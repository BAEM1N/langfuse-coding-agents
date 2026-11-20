// Sub-agent capture, against a mock Langfuse on loopback with synthetic transcripts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runHook } from '../src/core/run.ts';

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
  writeFileSync(parent, rows.join('\n') + '\n');

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
  assert.equal(agent.parentSpanId, root.spanId);
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
