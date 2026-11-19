import { stableId } from './ids.ts';
import { sanitize } from './text.ts';
import type { IngestResult, IngestionEvent } from './langfuse.ts';
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

type AttributeValue = { stringValue: string } | { intValue: string } | { boolValue: boolean };
type Attributes = Array<{ key: string; value: AttributeValue }>;

function attributes(values: Record<string, unknown>): Attributes {
  return Object.entries(values).flatMap(([key, v]): Attributes => {
    if (typeof v === 'string') return [{ key, value: { stringValue: v } }];
    if (typeof v === 'number' && Number.isSafeInteger(v)) return [{ key, value: { intValue: String(v) } }];
    if (typeof v === 'boolean') return [{ key, value: { boolValue: v } }];
    return [];
  });
}

const epoch = (time: number) => (BigInt(time) * 1_000_000n).toString();
const spanId = (id: string) => stableId('otlp-span', id).slice(0, 16);
const traceId = (id: string) => /^[0-9a-f]{32}$/.test(id) ? id : stableId('otlp-trace', id);
const content = (value: unknown) => value === undefined ? undefined : JSON.stringify(sanitize(value, { redact: true, maxChars: 8000 }));

export function otlpPayload(events: IngestionEvent[], agent: string, options: Pick<OtlpConfig, 'serviceName' | 'captureContent'>) {
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
    const trace = traces.get(body.traceId);
    const event = eventsById.get(body.id);
    const generation = event === 'generation-create';
    const tool = event === 'tool-create';
    const net = body.usageDetails as Record<string, number> | undefined;
    const meta = body.metadata as Record<string, unknown> | undefined;
    const start = Date.parse(String(body.startTime ?? trace?.timestamp));
    if (!Number.isFinite(start)) return [];
    const observedEnd = Date.parse(String(body.endTime));
    const end = Number.isFinite(observedEnd) ? Math.max(start, observedEnd) : start;
    const cacheRead = net?.input_cached_tokens ?? net?.cache_read_input_tokens ?? 0;
    const cacheWrite = net?.input_cache_creation ?? net?.cache_creation_input_tokens ?? 0;
    const operation = generation ? 'chat' : tool ? 'execute_tool' : 'invoke_agent';
    const nativeTraceId = traceId(body.traceId);
    const input = options.captureContent ? content(body.input) : undefined;
    const output = options.captureContent ? content(body.output) : undefined;
    const github = !body.parentObservationId
      ? (trace?.metadata as { github?: GithubContext } | undefined)?.github : undefined;
    const links = ['issuedByObservationId', 'consumedByObservationId'].flatMap(key => {
      const id = meta?.[key];
      return typeof id === 'string' && observations.has(id)
        ? [{ traceId: nativeTraceId, spanId: spanId(id), attributes: attributes({ 'coding_agent.link.role': key }) }]
        : [];
    });
    return [{ traceId: nativeTraceId, spanId: spanId(body.id),
      ...(typeof body.parentObservationId === 'string' && observations.has(body.parentObservationId) ? { parentSpanId: spanId(body.parentObservationId) } : {}),
      name: String(body.name ?? operation), kind: generation ? 3 : 1, startTimeUnixNano: epoch(start), endTimeUnixNano: epoch(end),
      status: { code: body.level === 'ERROR' ? 2 : 0 }, links,
      attributes: attributes({ 'gen_ai.operation.name': operation, 'gen_ai.agent.name': agent,
        'user.id': generation || tool ? undefined : trace?.userId,
        'gen_ai.conversation.id': trace?.sessionId, 'gen_ai.request.model': body.model,
        'gen_ai.tool.name': tool ? body.name : undefined,
        'gen_ai.tool.call.id': tool && meta?.toolCallId !== undefined ? String(meta.toolCallId) : undefined,
        'gen_ai.usage.input_tokens': typeof net?.input === 'number' ? net.input + cacheRead + cacheWrite : undefined,
        'gen_ai.usage.output_tokens': net?.output,
        'gen_ai.usage.cache_read.input_tokens': net && cacheRead,
        'gen_ai.usage.cache_creation.input_tokens': net && cacheWrite,
        'coding_agent.timing.has_end': Number.isFinite(observedEnd),
        'coding_agent.input': input,
        'coding_agent.output': output,
        'langfuse.observation.input': input,
        'langfuse.observation.output': output,
        ...(github ? githubAttributes(github) : {}),
        'langfuse.observation.metadata.github': github ? JSON.stringify(github) : undefined,
        'langfuse.trace.metadata.github': github ? JSON.stringify(github) : undefined }),
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

export async function exportOtlp(config: OtlpConfig, events: IngestionEvent[], agent: string): Promise<IngestResult> {
  try {
    const payload = otlpPayload(events, agent, config);
    const res = await fetch(config.endpoint, { method: 'POST', headers: config.headers,
      body: JSON.stringify(payload), signal: AbortSignal.timeout(config.timeoutMs), redirect: 'error' });
    if (!res.ok) return { ok: false, sent: 0, errors: [{ status: res.status, message: 'OTLP export failed' }] };
    const text = await res.text();
    const partial = text ? JSON.parse(text).partialSuccess : undefined;
    const rejected = Number(partial?.rejectedSpans ?? 0);
    const sent = payload.resourceSpans[0].scopeSpans[0].spans.length - rejected;
    return { ok: rejected === 0, sent, errors: rejected ? [{ message: `OTLP receiver rejected ${rejected} spans` }] : [] };
  } catch {
    return { ok: false, sent: 0, errors: [{ message: 'OTLP export failed' }] };
  }
}
