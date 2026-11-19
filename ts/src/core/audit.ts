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
  startTime: string;
  endTime?: string;
  input?: unknown;
  output?: unknown;
  metadata?: { kind?: string; toolCallId?: string | number; issuedByObservationId?: string;
    consumedByObservationId?: string; sourceStartTime?: string; sourceEndTime?: string };
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

function auditStoredTrace(trace: StoredTrace) {
  const observations = Array.isArray(trace.observations) ? trace.observations : [];
  const root = observations.find((span) => span.type === 'AGENT') ?? observations.find((span) => span.type === 'CHAIN');
  const steps: Turn['steps'] = [];
  let toolsWithoutIds = 0;
  let reversedSpans = 0;
  let outOfOrderToolLinks = 0;
  let tools = 0;
  const linked = new Set<string>();
  const generations = new Map(observations.filter((span) => span.type === 'GENERATION').map((span) => [span.id, span]));
  for (const span of observations) {
    const isTool = span.type === 'TOOL' || span.metadata?.kind === 'tool';
    const sourceTiming = span.metadata?.kind === 'tool';
    const started = sourceTiming ? span.metadata?.sourceStartTime : span.startTime;
    const ended = sourceTiming ? span.metadata?.sourceEndTime : span.endTime;
    if (started && ended && Date.parse(ended) < Date.parse(started)) reversedSpans++;
    if (span.type === 'GENERATION') {
      steps.push({ kind: 'generation', key: span.id, name: 'generation', startTime: span.startTime,
        endTime: span.endTime ?? span.startTime, input: decode(span.input), output: decode(span.output) });
    } else if (isTool) {
      tools++;
      const callId = span.metadata?.toolCallId;
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
  const turn: Turn = { key: trace.id, index: 1, sessionId: '', offset: 0, complete,
    startTime: root?.startTime ?? trace.timestamp, endTime: root?.endTime ?? root?.startTime ?? trace.timestamp,
    steps, events: [], metadata: {} };
  const tags = Array.isArray(trace.tags) ? trace.tags : [];
  const supported = ['claude-code', 'codex', 'oh-my-pi', 'omp', 'antigravity', 'opencode', 'gemini-cli', 'oh-my-codex'];
  const agent = supported.find((name) => trace.metadata?.agent === name || tags.includes(name)) ?? 'unknown';
  const analysis = analyzeTimeline(turn);
  for (const [key, link] of analysis.links) {
    if (link.issuedBy && link.consumedBy) linked.add(key);
  }
  const counts: Record<string, number> = {};
  for (const issue of analysis.issues) counts[issue.name] = (counts[issue.name] ?? 0) + 1;
  return { agent, tools, toolsWithoutIds, toolLinks: linked.size, reversedSpans, outOfOrderToolLinks, counts };
}

export async function auditLangfuse(client: LangfuseClient, limit: number) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({ limit: String(limit), fromTimestamp: since });
  const page = await client.read<{ data: Array<{ id: string }> }>('/api/public/traces?' + query);
  const groups: Record<string, { traces: number; tools: number; toolLinks: number; toolsWithoutIds: number;
    reversedSpans: number; outOfOrderToolLinks: number; counts: Record<string, number> }> = {};
  for (let i = 0; i < page.data.length; i += 4) {
    const traces = await Promise.all(page.data.slice(i, i + 4).map(({ id }) =>
      client.read<StoredTrace>('/api/public/traces/' + encodeURIComponent(id))));
    for (const trace of traces) {
      const row = auditStoredTrace(trace);
      const group = groups[row.agent] ??= { traces: 0, tools: 0, toolLinks: 0, toolsWithoutIds: 0, reversedSpans: 0, outOfOrderToolLinks: 0, counts: {} };
      group.traces++;
      group.tools += row.tools;
      group.toolLinks += row.toolLinks;
      group.toolsWithoutIds += row.toolsWithoutIds;
      group.reversedSpans += row.reversedSpans;
      group.outOfOrderToolLinks += row.outOfOrderToolLinks;
      for (const [name, count] of Object.entries(row.counts)) group.counts[name] = (group.counts[name] ?? 0) + count;
    }
  }
  return { since, traces: page.data.length, agents: groups };
}
