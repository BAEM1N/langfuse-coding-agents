#!/usr/bin/env node
// langfuse-agent-hooks — zero-dependency Langfuse tracing for AI coding agents.
//
//   node src/cli.ts hook <claude|codex>          (called by the agent; reads JSON on stdin)
//   node src/cli.ts install [claude|codex|antigravity|copilot|all] [--dry-run]
//   node src/cli.ts uninstall [claude|codex|antigravity|all]
//   node src/cli.ts doctor [claude|codex]
//   node src/cli.ts audit <claude|codex|omp|antigravity> <transcript.jsonl>
//   node src/cli.ts audit-langfuse [claude|codex] [--limit N]
//   node src/cli.ts backfill <claude|codex> <transcript.jsonl> [--session ID] [--dry-run]

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from './core/config.ts';
import { auditLangfuse, summarizeTurns } from './core/audit.ts';
import { parseOmpSession } from './adapters/omp.ts';
import { parseCopilotTurn } from './adapters/copilot.ts';
import { runAntigravityHook } from './core/antigravity-hook.ts';
import { auditAntigravity } from './adapters/antigravity.ts';
import { readJsonlFrom } from './core/jsonl.ts';
import { batchOptions, logPath, normalizePayload, parseTranscript, runHook } from './core/run.ts';
import { turnToEvents } from './core/batch.ts';
import { LangfuseClient } from './core/langfuse.ts';
import { createLogger } from './core/log.ts';
import { exportOtlp, loadOtlpConfig } from './core/otlp.ts';
import { canExport, exportEvents } from './core/export.ts';
import { applyPlan, deployPackage, HOOK_EVENTS, planAntigravityInstall, planCopilotInstall, planInstall } from './install.ts';
import type { Turn } from './core/types.ts';
import type { AgentName } from './core/types.ts';

const AGENTS: AgentName[] = ['claude', 'codex'];

function agentsArg(v: string | undefined): AgentName[] {
  if (!v || v === 'all') return AGENTS;
  if (AGENTS.includes(v as AgentName)) return [v as AgentName];
  throw new Error(`unknown agent: ${v} (expected claude, codex or all)`);
}

function flag(args: string[], name: string): string | true | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

async function readStdin(timeoutMs = 3000): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), timeoutMs);
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

async function cmdHook(agent: AgentName): Promise<void> {
  // Fail open: tracing must never break or slow down the agent. No stdout output.
  const cfg = loadConfig(agent);
  const log = createLogger(logPath(cfg), cfg.debug);
  try {
    const text = (await readStdin()).replace(/^﻿/, '').trim();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const r = await runHook(agent, payload, log);
    if (r.skipped) log.debug(`skipped: ${r.skipped}`);
  } catch (e) {
    log.error(`hook failed: ${(e as Error).stack ?? e}`);
  }
}

function cmdInstall(target: string | undefined, dryRun: boolean, remove: boolean): void {
  const cli = dryRun ? '<install-root>/src/cli.ts' : deployPackage();
  if (target === 'copilot' && !remove) {
    const plan = planCopilotInstall(cli, process.execPath);
    if (dryRun) console.log(JSON.stringify(plan.after, null, 2));
    else applyPlan(plan);
    console.log(`[copilot] ${plan.file}`);
    return;
  }
  if (target === 'antigravity') {
    const plan = planAntigravityInstall(cli, process.execPath, remove);
    if (dryRun) console.log(JSON.stringify(plan.after, null, 2));
    else applyPlan(plan);
    console.log(`[antigravity] ${plan.file}`);
    return;
  }
  for (const agent of agentsArg(target)) {
    const plan = planInstall(agent, cli, process.execPath, remove);
    const events = remove ? '(removed)' : HOOK_EVENTS[agent].join(', ');
    console.log(`\n[${agent}] ${plan.file}\n  events: ${events}`);
    if (dryRun) {
      console.log(JSON.stringify((plan.after as any).hooks ?? {}, null, 2));
      continue;
    }
    applyPlan(plan);
    console.log('  written (previous file backed up as *.bak-<timestamp>)');
    if (agent === 'codex' && !remove) {
      console.log('  NOTE: Codex requires trusting new hooks once: run `codex`, type /hooks, approve the entries.');
    }
  }
  if (!dryRun && !remove) console.log(`\nInstalled hook runtime: ${cli}`);
}

async function cmdDoctor(target: string | undefined): Promise<void> {
  console.log(`node ${process.version} (${process.execPath})`);
  for (const agent of agentsArg(target)) {
    const cfg = loadConfig(agent, { ...process.env });
    const mask = (s?: string) => (s ? `${s.slice(0, 10)}…${s.slice(-4)}` : '(missing)');
    console.log(`\n[${agent}] home=${cfg.agentHome}`);
    console.log(`  enabled=${cfg.enabled} url=${cfg.baseUrl} user=${cfg.userId} redact=${cfg.redact} maxChars=${cfg.maxChars}`);
    console.log(`  publicKey=${mask(cfg.publicKey)} secretKey=${cfg.secretKey ? '(set)' : '(missing)'}`);
    if (cfg.publicKey && cfg.secretKey) {
      const client = new LangfuseClient({ baseUrl: cfg.baseUrl, publicKey: cfg.publicKey, secretKey: cfg.secretKey, timeoutMs: cfg.timeoutMs, logger: createLogger(logPath(cfg), false) });
      const a = await client.authCheck();
      console.log(`  auth: ${a.ok ? 'OK' : 'FAILED'} (${a.message})`);
    }
    const plan = planInstall(agent, '', process.execPath);
    const hooks = (plan.before as any).hooks ?? {};
    const registered = Object.entries(hooks)
      .filter(([, list]) => JSON.stringify(list).includes('langfuse-agent-hooks'))
      .map(([ev]) => ev);
    const legacy = Object.entries(hooks)
      .filter(([, list]) => JSON.stringify(list).includes('langfuse_hook'))
      .map(([ev]) => ev);
    console.log(`  registered (ts): ${registered.join(', ') || '(none)'}${legacy.length ? `  | legacy python: ${legacy.join(', ')}` : ''}`);
    const lp = logPath(cfg);
    if (existsSync(lp)) {
      const tail = readFileSync(lp, 'utf8').trimEnd().split('\n').slice(-3);
      console.log(`  log (${lp}):\n    ${tail.join('\n    ')}`);
    }
  }
}

async function cmdBackfill(agent: AgentName, path: string, args: string[]): Promise<void> {
  if (!path || !existsSync(path)) throw new Error(`transcript not found: ${path}`);
  const cfg = loadConfig(agent);
  const session = typeof flag(args, 'session') === 'string' ? (flag(args, 'session') as string) : basename(path, '.jsonl').replace(/^rollout-[\dT-]+-/, '');
  const { turns } = parseTranscript(agent, path, session, { offset: 0, turnsBefore: 0 });
  const events = turns.flatMap((t) => turnToEvents(t, batchOptions(cfg)));
  console.log(`session=${session} turns=${turns.length} events=${events.length}`);
  for (const t of turns.slice(0, 50)) {
    const gens = t.steps.filter((s) => s.kind === 'generation').length;
    const tools = t.steps.length - gens;
    const input = typeof t.input === 'string' ? t.input.replace(/\s+/g, ' ').slice(0, 60) : '';
    console.log(`  #${t.index} ${t.complete ? 'done' : 'open'} gens=${gens} tools=${tools} events=${t.events.length}  ${input}`);
  }
  if (flag(args, 'dry-run')) return;
  if (!cfg.publicKey || !cfg.secretKey) throw new Error('missing Langfuse keys');
  const client = new LangfuseClient({ baseUrl: cfg.baseUrl, publicKey: cfg.publicKey, secretKey: cfg.secretKey, timeoutMs: 60000, logger: createLogger(logPath(cfg), cfg.debug) });
  const res = await client.ingest(events);
  console.log(res.ok ? `sent ${res.sent} events` : `errors: ${JSON.stringify(res.errors.slice(0, 5))}`);
}

function cmdAudit(agent: string | undefined, path: string | undefined, args: string[]): void {
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'omp' && agent !== 'antigravity') throw new Error('audit expects claude, codex, omp, or antigravity');
  if (!path || !existsSync(path)) throw new Error('audit expects an existing transcript path');
  if (agent === 'antigravity') {
    console.log(JSON.stringify({ agent, ...auditAntigravity(readJsonlFrom(path).entries) }, null, 2));
    return;
  }
  const session = flag(args, 'session');
  const sessionId = typeof session === 'string' ? session : basename(path, '.jsonl');
  const turns = agent === 'omp'
    ? parseOmpSession(readJsonlFrom(path).entries, sessionId)
    : parseTranscript(agent, path, sessionId, { offset: 0, turnsBefore: 0 }).turns;
  console.log(JSON.stringify({ agent, ...summarizeTurns(turns) }, null, 2));
}

async function cmdAuditLangfuse(agent: string | undefined, args: string[]): Promise<void> {
  const target = agent && !agent.startsWith('--') ? agent : 'claude';
  if (target !== 'claude' && target !== 'codex') throw new Error('audit-langfuse expects claude or codex credentials');
  const cfg = loadConfig(target);
  if (!cfg.publicKey || !cfg.secretKey) throw new Error('missing Langfuse keys');
  const rawLimit = flag(args, 'limit');
  const limit = rawLimit === undefined ? 20 : Number(rawLimit === true ? NaN : rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer from 1 to 100');
  const client = new LangfuseClient({ baseUrl: cfg.baseUrl, publicKey: cfg.publicKey, secretKey: cfg.secretKey,
    timeoutMs: cfg.timeoutMs, logger: createLogger(logPath(cfg), false) });
  console.log(JSON.stringify(await auditLangfuse(client, limit), null, 2));
}

async function main(): Promise<void> {
  const [cmd, a1, a2, ...rest] = process.argv.slice(2);
  const args = [a1, a2, ...rest].filter((x): x is string => x !== undefined);
  switch (cmd) {
    case 'hook':
      return cmdHook(agentsArg(a1)[0]);
    case 'install':
    case 'uninstall':
      return cmdInstall(a1?.startsWith('--') ? undefined : a1, !!flag(args, 'dry-run'), cmd === 'uninstall');
    case 'doctor':
      return cmdDoctor(a1?.startsWith('--') ? undefined : a1);
    case 'antigravity-hook':
      if (a1 === 'PreToolUse' || a1 === 'PostToolUse' || a1 === 'PreInvocation' || a1 === 'PostInvocation' || a1 === 'Stop') {
        try {
          const input = (await readStdin()).replace(/^﻿/, '').trim();
          await runAntigravityHook(a1, input ? JSON.parse(input) : {});
        } catch (err) {
          console.error('Antigravity observer: ' + (err as Error).message);
        }
        console.log(JSON.stringify(a1 === 'PreToolUse' ? { decision: 'allow' } : {}));
      }
      return;
    case 'export-otlp': {
      if (a1 !== 'opencode') throw new Error('export-otlp expects opencode');
      const config = loadOtlpConfig(process.env);
      if (!config) throw new Error('OTLP exporter is not configured');
      const events = JSON.parse(await readStdin());
      if (!Array.isArray(events)) throw new Error('Expected a trace event array');
      if (!(await exportOtlp(config, events, a1)).ok) process.exitCode = 1;
      return;
    }
    case 'audit':
      return cmdAudit(a1, a2, rest);
    case 'copilot-hook': {
      const cfg = loadConfig('copilot', { ...process.env });
      const log = createLogger(logPath(cfg), cfg.debug);
      try {
        const payload = normalizePayload(JSON.parse((await readStdin()).replace(/^﻿/, '') || '{}'));
        if (!canExport(cfg)) { log.debug('Copilot skipped: no trace exporter configured'); return; }
        if (typeof payload.session_id !== 'string' || typeof payload.transcript_path !== 'string') {
          log.debug('Copilot skipped: hook lacks a session ID or transcript path');
          return;
        }
        const stop = typeof payload.timestamp === 'number' ? new Date(payload.timestamp).toISOString() : new Date().toISOString();
        const turn = parseCopilotTurn(readJsonlFrom(payload.transcript_path).entries, payload.session_id, stop);
        if (!turn) { log.debug('Copilot skipped: transcript has no completed interaction'); return; }
        const result = await exportEvents(cfg, turnToEvents(turn, batchOptions(cfg)), log);
        if (!result.ok) log.error(`Copilot export failed (${result.errors.length} errors)`);
        else log.debug('Copilot turn exported');
      } catch { log.error('Could not export Copilot turn'); }
      return;
    }
    case 'export-turn': {
      if (a1 !== 'deepagents') throw new Error('export-turn expects deepagents');
      const cfg = loadConfig(a1, { ...process.env });
      if (!canExport(cfg)) return;
      const turn = JSON.parse(await readStdin()) as Turn;
      if (!turn.complete || typeof turn.sessionId !== 'string' || typeof turn.key !== 'string' || !Array.isArray(turn.steps)) {
        throw new Error('Expected a completed agent turn');
      }
      const log = createLogger(logPath(cfg), cfg.debug);
      if (!(await exportEvents(cfg, turnToEvents(turn, batchOptions(cfg)), log)).ok) {
        log.error('Deep Agents turn export failed');
        process.exitCode = 1;
      }
      return;
    }
    case 'audit-langfuse':
      return cmdAuditLangfuse(a1, args);
    case 'backfill':
      return cmdBackfill(agentsArg(a1)[0], a2, rest);
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}

main().catch((e) => {
  if (process.argv[2] === 'hook') return; // never fail the agent
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
