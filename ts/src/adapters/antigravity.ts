import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonlFrom, type JsonlEntry } from '../core/jsonl.ts';
import type { GenerationStep, SubAgentRun, ToolStep } from '../core/types.ts';

const CONVERSATION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/**
 * `invoke_subagent` runs a sub-agent in a conversation of its own. The tool's
 * result names that conversation, and its transcript sits beside the parent's:
 * brain/<conversation>/.system_generated/logs/transcript.jsonl.
 */
export function antigravitySubagentTranscript(parentTranscript: string, toolResult: unknown): { id: string; path: string } | undefined {
  const id = CONVERSATION_ID.exec(typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult ?? ''))?.[0];
  if (!id) return undefined;
  // <brain>/<parent conversation>/.system_generated/logs/transcript.jsonl
  const brain = dirname(dirname(dirname(dirname(parentTranscript))));
  const path = join(brain, id, '.system_generated', 'logs', 'transcript.jsonl');
  return existsSync(path) && path !== parentTranscript ? { id, path } : undefined;
}

/**
 * A sub-agent conversation as one run. No hooks fire inside it, so its steps
 * come from the transcript alone: model calls with their token counts, and the
 * tool calls each one requested. A tool result is paired only when the model
 * call requested a single tool and the next step is its result; otherwise the
 * tool is closed at the next model call without an output.
 */
export function readAntigravitySubagent(path: string, id: string, typeName: unknown, parentToolKey: string): SubAgentRun | undefined {
  // The type arrives JSON-encoded ("\"research\""). Anything that is not a short label is not used as a name.
  const label = typeof typeName === 'string' ? typeName.trim().replace(/^"+|"+$/g, '') : '';
  const name = /^[\w.-]{1,40}$/.test(label) ? label : 'subagent';
  const rows = readJsonlFrom(path).entries.map(entry => entry.value).filter(row => row && Number.isSafeInteger(row.step_index));
  const models = rows.filter(row => row.type === 'PLANNER_RESPONSE');
  if (!models.length) return undefined;
  const first = rows[0];
  const steps: Array<GenerationStep | ToolStep> = [];
  let pending: unknown[] = [];
  for (const [i, row] of models.entries()) {
    const at = typeof row.created_at === 'string' ? row.created_at : first.created_at;
    const nextAt = models[i + 1]?.created_at;
    const calls: Array<{ name?: unknown; args?: unknown }> = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    const issued = calls.map((call, index) => ({ type: 'tool_call', id: `${row.step_index}:${index}`, name: call?.name, input: call?.args }));
    steps.push({ kind: 'generation', key: String(row.step_index), name: row.model || 'Antigravity', model: row.model, startTime: at, endTime: at,
      input: pending, output: { text: row.content, content: issued },
      usage: { input: row.input_tokens ?? 0, input_cached_tokens: row.cache_read_tokens ?? 0, output: row.output_tokens ?? 0 },
      metadata: { stepIndex: row.step_index, timestampSource: 'transcript' } });
    pending = [];
    const result = calls.length === 1 ? rows.find(candidate => candidate.type === 'GENERIC' && candidate.step_index === row.step_index + 1) : undefined;
    for (const [index, call] of calls.entries()) {
      const key = `${row.step_index}:${index}`;
      const tool: ToolStep = { kind: 'tool', key, name: typeof call?.name === 'string' ? call.name : 'tool', startTime: at,
        endTime: result?.created_at ?? nextAt ?? at, input: call?.args, output: result?.content,
        metadata: { stepIndex: row.step_index, resultSource: result ? 'transcript' : 'unavailable' } };
      steps.push(tool);
      if (result) pending.push({ role: 'tool', call_id: key, content: result.content });
    }
  }
  const last = rows.at(-1);
  return { key: id, name, startTime: first.created_at ?? models[0].created_at, endTime: last?.created_at ?? models.at(-1)!.created_at,
    input: rows.find(row => row.type === 'USER_INPUT')?.content, output: models.findLast(row => typeof row.content === 'string' && row.content)?.content,
    complete: true, parentToolKey, steps, events: [], metadata: { agentType: name, conversationId: id, toolResultCorrelation: 'single-call only' } };
}

/** Antigravity 1.5 transcript. GENERIC steps have no stable tool-call ID. */
export function auditAntigravity(entries: JsonlEntry[]) {
  const counts: Record<string, number> = {};
  const seen = new Set<number>();
  let previousIndex = -1;
  let userTurns = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let genericSteps = 0;
  let totalInput = 0;
  let cacheRead = 0;
  let output = 0;
  const count = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
  for (const { value } of entries) {
    if (!value || !Number.isInteger(value.step_index) || value.step_index < 0) continue;
    const i = value.step_index as number;
    if (seen.has(i)) {
      count('duplicate_step_index');
      continue;
    }
    if (i < previousIndex) count('step_index_out_of_order');
    previousIndex = i;
    seen.add(i);
    if (value.type === 'USER_INPUT') userTurns++;
    if (value.type === 'GENERIC') genericSteps++;
    if (value.type !== 'PLANNER_RESPONSE') continue;
    modelCalls++;
    toolCalls += Array.isArray(value.tool_calls) ? value.tool_calls.length : 0;
    if (Number.isFinite(value.input_tokens)) totalInput += value.input_tokens;
    if (Number.isFinite(value.cache_read_tokens)) cacheRead += value.cache_read_tokens;
    if (Number.isFinite(value.output_tokens)) output += value.output_tokens;
  }
  return { steps: seen.size, userTurns, modelCalls, toolCalls, genericSteps, totalInput,
    cacheRead, output, toolResultCorrelation: 'unavailable', counts };
}
