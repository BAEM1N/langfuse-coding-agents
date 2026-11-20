import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, homedir, hostname, platform, release, arch, totalmem } from 'node:os';
import { basename, join } from 'node:path';
import type { TraceAgentName } from './types.ts';
import { loadOtlpConfig, type OtlpConfig } from './otlp.ts';
import { githubOptions, type GithubOptions } from './github.ts';

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
  /**
   * How turns reach Langfuse directly. `otlp` posts to /api/public/otel/v1/traces,
   * the route Langfuse supports. `legacy` posts to /api/public/ingestion, which
   * Langfuse has deprecated: Cloud no longer stores it and self-hosted v4 rejects
   * it by default. Unset is `auto`: OTLP, falling back to legacy only when the
   * server has no OTLP endpoint (self-hosted before v3.22).
   */
  langfuseTransport: 'legacy' | 'otlp' | 'auto';
  transportError?: string;
  /**
   * A turn with no end marker whose transcript has been idle this long is
   * treated as ended (interrupted, or the session was closed). 0 disables.
   */
  staleTurnMs: number;
  /** Read sub-agent transcripts and attach their work to the turn that started them. */
  subagents: boolean;
  /** Also send each sub-agent run as a trace of its own (without usage, to avoid double counting). */
  subagentTraces: boolean;
  /** False only when LANGFUSE_HOOK_CAPTURE_CONTENT=false; applies to the direct OTLP route. */
  langfuseCaptureContent: boolean;
  /** Declares that the generic OTLP endpoint is a Collector that also forwards to Langfuse. */
  otlpForwardsToLangfuse: boolean;
  /** Explicit opt-in to send one turn to the same Langfuse project over two routes. */
  allowDualLangfuse: boolean;
  otlp?: OtlpConfig;
  otlpError?: string;
  collectorLauncher?: string;
  nodeExecutable?: string;
  github?: GithubOptions;
}

export function agentHome(agent: TraceAgentName): string {
  if (agent === 'claude') return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  // The override exists for the self-test, which must not write into the real agent home.
  if (agent === 'antigravity') return process.env.LANGFUSE_HOOK_ANTIGRAVITY_HOME || join(homedir(), '.gemini', 'antigravity-cli');
  if (agent === 'omp') return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.omp', 'agent');
  if (agent === 'copilot') return process.env.COPILOT_HOME || join(homedir(), '.copilot');
  if (agent === 'opencode') return join(homedir(), '.config', 'opencode');
  if (agent === 'deepagents') return join(homedir(), '.config', 'deepagents-observability');
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function sharedConfigDir(): string {
  // The override keeps tests and trial installs away from the real settings.
  return process.env.LANGFUSE_AGENT_HOOKS_CONFIG_DIR || join(homedir(), '.config', 'langfuse-agent-hooks');
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
  const transport = (pick(env, 'LANGFUSE_HOOK_TRANSPORT') ?? 'auto').toLowerCase();
  const knownTransport = transport === 'legacy' || transport === 'otlp' || transport === 'auto';
  return {
    agent,
    agentHome: home,
    langfuseTransport: transport === 'otlp' || transport === 'legacy' ? transport : 'auto',
    transportError: knownTransport ? undefined : 'LANGFUSE_HOOK_TRANSPORT must be auto, otlp or legacy',
    subagents: (pick(env, 'CODING_AGENT_SUBAGENTS') ?? '').toLowerCase() !== 'false',
    subagentTraces: (pick(env, 'CODING_AGENT_SUBAGENT_TRACES') ?? '').toLowerCase() !== 'false',
    staleTurnMs: (() => {
      const minutes = Number(pick(env, 'LANGFUSE_HOOK_STALE_TURN_MINUTES') ?? '60');
      return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : 60 * 60_000;
    })(),
    langfuseCaptureContent: (pick(env, 'LANGFUSE_HOOK_CAPTURE_CONTENT') ?? '').toLowerCase() !== 'false',
    otlpForwardsToLangfuse: (pick(env, 'CODING_AGENT_OTLP_FORWARDS_TO_LANGFUSE') ?? '').toLowerCase() === 'true',
    allowDualLangfuse: (pick(env, 'LANGFUSE_HOOK_ALLOW_DUAL_ROUTE') ?? '').toLowerCase() === 'true',
    otlp,
    otlpError,
    collectorLauncher: env.CODING_AGENT_COLLECTOR_LAUNCHER,
    nodeExecutable: env.CODING_AGENT_NODE_EXECUTABLE,
    github: githubOptions(env),
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
