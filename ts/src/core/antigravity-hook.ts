import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { antigravitySubagentTranscript, readAntigravitySubagent } from '../adapters/antigravity.ts';
import { stableId } from './ids.ts';
import { loadConfig } from './config.ts';
import { batchOptions } from './run.ts';
import { readJsonlFrom } from './jsonl.ts';
import { turnToEvents } from './batch.ts';
import { createLogger } from './log.ts';
import { canExport, exportEvents } from './export.ts';
import { sanitize } from './text.ts';
import type { ToolStep, Turn } from './types.ts';

export type AntigravityPhase = 'PreToolUse' | 'PostToolUse' | 'PreInvocation' | 'PostInvocation' | 'Stop';
interface Sample {
  step: number;
  time: string;
  name: string;
  args?: unknown;
  error?: string;
}

export async function runAntigravityHook(phase: AntigravityPhase, payload: Record<string, unknown>): Promise<void> {
  const env = { ...process.env };
  const config = loadConfig('antigravity', env);
  if (!canExport(config)) return;
  const session = payload.conversationId;
  if (typeof session !== 'string' || !session) return;
  const captureContent = env.LANGFUSE_HOOK_CAPTURE_CONTENT === 'true';
  const stateRoot = env.LANGFUSE_ANTIGRAVITY_STATE_DIR || join(config.agentHome, 'state', 'langfuse');
  const directory = join(stateRoot, stableId('antigravity', session));
  mkdirSync(directory, { recursive: true });
  const log = createLogger(join(stateRoot, 'hook.log'), config.debug);
  log.debug('Antigravity ' + phase);
  if (phase === 'PreInvocation' || phase === 'PostInvocation') {
    const { initialNumSteps, invocationNum } = payload;
    if (typeof initialNumSteps !== 'number' || !Number.isSafeInteger(initialNumSteps) || initialNumSteps < 0
      || typeof invocationNum !== 'number' || !Number.isSafeInteger(invocationNum) || invocationNum < 0) return;
    writeFileSync(join(directory, `inv-${initialNumSteps}-${invocationNum}-${phase}.json`),
      JSON.stringify({ time: new Date().toISOString() }), 'utf8');
    return;
  }
  if (phase !== 'Stop') {
    const step = payload.stepIdx;
    const tool = payload.toolCall as { name?: unknown; args?: unknown } | undefined;
    if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0 || typeof tool?.name !== 'string') return;
    const sample: Sample = { step, time: new Date().toISOString(), name: tool.name,
      args: captureContent ? sanitize(tool.args, config) : undefined,
      error: typeof payload.error === 'string' && payload.error ? (captureContent ? String(sanitize(payload.error, config)) : 'Tool failed') : undefined };
    writeFileSync(join(directory, step + '-' + phase + '.json'), JSON.stringify(sample), 'utf8');
    return;
  }
  if (payload.fullyIdle === false) return;
  const path = payload.transcriptPath;
  if (typeof path !== 'string' || !existsSync(path)) {
    log.error('Antigravity Stop: transcript unavailable');
    return;
  }
  const rows = readJsonlFrom(path).entries.map((entry) => entry.value);
  const first = rows.findLastIndex((row) => row?.type === 'USER_INPUT' && Number.isSafeInteger(row.step_index));
  if (first < 0) return;
  const segment = rows.slice(first);
  const user = segment[0];
  const time = new Date().toISOString();
  const turn: Turn = { key: String(user.step_index), index: rows.slice(0, first + 1).filter((r) => r?.type === 'USER_INPUT').length,
    sessionId: session, startTime: user.created_at || time, endTime: time, offset: 0, input: user.content,
    complete: true, events: [], steps: [], toolResults: [],
    metadata: { agent: 'antigravity', terminationReason: payload.terminationReason } };
  if (typeof payload.error === 'string' && payload.error || ['error', 'max_steps_exceeded', 'cancelled', 'interrupted'].includes(String(payload.terminationReason))) {
    turn.events.push({ key: 'interrupted', name: 'Interrupted Antigravity execution', time, level: 'WARNING' });
  }

  const steps = new Map<number, { pre?: Sample; post?: Sample }>();
  const consumedFiles: string[] = [];
  const invocations = new Map<number, { pre?: string; post?: string }>();
  for (const name of readdirSync(directory)) {
    const invocation = /^inv-(\d+)-(\d+)-(PreInvocation|PostInvocation)\.json$/.exec(name);
    if (invocation && Number(invocation[1]) >= user.step_index) {
      const initial = Number(invocation[1]);
      const sample = JSON.parse(readFileSync(join(directory, name), 'utf8')) as { time: string };
      const timing = invocations.get(initial) ?? {};
      if (invocation[3] === 'PreInvocation') timing.pre = sample.time;
      else timing.post = sample.time;
      invocations.set(initial, timing);
      consumedFiles.push(name);
      continue;
    }
    const match = /^(\d+)-(PreToolUse|PostToolUse)\.json$/.exec(name);
    if (!match || Number(match[1]) < user.step_index) continue;
    const sample = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Sample;
    const phases = steps.get(sample.step) ?? {};
    if (match[2] === 'PreToolUse') phases.pre = sample;
    else phases.post = sample;
    steps.set(sample.step, phases);
    consumedFiles.push(name);
  }

  const toolSteps = new Map<number, ToolStep>();
  const transcript = new Map(segment.filter((r) => Number.isSafeInteger(r?.step_index)).map((r) => [r.step_index, r]));
  for (const [index, { pre, post }] of steps) {
    const key = String(index);
    if (post) turn.toolResults?.push({ key, time: post.time });
    if (!pre) continue;
    const row = transcript.get(index);
    // Exact hook step index is required. Never pair GENERIC outputs by array position.
    const output = row?.type === 'GENERIC' ? row.content : undefined;
    const step: ToolStep = { kind: 'tool', key, name: pre.name, startTime: pre.time, endTime: post?.time,
      input: pre.args, output: output ?? post?.error, isError: Boolean(post?.error),
      metadata: { stepIndex: index, resultSource: output !== undefined ? 'transcript' : undefined } };
    toolSteps.set(index, step);
  }

  const generations = segment.filter((r) => r?.type === 'PLANNER_RESPONSE' && Number.isSafeInteger(r.step_index));
  for (const [i, g] of generations.entries()) {
    const prev = generations[i - 1]?.step_index ?? user.step_index;
    const next = generations[i + 1]?.step_index ?? Infinity;
    const at = g.created_at || turn.startTime;
    const timing = invocations.get(g.step_index);
    const input: unknown[] = i === 0 ? [{ role: 'user', content: user.content }] : [];
    const issued = [];
    let firstToolStart: string | undefined;
    for (const [index, tool] of toolSteps) {
      if (index > prev && index < g.step_index && tool.endTime) {
        input.push({ role: 'tool', call_id: tool.key, content: tool.output });
      }
      if (index > g.step_index && index < next) {
        issued.push({ type: 'tool_call', id: tool.key, name: tool.name, input: tool.input });
        if (!firstToolStart || tool.startTime < firstToolStart) firstToolStart = tool.startTime;
      }
    }
    // PostInvocation can fire after the tools it dispatched have already run.
    const generationEnd = firstToolStart && (!timing?.post || firstToolStart < timing.post) ? firstToolStart : timing?.post;
    turn.steps.push({ kind: 'generation', key: String(g.step_index), name: g.model || 'Antigravity',
      model: g.model, startTime: timing?.pre ?? at, endTime: generationEnd ?? at, input, output: { text: g.content, content: issued },
      usage: { input: g.input_tokens ?? 0, input_cached_tokens: g.cache_read_tokens ?? 0, output: g.output_tokens ?? 0 },
      metadata: { stepIndex: g.step_index, timestampSource: timing?.pre ? 'native-hook' : 'transcript',
        postInvocationTime: timing?.post, reportedToolCalls: g.tool_calls?.length ?? 0 } });
  }
  // A sub-agent's work is in a conversation of its own, named by the tool result.
  if (config.subagents) {
    for (const [index, tool] of toolSteps) {
      if (tool.name !== 'invoke_subagent') continue;
      try {
        const sub = antigravitySubagentTranscript(path, transcript.get(index)?.content ?? tool.output);
        if (!sub) continue;
        // The type name the model asked for; the role text is free-form, so it is not used as a name.
        const asked = generations.flatMap((g) => (Array.isArray(g.tool_calls) ? g.tool_calls : []))
          .find((call: { name?: unknown; args?: { TypeName?: unknown } }) => call?.name === 'invoke_subagent' && typeof call.args?.TypeName === 'string');
        const run = readAntigravitySubagent(sub.path, sub.id, asked?.args?.TypeName || 'subagent', tool.key);
        if (run) (turn.children ??= []).push(run);
      } catch {
        log.debug('Antigravity sub-agent transcript could not be read');
      }
    }
  }
  turn.steps.push(...toolSteps.values());
  turn.steps.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  turn.output = generations.findLast((g) => typeof g.content === 'string')?.content;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const response = await exportEvents(config, turnToEvents(turn, { ...batchOptions(config), captureContent }), log, cwd);
  if (!response.ok) log.error('Antigravity trace ingestion failed (' + response.errors.map(e => e.status ?? e.message).join(', ') + ')');
  else {
    for (const name of consumedFiles) unlinkSync(join(directory, name));
    log.debug('Antigravity trace exported');
  }
}
