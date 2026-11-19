import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agentHome, defaultUserId, loadConfig, sharedConfigDir } from '../ts/src/core/config.ts';
import { applyPlan, deployPackage, installRoot, planAntigravityInstall, planCopilotInstall, planInstall } from '../ts/src/install.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const options = parseArgs({ options: {
  name: { type: 'string' }, device: { type: 'string' }, environment: { type: 'string' },
  agents: { type: 'string', default: 'claude,codex,omp,antigravity,copilot,opencode' },
  collector: { type: 'string' }, tempo: { type: 'string' }, python: { type: 'string' },
  'capture-content': { type: 'boolean' }, help: { type: 'boolean' },
} }).values;

if (options.help) {
  console.log('Usage: setup [--name NAME] [--device LABEL] [--environment NAME] [--agents LIST]');
  console.log('       [--collector OTELCOL_BINARY] [--tempo OTLP_HTTP_TRACE_URL] [--capture-content] [--python PYTHON]');
  console.log('Agents: claude,codex,omp,antigravity,copilot,opencode,deepagents');
  process.exit(0);
}

const agents = options.agents.split(',').map(agent => agent.trim()).filter(Boolean);
const supported = new Set(['claude', 'codex', 'omp', 'antigravity', 'copilot', 'opencode', 'deepagents']);
if (agents.some(agent => !supported.has(agent))) throw Error('Unknown agent in --agents list');
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
let lines = existsSync(configPath) ? readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/) : [];
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
if (options.collector) {
  if (!existing.publicKey || !existing.secretKey) throw Error('Set Langfuse project keys before installing the Collector relay');
  const directory = join(installRoot(), 'collector');
  const launcher = join(directory, 'start-collector.mjs');
  const executable = join(directory, process.platform === 'win32' ? 'otelcol.exe' : 'otelcol');
  mkdirSync(directory, { recursive: true });
  if (resolve(options.collector) !== resolve(executable)) copyFileSync(options.collector, executable);
  for (const file of ['collector.yaml', 'start-collector.mjs']) copyFileSync(join(repo, 'docs', 'examples', file), join(directory, file));
  set('CODING_AGENT_OTLP_TRACES_ENDPOINT', 'http://127.0.0.1:14318/v1/traces', false);
  set('CODING_AGENT_COLLECTOR_LAUNCHER', launcher, false);
  set('CODING_AGENT_NODE_EXECUTABLE', process.execPath, false);
}
writeFileSync(configPath, lines.join('\n') + '\n', { mode: 0o600 });

const apply = plan => {
  if (JSON.stringify(plan.before) !== JSON.stringify(plan.after)) applyPlan(plan);
  console.log(`${plan.agent}: ${plan.file}`);
};
const python = () => {
  const available = [options.python, 'python3', 'python'].filter(Boolean)
    .find(cmd => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0);
  if (!available) throw Error('An existing Python interpreter is required. Pass --python with its path.');
  return available;
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
    const home = agentHome('opencode');
    const directory = join(home, 'langfuse-venv');
    const venv = process.platform === 'win32' ? join(directory, 'Scripts', 'python.exe') : join(directory, 'bin', 'python');
    if (!existsSync(venv)) {
      execFileSync(python(), ['-m', 'venv', directory], { stdio: 'inherit' });
      execFileSync(venv, ['-m', 'pip', 'install', 'langfuse>=4,<5'], { stdio: 'inherit' });
    }
    for (const [sub, file] of [['plugins', 'langfuse_plugin.js'], ['hooks', 'langfuse_hook.py']]) {
      mkdirSync(join(home, sub), { recursive: true });
      copyFileSync(join(repo, 'tools', 'opencode', file), join(home, sub, file));
    }
    console.log('opencode: user plugin');
  }
  if (agent === 'deepagents') {
    execFileSync(python(), ['-m', 'pip', 'install', join(repo, 'tools', 'deepagents')], { stdio: 'inherit' });
    console.log('deepagents: attach DeepAgentsObserver to SDK invocations');
  }
}
if (agents.includes('codex')) console.log('Review newly registered hooks with Codex /hooks.');
console.log(`Trace user: ${name}`);
console.log(`Settings: ${configPath}`);
