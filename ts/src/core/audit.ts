import type { LangfuseClient } from './langfuse.ts';
import { analyzeTimeline } from './timeline.ts';
import type { Turn } from './types.ts';

function decode(value: unknown): unknown {
  if (typeof value !== 'string' || !/^\s*[\[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined; // older ingestions can contain truncated JSON
  }
}

interface Observation {
  id: string;
  type: string;
  name?: string;
  startTime: string;
  endTime?: string;
  input?: unknown;
  output?: unknown;
  usageDetails?: Record<string, number>;
  metadata?: Record<string, unknown> & { kind?: string; toolCallId?: string | number;
    attributes?: Record<string, unknown>; issuedByObservationId?: string; consumedByObservationId?: string;
    sourceStartTime?: string; sourceEndTime?: string };
}

interface StoredTrace {
  id: string;
  timestamp: string;
  tags?: string[];
  metadata?: { complete?: boolean; agent?: string };
  observations?: Observation[];
}

export function summarizeTurns(turns: Turn[]) {
  const counts: Record<string, number> = {};
  let toolLinks = 0;
  let completed = 0;
  let tools = 0;
  const affectedTurns = [];
  for (const turn of turns) {
    const result = analyzeTimeline(turn);
    toolLinks += [...result.links.values()].filter((link) => link.issuedBy && link.consumedBy).length;
    tools += turn.steps.filter((step) => step.kind === 'tool').length;
    completed += Number(turn.complete);
    if (!result.issues.length) continue;
    const codes = result.issues.map((issue) => issue.name);
    for (const code of codes) counts[code] = (counts[code] ?? 0) + 1;
    affectedTurns.push({ index: turn.index, codes });
  }
  return { turns: turns.length, completed, tools, toolLinks, counts, affectedTurns };
}

function nativeToolParts(value: unknown, result: boolean): unknown[] {
  const messages = decode(value);
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    if (!Array.isArray(message?.parts)) return [];
    return message.parts.flatMap((part: { type?: string; id?: unknown }) => {
      if (part.type !== (result ? 'tool_call_response' : 'tool_call') || typeof part.id !== 'string') return [];
      return result ? [{ role: 'tool', call_id: part.id }] : [{ type: 'tool_call', id: part.id }];
    });
  });
}

const hasValue = (value: unknown) => value !== undefined && value !== null && value !== '' && value !== 'null';
const nativeAttribute = (span: Observation | undefined, name: string) =>
  span?.metadata?.attributes?.[name] ?? span?.metadata?.[name];

export function auditStoredTrace(trace: StoredTrace) {
  const observations = Array.isArray(trace.observations) ? trace.observations : [];
  // Sub-agent runs are AGENT observations too; the turn's root is the one without a parent.
  const root = observations.find((span) => span.type === 'AGENT' && !(span as { parentObservationId?: string | null }).parentObservationId)
    ?? observations.find((span) => span.type === 'AGENT')
    ?? observations.find((span) => span.type === 'CHAIN' || nativeAttribute(span, 'gen_ai.operation.name') === 'invoke_agent');
  const nativeAgent = nativeAttribute(root, 'gen_ai.agent.name');
  // Goose emits a provider span and a chat wrapper for the same request. The
  // provider span holds the message parts needed for call-ID correlation.
  const isGeneration = (span: Observation) => (span.type === 'GENERATION' || nativeAttribute(span, 'gen_ai.operation.name') === 'chat')
    && (nativeAgent !== 'goose' || span.name === 'stream_response_from_provider');
  const steps: Turn['steps'] = [];
  let toolsWithoutIds = 0;
  let reversedSpans = 0;
  let outOfOrderToolLinks = 0;
  let tools = 0;
  const coverage = { modelCalls: 0, modelInputs: 0, modelOutputs: 0, modelTokenUsage: 0, toolInputs: 0, toolOutputs: 0 };
  const linked = new Set<string>();
  const generations = new Map(observations.filter(isGeneration).map((span) => [span.id, span]));
  for (const span of observations) {
    const isTool = span.type === 'TOOL' || span.metadata?.kind === 'tool'
      || nativeAttribute(span, 'gen_ai.operation.name') === 'execute_tool';
    const sourceTiming = span.metadata?.kind === 'tool';
    const started = sourceTiming ? span.metadata?.sourceStartTime : span.startTime;
    const ended = sourceTiming ? span.metadata?.sourceEndTime : span.endTime;
    if (started && ended && Date.parse(ended) < Date.parse(started)) reversedSpans++;
    if (isGeneration(span)) {
      const input = span.input ?? nativeAttribute(span, 'gen_ai.input.messages');
      const output = span.output ?? nativeAttribute(span, 'gen_ai.output.messages');
      coverage.modelCalls++;
      coverage.modelInputs += Number(hasValue(input));
      coverage.modelOutputs += Number(hasValue(output));
      coverage.modelTokenUsage += Number(hasValue(span.usageDetails?.input ?? nativeAttribute(span, 'gen_ai.usage.input_tokens'))
        && hasValue(span.usageDetails?.output ?? nativeAttribute(span, 'gen_ai.usage.output_tokens')));
      steps.push({ kind: 'generation', key: span.id, name: 'generation', startTime: span.startTime,
        endTime: span.endTime ?? span.startTime,
        input: nativeAgent === 'goose' || span.input == null ? nativeToolParts(input, true) : decode(input),
        output: nativeAgent === 'goose' || span.output == null ? nativeToolParts(output, false) : decode(output) });
    } else if (isTool) {
      tools++;
      coverage.toolInputs += Number(hasValue(span.input ?? nativeAttribute(span, 'gen_ai.tool.call.arguments')));
      coverage.toolOutputs += Number(hasValue(span.output ?? nativeAttribute(span, 'gen_ai.tool.call.result')));
      const callId = span.metadata?.toolCallId ?? nativeAttribute(span, 'gen_ai.tool.call.id');
      if ((typeof callId !== 'string' && typeof callId !== 'number') || callId === '') {
        toolsWithoutIds++;
        continue;
      }
      const issuer = generations.get(span.metadata?.issuedByObservationId ?? '');
      const consumer = generations.get(span.metadata?.consumedByObservationId ?? '');
      if (issuer && consumer) {
        linked.add(String(callId));
        // Streamed responses can dispatch a tool before the issuing generation finishes.
        if ((started && Date.parse(issuer.startTime) > Date.parse(started))
          || (ended && Date.parse(ended) > Date.parse(consumer.startTime))) outOfOrderToolLinks++;
      }
      if (started) steps.push({ kind: 'tool', key: String(callId), name: 'tool', startTime: started, endTime: ended });
    }
  }
  // Legacy exports did not persist the call ID on tool spans and may omit clipped inputs.
  // Check observed links and durations, but do not declare missing ends on those exports.
  const complete = trace.metadata?.complete === true && toolsWithoutIds === 0
    && steps.some((step) => step.kind === 'tool');
  steps.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const turn: Turn = { key: trace.id, index: 1, sessionId: '', offset: 0, complete,
    startTime: root?.startTime ?? trace.timestamp, endTime: root?.endTime ?? root?.startTime ?? trace.timestamp,
    steps, events: [], metadata: {} };
  const tags = Array.isArray(trace.tags) ? trace.tags : [];
  const supported = ['claude-code', 'codex', 'oh-my-pi', 'omp', 'antigravity', 'opencode', 'gemini-cli', 'oh-my-codex', 'goose', 'copilot', 'deepagents'];
  const agent = supported.find((name) => trace.metadata?.agent === name || tags.includes(name) || nativeAgent === name) ?? 'unknown';
  const analysis = analyzeTimeline(turn);
  for (const [key, link] of analysis.links) {
    if (link.issuedBy && link.consumedBy) linked.add(key);
  }
  const counts: Record<string, number> = {};
  for (const issue of analysis.issues) counts[issue.name] = (counts[issue.name] ?? 0) + 1;
  return { agent, tools, toolsWithoutIds, toolLinks: linked.size, reversedSpans, outOfOrderToolLinks, coverage, counts };
}

type AgentGroups = Record<string, { traces: number; tools: number; toolLinks: number; toolsWithoutIds: number;
  reversedSpans: number; outOfOrderToolLinks: number; coverage: ReturnType<typeof auditStoredTrace>['coverage']; counts: Record<string, number> }>;

function addTrace(groups: AgentGroups, trace: StoredTrace): void {
  const row = auditStoredTrace(trace);
  const group = groups[row.agent];
  if (!group) {
    const { agent, ...summary } = row;
    groups[agent] = { traces: 1, ...summary };
    return;
  }
  group.traces++;
  group.tools += row.tools;
  group.toolLinks += row.toolLinks;
  group.toolsWithoutIds += row.toolsWithoutIds;
  group.reversedSpans += row.reversedSpans;
  group.outOfOrderToolLinks += row.outOfOrderToolLinks;
  for (const name of Object.keys(row.coverage) as Array<keyof typeof row.coverage>) group.coverage[name] += row.coverage[name];
  for (const [name, count] of Object.entries(row.counts)) group.counts[name] = (group.counts[name] ?? 0) + count;
}

export interface AuditWindow {
  /** Maximum number of traces to audit, newest first. */
  limit: number;
  /** ISO timestamps. Defaults to the last 24 hours. */
  from?: string;
  to?: string;
}

/** Trace-centric read API of Langfuse v3 and self-hosted legacy/dual write modes. */
export async function auditLangfuse(client: LangfuseClient, window: AuditWindow | number) {
  const { limit, from, to } = typeof window === 'number' ? { limit: window } as AuditWindow : window;
  const since = from ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({ limit: String(limit), fromTimestamp: since });
  if (to) query.set('toTimestamp', to);
  const page = await client.read<{ data: Array<{ id: string }> }>('/api/public/traces?' + query);
  const groups: AgentGroups = {};
  for (let i = 0; i < page.data.length; i += 4) {
    const traces = await Promise.all(page.data.slice(i, i + 4).map(({ id }) =>
      client.read<StoredTrace>('/api/public/traces/' + encodeURIComponent(id))));
    for (const trace of traces) addTrace(groups, trace);
  }
  return { api: 'legacy' as const, since, until: to, traces: page.data.length, agents: groups };
}

interface ObservationV2 extends Observation {
  traceId: string;
  parentObservationId?: string | null;
  tags?: string[];
}

const V2_FIELDS = 'core,basic,io,usage,metadata,model,trace_context';
const V2_PAGE = 1000;
const V2_MAX_PAGES = 50;

/** Read one page-chain of observations. `meta.cursor` may be present on an empty page. */
export async function readObservations(client: LangfuseClient, filter: Record<string, string>, maxPages = V2_MAX_PAGES) {
  const observations: ObservationV2[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const query = new URLSearchParams({ ...filter, fields: V2_FIELDS, limit: String(V2_PAGE) });
    if (cursor) query.set('cursor', cursor);
    const page = await client.read<{ data?: ObservationV2[]; meta?: { cursor?: string | null } }>('/api/public/v2/observations?' + query);
    observations.push(...(Array.isArray(page.data) ? page.data : []));
    cursor = page.meta?.cursor || undefined;
    pages++;
  } while (cursor && pages < maxPages);
  return { observations, truncated: Boolean(cursor) };
}

const truthy = (value: unknown) => value === true || value === 'true';

/** Rebuild a trace from its observations: v4 has no stored trace row to read. */
export function traceFromObservations(traceId: string, observations: ObservationV2[]): StoredTrace {
  const root = observations.find((span) => !span.parentObservationId) ?? observations[0];
  const attribute = (name: string) => root?.metadata?.[name] ?? root?.metadata?.attributes?.['langfuse.trace.metadata.' + name];
  const agent = attribute('agent');
  return {
    id: traceId,
    timestamp: root?.startTime ?? '',
    tags: Array.isArray(root?.tags) ? root.tags : [],
    metadata: { complete: truthy(attribute('complete')), agent: typeof agent === 'string' ? agent : undefined },
    observations,
  };
}

/** Observation-centric read API of Langfuse Cloud and self-hosted v4. */
export async function auditLangfuseV2(client: LangfuseClient, window: AuditWindow) {
  const since = window.from ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const filter: Record<string, string> = { fromStartTime: since };
  if (window.to) filter.toStartTime = window.to;
  const { observations, truncated } = await readObservations(client, filter);
  const byTrace = new Map<string, ObservationV2[]>();
  for (const observation of observations) {
    if (typeof observation?.traceId !== 'string') continue;
    const group = byTrace.get(observation.traceId);
    if (group) group.push(observation); else byTrace.set(observation.traceId, [observation]);
  }
  const traces = [...byTrace].map(([id, group]) => traceFromObservations(id, group))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, window.limit);
  const groups: AgentGroups = {};
  for (const trace of traces) addTrace(groups, trace);
  // A trace that starts before the window is read without its earlier spans.
  return { api: 'v2' as const, since, until: window.to, observations: observations.length, truncated,
    traces: traces.length, tracesInWindow: byTrace.size, agents: groups };
}

/**
 * A self-hosted v4 server in `legacy` or `dual` write mode answers the v2
 * observations API with 404 and still serves stored traces. Try v2, then fall
 * back, and report which API answered.
 */
export async function withReadApi<T>(preferred: 'v2' | 'legacy' | undefined,
  read: (api: 'v2' | 'legacy') => Promise<T>): Promise<{ api: 'v2' | 'legacy'; value: T }> {
  if (preferred) return { api: preferred, value: await read(preferred) };
  try {
    return { api: 'v2', value: await read('v2') };
  } catch (error) {
    if (!/HTTP 404/.test((error as Error).message)) throw error;
    return { api: 'legacy', value: await read('legacy') };
  }
}

/** Read one trace back to check that a delivery actually reached storage. */
export async function readTraceObservations(client: LangfuseClient, api: 'v2' | 'legacy', traceId: string) {
  if (api === 'legacy') {
    let trace: StoredTrace;
    try {
      trace = await client.read<StoredTrace>('/api/public/traces/' + encodeURIComponent(traceId));
    } catch (error) {
      if (/HTTP 404/.test((error as Error).message)) return []; // no such trace
      throw error;
    }
    return (trace.observations ?? []).map((span) => ({ id: span.id, type: span.type }));
  }
  const { observations } = await readObservations(client, { traceId }, 5);
  return observations.map((span) => ({ id: span.id, type: span.type }));
}
