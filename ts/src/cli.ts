#!/usr/bin/env node
// langfuse-agent-hooks — zero-dependency Langfuse tracing for AI coding agents.
//
//   node src/cli.ts hook <claude|codex>          (called by the agent; reads JSON on stdin)
//   node src/cli.ts install [claude|codex|all] [--dry-run]
//   node src/cli.ts uninstall [claude|codex|all]
//   node src/cli.ts doctor [claude|codex]
//   node src/cli.ts backfill <claude|codex> <transcript.jsonl> [--session ID] [--dry-run]

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from './core/config.ts';
import { batchOptions, logPath, parseTranscript, runHook } from './core/run.ts';
import { turnToEvents } from './core/batch.ts';
import { LangfuseClient } from './core/langfuse.ts';
import { createLogger } from './core/log.ts';
import { applyPlan, deployPackage, HOOK_EVENTS, planInstall } from './install.ts';
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
