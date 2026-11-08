// Codex CLI rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*-<session>.jsonl) → Turns.
//
// Observed format (Codex CLI 0.16x):
//   {timestamp, type, payload}
//   type=session_meta                 cwd, cli_version, originator, model_provider
//   type=event_msg  task_started      payload.turn_id  → turn begins
//   type=turn_context                 payload.turn_id, model
//   type=event_msg  item_completed    item.type = UserMessage | AgentMessage | CommandExecution | …
//   type=response_item                message(user|assistant|developer) | reasoning |
//                                     function_call | custom_tool_call | *_output | …
//   type=token_usage_record           response_id + usage → one model call ended
//   type=event_msg  task_complete     turn ends (duration_ms, last_agent_message)
// response_items carry no turn_id; they belong to the most recent task_started.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonlEntry } from '../core/jsonl.ts';
import { contentText } from '../core/text.ts';
import type { GenerationStep, ToolStep, Turn, TurnEvent, Usage } from '../core/types.ts';

export interface CodexContext {
  cwd?: string;
  cliVersion?: string;
  originator?: string;
  modelProvider?: string;
  source?: string;
}

interface ToolAcc {
  key: string;
  name: string;
  startTime: string;
  endTime?: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  commands: unknown[];
}

interface GenAcc {
  outputs: unknown[];
  input: unknown[];
  startTime: string;
  endTime?: string;
}

interface TurnAcc {
  key: string;
  index: number;
  offset: number;
  startTime: string;
  lastTime: string;
  model?: string;
  prompt?: string;
  promptFallback?: string;
  finalMessage?: string;
  complete: boolean;
  durationMs?: number;
  ttftMs?: number;
  meta: Record<string, unknown>;
  gens: GenerationStep[];
  pending?: GenAcc;
  tools: Map<string, ToolAcc>;
  commands: Array<{ time: string; data: unknown }>;
  events: TurnEvent[];
  boundary: string; // time the next model call's input became ready
}

const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call', 'mcp_tool_call']);

function parseArgs(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch {
      /* keep raw */
    }
  }
  return v;
}

function outputText(o: unknown): string {
  if (typeof o === 'string') return o;
  if (Array.isArray(o)) return contentText(o);
  if (o && typeof o === 'object') {
    const r = o as Record<string, unknown>;
    if (typeof r.content === 'string') return r.content;
    if (Array.isArray(r.content)) return contentText(r.content);
    return JSON.stringify(o);
  }
  return String(o ?? '');
}

function codexUsage(u: any): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cached = n(u.cached_input_tokens);
  const reasoning = n(u.reasoning_output_tokens);
  const out: Usage = {
    input: Math.max(0, n(u.input_tokens) - cached),
    output: Math.max(0, n(u.output_tokens) - reasoning),
  };
  if (cached) out.input_cached_tokens = cached;
  if (n(u.cache_write_input_tokens)) out.input_cache_write_tokens = n(u.cache_write_input_tokens);
  if (reasoning) out.output_reasoning_tokens = reasoning;
  out.total = n(u.total_tokens) || n(u.input_tokens) + n(u.output_tokens);
  return out;
}

export interface CodexParseOptions {
  sessionId: string;
  turnsBefore: number;
  context: CodexContext;
}

export function parseCodexRollout(entries: JsonlEntry[], opts: CodexParseOptions): { turns: Turn[]; context: CodexContext } {
  const ctx: CodexContext = { ...opts.context };
  const turns: TurnAcc[] = [];
  const byId = new Map<string, TurnAcc>();
  let cur: TurnAcc | undefined;

  const turnFor = (id: string, offset: number, ts: string): TurnAcc => {
    let t = byId.get(id);
    if (!t) {
      if (cur && !cur.complete) cur.complete = true;
      t = {
        key: id,
        index: opts.turnsBefore + turns.length + 1,
        offset,
        startTime: ts,
        lastTime: ts,
        complete: false,
        meta: {},
        gens: [],
        tools: new Map(),
        commands: [],
        events: [],
        boundary: ts,
      };
      byId.set(id, t);
      turns.push(t);
    }
    return t;
  };

  const closeGen = (t: TurnAcc, key: string, ts: string, usage?: Usage) => {
    const p = t.pending;
    if (!p) return;
    t.gens.push({
      kind: 'generation',
      key,
      name: t.model ? `Codex (${t.model})` : 'Codex',
      model: t.model,
      startTime: p.startTime,
      endTime: p.endTime ?? ts,
      input: p.input,
      output: { role: 'assistant', content: p.outputs },
      usage,
    });
    t.pending = undefined;
    t.boundary = ts;
  };

  const pendingGen = (t: TurnAcc, ts: string): GenAcc => {
    if (!t.pending) t.pending = { outputs: [], input: [], startTime: t.boundary };
    t.pending.endTime = ts;
    return t.pending;
  };

  // input waiting for the next model call
  let nextInput: unknown[] = [];

  for (const { offset, value: o } of entries) {
    if (!o || typeof o !== 'object') continue;
    const p = o.payload ?? {};
    const ts: string = o.timestamp ?? new Date().toISOString();

    if (o.type === 'session_meta') {
      ctx.cwd = p.cwd ?? ctx.cwd;
      ctx.cliVersion = p.cli_version ?? ctx.cliVersion;
      ctx.originator = p.originator ?? ctx.originator;
      ctx.modelProvider = p.model_provider ?? ctx.modelProvider;
      ctx.source = p.source ?? ctx.source;
      continue;
    }

    if (o.type === 'event_msg' && p.type === 'task_started' && p.turn_id) {
      cur = turnFor(p.turn_id, offset, ts);
      cur.meta.trigger = p.turn_attribution?.turn_trigger;
      nextInput = [];
      continue;
    }
    if (o.type === 'turn_context' && p.turn_id) {
      const t = turnFor(p.turn_id, offset, ts);
      t.model = p.model ?? t.model;
      t.meta.approvalPolicy = p.approval_policy;
      t.meta.sandbox = p.sandbox_policy?.type ?? p.permission_profile?.type;
      t.meta.cwd = p.cwd;
      cur = t;
      continue;
    }
    if (!cur) continue;
    const t = cur;
    if (ts > t.lastTime) t.lastTime = ts;

    if (o.type === 'event_msg') {
      switch (p.type) {
        case 'item_completed': {
          const it = p.item ?? {};
          if (it.type === 'UserMessage') {
            t.prompt = contentText(it.content);
            nextInput.push({ role: 'user', content: t.prompt });
            t.boundary = ts;
          } else if (it.type === 'AgentMessage' && it.phase === 'final_answer') {
            t.finalMessage = contentText(it.content);
          } else if (it.type === 'CommandExecution') {
            t.commands.push({
              time: ts,
              data: {
                command: Array.isArray(it.parsed_cmd) && it.parsed_cmd[0]?.cmd ? it.parsed_cmd.map((c: any) => c.cmd).join(' && ') : it.command,
                exitCode: it.exit_code,
                durationMs: it.duration ? Math.round((it.duration.secs ?? 0) * 1000 + (it.duration.nanos ?? 0) / 1e6) : undefined,
                output: it.aggregated_output,
              },
            });
          }
          break;
        }
        case 'task_complete':
          t.complete = true;
          t.durationMs = p.duration_ms;
          t.ttftMs = p.time_to_first_token_ms;
          if (p.last_agent_message) t.finalMessage = p.last_agent_message;
          break;
        case 'turn_aborted':
          t.complete = true;
          t.events.push({ key: `aborted-${offset}`, name: 'Turn aborted', time: ts, input: p.reason, level: 'WARNING' });
          break;
        case 'error':
        case 'stream_error':
          t.events.push({ key: `error-${offset}`, name: `Error`, time: ts, input: p.message ?? p, level: 'ERROR' });
          break;
        case 'exec_approval_request':
        case 'apply_patch_approval_request':
          t.events.push({ key: `approval-${offset}`, name: 'Approval requested', time: ts, input: p });
          break;
        default:
          break;
      }
      continue;
    }

    if (o.type === 'response_item') {
      if (p.type === 'message') {
        const text = contentText(p.content);
        if (p.role === 'assistant') {
          pendingGen(t, ts).outputs.push({ type: 'text', text });
        } else if (p.role === 'user' && text && !text.trimStart().startsWith('<')) {
          t.promptFallback ??= text;
        }
      } else if (p.type === 'reasoning') {
        const summary = Array.isArray(p.summary) ? p.summary.map((s: any) => s?.text).filter(Boolean).join('\n') : '';
        pendingGen(t, ts).outputs.push({ type: 'thinking', thinking: summary || '[encrypted reasoning]' });
      } else if (CALL_TYPES.has(p.type)) {
        const key = p.call_id ?? p.id ?? `call-${offset}`;
        const name = p.name ?? p.type.replace(/_call$/, '');
        const input = parseArgs(p.arguments ?? p.input ?? p.action ?? p.query);
        pendingGen(t, ts).outputs.push({ type: 'tool_call', id: key, name, input });
        t.tools.set(key, { key, name, startTime: ts, input, commands: [] });
      } else if (typeof p.type === 'string' && p.type.endsWith('_output')) {
        const key = p.call_id ?? p.id;
        const tool = key ? t.tools.get(key) : undefined;
        const text = outputText(p.output);
        if (tool) {
          tool.output = text;
          tool.endTime = ts;
          const success = (p.output && typeof p.output === 'object' && 'success' in p.output) ? (p.output as any).success : undefined;
          tool.isError = success === false || /\bexit code:?\s*[1-9]/i.test(text.slice(0, 200));
        }
        nextInput.push({ role: 'tool', tool: tool?.name, call_id: key, content: text });
        t.boundary = ts;
      }
      // hand accumulated input to the model call now in progress
      if (t.pending && nextInput.length && t.pending.input.length === 0) {
        t.pending.input = nextInput;
        nextInput = [];
      }
      continue;
    }

    if (o.type === 'token_usage_record') {
      if (t.pending && t.pending.input.length === 0 && nextInput.length) {
        t.pending.input = nextInput;
        nextInput = [];
      }
      closeGen(t, p.response_id ?? `resp-${offset}`, ts, codexUsage(p.usage));
    }
  }

  // close dangling generations (turn still running, or no usage record)
  for (const t of turns) {
    if (t.pending) closeGen(t, `pending-${t.gens.length}`, t.lastTime);
  }

  return { turns: turns.map((t) => finalize(t, ctx, opts.sessionId)), context: ctx };
}

function finalize(t: TurnAcc, ctx: CodexContext, sessionId: string): Turn {
  for (const c of t.commands) {
    const tool = [...t.tools.values()].find((x) => x.startTime <= c.time && (!x.endTime || c.time <= x.endTime));
    if (tool) tool.commands.push(c.data);
  }
  const tools: ToolStep[] = [...t.tools.values()].map((x) => ({
    kind: 'tool',
    key: x.key,
    name: x.name,
    startTime: x.startTime,
    endTime: x.endTime,
    input: x.input,
    output: x.output,
    isError: x.isError,
    metadata: x.commands.length ? { commands: x.commands } : undefined,
  }));
  const steps: Array<GenerationStep | ToolStep> = [...t.gens, ...tools].sort((a, b) =>
    a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0,
  );
  const lastText = [...t.gens]
    .reverse()
    .map((g) => ((g.output as any)?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'))
    .find((s) => s);
  return {
    key: t.key,
    index: t.index,
    sessionId,
    startTime: t.startTime,
    endTime: t.lastTime,
    input: t.prompt ?? t.promptFallback,
    output: t.finalMessage ?? lastText,
    complete: t.complete,
    steps,
    events: t.events,
    offset: t.offset,
    metadata: {
      agent: 'codex',
      cwd: t.meta.cwd ?? ctx.cwd,
      agentVersion: ctx.cliVersion,
      originator: ctx.originator,
      modelProvider: ctx.modelProvider,
      source: ctx.source,
      model: t.model,
      approvalPolicy: t.meta.approvalPolicy,
      sandbox: t.meta.sandbox,
      trigger: t.meta.trigger,
      durationMs: t.durationMs,
      timeToFirstTokenMs: t.ttftMs,
      generationCount: t.gens.length,
      toolCount: t.tools.size,
    },
  };
}

/** Find the rollout file for a session when the hook payload has no transcript_path. */
export function findCodexRollout(codexHome: string, sessionId: string, maxDays = 14): string | undefined {
  const root = join(codexHome, 'sessions');
  if (!existsSync(root) || !sessionId) return undefined;
  const desc = (dir: string) => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  let days = 0;
  for (const y of desc(root)) {
    for (const m of desc(join(root, y))) {
      for (const d of desc(join(root, y, m))) {
        const dir = join(root, y, m, d);
        const hit = desc(dir).find((f) => f.endsWith(`${sessionId}.jsonl`));
        if (hit) return join(dir, hit);
        if (++days >= maxDays) return undefined;
      }
    }
  }
  return undefined;
}
