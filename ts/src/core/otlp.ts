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

type AttributeValue = { stringValue: string } | { intValue: string } | { boolValue: boolean }
  | { arrayValue: { values: Array<{ stringValue: string }> } };
type Attributes = Array<{ key: string; value: AttributeValue }>;

function attributes(values: Record<string, unknown>): Attributes {
  return Object.entries(values).flatMap(([key, v]): Attributes => {
    if (typeof v === 'string') return [{ key, value: { stringValue: v } }];
    if (typeof v === 'number' && Number.isSafeInteger(v)) return [{ key, value: { intValue: String(v) } }];
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
const content = (value: unknown) => value === undefined ? undefined : JSON.stringify(sanitize(value, { redact: true, maxChars: 8000 }));
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

const OBSERVATION_TYPES: Record<string, string> = { 'agent-create': 'agent', 'generation-create': 'generation',
  'tool-create': 'tool', 'span-create': 'span' };

export interface PayloadOptions extends Pick<OtlpConfig, 'serviceName' | 'captureContent'> {
  /** Emit only these observation IDs. Parents and links still resolve against the whole turn. */
  only?: ReadonlySet<string>;
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
    const input = options.captureContent ? content(body.input) : undefined;
    const output = options.captureContent ? content(body.output) : undefined;
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
        'langfuse.trace.name': typeof trace?.name === 'string' ? trace.name : undefined,
        'langfuse.session.id': trace?.sessionId,
        'langfuse.user.id': trace?.userId,
        'langfuse.trace.tags': trace?.tags,
        'langfuse.environment': trace?.environment,
        'langfuse.release': trace?.release,
        'langfuse.trace.metadata.agent': Array.isArray(trace?.tags) ? trace.tags[0] : undefined,
        'langfuse.trace.metadata.complete': typeof traceMeta?.complete === 'boolean' ? traceMeta.complete : undefined,
        'langfuse.trace.metadata.turnIndex': traceMeta?.turnIndex,
        'langfuse.trace.metadata.hostname': traceMeta?.hostname,
        'langfuse.trace.metadata.github_repository': github?.repository,
        'langfuse.trace.metadata.github_branch': github?.branch,
        'langfuse.trace.metadata.github_commit': github?.commit,
        'langfuse.trace.metadata.github_pull_request': github?.pullRequest?.number,
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
  const sample = traces.values().next().value;
  const metadata = sample?.metadata as { device?: Record<string, unknown> } | undefined;
  return { resourceSpans: [{ resource: { attributes: attributes({ ...metadata?.device,
    'service.name': options.serviceName ?? 'coding-agent-' + agent, 'deployment.environment.name': sample?.environment }) },
    scopeSpans: [{ scope: { name: 'langfuse-coding-agents' }, spans }] }] };
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
