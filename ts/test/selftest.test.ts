// The self-test, run against a stand-in for Langfuse that stores OTLP spans the
// way the real server was observed to (IDs, types, parents, usage and metadata
// from the langfuse.* attributes) and serves them back.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { loadConfig } from '../src/core/config.ts';
import { selfTest } from '../src/core/selftest.ts';

async function fakeLangfuse(t: TestContext, mode: 'v2' | 'legacy', corrupt?: (observation: any) => void) {
  const traces = new Map<string, any>();
  const deleted: string[] = [];
  const value = (attribute: any) => {
    const v = attribute.value;
    if ('intValue' in v) return Number(v.intValue);
    if ('arrayValue' in v) return v.arrayValue.values.map((item: any) => item.stringValue);
    return v.stringValue ?? v.boolValue ?? v.doubleValue;
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '', 'http://x');
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && url.pathname === '/api/public/otel/v1/traces') {
        assert.equal(req.headers['x-langfuse-ingestion-version'], '4');
        for (const span of JSON.parse(Buffer.concat(chunks).toString('utf8')).resourceSpans[0].scopeSpans[0].spans) {
          const attributes = Object.fromEntries(span.attributes.map((attribute: any) => [attribute.key, value(attribute)]));
          const pick = (prefix: string) => Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith(prefix)).map(([key, v]) => [key.slice(prefix.length), v]));
          const trace = traces.get(span.traceId) ?? { id: span.traceId, observations: [], metadata: {} };
          Object.assign(trace, { sessionId: attributes['langfuse.session.id'], tags: attributes['langfuse.trace.tags'], name: attributes['langfuse.trace.name'] });
          Object.assign(trace.metadata, pick('langfuse.trace.metadata.'));
          const observation = { id: span.spanId, traceId: span.traceId, type: String(attributes['langfuse.observation.type']).toUpperCase(), name: span.name,
            parentObservationId: span.parentSpanId ?? null, level: attributes['langfuse.observation.level'],
            usageDetails: attributes['langfuse.observation.usage_details'] ? JSON.parse(attributes['langfuse.observation.usage_details']) : {},
            metadata: mode === 'v2' ? { ...pick('langfuse.trace.metadata.'), ...pick('langfuse.observation.metadata.') } : pick('langfuse.observation.metadata.'),
            sessionId: attributes['langfuse.session.id'], tags: attributes['langfuse.trace.tags'], traceName: attributes['langfuse.trace.name'] };
          corrupt?.(observation);
          trace.observations.push(observation);
          traces.set(span.traceId, trace);
        }
        return json(200, {});
      }
      if (url.pathname === '/api/public/v2/observations') {
        if (mode !== 'v2') return json(404, { message: 'not in a v4 write mode' });
        return json(200, { data: traces.get(url.searchParams.get('traceId') ?? '')?.observations ?? [], meta: {} });
      }
      const match = /^\/api\/public\/traces\/([0-9a-f]{32})$/.exec(url.pathname);
      if (match && req.method === 'DELETE') { deleted.push(match[1]); traces.delete(match[1]); return json(200, { message: 'deleted' }); }
      if (match && mode === 'legacy') return traces.has(match[1]) ? json(200, traces.get(match[1])) : json(404, {});
      json(404, {});
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { TRACE_TO_LANGFUSE: 'true', LANGFUSE_PUBLIC_KEY: 'pk-lf-test', LANGFUSE_SECRET_KEY: 'sk-lf-test',
    LANGFUSE_BASE_URL: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, CODING_AGENT_OTLP_ENABLED: 'false' };
  return { config: loadConfig('claude', env), traces, deleted };
}

for (const mode of ['v2', 'legacy'] as const) {
  test(`selftest passes against a server that offers the ${mode} read API, and cleans up`, async (t) => {
    const before = { home: process.env.CLAUDE_CONFIG_DIR, transport: process.env.LANGFUSE_HOOK_TRANSPORT };
    const { config, traces, deleted } = await fakeLangfuse(t, mode);
    const report = await selfTest(config, { keep: false, waitMs: 5000 });
    assert.deepEqual(report.checks.filter(item => !item.ok), [], 'every check passes');
    assert.equal(report.ok, true);
    assert.equal(report.readApi, mode);
    assert.ok(report.passed >= 15);
    assert.deepEqual(deleted.sort(), [report.traces.turn, report.traces.subagent].sort(), 'both synthetic traces are deleted');
    assert.equal(traces.size, 0);
    assert.equal(report.deleted, true);
    assert.deepEqual({ home: process.env.CLAUDE_CONFIG_DIR, transport: process.env.LANGFUSE_HOOK_TRANSPORT }, before, 'the environment is restored');
  });
}

test('selftest fails when the server stores something else, and --keep leaves the traces', async (t) => {
  // A server that drops usage on sub-agent model calls.
  const { config, traces, deleted } = await fakeLangfuse(t, 'legacy', (observation) => {
    if (observation.name?.includes('small')) observation.usageDetails = {};
  });
  const report = await selfTest(config, { keep: true, waitMs: 3000 });
  assert.equal(report.ok, false);
  assert.ok(report.checks.some(item => !item.ok && /turn tokens/.test(item.check)), 'the token check reports the difference');
  assert.equal(deleted.length, 0);
  assert.equal(traces.size, 2, 'kept for inspection');
});
