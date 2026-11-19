// Place beside otelcol[.exe] and collector.yaml under the deployed hook runtime.
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const reachable = () => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port: 14320 });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.setTimeout(300, () => { socket.destroy(); resolve(false); });
});
if (await reachable()) process.exit(0);

const config = loadConfig('claude', { ...process.env });
if (!config.publicKey || !config.secretKey) throw Error('Collector requires Langfuse project keys');
const log = openSync(join(directory, 'collector.log'), 'a');
try {
  const executable = process.platform === 'win32' ? 'otelcol.exe' : 'otelcol';
  const child = spawn(join(directory, executable), ['--config', join(directory, 'collector.yaml')], {
    detached: true, windowsHide: true, stdio: ['ignore', log, log],
    env: { ...process.env, CODING_AGENT_OTLP_FILE: join(directory, 'traces.ndjson'),
      CODING_AGENT_LANGFUSE_OTLP_URL: config.baseUrl + '/api/public/otel/v1/traces',
      CODING_AGENT_LANGFUSE_AUTH: 'Basic ' + Buffer.from(config.publicKey + ':' + config.secretKey).toString('base64') },
  });
  child.once('error', () => { process.exitCode = 1; });
  child.unref();
} finally { closeSync(log); }

for (let attempt = 0; attempt < 25; attempt++) {
  if (await reachable()) process.exit(0);
  await new Promise(resolve => setTimeout(resolve, 100));
}
process.exitCode = 1;
