import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IngestionEvent } from './langfuse.ts';

// Delivery state is separate from the transcript read position (state.ts).
// One small file per (trace, destination) means concurrent hooks and restarts
// never rewrite each other's records, unlike a single shared JSON file.

export type DeliveryStatus =
  /** Every span of the turn seen so far was accepted by this destination. */
  | 'confirmed'
  /** Some spans were accepted; the rest were refused and can be retried. */
  | 'partial'
  /** Nothing new was accepted; safe to retry. */
  | 'failed'
  /**
   * The receiver may or may not hold the spans listed in `pending` (lost
   * response, timeout, OTLP partial rejection). Never retried automatically:
   * a receiver that does not deduplicate would store them twice.
   */
  | 'unconfirmed';

export interface DeliveryRecord {
  version: 1;
  traceId: string;
  destination: string;
  sessionId?: string;
  status: DeliveryStatus;
  /** Accepted ID -> content hash at the time it was accepted. */
  spans: Record<string, string>;
  /** IDs whose acceptance is unknown. */
  pending?: string[];
  /** Accepted IDs whose content changed afterwards and could not be updated. */
  lateChanges?: string[];
  /** Consecutive attempts that delivered nothing. */
  attempts: number;
  lastError?: string;
  updatedAt: string;
}

export const MAX_ATTEMPTS = 5;
/** Stored in `spans` for an ID a read of the backend found, when its content hash was not kept. */
export const VERIFIED = 'verified';

/**
 * Settle an unconfirmed record against what the backend actually holds.
 * Spans found there are accepted. Spans not found were never stored, so they
 * are released for the next run to send: that is safe, because it is now known
 * they are absent. Returns what changed, or undefined if nothing was pending.
 */
export function reconcile(dir: string, record: DeliveryRecord, stored: ReadonlySet<string>,
  storedId: (id: string) => string): { found: number; released: number; status: DeliveryStatus } | undefined {
  if (record.status !== 'unconfirmed' || !record.pending?.length) return undefined;
  const found = record.pending.filter(id => stored.has(storedId(id)));
  for (const id of found) record.spans[id] = VERIFIED;
  const released = record.pending.length - found.length;
  record.status = released ? (Object.keys(record.spans).length ? 'partial' : 'failed') : 'confirmed';
  record.pending = undefined;
  record.attempts = 0;
  record.lastError = released ? `${released} span(s) were not stored; they will be sent again` : undefined;
  record.updatedAt = new Date().toISOString();
  writeRecord(dir, record);
  return { found: found.length, released, status: record.status };
}
const LOCK_STALE_MS = 2 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const destinationKey = (destination: string) => createHash('sha256').update(destination).digest('hex').slice(0, 12);
const safeTrace = (traceId: string) => /^[0-9a-f]{32}$/.test(traceId) ? traceId
  : createHash('sha256').update(traceId).digest('hex').slice(0, 32);

export function recordPath(dir: string, traceId: string, destination: string): string {
  return join(dir, `${safeTrace(traceId)}.${destinationKey(destination)}.json`);
}

export function readRecord(dir: string, traceId: string, destination: string): DeliveryRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(dir, traceId, destination), 'utf8')) as DeliveryRecord;
    if (parsed?.version === 1 && parsed.spans && typeof parsed.status === 'string') return parsed;
  } catch {
    /* missing or unreadable: treat as never delivered */
  }
  return undefined;
}

export function writeRecord(dir: string, record: DeliveryRecord): void {
  mkdirSync(dir, { recursive: true });
  const path = recordPath(dir, record.traceId, record.destination);
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, path);
}

export function clearRecord(dir: string, traceId: string, destination: string): boolean {
  try { unlinkSync(recordPath(dir, traceId, destination)); return true; } catch { return false; }
}

/**
 * Exclusive claim on one (trace, destination) so two hook processes cannot send
 * the same turn at once. Returns undefined when another live process holds it.
 */
export function acquire(dir: string, traceId: string, destination: string): (() => void) | undefined {
  mkdirSync(dir, { recursive: true });
  const lock = recordPath(dir, traceId, destination).replace(/\.json$/, '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lock, 'wx'));
      return () => { try { unlinkSync(lock); } catch { /* already released */ } };
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return undefined;
        unlinkSync(lock); // holder crashed
      } catch {
        /* released between the two calls: try once more */
      }
    }
  }
  return undefined;
}

export function listRecords(dir: string): DeliveryRecord[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: DeliveryRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as DeliveryRecord;
      if (parsed?.version === 1) out.push(parsed);
    } catch {
      /* skip unreadable record */
    }
  }
  return out;
}

/** Drop records, stale locks and temp files past retention. Runs at most once a day. */
export function prune(dir: string, now = Date.now()): void {
  const marker = join(dir, '.pruned');
  try {
    if (now - statSync(marker).mtimeMs < PRUNE_INTERVAL_MS) return;
  } catch {
    /* first run */
  }
  try {
    mkdirSync(dir, { recursive: true });
    closeSync(openSync(marker, 'a'));
    utimesSync(marker, new Date(now), new Date(now));
    for (const name of readdirSync(dir)) {
      if (name === '.pruned') continue;
      const path = join(dir, name);
      const limit = name.endsWith('.json') ? RETENTION_MS : LOCK_STALE_MS * 5;
      try { if (now - statSync(path).mtimeMs > limit) unlinkSync(path); } catch { /* raced with another process */ }
    }
  } catch {
    /* pruning is best effort */
  }
}

/**
 * Content hash used to tell "already delivered" from "changed since". GitHub
 * context is excluded: it is looked up at export time and may differ between
 * runs without the turn itself changing.
 */
export function contentHash(event: IngestionEvent): string {
  const body: Record<string, unknown> = { ...event.body };
  const metadata = body.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata) && 'github' in metadata) {
    const { github: _github, ...rest } = metadata as Record<string, unknown>;
    body.metadata = rest;
  }
  return createHash('sha256').update(event.type + '\n' + JSON.stringify(body)).digest('hex').slice(0, 16);
}
