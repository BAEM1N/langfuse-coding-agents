import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseClaudeTranscript } from '../src/adapters/claude.ts';
import { turnToEvents } from '../src/core/batch.ts';
import { loadDotenv } from '../src/core/config.ts';
import { stableId } from '../src/core/ids.ts';
import { readJsonlFrom } from '../src/core/jsonl.ts';
import { nullLogger } from '../src/core/log.ts';
import { normalizePayload, runHook } from '../src/core/run.ts';
import { redact, sanitize } from '../src/core/text.ts';
import { mergeHooks } from '../src/install.ts';

const opts = { agentLabel: 'Claude Code', agentTag: 'claude-code', userId: 'u', hostname: 'h', maxChars: 20000, redact: true };

test('redact masks common secrets', () => {
  const cases: Array<[string, RegExp]> = [
    ['key sk-lf-11111111-2222-3333-4444-555555555555 end', /sk-lf-\[REDACTED\]/],
    ['pk-lf-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', /pk-lf-\[REDACTED\]/],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB', /gh\*_\[REDACTED\]/],
    ['glpat-abcdefghij1234567890', /glpat-\[REDACTED\]/],
    ['AKIAABCDEFGHIJKLMNOP', /AKIA\[REDACTED\]/],
    ['PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=', /PrivateKey = \[REDACTED\]/],
    ['LANGFUSE_SECRET_KEY="abc123456789"', /LANGFUSE_SECRET_KEY=\[REDACTED\]/],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', /Bearer \[REDACTED\]/],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----', /\[REDACTED PRIVATE KEY\]/],
  ];
  for (const [input, expected] of cases) assert.match(redact(input), expected, input);
  assert.equal(redact('plain text with no secrets'), 'plain text with no secrets');
});

test('sanitize truncates, redacts deeply and drops images', () => {
  const out = sanitize({ a: 'x'.repeat(50), b: [{ t: 'sk-ant-api03-abcdefghijklmnopqrstuvwx' }], img: { type: 'image', source: { data: 'AAAA' } } }, { maxChars: 30, redact: true }) as any;
  assert.match(out.a, /^x{30}… \[truncated 20 chars\]$/);
  assert.match(out.b[0].t, /REDACTED/);
  assert.deepEqual(out.img, { type: 'image', note: '[image omitted]' });
});

test('stableId is deterministic and 32 hex chars', () => {
  assert.equal(stableId('a', 'b'), stableId('a', 'b'));
  assert.notEqual(stableId('a', 'b'), stableId('ab'));
  assert.match(stableId('x'), /^[0-9a-f]{32}$/);
});

test('turnToEvents: deterministic ids, hierarchy and redaction', () => {
  const file = fileURLToPath(new URL('./fixtures/claude-transcript.jsonl', import.meta.url));
  const [t1] = parseClaudeTranscript(readJsonlFrom(file).entries, { sessionId: 'x', turnsBefore: 0 });
  const a = turnToEvents(t1, opts);
  const b = turnToEvents(t1, opts);
  assert.deepEqual(a.map((e) => e.body.id), b.map((e) => e.body.id));
  assert.deepEqual(a.map((e) => e.type), ['trace-create', 'agent-create', 'generation-create', 'tool-create', 'generation-create']);
  const traceId = a[0].body.id;
  const agentId = a[1].body.id;
  for (const e of a.slice(1)) assert.equal(e.body.traceId, traceId);
  for (const e of a.slice(2)) assert.equal(e.body.parentObservationId, agentId);
  assert.equal(a[0].body.name, 'Claude Code - Turn 1');
  assert.equal(a[0].body.userId, 'u');
  assert.ok(!JSON.stringify(a).includes('11111111-2222'), 'secret must not be sent');
});

test('Claude Stop waits for the model call recorded after the tool result', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'lah-claude-stop-'));
  const path = join(home, 'transcript.jsonl');
  const rows = readFileSync(new URL('./fixtures/claude-transcript.jsonl', import.meta.url), 'utf8').split(/\r?\n/);
  const env = {
    CLAUDE_CONFIG_DIR: home,
    TRACE_TO_LANGFUSE: 'false',
    CODING_AGENT_OTLP_ENABLED: 'true',
    CODING_AGENT_OTLP_TRACES_ENDPOINT: 'https://collector.example.test/v1/traces',
    CODING_AGENT_COLLECTOR_LAUNCHER: '',
  };
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent.push(String(init?.body));
    return new Response('{}');
  });
  writeFileSync(path, rows.slice(0, 5).join('\n') + '\n');
  const timer = setTimeout(() => appendFileSync(path, rows.slice(5, 8).join('\n') + '\n'), 30);
  t.after(() => {
    clearTimeout(timer);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { force: true, recursive: true });
  });
  const result = await runHook('claude', { hook_event_name: 'Stop', session_id: 'diagnostic', transcript_path: path }, nullLogger);
  assert.equal(result.errors, 0);
  assert.equal(sent.length, 1);
  const spans: { kind: number }[] = JSON.parse(sent[0]).resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.filter(span => span.kind === 3).length, 2);
});

test('readJsonlFrom ignores a trailing partial line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lah-'));
  const f = join(dir, 't.jsonl');
  writeFileSync(f, '{"a":1}\r\n{"b":2}\n{"c":');
  const r = readJsonlFrom(f);
  assert.deepEqual(r.entries.map((e) => e.value), [{ a: 1 }, { b: 2 }]);
  assert.equal(r.entries[1].offset, 9);
  assert.equal(readJsonlFrom(f, 999).from, 0, 'offset beyond EOF resets to 0');
});

test('loadDotenv parses quotes and never overrides existing env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lah-'));
  const f = join(dir, '.env');
  writeFileSync(f, '﻿# c\nA="quoted value"\nB=plain # comment\nexport C=\'single\'\nD=keep\n');
  const env: NodeJS.ProcessEnv = { D: 'original' };
  loadDotenv(f, env);
  assert.equal(env.A, 'quoted value');
  assert.equal(env.B, 'plain');
  assert.equal(env.C, 'single');
  assert.equal(env.D, 'original');
});

test('normalizePayload maps camelCase keys', () => {
  const p = normalizePayload({ sessionId: 's', hookEventName: 'Stop', transcriptPath: '/t' });
  assert.equal(p.session_id, 's');
  assert.equal(p.hook_event_name, 'Stop');
  assert.equal(p.transcript_path, '/t');
});

test('mergeHooks replaces python and ts entries, keeps others, is idempotent', () => {
  const other = { hooks: [{ type: 'command', command: 'prettier --write' }] };
  const py = { hooks: [{ type: 'command', command: 'python ~/.claude/hooks/langfuse_hook.py' }] };
  const ts = { hooks: [{ type: 'command', command: 'node', args: ['/x/langfuse-agent-hooks/src/cli.ts', 'hook', 'claude'] }] };
  const start = { Stop: [py, other], PreToolUse: [py], PostToolUse: [other] };
  const once = mergeHooks(start, ['Stop', 'Notification'], ts);
  assert.deepEqual(once, { Stop: [other, ts], PostToolUse: [other], Notification: [ts] });
  assert.deepEqual(mergeHooks(once, ['Stop', 'Notification'], ts), once);
  assert.deepEqual(mergeHooks(once, [], ts), { Stop: [other], PostToolUse: [other] });
});
