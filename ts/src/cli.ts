#!/usr/bin/env node
// langfuse-agent-hooks — zero-dependency Langfuse tracing for AI coding agents.
//
//   node src/cli.ts hook <claude|codex>          (called by the agent; reads JSON on stdin)
//   node src/cli.ts install [claude|codex|antigravity|copilot|all] [--dry-run]
//   node src/cli.ts uninstall [claude|codex|antigravity|all]
//   node src/cli.ts doctor [claude|codex]
//   node src/cli.ts delivery <agent> [--all] | delivery <agent> clear <traceId> [--destination ID]
//   node src/cli.ts audit <claude|codex|omp|antigravity> <transcript.jsonl>
//   node src/cli.ts verify <agent> <traceId> [--api v2|legacy] [--tempo URL] [--reconcile]
//   node src/cli.ts coverage <claude|codex> [--since ISO] [--until ISO] [--deep N]
//   node src/cli.ts selftest [claude|codex|omp|copilot|opencode|all] [--keep]   (sends a synthetic turn to the project, checks it, deletes it)
//   node src/cli.ts audit-langfuse [claude|codex] [--limit N] [--api v2|legacy] [--from ISO] [--to ISO]
//   node src/cli.ts backfill <claude|codex> <transcript.jsonl> --from ISO --to ISO [--session ID] [--dry-run]

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig } from './core/config.ts';
import { auditLangfuse, auditLangfuseV2, readTraceObservations, summarizeTurns, withReadApi } from './core/audit.ts';
import { otlpSpanId } from './core/otlp.ts';
import { parseOmpSession } from './adapters/omp.ts';
import { readCopilotTurn } from './adapters/copilot.ts';
import { runAntigravityHook } from './core/antigravity-hook.ts';
import { auditAntigravity } from './adapters/antigravity.ts';
import { readJsonlFrom } from './core/jsonl.ts';
import { batchOptions, logPath, normalizePayload, parseTranscript, runHook } from './core/run.ts';
import { turnToEvents } from './core/batch.ts';
import { LangfuseClient } from './core/langfuse.ts';
import { createLogger } from './core/log.ts';
import { canExport, deliveryDir, exportEvents } from './core/export.ts';
import { clearRecord, listRecords, reconcile } from './core/delivery.ts';
import { coverage } from './core/coverage.ts';
import { selfTest } from './core/selftest.ts';
import { planBackfill, runBackfill } from './core/backfill.ts';
import { isLangfuseCloud, resolveDestinations } from './core/destinations.ts';
import { githubAttributes, githubOptions, readGithubContext } from './core/github.ts';
import { applyPlan, deployPackage, HOOK_EVENTS, planAntigravityInstall, planCopilotInstall, planInstall } from './install.ts';
import type { Turn } from './core/types.ts';
import type { AgentName, TraceAgentName } from './core/types.ts';

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
    const env = { ...process.env };
    const cfg = loadConfig(agent, env);
    const mask = (s?: string) => (s ? `${s.slice(0, 10)}…${s.slice(-4)}` : '(missing)');
    console.log(`\n[${agent}] home=${cfg.agentHome}`);
    console.log(`  enabled=${cfg.enabled} url=${cfg.baseUrl} user=${cfg.userId} redact=${cfg.redact} maxChars=${cfg.maxChars}`);
    console.log(`  publicKey=${mask(cfg.publicKey)} secretKey=${cfg.secretKey ? '(set)' : '(missing)'}`);
    if (cfg.publicKey && cfg.secretKey) {
      const client = new LangfuseClient({ baseUrl: cfg.baseUrl, publicKey: cfg.publicKey, secretKey: cfg.secretKey, timeoutMs: cfg.timeoutMs, logger: createLogger(logPath(cfg), false) });
      const a = await client.authCheck();
      // Valid keys say nothing about whether traces are being stored.
      console.log(`  auth: ${a.ok ? 'OK' : 'FAILED'} (${a.message}) - credentials only, not proof of ingestion`);
    }
    const destinations = resolveDestinations(cfg);
    console.log(`  langfuse transport=${cfg.langfuseTransport}${env.LANGFUSE_HOOK_TRANSPORT ? '' : ' (default: OTLP, legacy only if the server has no OTLP endpoint)'}`);
    if (!destinations.length) console.log('  destinations: (none) - nothing will be sent');
    for (const d of destinations) {
      console.log(`  destination: ${d.label} [${d.id}]${d.configError ? `\n    CONFIG ERROR: ${d.configError}` : ''}`);
      if (d.kind === 'langfuse-legacy') {
        console.log(isLangfuseCloud(cfg.baseUrl)
          ? '    WARNING: Langfuse Cloud retired legacy trace ingestion on 2026-11-16: these turns are not stored. Remove LANGFUSE_HOOK_TRANSPORT or set it to otlp.'
          : '    WARNING: legacy ingestion is deprecated by Langfuse (self-hosted v4 rejects it unless the server runs in legacy or dual write mode). Remove LANGFUSE_HOOK_TRANSPORT to use OTLP.');
      }
      if (d.relay) console.log('    note: a relay accepting a request does not show that its backends stored it');
    }
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = listRecords(deliveryDir(cfg)).filter((r) => Date.parse(r.updatedAt) >= since);
    for (const d of destinations) {
      const mine = recent.filter((r) => r.destination === d.id);
      const count = (status: string) => mine.filter((r) => r.status === status).length;
      const late = mine.filter((r) => r.lateChanges?.length).length;
      console.log(`  delivery, last 24h, ${d.label}: confirmed=${count('confirmed')} partial=${count('partial')} failed=${count('failed')} unconfirmed=${count('unconfirmed')} changed-after-delivery=${late}`);
      if (!mine.length) console.log('    no delivery attempts recorded: ingestion is unverified');
      const stuck = mine.filter((r) => r.status !== 'confirmed');
      if (stuck.length) console.log(`    last problem: ${stuck[stuck.length - 1].lastError ?? '(no detail)'}\n    see: delivery ${agent}`);
    }
    console.log(`  "confirmed" means the destination accepted the request. Use verify ${agent} <traceId> to read it back.`);
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

const TRACE_AGENTS: TraceAgentName[] = ['claude', 'codex', 'omp', 'antigravity', 'copilot', 'deepagents', 'opencode'];

/** Show or reset per-destination delivery state. Prints IDs and statuses only. */
function cmdDelivery(agent: string | undefined, args: string[]): void {
  if (!TRACE_AGENTS.includes(agent as TraceAgentName)) throw new Error('delivery expects one of: ' + TRACE_AGENTS.join(', '));
  const cfg = loadConfig(agent as TraceAgentName, { ...process.env });
  const dir = deliveryDir(cfg);
  const records = listRecords(dir);
  if (args[1] === 'clear') {
    const traceId = args[2];
    if (!traceId || traceId.startsWith('--')) throw new Error('delivery <agent> clear <traceId> [--destination ID]');
    const only = flag(args, 'destination');
    const targets = records.filter((r) => r.traceId === traceId && (typeof only !== 'string' || r.destination === only));
    if (!targets.length) throw new Error('no delivery record for that trace');
    for (const r of targets) {
      clearRecord(dir, r.traceId, r.destination);
      console.log(`cleared ${r.traceId} ${r.destination} (was ${r.status})`);
    }
    console.log('The turn is sent again the next time its transcript is read or backfilled.');
    console.log('A receiver that does not deduplicate span IDs (Langfuse v4, Tempo) may then hold it twice.');
    return;
  }
  const shown = flag(args, 'all') ? records : records.filter((r) => r.status !== 'confirmed' || r.lateChanges?.length);
  console.log(`${dir}: ${records.length} record(s), ${shown.length} shown${flag(args, 'all') ? '' : ' (not confirmed, or changed after delivery; --all for every record)'}`);
  for (const r of shown.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    console.log(`  ${r.updatedAt} ${r.status.padEnd(11)} trace=${r.traceId} dest=${r.destination} accepted=${Object.keys(r.spans).length}` +
      ` pending=${r.pending?.length ?? 0} changed-after=${r.lateChanges?.length ?? 0} attempts=${r.attempts}${r.lastError ? `\n      ${r.lastError}` : ''}`);
  }
}

async function cmdBackfill(agent: AgentName, path: string, args: string[]): Promise<void> {
  if (!path || !existsSync(path)) throw new Error(`transcript not found: ${path}`);
  const cfg = loadConfig(agent);
  const session = typeof flag(args, 'session') === 'string' ? (flag(args, 'session') as string) : basename(path, '.jsonl').replace(/^rollout-[\dT-]+-/, '');
  const { turns } = parseTranscript(agent, path, session, { offset: 0, turnsBefore: 0 });
  // Historical turns keep their own metadata: GitHub context describes the checkout as it is now.
  const config = { ...cfg, github: undefined, timeoutMs: Math.max(cfg.timeoutMs, 60000) };
  const range = { from: timeFlag(args, 'from'), to: timeFlag(args, 'to') };
  const plan = planBackfill(config, turns, batchOptions(config), range);
  // The summary lists counts and IDs only, never prompt or response text.
  console.log(`session=${session}`);
  console.log(`range: ${range.from ?? '(not set)'} .. ${range.to ?? '(not set)'}  (by turn start time)`);
  console.log(`turns: ${plan.turns} read, ${plan.selected.length} selected, excluded: unfinished=${plan.excluded.incomplete} outside-range=${plan.excluded.outsideRange}`);
  if (!plan.destinations.length) console.log('destinations: (none configured)');
  for (const d of plan.destinations) {
    console.log(`destination: ${d.label} [${d.id}] to-send=${d.toSend} already-confirmed=${d.alreadyConfirmed}${d.configError ? `\n  CONFIG ERROR: ${d.configError}` : ''}`);
  }
  if (flag(args, 'dry-run')) {
    console.log('dry run: nothing was sent and no network request was made');
    return;
  }
  const result = await runBackfill(config, plan, createLogger(logPath(cfg), cfg.debug), process.cwd());
  if (result.foundComplete.length) console.log(`already stored in Langfuse, recorded as delivered: ${result.foundComplete.length}`);
  if (result.existsRemotely.length) {
    console.log(`stored in Langfuse under other observation IDs, not sent to it: ${result.existsRemotely.length}\n  ${result.existsRemotely.join('\n  ')}`);
  }
  for (const d of result.export?.destinations ?? []) {
    const counts: Record<string, number> = {};
    for (const trace of d.traces) counts[trace.status] = (counts[trace.status] ?? 0) + 1;
    console.log(`${d.label}: ${Object.entries(counts).map(([status, n]) => `${status}=${n}`).join(' ')} (${d.evidence})`);
    for (const trace of d.traces.filter((item) => !['delivered', 'skipped'].includes(item.status))) {
      console.log(`  ${trace.status} ${trace.traceId}${trace.message ? ` - ${trace.message}` : ''}`);
    }
  }
  if (result.export && !result.export.ok) process.exitCode = 1;
  console.log('Read a trace back with: verify ' + agent + ' <traceId>');
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
  const window = { limit, from: timeFlag(args, 'from'), to: timeFlag(args, 'to') };
  const client = new LangfuseClient({ baseUrl: cfg.baseUrl, publicKey: cfg.publicKey, secretKey: cfg.secretKey,
    timeoutMs: Math.max(cfg.timeoutMs, 30000), logger: createLogger(logPath(cfg), false) });
  const { value: report } = await withReadApi<object>(readApi(args), (api) =>
    api === 'v2' ? auditLangfuseV2(client, window) : auditLangfuse(client, window));
  console.log(JSON.stringify(report, null, 2));
}

/** Local transcripts against what the project holds: missing turns, short turns, uncosted model calls. */
async function cmdCoverage(agent: string | undefined, args: string[]): Promise<void> {
  if (agent !== 'claude' && agent !== 'codex') throw new Error('coverage expects claude or codex');
  const cfg = loadConfig(agent, { ...process.env });
  if (!cfg.publicKey || !cfg.secretKey) throw new Error('missing Langfuse keys');
  const rawDeep = flag(args, 'deep');
  const deep = rawDeep === undefined ? 40 : Number(rawDeep === true ? NaN : rawDeep);
  if (!Number.isInteger(deep) || deep < 0 || deep > 500) throw new Error('--deep must be an integer from 0 to 500');
  const client = new LangfuseClient({ baseUrl: cfg.baseUrl, publicKey: cfg.publicKey, secretKey: cfg.secretKey,
    timeoutMs: Math.max(cfg.timeoutMs, 60000), logger: createLogger(logPath(cfg), false) });
  const report = await coverage(agent, cfg, client, { since: timeFlag(args, 'since') ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    until: timeFlag(args, 'until'), api: readApi(args), deep });
  console.log(JSON.stringify(report, null, 2));
  if (report.stored.finishedTurnsMissing > 0) process.exitCode = 1;
}

/**
 * Send a made-up turn with a sub-agent to the configured project, read it back,
 * compare, and delete it. The one check that shows the whole path works.
 */
async function cmdSelfTest(agent: string | undefined, args: string[]): Promise<void> {
  const target = agent && !agent.startsWith('--') ? agent : 'claude';
  const known = ['claude', 'codex', 'omp', 'copilot', 'opencode'] as const;
  const formats = target === 'all' ? known : known.filter((name) => name === target);
  if (!formats.length) throw new Error('selftest expects claude, codex, omp, copilot, opencode or all');
  for (const format of formats) {
    // Keys come from that agent's own settings, as they do when its integration runs.
    const cfg = loadConfig(format, { ...process.env });
    const report = await selfTest(cfg, { format, keep: !!flag(args, 'keep'), api: readApi(args) });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}

function timeFlag(args: string[], name: string): string | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const time = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(time)) throw new Error(`--${name} expects an ISO timestamp`);
  return new Date(time).toISOString();
}

/**
 * v2 reads observations (Langfuse Cloud, self-hosted v4). legacy reads stored
 * traces (self-hosted v3, or v4 in legacy/dual write mode). The default follows
 * the transport that wrote the data.
 */
function readApi(args: string[]): 'v2' | 'legacy' | undefined {
  const raw = flag(args, 'api');
  // Unset: try v2 and fall back. The write transport does not tell which read
  // API a server offers: a v4 server in dual write mode takes OTLP but has no v2.
  if (raw === undefined) return undefined;
  if (raw !== 'v2' && raw !== 'legacy') throw new Error('--api must be v2 or legacy');
  return raw;
}

/** Read a trace back from each backend. This, not an HTTP 2xx, shows it was stored. */
async function cmdVerify(agent: string | undefined, traceId: string | undefined, args: string[]): Promise<void> {
  if (!TRACE_AGENTS.includes(agent as TraceAgentName)) throw new Error('verify expects one of: ' + TRACE_AGENTS.join(', '));
  if (!traceId || !/^[0-9a-f]{32}$/.test(traceId)) throw new Error('verify <agent> <traceId> expects a 32-hex trace ID');
  const cfg = loadConfig(agent as TraceAgentName, { ...process.env });
  const records = listRecords(deliveryDir(cfg)).filter((r) => r.traceId === traceId);
  const report: Record<string, unknown> = { traceId, local: records.map((r) => ({ destination: r.destination, status: r.status,
    accepted: Object.values(r.spans).filter((hash) => hash !== 'dropped').length, pending: r.pending?.length ?? 0 })) };
  let ok = true;
  if (cfg.publicKey && cfg.secretKey) {
    let api: 'v2' | 'legacy' | undefined = readApi(args);
    const client = new LangfuseClient({ baseUrl: cfg.baseUrl, publicKey: cfg.publicKey, secretKey: cfg.secretKey,
      timeoutMs: Math.max(cfg.timeoutMs, 30000), logger: createLogger(logPath(cfg), false) });
    try {
      const read = await withReadApi(api, (chosen) => readTraceObservations(client, chosen, traceId));
      api = read.api;
      const stored = read.value;
      const ids = stored.map((span) => span.id);
      const record = records.find((r) => r.destination.startsWith('langfuse-'));
      const expected = record ? Object.entries(record.spans).filter(([, hash]) => hash !== 'dropped')
        .map(([id]) => record.destination.startsWith('langfuse-otlp') ? otlpSpanId(id) : id) : [];
      const types: Record<string, number> = {};
      for (const span of stored) types[span.type] = (types[span.type] ?? 0) + 1;
      // Legacy records also hold the trace and event IDs, which are not observations.
      const missing = record?.destination.startsWith('langfuse-otlp') ? expected.filter((id) => !ids.includes(id)).length : undefined;
      const duplicates = ids.length - new Set(ids).size;
      report.langfuse = { api, stored: stored.length, types, missing, duplicates,
        verdict: !stored.length ? 'NOT FOUND' : missing || duplicates ? 'INCOMPLETE OR DUPLICATED' : 'STORED' };
      ok &&= stored.length > 0 && !missing && !duplicates;
      if (record?.status === 'unconfirmed' && record.destination.startsWith('langfuse-otlp')) {
        // A read can run ahead of ingestion, so settling the record is asked for, never assumed.
        if (flag(args, 'reconcile')) {
          report.reconciled = reconcile(deliveryDir(cfg), record, new Set(ids), otlpSpanId);
        } else {
          const present = (record.pending ?? []).filter((id) => ids.includes(otlpSpanId(id))).length;
          report.unconfirmed = { pending: record.pending?.length ?? 0, foundInBackend: present,
            next: 'Re-run with --reconcile to accept the spans found and release the rest for sending. Allow a few minutes after the send first: a read can run ahead of ingestion.' };
        }
      }
    } catch (e) {
      report.langfuse = { api, verdict: 'READ FAILED', detail: (e as Error).message };
      ok = false;
    }
  } else {
    report.langfuse = { verdict: 'NOT CHECKED', detail: 'no Langfuse keys in this agent configuration' };
  }
  const tempo = flag(args, 'tempo');
  if (typeof tempo === 'string') {
    try {
      const res = await fetch(new URL('/api/traces/' + traceId, tempo), { signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (res.status === 404) { report.tempo = { verdict: 'NOT FOUND' }; ok = false; }
      else if (!res.ok) { report.tempo = { verdict: 'READ FAILED', detail: 'HTTP ' + res.status }; ok = false; }
      else {
        const body = await res.json() as { batches?: any[]; resourceSpans?: any[] };
        const spans = (body.batches ?? body.resourceSpans ?? []).flatMap((batch) =>
          (batch.scopeSpans ?? batch.instrumentationLibrarySpans ?? []).flatMap((scope: any) => scope.spans ?? []));
        report.tempo = { stored: spans.length, verdict: spans.length ? 'STORED' : 'NOT FOUND' };
        ok &&= spans.length > 0;
      }
    } catch {
      report.tempo = { verdict: 'READ FAILED', detail: 'Tempo query endpoint unreachable' };
      ok = false;
    }
  } else {
    report.tempo = { verdict: 'NOT CHECKED', detail: 'pass --tempo <Tempo query URL>, for example http://127.0.0.1:13200' };
  }
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 1;
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
    case 'github-context': {
      const config = a1 === 'opencode' ? loadConfig(a1, { ...process.env }) : undefined;
      const github = await readGithubContext(process.cwd(), config?.github ?? githubOptions(process.env));
      if (a1 === '--otlp') {
        console.log(github ? Object.entries(githubAttributes(github)).filter(([, value]) => value !== undefined)
          .map(([key, value]) => key + '=' + String(value).replace(/[%,=]/g, encodeURIComponent)).join(',') : '');
      } else {
        console.log(JSON.stringify(github ?? null));
      }
      return;
    }
    case 'export-events': {
      // A finished turn built by an integration that is not written in TypeScript
      // (the OpenCode plugin). Every configured destination gets it, with delivery state.
      if (a1 !== 'opencode') throw new Error('export-events expects opencode');
      const config = loadConfig(a1, { ...process.env });
      if (!canExport(config)) return;
      const events = JSON.parse(await readStdin());
      if (!Array.isArray(events)) throw new Error('Expected a trace event array');
      if (!(await exportEvents(config, events, createLogger(logPath(config), config.debug))).ok) process.exitCode = 1;
      return;
    }
    case 'export-otlp': {
      if (a1 !== 'opencode') throw new Error('export-otlp expects opencode');
      const config = loadConfig(a1, { ...process.env });
      if (!config.otlp) throw new Error('OTLP exporter is not configured');
      const events = JSON.parse(await readStdin());
      if (!Array.isArray(events)) throw new Error('Expected a trace event array');
      if (!(await exportEvents({ ...config, enabled: false }, events, createLogger(logPath(config), config.debug))).ok) process.exitCode = 1;
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
        const turn = await readCopilotTurn(payload.transcript_path, payload.session_id, stop);
        if (!turn) { log.debug('Copilot skipped: transcript has no completed interaction'); return; }
        const result = await exportEvents(cfg, turnToEvents(turn, batchOptions(cfg)), log, payload.cwd);
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
    case 'delivery':
      return cmdDelivery(a1, args);
    case 'verify':
      return cmdVerify(a1, a2, args);
    case 'coverage':
      return cmdCoverage(a1, args);
    case 'selftest':
      return cmdSelfTest(a1, args);
    case 'audit-langfuse':
      return cmdAuditLangfuse(a1, args);
    case 'backfill':
      return cmdBackfill(agentsArg(a1)[0], a2, rest);
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}

main().catch((e) => {
  if (process.argv[2] === 'hook') return; // never fail the agent
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
