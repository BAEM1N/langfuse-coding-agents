import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { readObservations, withReadApi } from './audit.ts';
import { subagentTraceIdFor, traceIdFor } from './batch.ts';
import type { Config } from './config.ts';
import { listRecords } from './delivery.ts';
import { LangfuseClient } from './langfuse.ts';
import { nullLogger } from './log.ts';
import { runHook } from './run.ts';

// End-to-end check against the configured Langfuse project, with data made up
// here: one turn that starts a sub-agent, in the transcript format of the
// chosen agent. It is sent the way that agent's integration sends, read back,
// compared, and deleted. Nothing from a real session is involved, and the
// agent's own state is not touched.

const ENVIRONMENT = 'hook-selftest';
export type SelfTestFormat = 'claude' | 'codex' | 'omp' | 'copilot' | 'opencode' | 'antigravity';

interface StoredObservation {
  id: string;
  type: string;
  name?: string;
  parentObservationId?: string | null;
  usageDetails?: Record<string, number>;
  metadata?: Record<string, unknown>;
}
interface StoredTrace { sessionId?: string; tags?: string[]; name?: string; metadata?: Record<string, unknown>; observations: StoredObservation[] }

interface Scenario {
  tag: string;
  turnKey: string;
  runKey: string;
  /** Name of the tool call the sub-agent must hang under. */
  ownerTool: string;
  subagent: string;
  turnTypes: string;
  innerTypes: string;
  mainTokens: number;
  agentTokens: number;
  environment: Record<string, string>;
  send(): Promise<string[] | undefined>;
  /**
   * OpenCode keeps a sub-agent's turns as traces of their own in the parent's
   * session instead of nesting them. Gives the two trace IDs to compare.
   */
  separate?: { turn: string; subagent: string };
  /** Agent home of an integration whose send() returns nothing: its delivery records say what happened. */
  deliveryHome?: string;
  /** Hook timestamps are taken when the hook runs, so timeline warnings may be added: compare without them. */
  ignoreEvents?: boolean;
  /** Checks only this format can make. */
  extra?(turn: StoredTrace, check: (name: string, ok: boolean, detail?: string) => void): void;
}

/** The recorded total, or the sum of the parts when an agent records none. */
const tokensOf = (usage?: Record<string, number>) => usage ? usage.total ?? Object.values(usage).reduce((sum, value) => sum + value, 0) : 0;

const lines = (rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

function claudeScenario(dir: string, session: string): Scenario {
  const start = Date.now() - 120_000;
  const at = (ms: number) => new Date(start + ms).toISOString();
  const transcript = join(dir, 'session.jsonl');
  writeFileSync(transcript, lines([
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
  ]));
  const side = (row: object) => ({ isSidechain: true, agentId: 'a1', sessionId: session, ...row });
  mkdirSync(join(dir, 'session', 'subagents'), { recursive: true });
  writeFileSync(join(dir, 'session', 'subagents', 'agent-a1.jsonl'), lines([
    side({ type: 'user', uuid: 'su1', timestamp: at(2000), message: { role: 'user', content: 'Synthetic sub-agent prompt' } }),
    side({ type: 'assistant', uuid: 'sa1', timestamp: at(3000), message: { id: 'msg_S1', role: 'assistant', model: 'claude-selftest-small', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Glob', input: { pattern: '*' } }], usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 40 } } }),
    side({ type: 'user', uuid: 'su2', timestamp: at(3500), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: 'synthetic.txt' }] } }),
    side({ type: 'assistant', uuid: 'sa2', timestamp: at(5000), message: { id: 'msg_S2', role: 'assistant', model: 'claude-selftest-small', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Synthetic sub-agent answer' }], usage: { input_tokens: 9, output_tokens: 4 } } }),
  ]));
  writeFileSync(join(dir, 'session', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'SelfTest', toolUseId: 'toolu_1', finished: true, spawnDepth: 1 }));
  const payload = { session_id: session, transcript_path: transcript };
  return { tag: 'claude-code', turnKey: 'p1', runKey: 'a1', ownerTool: 'Task', subagent: 'SelfTest',
    turnTypes: 'AGENT,AGENT,EVENT,GENERATION,GENERATION,GENERATION,GENERATION,TOOL,TOOL', innerTypes: 'GENERATION,GENERATION,TOOL',
    mainTokens: 135 + 130, agentTokens: 50 + 13, environment: { CLAUDE_CONFIG_DIR: join(dir, 'home') },
    async send() {
      const sent = await runHook('claude', { ...payload, hook_event_name: 'Stop' }, nullLogger);
      await runHook('claude', { ...payload, hook_event_name: 'Notification', notification_type: 'selftest', message: 'synthetic notification' }, nullLogger);
      return sent.destinations?.find(destination => destination.kind === 'langfuse-otlp')?.traces
        .map(trace => `${trace.status}${trace.httpStatus ? ' HTTP ' + trace.httpStatus : ''}${trace.message ? ' ' + trace.message : ''}`);
    },
    extra(turn, check) {
      const first = turn.observations.find(observation => observation.type === 'GENERATION' && observation.usageDetails?.cache_creation_input_tokens);
      check('cache tokens kept as separate parts', first?.usageDetails?.input === 10 && first.usageDetails.cache_read_input_tokens === 100
        && first.usageDetails.cache_creation_input_tokens === 20, JSON.stringify(first?.usageDetails));
      const event = turn.observations.find(observation => observation.type === 'EVENT');
      check('notification stored as an event observation', Boolean(event && /^Notification/.test(event.name ?? '')), event?.name);
      check('adapter metadata kept on a model call', first?.metadata?.stopReason === 'tool_use' && first.metadata.requestId === 'req_selftest_1',
        JSON.stringify({ stopReason: first?.metadata?.stopReason, requestId: first?.metadata?.requestId }));
    } };
}

/** One Codex rollout: a turn with a model call, a tool call, and a final answer. */
function codexRollout(thread: string, session: string, turn: string, start: number, parent?: { turn: string; nickname: string }, spawns?: string) {
  let ordinal = 0;
  const row = (ms: number, type: string, payload: object) => ({ timestamp: new Date(start + ms).toISOString(), ordinal: ordinal++, type, payload });
  const call = 'call_' + thread;
  const usage = (response: string, input: number, cached: number, output: number, reasoning: number) => ({ thread_id: thread, turn_id: turn,
    session_id: session, response_id: response, usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
      output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output } });
  return [
    row(0, 'session_meta', { id: thread, session_id: session, timestamp: new Date(start).toISOString(), cwd: tmpdir(), originator: 'selftest',
      cli_version: 'selftest', model_provider: 'openai', ...(parent ? { source: { subagent: { thread_spawn: {} } }, thread_source: 'subagent',
        parent_thread_id: session, agent_nickname: parent.nickname } : { source: 'exec' }) }),
    row(10, 'event_msg', { type: 'task_started', turn_id: turn, turn_attribution: { turn_id: turn, turn_trigger: parent ? 'composer' : 'exec',
      parent_turn_id: parent?.turn ?? null, root_turn_id: parent?.turn ?? turn } }),
    row(20, 'turn_context', { turn_id: turn, cwd: tmpdir(), model: 'gpt-selftest' }),
    row(30, 'event_msg', { type: 'item_completed', thread_id: thread, turn_id: turn, item: { type: 'UserMessage', id: 'um_' + thread,
      content: [{ type: 'text', text: parent ? 'Synthetic thread prompt' : 'Self-test prompt (synthetic)' }] } }),
    row(900, 'response_item', { type: 'message', status: 'completed', id: 'msg1_' + thread, role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: 'working (synthetic)' }] }),
    row(1000, 'response_item', { type: 'custom_tool_call', id: 'ctc_' + thread, status: 'completed', call_id: call,
      name: spawns ? 'spawn_agent' : 'exec', input: 'synthetic input' }),
    ...(spawns ? [row(1010, 'event_msg', { type: 'item_completed', thread_id: thread, turn_id: turn,
      item: { type: 'SubAgentActivity', id: call, agent_thread_id: spawns, kind: 'spawn' } })] : []),
    row(1100, 'token_usage_record', usage('resp1_' + thread, 1000, 600, 30, 10)),
    row(parent ? 2500 : 6000, 'response_item', { type: 'custom_tool_call_output', id: 'ctco_' + thread, call_id: call,
      output: [{ type: 'input_text', text: 'synthetic output' }] }),
    row(parent ? 3400 : 6900, 'event_msg', { type: 'item_completed', thread_id: thread, turn_id: turn, item: { type: 'AgentMessage', id: 'msg2_' + thread,
      content: [{ type: 'Text', text: 'done (synthetic)' }], phase: 'final_answer' } }),
    row(parent ? 3410 : 6910, 'response_item', { type: 'message', status: 'completed', id: 'msg2_' + thread, role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'done (synthetic)' }] }),
    row(parent ? 3500 : 7000, 'token_usage_record', usage('resp2_' + thread, 1200, 800, 20, 0)),
    row(parent ? 3600 : 7100, 'event_msg', { type: 'task_complete', turn_id: turn, root_turn_id: parent?.turn ?? turn, last_agent_message: 'done (synthetic)',
      duration_ms: parent ? 3600 : 7100 }),
  ];
}

function codexScenario(dir: string, session: string): Scenario {
  const start = Date.now() - 120_000;
  const day = new Date(start).toISOString().slice(0, 10).split('-');
  const sessions = join(dir, 'home', 'sessions', ...day);
  mkdirSync(sessions, { recursive: true });
  const stamp = new Date(start).toISOString().slice(0, 19).replace(/:/g, '-');
  const thread = session + '-thread';
  const parent = join(sessions, `rollout-${stamp}-${session}.jsonl`);
  writeFileSync(parent, lines(codexRollout(session, session, 'turn-main', start, undefined, thread)));
  writeFileSync(join(sessions, `rollout-${stamp}-${thread}.jsonl`),
    lines(codexRollout(thread, session, 'turn-thread', start + 1500, { turn: 'turn-main', nickname: 'selftest-thread' })));
  return { tag: 'codex', turnKey: 'turn-main', runKey: `${thread}:turn-thread`, ownerTool: 'spawn_agent', subagent: 'selftest-thread',
    turnTypes: 'AGENT,AGENT,GENERATION,GENERATION,GENERATION,GENERATION,TOOL,TOOL', innerTypes: 'GENERATION,GENERATION,TOOL',
    mainTokens: 1030 + 1220, agentTokens: 1030 + 1220, environment: { CODEX_HOME: join(dir, 'home') },
    async send() {
      const sent = await runHook('codex', { hook_event_name: 'Stop', session_id: session, transcript_path: parent }, nullLogger);
      return sent.destinations?.find(destination => destination.kind === 'langfuse-otlp')?.traces
        .map(trace => `${trace.status}${trace.httpStatus ? ' HTTP ' + trace.httpStatus : ''}${trace.message ? ' ' + trace.message : ''}`);
    },
    extra(turn, check) {
      const reasoning = turn.observations.find(observation => observation.usageDetails?.output_reasoning_tokens);
      check('reasoning and cached tokens kept as separate parts', reasoning?.usageDetails?.input === 400 && reasoning.usageDetails.input_cached_tokens === 600
        && reasoning.usageDetails.output === 20 && reasoning.usageDetails.output_reasoning_tokens === 10 && reasoning.usageDetails.total === 1030,
        JSON.stringify(reasoning?.usageDetails));
    } };
}

function ompScenario(dir: string, session: string): Scenario {
  const start = Date.now() - 120_000;
  const home = join(dir, 'home');
  const folder = join(home, 'sessions', '-selftest', new Date(start).toISOString().replace(/[:.]/g, '-') + '_' + session);
  mkdirSync(folder, { recursive: true });
  const message = (id: string, parentId: string | null, body: object) => ({ type: 'message', id, parentId, message: body });
  writeFileSync(join(folder, 'SelfTestTask.jsonl'), lines([
    { type: 'session', id: session + '-task', parentSession: session },
    message('tu', null, { role: 'user', content: 'Synthetic task prompt', timestamp: start + 2000 }),
    message('tg', 'tu', { role: 'assistant', timestamp: start + 2100, completedAt: start + 4000, model: 'selftest-model', provider: 'selftest',
      content: [{ type: 'text', text: 'Synthetic task answer' }], usage: { input: 30, output: 4, totalTokens: 34 }, stopReason: 'stop' }),
  ]));
  const branch = [
    { type: 'session', id: session },
    message('u', null, { role: 'user', content: 'Self-test prompt (synthetic)', timestamp: start }),
    message('g', 'u', { role: 'assistant', timestamp: start + 100, completedAt: start + 1500, model: 'selftest-model', provider: 'selftest',
      usage: { input: 9, output: 1, totalTokens: 10 }, stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call-task', name: 'task', arguments: { tasks: [{ name: 'SelfTestTask', task: 'synthetic' }] } }] }),
    message('r', 'g', { role: 'toolResult', toolCallId: 'call-task', toolName: 'task', timestamp: start + 5000, content: 'synthetic task result' }),
    message('e', 'r', { role: 'assistant', timestamp: start + 5100, completedAt: start + 6500, model: 'selftest-model', provider: 'selftest',
      usage: { input: 12, output: 2, totalTokens: 14 }, stopReason: 'stop', content: [{ type: 'text', text: 'Self-test complete (synthetic)' }] }),
  ];
  return { tag: 'oh-my-pi', turnKey: 'u', runKey: 'SelfTestTask:tu', ownerTool: 'task', subagent: 'SelfTestTask',
    turnTypes: 'AGENT,AGENT,GENERATION,GENERATION,GENERATION,TOOL', innerTypes: 'GENERATION', mainTokens: 10 + 14, agentTokens: 34,
    deliveryHome: home,
    environment: { PI_CODING_AGENT_DIR: home },
    async send() {
      // The extension is what Oh My Pi loads; drive it the way the host does.
      const { default: extension } = await import('../omp-extension.ts');
      const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
      extension({ on: (name, handler) => { handlers[name] = handler as never; } });
      await handlers.agent_end?.({}, { sessionManager: { getSessionId: () => session, getBranch: () => branch } });
      return undefined;
    } };
}

function copilotScenario(dir: string, session: string): Scenario {
  const start = Date.now() - 120_000;
  let n = 0;
  const row = (ms: number, type: string, data: object, agentId?: string) => ({ id: 'e' + n++, timestamp: new Date(start + ms).toISOString(), type, data,
    ...(agentId ? { agentId } : {}) });
  const usage = (apiCallId: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0) => ({ usage: { apiCallId, inputTokens, outputTokens, cacheReadTokens } });
  const agent = 'selftest-agent-1';
  const transcript = join(dir, 'events.jsonl');
  writeFileSync(transcript, lines([
    row(0, 'user.message', { messageId: 'um', content: 'Self-test prompt (synthetic)', interactionId: 'i1' }),
    row(100, 'assistant.turn_start', { turnId: '0', interactionId: 'i1' }),
    row(900, 'session.usage_record', usage('c1', 100, 10, 40)),
    row(900, 'assistant.message', { messageId: 'm1', turnId: '0', apiCallId: 'c1', model: 'copilot-selftest', providerId: 'selftest',
      toolRequests: [{ toolCallId: 'call_task', name: 'task', arguments: { agent_type: 'selftest-agent' } }] }),
    row(950, 'tool.execution_start', { toolCallId: 'call_task', toolName: 'task', arguments: { agent_type: 'selftest-agent' } }),
    row(1000, 'subagent.started', { toolCallId: 'call_task', agentName: 'selftest-agent', agentDisplayName: 'Self test', model: 'copilot-selftest' }, agent),
    row(1010, 'user.message', { messageId: 'sum', content: 'Synthetic sub-agent prompt' }, agent),
    row(1020, 'assistant.turn_start', { turnId: '0', parentToolCallId: 'call_task' }, agent),
    row(1800, 'session.usage_record', usage('s1', 50, 5), agent),
    row(1800, 'assistant.message', { messageId: 'sm1', turnId: '0', apiCallId: 's1', model: 'copilot-selftest', providerId: 'selftest',
      toolRequests: [{ toolCallId: 'call_view', name: 'view', arguments: { path: 'synthetic.txt' } }] }, agent),
    row(1850, 'tool.execution_start', { toolCallId: 'call_view', toolName: 'view', arguments: { path: 'synthetic.txt' } }, agent),
    row(2200, 'tool.execution_complete', { toolCallId: 'call_view', success: true, result: { content: 'synthetic' } }, agent),
    row(2250, 'assistant.turn_start', { turnId: '1', parentToolCallId: 'call_task' }, agent),
    row(3000, 'session.usage_record', usage('s2', 60, 6), agent),
    row(3000, 'assistant.message', { messageId: 'sm2', turnId: '1', apiCallId: 's2', model: 'copilot-selftest', providerId: 'selftest', content: 'Synthetic sub-agent answer' }, agent),
    row(3050, 'subagent.completed', { toolCallId: 'call_task', agentName: 'selftest-agent', totalTokens: 121, totalToolCalls: 1 }, agent),
    row(3100, 'tool.execution_complete', { toolCallId: 'call_task', success: true, result: { content: 'Synthetic sub-agent answer' } }),
    row(3150, 'assistant.turn_start', { turnId: '1', interactionId: 'i1' }),
    row(4000, 'session.usage_record', usage('c2', 120, 12, 60)),
    row(4000, 'assistant.message', { messageId: 'm2', turnId: '1', apiCallId: 'c2', model: 'copilot-selftest', providerId: 'selftest', content: 'Self-test complete (synthetic)' }),
  ]));
  return { tag: 'copilot', turnKey: 'um', runKey: agent, ownerTool: 'task', subagent: 'selftest-agent',
    turnTypes: 'AGENT,AGENT,GENERATION,GENERATION,GENERATION,GENERATION,TOOL,TOOL', innerTypes: 'GENERATION,GENERATION,TOOL',
    mainTokens: 110 + 132, agentTokens: 55 + 66, environment: { COPILOT_HOME: join(dir, 'home') },
    async send() {
      // What the agentStop hook command does with the session's event log.
      const { readCopilotTurn } = await import('../adapters/copilot.ts');
      const { turnToEvents } = await import('./batch.ts');
      const { loadConfig } = await import('./config.ts');
      const { exportEvents } = await import('./export.ts');
      const { batchOptions } = await import('./run.ts');
      const config = loadConfig('copilot');
      const turn = await readCopilotTurn(transcript, session, new Date(start + 4100).toISOString());
      if (!turn) return ['no turn could be read'];
      const sent = await exportEvents(config, turnToEvents(turn, batchOptions(config)), nullLogger);
      return sent.destinations.find(destination => destination.kind === 'langfuse-otlp')?.traces
        .map(trace => `${trace.status}${trace.httpStatus ? ' HTTP ' + trace.httpStatus : ''}${trace.message ? ' ' + trace.message : ''}`);
    },
    extra(turn, check) {
      const cached = turn.observations.find(observation => observation.usageDetails?.input_cached_tokens === 40);
      check('cached input kept as a separate part', cached?.usageDetails?.input === 60 && cached.usageDetails.total === 110, JSON.stringify(cached?.usageDetails));
    } };
}

function opencodeScenario(dir: string, session: string): Scenario {
  const start = Date.now() - 120_000;
  const at = (ms: number) => new Date(start + ms).toISOString();
  // The event arrays the OpenCode plugin's hook builds for a finished turn:
  // one for the main session, one for the session its task tool started.
  const turnEvents = (id: string, subagent: boolean, offset: number) => {
    const root = id.slice(0, 16) + 'root';
    const generation = id.slice(0, 16) + 'gen1';
    const metadata = subagent ? { source: 'opencode', generationCount: 1, subagent: true, subagentSessionId: session + '-child', parentSessionId: session }
      : { source: 'opencode', generationCount: 1 };
    return [
      { id: id + '-t', timestamp: at(offset), type: 'trace-create', body: { id, name: `OpenCode ${subagent ? 'subagent ' : ''}turn selftest`, sessionId: session,
        userId: 'hook-selftest', timestamp: at(offset), environment: ENVIRONMENT, input: 'Self-test prompt (synthetic)', output: 'Self-test complete (synthetic)',
        tags: ['opencode', 'selftest-host', ...(subagent ? ['subagent'] : [])], metadata } },
      { id: id + '-a', timestamp: at(offset), type: 'agent-create', body: { id: root, traceId: id, name: subagent ? 'OpenCode subagent' : 'OpenCode',
        startTime: at(offset), endTime: at(offset + 1000), input: 'Self-test prompt (synthetic)', output: 'Self-test complete (synthetic)' } },
      { id: id + '-g', timestamp: at(offset), type: 'generation-create', body: { id: generation, traceId: id, parentObservationId: root, name: 'opencode-selftest',
        model: 'opencode-selftest', startTime: at(offset + 100), endTime: at(offset + 900), input: [{ role: 'user', content: 'Self-test prompt (synthetic)' }],
        output: { text: 'Self-test complete (synthetic)', toolCalls: [] },
        usageDetails: { input: 40, output: 6, total: 49, output_reasoning_tokens: 3, input_cached_tokens: 20, input_cache_creation: 0 },
        metadata: { provider: 'selftest', finish: 'stop' } } },
    ];
  };
  const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
  const main = digest('opencode-selftest-main-' + session);
  const child = digest('opencode-selftest-child-' + session);
  return { tag: 'opencode', turnKey: '', runKey: '', ownerTool: '', subagent: '', turnTypes: 'AGENT,GENERATION', innerTypes: '', mainTokens: 49, agentTokens: 49,
    environment: {}, separate: { turn: main, subagent: child },
    async send() {
      // What `export-events opencode` does with the array the plugin hands over.
      const { loadConfig } = await import('./config.ts');
      const { exportEvents } = await import('./export.ts');
      const sent = await exportEvents(loadConfig('opencode'), [...turnEvents(main, false, 0), ...turnEvents(child, true, 2000)], nullLogger, undefined,
        { stateDir: join(dir, 'delivery') });
      return sent.destinations.find(destination => destination.kind === 'langfuse-otlp')?.traces
        .map(trace => `${trace.status}${trace.httpStatus ? ' HTTP ' + trace.httpStatus : ''}${trace.message ? ' ' + trace.message : ''}`);
    } };
}

function antigravityScenario(dir: string, session: string): Scenario {
  const start = Date.now() - 20_000;
  const at = (ms: number) => new Date(start + ms).toISOString();
  const child = '0a0b0c0d-1111-4222-8333-' + String(Date.now()).padStart(12, '0').slice(-12);
  const logs = (conversation: string) => join(dir, 'home', 'brain', conversation, '.system_generated', 'logs');
  mkdirSync(logs(session), { recursive: true });
  mkdirSync(logs(child), { recursive: true });
  const transcript = join(logs(session), 'transcript.jsonl');
  writeFileSync(transcript, lines([
    { type: 'USER_INPUT', step_index: 0, created_at: at(0), content: 'Self-test prompt (synthetic)' },
    { type: 'PLANNER_RESPONSE', step_index: 1, created_at: at(1000), model: 'antigravity-selftest', input_tokens: 100, cache_read_tokens: 40, output_tokens: 10,
      content: '', tool_calls: [{ name: 'invoke_subagent', args: { TypeName: '"selftest"', Role: 'synthetic', Prompt: 'Synthetic sub-agent prompt' } }] },
    { type: 'GENERIC', step_index: 2, created_at: at(6000), content: 'Subagent finished. Conversation ID: ' + child },
    { type: 'PLANNER_RESPONSE', step_index: 3, created_at: at(7000), model: 'antigravity-selftest', input_tokens: 120, cache_read_tokens: 60, output_tokens: 12,
      content: 'Self-test complete (synthetic)' },
  ]));
  writeFileSync(join(logs(child), 'transcript.jsonl'), lines([
    { type: 'USER_INPUT', step_index: 0, created_at: at(1500), content: 'Synthetic sub-agent prompt' },
    { type: 'PLANNER_RESPONSE', step_index: 1, created_at: at(2000), model: 'antigravity-selftest', input_tokens: 100, cache_read_tokens: 40, output_tokens: 10,
      content: '', tool_calls: [{ name: 'read_file', args: { path: 'synthetic.txt' } }] },
    { type: 'GENERIC', step_index: 2, created_at: at(3000), content: 'synthetic' },
    { type: 'PLANNER_RESPONSE', step_index: 3, created_at: at(4000), model: 'antigravity-selftest', input_tokens: 150, cache_read_tokens: 80, output_tokens: 15,
      content: 'Synthetic sub-agent answer' },
  ]));
  return { tag: 'antigravity', turnKey: '0', runKey: child, ownerTool: 'invoke_subagent', subagent: 'selftest',
    turnTypes: 'AGENT,AGENT,GENERATION,GENERATION,GENERATION,GENERATION,TOOL,TOOL', innerTypes: 'GENERATION,GENERATION,TOOL',
    mainTokens: 150 + 192, agentTokens: 150 + 245, ignoreEvents: true, deliveryHome: join(dir, 'home'),
    environment: { LANGFUSE_HOOK_ANTIGRAVITY_HOME: join(dir, 'home'), LANGFUSE_ANTIGRAVITY_STATE_DIR: join(dir, 'home', 'state', 'langfuse') },
    async send() {
      // The five hook phases Antigravity runs around a turn that calls one tool.
      const { runAntigravityHook } = await import('./antigravity-hook.ts');
      const conversation = { conversationId: session };
      const tool = { ...conversation, stepIdx: 2, toolCall: { name: 'invoke_subagent', args: { TypeName: '"selftest"' } } };
      await runAntigravityHook('PreInvocation', { ...conversation, initialNumSteps: 1, invocationNum: 0 });
      await runAntigravityHook('PreToolUse', tool);
      await runAntigravityHook('PostToolUse', tool);
      await runAntigravityHook('PostInvocation', { ...conversation, initialNumSteps: 1, invocationNum: 0 });
      await runAntigravityHook('Stop', { ...conversation, transcriptPath: transcript, fullyIdle: true, terminationReason: 'completed' });
      return undefined;
    } };
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
  /** Whose transcript format and integration to exercise. */
  format?: SelfTestFormat;
  /** Leave the two synthetic traces in the project to look at. */
  keep: boolean;
  api?: 'v2' | 'legacy';
  /** How long to wait for the project to show what was sent. */
  waitMs?: number;
  /** After deleting: how many times, and how far apart, to look for a trace that surfaced late. */
  settleChecks?: number;
  settleMs?: number;
}

/**
 * Remove every trace a self-test left behind (environment `hook-selftest`),
 * for example after one that was interrupted. Uses the stored-trace list where
 * the server offers it, else the observations API.
 */
export async function cleanSelfTest(cfg: Config): Promise<{ found: number; deleted: number }> {
  if (!cfg.publicKey || !cfg.secretKey) throw new Error('missing Langfuse keys');
  const client = new LangfuseClient({ baseUrl: cfg.baseUrl, publicKey: cfg.publicKey, secretKey: cfg.secretKey,
    timeoutMs: Math.max(cfg.timeoutMs, 30000), logger: nullLogger });
  const { value: ids } = await withReadApi(undefined, async (api) => {
    if (api === 'v2') {
      const { observations } = await readObservations(client, { environment: ENVIRONMENT }, 5, 'core');
      return [...new Set((observations as Array<{ traceId?: string }>).map(observation => observation.traceId).filter((id): id is string => Boolean(id)))];
    }
    const list = await client.read<{ data?: Array<{ id: string }> }>(`/api/public/traces?environment=${ENVIRONMENT}&limit=100`);
    return (list.data ?? []).map(trace => trace.id);
  });
  let deleted = 0;
  for (const id of ids) if (await client.deleteTrace(id)) deleted++;
  return { found: ids.length, deleted };
}

export async function selfTest(cfg: Config, options: SelfTestOptions) {
  if (!cfg.publicKey || !cfg.secretKey) throw new Error('missing Langfuse keys');
  const format = options.format ?? 'claude';
  const session = `hook-selftest-${format}-${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), 'langfuse-hooks-selftest-'));
  const scenario = format === 'codex' ? codexScenario(dir, session) : format === 'omp' ? ompScenario(dir, session)
    : format === 'copilot' ? copilotScenario(dir, session) : format === 'opencode' ? opencodeScenario(dir, session)
    : format === 'antigravity' ? antigravityScenario(dir, session) : claudeScenario(dir, session);

  // The integration reads its settings from the environment. Point it at a
  // throwaway home so the real read positions and delivery records stay as they are.
  const settings: Record<string, string> = { ...scenario.environment, LANGFUSE_AGENT_HOOKS_CONFIG_DIR: join(dir, 'shared'),
    TRACE_TO_LANGFUSE: 'true', LANGFUSE_PUBLIC_KEY: cfg.publicKey, LANGFUSE_SECRET_KEY: cfg.secretKey, LANGFUSE_BASE_URL: cfg.baseUrl,
    CC_LANGFUSE_PUBLIC_KEY: '', CC_LANGFUSE_SECRET_KEY: '', CC_LANGFUSE_BASE_URL: '', CC_LANGFUSE_USER_ID: '',
    LANGFUSE_HOOK_TRANSPORT: 'otlp', CODING_AGENT_OTLP_ENABLED: 'false', CODING_AGENT_GITHUB_METADATA: 'false',
    LANGFUSE_TRACING_ENVIRONMENT: ENVIRONMENT, CODING_AGENT_USER_NAME: 'hook-selftest', LANGFUSE_HOOK_CAPTURE_CONTENT: 'true',
    CODING_AGENT_SUBAGENTS: 'true', CODING_AGENT_SUBAGENT_TRACES: 'true', LANGFUSE_HOOK_STALE_TURN_MINUTES: '0' };
  const previous = new Map(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: string) => { checks.push({ check: name, ok, detail: ok ? undefined : detail }); };
  const turnId = scenario.separate?.turn ?? traceIdFor(scenario.tag, session, scenario.turnKey);
  const runId = scenario.separate?.subagent ?? subagentTraceIdFor(scenario.tag, session, scenario.runKey);
  const client = new LangfuseClient({ baseUrl: cfg.baseUrl, publicKey: cfg.publicKey, secretKey: cfg.secretKey,
    timeoutMs: Math.max(cfg.timeoutMs, 30000), logger: nullLogger });
  let api: 'v2' | 'legacy' | undefined = options.api;
  let deleted: boolean | undefined;
  try {
    let statuses = await scenario.send();
    if (!statuses && scenario.deliveryHome) {
      // This integration reports nothing back, so read what it recorded about the delivery.
      statuses = listRecords(join(scenario.deliveryHome, 'state', 'delivery')).filter(record => record.destination.startsWith('langfuse-otlp'))
        .map(record => record.status === 'confirmed' ? 'delivered' : ` `.trim());
    }
    if (statuses) {
      check('accepted by the OTLP endpoint', statuses.length === 2 && statuses.every(status => status === 'delivered'), statuses.join('; ') || 'nothing was sent');
    }
    let turn: StoredTrace | undefined;
    let run: StoredTrace | undefined;
    const expected = scenario.turnTypes.split(',').length;
    const deadline = Date.now() + (options.waitMs ?? 90_000);
    let readError: string | undefined;
    do {
      try {
        const read = await withReadApi(api, async chosen => [await readBack(client, chosen, turnId), await readBack(client, chosen, runId)] as const);
        api = read.api;
        [turn, run] = read.value;
        readError = undefined;
        if (turn && run && turn.observations.length >= expected) break;
      } catch (error) {
        // A slow or dropped read is tried again; it is not the answer to whether the trace is stored.
        readError = (error as Error).message;
      }
      await wait(3000);
    } while (Date.now() < deadline);
    if (readError) check('project could be read back', false, readError);

    check('turn trace stored', Boolean(turn), 'not found by trace ID ' + turnId);
    check('sub-agent trace stored', Boolean(run), 'not found by trace ID ' + runId);
    if (scenario.separate) {
      // Side by side in one session, not nested: check each trace and what tells them apart.
      const total = (trace?: StoredTrace) => (trace?.observations ?? []).reduce((sum, observation) => sum + (observation.usageDetails?.total ?? 0), 0);
      const kinds = (trace?: StoredTrace) => (trace?.observations ?? []).map(observation => observation.type).sort().join(',');
      check('main turn: root agent and model call', kinds(turn) === scenario.turnTypes, kinds(turn));
      check('sub-agent turn: root agent and model call', kinds(run) === scenario.turnTypes, kinds(run));
      check('both turns in the session that started the sub-agent', turn?.sessionId === session && run?.sessionId === session,
        JSON.stringify({ main: turn?.sessionId, subagent: run?.sessionId }));
      check('sub-agent turn tagged, and pointing at its parent session', (run?.tags ?? []).includes('subagent') && !(turn?.tags ?? []).includes('subagent')
        && run?.metadata?.parentSessionId === session, JSON.stringify({ tags: run?.tags, parentSessionId: run?.metadata?.parentSessionId }));
      check(`tokens counted once in each turn (${scenario.mainTokens} and ${scenario.agentTokens})`, total(turn) === scenario.mainTokens && total(run) === scenario.agentTokens,
        `${total(turn)} and ${total(run)}`);
      const usage = run?.observations.find(observation => observation.type === 'GENERATION')?.usageDetails;
      check('reasoning and cached tokens kept as separate parts', usage?.output_reasoning_tokens === 3 && usage.input_cached_tokens === 20 && usage.input === 40,
        JSON.stringify(usage));
    } else if (turn) {
      const observations = turn.observations;
      const byId = new Map(observations.map(observation => [observation.id, observation]));
      const types = (list: StoredObservation[]) => list.map(observation => observation.type)
        .filter(kind => !(scenario.ignoreEvents && kind === 'EVENT')).sort().join(',');
      check('turn: root agent, sub-agent, and every model call, tool and event', types(observations) === scenario.turnTypes, types(observations));
      check('no observation stored twice', new Set(observations.map(observation => observation.id)).size === observations.length);
      const agent = observations.find(observation => observation.name === 'Subagent: ' + scenario.subagent);
      const call = observations.find(observation => observation.type === 'TOOL' && observation.name === scenario.ownerTool);
      check('sub-agent sits under the tool call that started it', Boolean(agent && call && agent.parentObservationId === call.id),
        'parent is ' + (byId.get(agent?.parentObservationId ?? '')?.name ?? 'missing'));
      const inner = observations.filter(observation => agent && observation.parentObservationId === agent.id);
      check('sub-agent model calls and tools sit under the sub-agent', types(inner) === scenario.innerTypes, types(inner));
      const tokens = observations.filter(observation => observation.type === 'GENERATION')
        .reduce((sum, observation) => sum + tokensOf(observation.usageDetails), 0);
      check(`turn tokens are main ${scenario.mainTokens} + sub-agent ${scenario.agentTokens}`, tokens === scenario.mainTokens + scenario.agentTokens, 'stored ' + tokens);
      const tool = inner.find(observation => observation.type === 'TOOL') ?? call;
      check('tool call ID and neighbouring model calls kept as metadata', typeof tool?.metadata?.toolCallId === 'string'
        && byId.get(String(tool.metadata.issuedByObservationId))?.type === 'GENERATION'
        && byId.get(String(tool.metadata.consumedByObservationId))?.type === 'GENERATION', JSON.stringify(tool?.metadata).slice(0, 200));
      check('session and agent tag', turn.sessionId === session && (turn.tags ?? []).includes(scenario.tag), JSON.stringify({ sessionId: turn.sessionId, tags: turn.tags }));
      check('link from the turn to the sub-agent trace', agent?.metadata?.subagentTraceId === runId, String(agent?.metadata?.subagentTraceId));
      scenario.extra?.(turn, check);
    }
    if (run && !scenario.separate) {
      const usage = run.observations.filter(observation => observation.usageDetails && Object.keys(observation.usageDetails).length);
      check('sub-agent trace carries no usage of its own', usage.length === 0, usage.length + ' observation(s) with usage');
      check('sub-agent trace: session, tag and link back', run.sessionId === session && (run.tags ?? []).includes('subagent')
        && run.metadata?.parentTraceId === turnId, JSON.stringify({ sessionId: run.sessionId, tags: run.tags, parentTraceId: run.metadata?.parentTraceId }));
    }
    if (!options.keep) {
      const results = await Promise.all([client.deleteTrace(turnId), client.deleteTrace(runId)]);
      deleted = results.every(Boolean);
      // A server can show a trace some seconds after accepting it. One deleted
      // too early would reappear and stay, so look again and delete once more.
      for (let pass = 0; pass < (options.settleChecks ?? 3); pass++) {
        await wait(options.settleMs ?? 4000);
        const present = await withReadApi(api, async chosen => [await readBack(client, chosen, turnId), await readBack(client, chosen, runId)])
          .then(read => read.value.some(Boolean), () => false);
        if (present) deleted = (await Promise.all([client.deleteTrace(turnId), client.deleteTrace(runId)])).every(Boolean);
      }
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { force: true, recursive: true, maxRetries: 3 });
  }
  return { ok: checks.every(item => item.ok), format, server: cfg.baseUrl, readApi: api, environment: ENVIRONMENT, session,
    traces: { turn: turnId, subagent: runId }, kept: options.keep, deleted, passed: checks.filter(item => item.ok).length,
    failed: checks.filter(item => !item.ok).length, checks };
}
