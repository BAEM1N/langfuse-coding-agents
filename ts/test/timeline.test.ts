import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ompExtension from '../src/omp-extension.ts';
import { analyzeTimeline } from '../src/core/timeline.ts';
import { turnToEvents } from '../src/core/batch.ts';
import { parseOmpSession } from '../src/adapters/omp.ts';
import { loadOtlpConfig, otlpPayload } from '../src/core/otlp.ts';
import { auditStoredTrace } from '../src/core/audit.ts';
import type { Turn } from '../src/core/types.ts';

const time = (seconds: number) => new Date(seconds * 1000).toISOString();

function parallelTurn(): Turn {
  return { key: 'turn', index: 1, sessionId: 's', offset: 0, complete: true,
    startTime: time(1), endTime: time(6), events: [], metadata: {},
    steps: [
      { kind: 'generation', key: 'g1', name: 'g', startTime: time(1), endTime: time(2),
        output: { content: [{ type: 'tool_call', id: 'a' }, { type: 'tool_call', id: 'b' }] } },
      { kind: 'tool', key: 'a', name: 'read', startTime: time(2), endTime: time(5) },
      { kind: 'tool', key: 'b', name: 'read', startTime: time(2), endTime: time(4) },
      { kind: 'generation', key: 'g2', name: 'g', startTime: time(5), endTime: time(6),
        input: [{ role: 'tool', call_id: 'b' }, { role: 'tool', call_id: 'a' }] },
    ], toolResults: [{ key: 'b', time: time(4) }, { key: 'a', time: time(5) }] };
}

test('correlates parallel tools by call ID and preserves edges without capturing content', () => {
  const turn = parallelTurn();
  const audit = analyzeTimeline(turn);
  assert.deepEqual(audit.issues, []);
  assert.equal(audit.links.get('a')?.issuedBy?.key, 'g1');
  assert.equal(audit.links.get('b')?.consumedBy?.key, 'g2');
  const events = turnToEvents(turn, { agentLabel: 'OMP', agentTag: 'oh-my-pi', userId: 'user',
    hostname: 'test', maxChars: 100, redact: true, captureContent: false });
  const gens = events.filter((event) => event.type === 'generation-create');
  for (const tool of events.filter((event) => event.type === 'tool-create')) {
    const meta = tool.body.metadata as Record<string, unknown>;
    assert.equal(meta.issuedByObservationId, gens[0].body.id);
    assert.equal(meta.consumedByObservationId, gens[1].body.id);
  }
  assert.ok(events.every((event) => !('input' in event.body) && !('output' in event.body)));
});

test('OTLP preserves causal links and excludes captured bodies by default', () => {
  const turn = parallelTurn();
  turn.input = 'diagnostic prompt';
  const generation = turn.steps[0];
  assert.equal(generation.kind, 'generation');
  generation.usage = { input: 10, input_cached_tokens: 4, output: 2 };
  const events = turnToEvents(turn, { agentLabel: 'OMP', agentTag: 'oh-my-pi', userId: 'user',
    hostname: 'test', maxChars: 100, redact: true });
  const config = loadOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/otlp',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'routing=test%20project' });
  assert.ok(config);
  assert.equal(config.endpoint, 'https://collector.example/otlp/v1/traces');
  assert.equal(config.headers.get('routing'), 'test project');
  const [root, first, tool, parallel, next] = otlpPayload(events, 'omp', config).resourceSpans[0].scopeSpans[0].spans;
  assert.equal(tool.traceId, root.traceId);
  assert.match(tool.spanId, /^[0-9a-f]{16}$/);
  assert.deepEqual(tool.links.map((link) => link.spanId), [first.spanId, next.spanId]);
  assert.equal(parallel.startTimeUnixNano, tool.startTimeUnixNano);
  assert.ok(first.attributes.some(attribute => attribute.key === 'gen_ai.usage.input_tokens'
    && 'intValue' in attribute.value && attribute.value.intValue === '14'));
  assert.ok(!root.attributes.some(attribute => attribute.key === 'coding_agent.input'));
  const withContent = otlpPayload(events, 'omp', { captureContent: true });
  assert.ok(JSON.stringify(withContent).includes('diagnostic prompt'));
});

test('reports early, duplicate and orphaned results while separating incomplete turns', () => {
  const turn = parallelTurn();
  turn.steps.splice(3, 1);
  delete turn.steps[2].endTime;
  turn.toolResults = [{ key: 'a', time: time(1) }, { key: 'a', time: time(5) }, { key: 'orphan', time: time(4) }];
  assert.deepEqual(analyzeTimeline(turn).issues.map((event) => event.name).sort(),
    ['duplicate_tool_result', 'tool_call_missing', 'tool_result_before_call', 'tool_result_missing']);
  turn.complete = false;
  assert.deepEqual(analyzeTimeline(turn).issues.map((event) => event.name).sort(),
    ['duplicate_tool_result', 'tool_result_before_call']);
});

test('audits native Goose spans and reports a missing final response without double-counting chat', () => {
  const chat = { 'gen_ai.operation.name': 'chat' };
  const trace = auditStoredTrace({ id: 'goose', timestamp: time(1), observations: [
    { id: 'root', type: 'SPAN', startTime: time(1), metadata: {
      'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'goose' } },
    { id: 'wrapper', name: 'chat', type: 'SPAN', startTime: time(2), metadata: chat },
    { id: 'g1', name: 'stream_response_from_provider', type: 'SPAN', startTime: time(2), endTime: time(3), metadata: {
      ...chat, 'gen_ai.input.messages': '[{"role":"user"}]',
      'gen_ai.output.messages': '[{"role":"assistant","parts":[{"type":"tool_call","id":"a"}]}]',
      'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 2 } },
    { id: 't1', type: 'SPAN', startTime: time(3), endTime: time(4), metadata: {
      'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.call.id': 'a',
      'gen_ai.tool.call.arguments': '{}', 'gen_ai.tool.call.result': 'fixture output' } },
    { id: 'g2', name: 'stream_response_from_provider', type: 'SPAN', startTime: time(4), metadata: {
      ...chat, 'gen_ai.input.messages': '[{"role":"tool","parts":[{"type":"tool_call_response","id":"a"}]}]' } },
  ] });
  assert.equal(trace.agent, 'goose');
  assert.equal(trace.toolLinks, 1);
  assert.deepEqual(trace.coverage, { modelCalls: 2, modelInputs: 2, modelOutputs: 1,
    modelTokenUsage: 1, toolInputs: 1, toolOutputs: 1 });
});

test('OMP uses the active branch and pairs provider tool results by ID', () => {
  const rows = [
    { type: 'session', id: 'session' },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', timestamp: 1000 } },
    { type: 'message', id: 'g', parentId: 'u', message: { role: 'assistant', timestamp: 1000,
      completedAt: 2000, content: [{ type: 'toolCall', id: 'a' }], stopReason: 'toolUse' } },
    { type: 'message', id: 'old', parentId: 'g', message: { role: 'toolResult', toolCallId: 'abandoned', timestamp: 3000 } },
    { type: 'message', id: 't', parentId: 'g', message: { role: 'toolResult', toolCallId: 'a', timestamp: 3000 } },
    { type: 'message', id: 'end', parentId: 't', message: { role: 'assistant', timestamp: 3000, stopReason: 'stop' } },
  ];
  const [turn] = parseOmpSession(rows.map((value, offset) => ({ value, offset })), 'fallback');
  assert.equal(turn.sessionId, 'session');
  assert.equal(turn.complete, true);
  assert.deepEqual(analyzeTimeline(turn).issues, []);
  assert.equal(analyzeTimeline(turn).links.get('a')?.consumedBy?.key, 'end');
});


test('OMP extension exports a completed turn without prompt or tool bodies', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'langfuse-omp-test-'));
  const env = { PI_CODING_AGENT_DIR: home, TRACE_TO_LANGFUSE: 'true', LANGFUSE_BASE_URL: 'https://example.test',
    CC_LANGFUSE_BASE_URL: 'https://example.test', CC_LANGFUSE_PUBLIC_KEY: 'test', CC_LANGFUSE_SECRET_KEY: 'test' };
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    try { rmdirSync(join(home, 'state')); } catch {}
    rmdirSync(home);
  });
  Object.assign(process.env, env);
  let batch: Array<{ type: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    batch = JSON.parse(String(init.body)).batch;
    return new Response('{"errors":[]}', { status: 207 });
  });
  let registered: Parameters<Parameters<typeof ompExtension>[0]['on']>[1] | undefined;
  ompExtension({ on: (name, fn) => { if (name === 'agent_end') registered = fn; } });
  assert.ok(registered);
  await registered({}, { sessionManager: { getSessionId: () => 'session', getBranch: () => [
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'private', timestamp: 1000 } },
    { type: 'message', id: 'g', parentId: 'u', message: { role: 'assistant', timestamp: 1500,
      completedAt: 2000, content: [{ type: 'text', text: 'private' }], usage: { input: 17, output: 2 }, stopReason: 'stop' } },
  ] } });
  assert.deepEqual(batch.map((event) => event.type), ['trace-create', 'agent-create', 'generation-create']);
  assert.deepEqual(batch[2].body.usageDetails, { input: 17, output: 2 });
  assert.ok(batch.every((event) => !('input' in event.body) && !('output' in event.body)));
});
