// Delivery tests run against mock receivers on loopback and synthetic transcripts.
// Nothing here reads real agent settings or sends to a real backend.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.ts';
import { listRecords, reconcile } from '../src/core/delivery.ts';
import { otlpSpanId } from '../src/core/otlp.ts';
import { resolveDestinations } from '../src/core/destinations.ts';
import { deliveryDir } from '../src/core/export.ts';
import { logPath, runHook } from '../src/core/run.ts';

const PUBLIC_KEY = 'pk-lf-test-0000';
const SECRET_KEY = 'sk-lf-test-secret-1111';
const BASIC = 'Basic ' + Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64');
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean);

// Every setting the exporter reads. Cleared before each test so the developer's
// own shell cannot point a test at a real project.
const SETTINGS = ['TRACE_TO_LANGFUSE', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL', 'LANGFUSE_HOST',
  'CC_LANGFUSE_PUBLIC_KEY', 'CC_LANGFUSE_SECRET_KEY', 'CC_LANGFUSE_BASE_URL', 'CC_LANGFUSE_USER_ID', 'CC_LANGFUSE_DEBUG',
  'CC_LANGFUSE_HOSTNAME', 'CC_LANGFUSE_MAX_CHARS', 'CODING_AGENT_USER_NAME', 'LANGFUSE_USER_ID', 'LANGFUSE_HOOK_TRANSPORT',
  'LANGFUSE_HOOK_CAPTURE_CONTENT', 'LANGFUSE_HOOK_ALLOW_DUAL_ROUTE', 'LANGFUSE_HOOK_TIMEOUT_MS', 'LANGFUSE_HOOK_DEBUG',
  'LANGFUSE_HOOK_REDACT', 'LANGFUSE_HOOK_MAX_CHARS', 'LANGFUSE_HOOK_HOSTNAME', 'LANGFUSE_TRACING_ENVIRONMENT',
  'CODING_AGENT_OTLP_ENABLED', 'CODING_AGENT_OTLP_TRACES_ENDPOINT', 'CODING_AGENT_OTLP_FORWARDS_TO_LANGFUSE',
  'CODING_AGENT_COLLECTOR_LAUNCHER', 'CODING_AGENT_NODE_EXECUTABLE', 'CODING_AGENT_GITHUB_METADATA',
  'CODING_AGENT_DEVICE_METADATA', 'CODING_AGENT_DEVICE_LABEL', 'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL', 'OTEL_EXPORTER_OTLP_TIMEOUT',
  'OTEL_EXPORTER_OTLP_TRACES_TIMEOUT', 'OTEL_CAPTURE_CONTENT', 'OTEL_SERVICE_NAME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  'LANGFUSE_AGENT_HOOKS_CONFIG_DIR', 'LANGFUSE_HOOK_STALE_TURN_MINUTES'];

interface Seen { path: string; headers: IncomingHttpHeaders; body: any }
type Reply = { status?: number; body?: string; delayMs?: number } | void;

async function receiver(t: TestContext, respond: (request: Seen, count: number) => Reply = () => {}) {
  const requests: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const seen = { path: req.url ?? '', headers: req.headers, body: text ? JSON.parse(text) : undefined };
      requests.push(seen);
      const reply = respond(seen, requests.length) ?? {};
      setTimeout(() => {
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(reply.body ?? '{}');
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, requests };
}

function sandbox(t: TestContext, settings: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'lah-delivery-'));
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'),
    LANGFUSE_AGENT_HOOKS_CONFIG_DIR: join(home, 'shared'), CODING_AGENT_GITHUB_METADATA: 'false',
    CODING_AGENT_USER_NAME: 'synthetic-user', ...settings };
  const previous = new Map(SETTINGS.map(key => [key, process.env[key]]));
  for (const key of SETTINGS) delete process.env[key];
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { force: true, recursive: true });
  });
  return { home, env, transcript: join(home, 'transcript.jsonl') };
}

const langfuse = (url: string, extra: Record<string, string> = {}) => ({ TRACE_TO_LANGFUSE: 'true',
  LANGFUSE_PUBLIC_KEY: PUBLIC_KEY, LANGFUSE_SECRET_KEY: SECRET_KEY, LANGFUSE_BASE_URL: url, LANGFUSE_HOOK_TRANSPORT: 'otlp', ...extra });
const spansOf = (request: Seen): any[] => request.body.resourceSpans[0].scopeSpans[0].spans;
const attr = (span: any, key: string) => {
  const value = span.attributes.find((item: any) => item.key === key)?.value;
  if (!value) return undefined;
  if ('intValue' in value) return Number(value.intValue);
  if ('arrayValue' in value) return value.arrayValue.values.map((item: any) => item.stringValue);
  return value.stringValue ?? value.boolValue;
};
const stop = (agent: 'claude' | 'codex', transcript: string, session = 'synthetic-session') =>
  runHook(agent, { hook_event_name: 'Stop', session_id: session, transcript_path: transcript });
const statuses = (result: Awaited<ReturnType<typeof runHook>>, kind: string) =>
  result.destinations?.find(destination => destination.kind === kind)?.traces.map(trace => trace.status);

/** Root, first model call, tool call, follow-up model call: parents and time order. */
function assertTurnShape(spans: any[], callId: string) {
  const root = spans.find(span => !span.parentSpanId);
  const models = spans.filter(span => attr(span, 'langfuse.observation.type') === 'generation')
    .sort((a, b) => Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano)));
  const tool = spans.find(span => attr(span, 'langfuse.observation.type') === 'tool');
  assert.ok(root && tool && models.length >= 2, 'expected root, tool and two model spans');
  assert.equal(attr(root, 'langfuse.observation.type'), 'agent');
  for (const span of spans) {
    if (span !== root) assert.equal(span.parentSpanId, root.spanId);
    assert.equal(span.traceId, root.traceId);
    assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
  }
  const [first, next] = models;
  assert.ok(BigInt(first.startTimeUnixNano) <= BigInt(tool.startTimeUnixNano), 'model call starts before its tool');
  assert.ok(BigInt(tool.endTimeUnixNano) <= BigInt(next.startTimeUnixNano), 'tool ends before the follow-up model call');
  assert.equal(attr(tool, 'gen_ai.tool.call.id'), callId);
  assert.equal(attr(tool, 'langfuse.observation.metadata.toolCallId'), callId);
  assert.equal(attr(tool, 'langfuse.observation.metadata.issuedByObservationId'), first.spanId);
  assert.equal(attr(tool, 'langfuse.observation.metadata.consumedByObservationId'), next.spanId);
  assert.deepEqual(tool.links.map((link: any) => link.spanId), [first.spanId, next.spanId], 'Tempo keeps span links');
  return { root, first, next, tool };
}

test('Claude turn: Langfuse OTLP and a second receiver get the same trace, with headers kept apart', async (t) => {
  const lf = await receiver(t);
  const tempo = await receiver(t);
  const box = sandbox(t, langfuse(lf.url, { CODING_AGENT_OTLP_TRACES_ENDPOINT: tempo.url + '/v1/traces',
    LANGFUSE_TRACING_ENVIRONMENT: 'test' }));
  writeFileSync(box.transcript, fixture('claude-transcript.jsonl').slice(0, 8).join('\n') + '\n');
  const result = await stop('claude', box.transcript);
  assert.equal(result.errors, 0);

  assert.equal(lf.requests.length, 1);
  assert.equal(lf.requests[0].path, '/api/public/otel/v1/traces');
  assert.equal(lf.requests[0].headers.authorization, BASIC);
  assert.equal(lf.requests[0].headers['x-langfuse-ingestion-version'], '4');
  assert.equal(tempo.requests.length, 1);
  assert.equal(tempo.requests[0].path, '/v1/traces');
  assert.equal(tempo.requests[0].headers.authorization, undefined, 'project keys must not reach another receiver');
  assert.equal(tempo.requests[0].headers['x-langfuse-ingestion-version'], undefined);

  const spans = spansOf(lf.requests[0]);
  const { root, first, next } = assertTurnShape(spans, 'toolu_1');
  assert.equal(spansOf(tempo.requests[0])[0].traceId, root.traceId, 'same trace ID on both sides');
  assert.deepEqual(spansOf(tempo.requests[0]).map(span => span.spanId), spans.map(span => span.spanId));
  for (const span of spans) {
    assert.equal(attr(span, 'langfuse.session.id'), 'sess-1', 'session ID from the transcript, on every span');
    assert.equal(attr(span, 'gen_ai.conversation.id'), 'sess-1');
    assert.equal(attr(span, 'langfuse.user.id'), 'synthetic-user');
    assert.equal(attr(span, 'langfuse.environment'), 'test');
    assert.equal(attr(span, 'langfuse.trace.name'), 'Claude Code - Turn 1');
    assert.ok(attr(span, 'langfuse.trace.tags').includes('claude-code'));
    assert.equal(attr(span, 'langfuse.trace.metadata.complete'), true);
  }
  // Source usage: input 10, cache write 100, cache read 2000, output 50.
  assert.deepEqual(JSON.parse(attr(first, 'langfuse.observation.usage_details')),
    { input: 10, output: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100, total: 2160 });
  assert.equal(attr(first, 'gen_ai.usage.input_tokens'), 2110);
  assert.equal(attr(first, 'gen_ai.usage.cache_read.input_tokens'), 2000);
  assert.equal(attr(first, 'gen_ai.usage.cache_write.input_tokens'), 100);
  assert.equal(attr(first, 'gen_ai.provider.name'), 'anthropic');
  assert.equal(attr(first, 'gen_ai.usage.cache_creation.input_tokens'), undefined, 'the renamed attribute is not sent under its old name');
  assert.equal(attr(first, 'gen_ai.usage.output_tokens'), 50);
  assert.deepEqual(JSON.parse(attr(next, 'langfuse.observation.usage_details')),
    { input: 5, output: 12, cache_read_input_tokens: 2100, total: 2117 });

  // Bodies: Langfuse keeps what legacy ingestion sent, redacted. The other
  // receiver gets none unless OTEL_CAPTURE_CONTENT=true.
  assert.match(attr(root, 'langfuse.observation.input'), /List files/);
  assert.ok(!JSON.stringify(lf.requests[0].body).includes('11111111-2222'), 'secret in the prompt is redacted');
  assert.ok(spansOf(tempo.requests[0]).every(span => attr(span, 'coding_agent.input') === undefined
    && attr(span, 'langfuse.observation.input') === undefined));
});

test('Codex turn: reasoning tokens are reported once and parents hold', async (t) => {
  const lf = await receiver(t);
  const box = sandbox(t, langfuse(lf.url));
  let first = true;
  const rows = fixture('codex-rollout.jsonl').map((line) => {
    const row = JSON.parse(line);
    if (row.type === 'token_usage_record' && first) {
      first = false;
      row.payload.usage = { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0,
        output_tokens: 300, reasoning_output_tokens: 200, total_tokens: 1300 };
    }
    return JSON.stringify(row);
  });
  writeFileSync(box.transcript, rows.join('\n') + '\n');
  const result = await stop('codex', box.transcript, '01a1bb7c-f9d0-7d62-8250-f2b04cedb471');
  assert.equal(result.errors, 0);
  assert.equal(lf.requests.length, 1);
  const spans = spansOf(lf.requests[0]);
  const tool = spans.find(span => attr(span, 'langfuse.observation.type') === 'tool');
  const { first: model } = assertTurnShape(spans, attr(tool, 'gen_ai.tool.call.id'));
  const usage = JSON.parse(attr(model, 'langfuse.observation.usage_details'));
  assert.deepEqual(usage, { input: 400, output: 100, input_cached_tokens: 600, output_reasoning_tokens: 200, total: 1300 });
  assert.equal(usage.input + usage.output + usage.input_cached_tokens + usage.output_reasoning_tokens, usage.total,
    'exclusive parts add up to the source total: reasoning is neither dropped nor doubled');
  assert.equal(attr(model, 'gen_ai.usage.input_tokens'), 1000, 'inclusive of cached input, as in the source');
  assert.equal(attr(model, 'gen_ai.usage.output_tokens'), 300, 'inclusive of reasoning, as in the source');
  assert.equal(attr(model, 'gen_ai.usage.reasoning.output_tokens'), 200);
  assert.equal(attr(model, 'gen_ai.provider.name'), 'openai');
  assert.equal(attr(model, 'gen_ai.usage.cache_read.input_tokens'), 600);
  for (const span of spans) assert.equal(attr(span, 'langfuse.session.id'), '01a1bb7c-f9d0-7d62-8250-f2b04cedb471');
});

test('a repeated Stop sends nothing, and the next turn sends only itself', async (t) => {
  const lf = await receiver(t);
  const box = sandbox(t, langfuse(lf.url));
  const rows = fixture('claude-transcript.jsonl');
  writeFileSync(box.transcript, rows.slice(0, 8).join('\n') + '\n');
  await stop('claude', box.transcript);
  const again = await stop('claude', box.transcript);
  assert.equal(again.errors, 0);
  assert.deepEqual(statuses(again, 'langfuse-otlp'), ['skipped']);
  assert.equal(lf.requests.length, 1, 'same Stop twice: one request');

  appendFileSync(box.transcript, rows.slice(8).join('\n') + '\n');
  await stop('claude', box.transcript);
  assert.equal(lf.requests.length, 2);
  const firstTrace = spansOf(lf.requests[0])[0].traceId;
  assert.ok(spansOf(lf.requests[1]).every(span => span.traceId !== firstTrace), 'turn 1 is not sent again');
  await stop('claude', box.transcript);
  assert.equal(lf.requests.length, 2, 'state survives a new hook run');
});

test('a response written after Stop is sent as a new span, without repeating delivered spans', async (t) => {
  const lf = await receiver(t);
  const box = sandbox(t, langfuse(lf.url));
  const rows = fixture('claude-transcript.jsonl');
  // The transcript stops at the tool result: the final model call is not on disk yet.
  writeFileSync(box.transcript, rows.slice(0, 5).join('\n') + '\n');
  await stop('claude', box.transcript);
  assert.equal(lf.requests.length, 1);
  const early = spansOf(lf.requests[0]);
  assert.equal(early.filter(span => span.kind === 3).length, 1);

  appendFileSync(box.transcript, rows.slice(5, 8).join('\n') + '\n');
  await stop('claude', box.transcript);
  assert.equal(lf.requests.length, 2);
  const late = spansOf(lf.requests[1]);
  assert.equal(late.length, 1, 'only the missing model call');
  assert.equal(late[0].kind, 3);
  assert.equal(late[0].traceId, early[0].traceId);
  assert.equal(late[0].parentSpanId, early.find(span => !span.parentSpanId).spanId);
  assert.ok(early.every(span => span.spanId !== late[0].spanId));
  const [record] = listRecords(deliveryDir(loadConfig('claude')));
  assert.equal(record.status, 'confirmed');
  assert.equal(Object.keys(record.spans).length, early.length + 1);
});

test('concurrent hook calls in one process send the turn once', async (t) => {
  const lf = await receiver(t, () => ({ delayMs: 80 }));
  const box = sandbox(t, langfuse(lf.url));
  writeFileSync(box.transcript, fixture('claude-transcript.jsonl').slice(0, 8).join('\n') + '\n');
  const results = await Promise.all([stop('claude', box.transcript), stop('claude', box.transcript), stop('claude', box.transcript)]);
  assert.equal(lf.requests.length, 1);
  assert.ok(results.every(result => result.errors === 0));
});

function hookProcess(env: Record<string, string>, payload: object): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SETTINGS.includes(key)));
    const child = spawn(process.execPath, [CLI, 'hook', 'claude'], { env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function cliProcess(env: Record<string, string>, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SETTINGS.includes(key)));
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

test('backfill: dry run is offline, a real run needs a range, sends finished turns once, and skips stored ones', async (t) => {
  let stored: unknown[] = [];
  const lf = await receiver(t, request => request.path.startsWith('/api/public/v2/observations')
    ? { body: JSON.stringify({ data: stored, meta: {} }) } : {});
  const box = sandbox(t, langfuse(lf.url));
  writeFileSync(box.transcript, fixture('claude-transcript.jsonl').join('\n') + '\n');
  const range = ['--from', '2026-11-08T10:00:00Z', '--to', '2026-11-08T10:00:30Z'];

  const dry = await cliProcess(box.env, ['backfill', 'claude', box.transcript, ...range, '--dry-run']);
  assert.equal(dry.code, 0);
  assert.equal(lf.requests.length, 0, 'dry run makes no request');
  assert.match(dry.output, /range: 2026-11-08T10:00:00\.000Z \.\. 2026-11-08T10:00:30\.000Z/);
  assert.match(dry.output, /turns: 2 read, 1 selected, excluded: unfinished=1 outside-range=0/);
  assert.match(dry.output, /Langfuse \(OTLP\).*to-send=1 already-confirmed=0/);
  assert.ok(!dry.output.includes('List files') && !dry.output.includes(SECRET_KEY), 'no prompt text or key in the summary');

  const unbounded = await cliProcess(box.env, ['backfill', 'claude', box.transcript]);
  assert.equal(unbounded.code, 1);
  assert.match(unbounded.output, /explicit range/);
  assert.equal(lf.requests.length, 0);

  const outside = await cliProcess(box.env, ['backfill', 'claude', box.transcript, '--from', '2026-11-09T00:00:00Z', '--to', '2026-11-10T00:00:00Z']);
  assert.equal(outside.code, 0);
  assert.match(outside.output, /0 selected, excluded: unfinished=1 outside-range=1/);
  assert.equal(lf.requests.length, 0);

  const sent = await cliProcess(box.env, ['backfill', 'claude', box.transcript, ...range]);
  assert.equal(sent.code, 0, sent.output);
  assert.match(sent.output, /Langfuse \(OTLP\): delivered=1/);
  const posts = () => lf.requests.filter(request => request.path === '/api/public/otel/v1/traces');
  assert.equal(posts().length, 1);
  assert.match(lf.requests[0].path, /^\/api\/public\/v2\/observations\?traceId=/, 'the project is read before anything is written');
  assert.ok(spansOf(posts()[0]).every(span => attr(span, 'langfuse.trace.metadata.complete') === true));

  const again = await cliProcess(box.env, ['backfill', 'claude', box.transcript, ...range]);
  assert.match(again.output, /to-send=0 already-confirmed=1/);
  assert.equal(posts().length, 1, 'a confirmed turn is not backfilled twice');

  // A machine without local state, and a project that already holds the turn
  // under legacy observation IDs: nothing is added to it.
  rmSync(join(box.env.CLAUDE_CONFIG_DIR, 'state'), { force: true, recursive: true });
  stored = [{ id: 'legacy-observation', traceId: spansOf(posts()[0])[0].traceId, type: 'GENERATION' }];
  const present = await cliProcess(box.env, ['backfill', 'claude', box.transcript, ...range]);
  assert.match(present.output, /stored in Langfuse under other observation IDs, not sent to it: 1/);
  assert.equal(posts().length, 1);
});

test('separate hook processes send the turn once, and a restarted process sends nothing', async (t) => {
  const lf = await receiver(t, () => ({ delayMs: 150 }));
  const box = sandbox(t, langfuse(lf.url));
  writeFileSync(box.transcript, fixture('claude-transcript.jsonl').slice(0, 8).join('\n') + '\n');
  const payload = { hook_event_name: 'Stop', session_id: 'synthetic-session', transcript_path: box.transcript };
  const runs = await Promise.all([hookProcess(box.env, payload), hookProcess(box.env, payload), hookProcess(box.env, payload)]);
  assert.ok(runs.every(run => run.code === 0 && run.stdout === ''), 'hooks exit 0 and print nothing');
  assert.equal(lf.requests.length, 1);
  const restarted = await hookProcess(box.env, payload);
  assert.equal(restarted.code, 0);
  assert.equal(lf.requests.length, 1);
});

test('one receiver down: the other is not sent again, and the failed one is retried', async (t) => {
  let tempoUp = false;
  const lf = await receiver(t);
  const tempo = await receiver(t, () => tempoUp ? {} : { status: 503 });
  const box = sandbox(t, langfuse(lf.url, { CODING_AGENT_OTLP_TRACES_ENDPOINT: tempo.url + '/v1/traces' }));
  writeFileSync(box.transcript, fixture('claude-transcript.jsonl').slice(0, 8).join('\n') + '\n');
  const failed = await stop('claude', box.transcript);
  assert.ok(failed.errors! > 0, 'a refused destination is reported');
  assert.deepEqual(statuses(failed, 'langfuse-otlp'), ['delivered']);
  assert.deepEqual(statuses(failed, 'otlp'), ['failed']);

  tempoUp = true;
  const retried = await stop('claude', box.transcript);
  assert.equal(retried.errors, 0);
  assert.deepEqual(statuses(retried, 'langfuse-otlp'), ['skipped']);
  assert.deepEqual(statuses(retried, 'otlp'), ['delivered']);
  assert.equal(lf.requests.length, 1, 'the receiver that succeeded gets nothing more');
  assert.equal(tempo.requests.length, 2);
});

test('legacy ingestion: a 207 with per-event errors is partial, then retried in full', async (t) => {
  const lf = await receiver(t, (request, count) => count === 1
    ? { status: 207, body: JSON.stringify({ successes: [], errors: [{ id: request.body.batch[2].id, status: 400, message: 'invalid' }] }) }
    : { status: 207, body: '{"successes":[],"errors":[]}' });
  const box = sandbox(t, langfuse(lf.url, { LANGFUSE_HOOK_TRANSPORT: 'legacy' }));
  writeFileSync(box.transcript, fixture('claude-transcript.jsonl').slice(0, 8).join('\n') + '\n');
  const partial = await stop('claude', box.transcript);
  assert.equal(lf.requests[0].path, '/api/public/ingestion');
  assert.equal(lf.requests[0].headers['x-langfuse-ingestion-version'], undefined);
  assert.deepEqual(statuses(partial, 'langfuse-legacy'), ['partial']);
  assert.ok(partial.errors! > 0, 'HTTP 207 alone is not success');

  const retried = await stop('claude', box.transcript);
  assert.deepEqual(statuses(retried, 'langfuse-legacy'), ['delivered']);
  assert.equal(lf.requests[1].body.batch.length, lf.requests[0].body.batch.length, 'legacy upserts, so the turn is sent whole');
  await stop('claude', box.transcript);
  assert.equal(lf.requests.length, 2, 'confirmed: no third request');
});

test('OTLP partialSuccess is unconfirmed: reported, and not sent again automatically', async (t) => {
  const lf = await receiver(t, () => ({ body: JSON.stringify({ partialSuccess: { rejectedSpans: 1, errorMessage: 'x' } }) }));
  const box = sandbox(t, langfuse(lf.url));
  writeFileSync(box.transcript, fixture('claude-transcript.jsonl').slice(0, 8).join('\n') + '\n');
  const first = await stop('claude', box.transcript);
  assert.deepEqual(statuses(first, 'langfuse-otlp'), ['unconfirmed']);
  assert.ok(first.errors! > 0, 'HTTP 200 with rejected spans is not success');
  const [record] = listRecords(deliveryDir(loadConfig('claude')));
  assert.equal(record.status, 'unconfirmed');
  assert.equal(record.pending?.length, 4);
  assert.deepEqual(record.spans, {});

  const second = await stop('claude', box.transcript);
  assert.deepEqual(statuses(second, 'langfuse-otlp'), ['held']);
  assert.equal(lf.requests.length, 1);
});

test('a timeout is unconfirmed, does not throw, and is not retried blindly', async (t) => {
  const lf = await receiver(t, () => ({ delayMs: 700 }));
  const box = sandbox(t, langfuse(lf.url, { LANGFUSE_HOOK_TIMEOUT_MS: '150' }));
  writeFileSync(box.transcript, fixture('claude-transcript.jsonl').slice(0, 8).join('\n') + '\n');
  const first = await stop('claude', box.transcript);
  assert.deepEqual(statuses(first, 'langfuse-otlp'), ['unconfirmed']);
  const second = await stop('claude', box.transcript);
  assert.deepEqual(statuses(second, 'langfuse-otlp'), ['held']);
  assert.equal(lf.requests.length, 1);
});

test('an unreachable receiver never fails the hook process', async (t) => {
  const closed = await receiver(t);
  // Reserve a port, then close it, so the connection is refused.
  const gone = createServer();
  await new Promise<void>(resolve => gone.listen(0, '127.0.0.1', resolve));
  const refused = 'http://127.0.0.1:' + (gone.address() as AddressInfo).port;
  await new Promise(resolve => gone.close(resolve));
  const box = sandbox(t, langfuse(refused, { CODING_AGENT_OTLP_TRACES_ENDPOINT: closed.url + '/v1/traces' }));
  writeFileSync(box.transcript, fixture('claude-transcript.jsonl').slice(0, 8).join('\n') + '\n');
  const run = await hookProcess(box.env, { hook_event_name: 'Stop', session_id: 'synthetic-session', transcript_path: box.transcript });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.equal(closed.requests.length, 1, 'the reachable receiver still gets the turn');
  const records = listRecords(join(box.env.CLAUDE_CONFIG_DIR, 'state', 'delivery'));
  assert.deepEqual(records.map(record => record.status).sort(), ['confirmed', 'failed']);
});

test('capture off sends no bodies, and logs hold no keys or content', async (t) => {
  const lf = await receiver(t, (_request, count) => count === 1 ? { status: 500 } : {});
  const tempo = await receiver(t);
  const box = sandbox(t, langfuse(lf.url, { LANGFUSE_HOOK_CAPTURE_CONTENT: 'false', LANGFUSE_HOOK_DEBUG: 'true',
    CODING_AGENT_OTLP_TRACES_ENDPOINT: tempo.url + '/v1/traces' }));
  writeFileSync(box.transcript, fixture('claude-transcript.jsonl').slice(0, 8).join('\n') + '\n');
  await stop('claude', box.transcript);
  for (const request of [...lf.requests, ...tempo.requests]) {
    const text = JSON.stringify(request.body);
    for (const span of spansOf(request)) {
      for (const key of ['langfuse.observation.input', 'langfuse.observation.output', 'coding_agent.input', 'coding_agent.output']) {
        assert.equal(attr(span, key), undefined, key);
      }
    }
    assert.ok(!text.includes('List files') && !text.includes('a.txt'), 'no prompt or tool output');
  }
  const log = readFileSync(logPath(loadConfig('claude')), 'utf8');
  assert.match(log, /unconfirmed/, 'the failure is logged');
  for (const secret of [SECRET_KEY, PUBLIC_KEY, BASIC, BASIC.slice(6), 'List files', 'a.txt', '11111111-2222']) {
    assert.ok(!log.includes(secret), 'log must not contain ' + secret.slice(0, 6));
  }
  for (const record of listRecords(deliveryDir(loadConfig('claude')))) {
    const text = JSON.stringify(record);
    assert.ok(!text.includes(SECRET_KEY) && !text.includes(PUBLIC_KEY) && !text.includes('List files'));
  }
});

test('a Collector that forwards to Langfuse disables the direct route unless both are requested', async (t) => {
  const lf = await receiver(t);
  const collector = await receiver(t);
  const box = sandbox(t, langfuse(lf.url, { CODING_AGENT_OTLP_TRACES_ENDPOINT: collector.url + '/v1/traces',
    CODING_AGENT_OTLP_FORWARDS_TO_LANGFUSE: 'true' }));
  writeFileSync(box.transcript, fixture('claude-transcript.jsonl').slice(0, 8).join('\n') + '\n');
  const result = await stop('claude', box.transcript);
  assert.equal(collector.requests.length, 1);
  assert.equal(lf.requests.length, 0, 'no second copy to the same project');
  assert.deepEqual(statuses(result, 'langfuse-otlp'), ['config-error']);
  assert.ok(result.errors! > 0, 'the conflict is reported, not silent');
  assert.match(result.destinations!.find(d => d.kind === 'otlp')!.evidence, /relay/);
  assert.equal(existsSync(box.transcript), true);
});

test('destination identifiers carry no credentials, and transport is never switched implicitly', (t) => {
  sandbox(t, {});
  const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ TRACE_TO_LANGFUSE: 'true', LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: SECRET_KEY, CODING_AGENT_GITHUB_METADATA: 'false', ...extra });
  const [legacy] = resolveDestinations(loadConfig('claude', env({ LANGFUSE_BASE_URL: 'https://cloud.langfuse.com' })));
  assert.equal(legacy.kind, 'langfuse-otlp', 'unset transport uses the supported route, not the deprecated one');
  assert.equal(legacy.legacyFallback, true, 'falling back only if the server has no OTLP endpoint');
  const [asked] = resolveDestinations(loadConfig('claude', env({ LANGFUSE_BASE_URL: 'https://lf.example.test', LANGFUSE_HOOK_TRANSPORT: 'legacy' })));
  assert.equal(asked.kind, 'langfuse-legacy', 'legacy ingestion stays available when asked for');
  assert.equal(asked.legacyFallback, undefined);
  const [direct, other] = resolveDestinations(loadConfig('claude', env({ LANGFUSE_BASE_URL: 'https://lf.example.test',
    LANGFUSE_HOOK_TRANSPORT: 'otlp', CODING_AGENT_OTLP_TRACES_ENDPOINT: 'https://user:pass@tempo.example.test/v1/traces?token=abc' })));
  assert.equal(other.kind, 'langfuse-otlp');
  assert.equal(other.otlp?.headers.get('x-langfuse-ingestion-version'), '4');
  assert.equal(direct.otlp?.headers.get('authorization'), null);
  assert.equal(direct.otlp?.headers.get('x-langfuse-ingestion-version'), null);
  for (const destination of [legacy, direct, other]) {
    for (const secret of [PUBLIC_KEY, SECRET_KEY, 'user', 'pass', 'abc']) assert.ok(!destination.id.includes(secret), destination.id);
  }
  assert.notEqual(legacy.id, other.id, 'legacy and OTLP delivery are tracked separately');
  const [invalid] = resolveDestinations(loadConfig('claude', env({ LANGFUSE_HOOK_TRANSPORT: 'grpc' })));
  assert.match(invalid.configError ?? '', /auto, otlp or legacy/);
});

test('the Langfuse route keeps what legacy ingestion carried: events, metadata and the body limit', async (t) => {
  const lf = await receiver(t);
  const tempo = await receiver(t);
  const box = sandbox(t, langfuse(lf.url, { CODING_AGENT_OTLP_TRACES_ENDPOINT: tempo.url + '/v1/traces', OTEL_CAPTURE_CONTENT: 'true' }));
  const rows = fixture('claude-transcript.jsonl').slice(0, 8).map(line => JSON.parse(line));
  rows[1].message.content = 'P'.repeat(15000); // longer than the 8000 default, shorter than the 20000 legacy limit
  writeFileSync(box.transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await stop('claude', box.transcript);
  const sent = spansOf(lf.requests[0]);
  const root = sent.find(span => !span.parentSpanId);
  const model = sent.find(span => attr(span, 'langfuse.observation.type') === 'generation');
  assert.ok(attr(root, 'langfuse.observation.input').includes('P'.repeat(15000)), 'same per-string limit as legacy ingestion');
  assert.equal(attr(model, 'langfuse.observation.metadata.stopReason'), 'tool_use');
  assert.equal(attr(model, 'langfuse.observation.metadata.requestId'), rows[2].requestId ?? rows[3].requestId);
  for (const span of sent) assert.equal(attr(span, 'langfuse.trace.metadata.promptSource'), 'typed', 'turn metadata on every span');

  const elsewhere = spansOf(tempo.requests[0]);
  assert.ok(!attr(elsewhere.find(span => !span.parentSpanId), 'coding_agent.input').includes('P'.repeat(8001)), 'other receivers keep the 8000 limit');
  assert.ok(elsewhere.every(span => attr(span, 'langfuse.trace.metadata.promptSource') === undefined
    && attr(span, 'langfuse.observation.metadata.stopReason') === undefined), 'adapter metadata is not widened to other receivers');

  // An idle notification after the turn ended: one new event observation, nothing repeated.
  await runHook('claude', { hook_event_name: 'Notification', session_id: 's', transcript_path: box.transcript,
    notification_type: 'idle_prompt', message: 'waiting for input' });
  assert.equal(lf.requests.length, 2);
  const [event] = spansOf(lf.requests[1]);
  assert.equal(spansOf(lf.requests[1]).length, 1);
  assert.equal(attr(event, 'langfuse.observation.type'), 'event');
  assert.equal(event.name, 'Notification: idle_prompt');
  assert.equal(event.parentSpanId, root.spanId);
  assert.equal(event.startTimeUnixNano, event.endTimeUnixNano);
  assert.match(attr(event, 'langfuse.observation.input'), /waiting for input/);
  assert.equal(attr(event, 'langfuse.session.id'), 'sess-1');
  assert.equal(tempo.requests.length, 1, 'no event span for a receiver that shows span events');
});

test('a turn left without a Stop event is closed and sent once its transcript has been idle', async (t) => {
  const lf = await receiver(t);
  const box = sandbox(t, langfuse(lf.url, { LANGFUSE_HOOK_STALE_TURN_MINUTES: '0.002' })); // 120 ms
  const rows = fixture('claude-transcript.jsonl');
  const abandoned = join(box.home, 'abandoned.jsonl');
  // The session stops after a tool result: no final model call, no end-of-turn marker, no Stop.
  writeFileSync(abandoned, rows.slice(0, 5).join('\n') + '\n');
  const first = await runHook('claude', { hook_event_name: 'Notification', session_id: 'sess-1', transcript_path: abandoned, message: 'needs permission' });
  assert.deepEqual(statuses(first, 'langfuse-otlp'), ['not-ready']);
  assert.equal(lf.requests.length, 0, 'an unfinished turn is not sent to a receiver that cannot update it');

  await new Promise(resolve => setTimeout(resolve, 300));
  // Any later hook for another session picks it up.
  writeFileSync(box.transcript, rows.slice(0, 8).join('\n').replaceAll('sess-1', 'sess-2') + '\n');
  await stop('claude', box.transcript, 'sess-2');
  assert.equal(lf.requests.length, 2);
  const closed = lf.requests.map(spansOf).find(spans => attr(spans[0], 'langfuse.session.id') === 'sess-1')!;
  assert.ok(closed, 'the abandoned turn was sent');
  assert.ok(closed.every(span => attr(span, 'langfuse.trace.metadata.endedWithoutStop') === true
    && attr(span, 'langfuse.trace.metadata.complete') === true), 'and is marked as closed without a Stop');
  assert.equal(attr(closed.find(span => !span.parentSpanId), 'langfuse.trace.name'), 'Claude Code - Turn 1');

  await new Promise(resolve => setTimeout(resolve, 300));
  await stop('claude', box.transcript, 'sess-2');
  assert.equal(lf.requests.length, 2, 'closed once: nothing is sent again');
});

test('an unconfirmed turn is settled against what the backend holds: found spans accepted, the rest sent once', async (t) => {
  let healthy = false;
  const lf = await receiver(t, () => healthy ? {} : { body: JSON.stringify({ partialSuccess: { rejectedSpans: 1 } }) });
  const box = sandbox(t, langfuse(lf.url));
  writeFileSync(box.transcript, fixture('claude-transcript.jsonl').slice(0, 8).join('\n') + '\n');
  await stop('claude', box.transcript);
  const dir = deliveryDir(loadConfig('claude'));
  const [record] = listRecords(dir);
  assert.equal(record.status, 'unconfirmed');
  // A read of the backend finds three of the four spans.
  const present = new Set(record.pending!.slice(0, 3).map(otlpSpanId));
  const absent = otlpSpanId(record.pending![3]);
  assert.deepEqual(reconcile(dir, record, present, otlpSpanId), { found: 3, released: 1, status: 'partial' });

  healthy = true;
  const next = await stop('claude', box.transcript);
  assert.deepEqual(statuses(next, 'langfuse-otlp'), ['delivered']);
  assert.deepEqual(spansOf(lf.requests[1]).map(span => span.spanId), [absent], 'only the span the backend did not have');
  assert.equal(listRecords(dir)[0].status, 'confirmed');
  await stop('claude', box.transcript);
  assert.equal(lf.requests.length, 2);
  assert.equal(listRecords(dir)[0].lateChanges, undefined, 'spans accepted by a read are not reported as changed');
});

test('with no transport chosen, a server without an OTLP endpoint gets legacy ingestion, and is not probed again', async (t) => {
  const lf = await receiver(t, request => request.path === '/api/public/otel/v1/traces' ? { status: 404 }
    : { status: 207, body: '{"successes":[],"errors":[]}' });
  const settings = langfuse(lf.url);
  delete (settings as Record<string, string>).LANGFUSE_HOOK_TRANSPORT;
  const box = sandbox(t, settings);
  const rows = fixture('claude-transcript.jsonl');
  writeFileSync(box.transcript, rows.slice(0, 8).join('\n') + '\n');
  const first = await stop('claude', box.transcript);
  assert.equal(first.errors, 0, 'the turn is delivered in the same run');
  assert.deepEqual(lf.requests.map(request => request.path), ['/api/public/otel/v1/traces', '/api/public/ingestion']);
  assert.deepEqual(statuses(first, 'langfuse-legacy'), ['delivered']);
  assert.match(readFileSync(logPath(loadConfig('claude')), 'utf8'), /no OTLP endpoint.*deprecated/);

  appendFileSync(box.transcript, rows.slice(8).join('\n') + '\n');
  await stop('claude', box.transcript);
  assert.ok(lf.requests.slice(2).every(request => request.path === '/api/public/ingestion'), 'OTLP is not probed on every turn');
});

test('a home that used legacy ingestion does not resend an earlier turn over OTLP', async (t) => {
  const posts: any[] = [];
  let storedByLegacy = true;
  const lf = await receiver(t, (request) => {
    if (request.path.startsWith('/api/public/v2/observations')) {
      // The project already holds the turn under legacy observation IDs.
      return { body: JSON.stringify({ data: storedByLegacy ? [{ id: 'legacy-observation-id', traceId: 'x', type: 'GENERATION' }] : [], meta: {} }) };
    }
    posts.push(request);
    return {};
  });
  const box = sandbox(t, langfuse(lf.url));
  // Read positions in the old format are what an earlier runtime leaves behind.
  const state = join(box.env.CLAUDE_CONFIG_DIR, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'langfuse_agent_hooks_state.json'), JSON.stringify({ version: 1,
    transcripts: { [box.transcript]: { offset: 0, turnsBefore: 0, updatedAt: new Date().toISOString() } } }));
  const rows = fixture('claude-transcript.jsonl');
  writeFileSync(box.transcript, rows.slice(0, 8).join('\n') + '\n');
  const first = await stop('claude', box.transcript);
  assert.deepEqual(statuses(first, 'langfuse-otlp'), ['held']);
  assert.equal(posts.length, 0, 'the turn legacy ingestion stored is not sent a second time');
  assert.equal(first.errors, 0, 'and that is not an error');

  // A turn that starts after the change is sent normally, with no read first.
  storedByLegacy = false;
  const later = rows.slice(8).map(line => JSON.parse(line));
  const shift = Date.now() + 60_000 - Date.parse(later[0].timestamp);
  for (const row of later) if (row.timestamp) row.timestamp = new Date(Date.parse(row.timestamp) + shift).toISOString();
  appendFileSync(box.transcript, later.map(row => JSON.stringify(row)).join('\n') + '\n');
  const reads = lf.requests.length - posts.length;
  await stop('claude', box.transcript);
  assert.equal(posts.length, 1);
  assert.equal(lf.requests.length - posts.length, reads, 'no project read for a turn that began after the change');
});

test('verify reads a trace back from Tempo, and export-events takes a turn from another integration', async (t) => {
  const traceId = 'c5c113e297450e2e9606455dc35210c7';
  const backend = await receiver(t, (request) => {
    if (request.path.startsWith('/api/traces/')) {
      // Tempo's trace-by-ID response: batches of scope spans.
      return request.path.endsWith(traceId) ? { body: JSON.stringify({ batches: [{ scopeSpans: [{ spans: [{ spanId: 'a' }, { spanId: 'b' }, { spanId: 'c' }] }] }] }) }
        : { status: 404 };
    }
    if (request.path.startsWith('/api/public/v2/observations')) return { body: JSON.stringify({ data: [{ id: 'o1', traceId, type: 'AGENT' }], meta: {} }) };
    return {};
  });
  const box = sandbox(t, langfuse(backend.url));
  const found = await cliProcess(box.env, ['verify', 'claude', traceId, '--tempo', backend.url]);
  const report = JSON.parse(found.output);
  assert.deepEqual(report.tempo, { stored: 3, verdict: 'STORED' });
  assert.equal(report.langfuse.verdict, 'STORED');
  assert.equal(found.code, 0);
  const missing = JSON.parse((await cliProcess(box.env, ['verify', 'claude', 'f'.repeat(32), '--tempo', backend.url])).output);
  assert.equal(missing.tempo.verdict, 'NOT FOUND');

  // A finished turn handed over on stdin (the OpenCode plugin does this) goes out over OTLP once.
  const events = [
    { id: 'e1', timestamp: '2026-11-08T10:00:00.000Z', type: 'trace-create', body: { id: 'a'.repeat(32), timestamp: '2026-11-08T10:00:00.000Z',
      name: 'OpenCode turn x', sessionId: 'ses', userId: 'u', tags: ['opencode', 'h'], metadata: { source: 'opencode' } } },
    { id: 'e2', timestamp: '2026-11-08T10:00:00.000Z', type: 'agent-create', body: { id: 'root', traceId: 'a'.repeat(32), name: 'OpenCode',
      startTime: '2026-11-08T10:00:00.000Z', endTime: '2026-11-08T10:00:02.000Z' } },
  ];
  const posts = () => backend.requests.filter(request => request.path === '/api/public/otel/v1/traces');
  const handOver = () => new Promise<number | null>((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SETTINGS.includes(key)));
    const child = spawn(process.execPath, [CLI, 'export-events', 'opencode'], { env: { ...clean, ...box.env, USERPROFILE: box.home, HOME: box.home }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', reject);
    child.once('close', resolve);
    child.stdin.end(JSON.stringify(events));
  });
  assert.equal(await handOver(), 0);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].headers['x-langfuse-ingestion-version'], '4');
  assert.equal(backend.requests.filter(request => request.path === '/api/public/ingestion').length, 0, 'not the deprecated ingestion API');
  assert.equal(await handOver(), 0);
  assert.equal(posts().length, 1, 'handed over twice, stored once');
});
