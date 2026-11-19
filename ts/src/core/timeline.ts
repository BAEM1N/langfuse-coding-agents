import type { GenerationStep, ToolStep, Turn, TurnEvent } from './types.ts';

interface ToolLinks {
  issuedBy?: GenerationStep;
  consumedBy?: GenerationStep;
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object');
}

function outputBlocks(value: unknown): Array<Record<string, unknown>> {
  if (value && typeof value === 'object' && 'content' in value) return records(value.content);
  return records(value);
}

/** Correlate by call ID. Concurrent tools and equal transcript timestamps are valid. */
export function analyzeTimeline(turn: Turn): { links: Map<string, ToolLinks>; issues: TurnEvent[] } {
  const links = new Map<string, ToolLinks>();
  const tools = new Map<string, ToolStep>();
  const observed = new Map<string, string | undefined>();
  const issues = new Map<string, TurnEvent>();
  const report = (code: string, key: string, time: string, kind: string) => {
    const id = 'timeline:' + code + ':' + key;
    issues.set(id, { key: id, name: code, time, level: 'WARNING',
      metadata: { category: 'timeline', code, kind } });
  };

  if (Date.parse(turn.endTime) < Date.parse(turn.startTime)) {
    report('turn_end_before_start', turn.key, turn.startTime, 'turn');
  }
  for (const step of turn.steps) {
    if (step.endTime && Date.parse(step.endTime) < Date.parse(step.startTime)) {
      report('step_end_before_start', step.key, step.startTime, step.kind);
    }
    if (step.kind === 'tool') {
      tools.set(step.key, step);
      continue;
    }
    for (const block of outputBlocks(step.output)) {
      if (!['tool_use', 'tool_call', 'toolCall'].includes(String(block.type)) || typeof block.id !== 'string') continue;
      const link = links.get(block.id) ?? {};
      link.issuedBy ??= step;
      links.set(block.id, link);
    }
    for (const block of records(step.input)) {
      const key = block.tool_use_id ?? block.call_id;
      if (block.role !== 'tool' || typeof key !== 'string') continue;
      const link = links.get(key) ?? {};
      link.consumedBy ??= step;
      links.set(key, link);
    }
  }
  for (const result of turn.toolResults ?? []) {
    if (observed.has(result.key)) {
      report('duplicate_tool_result', result.key, result.time ?? turn.startTime, 'tool');
      continue;
    }
    observed.set(result.key, result.time);
  }

  const cancelled = turn.events.some((event) => /abort|interrupt|cancel/i.test(event.name));
  const keys = new Set([...tools.keys(), ...observed.keys(), ...links.keys()]);
  for (const key of keys) {
    const tool = tools.get(key);
    const link = links.get(key);
    const callTime = tool?.startTime ?? link?.issuedBy?.startTime;
    const resultTime = observed.get(key) ?? tool?.endTime;
    const hasResult = observed.has(key) || Boolean(tool?.endTime || link?.consumedBy);
    if (link?.issuedBy && link.consumedBy
      && Date.parse(link.consumedBy.startTime) < Date.parse(link.issuedBy.startTime)) {
      report('tool_consumed_before_call', key, callTime ?? turn.startTime, 'tool');
    }
    if (callTime && resultTime && Date.parse(resultTime) < Date.parse(callTime)) {
      report('tool_result_before_call', key, callTime, 'tool');
    } else if (turn.complete && !cancelled && callTime && !hasResult) {
      report('tool_result_missing', key, turn.endTime, 'tool');
    } else if (turn.complete && !cancelled && !callTime && hasResult) {
      report('tool_call_missing', key, resultTime ?? link?.consumedBy?.startTime ?? turn.startTime, 'tool');
    }
  }
  return { links, issues: [...issues.values()] };
}
