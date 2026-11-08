// Claude Code transcript (~/.claude/projects/<project>/<session>.jsonl) → Turns.
//
// Observed format (Claude Code 2.x):
//  - A turn starts at a `user` entry carrying `turnPosition` (human / task-notification
//    prompts). Older versions lack it; then any non-meta user entry whose content is
//    not only tool_result blocks starts a turn.
//  - One API response is split across several `assistant` lines sharing message.id
//    (one content block per line, identical usage) → merge them into one generation.
//  - Tool results come back as `user` entries with tool_result blocks.
//  - `system` / subtype `turn_duration` marks the end of a turn.
//  - `isSidechain` entries belong to subagents and are skipped here.

import type { JsonlEntry } from '../core/jsonl.ts';
import { contentText } from '../core/text.ts';
import type { GenerationStep, ToolStep, Turn, TurnEvent, Usage } from '../core/types.ts';

interface GenAcc {
  key: string;
  model?: string;
  startTime: string;
  endTime: string;
  blocks: any[];
  usage?: any;
  stopReason?: string;
  requestId?: string;
  input: unknown[];
}

interface ToolAcc {
  key: string;
  name: string;
  startTime: string;
  endTime?: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  result?: unknown;
}

interface TurnAcc {
  key: string;
  index: number;
  offset: number;
  sessionId: string;
  startTime: string;
  lastTime: string;
  prompt: unknown;
  meta: Record<string, unknown>;
  gens: Map<string, GenAcc>;
  tools: Map<string, ToolAcc>;
  events: TurnEvent[];
  pendingInput: unknown[];
  complete: boolean;
  durationMs?: number;
}

export interface ParseOptions {
  sessionId: string;
  turnsBefore: number;
}

function isToolResultOnly(content: unknown): boolean {
  return Array.isArray(content) && content.length > 0 && content.every((b: any) => b?.type === 'tool_result');
}

function isHumanPromptLegacy(v: any): boolean {
  if (v.type !== 'user' || v.isMeta || v.isSidechain || v.sourceToolUseID) return false;
  const c = v.message?.content;
  if (isToolResultOnly(c)) return false;
  const text = contentText(c).trimStart();
  return !!text && !text.startsWith('<command-') && !text.startsWith('[Request interrupted');
}

function promptOf(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  const parts = content.map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : null)).filter(Boolean);
  return parts.length === 1 ? parts[0] : parts.join('\n');
}

function usageDetails(u: any): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const out: Usage = {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  out.input = num(u.input_tokens);
  out.output = num(u.output_tokens);
  if (num(u.cache_read_input_tokens)) out.cache_read_input_tokens = num(u.cache_read_input_tokens);
  if (num(u.cache_creation_input_tokens)) out.cache_creation_input_tokens = num(u.cache_creation_input_tokens);
  out.total = out.input + out.output + (out.cache_read_input_tokens ?? 0) + (out.cache_creation_input_tokens ?? 0);
  return out;
}

function outputOf(blocks: any[]): unknown {
  const content = blocks
    .map((b) => {
      if (b?.type === 'text') return { type: 'text', text: b.text };
      if (b?.type === 'thinking') return { type: 'thinking', thinking: b.thinking };
      if (b?.type === 'redacted_thinking') return { type: 'thinking', thinking: '[redacted]' };
      if (b?.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      return { type: b?.type ?? 'unknown' };
    })
    .filter(Boolean);
  return { role: 'assistant', content };
}

function finalText(t: TurnAcc): string | undefined {
  const gens = [...t.gens.values()];
  for (let i = gens.length - 1; i >= 0; i--) {
    const text = gens[i].blocks
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return undefined;
}

export function parseClaudeTranscript(entries: JsonlEntry[], opts: ParseOptions): Turn[] {
  const useTurnPosition = entries.some((e) => e.value?.type === 'user' && e.value.turnPosition);
  const isBoundary = (v: any) =>
    v.type === 'user' && !v.isMeta && !v.isSidechain && (useTurnPosition ? !!v.turnPosition : isHumanPromptLegacy(v));

  const turns: TurnAcc[] = [];
  let cur: TurnAcc | undefined;

  for (const { offset, value: v } of entries) {
    if (!v || typeof v !== 'object' || v.isSidechain) continue;
    const ts: string | undefined = v.timestamp;

    if (isBoundary(v)) {
      if (cur) cur.complete = true; // a newer prompt means the previous turn ended
      const prompt = promptOf(v.message?.content);
      cur = {
        key: v.promptId ?? v.uuid ?? `offset-${offset}`,
        index: v.turnPosition?.turnIndex ?? opts.turnsBefore + turns.length + 1,
        offset,
        sessionId: v.sessionId ?? opts.sessionId,
        startTime: ts ?? new Date().toISOString(),
        lastTime: ts ?? new Date().toISOString(),
        prompt,
        meta: {
          cwd: v.cwd,
          gitBranch: v.gitBranch || undefined,
          agentVersion: v.version,
          entrypoint: v.entrypoint,
          permissionMode: v.permissionMode,
          promptSource: v.promptSource,
          turnOrigin: v.turnOrigin,
        },
        gens: new Map(),
        tools: new Map(),
        events: [],
        pendingInput: [{ role: 'user', content: prompt }],
        complete: false,
      };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;

    if (v.type === 'assistant' && v.message) {
      const m = v.message;
      const key: string = m.id ?? v.uuid ?? `gen-${offset}`;
      let g = cur.gens.get(key);
      if (!g) {
        g = {
          key,
          model: m.model,
          startTime: cur.lastTime,
          endTime: ts ?? cur.lastTime,
          blocks: [],
          requestId: v.requestId,
          input: cur.pendingInput,
        };
        cur.pendingInput = [];
        cur.gens.set(key, g);
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        g.blocks.push(b);
        if (b?.type === 'tool_use' && b.id) {
          cur.tools.set(b.id, { key: b.id, name: b.name ?? 'tool', startTime: ts ?? g.endTime, input: b.input });
        }
      }
      if (m.usage) g.usage = m.usage;
      if (m.stop_reason) g.stopReason = m.stop_reason;
      if (ts) g.endTime = ts;
      if (m.model === '<synthetic>') g.model = undefined;
    } else if (v.type === 'user') {
      const c = v.message?.content;
      if (Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')) {
        for (const b of c) {
          if (b?.type !== 'tool_result') continue;
          const tool = cur.tools.get(b.tool_use_id);
          const text = contentText(b.content);
          if (tool) {
            tool.output = text;
            tool.isError = !!b.is_error;
            tool.endTime = ts;
          }
          cur.pendingInput.push({ role: 'tool', tool: tool?.name, tool_use_id: b.tool_use_id, content: text, is_error: !!b.is_error || undefined });
        }
      } else if (!v.isMeta) {
        const text = contentText(c);
        if (text) {
          cur.events.push({ key: v.uuid ?? `user-${offset}`, name: text.startsWith('[Request interrupted') ? 'Interrupted' : 'User message', time: ts ?? cur.lastTime, input: text });
          cur.pendingInput.push({ role: 'user', content: text });
        }
      }
    } else if (v.type === 'system') {
      if (v.subtype === 'turn_duration') {
        cur.complete = true;
        cur.durationMs = v.durationMs;
      } else if (v.level === 'error' || v.subtype === 'api_error') {
        cur.events.push({ key: v.uuid ?? `sys-${offset}`, name: `System: ${v.subtype ?? 'error'}`, time: ts ?? cur.lastTime, input: v.content, level: 'ERROR' });
      }
    }
    if (ts && ts > cur.lastTime) cur.lastTime = ts;
  }

  return turns.map((t) => finalize(t));
}

function finalize(t: TurnAcc): Turn {
  const steps: Array<GenerationStep | ToolStep> = [];
  const models = new Set<string>();
  for (const g of t.gens.values()) {
    if (g.model) models.add(g.model);
    steps.push({
      kind: 'generation',
      key: g.key,
      name: g.model ? `Claude (${g.model})` : 'Claude',
      model: g.model,
      startTime: g.startTime,
      endTime: g.endTime,
      input: g.input,
      output: outputOf(g.blocks),
      usage: usageDetails(g.usage),
      metadata: { stopReason: g.stopReason, requestId: g.requestId, serviceTier: g.usage?.service_tier },
      level: g.stopReason === 'max_tokens' ? 'WARNING' : undefined,
      statusMessage: g.stopReason === 'max_tokens' ? 'stopped at max_tokens' : undefined,
    });
  }
  for (const tool of t.tools.values()) {
    steps.push({
      kind: 'tool',
      key: tool.key,
      name: tool.name,
      startTime: tool.startTime,
      endTime: tool.endTime,
      input: tool.input,
      output: tool.output,
      isError: tool.isError,
    });
  }
  steps.sort((a, b) => (a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0));

  return {
    key: t.key,
    index: t.index,
    sessionId: t.sessionId,
    startTime: t.startTime,
    endTime: t.lastTime,
    input: t.prompt,
    output: finalText(t),
    complete: t.complete,
    steps,
    events: t.events,
    offset: t.offset,
    metadata: {
      ...t.meta,
      agent: 'claude-code',
      models: [...models],
      durationMs: t.durationMs,
      generationCount: t.gens.size,
      toolCount: t.tools.size,
    },
  };
}
