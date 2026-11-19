import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({ options: {
  tempo: { type: 'string' }, grafana: { type: 'string' }, data: { type: 'string' },
  'anonymous-viewer': { type: 'boolean' },
} });
if (!options.tempo || !options.grafana) throw Error('Pass --tempo PATH and --grafana GRAFANA_HOME');
const examples = join(dirname(dirname(fileURLToPath(import.meta.url))), 'docs', 'examples', 'grafana');
const data = resolve(options.data || join(homedir(), '.local', 'share', 'coding-agent-grafana'));
const grafana = resolve(options.grafana);
const exe = process.platform === 'win32' ? '.exe' : '';
const grafanaExe = join(grafana, 'bin', 'grafana' + exe);
const tempoExe = resolve(options.tempo);
for (const path of [grafanaExe, tempoExe]) if (!existsSync(path)) throw Error(`Binary not found: ${path}`);
for (const directory of [data, join(data, 'grafana-data'), join(data, 'grafana-logs')]) mkdirSync(directory, { recursive: true });

async function isListening(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(500) }); return true; }
  catch { return false; }
}

function start(name, command, args, env) {
  const log = openSync(join(data, name + '.log'), 'a');
  try {
    const child = spawn(command, args, { cwd: data, env, windowsHide: true, detached: true, stdio: ['ignore', log, log] });
    child.once('error', error => { console.error(`${name}: ${error.message}`); process.exitCode = 1; });
    child.unref();
  } finally { closeSync(log); }
}

if (!(await isListening('http://127.0.0.1:13200/ready'))) {
  start('tempo', tempoExe, ['-config.file=' + join(examples, 'tempo.yaml')], process.env);
}
if (!(await isListening('http://127.0.0.1:13000/api/health'))) {
  start('grafana', grafanaExe, ['server', '--homepath', grafana], {
    ...process.env, GF_SERVER_HTTP_ADDR: '127.0.0.1', GF_SERVER_HTTP_PORT: '13000',
    GF_PATHS_DATA: join(data, 'grafana-data'), GF_PATHS_LOGS: join(data, 'grafana-logs'),
    GF_PATHS_PROVISIONING: join(examples, 'provisioning'), CODING_AGENT_GRAFANA_DASHBOARDS: join(examples, 'dashboards'),
    GF_AUTH_ANONYMOUS_ENABLED: String(options['anonymous-viewer'] === true), GF_AUTH_ANONYMOUS_ORG_ROLE: 'Viewer',
    GF_ANALYTICS_REPORTING_ENABLED: 'false', GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
    GF_PLUGINS_PREINSTALL_DISABLED: 'true',
  });
}
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  if (await isListening('http://127.0.0.1:13000/api/health') && await isListening('http://127.0.0.1:13200/api/echo')) {
    console.log('http://127.0.0.1:13000/d/coding-agent-traces/coding-agent-traces');
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 400));
}
console.error(`Grafana failed to start. See ${join(data, 'grafana.log')}`);
process.exitCode = 1;
