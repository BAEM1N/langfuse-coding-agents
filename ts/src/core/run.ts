import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { findCodexRollout, parseCodexRollout, type CodexContext } from '../adapters/codex.ts';
import { parseClaudeTranscript } from '../adapters/claude.ts';
import { traceIdFor, turnToEvents, type BatchOptions } from './batch.ts';
import { loadConfig, type Config } from './config.ts';
import { readJsonlFrom } from './jsonl.ts';
import { canExport, exportEvents, type DestinationResult } from './export.ts';
import { createLogger, type Logger } from './log.ts';
import { loadState, saveState, type TranscriptState } from './state.ts';
import { attachClaudeSubagents, attachCodexSubagents } from './subagents.ts';
import type { AgentName, HookPayload, TraceAgentName, Turn } from './types.ts';

const LABELS: Record<TraceAgentName, { label: string; tag: string }> = {
  claude: { label: 'Claude Code', tag: 'claude-code' },
  codex: { label: 'Codex', tag: 'codex' },
  omp: { label: 'Oh My Pi', tag: 'oh-my-pi' },
  antigravity: { label: 'Antigravity', tag: 'antigravity' },
  copilot: { label: 'GitHub Copilot CLI', tag: 'copilot' },
  deepagents: { label: 'Deep Agents', tag: 'deepagents' },
  opencode: { label: 'OpenCode', tag: 'opencode' },
};

/** Accept both snake_case and camelCase payload keys. */
export function normalizePayload(raw: Record<string, unknown>): HookPayload {
  const p: HookPayload = { ...raw };
  const alias: Record<string, string> = {
    sessionId: 'session_id',
    transcriptPath: 'transcript_path',
    hookEventName: 'hook_event_name',
    turnId: 'turn_id',
    toolName: 'tool_name',
    toolInput: 'tool_input',
    lastAssistantMessage: 'last_assistant_message',
  };
  for (const [camel, snake] of Object.entries(alias)) {
    if (p[snake] === undefined && raw[camel] !== undefined) p[snake] = raw[camel];
  }
  return p;
}

export interface ParsedTranscript {
  turns: Turn[];
  context?: Record<string, unknown>;
}

export function parseTranscript(
  agent: AgentName,
  path: string,
  sessionId: string,
  st: Pick<TranscriptState, 'offset' | 'turnsBefore' | 'context'>,
  /** `read-only` attaches sub-agents without writing the thread lookup cache. */
  subagents: boolean | 'read-only' = true,
): ParsedTranscript & { from: number } {
  const read = readJsonlFrom(path, st.offset);
  const turnsBefore = read.from === st.offset ? st.turnsBefore : 0;
  if (agent === 'claude') {
    const turns = parseClaudeTranscript(read.entries, { sessionId, turnsBefore });
    if (subagents) attach(() => attachClaudeSubagents(path, turns));
    return { turns, from: read.from };
  }
  const r = parseCodexRollout(read.entries, {
    sessionId,
    turnsBefore,
    context: read.from === st.offset ? ((st.context ?? {}) as CodexContext) : {},
  });
  if (subagents) attach(() => attachCodexSubagents(path, sessionId, r.turns, subagents !== 'read-only'));
  return { turns: r.turns, context: r.context as Record<string, unknown>, from: read.from };
}

/** Sub-agent files are extra: a problem reading them must not cost the turn itself. */
function attach(read: () => void): void {
  try { read(); } catch { /* the turn is exported without its sub-agents */ }
}

export function batchOptions(cfg: Config): BatchOptions {
  return {
    agentLabel: LABELS[cfg.agent].label,
    agentTag: LABELS[cfg.agent].tag,
    userId: cfg.userId,
    hostname: cfg.hostname,
    device: cfg.device,
    environment: cfg.environment,
    maxChars: cfg.maxChars,
    redact: cfg.redact,
    subagentTraces: cfg.subagentTraces,
  };
}

export function logPath(cfg: Config): string {
  return join(cfg.agentHome, 'state', 'langfuse_agent_hooks.log');
}

function resolveTranscript(cfg: Config, p: HookPayload): string | undefined {
  if (p.transcript_path && existsSync(p.transcript_path)) return p.transcript_path;
  if (cfg.agent === 'codex' && p.session_id) return findCodexRollout(cfg.agentHome, p.session_id);
  return undefined;
}

/** Apply what the hook event itself tells us on top of the transcript. */
function applyEvent(agent: AgentName, event: string, p: HookPayload, turns: Turn[]): void {
  const last = turns[turns.length - 1];
  if (!last) return;
  const now = new Date().toISOString();
  if (event === 'Stop') {
    last.complete = true;
    if (!last.output && p.last_assistant_message) last.output = p.last_assistant_message;
  } else if (event === 'Notification') {
    last.events.push({
      key: `notification-${now}`,
      name: `Notification${p.notification_type ? `: ${String(p.notification_type)}` : ''}`,
      time: now,
      input: p.message,
      level: 'DEFAULT',
    });
  } else if (event === 'PermissionRequest') {
    last.events.push({
      key: `permission-${now}`,
      name: `Permission request${p.tool_name ? `: ${p.tool_name}` : ''}`,
      time: now,
      input: { tool: p.tool_name, input: p.tool_input },
      level: 'WARNING',
    });
  }
  void agent;
}

/** Turn with no transcript (Codex fallback): build it from the hook payload alone. */
function fallbackTurn(p: HookPayload, sessionId: string): Turn | undefined {
  if (!p.last_assistant_message && !p.prompt) return undefined;
  const now = new Date().toISOString();
  return {
    key: p.turn_id ?? `fallback-${now}`,
    index: 0,
    sessionId,
    startTime: now,
    endTime: now,
    input: p.prompt,
    output: p.last_assistant_message,
    complete: p.hook_event_name === 'Stop',
    steps: [],
    events: [],
    offset: 0,
    metadata: { fallback: 'no transcript available' },
  };
}

/**
 * The read position only says where the next parse starts. Whether a turn
 * reached a destination is tracked per destination in the delivery state, so
 * the position stops at the first turn some destination still needs. The last
 * turn is always read again: its final response can land late.
 */
function savePosition(statePath: string, transcript: string, turns: Turn[], settledIds: string[], opts: BatchOptions,
  context: Record<string, unknown> | undefined, sessionId: string): void {
  const settled = new Set(settledIds);
  const last = turns[turns.length - 1];
  const resume = turns.find((t) => !t.complete || !settled.has(traceIdFor(opts.agentTag, t.sessionId, t.key))) ?? last;
  const latest = loadState(statePath); // another session may have saved meanwhile
  latest.transcripts[transcript] = {
    offset: resume.offset,
    turnsBefore: Math.max(0, resume.index - 1),
    context,
    updatedAt: new Date().toISOString(),
    sessionId,
    // Also open while the last turn is still owed to a destination, so it is
    // retried even if this session never runs another hook.
    open: !last.complete || !settled.has(traceIdFor(opts.agentTag, last.sessionId, last.key)),
  };
  saveState(statePath, latest);
}

const MAX_STALE_PER_RUN = 2;

/**
 * A turn that was interrupted, or whose session was closed, never gets a Stop
 * event, and no later hook runs for that transcript. Legacy ingestion left it
 * named "(in progress)" forever; destinations that only take finished turns
 * would never receive it. When another hook runs, close turns whose transcript
 * has been idle for the configured time and send them, marked as such.
 */
async function closeStaleTurns(agent: AgentName, cfg: Config, statePath: string, current: string | undefined,
  opts: BatchOptions, log: Logger): Promise<void> {
  if (!cfg.staleTurnMs) return;
  const now = Date.now();
  let handled = 0;
  for (const [path, st] of Object.entries(loadState(statePath).transcripts)) {
    if (handled >= MAX_STALE_PER_RUN) break;
    if (path === current || !st.open || !st.sessionId || now - Date.parse(st.updatedAt) < cfg.staleTurnMs) continue;
    let idleFor: number | undefined;
    try { idleFor = now - statSync(path).mtimeMs; } catch { /* transcript is gone */ }
    if (idleFor !== undefined && idleFor < cfg.staleTurnMs) continue;
    handled++;
    const parsed = idleFor === undefined ? undefined : parseTranscript(agent, path, st.sessionId, st, cfg.subagents);
    const last = parsed?.turns.at(-1);
    if (!parsed || !last) {
      const latest = loadState(statePath);
      if (latest.transcripts[path]) { latest.transcripts[path].open = false; saveState(statePath, latest); }
      continue;
    }
    if (!last.complete) {
      last.complete = true;
      last.metadata = { ...last.metadata, endedWithoutStop: true };
    }
    // GitHub context describes the checkout this hook runs in, not that session's.
    const res = await exportEvents({ ...cfg, github: undefined }, parsed.turns.flatMap((t) => turnToEvents(t, opts)), log);
    savePosition(statePath, path, parsed.turns, res.settled, opts, parsed.context ?? st.context, st.sessionId);
    log.info(`closed a turn idle for ${Math.round(idleFor! / 60000)} min without a Stop event (session=${st.sessionId})`);
  }
}

export interface HookResult {
  skipped?: string;
  turns?: number;
  events?: number;
  errors?: number;
  /** Per-destination outcome. A hook never fails the agent because of these. */
  destinations?: DestinationResult[];
}

/** How long a Claude Stop hook waits for the final response to reach the transcript. */
const STOP_WAIT_MS = 3000;

export async function runHook(agent: AgentName, raw: Record<string, unknown>, logger?: Logger): Promise<HookResult> {
  const cfg = loadConfig(agent);
  const log = logger ?? createLogger(logPath(cfg), cfg.debug);
  if (!canExport(cfg)) return { skipped: 'no trace exporter configured' };

  const p = normalizePayload(raw);
  const event = p.hook_event_name ?? 'unknown';
  const sessionId = p.session_id;
  log.debug(`event=${event} session=${sessionId ?? '-'}`);
  if (!sessionId) return { skipped: 'no session_id' };
  if (event === 'SessionStart') return { skipped: 'SessionStart has no turn yet' };

  const statePath = join(cfg.agentHome, 'state', 'langfuse_agent_hooks_state.json');
  const state = loadState(statePath);
  const transcript = resolveTranscript(cfg, p);

  let turns: Turn[] = [];
  let context: Record<string, unknown> | undefined;
  let st: TranscriptState | undefined;
  if (transcript) {
    st = state.transcripts[transcript] ?? { offset: 0, turnsBefore: 0, updatedAt: '' };
    let parsed = parseTranscript(agent, transcript, sessionId, st, cfg.subagents);
    if (agent === 'claude' && event === 'Stop') {
      // The Stop event can arrive before the final model response reaches the transcript.
      const finalText = p.last_assistant_message?.trim();
      // Sending without it stores the turn short: the response follows on a later
      // hook run, but the root span and the tools it answered were already
      // accepted as they stood and cannot be updated. Claude Code has been seen
      // to write that row more than a second after Stop, so wait for it; the
      // loop ends as soon as the response is there.
      const deadline = performance.now() + STOP_WAIT_MS;
      while (performance.now() < deadline) {
        const turn = parsed.turns.at(-1);
        const last = turn?.steps.at(-1);
        const stopReason = last?.kind === 'generation' ? last.metadata?.stopReason : undefined;
        const answered = typeof stopReason === 'string' ? stopReason !== 'tool_use' : (!finalText || (typeof turn?.output === 'string' && turn.output.trim() === finalText));
        if (last?.kind === 'generation' && last.usage && answered) break;
        await wait(75);
        parsed = parseTranscript(agent, transcript, sessionId, st, cfg.subagents);
      }
    }
    turns = parsed.turns;
    context = parsed.context;
  } else {
    const t = fallbackTurn(p, sessionId);
    if (t) turns = [t];
    log.debug(`no transcript for session=${sessionId}; fallback turns=${turns.length}`);
  }
  if (!turns.length) return { skipped: 'no turns found' };

  applyEvent(agent, event, p, turns);

  const opts = batchOptions(cfg);
  const events = turns.flatMap((t) => turnToEvents(t, opts));
  const started = Date.now();
  const res = await exportEvents(cfg, events, log, p.cwd);

  if (transcript && st) savePosition(statePath, transcript, turns, res.settled, opts, context ?? st.context, sessionId);
  try {
    await closeStaleTurns(agent, cfg, statePath, transcript, opts, log);
  } catch (e) {
    log.debug(`stale turn check failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    log.error(`${event}: export incomplete (${res.errors.length} problem(s), session=${sessionId})`);
    return { turns: turns.length, events: events.length, errors: res.errors.length, destinations: res.destinations };
  }
  log.debug(`${event}: ${turns.length} turn(s) read, ${res.sent} item(s) sent in ${Date.now() - started}ms (session=${sessionId})`);
  return { turns: turns.length, events: events.length, errors: 0, destinations: res.destinations };
}
