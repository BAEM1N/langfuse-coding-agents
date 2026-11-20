import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './config.ts';
import { acquire, contentHash, MAX_ATTEMPTS, prune, readRecord, writeRecord, type DeliveryRecord } from './delivery.ts';
import { resolveDestinations, type Destination } from './destinations.ts';
import { LangfuseClient, type IngestionEvent, type IngestResult } from './langfuse.ts';
import type { Logger } from './log.ts';
import { otlpPayload, otlpSpanId, postOtlp, type OtlpSpan } from './otlp.ts';
import { enrichGithub } from './github.ts';

const launch = promisify(execFile);
const MAX_OTLP_BYTES = 2_000_000;

export type TraceStatus =
  /** Accepted by the destination in this run. */
  | 'delivered'
  /** Already confirmed for this destination; nothing new to send. */
  | 'skipped'
  /** Refused; will be retried on a later run. */
  | 'failed'
  /** Some spans accepted, the rest refused; the rest will be retried. */
  | 'partial'
  /** Acceptance unknown as of this run. Not retried automatically. */
  | 'unconfirmed'
  /** Left alone: unconfirmed earlier, or refused MAX_ATTEMPTS times. Needs `delivery clear`. */
  | 'held'
  /** Another hook process is sending this turn right now. */
  | 'busy'
  /** The turn has not ended and this destination only takes finished turns. */
  | 'not-ready'
  | 'config-error';

export interface TraceOutcome {
  traceId: string;
  status: TraceStatus;
  sent: number;
  message?: string;
  httpStatus?: number;
}

export interface DestinationResult {
  destination: string;
  kind: Destination['kind'];
  label: string;
  /** What a `delivered` status proves for this destination. */
  evidence: 'accepted by a relay; delivery to its backends is not confirmed' | 'accepted by the Langfuse API; not verified by a read';
  sent: number;
  traces: TraceOutcome[];
}

export interface ExportResult extends IngestResult {
  destinations: DestinationResult[];
  /** Traces every destination has either accepted or deliberately stopped retrying. */
  settled: string[];
}

export interface ExportOptions {
  /** Delivery-state directory. Defaults to <agent home>/state/delivery. */
  stateDir?: string;
}

export function deliveryDir(config: Config): string {
  return join(config.agentHome, 'state', 'delivery');
}

export function canExport(config: Config): boolean {
  return resolveDestinations(config).length > 0;
}

const traceIdOf = (event: IngestionEvent) => String(event.type === 'trace-create' ? event.body.id : event.body.traceId);
const isComplete = (events: IngestionEvent[]) =>
  (events.find(event => event.type === 'trace-create')?.body.metadata as { complete?: boolean } | undefined)?.complete !== false;
const sessionOf = (events: IngestionEvent[]) => {
  const id = events.find(event => event.type === 'trace-create')?.body.sessionId;
  return typeof id === 'string' ? id : undefined;
};

interface Attempt extends TraceOutcome {
  /** The failure is about the destination, not this turn: stop sending to it in this run. */
  destinationDown?: boolean;
}

function baseRecord(previous: DeliveryRecord | undefined, traceId: string, destination: string, events: IngestionEvent[]): DeliveryRecord {
  return previous ?? { version: 1, traceId, destination, sessionId: sessionOf(events), status: 'failed', spans: {}, attempts: 0, updatedAt: '' };
}

// 400 / 413 / 422 describe this request's content. Anything else (auth, path,
// throttling, 5xx, network) would fail the same way for every other turn.
const turnScoped = (status?: number) => status === 400 || status === 413 || status === 422;

async function deliverLegacy(config: Config, destination: Destination, traceId: string, events: IngestionEvent[],
  dir: string, logger: Logger): Promise<Attempt> {
  const hashes = new Map(events.map(event => [String(event.body.id), contentHash(event)]));
  const previous = readRecord(dir, traceId, destination.id);
  const unchanged = previous && [...hashes].every(([id, hash]) => previous.spans[id] === hash);
  if (previous?.status === 'confirmed' && unchanged) return { traceId, status: 'skipped', sent: 0 };
  if (previous && previous.status !== 'confirmed' && previous.attempts >= MAX_ATTEMPTS) {
    return { traceId, status: 'held', sent: 0, message: previous.lastError };
  }
  const client = new LangfuseClient({ baseUrl: config.baseUrl, publicKey: config.publicKey!, secretKey: config.secretKey!,
    timeoutMs: config.timeoutMs, logger });
  const result = await client.ingest(events);
  const record = baseRecord(previous, traceId, destination.id, events);
  record.updatedAt = new Date().toISOString();
  if (result.ok) {
    for (const [id, hash] of hashes) record.spans[id] = hash;
    Object.assign(record, { status: 'confirmed', attempts: 0, lastError: undefined });
    writeRecord(dir, record);
    return { traceId, status: 'delivered', sent: result.sent };
  }
  // Legacy ingestion upserts by ID, so anything not acknowledged is simply sent again.
  const rejected = new Set(result.errors.map(error => error.id));
  const perEvent = result.errors.every(error => typeof error.id === 'string');
  let accepted = 0;
  if (perEvent) {
    for (const event of events) {
      if (rejected.has(event.id)) continue;
      record.spans[String(event.body.id)] = hashes.get(String(event.body.id))!;
      accepted++;
    }
  }
  const httpStatus = result.errors.find(error => error.status !== undefined)?.status;
  const everyEventRefused = perEvent && accepted === 0 && result.errors.every(error => error.status === 400);
  const message = everyEventRefused
    ? 'Legacy ingestion refused every trace event (HTTP 400 per event). This server no longer stores legacy trace events; set LANGFUSE_HOOK_TRANSPORT=otlp.'
    : perEvent ? `Legacy ingestion rejected ${result.errors.length} of ${events.length} events`
      : result.errors[0]?.message ?? 'Legacy ingestion failed';
  const scoped = perEvent || turnScoped(httpStatus);
  Object.assign(record, { status: accepted ? 'partial' : 'failed', lastError: message, attempts: record.attempts + (scoped ? 1 : 0) });
  writeRecord(dir, record);
  return { traceId, status: accepted ? 'partial' : 'failed', sent: accepted, message, httpStatus, destinationDown: !scoped };
}

function chunkSpans(spans: OtlpSpan[]): OtlpSpan[][] {
  const chunks: OtlpSpan[][] = [];
  let current: OtlpSpan[] = [];
  let size = 0;
  for (const span of spans) {
    const bytes = Buffer.byteLength(JSON.stringify(span));
    if (current.length && size + bytes > MAX_OTLP_BYTES) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(span);
    size += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function deliverOtlp(config: Config, destination: Destination, traceId: string, events: IngestionEvent[],
  dir: string, logger: Logger): Promise<Attempt> {
  const otlp = destination.otlp!;
  // Turn events are observations of their own only where the payload reaches Langfuse.
  const langfuse = destination.kind === 'langfuse-otlp' || config.otlpForwardsToLangfuse;
  const observations = events.filter(event => event.type !== 'trace-create' && (langfuse || event.type !== 'event-create'));
  const hashes = new Map(observations.map(event => [String(event.body.id), contentHash(event)]));
  const previous = readRecord(dir, traceId, destination.id);
  // The receiver may already hold these spans and does not deduplicate span IDs,
  // so an unknown outcome is never retried without an operator's decision.
  if (previous?.status === 'unconfirmed') return { traceId, status: 'held', sent: 0, message: previous.lastError };

  const record = baseRecord(previous, traceId, destination.id, events);
  const fresh = [...hashes.keys()].filter(id => !(id in record.spans));
  // A span that changed after it was accepted cannot be updated in place.
  const late = [...hashes].filter(([id, hash]) => id in record.spans && record.spans[id] !== hash && record.spans[id] !== 'dropped')
    .map(([id]) => id).filter(id => !record.lateChanges?.includes(id));
  if (late.length) {
    record.lateChanges = [...(record.lateChanges ?? []), ...late];
    logger.warn(`${destination.label}: ${late.length} span(s) of trace ${traceId} changed after delivery and were not re-sent`);
    if (!fresh.length) writeRecord(dir, { ...record, updatedAt: new Date().toISOString() });
  }
  if (!fresh.length) return { traceId, status: 'skipped', sent: 0 };
  if (previous && previous.status !== 'confirmed' && previous.attempts >= MAX_ATTEMPTS) {
    return { traceId, status: 'held', sent: 0, message: previous.lastError };
  }

  const payload = otlpPayload(events, config.agent, { serviceName: otlp.serviceName, captureContent: otlp.captureContent,
    only: new Set(fresh), langfuse,
    // The direct route keeps the body limit legacy ingestion used for the same project.
    maxChars: destination.kind === 'langfuse-otlp' ? config.maxChars : undefined });
  const resource = payload.resourceSpans[0];
  const bySpanId = new Map(fresh.map(id => [otlpSpanId(id), id]));
  const emitted = new Set(resource.scopeSpans[0].spans.map(span => bySpanId.get(span.spanId)));
  // Observations the converter cannot express (no usable start time) are final.
  for (const id of fresh) if (!emitted.has(id)) record.spans[id] = 'dropped';

  let sent = 0;
  let failure: Attempt | undefined;
  for (const chunk of chunkSpans(resource.scopeSpans[0].spans)) {
    const outcome = await postOtlp(otlp, { resourceSpans: [{ resource: resource.resource,
      scopeSpans: [{ scope: resource.scopeSpans[0].scope, spans: chunk }] }] });
    const ids = chunk.map(span => bySpanId.get(span.spanId)!);
    if (outcome.outcome === 'accepted') {
      for (const id of ids) record.spans[id] = hashes.get(id)!;
      sent += ids.length;
      continue;
    }
    if (outcome.outcome === 'unknown') {
      record.pending = [...new Set([...(record.pending ?? []), ...ids])];
      failure = { traceId, status: 'unconfirmed', sent, message: outcome.message, httpStatus: outcome.status, destinationDown: true };
    } else {
      failure = { traceId, status: sent ? 'partial' : 'failed', sent, message: outcome.message, httpStatus: outcome.status,
        destinationDown: !turnScoped(outcome.status) };
    }
    break;
  }
  record.updatedAt = new Date().toISOString();
  if (!failure) {
    Object.assign(record, { status: 'confirmed', attempts: 0, lastError: undefined, pending: undefined });
    writeRecord(dir, record);
    return { traceId, status: 'delivered', sent };
  }
  Object.assign(record, { status: failure.status, lastError: failure.message,
    attempts: record.attempts + (failure.status !== 'unconfirmed' && !failure.destinationDown ? 1 : 0) });
  writeRecord(dir, record);
  return failure;
}

async function deliver(config: Config, destination: Destination, groups: Map<string, IngestionEvent[]>, dir: string,
  logger: Logger): Promise<DestinationResult> {
  const result: DestinationResult = { destination: destination.id, kind: destination.kind, label: destination.label, sent: 0, traces: [],
    evidence: destination.relay ? 'accepted by a relay; delivery to its backends is not confirmed'
      : 'accepted by the Langfuse API; not verified by a read' };
  let down: string | undefined;
  let started = false;
  for (const [traceId, events] of groups) {
    if (destination.configError) {
      result.traces.push({ traceId, status: 'config-error', sent: 0, message: destination.configError });
      continue;
    }
    if (destination.completedOnly && !isComplete(events)) {
      result.traces.push({ traceId, status: 'not-ready', sent: 0 });
      continue;
    }
    if (down) {
      result.traces.push({ traceId, status: 'failed', sent: 0, message: down });
      continue;
    }
    const release = acquire(dir, traceId, destination.id);
    if (!release) {
      result.traces.push({ traceId, status: 'busy', sent: 0 });
      continue;
    }
    try {
      if (destination.kind === 'otlp' && config.collectorLauncher && !started) {
        const node = config.nodeExecutable || (process.versions.bun ? 'node' : process.execPath);
        try {
          await launch(node, [config.collectorLauncher], { timeout: 4000, windowsHide: true });
          started = true;
        } catch {
          down = 'Local Collector did not start';
          result.traces.push({ traceId, status: 'failed', sent: 0, message: down });
          continue;
        }
      }
      const { destinationDown, ...outcome } = destination.idempotent
        ? await deliverLegacy(config, destination, traceId, events, dir, logger)
        : await deliverOtlp(config, destination, traceId, events, dir, logger);
      result.traces.push(outcome);
      result.sent += outcome.sent;
      if (destinationDown) down = outcome.message ?? 'Destination unavailable';
    } catch {
      // Delivery state could not be read or written. Sending without it could duplicate the turn.
      result.traces.push({ traceId, status: 'failed', sent: 0, message: 'Delivery state unavailable' });
    } finally {
      release();
    }
  }
  return result;
}

const PROBLEM = new Set<TraceStatus>(['failed', 'partial', 'unconfirmed', 'config-error']);
const SETTLED = new Set<TraceStatus>(['delivered', 'skipped', 'unconfirmed', 'held']);

function summarize(result: DestinationResult): string {
  const counts: Record<string, number> = {};
  for (const trace of result.traces) counts[trace.status] = (counts[trace.status] ?? 0) + 1;
  return `${result.label} [${result.destination}] ` + Object.entries(counts).map(([status, n]) => `${status}=${n}`).join(' ');
}

export async function exportEvents(config: Config, events: IngestionEvent[], logger: Logger, cwd = process.cwd(),
  options: ExportOptions = {}): Promise<ExportResult> {
  if (config.github) await enrichGithub(events, config.github, cwd);
  const dir = options.stateDir ?? deliveryDir(config);
  const groups = new Map<string, IngestionEvent[]>();
  for (const event of events) {
    const id = traceIdOf(event);
    const group = groups.get(id);
    if (group) group.push(event); else groups.set(id, [event]);
  }
  const destinations = await Promise.all(resolveDestinations(config).map(destination =>
    deliver(config, destination, groups, dir, logger)));
  prune(dir);

  const errors: IngestResult['errors'] = [];
  for (const result of destinations) {
    const problems = result.traces.filter(trace => PROBLEM.has(trace.status));
    if (problems.length) {
      logger.error(summarize(result) + ' :: ' + (problems[0].message ?? 'no detail'));
      for (const trace of problems) errors.push({ id: trace.traceId, status: trace.httpStatus, message: `${result.label}: ${trace.status}: ${trace.message ?? ''}` });
    } else if (result.sent) {
      logger.info(summarize(result) + ` :: ${result.sent} item(s) ${result.evidence}`);
    } else {
      logger.debug(summarize(result));
    }
  }
  const settled = [...groups.keys()].filter(traceId => destinations.length > 0 && destinations.every(result =>
    SETTLED.has(result.traces.find(trace => trace.traceId === traceId)?.status ?? 'failed')));
  return { ok: errors.length === 0, sent: destinations.reduce((total, result) => total + result.sent, 0), errors, destinations, settled };
}
