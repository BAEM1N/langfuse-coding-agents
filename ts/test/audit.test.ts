// The v2 audit is checked against a mock API. The rows are built the way the
// Langfuse OTLP mapping is documented to store this exporter's spans; a real
// project is still needed to confirm that mapping.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseClaudeTranscript } from '../src/adapters/claude.ts';
import { auditLangfuse, auditLangfuseV2, readTraceObservations } from '../src/core/audit.ts';
import { turnToEvents } from '../src/core/batch.ts';
import { readJsonlFrom } from '../src/core/jsonl.ts';
import { LangfuseClient } from '../src/core/langfuse.ts';
import { nullLogger } from '../src/core/log.ts';
import { otlpPayload } from '../src/core/otlp.ts';

function storedRows() {
  const file = fileURLToPath(new URL('./fixtures/claude-transcript.jsonl', import.meta.url));
  const [turn] = parseClaudeTranscript(readJsonlFrom(file).entries, { sessionId: 'sess-1', turnsBefore: 0 });
  const events = turnToEvents(turn, { agentLabel: 'Claude Code', agentTag: 'claude-code', userId: 'u', hostname: 'h', maxChars: 20000, redact: true });
  const spans = otlpPayload(events, 'claude', { captureContent: false }).resourceSpans[0].scopeSpans[0].spans;
  const iso = (nanos: string) => new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();
  return spans.map((span) => {
    const get = (key: string) => {
      const value = span.attributes.find((item) => item.key === key)?.value as any;
      return value?.stringValue ?? value?.boolValue ?? (value?.arrayValue ? value.arrayValue.values.map((v: any) => v.stringValue) : undefined);
    };
    const usage = get('langfuse.observation.usage_details');
    return { id: span.spanId, traceId: span.traceId, parentObservationId: 'parentSpanId' in span ? span.parentSpanId : null,
      type: String(get('langfuse.observation.type')).toUpperCase(), name: span.name,
      startTime: iso(span.startTimeUnixNano), endTime: iso(span.endTimeUnixNano), tags: get('langfuse.trace.tags'),
      usageDetails: usage ? JSON.parse(usage) : undefined,
      metadata: { toolCallId: get('langfuse.observation.metadata.toolCallId'),
        issuedByObservationId: get('langfuse.observation.metadata.issuedByObservationId'),
        consumedByObservationId: get('langfuse.observation.metadata.consumedByObservationId'),
        complete: get('langfuse.trace.metadata.complete'), agent: get('langfuse.trace.metadata.agent') } };
  });
}

test('v2 audit pages through observations, groups them by trace, and keeps tool links', async (t) => {
  const rows = storedRows();
  const queries: URLSearchParams[] = [];
  const paths: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    paths.push(url.pathname);
    queries.push(url.searchParams);
    assert.match(req.headers.authorization ?? '', /^Basic /);
    const cursor = url.searchParams.get('cursor');
    // First page, then an empty page that still carries a cursor, then the rest.
    const page = url.searchParams.get('traceId') ? { data: rows, meta: {} }
      : !cursor ? { data: rows.slice(0, 2), meta: { cursor: 'c1' } }
        : cursor === 'c1' ? { data: [], meta: { cursor: 'c2' } }
          : { data: rows.slice(2), meta: { cursor: null } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(page));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const client = new LangfuseClient({ baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    publicKey: 'pk-lf-test', secretKey: 'sk-lf-test', timeoutMs: 5000, logger: nullLogger });

  const report = await auditLangfuseV2(client, { limit: 20, from: '2026-11-08T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z' });
  assert.ok(paths.every(path => path === '/api/public/v2/observations'));
  assert.equal(queries.length, 3, 'an empty page with a cursor does not end the read');
  assert.equal(queries[0].get('fromStartTime'), '2026-11-08T00:00:00.000Z');
  assert.equal(queries[0].get('toStartTime'), '2026-11-09T00:00:00.000Z');
  assert.match(queries[0].get('fields') ?? '', /core.*usage.*metadata/);
  assert.deepEqual(queries.map(query => query.get('cursor')), [null, 'c1', 'c2']);
  assert.equal(report.api, 'v2');
  assert.equal(report.truncated, false);
  assert.equal(report.observations, rows.length);
  assert.equal(report.traces, 1);
  const agent = report.agents['claude-code'];
  assert.ok(agent, 'agent is recovered from tags or metadata');
  assert.equal(agent.tools, 1);
  assert.equal(agent.toolsWithoutIds, 0);
  assert.equal(agent.toolLinks, 1);
  assert.equal(agent.reversedSpans, 0);
  assert.equal(agent.coverage.modelCalls, 2);
  assert.equal(agent.coverage.modelTokenUsage, 2);

  const stored = await readTraceObservations(client, 'v2', rows[0].traceId);
  assert.equal(queries.at(-1)?.get('traceId'), rows[0].traceId);
  assert.deepEqual(stored.map(span => span.type).sort(), ['AGENT', 'GENERATION', 'GENERATION', 'TOOL']);
});

test('the legacy audit keeps reading stored traces', async (t) => {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url?.startsWith('/api/public/traces?')
      ? { data: [{ id: 't1' }] } : { id: 't1', timestamp: '2026-11-08T10:00:00.000Z', tags: ['codex'], metadata: {}, observations: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const client = new LangfuseClient({ baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    publicKey: 'pk-lf-test', secretKey: 'sk-lf-test', timeoutMs: 5000, logger: nullLogger });
  const report = await auditLangfuse(client, 5);
  assert.equal(report.api, 'legacy');
  assert.equal(report.agents.codex.traces, 1);
  assert.match(paths[0], /^\/api\/public\/traces\?limit=5&fromTimestamp=/);
  assert.equal(paths[1], '/api/public/traces/t1');
});

test('Tempo span IDs are read as hex whether Tempo answers in base64 or hex', async () => {
  const { createServer } = await import('node:http');
  const { readTempoSpanIds } = await import('../src/core/audit.ts');
  const hex = '0123456789abcdef';
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/missing')) { res.statusCode = 404; res.end(); return; }
    if (req.url?.endsWith('/broken')) { res.statusCode = 500; res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ batches: [{ scopeSpans: [{ spans: [{ spanId: Buffer.from(hex, 'hex').toString('base64') }, { spanId: hex.toUpperCase() }] }] }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  try {
    assert.deepEqual(await readTempoSpanIds(base, 'abc'), [hex, hex]);
    assert.equal(await readTempoSpanIds(base, 'missing'), undefined);
    await assert.rejects(readTempoSpanIds(base, 'broken'), /HTTP 500/);
  } finally { server.close(); }
});
