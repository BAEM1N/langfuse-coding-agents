import { readTraceObservations, withReadApi } from './audit.ts';
import { traceIdFor, turnToEvents } from './batch.ts';
import type { Config } from './config.ts';
import { contentHash, readRecord, writeRecord } from './delivery.ts';
import { resolveDestinations, type Destination } from './destinations.ts';
import { deliveryDir, exportEvents, type ExportResult } from './export.ts';
import { LangfuseClient, type IngestionEvent } from './langfuse.ts';
import type { Logger } from './log.ts';
import { otlpSpanId } from './otlp.ts';
import type { BatchOptions } from './batch.ts';
import type { Turn } from './types.ts';

export interface BackfillRange {
  from?: string;
  to?: string;
}

export interface BackfillPlan {
  range: BackfillRange;
  turns: number;
  excluded: { incomplete: number; outsideRange: number };
  /** Finished turns inside the range, as trace IDs. */
  selected: string[];
  destinations: Array<{ id: string; label: string; configError?: string; alreadyConfirmed: number; toSend: number }>;
  events: Map<string, IngestionEvent[]>;
}

/** Decide what a backfill would send. Reads local state only; no network. */
export function planBackfill(config: Config, turns: Turn[], options: BatchOptions, range: BackfillRange,
  stateDir = deliveryDir(config)): BackfillPlan {
  const from = range.from ? Date.parse(range.from) : -Infinity;
  const to = range.to ? Date.parse(range.to) : Infinity;
  const excluded = { incomplete: 0, outsideRange: 0 };
  const events = new Map<string, IngestionEvent[]>();
  for (const turn of turns) {
    // An unfinished turn would be stored without its later spans, and most receivers cannot update it.
    if (!turn.complete) { excluded.incomplete++; continue; }
    const start = Date.parse(turn.startTime);
    if (!(start >= from && start < to)) { excluded.outsideRange++; continue; }
    events.set(traceIdFor(options.agentTag, turn.sessionId, turn.key), turnToEvents(turn, options));
  }
  const selected = [...events.keys()];
  const destinations = resolveDestinations(config).map((destination) => {
    const alreadyConfirmed = selected.filter(traceId => readRecord(stateDir, traceId, destination.id)?.status === 'confirmed').length;
    return { id: destination.id, label: destination.label, configError: destination.configError,
      alreadyConfirmed, toSend: destination.configError ? 0 : selected.length - alreadyConfirmed };
  });
  return { range, turns: turns.length, excluded, selected, destinations, events };
}

export interface BackfillResult {
  /** Traces left alone because the project already holds them under other observation IDs. */
  existsRemotely: string[];
  /** Traces recorded as delivered because the project already holds every span. */
  foundComplete: string[];
  export?: ExportResult;
}

/**
 * Before sending to Langfuse over OTLP, read each trace that has no local
 * delivery record. Langfuse v4 does not deduplicate, so a turn that is already
 * stored (by an earlier version, or by legacy ingestion) must not be sent again.
 */
async function reconcileRemote(config: Config, destination: Destination, plan: BackfillPlan, stateDir: string,
  logger: Logger, result: BackfillResult): Promise<void> {
  const client = new LangfuseClient({ baseUrl: config.baseUrl, publicKey: config.publicKey!, secretKey: config.secretKey!,
    timeoutMs: Math.max(config.timeoutMs, 30000), logger });
  for (const traceId of plan.selected) {
    if (readRecord(stateDir, traceId, destination.id)) continue;
    const { value } = await withReadApi(undefined, api => readTraceObservations(client, api, traceId));
    const stored = new Set(value.map(span => span.id));
    if (!stored.size) continue;
    const observations = plan.events.get(traceId)!.filter(event => event.type !== 'trace-create' && event.type !== 'event-create');
    const present = observations.filter(event => stored.has(otlpSpanId(String(event.body.id))));
    if (!present.length) {
      // Stored with different observation IDs: sending would add a second copy.
      // Held for this destination only; other destinations still get the turn.
      result.existsRemotely.push(traceId);
      writeRecord(stateDir, { version: 1, traceId, destination: destination.id, status: 'unconfirmed', spans: {}, attempts: 0,
        lastError: 'Already stored in this project under other observation IDs; not sent again', updatedAt: new Date().toISOString() });
      continue;
    }
    const complete = present.length === observations.length;
    writeRecord(stateDir, { version: 1, traceId, destination: destination.id, status: complete ? 'confirmed' : 'partial',
      spans: Object.fromEntries(present.map(event => [String(event.body.id), contentHash(event)])), attempts: 0,
      updatedAt: new Date().toISOString() });
    if (complete) result.foundComplete.push(traceId);
  }
}

export async function runBackfill(config: Config, plan: BackfillPlan, logger: Logger, cwd: string,
  stateDir = deliveryDir(config)): Promise<BackfillResult> {
  if (!plan.range.from || !plan.range.to) throw new Error('backfill sends only an explicit range: pass --from and --to');
  const result: BackfillResult = { existsRemotely: [], foundComplete: [] };
  for (const destination of resolveDestinations(config)) {
    if (destination.kind === 'langfuse-otlp' && !destination.configError) {
      await reconcileRemote(config, destination, plan, stateDir, logger, result);
    }
  }
  const events = [...plan.events.values()].flat();
  if (events.length) result.export = await exportEvents(config, events, logger, cwd, { stateDir });
  return result;
}
