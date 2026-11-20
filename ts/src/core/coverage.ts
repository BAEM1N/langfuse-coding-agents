import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readObservations, withReadApi } from './audit.ts';
import { traceIdFor } from './batch.ts';
import type { Config } from './config.ts';
import type { LangfuseClient } from './langfuse.ts';
import { batchOptions, parseTranscript } from './run.ts';
import { isCodexThread } from './subagents.ts';
import type { AgentName, SubAgentRun, Turn, Usage } from './types.ts';

// Compares the local transcripts (what happened) with the project (what was
// logged): which turns are missing, which are stored short, and which model
// calls have no cost. Reads only. Reports counts and IDs, never text.

export interface CoverageOptions {
  /** ISO time: turns that started at or after it. */
  since: string;
  until?: string;
  api?: 'v2' | 'legacy';
  /** With the stored-trace API, how many stored turns to compare step by step. */
  deep: number;
}

interface LocalTurn {
  traceId: string;
  session: string;
  index: number;
  start: string;
  finished: boolean;
  modelCalls: number;
  tools: number;
  tokens: number;
  /** The same three without sub-agent work, to recognise turns stored before it was captured. */
  mainModelCalls: number;
  mainTools: number;
  mainTokens: number;
  subagentRuns: number;
}
interface StoredTurn { modelCalls: number; tools: number; tokens: number; inProgress?: boolean; detailed: boolean }

const tokensOf = (usage: Usage | Record<string, unknown> | undefined): number => {
  if (!usage) return 0;
  const n = (key: string) => (typeof usage[key] === 'number' ? usage[key] as number : 0);
  // The adapters store exclusive parts plus their sum. Prefer the sum they recorded.
  return n('total') || n('input') + n('output') + n('input_cached_tokens') + n('cache_read_input_tokens')
    + n('cache_creation_input_tokens') + n('input_cache_creation') + n('output_reasoning_tokens');
};

function flatten(runs: SubAgentRun[] | undefined, out: SubAgentRun[] = []): SubAgentRun[] {
  for (const run of runs ?? []) { out.push(run); flatten(run.children, out); }
  return out;
}

function walk(dir: string, skip: ReadonlySet<string>, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(path, skip, out); }
    else if (entry.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

export function localTurns(agent: AgentName, cfg: Config, since: string, until?: string): { turns: LocalTurn[]; unreadable: number } {
  const tag = batchOptions(cfg).agentTag;
  const files = agent === 'claude' ? walk(join(cfg.agentHome, 'projects'), new Set(['subagents', 'tool-results']))
    : walk(join(cfg.agentHome, 'sessions'), new Set());
  const turns: LocalTurn[] = [];
  let unreadable = 0;
  const from = Date.parse(since);
  for (const file of files) {
    try {
      if (statSync(file).mtimeMs < from) continue; // nothing in it can be in range
      if (agent === 'codex' && isCodexThread(file)) continue; // read through its parent
      const session = agent === 'claude' ? basename(file, '.jsonl') : basename(file, '.jsonl').replace(/^rollout-[\dT-]+-/, '');
      for (const turn of parseTranscript(agent, file, session, { offset: 0, turnsBefore: 0 }, cfg.subagents && 'read-only').turns as Turn[]) {
        if (turn.startTime < since || (until && turn.startTime >= until)) continue;
        const count = (steps: Turn['steps']) => ({ calls: steps.filter(s => s.kind === 'generation').length,
          tools: steps.filter(s => s.kind === 'tool').length,
          tokens: steps.reduce((sum, s) => sum + (s.kind === 'generation' ? tokensOf(s.usage) : 0), 0) });
        const main = count(turn.steps);
        const runs = flatten(turn.children);
        const sub = runs.map(run => count(run.steps));
        const total = (key: 'calls' | 'tools' | 'tokens') => main[key] + sub.reduce((sum, item) => sum + item[key], 0);
        turns.push({ traceId: traceIdFor(tag, turn.sessionId, turn.key), session: turn.sessionId, index: turn.index, start: turn.startTime,
          finished: turn.complete, modelCalls: total('calls'), tools: total('tools'), tokens: total('tokens'),
          mainModelCalls: main.calls, mainTools: main.tools, mainTokens: main.tokens, subagentRuns: runs.length });
      }
    } catch {
      unreadable++;
    }
  }
  return { turns, unreadable };
}

async function inParallel<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (next < items.length) await work(items[next++]); }));
}

interface Stored { turns: Map<string, StoredTurn>; uncosted: Map<string, number>; costed: number; modelCalls: number }

async function readStored(client: LangfuseClient, api: 'v2' | 'legacy', local: LocalTurn[], options: CoverageOptions): Promise<Stored> {
  const stored: Stored = { turns: new Map(), uncosted: new Map(), costed: 0, modelCalls: 0 };
  const wanted = new Set(local.map(turn => turn.traceId));
  const sessions = [...new Set(local.map(turn => turn.session))];
  const add = (traceId: string, type: string, usage: Record<string, unknown> | undefined, cost: unknown, model: unknown) => {
    if (!wanted.has(traceId)) return; // sub-agent traces and other agents share the session
    const turn = stored.turns.get(traceId) ?? { modelCalls: 0, tools: 0, tokens: 0, detailed: true };
    turn.detailed = true;
    if (type === 'TOOL') turn.tools++;
    if (type === 'GENERATION') {
      turn.modelCalls++;
      turn.tokens += tokensOf(usage);
      stored.modelCalls++;
      if (typeof cost === 'number' && cost > 0) stored.costed++;
      else stored.uncosted.set(String(model ?? 'unknown'), (stored.uncosted.get(String(model ?? 'unknown')) ?? 0) + 1);
    }
    stored.turns.set(traceId, turn);
  };
  if (api === 'v2') {
    // One paged read per session returns every observation with usage and cost.
    await inParallel(sessions, 3, async (session) => {
      const { observations } = await readObservations(client, { sessionId: session, fromStartTime: options.since }, 20, 'core,basic,usage,model');
      for (const o of observations as Array<Record<string, any>>) add(o.traceId, o.type, o.usageDetails, o.totalCost, o.model);
    });
    return stored;
  }
  await inParallel(sessions, 4, async (session) => {
    for (let page = 1; page <= 30; page++) {
      const list = await client.read<{ data?: Array<{ id: string; name?: string; metadata?: { complete?: boolean } }>; meta?: { totalPages?: number } }>(
        `/api/public/traces?sessionId=${encodeURIComponent(session)}&limit=100&page=${page}`);
      for (const trace of list.data ?? []) {
        if (!wanted.has(trace.id)) continue;
        stored.turns.set(trace.id, { modelCalls: 0, tools: 0, tokens: 0, detailed: false,
          inProgress: /in progress/.test(trace.name ?? '') || trace.metadata?.complete === false });
      }
      if (page >= (list.meta?.totalPages ?? 1)) break;
    }
  });
  // The stored-trace API needs one read per trace for its steps: do the newest ones.
  const deep = local.filter(turn => turn.finished && stored.turns.has(turn.traceId))
    .sort((a, b) => b.start.localeCompare(a.start)).slice(0, options.deep);
  await inParallel(deep, 4, async (turn) => {
    const trace = await client.read<{ observations?: Array<Record<string, any>> }>('/api/public/traces/' + turn.traceId);
    const kept = stored.turns.get(turn.traceId)!;
    Object.assign(kept, { modelCalls: 0, tools: 0, tokens: 0 });
    for (const o of trace.observations ?? []) add(turn.traceId, o.type, o.usageDetails, o.calculatedTotalCost ?? o.totalCost, o.model);
  });
  return stored;
}

export async function coverage(agent: AgentName, cfg: Config, client: LangfuseClient, options: CoverageOptions) {
  const { turns, unreadable } = localTurns(agent, cfg, options.since, options.until);
  const { api, value: stored } = await withReadApi(options.api, chosen => readStored(client, chosen, turns, options));
  const sessions = new Map<string, LocalTurn[]>();
  for (const turn of turns) sessions.set(turn.session, [...(sessions.get(turn.session) ?? []), turn]);
  const missing = turns.filter(turn => !stored.turns.has(turn.traceId));
  const compared = turns.filter(turn => turn.finished && stored.turns.get(turn.traceId)?.detailed);
  const kinds = { identical: 0, withoutSubagentWork: 0, fewerSteps: 0, moreSteps: 0, sameStepsDifferentTokens: 0 };
  const different: Array<Record<string, unknown>> = [];
  let localTokens = 0, storedTokens = 0;
  for (const turn of compared) {
    const s = stored.turns.get(turn.traceId)!;
    localTokens += turn.tokens;
    storedTokens += s.tokens;
    const same = (calls: number, tools: number, tokens: number) => s.modelCalls === calls && s.tools === tools && s.tokens === tokens;
    const kind = same(turn.modelCalls, turn.tools, turn.tokens) ? 'identical'
      : turn.subagentRuns && same(turn.mainModelCalls, turn.mainTools, turn.mainTokens) ? 'withoutSubagentWork'
        : s.modelCalls < turn.modelCalls || s.tools < turn.tools ? 'fewerSteps'
          : s.modelCalls > turn.modelCalls || s.tools > turn.tools ? 'moreSteps' : 'sameStepsDifferentTokens';
    kinds[kind]++;
    if (kind !== 'identical' && different.length < 25) {
      different.push({ traceId: turn.traceId, kind, modelCalls: `${s.modelCalls}/${turn.modelCalls}`, tools: `${s.tools}/${turn.tools}`,
        tokens: `${s.tokens}/${turn.tokens}` });
    }
  }
  const finishedMissing = missing.filter(turn => turn.finished);
  return {
    agent, api, since: options.since, until: options.until,
    local: { sessions: sessions.size, turns: turns.length, finishedTurns: turns.filter(turn => turn.finished).length,
      modelCalls: turns.reduce((sum, turn) => sum + turn.modelCalls, 0), tokens: turns.reduce((sum, turn) => sum + turn.tokens, 0),
      subagentRuns: turns.reduce((sum, turn) => sum + turn.subagentRuns, 0), unreadableFiles: unreadable },
    stored: { turns: turns.length - missing.length, finishedTurnsMissing: finishedMissing.length,
      unfinishedTurnsMissing: missing.length - finishedMissing.length,
      tokensInMissingTurns: missing.reduce((sum, turn) => sum + turn.tokens, 0),
      sessionsWithoutAnyTrace: [...sessions.values()].filter(list => list.every(turn => !stored.turns.has(turn.traceId))).length,
      finishedButNamedInProgress: turns.filter(turn => turn.finished && stored.turns.get(turn.traceId)?.inProgress).length },
    compared: { turns: compared.length, ...kinds, localTokens, storedTokens, tokensNotStored: localTokens - storedTokens,
      note: 'stored/local in the lists below' },
    cost: { modelCallsChecked: stored.modelCalls, withCost: stored.costed,
      withoutCostByModel: Object.fromEntries([...stored.uncosted].sort((a, b) => b[1] - a[1])) },
    missing: missing.slice(0, 25).map(turn => ({ traceId: turn.traceId, session: turn.session, turn: turn.index, start: turn.start, finished: turn.finished })),
    different,
  };
}
