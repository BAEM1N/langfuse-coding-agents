import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { readObservations, withReadApi } from './audit.ts';
import { subagentTraceIdFor, traceIdFor } from './batch.ts';
import type { Config } from './config.ts';
import { LangfuseClient } from './langfuse.ts';
import { nullLogger } from './log.ts';
import { runHook } from './run.ts';

// End-to-end check against the configured Langfuse project, with data made up
// here: one turn that starts a sub-agent, plus a notification. It is sent the
// way the hooks send, read back, compared, and deleted. Nothing from a real
// session is involved, and the agent's own state is not touched.

const ENVIRONMENT = 'hook-selftest';

interface StoredObservation {
  id: string;
  type: string;
  name?: string;
  parentObservationId?: string | null;
  usageDetails?: Record<string, number>;
  metadata?: Record<string, unknown>;
  level?: string;
}
interface StoredTrace { sessionId?: string; tags?: string[]; name?: string; metadata?: Record<string, unknown>; observations: StoredObservation[] }

function synthetic(session: string) {
  const start = Date.now() - 120_000;
  const at = (ms: number) => new Date(start + ms).toISOString();
  const main = [
    { type: 'user', uuid: 'u1', promptId: 'p1', sessionId: session, timestamp: at(0), origin: { kind: 'human' }, promptSource: 'typed',
      turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: 'Self-test prompt (synthetic)' } },
    { type: 'api-request', sessionId: session, timestamp: at(100) },
    { type: 'assistant', uuid: 'a1', sessionId: session, timestamp: at(1500), requestId: 'req_selftest_1', message: { id: 'msg_A', role: 'assistant',
      model: 'claude-selftest', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { description: 'synthetic sub-agent' } }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } },
    { type: 'user', uuid: 'u2', sessionId: session, timestamp: at(6000), message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'synthetic sub-agent result' }] } },
    { type: 'api-request', sessionId: session, timestamp: at(6100) },
    { type: 'assistant', uuid: 'a2', sessionId: session, timestamp: at(7500), requestId: 'req_selftest_2', message: { id: 'msg_B', role: 'assistant',
      model: 'claude-selftest', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Self-test complete (synthetic)' }],
      usage: { input_tokens: 6, output_tokens: 4, cache_read_input_tokens: 120 } } },
    { type: 'system', subtype: 'turn_duration', uuid: 's1', sessionId: session, timestamp: at(7600), durationMs: 7600 },
  ];
  const side = (row: object) => ({ isSidechain: true, agentId: 'a1', sessionId: session, ...row });
  const agent = [
    side({ type: 'user', uuid: 'su1', timestamp: at(2000), message: { role: 'user', content: 'Synthetic sub-agent prompt' } }),
    side({ type: 'assistant', uuid: 'sa1', timestamp: at(3000), message: { id: 'msg_S1', role: 'assistant', model: 'claude-selftest-small', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Glob', input: { pattern: '*' } }], usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 40 } } }),
    side({ type: 'user', uuid: 'su2', timestamp: at(3500), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: 'synthetic.txt' }] } }),
    side({ type: 'assistant', uuid: 'sa2', timestamp: at(5000), message: { id: 'msg_S2', role: 'assistant', model: 'claude-selftest-small', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Synthetic sub-agent answer' }], usage: { input_tokens: 9, output_tokens: 4 } } }),
  ];
  return { main, agent, mainTokens: 135 + 130, agentTokens: 50 + 13 };
}

async function readBack(client: LangfuseClient, api: 'v2' | 'legacy', traceId: string): Promise<StoredTrace | undefined> {
  if (api === 'legacy') {
    try {
      return await client.read<StoredTrace>('/api/public/traces/' + traceId);
    } catch (error) {
      if (/HTTP 404/.test((error as Error).message)) return undefined;
      throw error;
    }
  }
  const { observations } = await readObservations(client, { traceId }, 3);
  if (!observations.length) return undefined;
  const rows = observations as Array<StoredObservation & { sessionId?: string; tags?: string[]; traceName?: string }>;
  const root = rows.find(row => !row.parentObservationId) ?? rows[0];
  // v4 has no trace row: trace-level fields are repeated on each observation.
  return { sessionId: root.sessionId, tags: root.tags, name: root.traceName, metadata: root.metadata, observations: rows };
}

export interface SelfTestOptions {
  /** Leave the two synthetic traces in the project to look at. */
  keep: boolean;
  api?: 'v2' | 'legacy';
  /** How long to wait for the project to show what was sent. */
  waitMs?: number;
}

export async function selfTest(cfg: Config, options: SelfTestOptions) {
  if (!cfg.publicKey || !cfg.secretKey) throw new Error('missing Langfuse keys');
  const session = 'hook-selftest-' + Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'langfuse-hooks-selftest-'));
  const transcript = join(dir, 'session.jsonl');
  const data = synthetic(session);
  writeFileSync(transcript, data.main.map(row => JSON.stringify(row)).join('\n') + '\n');
  mkdirSync(join(dir, 'session', 'subagents'), { recursive: true });
  writeFileSync(join(dir, 'session', 'subagents', 'agent-a1.jsonl'), data.agent.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(dir, 'session', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'SelfTest', toolUseId: 'toolu_1', finished: true, spawnDepth: 1 }));

  // The hook reads its settings from the environment. Point it at a throwaway
  // home so the real read positions and delivery records stay as they are.
  const settings: Record<string, string> = { CLAUDE_CONFIG_DIR: join(dir, 'home'), LANGFUSE_AGENT_HOOKS_CONFIG_DIR: join(dir, 'shared'),
    TRACE_TO_LANGFUSE: 'true', LANGFUSE_PUBLIC_KEY: cfg.publicKey, LANGFUSE_SECRET_KEY: cfg.secretKey, LANGFUSE_BASE_URL: cfg.baseUrl,
    CC_LANGFUSE_PUBLIC_KEY: '', CC_LANGFUSE_SECRET_KEY: '', CC_LANGFUSE_BASE_URL: '', CC_LANGFUSE_USER_ID: '',
    LANGFUSE_HOOK_TRANSPORT: 'otlp', CODING_AGENT_OTLP_ENABLED: 'false', CODING_AGENT_GITHUB_METADATA: 'false',
    LANGFUSE_TRACING_ENVIRONMENT: ENVIRONMENT, CODING_AGENT_USER_NAME: 'hook-selftest', LANGFUSE_HOOK_CAPTURE_CONTENT: 'true',
    CODING_AGENT_SUBAGENTS: 'true', CODING_AGENT_SUBAGENT_TRACES: 'true', LANGFUSE_HOOK_STALE_TURN_MINUTES: '0' };
  const previous = new Map(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: string) => { checks.push({ check: name, ok, detail: ok ? undefined : detail }); };
  const turnId = traceIdFor('claude-code', session, 'p1');
  const runId = subagentTraceIdFor('claude-code', session, 'a1');
  const client = new LangfuseClient({ baseUrl: cfg.baseUrl, publicKey: cfg.publicKey, secretKey: cfg.secretKey,
    timeoutMs: Math.max(cfg.timeoutMs, 30000), logger: nullLogger });
  let api: 'v2' | 'legacy' | undefined = options.api;
  let deleted: boolean | undefined;
  try {
    const payload = { session_id: session, transcript_path: transcript };
    const sent = await runHook('claude', { ...payload, hook_event_name: 'Stop' }, nullLogger);
    await runHook('claude', { ...payload, hook_event_name: 'Notification', notification_type: 'selftest', message: 'synthetic notification' }, nullLogger);
    const outcome = sent.destinations?.find(destination => destination.kind === 'langfuse-otlp');
    const statuses = outcome?.traces.map(trace => trace.status) ?? [];
    check('accepted by the OTLP endpoint', statuses.length === 2 && statuses.every(status => status === 'delivered'),
      outcome?.traces.map(trace => `${trace.status}${trace.httpStatus ? ' HTTP ' + trace.httpStatus : ''}${trace.message ? ' ' + trace.message : ''}`).join('; ') || 'nothing was sent');

    let turn: StoredTrace | undefined;
    let run: StoredTrace | undefined;
    const deadline = Date.now() + (options.waitMs ?? 90_000);
    do {
      const read = await withReadApi(api, async chosen => [await readBack(client, chosen, turnId), await readBack(client, chosen, runId)] as const);
      api = read.api;
      [turn, run] = read.value;
      if (turn && run && turn.observations.length >= 9 && run.observations.length >= 4) break;
      await wait(3000);
    } while (Date.now() < deadline);

    check('turn trace stored', Boolean(turn), 'not found by trace ID ' + turnId);
    check('sub-agent trace stored', Boolean(run), 'not found by trace ID ' + runId);
    if (turn) {
      const observations = turn.observations;
      const byId = new Map(observations.map(observation => [observation.id, observation]));
      const types = (list: StoredObservation[]) => list.map(observation => observation.type).sort().join(',');
      check('turn: one root agent, the sub-agent, four model calls, two tools, one event',
        types(observations) === 'AGENT,AGENT,EVENT,GENERATION,GENERATION,GENERATION,GENERATION,TOOL,TOOL', types(observations));
      check('no observation stored twice', new Set(observations.map(observation => observation.id)).size === observations.length);
      const agent = observations.find(observation => observation.name === 'Subagent: SelfTest');
      const call = observations.find(observation => observation.type === 'TOOL' && observation.name === 'Task');
      check('sub-agent sits under the tool call that started it', Boolean(agent && call && agent.parentObservationId === call.id),
        'parent is ' + (byId.get(agent?.parentObservationId ?? '')?.name ?? 'missing'));
      const inner = observations.filter(observation => agent && observation.parentObservationId === agent.id);
      check('sub-agent model calls and tool sit under the sub-agent', types(inner) === 'GENERATION,GENERATION,TOOL', types(inner));
      const tokens = observations.filter(observation => observation.type === 'GENERATION')
        .reduce((sum, observation) => sum + (observation.usageDetails?.total ?? 0), 0);
      check(`turn tokens are main ${data.mainTokens} + sub-agent ${data.agentTokens}`, tokens === data.mainTokens + data.agentTokens, 'stored ' + tokens);
      const first = observations.find(observation => observation.type === 'GENERATION' && observation.parentObservationId !== agent?.id
        && observation.usageDetails?.cache_creation_input_tokens);
      check('cache tokens kept as separate parts', first?.usageDetails?.input === 10 && first.usageDetails.cache_read_input_tokens === 100
        && first.usageDetails.cache_creation_input_tokens === 20, JSON.stringify(first?.usageDetails));
      const event = observations.find(observation => observation.type === 'EVENT');
      check('notification stored as an event observation', Boolean(event && /^Notification/.test(event.name ?? '')), event?.name);
      const tool = inner.find(observation => observation.type === 'TOOL');
      check('tool call ID and neighbouring model calls kept as metadata', tool?.metadata?.toolCallId === 'toolu_s1'
        && byId.get(String(tool.metadata.issuedByObservationId))?.type === 'GENERATION'
        && byId.get(String(tool.metadata.consumedByObservationId))?.type === 'GENERATION', JSON.stringify(tool?.metadata).slice(0, 200));
      check('adapter metadata kept on a model call', first?.metadata?.stopReason === 'tool_use' && first.metadata.requestId === 'req_selftest_1',
        JSON.stringify({ stopReason: first?.metadata?.stopReason, requestId: first?.metadata?.requestId }));
      check('session and agent tag', turn.sessionId === session && (turn.tags ?? []).includes('claude-code'), JSON.stringify({ sessionId: turn.sessionId, tags: turn.tags }));
      check('link from the turn to the sub-agent trace', agent?.metadata?.subagentTraceId === runId, String(agent?.metadata?.subagentTraceId));
    }
    if (run) {
      const usage = run.observations.filter(observation => observation.usageDetails && Object.keys(observation.usageDetails).length);
      check('sub-agent trace carries no usage of its own', usage.length === 0, usage.length + ' observation(s) with usage');
      check('sub-agent trace: session, tag and link back', run.sessionId === session && (run.tags ?? []).includes('subagent')
        && run.metadata?.parentTraceId === turnId, JSON.stringify({ sessionId: run.sessionId, tags: run.tags, parentTraceId: run.metadata?.parentTraceId }));
    }
    if (!options.keep) {
      const results = await Promise.all([client.deleteTrace(turnId), client.deleteTrace(runId)]);
      deleted = results.every(Boolean);
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { force: true, recursive: true, maxRetries: 3 });
  }
  return { ok: checks.every(item => item.ok), server: cfg.baseUrl, readApi: api, environment: ENVIRONMENT, session,
    traces: { turn: turnId, subagent: runId }, kept: options.keep, deleted, passed: checks.filter(item => item.ok).length,
    failed: checks.filter(item => !item.ok).length, checks };
}
