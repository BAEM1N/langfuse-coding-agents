import type { JsonlEntry } from '../core/jsonl.ts';
import type { ToolStep, Turn, TurnEvent, Usage } from '../core/types.ts';

function iso(value: unknown): string | undefined {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : undefined;
}

/** Follow the active OMP branch. Superseded branches are not part of its tool timeline. */
function activeEntries(entries: JsonlEntry[]): JsonlEntry[] {
  const indexed = new Map(entries.filter(({ value }) => typeof value?.id === 'string' && value.type !== 'session')
    .map((entry) => [entry.value.id as string, entry]));
  const latest = [...indexed.values()].at(-1);
  if (!latest || !('parentId' in latest.value)) return entries;
  const active = new Set<JsonlEntry>();
  for (let entry: JsonlEntry | undefined = latest; entry && !active.has(entry); entry = indexed.get(entry.value.parentId)) {
    active.add(entry);
  }
  return entries.filter((entry) => active.has(entry) || entry.value?.type === 'session');
}

function usageDetails(raw: Record<string, unknown> | undefined): Usage | undefined {
  if (!raw) return undefined;
  const result: Usage = {};
  for (const [from, to] of Object.entries({ input: 'input', output: 'output', cacheRead: 'input_cached_tokens',
    cacheWrite: 'input_cache_creation', totalTokens: 'total' })) {
    const n = raw[from];
    if (typeof n === 'number') result[to] = n;
  }
  return result;
}

export function parseOmpSession(entries: JsonlEntry[], fallbackSessionId: string): Turn[] {
  const turns: Turn[] = [];
  let sessionId = fallbackSessionId;
  let turn: Turn | undefined;
  let tools = new Map<string, ToolStep>();
  let pending: unknown[] = [];

  for (const { value: row, offset } of activeEntries(entries)) {
    if (!row || typeof row !== 'object') continue;
    if (row.type === 'session' && typeof row.id === 'string') sessionId = row.id;
    const msg = row.type === 'message' ? row.message : undefined;
    const time = iso(msg?.timestamp) ?? iso(row.timestamp);
    if (msg?.role === 'user' && time) {
      if (turn && !turn.complete) {
        pending.push({ role: 'user', content: msg.content });
        turn.endTime = time;
        continue;
      }
      turn = { key: row.id ?? String(offset), index: turns.length + 1, sessionId,
        startTime: time, endTime: time, offset, input: msg.content, complete: false,
        steps: [], events: [], toolResults: [], metadata: { agent: 'oh-my-pi' } };
      turns.push(turn);
      tools = new Map();
      pending = [{ role: 'user', content: msg.content }];
      continue;
    }
    if (!turn) continue;
    if (row.type === 'custom' && row.customType === 'tool_execution_start') {
      const tool = tools.get(row.data?.toolCallId);
      const started = iso(row.data?.startedAt) ?? time;
      if (tool && started) tool.startTime = started;
      continue;
    }
    if (!msg || !time) continue;
    const end = iso(msg.completedAt) ?? time;
    if (end > turn.endTime) turn.endTime = end;
    if (msg.role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      turn.steps.push({ kind: 'generation', key: row.id ?? String(offset),
        name: msg.model ?? 'OMP', model: msg.model, startTime: time, endTime: end,
        input: pending, output: { content }, usage: usageDetails(msg.usage),
        metadata: { provider: msg.provider, stopReason: msg.stopReason, requestId: msg.responseId } });
      pending = [];
      for (const block of content) {
        if (block?.type !== 'toolCall' || typeof block.id !== 'string' || tools.has(block.id)) continue;
        const tool: ToolStep = { kind: 'tool', key: block.id, name: block.name ?? 'tool',
          startTime: end, input: block.arguments };
        tools.set(tool.key, tool);
        turn.steps.push(tool);
      }
      if (['stop', 'length', 'aborted', 'error'].includes(msg.stopReason)) {
        turn.complete = true;
        turn.output = content.filter((block: { type?: string }) => block?.type === 'text');
        if (msg.stopReason === 'aborted' || msg.stopReason === 'error') {
          const event: TurnEvent = { key: 'stop-' + offset, name: 'Turn ' + msg.stopReason,
            time: end, level: 'WARNING' };
          turn.events.push(event);
        }
      }
    } else if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string') {
      turn.toolResults?.push({ key: msg.toolCallId, time });
      const tool = tools.get(msg.toolCallId);
      if (tool) {
        tool.endTime = time;
        tool.isError = msg.isError === true;
        tool.output = msg.content;
      }
      pending.push({ role: 'tool', call_id: msg.toolCallId, content: msg.content });
    }
  }
  return turns;
}
