import { stableId } from './ids.ts';
import { sanitize } from './text.ts';
import type { IngestionEvent } from './langfuse.ts';
import { githubAttributes, type GithubContext } from './github.ts';

export interface OtlpConfig {
  endpoint: string;
  headers: Headers;
  serviceName?: string;
  captureContent: boolean;
  timeoutMs: number;
}

export function loadOtlpConfig(env: NodeJS.ProcessEnv): OtlpConfig | undefined {
  if (env.CODING_AGENT_OTLP_ENABLED === 'false') return;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const endpoint = env.CODING_AGENT_OTLP_TRACES_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
    || (base ? new URL('v1/traces', base.replace(/\/+$/, '') + '/').href : undefined);
  if (!endpoint) return;
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OTLP traces endpoint must use HTTP or HTTPS');
  const protocol = env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL || env.OTEL_EXPORTER_OTLP_PROTOCOL || 'http/json';
  if (protocol !== 'http/json') throw new Error('This exporter supports OTLP http/json');
  const headers = new Headers();
  for (const raw of (env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')) {
    const i = raw.indexOf('=');
    if (i > 0) headers.set(raw.slice(0, i).trim(), decodeURIComponent(raw.slice(i + 1).trim()));
  }
  headers.set('Content-Type', 'application/json');
  const timeout = Number(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? env.OTEL_EXPORTER_OTLP_TIMEOUT ?? '5000');
  return { endpoint: url.href, headers, serviceName: env.OTEL_SERVICE_NAME,
    captureContent: env.OTEL_CAPTURE_CONTENT === 'true', timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.trunc(timeout), 15000) || 1 : 5000 };
}

type AttributeValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean }
  | { arrayValue: { values: Array<{ stringValue: string }> } };
type Attributes = Array<{ key: string; value: AttributeValue }>;

function attributes(values: Record<string, unknown>): Attributes {
  return Object.entries(values).flatMap(([key, v]): Attributes => {
    if (typeof v === 'string') return [{ key, value: { stringValue: v } }];
    if (typeof v === 'number' && Number.isSafeInteger(v)) return [{ key, value: { intValue: String(v) } }];
    if (typeof v === 'number' && Number.isFinite(v)) return [{ key, value: { doubleValue: v } }];
    if (typeof v === 'boolean') return [{ key, value: { boolValue: v } }];
    if (Array.isArray(v) && v.length && v.every(item => typeof item === 'string')) {
      return [{ key, value: { arrayValue: { values: v.map(item => ({ stringValue: item as string })) } } }];
    }
    return [];
  });
}

const epoch = (time: number) => (BigInt(time) * 1_000_000n).toString();
/** OTLP span ID for an observation ID. Langfuse uses the span ID as the observation ID. */
export const otlpSpanId = (id: string) => stableId('otlp-span', id).slice(0, 16);
export const otlpTraceId = (id: string) => /^[0-9a-f]{32}$/.test(id) ? id : stableId('otlp-trace', id);
const DEFAULT_MAX_CHARS = 8000;
const content = (value: unknown, maxChars = DEFAULT_MAX_CHARS) =>
  value === undefined ? undefined : JSON.stringify(sanitize(value, { redact: true, maxChars }));
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

const OBSERVATION_TYPES: Record<string, string> = { 'agent-create': 'agent', 'generation-create': 'generation',
  'tool-create': 'tool', 'span-create': 'span' };

export interface PayloadOptions extends Pick<OtlpConfig, 'serviceName' | 'captureContent'> {
  /** Emit only these observation IDs. Parents and links still resolve against the whole turn. */
  only?: ReadonlySet<string>;
  /**
   * The payload reaches Langfuse (directly, or through a Collector declared to
   * forward there). Adds what legacy ingestion carried and OTLP otherwise drops:
   * turn events as `event` observations (Langfuse ignores OTLP span events) and
   * the adapters' trace and observation metadata. Other receivers get neither.
   */
  langfuse?: boolean;
  /** Per-string limit for captured bodies. Defaults to 8000. */
  maxChars?: number;
}

/** Metadata values as attributes: scalars as they are, small objects as JSON. */
function metadataAttributes(prefix: string, metadata: unknown, skip: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return out;
  for (const [key, value] of Object.entries(metadata)) {
    if (skip.has(key) || !/^[A-Za-z0-9_-]{1,64}$/.test(key) || value === undefined || value === null) continue;
    if (typeof value === 'string') out[prefix + key] = value.slice(0, 1000);
    else if (typeof value === 'number' || typeof value === 'boolean') out[prefix + key] = value;
    else { const json = JSON.stringify(value); if (json.length <= 2000) out[prefix + key] = json; }
  }
  return out;
}
const TRACE_METADATA_SET_ELSEWHERE = new Set(['complete', 'turnIndex', 'hostname', 'github', 'device', 'agent']);
const OBSERVATION_METADATA_SET_ELSEWHERE = new Set(['toolCallId', 'issuedByObservationId', 'consumedByObservationId', 'github']);

/**
 * Trace-level fields. Langfuse stores observations independently, so session,
 * user, tags and filterable metadata are repeated on every span of the turn.
 */
function traceAttributes(trace: Record<string, unknown> | undefined, full: boolean | undefined): Record<string, unknown> {
  const meta = trace?.metadata as { github?: GithubContext; complete?: unknown; turnIndex?: unknown; hostname?: unknown } | undefined;
  const github = meta?.github;
  return {
    'langfuse.trace.name': typeof trace?.name === 'string' ? trace.name : undefined,
    'langfuse.session.id': trace?.sessionId,
    'langfuse.user.id': trace?.userId,
    'langfuse.trace.tags': trace?.tags,
    'langfuse.environment': trace?.environment,
    'langfuse.release': trace?.release,
    'langfuse.trace.metadata.agent': Array.isArray(trace?.tags) ? trace.tags[0] : undefined,
    'langfuse.trace.metadata.complete': typeof meta?.complete === 'boolean' ? meta.complete : undefined,
    'langfuse.trace.metadata.turnIndex': meta?.turnIndex,
    'langfuse.trace.metadata.hostname': meta?.hostname,
    'langfuse.trace.metadata.github_repository': github?.repository,
    'langfuse.trace.metadata.github_branch': github?.branch,
    'langfuse.trace.metadata.github_commit': github?.commit,
    'langfuse.trace.metadata.github_pull_request': github?.pullRequest?.number,
    ...(full ? metadataAttributes('langfuse.trace.metadata.', trace?.metadata, TRACE_METADATA_SET_ELSEWHERE) : {}),
  };
}

export type OtlpSpan = ReturnType<typeof otlpPayload>['resourceSpans'][number]['scopeSpans'][number]['spans'][number];

export function otlpPayload(events: IngestionEvent[], agent: string, options: PayloadOptions) {
  const traces = new Map(events.filter(e => e.type === 'trace-create').map(e => [e.body.id, e.body]));
  const eventsById = new Map(events.map(e => [e.body.id, e.type]));
  const observations = new Map(events.filter(e => e.type !== 'trace-create' && e.type !== 'event-create').map(e => [e.body.id, e.body]));
  const issuesByParent = new Map<unknown, IngestionEvent[]>();
  for (const event of events) {
    if (event.type !== 'event-create') continue;
    const parent = event.body.parentObservationId;
    const siblings = issuesByParent.get(parent) ?? [];
    siblings.push(event);
    issuesByParent.set(parent, siblings);
  }
  const spans = [...observations.values()].flatMap(body => {
    if (typeof body.id !== 'string' || typeof body.traceId !== 'string') return [];
    if (options.only && !options.only.has(body.id)) return [];
    const trace = traces.get(body.traceId);
    const event = eventsById.get(body.id);
    const generation = event === 'generation-create';
    const tool = event === 'tool-create';
    const net = body.usageDetails as Record<string, number> | undefined;
    const meta = body.metadata as Record<string, unknown> | undefined;
    const traceMeta = trace?.metadata as { github?: GithubContext; complete?: unknown; turnIndex?: unknown; hostname?: unknown } | undefined;
    const start = Date.parse(String(body.startTime ?? trace?.timestamp));
    if (!Number.isFinite(start)) return [];
    const observedEnd = Date.parse(String(body.endTime));
    const end = Number.isFinite(observedEnd) ? Math.max(start, observedEnd) : start;
    // Adapters store usage as exclusive parts: `input` is uncached input, `output`
    // is visible output, and cache / reasoning tokens have their own keys.
    // OTel gen_ai totals are inclusive, so the parts are added back here once.
    const cacheRead = count(net?.input_cached_tokens ?? net?.cache_read_input_tokens);
    const cacheWrite = count(net?.input_cache_creation ?? net?.cache_creation_input_tokens);
    // Codex reports cache writes without saying whether input_tokens already
    // counts them, so they are reported but not added to the input total.
    const cacheWriteReported = cacheWrite || count(net?.input_cache_write_tokens);
    const reasoning = count(net?.output_reasoning_tokens);
    const operation = generation ? 'chat' : tool ? 'execute_tool' : 'invoke_agent';
    const nativeTraceId = otlpTraceId(body.traceId);
    const input = options.captureContent ? content(body.input, options.maxChars) : undefined;
    const output = options.captureContent ? content(body.output, options.maxChars) : undefined;
    const root = !body.parentObservationId;
    const github = traceMeta?.github;
    const linked = (key: string) => {
      const id = meta?.[key];
      return typeof id === 'string' && observations.has(id) ? otlpSpanId(id) : undefined;
    };
    const links = ['issuedByObservationId', 'consumedByObservationId'].flatMap(key => {
      const id = linked(key);
      return id ? [{ traceId: nativeTraceId, spanId: id, attributes: attributes({ 'coding_agent.link.role': key }) }] : [];
    });
    return [{ traceId: nativeTraceId, spanId: otlpSpanId(body.id),
      ...(typeof body.parentObservationId === 'string' && observations.has(body.parentObservationId) ? { parentSpanId: otlpSpanId(body.parentObservationId) } : {}),
      name: String(body.name ?? operation), kind: generation ? 3 : 1, startTimeUnixNano: epoch(start), endTimeUnixNano: epoch(end),
      status: { code: body.level === 'ERROR' ? 2 : 0 }, links,
      attributes: attributes({ 'gen_ai.operation.name': operation, 'gen_ai.agent.name': agent,
        'user.id': generation || tool ? undefined : trace?.userId,
        'gen_ai.conversation.id': trace?.sessionId, 'gen_ai.request.model': body.model,
        'gen_ai.tool.name': tool ? body.name : undefined,
        'gen_ai.tool.call.id': tool && meta?.toolCallId !== undefined ? String(meta.toolCallId) : undefined,
        'gen_ai.usage.input_tokens': typeof net?.input === 'number' ? net.input + cacheRead + cacheWrite : undefined,
        'gen_ai.usage.output_tokens': typeof net?.output === 'number' ? net.output + reasoning : undefined,
        'gen_ai.usage.cache_read.input_tokens': net && cacheRead,
        'gen_ai.usage.cache_creation.input_tokens': net && cacheWriteReported,
        'coding_agent.usage.reasoning_tokens': reasoning || undefined,
        'coding_agent.timing.has_end': Number.isFinite(observedEnd),
        'coding_agent.input': input,
        'coding_agent.output': output,
        // Langfuse reads the fields below. It stores observations independently, so
        // session, user, tags and filterable metadata are repeated on every span.
        'langfuse.observation.type': OBSERVATION_TYPES[event ?? ''] ?? 'span',
        'langfuse.observation.level': typeof body.level === 'string' ? body.level : undefined,
        'langfuse.observation.status_message': typeof body.statusMessage === 'string' ? body.statusMessage : undefined,
        'langfuse.observation.input': input,
        'langfuse.observation.output': output,
        // The adapter's exclusive parts, unchanged, so nothing is counted twice.
        'langfuse.observation.usage_details': generation && net && Object.keys(net).length ? JSON.stringify(net) : undefined,
        ...traceAttributes(trace, options.langfuse),
        ...(options.langfuse ? metadataAttributes('langfuse.observation.metadata.', meta, OBSERVATION_METADATA_SET_ELSEWHERE) : {}),
        // Langfuse ignores span links, so the tool's call ID and the model spans
        // before and after it are also kept as observation metadata.
        'langfuse.observation.metadata.toolCallId': tool && meta?.toolCallId !== undefined ? String(meta.toolCallId) : undefined,
        'langfuse.observation.metadata.issuedByObservationId': tool ? linked('issuedByObservationId') : undefined,
        'langfuse.observation.metadata.consumedByObservationId': tool ? linked('consumedByObservationId') : undefined,
        ...(root && github ? githubAttributes(github) : {}),
        'langfuse.observation.metadata.github': root && github ? JSON.stringify(github) : undefined,
        'langfuse.trace.metadata.github': root && github ? JSON.stringify(github) : undefined }),
      events: (issuesByParent.get(body.id) ?? []).map(({ body }) => {
        const eventTime = Date.parse(String(body.startTime));
        return { name: String(body.name ?? 'coding_agent.event'), timeUnixNano: epoch(Number.isFinite(eventTime) ? eventTime : start),
          attributes: attributes({ 'coding_agent.event.level': body.level }) };
      }),
    }];
  });
  // Notifications, permission requests, interruptions and timeline warnings.
  // They stay as span events for trace viewers; Langfuse needs them as observations.
  const eventSpans: typeof spans = !options.langfuse ? [] : events.filter(e => e.type === 'event-create').flatMap(({ body }) => {
    if (typeof body.id !== 'string' || typeof body.traceId !== 'string') return [];
    if (options.only && !options.only.has(body.id)) return [];
    const trace = traces.get(body.traceId);
    const at = Date.parse(String(body.startTime ?? trace?.timestamp));
    if (!Number.isFinite(at)) return [];
    return [{ traceId: otlpTraceId(body.traceId), spanId: otlpSpanId(body.id),
      ...(typeof body.parentObservationId === 'string' && observations.has(body.parentObservationId) ? { parentSpanId: otlpSpanId(body.parentObservationId) } : {}),
      name: String(body.name ?? 'coding_agent.event'), kind: 1, startTimeUnixNano: epoch(at), endTimeUnixNano: epoch(at),
      status: { code: body.level === 'ERROR' ? 2 : 0 }, links: [],
      attributes: attributes({ 'gen_ai.agent.name': agent, 'gen_ai.conversation.id': trace?.sessionId,
        'langfuse.observation.type': 'event',
        'langfuse.observation.level': typeof body.level === 'string' ? body.level : undefined,
        'langfuse.observation.input': options.captureContent ? content(body.input, options.maxChars) : undefined,
        ...traceAttributes(trace, true),
        ...metadataAttributes('langfuse.observation.metadata.', body.metadata, OBSERVATION_METADATA_SET_ELSEWHERE) }),
      events: [] }];
  });
  const sample = traces.values().next().value;
  const metadata = sample?.metadata as { device?: Record<string, unknown> } | undefined;
  return { resourceSpans: [{ resource: { attributes: attributes({ ...metadata?.device,
    'service.name': options.serviceName ?? 'coding-agent-' + agent, 'deployment.environment.name': sample?.environment }) },
    scopeSpans: [{ scope: { name: 'langfuse-coding-agents' }, spans: [...spans, ...eventSpans] }] }] };
}

export interface SendOutcome {
  /**
   * accepted: 2xx with no rejected spans.
   * rejected: the receiver refused the request; nothing was stored.
   * unknown: the request may have been stored in full, in part, or not at all.
   */
  outcome: 'accepted' | 'rejected' | 'unknown';
  status?: number;
  /** True for errors a retry cannot fix (credentials, endpoint path). */
  config?: boolean;
  message?: string;
}

const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_INVALID_URL']);

/** POST one OTLP payload. Messages never include headers, the request body or the response body. */
export async function postOtlp(config: Pick<OtlpConfig, 'endpoint' | 'headers' | 'timeoutMs'>, payload: unknown): Promise<SendOutcome> {
  let res: Response;
  try {
    res = await fetch(config.endpoint, { method: 'POST', headers: config.headers,
      body: JSON.stringify(payload), signal: AbortSignal.timeout(config.timeoutMs), redirect: 'error' });
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
    const code = String(cause?.code ?? '');
    // A connection that was never established cannot have delivered anything.
    if (NOT_SENT.has(code)) return { outcome: 'rejected', message: 'OTLP receiver unreachable (' + code + ')' };
    // fetch refuses some ports before opening a socket.
    if (cause?.message === 'bad port') return { outcome: 'rejected', config: true, message: 'OTLP endpoint uses a port fetch does not allow' };
    const timedOut = (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError';
    return { outcome: 'unknown', message: timedOut ? 'OTLP request timed out; delivery unknown' : 'OTLP response lost; delivery unknown' };
  }
  const status = res.status;
  let text = '';
  try { text = await res.text(); } catch { /* body is optional */ }
  if (status >= 200 && status < 300) {
    let rejected = 0;
    try { rejected = Number(JSON.parse(text).partialSuccess?.rejectedSpans ?? 0); } catch { /* empty or non-JSON success body */ }
    // OTLP does not say which spans were rejected.
    return rejected > 0 ? { outcome: 'unknown', status, message: `OTLP receiver rejected ${rejected} spans (partial success)` }
      : { outcome: 'accepted', status };
  }
  if (status === 401 || status === 403 || status === 404) {
    return { outcome: 'rejected', status, config: true, message: 'OTLP export refused (HTTP ' + status + '): check endpoint and credentials' };
  }
  // The server may have stored the spans before these responses were produced.
  if (status === 408 || status === 500 || status === 504) {
    return { outcome: 'unknown', status, message: 'OTLP export failed (HTTP ' + status + '); delivery unknown' };
  }
  return { outcome: 'rejected', status, message: 'OTLP export failed (HTTP ' + status + ')' };
}
