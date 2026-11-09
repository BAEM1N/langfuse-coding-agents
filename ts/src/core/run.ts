import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findCodexRollout, parseCodexRollout, type CodexContext } from '../adapters/codex.ts';
import { parseClaudeTranscript } from '../adapters/claude.ts';
import { turnToEvents, type BatchOptions } from './batch.ts';
import { loadConfig, type Config } from './config.ts';
import { readJsonlFrom } from './jsonl.ts';
import { LangfuseClient } from './langfuse.ts';
import { createLogger, type Logger } from './log.ts';
import { loadState, saveState, type TranscriptState } from './state.ts';
import type { AgentName, HookPayload, Turn } from './types.ts';

const LABELS: Record<AgentName, { label: string; tag: string }> = {
  claude: { label: 'Claude Code', tag: 'claude-code' },
  codex: { label: 'Codex', tag: 'codex' },
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
): ParsedTranscript & { from: number } {
  const read = readJsonlFrom(path, st.offset);
  const turnsBefore = read.from === st.offset ? st.turnsBefore : 0;
  if (agent === 'claude') {
    return { turns: parseClaudeTranscript(read.entries, { sessionId, turnsBefore }), from: read.from };
  }
  const r = parseCodexRollout(read.entries, {
    sessionId,
    turnsBefore,
    context: read.from === st.offset ? ((st.context ?? {}) as CodexContext) : {},
  });
  return { turns: r.turns, context: r.context as Record<string, unknown>, from: read.from };
}

export function batchOptions(cfg: Config): BatchOptions {
  return {
    agentLabel: LABELS[cfg.agent].label,
    agentTag: LABELS[cfg.agent].tag,
    userId: cfg.userId,
    hostname: cfg.hostname,
    environment: cfg.environment,
    maxChars: cfg.maxChars,
    redact: cfg.redact,
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

export interface HookResult {
  skipped?: string;
  turns?: number;
  events?: number;
  errors?: number;
}

export async function runHook(agent: AgentName, raw: Record<string, unknown>, logger?: Logger): Promise<HookResult> {
  const cfg = loadConfig(agent);
  const log = logger ?? createLogger(logPath(cfg), cfg.debug);
  if (!cfg.enabled) return { skipped: 'TRACE_TO_LANGFUSE is not true' };
  if (!cfg.publicKey || !cfg.secretKey) return { skipped: 'missing Langfuse keys' };

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
    const parsed = parseTranscript(agent, transcript, sessionId, st);
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
  const client = new LangfuseClient({
    baseUrl: cfg.baseUrl,
    publicKey: cfg.publicKey,
    secretKey: cfg.secretKey,
    timeoutMs: cfg.timeoutMs,
    logger: log,
  });
  const started = Date.now();
  const res = await client.ingest(events);
  if (!res.ok) {
    log.error(`ingest failed (${res.errors.length} errors): ${JSON.stringify(res.errors.slice(0, 3))}`);
    return { turns: turns.length, events: events.length, errors: res.errors.length };
  }

  if (transcript && st) {
    const last = turns[turns.length - 1];
    state.transcripts[transcript] = {
      offset: last.offset,
      turnsBefore: Math.max(0, last.index - 1),
      context: context ?? st.context,
      updatedAt: new Date().toISOString(),
    };
    saveState(statePath, state);
  }
  log.info(`${event}: sent ${turns.length} turn(s), ${events.length} events in ${Date.now() - started}ms (session=${sessionId})`);
  return { turns: turns.length, events: events.length, errors: 0 };
}
