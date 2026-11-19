import type { JsonlEntry } from '../core/jsonl.ts';

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
