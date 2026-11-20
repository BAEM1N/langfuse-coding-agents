import { setTimeout as wait } from 'node:timers/promises';
import { readJsonlFrom, type JsonlEntry } from '../core/jsonl.ts';
import type { SubAgentRun, ToolStep, Turn, Usage } from '../core/types.ts';

export async function readCopilotTurn(path: string, sessionId: string, stoppedAt: string): Promise<Turn | undefined> {
  // agentStop can run before the final response and usage reach the transcript.
  const deadline = performance.now() + 750;
  let turn: Turn | undefined;
  do {
    turn = parseCopilotTurn(readJsonlFrom(path).entries, sessionId, stoppedAt);
    const last = turn?.steps.at(-1);
    if (last?.kind === 'generation' && last.usage && turn?.output !== undefined) {
      const output = last.output as { content: unknown[] };
      if (!output.content.length) return turn;
    }
    if (performance.now() >= deadline) return turn;
    await wait(75);
  } while (true);
}

function usageOf(source: Record<string, unknown> | undefined): Usage | undefined {
  if (!source || typeof source.inputTokens !== 'number' || typeof source.outputTokens !== 'number') return;
  const read = typeof source.cacheReadTokens === 'number' ? source.cacheReadTokens : 0;
  const write = typeof source.cacheWriteTokens === 'number' ? source.cacheWriteTokens : 0;
  return { input: Math.max(0, source.inputTokens - read - write), output: source.outputTokens,
    input_cached_tokens: read, input_cache_creation: write, total: source.inputTokens + source.outputTokens };
}

/**
 * Read the latest main-agent interaction from Copilot CLI's native event log.
 * A sub-agent (the task tool, a custom agent) writes its events to the same
 * log with an `agentId` on the envelope; those are read as runs of their own
 * and attached to the tool call named by `subagent.started`.
 */
export function parseCopilotTurn(entries: JsonlEntry[], sessionId: string, stoppedAt: string): Turn | undefined {
  const main = entries.filter(entry => !entry.value?.agentId);
  const isUser = (entry: JsonlEntry) => entry.value?.type === 'user.message' && entry.value.data?.hasSubmittedTask !== false;
  const userIndex = main.findLastIndex(isUser);
  if (userIndex < 0) return;
  const user = main[userIndex].value;
  if (typeof user.timestamp !== 'string' || typeof user.data?.messageId !== 'string') return;
  const interaction = user.data.interactionId;
  const turn: Turn = { key: user.data.messageId, index: main.slice(0, userIndex + 1).filter(isUser).length,
    sessionId, startTime: user.timestamp, endTime: stoppedAt, offset: main[userIndex].offset,
    input: user.data.content, complete: true, steps: [], toolResults: [], events: [], metadata: { agent: 'copilot' } };
  const after = entries.slice(entries.indexOf(main[userIndex]) + 1).map(entry => entry.value);
  const usages = new Map<string, Record<string, unknown>>();
  for (const record of after) {
    const usage = record?.data?.usage;
    if (record?.type === 'session.usage_record' && typeof usage?.apiCallId === 'string') usages.set(usage.apiCallId, usage);
  }
  const mainSteps = readSteps(after.filter(record => !record?.agentId), usages, user.data.transformedContent ?? user.data.content, interaction);
  turn.steps = mainSteps.steps;
  turn.toolResults = mainSteps.toolResults;
  turn.output = mainSteps.output;

  // Sub-agent runs started during this interaction.
  const byAgent = new Map<string, any[]>();
  for (const record of after) {
    if (typeof record?.agentId !== 'string') continue;
    const list = byAgent.get(record.agentId);
    if (list) list.push(record); else byAgent.set(record.agentId, [record]);
  }
  for (const [agentId, records] of byAgent) {
    const started = records.find(record => record.type === 'subagent.started');
    if (!started || typeof started.data?.toolCallId !== 'string') continue;
    const ended = records.find(record => record.type === 'subagent.completed' || record.type === 'subagent.failed');
    const prompt = records.find(record => record.type === 'user.message')?.data?.content;
    const run = readSteps(records, usages, prompt, undefined);
    const name = typeof started.data.agentName === 'string' && started.data.agentName ? started.data.agentName : 'agent';
    const child: SubAgentRun = { key: agentId, name, startTime: started.timestamp, endTime: ended?.timestamp ?? records.at(-1)?.timestamp ?? started.timestamp,
      input: prompt, output: run.output, complete: Boolean(ended), parentToolKey: started.data.toolCallId, steps: run.steps,
      toolResults: run.toolResults, events: [], metadata: { agentType: name, model: started.data.model, executionMode: started.data.executionMode,
        reportedTotalTokens: ended?.data?.totalTokens, reportedToolCalls: ended?.data?.totalToolCalls } };
    if (ended?.type === 'subagent.failed') {
      child.events.push({ key: 'failed-' + agentId, name: 'Subagent failed', time: ended.timestamp, level: 'ERROR', input: ended.data?.error });
    }
    (turn.children ??= []).push(child);
  }
  return turn.steps.length ? turn : undefined;
}

/** Model calls and tools of one agent, in log order. */
function readSteps(records: any[], usages: Map<string, Record<string, unknown>>, firstInput: unknown, interaction: unknown) {
  const turn: Pick<Turn, 'steps' | 'toolResults' | 'output'> = { steps: [], toolResults: [] };
  const user = { data: { content: firstInput, transformedContent: firstInput } };
  const starts = new Map<unknown, string>();
  const requested = new Set<string>();
  const tools = new Map<string, ToolStep>();
  const results: Array<{ role: string; call_id: string; content: unknown }> = [];
  for (const record of records) {
    const data = record?.data;
    const time = record?.timestamp;
    if (!data || typeof time !== 'string') continue;
    if (interaction && data.interactionId && data.interactionId !== interaction) continue;
    switch (record.type) {
      case 'assistant.turn_start': starts.set(data.turnId, time); break;
      case 'assistant.message': {
        const calls = Array.isArray(data.toolRequests) ? data.toolRequests.flatMap((call: { toolCallId?: unknown; name?: unknown; arguments?: unknown }) => {
          if (typeof call?.toolCallId !== 'string') return [];
          requested.add(call.toolCallId);
          return [{ type: 'tool_call', id: call.toolCallId, name: call.name, input: call.arguments }];
        }) : [];
        const model = typeof data.model === 'string' ? data.model : undefined;
        const input = turn.steps.length === 0 ? [{ role: 'user', content: user.data.transformedContent ?? user.data.content }] : results.splice(0);
        turn.steps.push({ kind: 'generation', key: data.messageId ?? record.id, name: model ?? 'Copilot model', model,
          startTime: starts.get(data.turnId) ?? time, endTime: time, input,
          output: { text: data.content, content: calls }, usage: usageOf(usages.get(data.apiCallId)),
          metadata: { inputSource: 'transcript', provider: data.providerId } });
        if (typeof data.content === 'string' && data.content.trim()) turn.output = data.content;
        break;
      }
      case 'tool.execution_start': {
        if (!requested.has(data.toolCallId)) break;
        const tool: ToolStep = { kind: 'tool', key: data.toolCallId, name: data.toolName ?? 'tool', startTime: time, input: data.arguments };
        tools.set(tool.key, tool);
        turn.steps.push(tool);
        break;
      }
      case 'tool.execution_complete': {
        const tool = tools.get(data.toolCallId);
        if (!tool) break;
        tool.endTime = time;
        tool.output = data.result?.content ?? data.result ?? data.error;
        tool.isError = data.success === false;
        turn.toolResults?.push({ key: tool.key, time });
        results.push({ role: 'tool', call_id: tool.key, content: tool.output });
        break;
      }
    }
  }
  return turn;
}
