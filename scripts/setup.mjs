import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agentHome, defaultUserId, loadConfig, sharedConfigDir } from '../ts/src/core/config.ts';
import { isLangfuseCloud, resolveDestinations } from '../ts/src/core/destinations.ts';
import { applyPlan, deployPackage, installRoot, planAntigravityInstall, planCopilotInstall, planInstall } from '../ts/src/install.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const options = parseArgs({ options: {
  name: { type: 'string' }, device: { type: 'string' }, environment: { type: 'string' },
  agents: { type: 'string', default: 'claude,codex,omp,antigravity,copilot,opencode' },
  collector: { type: 'string' }, tempo: { type: 'string' }, python: { type: 'string' },
  'capture-content': { type: 'boolean' }, help: { type: 'boolean' },
  'langfuse-transport': { type: 'string' }, 'collector-route': { type: 'string' },
} }).values;

if (options.help) {
  console.log('Usage: setup [--name NAME] [--device LABEL] [--environment NAME] [--agents LIST]');
  console.log('       [--langfuse-transport auto|otlp|legacy]');
  console.log('       [--collector OTELCOL_BINARY] [--collector-route tempo|both] [--tempo OTLP_HTTP_TRACE_URL]');
  console.log('       [--capture-content] [--python PYTHON]');
  console.log('Agents: claude,codex,omp,antigravity,copilot,opencode,deepagents');
  console.log('--langfuse-transport  auto (default when unset): OTLP, the route Langfuse supports, with legacy ingestion only for a');
  console.log('                      server that has no OTLP endpoint. otlp: OTLP only. legacy: deprecated ingestion API only.');
  console.log('--collector-route     tempo: hooks send Langfuse directly, Collector feeds Tempo (default).');
  console.log('                      both: hooks send only to the Collector, which feeds Langfuse and Tempo.');
  process.exit(0);
}
if (options['langfuse-transport'] && !['auto', 'otlp', 'legacy'].includes(options['langfuse-transport'])) {
  throw Error('--langfuse-transport must be auto, otlp or legacy');
}
if (options['collector-route'] && !['tempo', 'both'].includes(options['collector-route'])) {
  throw Error('--collector-route must be tempo or both');
}
if (options['collector-route'] && !options.collector) throw Error('--collector-route needs --collector');

const agents = options.agents.split(',').map(agent => agent.trim()).filter(Boolean);
const supported = new Set(['claude', 'codex', 'omp', 'antigravity', 'copilot', 'opencode', 'deepagents']);
if (agents.some(agent => !supported.has(agent))) throw Error('Unknown agent in --agents list');

const usablePython = (cmd, check) => spawnSync(cmd, ['-c', check], { stdio: 'ignore' }).status === 0;
const versionCheck = 'import sys; raise SystemExit(sys.version_info < (3, 10))';
const selectPython = (needVenv = false) => {
  const candidates = options.python ? [options.python] : ['python3', 'python'];
  const check = (needVenv ? 'import venv, ensurepip; ' : 'import pip; ') + versionCheck;
  const available = candidates.find(cmd => usablePython(cmd, check));
  if (!available) {
    throw Error(`Python 3.10+ ${needVenv ? 'with venv and ensurepip' : 'with pip'} is required. Pass --python with its path.`);
  }
  return available;
};

const opencodeHome = agents.includes('opencode') ? agentHome('opencode') : undefined;
const venvDirectory = opencodeHome && join(opencodeHome, 'langfuse-venv');
const venvPython = venvDirectory && (process.platform === 'win32'
  ? join(venvDirectory, 'Scripts', 'python.exe') : join(venvDirectory, 'bin', 'python'));
const recreateVenv = venvPython && !usablePython(venvPython, versionCheck);
const venvSource = recreateVenv ? selectPython(true) : undefined;
const deepAgentsPython = agents.includes('deepagents') ? selectPython() : undefined;

let name = options.name?.trim();
if (name === undefined && process.stdin.isTTY) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { name = (await prompt.question(`Trace user name [${defaultUserId()}]: `)).trim(); }
  finally { prompt.close(); }
}
name ||= defaultUserId();

const deployedCli = deployPackage();
const configDirectory = sharedConfigDir();
const configPath = join(configDirectory, '.env');
mkdirSync(configDirectory, { recursive: true });
const before = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
let lines = before !== undefined ? before.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/) : [];
const set = (key, value, replace = true) => {
  if (value === undefined) return;
  if (/[\r\n\0]/.test(value)) throw Error(`${key} requires a single-line value`);
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  if (!replace && lines.some(line => matcher.test(line))) return;
  const quote = value.includes('"') ? "'" : '"';
  lines = lines.filter(line => !matcher.test(line));
  lines.push(`${key}=${quote}${value}${quote}`);
};
const existing = loadConfig('claude', { ...process.env });
set('CODING_AGENT_USER_NAME', name);
set('CODING_AGENT_DEVICE_LABEL', options.device);
set('LANGFUSE_TRACING_ENVIRONMENT', options.environment);
set('LANGFUSE_PUBLIC_KEY', existing.publicKey, false);
set('LANGFUSE_SECRET_KEY', existing.secretKey, false);
set('LANGFUSE_BASE_URL', existing.baseUrl, false);
if (existing.publicKey && existing.secretKey) set('TRACE_TO_LANGFUSE', 'true', false);
if (options['capture-content']) {
  set('LANGFUSE_HOOK_CAPTURE_CONTENT', 'true');
  set('OTEL_CAPTURE_CONTENT', 'true');
}
set('CODING_AGENT_TEMPO_TRACES_URL', options.tempo);
// Written only when asked. Unset means auto: OTLP, with legacy ingestion as a fallback for old servers.
set('LANGFUSE_HOOK_TRANSPORT', options['langfuse-transport']);
if (options.collector) {
  if (!existing.publicKey || !existing.secretKey) throw Error('Set Langfuse project keys before installing the Collector relay');
  const directory = join(installRoot(), 'collector');
  const launcher = join(directory, 'start-collector.mjs');
  const executable = join(directory, process.platform === 'win32' ? 'otelcol.exe' : 'otelcol');
  mkdirSync(directory, { recursive: true });
  if (resolve(options.collector) !== resolve(executable)) copyFileSync(options.collector, executable);
  for (const file of ['collector.yaml', 'start-collector.mjs']) copyFileSync(join(repo, 'docs', 'examples', file), join(directory, file));
  if (options['collector-route'] === 'both') {
    // One route per project: the Collector forwards to Langfuse, so the hooks stop sending to it directly.
    set('CODING_AGENT_OTLP_TRACES_ENDPOINT', 'http://127.0.0.1:14319/v1/traces');
    set('CODING_AGENT_OTLP_FORWARDS_TO_LANGFUSE', 'true');
    set('TRACE_TO_LANGFUSE', 'false');
  } else if (options['collector-route'] === 'tempo') {
    set('CODING_AGENT_OTLP_TRACES_ENDPOINT', 'http://127.0.0.1:14318/v1/traces');
    set('CODING_AGENT_OTLP_FORWARDS_TO_LANGFUSE', 'false');
    if (existing.publicKey && existing.secretKey) set('TRACE_TO_LANGFUSE', 'true');
  } else {
    set('CODING_AGENT_OTLP_TRACES_ENDPOINT', 'http://127.0.0.1:14318/v1/traces', false);
  }
  set('CODING_AGENT_COLLECTOR_LAUNCHER', launcher, false);
  set('CODING_AGENT_NODE_EXECUTABLE', process.execPath, false);
  // The launcher leaves a running Collector alone, and an older one has no 14319 receiver.
  console.log('Collector configuration updated. Restart the Collector if one is already running.');
}
const after = lines.join('\n') + '\n';
if (before !== undefined && before !== after) {
  // Restore this file to undo a transport or route change.
  const backup = `${configPath}.bak-${new Date().toISOString().replace(/\D/g, '').slice(0, 17)}`;
  writeFileSync(backup, before, { mode: 0o600 });
  console.log(`Previous settings saved to ${backup}`);
}
writeFileSync(configPath, after, { mode: 0o600 });

const apply = plan => {
  if (JSON.stringify(plan.before) !== JSON.stringify(plan.after)) applyPlan(plan);
  console.log(`${plan.agent}: ${plan.file}`);
};
for (const agent of new Set(agents)) {
  if (agent === 'claude' || agent === 'codex') apply(planInstall(agent, deployedCli));
  if (agent === 'antigravity') apply(planAntigravityInstall(deployedCli));
  if (agent === 'copilot') apply(planCopilotInstall(deployedCli));
  if (agent === 'omp') {
    const home = agentHome('omp');
    const settings = join(home, 'config.yml');
    const source = join(installRoot(), 'src', 'omp-extension.ts').replaceAll('\\', '/');
    if (!existsSync(settings) || !readFileSync(settings, 'utf8').replaceAll('\\', '/').includes(source)) {
      const destination = join(home, 'extensions', 'langfuse-agent-hooks');
      cpSync(join(installRoot(), 'src'), destination, { recursive: true });
      copyFileSync(join(destination, 'omp-extension.ts'), join(destination, 'index.ts'));
    }
    console.log('omp: user extension');
  }
  if (agent === 'opencode') {
    if (recreateVenv) {
      if (existsSync(venvDirectory)) {
        const backup = venvDirectory + '.bak-' + Date.now();
        renameSync(venvDirectory, backup);
        console.log(`Backed up the previous OpenCode virtual environment to ${backup}`);
      }
      execFileSync(venvSource, ['-m', 'venv', venvDirectory], { stdio: 'inherit' });
    }
    if (!usablePython(venvPython, 'import langfuse')) {
      execFileSync(venvPython, ['-m', 'pip', 'install', 'langfuse>=4.7'], { stdio: 'inherit' });
    }
    for (const [sub, file] of [['plugins', 'langfuse_plugin.js'], ['hooks', 'langfuse_hook.py']]) {
      mkdirSync(join(opencodeHome, sub), { recursive: true });
      copyFileSync(join(repo, 'tools', 'opencode', file), join(opencodeHome, sub, file));
    }
    console.log('opencode: user plugin');
  }
  if (agent === 'deepagents') {
    execFileSync(deepAgentsPython, ['-m', 'pip', 'install', join(repo, 'tools', 'deepagents')], { stdio: 'inherit' });
    console.log('deepagents: attach DeepAgentsObserver to SDK invocations');
  }
}
if (agents.includes('codex')) console.log('Review newly registered hooks with Codex /hooks.');
console.log(`Trace user: ${name}`);
console.log(`Settings: ${configPath}`);
const final = loadConfig('claude', { ...process.env });
for (const destination of resolveDestinations(final)) {
  console.log(`Destination: ${destination.label}${destination.configError ? ` - CONFIG ERROR: ${destination.configError}` : ''}`);
  if (destination.kind === 'langfuse-legacy') {
    console.log(isLangfuseCloud(final.baseUrl)
      ? '  Langfuse Cloud retired legacy trace ingestion on 2026-11-16, so these turns are not stored.'
      : '  Legacy ingestion is deprecated by Langfuse; self-hosted v4 rejects it outside the legacy and dual write modes.');
    console.log('  Re-run with --langfuse-transport auto to use OTLP.');
  }
}
console.log('Installing hooks does not show that traces are stored. Run one turn, then `doctor` and `verify <agent> <traceId>`.');
