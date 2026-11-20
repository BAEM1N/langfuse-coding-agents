// Runs the example Collector configuration against mock backends on loopback.
// Needs an OpenTelemetry Collector binary with the otlp, file, resource and
// otlp_http components: set CODING_AGENT_TEST_OTELCOL to its path. Without it
// the test is skipped, and reported as skipped.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const binary = process.env.CODING_AGENT_TEST_OTELCOL;
const config = fileURLToPath(new URL('../../docs/examples/collector.yaml', import.meta.url));

async function backend(t: TestContext) {
  const requests: Array<{ path: string; headers: IncomingHttpHeaders; bytes: number; text: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw; // the exporter compresses by default
      requests.push({ path: req.url ?? '', headers: req.headers, bytes: body.length, text: body.toString('latin1') });
      res.writeHead(200, { 'Content-Type': req.headers['content-type'] ?? 'application/json' });
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, requests };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const payload = (marker: string) => ({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: marker } }] },
  scopeSpans: [{ scope: { name: 'collector-test' }, spans: [{ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331',
    name: marker, kind: 1, startTimeUnixNano: '1794146894000000000', endTimeUnixNano: '1794146895000000000' }] }] }] });

async function post(port: number, marker: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload(marker)) });
  return res.status;
}

async function until(check: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(100);
  }
  return check();
}

test('example Collector: 14318 route skips Langfuse, the both route reaches Langfuse and Tempo with separate headers',
  { skip: !binary || !existsSync(binary) ? 'set CODING_AGENT_TEST_OTELCOL to an otelcol binary' : false }, async (t) => {
    const langfuse = await backend(t);
    const tempo = await backend(t);
    const [local, both, goose] = [await freePort(), await freePort(), await freePort()];
    const dir = mkdtempSync(join(tmpdir(), 'lah-collector-'));
    const child = spawn(binary!, ['--config', config], { stdio: 'ignore', windowsHide: true, env: { ...process.env,
      CODING_AGENT_COLLECTOR_LOCAL_PORT: String(local), CODING_AGENT_COLLECTOR_BOTH_PORT: String(both),
      CODING_AGENT_COLLECTOR_GOOSE_PORT: String(goose), CODING_AGENT_OTLP_FILE: join(dir, 'traces.ndjson'),
      CODING_AGENT_LANGFUSE_OTLP_URL: langfuse.url + '/api/public/otel/v1/traces', CODING_AGENT_LANGFUSE_AUTH: 'Basic dGVzdDp0ZXN0',
      CODING_AGENT_TEMPO_TRACES_URL: tempo.url + '/v1/traces', CODING_AGENT_COLLECTOR_USER: 'collector-user',
      CODING_AGENT_COLLECTOR_OS: 'test-os', CODING_AGENT_COLLECTOR_OS_VERSION: '1', CODING_AGENT_COLLECTOR_ARCH: 'test-arch',
      CODING_AGENT_COLLECTOR_ENVIRONMENT: 'test' } });
    t.after(async () => {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
      rmSync(dir, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 });
    });
    let ready = false;
    for (let attempt = 0; attempt < 80 && !ready; attempt++) {
      try { ready = (await post(local, 'warmup')) === 200; } catch { await wait(100); }
    }
    assert.ok(ready, 'Collector did not start with the example configuration');
    assert.ok(await until(() => tempo.requests.length === 1));
    langfuse.requests.length = 0;
    tempo.requests.length = 0;

    // 14318 route: file and Tempo only.
    assert.equal(await post(local, 'route-local'), 200);
    assert.ok(await until(() => tempo.requests.some(request => request.text.includes('route-local'))));
    await wait(700);
    assert.equal(langfuse.requests.length, 0, 'the 14318 route must not reach Langfuse');

    // Both route: Langfuse with its headers, Tempo without them.
    assert.equal(await post(both, 'route-both'), 200);
    assert.ok(await until(() => langfuse.requests.some(request => request.text.includes('route-both'))
      && tempo.requests.some(request => request.text.includes('route-both'))), 'both backends receive the span');
    const toLangfuse = langfuse.requests.find(request => request.text.includes('route-both'))!;
    assert.equal(toLangfuse.path, '/api/public/otel/v1/traces');
    assert.equal(toLangfuse.headers.authorization, 'Basic dGVzdDp0ZXN0');
    assert.equal(toLangfuse.headers['x-langfuse-ingestion-version'], '4');
    assert.ok(!toLangfuse.text.includes('collector-user'), 'the Goose resource processor stays off shared-hook spans');
    for (const request of tempo.requests) {
      assert.equal(request.headers.authorization, undefined, 'no Langfuse credentials on the Tempo exporter');
      assert.equal(request.headers['x-langfuse-ingestion-version'], undefined);
    }

    // Goose route: unchanged exporter (no version header), local user added.
    assert.equal(await post(goose, 'route-goose'), 200);
    assert.ok(await until(() => langfuse.requests.some(request => request.text.includes('route-goose'))));
    const fromGoose = langfuse.requests.find(request => request.text.includes('route-goose'))!;
    assert.equal(fromGoose.headers['x-langfuse-ingestion-version'], undefined);
    assert.ok(fromGoose.text.includes('collector-user'));
  });
