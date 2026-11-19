import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, homedir, hostname, platform, release, arch, totalmem } from 'node:os';
import { basename, join } from 'node:path';
import type { TraceAgentName } from './types.ts';
import { loadOtlpConfig, type OtlpConfig } from './otlp.ts';

export interface Config {
  agent: TraceAgentName;
  agentHome: string;
  enabled: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl: string;
  userId: string;
  hostname: string;
  device?: Record<string, string | number>;
  environment?: string;
  maxChars: number;
  redact: boolean;
  debug: boolean;
  timeoutMs: number;
  otlp?: OtlpConfig;
  otlpError?: string;
  collectorLauncher?: string;
  nodeExecutable?: string;
}

export function agentHome(agent: TraceAgentName): string {
  if (agent === 'claude') return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  if (agent === 'antigravity') return join(homedir(), '.gemini', 'antigravity-cli');
  if (agent === 'omp') return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.omp', 'agent');
  if (agent === 'copilot') return process.env.COPILOT_HOME || join(homedir(), '.copilot');
  if (agent === 'opencode') return join(homedir(), '.config', 'opencode');
  if (agent === 'deepagents') return join(homedir(), '.config', 'deepagents-observability');
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function sharedConfigDir(): string {
  return join(homedir(), '.config', 'langfuse-agent-hooks');
}

export function defaultUserId(): string {
  return basename(homedir()) || 'local-user';
}

export function deviceAttributes(env: NodeJS.ProcessEnv, host: string): Config['device'] {
  if (env.CODING_AGENT_DEVICE_METADATA === 'false') return;
  const attrs: NonNullable<Config['device']> = { 'host.name': host, 'os.type': platform(), 'os.version': release(),
    'host.arch': arch(), 'host.cpu.logical_count': availableParallelism(), 'host.memory.bytes': totalmem() };
  if (env.CODING_AGENT_DEVICE_LABEL) attrs['coding_agent.device.label'] = env.CODING_AGENT_DEVICE_LABEL;
  return attrs;
}

/** Minimal .env parser. Never overrides variables already set in the environment. */
export function loadDotenv(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '');
    }
    if (env[m[1]] === undefined) env[m[1]] = val;
  }
}

function pick(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/**
 * Priority: process env (incl. Claude settings.json `env`) > <agent home>/.env >
 * ~/.config/langfuse-agent-hooks/.env. The agent .env files are shared with the
 * Python hooks, so both implementations read the same credentials.
 */
export function loadConfig(agent: TraceAgentName, env: NodeJS.ProcessEnv = process.env): Config {
  const home = agentHome(agent);
  loadDotenv(join(home, '.env'), env);
  loadDotenv(join(sharedConfigDir(), '.env'), env);

  const maxChars = Number.parseInt(pick(env, 'LANGFUSE_HOOK_MAX_CHARS', 'CC_LANGFUSE_MAX_CHARS') ?? '20000', 10);
  let otlp: OtlpConfig | undefined;
  let otlpError: string | undefined;
  try { otlp = loadOtlpConfig(env); } catch { otlpError = 'Invalid OTLP endpoint, protocol, or headers'; }
  const host = pick(env, 'CC_LANGFUSE_HOSTNAME', 'LANGFUSE_HOOK_HOSTNAME') ?? hostname();
  return {
    agent,
    agentHome: home,
    otlp,
    otlpError,
    collectorLauncher: env.CODING_AGENT_COLLECTOR_LAUNCHER,
    nodeExecutable: env.CODING_AGENT_NODE_EXECUTABLE,
    enabled: (pick(env, 'TRACE_TO_LANGFUSE') ?? '').toLowerCase() === 'true',
    publicKey: pick(env, 'CC_LANGFUSE_PUBLIC_KEY', 'LANGFUSE_PUBLIC_KEY'),
    secretKey: pick(env, 'CC_LANGFUSE_SECRET_KEY', 'LANGFUSE_SECRET_KEY'),
    baseUrl: (pick(env, 'CC_LANGFUSE_BASE_URL', 'LANGFUSE_BASE_URL', 'LANGFUSE_HOST') ?? 'https://cloud.langfuse.com').replace(/\/+$/, ''),
    userId: pick(env, 'CC_LANGFUSE_USER_ID', 'CODING_AGENT_USER_NAME', 'LANGFUSE_USER_ID') ?? defaultUserId(),
    hostname: host,
    device: deviceAttributes(env, host),
    environment: pick(env, 'LANGFUSE_TRACING_ENVIRONMENT'),
    maxChars: Number.isFinite(maxChars) ? maxChars : 20000,
    redact: (pick(env, 'LANGFUSE_HOOK_REDACT') ?? 'true').toLowerCase() !== 'false',
    debug: ['true', '1'].includes((pick(env, 'LANGFUSE_HOOK_DEBUG', 'CC_LANGFUSE_DEBUG') ?? '').toLowerCase()),
    timeoutMs: Number.parseInt(pick(env, 'LANGFUSE_HOOK_TIMEOUT_MS') ?? '15000', 10) || 15000,
  };
}
