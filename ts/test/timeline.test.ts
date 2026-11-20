import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdtempSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ompExtension from '../src/omp-extension.ts';
import { analyzeTimeline } from '../src/core/timeline.ts';
import { turnToEvents } from '../src/core/batch.ts';
import { parseOmpSession } from '../src/adapters/omp.ts';
import { loadOtlpConfig, otlpPayload } from '../src/core/otlp.ts';
import { auditStoredTrace } from '../src/core/audit.ts';
import { readCopilotTurn } from '../src/adapters/copilot.ts';
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
  turn.steps[1].input = { path: 'probe.txt' };
  turn.steps[1].output = 'diagnostic result';
  const generation = turn.steps[0];
  assert.equal(generation.kind, 'generation');
  generation.usage = { input: 10, input_cached_tokens: 4, output: 2 };
  const events = turnToEvents(turn, { agentLabel: 'OMP', agentTag: 'oh-my-pi', userId: 'user',
    hostname: 'test', device: { 'host.arch': 'x64', 'host.cpu.logical_count': 8 }, environment: 'local',
    maxChars: 100, redact: true });
  const config = loadOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/otlp',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'routing=test%20project' });
  assert.ok(config);
  assert.equal(config.endpoint, 'https://collector.example/otlp/v1/traces');
  assert.equal(config.headers.get('routing'), 'test project');
  const resource = otlpPayload(events, 'omp', config).resourceSpans[0];
  const [root, first, tool, parallel, next] = resource.scopeSpans[0].spans;
  assert.ok(resource.resource.attributes.some(attribute => attribute.key === 'host.arch'));
  assert.ok(resource.resource.attributes.some(attribute => attribute.key === 'deployment.environment.name'));
  assert.ok(root.attributes.some(attribute => attribute.key === 'user.id'));
  assert.equal(tool.traceId, root.traceId);
  assert.match(tool.spanId, /^[0-9a-f]{16}$/);
  assert.deepEqual(tool.links.map((link) => link.spanId), [first.spanId, next.spanId]);
  assert.equal(parallel.startTimeUnixNano, tool.startTimeUnixNano);
  assert.ok(first.attributes.some(attribute => attribute.key === 'gen_ai.usage.input_tokens'
    && 'intValue' in attribute.value && attribute.value.intValue === '14'));
  const contentKeys = ['coding_agent.input', 'coding_agent.output', 'langfuse.observation.input', 'langfuse.observation.output'];
  assert.ok(resource.scopeSpans[0].spans.every(span => span.attributes.every(attribute => !contentKeys.includes(attribute.key))));
  const [capturedRoot, , capturedTool] = otlpPayload(events, 'omp', { captureContent: true }).resourceSpans[0].scopeSpans[0].spans;
  const rootInput = capturedRoot.attributes.find(attribute => attribute.key === 'langfuse.observation.input')?.value;
  assert.deepEqual(rootInput, { stringValue: '"diagnostic prompt"' });
  for (const span of [capturedRoot, capturedTool]) {
    for (const field of ['input', 'output']) {
      assert.deepEqual(span.attributes.find(attribute => attribute.key === `langfuse.observation.${field}`)?.value,
        span.attributes.find(attribute => attribute.key === `coding_agent.${field}`)?.value);
    }
  }
  assert.deepEqual(capturedTool.attributes.find(attribute => attribute.key === 'langfuse.observation.output')?.value,
    { stringValue: '"diagnostic result"' });
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

test('Copilot waits for late final responses and links model usage and tool results', async (t) => {
  const rows = [
    ['user.message', 1, { messageId: 'u', content: 'read file' }],
    ['assistant.turn_start', 2, { turnId: '1' }],
    ['session.usage_record', 3, { usage: { apiCallId: 'request-a', inputTokens: 15, outputTokens: 3 } }],
    ['assistant.message', 3, { messageId: 'a', turnId: '1', apiCallId: 'request-a', toolRequests: [{ toolCallId: 'r', name: 'view' }] }],
    ['tool.execution_start', 3, { toolCallId: 'r', toolName: 'view', arguments: { path: 'probe.txt' } }],
    ['tool.execution_complete', 4, { toolCallId: 'r', success: true, result: { content: 'contents' } }],
    ['assistant.turn_start', 5, { turnId: '2' }],
    ['session.usage_record', 6, { usage: { apiCallId: 'request-b', inputTokens: 20, cacheReadTokens: 12, outputTokens: 2 } }],
    ['assistant.message', 6, { messageId: 'b', turnId: '2', apiCallId: 'request-b', content: 'contents' }],
  ] as const;
  const directory = mkdtempSync(join(tmpdir(), 'langfuse-copilot-'));
  const transcript = join(directory, 'events.jsonl');
  const entries = rows.map(([type, at, data]) => ({ type, timestamp: time(at), data }));
  const jsonl = (values: typeof entries) => values.map(value => JSON.stringify(value) + '\n').join('');
  writeFileSync(transcript, jsonl(entries.slice(0, -2)));
  const timer = setTimeout(() => appendFileSync(transcript, jsonl(entries.slice(-2))), 30);
  t.after(() => {
    clearTimeout(timer);
    unlinkSync(transcript);
    rmdirSync(directory);
  });
  const turn = await readCopilotTurn(transcript, 'session', time(7));
  assert.ok(turn);
  assert.equal(turn.output, 'contents');
  const [first, tool, last] = turn.steps;
  assert.equal(first.kind, 'generation');
  assert.equal(first.usage?.input, 15);
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.output, 'contents');
  assert.equal(last.kind, 'generation');
  assert.equal(last.usage?.input, 8);
  assert.equal(last.usage?.input_cached_tokens, 12);
  assert.equal(analyzeTimeline(turn).links.get('r')?.consumedBy?.key, 'b');
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
    CC_LANGFUSE_BASE_URL: 'https://example.test', CC_LANGFUSE_PUBLIC_KEY: 'test', CC_LANGFUSE_SECRET_KEY: 'test',
    CODING_AGENT_OTLP_ENABLED: 'false', LANGFUSE_HOOK_CAPTURE_CONTENT: 'false',
    CODING_AGENT_GITHUB_METADATA: 'false' }; // keep the test off the network
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // The exporter records per-destination delivery state under <home>/state.
    rmSync(home, { force: true, recursive: true });
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
