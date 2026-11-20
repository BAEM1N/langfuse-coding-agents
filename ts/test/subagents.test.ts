// Sub-agent capture, against a mock Langfuse on loopback with synthetic transcripts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runHook } from '../src/core/run.ts';
import type { GenerationStep, ToolStep } from '../src/core/types.ts';

const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean);
const CLEAR = /^(CC_)?LANGFUSE|^OTEL_|^CODING_AGENT|^CLAUDE_CONFIG_DIR$|^CODEX_HOME$/;

async function setup(t: TestContext, extra: Record<string, string> = {}) {
  const requests: any[][] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).resourceSpans[0].scopeSpans[0].spans);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const home = mkdtempSync(join(tmpdir(), 'lah-subagents-'));
  const previous = new Map(Object.keys(process.env).filter(key => CLEAR.test(key)).map(key => [key, process.env[key]]));
  for (const key of previous.keys()) delete process.env[key];
  const env = { CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), LANGFUSE_AGENT_HOOKS_CONFIG_DIR: join(home, 'shared'),
    TRACE_TO_LANGFUSE: 'true', LANGFUSE_PUBLIC_KEY: 'pk-lf-test', LANGFUSE_SECRET_KEY: 'sk-lf-test', LANGFUSE_HOOK_TRANSPORT: 'otlp',
    LANGFUSE_BASE_URL: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, CODING_AGENT_GITHUB_METADATA: 'false', ...extra };
  Object.assign(process.env, env);
  t.after(() => {
    server.closeAllConnections(); server.close();
    for (const key of Object.keys(env)) delete process.env[key];
    for (const [key, value] of previous) if (value !== undefined) process.env[key] = value;
    rmSync(home, { force: true, recursive: true });
  });
  return { home, requests };
}
const attr = (span: any, key: string) => {
  const value = span.attributes.find((item: any) => item.key === key)?.value;
  if (!value) return undefined;
  if ('intValue' in value) return Number(value.intValue);
  if ('arrayValue' in value) return value.arrayValue.values.map((item: any) => item.stringValue);
  return value.stringValue ?? value.boolValue ?? value.doubleValue;
};
const type = (span: any) => attr(span, 'langfuse.observation.type');
const tokens = (spans: any[]) => spans.reduce((sum, span) => {
  const usage = attr(span, 'langfuse.observation.usage_details');
  return sum + (usage ? JSON.parse(usage).total : 0);
}, 0);
const usageAttributes = ['langfuse.observation.usage_details', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens'];

function claudeSession(home: string) {
  const transcript = join(home, 'session.jsonl');
  writeFileSync(transcript, fixture('claude-transcript.jsonl').slice(0, 8).join('\n') + '\n');
  const dir = join(home, 'session', 'subagents');
  mkdirSync(dir, { recursive: true });
  const row = (value: object) => JSON.stringify({ isSidechain: true, agentId: 'a1', sessionId: 'sess-1', ...value });
  writeFileSync(join(dir, 'agent-a1.jsonl'), [
    row({ type: 'user', uuid: 'su1', timestamp: '2026-11-08T10:00:02.200Z', message: { role: 'user', content: 'find the files' } }),
    row({ type: 'assistant', uuid: 'sa1', timestamp: '2026-11-08T10:00:02.900Z', message: { id: 'msg_S1', model: 'claude-haiku-5-5', role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Glob', input: { pattern: '*' } }], stop_reason: 'tool_use',
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 40 } } }),
    row({ type: 'user', uuid: 'su2', timestamp: '2026-11-08T10:00:03.200Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: 'a.txt' }] } }),
    row({ type: 'assistant', uuid: 'sa2', timestamp: '2026-11-08T10:00:03.700Z', message: { id: 'msg_S2', model: 'claude-haiku-5-5', role: 'assistant',
      content: [{ type: 'text', text: 'found a.txt' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 4 } } }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_1', finished: true,
    model: 'claude-haiku-5-5', spawnDepth: 1, description: 'FREE-TEXT-DESCRIPTION' }));
  return transcript;
}
const stop = (agent: 'claude' | 'codex', path: string, session = 'sess-1') =>
  runHook(agent, { hook_event_name: 'Stop', session_id: session, transcript_path: path });

test('Claude sub-agent: spans inside the turn under the tool that started it, plus a trace of its own without usage', async (t) => {
  const { home, requests } = await setup(t);
  const transcript = claudeSession(home);
  const result = await stop('claude', transcript);
  assert.equal(result.errors, 0);
  assert.equal(requests.length, 2, 'the turn and the sub-agent run');
  const turn = requests.find(spans => spans.some(span => attr(span, 'langfuse.trace.name') === 'Claude Code - Turn 1'))!;
  const own = requests.find(spans => spans !== turn)!;

  // Inside the turn.
  assert.deepEqual(turn.map(type).sort(), ['agent', 'agent', 'generation', 'generation', 'generation', 'generation', 'tool', 'tool']);
  const root = turn.find(span => !span.parentSpanId);
  const bash = turn.find(span => span.name === 'Bash');
  const agent = turn.find(span => span.name === 'Subagent: Explore');
  assert.equal(agent.parentSpanId, bash.spanId, 'under the tool call that started it');
  assert.equal(attr(agent, 'langfuse.observation.metadata.subagent'), true);
  assert.equal(attr(agent, 'gen_ai.agent.name'), 'Explore', 'a sub-agent run is its own agent');
  assert.equal(attr(agent, 'gen_ai.operation.name'), 'invoke_agent');
  assert.equal(attr(root, 'gen_ai.agent.name'), 'claude');
  assert.equal(attr(agent, 'langfuse.observation.metadata.agentType'), 'Explore');
  assert.match(attr(agent, 'langfuse.observation.input'), /find the files/);
  const inner = turn.filter(span => span.parentSpanId === agent.spanId);
  assert.deepEqual(inner.map(type).sort(), ['generation', 'generation', 'tool']);
  const glob = inner.find(span => type(span) === 'tool');
  const [first, last] = inner.filter(span => type(span) === 'generation').sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)));
  assert.equal(attr(glob, 'langfuse.observation.metadata.issuedByObservationId'), first.spanId);
  assert.equal(attr(glob, 'langfuse.observation.metadata.consumedByObservationId'), last.spanId);
  assert.equal(new Set(turn.map(span => span.spanId)).size, turn.length, 'no span ID is shared');
  assert.ok(turn.every(span => span.traceId === root.traceId && attr(span, 'langfuse.session.id') === 'sess-1'));
  // Main thread 2160 + 2117, sub-agent 50 + 13: every model call once.
  assert.equal(tokens(turn), 2160 + 2117 + 50 + 13);
  assert.equal(attr(root, 'langfuse.trace.metadata.subagentRuns'), 1);

  // On its own.
  assert.ok(own.every(span => span.traceId !== root.traceId && attr(span, 'langfuse.trace.name') === 'Claude Code - Subagent: Explore'));
  assert.ok(own.every(span => attr(span, 'langfuse.trace.tags').includes('subagent') && attr(span, 'langfuse.session.id') === 'sess-1'));
  assert.equal(attr(own[0], 'langfuse.trace.metadata.parentTraceId'), root.traceId);
  assert.equal(attr(agent, 'langfuse.observation.metadata.subagentTraceId'), own[0].traceId, 'each side points at the other');
  assert.deepEqual(own.map(type).sort(), ['agent', 'span', 'span', 'tool']);
  for (const span of own) for (const key of usageAttributes) assert.equal(attr(span, key), undefined, 'tokens are counted on the turn only');
  assert.equal(tokens(own), 0);
  const copy = own.find(span => type(span) === 'span');
  assert.equal(attr(copy, 'langfuse.observation.metadata.usageCountedOnTurnTrace'), true);
  assert.equal(JSON.parse(attr(own[0], 'langfuse.trace.metadata.usage')).total, 63, 'the total is still visible as metadata');
  assert.ok(!JSON.stringify(requests).includes('FREE-TEXT-DESCRIPTION'), 'the free-text description is not used as a name');

  await stop('claude', transcript);
  assert.equal(requests.length, 2, 'nothing is sent again');
});

test('sub-agent capture can be narrowed or turned off', async (t) => {
  const inside = await setup(t, { CODING_AGENT_SUBAGENT_TRACES: 'false' });
  await stop('claude', claudeSession(inside.home));
  assert.equal(inside.requests.length, 1);
  assert.equal(inside.requests[0].length, 8);
  assert.equal(attr(inside.requests[0].find(span => span.name === 'Subagent: Explore'), 'langfuse.observation.metadata.subagentTraceId'), undefined);

  const off = await setup(t, { CODING_AGENT_SUBAGENTS: 'false' });
  await stop('claude', claudeSession(off.home));
  assert.equal(off.requests.length, 1);
  assert.equal(off.requests[0].length, 4);
});

test('Codex spawned thread: its own turns are attached to the parent turn, and copied parent history is skipped', async (t) => {
  const { home, requests } = await setup(t);
  const session = '01a1bb7c-f9d0-7d62-8250-f2b04cedb471';
  const parentTurn = '01a1bb7d-0143-7b50-bf41-621cc8250659';
  const dir = join(home, 'codex', 'sessions', '2026', '11', '08');
  mkdirSync(dir, { recursive: true });
  const parent = join(dir, `rollout-2026-11-08T14-08-13-${session}.jsonl`);
  const rows = fixture('codex-rollout.jsonl');
  // The parent records which tool call spawned the thread.
  const callRow = rows.findIndex(line => line.includes('"custom_tool_call"'));
  const call = JSON.parse(rows[callRow]);
  const activity = { timestamp: call.timestamp, ordinal: call.ordinal, type: 'event_msg', payload: { type: 'item_completed', turn_id: parentTurn,
    item: { type: 'SubAgentActivity', id: call.payload.call_id, agent_thread_id: 'thread-child-1', kind: 'spawn' } } };
  writeFileSync(parent, [...rows.slice(0, callRow + 1), JSON.stringify(activity), ...rows.slice(callRow + 1)].join('\n') + '\n');

  // A forked thread: the parent's rows first (ordinals below the history start), then its own turn.
  const history = rows.slice(1).map(line => JSON.parse(line));
  const own = rows.slice(1).map((line) => {
    const row = JSON.parse(line.replaceAll(parentTurn, 'child-turn-0001'));
    row.ordinal += 100;
    if (row.type === 'event_msg' && row.payload.type === 'task_started') {
      row.payload.turn_attribution = { ...row.payload.turn_attribution, turn_id: 'child-turn-0001', parent_turn_id: parentTurn, root_turn_id: parentTurn };
    }
    return row;
  });
  const meta = { timestamp: '2026-11-08T14:08:20.000Z', ordinal: 0, type: 'session_meta', payload: { id: 'thread-child-1', session_id: session,
    parent_thread_id: session, forked_from_id: session, thread_source: 'subagent', source: { subagent: { thread_spawn: {} } },
    agent_nickname: 'scout', subagent_history_start_ordinal: 100, cwd: 'C:\\work\\demo' } };
  writeFileSync(join(dir, 'rollout-2026-11-08T14-08-20-thread-child-1.jsonl'), [meta, ...history, ...own].map(row => JSON.stringify(row)).join('\n') + '\n');

  const result = await stop('codex', parent, session);
  assert.equal(result.errors, 0);
  assert.equal(requests.length, 2);
  const turn = requests.find(spans => spans.some(span => attr(span, 'langfuse.trace.name') === 'Codex - Turn 1'))!;
  const separate = requests.find(spans => spans !== turn)!;
  const root = turn.find(span => !span.parentSpanId);
  const agent = turn.find(span => span.name === 'Subagent: scout');
  assert.ok(agent, 'the thread is attached to the turn named in its turn_attribution');
  const spawnTool = turn.find(span => type(span) === 'tool' && span.parentSpanId === root.spanId);
  assert.equal(agent.parentSpanId, spawnTool.spanId, 'under the tool call that spawned the thread');
  const mainCalls = turn.filter(span => type(span) === 'generation' && span.parentSpanId === root.spanId);
  const threadCalls = turn.filter(span => type(span) === 'generation' && span.parentSpanId === agent.spanId);
  assert.equal(mainCalls.length, 2);
  assert.equal(threadCalls.length, 2, 'only the thread\'s own model calls, not the copied history');
  assert.equal(tokens(threadCalls), tokens(mainCalls), 'same synthetic usage, counted once per thread');
  assert.equal(new Set(turn.map(span => span.spanId)).size, turn.length);
  assert.ok(separate.every(span => attr(span, 'langfuse.trace.name') === 'Codex - Subagent: scout'));
  assert.equal(tokens(separate), 0);
  assert.ok(existsSync(join(home, 'codex', 'state', 'langfuse_agent_hooks_threads.json')), 'thread lookup is cached');

  await stop('codex', parent, session);
  assert.equal(requests.length, 2);
});

test('Oh My Pi task session: attached under the task call that named it', async () => {
  const { attachOmpSubagents } = await import('../src/core/subagents.ts');
  const { parseOmpSession } = await import('../src/adapters/omp.ts');
  const { turnToEvents } = await import('../src/core/batch.ts');
  const home = mkdtempSync(join(tmpdir(), 'lah-omp-task-'));
  try {
    const dir = join(home, 'sessions', '-tmp', '2026-11-20T10-00-00-000Z_parent-session');
    mkdirSync(dir, { recursive: true });
    const message = (id: string, parentId: string | null, body: object) => ({ type: 'message', id, parentId, message: body });
    writeFileSync(join(dir, 'LiteUpgrade.jsonl'), [
      { type: 'session', id: 'task-session', parentSession: 'parent-session' },
      message('tu', null, { role: 'user', content: 'do the task', timestamp: 2000 }),
      message('tg', 'tu', { role: 'assistant', timestamp: 2100, completedAt: 2900, content: [{ type: 'text', text: 'done' }],
        usage: { input: 30, output: 4, totalTokens: 34 }, stopReason: 'stop' }),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(join(dir, 'changes.jsonl'), '{"type":"change"}\n');
    const parent = [
      { type: 'session', id: 'parent-session' },
      message('u', null, { role: 'user', content: 'x', timestamp: 1000 }),
      message('g', 'u', { role: 'assistant', timestamp: 1100, completedAt: 1900, usage: { input: 9, output: 1, totalTokens: 10 }, stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'call-task', name: 'task', arguments: { tasks: [{ name: 'LiteUpgrade', task: 't' }] } }] }),
      message('r', 'g', { role: 'toolResult', toolCallId: 'call-task', toolName: 'task', timestamp: 3000 }),
      message('e', 'r', { role: 'assistant', timestamp: 3100, completedAt: 3500, usage: { input: 12, output: 2, totalTokens: 14 }, stopReason: 'stop',
        content: [{ type: 'text', text: 'ok' }] }),
    ].map((value, offset) => ({ value, offset }));
    const turns = parseOmpSession(parent, 'fallback');
    attachOmpSubagents(home, turns[0].sessionId, turns);
    assert.equal(turns[0].children?.length, 1);
    assert.equal(turns[0].children![0].name, 'LiteUpgrade');
    assert.equal(turns[0].children![0].parentToolKey, 'call-task');
    const events = turnToEvents(turns[0], { agentLabel: 'Oh My Pi', agentTag: 'oh-my-pi', userId: 'u', hostname: 'h', maxChars: 2000, redact: true });
    const counted = events.filter(event => event.type === 'generation-create');
    assert.equal(counted.reduce((sum, event) => sum + (event.body.usageDetails as { total: number }).total, 0), 10 + 14 + 34, 'main and task tokens, once');
    const run = events.find(event => event.body.name === 'Subagent: LiteUpgrade' && event.body.traceId === events[0].body.id);
    const taskCall = events.find(event => event.type === 'tool-create' && event.body.name === 'task');
    assert.equal(run?.body.parentObservationId, taskCall?.body.id);
    assert.equal(events.filter(event => event.type === 'trace-create').length, 2, 'the turn and the task session on its own');
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test('Copilot CLI sub-agent: events carrying an agentId are a run under the task call, not part of the main turn', async () => {
  const { parseCopilotTurn } = await import('../src/adapters/copilot.ts');
  let n = 0;
  const row = (seconds: number, type: string, data: object, agentId?: string) => ({ offset: n, value: { id: 'e' + n++, type, data,
    timestamp: new Date(Date.UTC(2026, 10, 20, 12, 0, seconds)).toISOString(), ...(agentId ? { agentId } : {}) } });
  const usage = (apiCallId: string, inputTokens: number, outputTokens: number) => ({ usage: { apiCallId, inputTokens, outputTokens } });
  const entries = [
    row(0, 'user.message', { messageId: 'um', content: 'main prompt', interactionId: 'i1' }),
    row(1, 'assistant.turn_start', { turnId: '0', interactionId: 'i1' }),
    row(2, 'session.usage_record', usage('c1', 100, 10)),
    row(2, 'assistant.message', { messageId: 'm1', turnId: '0', apiCallId: 'c1', model: 'm', toolRequests: [{ toolCallId: 'call_task', name: 'task' }] }),
    row(3, 'tool.execution_start', { toolCallId: 'call_task', toolName: 'task' }),
    row(4, 'subagent.started', { toolCallId: 'call_task', agentName: 'general-purpose', model: 'm' }, 'agent-1'),
    // The sub-agent's own prompt is a user.message too: it must not be taken for the user's.
    row(4, 'user.message', { messageId: 'sum', content: 'SUB-AGENT PROMPT' }, 'agent-1'),
    row(5, 'assistant.turn_start', { turnId: '0', parentToolCallId: 'call_task' }, 'agent-1'),
    row(6, 'session.usage_record', usage('s1', 50, 5), 'agent-1'),
    row(6, 'assistant.message', { messageId: 'sm1', turnId: '0', apiCallId: 's1', model: 'm', toolRequests: [{ toolCallId: 'call_view', name: 'view' }] }, 'agent-1'),
    row(7, 'tool.execution_start', { toolCallId: 'call_view', toolName: 'view' }, 'agent-1'),
    row(8, 'tool.execution_complete', { toolCallId: 'call_view', success: true, result: { content: 'x' } }, 'agent-1'),
    row(9, 'assistant.turn_start', { turnId: '1', parentToolCallId: 'call_task' }, 'agent-1'),
    row(10, 'session.usage_record', usage('s2', 60, 6), 'agent-1'),
    row(10, 'assistant.message', { messageId: 'sm2', turnId: '1', apiCallId: 's2', model: 'm', content: 'sub answer' }, 'agent-1'),
    row(11, 'subagent.completed', { toolCallId: 'call_task', agentName: 'general-purpose', totalTokens: 121 }, 'agent-1'),
    row(12, 'tool.execution_complete', { toolCallId: 'call_task', success: true, result: { content: 'sub answer' } }),
    row(13, 'assistant.turn_start', { turnId: '1', interactionId: 'i1' }),
    row(14, 'session.usage_record', usage('c2', 120, 12)),
    row(14, 'assistant.message', { messageId: 'm2', turnId: '1', apiCallId: 'c2', model: 'm', content: 'main answer' }),
  ];
  const turn = parseCopilotTurn(entries, 'session', new Date(Date.UTC(2026, 10, 20, 12, 0, 15)).toISOString())!;
  assert.equal(turn.key, 'um');
  assert.equal(turn.input, 'main prompt', 'the user prompt, not the sub-agent prompt');
  assert.equal(turn.output, 'main answer');
  const total = (steps: typeof turn.steps) => steps.reduce((sum, step) => sum + (step.kind === 'generation' ? step.usage?.total ?? 0 : 0), 0);
  assert.deepEqual(turn.steps.map(step => step.kind + ':' + step.name), ['generation:m', 'tool:task', 'generation:m'], 'only the main agent\'s steps');
  assert.equal(total(turn.steps), 110 + 132);
  const [run] = turn.children ?? [];
  assert.equal(run.name, 'general-purpose');
  assert.equal(run.parentToolKey, 'call_task');
  assert.equal(run.complete, true);
  assert.equal(run.input, 'SUB-AGENT PROMPT');
  assert.deepEqual(run.steps.map(step => step.kind + ':' + step.name), ['generation:m', 'tool:view', 'generation:m']);
  assert.equal(total(run.steps), 121, 'matches the total Copilot reports for the sub-agent');
  assert.equal(run.metadata.reportedTotalTokens, 121);

  // A sub-agent that failed before any model call is still recorded, with the failure as an event.
  const failed = [...entries.slice(0, 6), row(5, 'subagent.failed', { toolCallId: 'call_task', agentName: 'general-purpose', error: 'model not supported' }, 'agent-1'),
    ...entries.slice(16)];
  const [failure] = parseCopilotTurn(failed, 'session', new Date(Date.UTC(2026, 10, 20, 12, 0, 15)).toISOString())!.children ?? [];
  assert.deepEqual(failure.events.map(event => [event.name, event.level]), [['Subagent failed', 'ERROR']]);
  assert.equal(failure.steps.length, 0);
});

test('Antigravity invoke_subagent: the conversation named by the tool result becomes a run under that tool call', async () => {
  const { antigravitySubagentTranscript, readAntigravitySubagent } = await import('../src/adapters/antigravity.ts');
  const brain = mkdtempSync(join(tmpdir(), 'lah-agy-'));
  try {
    const parentId = '11111111-1111-4111-8111-111111111111';
    const childId = '22222222-2222-4222-8222-222222222222';
    const logs = (id: string) => join(brain, id, '.system_generated', 'logs');
    mkdirSync(logs(parentId), { recursive: true });
    mkdirSync(logs(childId), { recursive: true });
    const parent = join(logs(parentId), 'transcript.jsonl');
    writeFileSync(parent, '');
    const at = (seconds: number) => new Date(Date.UTC(2026, 10, 20, 12, 0, seconds)).toISOString();
    writeFileSync(join(logs(childId), 'transcript.jsonl'), [
      { type: 'SYSTEM_MESSAGE', step_index: 0, created_at: at(0), content: 'system' },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: at(1), model: 'm', input_tokens: 100, cache_read_tokens: 40, output_tokens: 10,
        tool_calls: [{ name: 'read_file', args: { path: 'a' } }] },
      { type: 'GENERIC', step_index: 2, created_at: at(2), content: 'file contents' },
      { type: 'PLANNER_RESPONSE', step_index: 3, created_at: at(3), model: 'm', input_tokens: 120, cache_read_tokens: 60, output_tokens: 12,
        tool_calls: [{ name: 'read_file', args: { path: 'b' } }, { name: 'read_file', args: { path: 'c' } }] },
      { type: 'GENERIC', step_index: 4, created_at: at(4), content: 'first' },
      { type: 'GENERIC', step_index: 5, created_at: at(5), content: 'second' },
      { type: 'PLANNER_RESPONSE', step_index: 6, created_at: at(6), model: 'm', input_tokens: 150, cache_read_tokens: 80, output_tokens: 15, content: 'sub answer' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const found = antigravitySubagentTranscript(parent, `Subagent started. Conversation ID: ${childId}`);
    assert.equal(found?.id, childId);
    assert.equal(antigravitySubagentTranscript(parent, 'no conversation here'), undefined);
    assert.equal(antigravitySubagentTranscript(parent, `missing ${'33333333-3333-4333-8333-333333333333'}`), undefined, 'a conversation with no transcript is not attached');

    const run = readAntigravitySubagent(found!.path, found!.id, '"research"', '7')!;
    assert.equal(run.name, 'research', 'the JSON-encoded type name is unwrapped');
    assert.equal(readAntigravitySubagent(found!.path, found!.id, 'a long free-form role description that is not a label', '7')!.name, 'subagent');
    assert.equal(run.parentToolKey, '7');
    const calls = run.steps.filter((step): step is GenerationStep => step.kind === 'generation');
    assert.equal(calls.length, 3);
    assert.equal(calls.reduce((sum, call) => sum + call.usage!.input + call.usage!.input_cached_tokens + call.usage!.output, 0), 370 + 180 + 37);
    const tools = run.steps.filter((step): step is ToolStep => step.kind === 'tool');
    assert.equal(tools.length, 3);
    assert.equal(tools[0].output, 'file contents', 'a single requested tool is paired with the next step');
    assert.deepEqual(tools.slice(1).map(tool => tool.output), [undefined, undefined], 'two tools in one call are not paired by position');
    assert.ok(tools.every(tool => tool.endTime && tool.endTime >= tool.startTime));
    assert.equal(run.output, 'sub answer');
  } finally {
    rmSync(brain, { force: true, recursive: true });
  }
});
