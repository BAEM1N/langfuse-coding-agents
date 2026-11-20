import { eventId, stableId } from './ids.ts';
import type { IngestionEvent } from './langfuse.ts';
import { sanitize, type SanitizeOptions } from './text.ts';
import { analyzeTimeline } from './timeline.ts';
import type { GenerationStep, SubAgentRun, ToolStep, Turn, TurnEvent, Usage } from './types.ts';

export interface BatchOptions extends SanitizeOptions {
  agentLabel: string; // "Claude Code"
  agentTag: string; // "claude-code"
  userId: string;
  hostname: string;
  device?: Record<string, string | number>;
  environment?: string;
  release?: string;
  captureContent?: boolean;
  /**
   * Also emit one trace per sub-agent run, so a run can be opened on its own.
   * Its model calls are plain spans without usage: tokens are counted once, on
   * the turn's trace. Default true.
   */
  subagentTraces?: boolean;
}

export function traceIdFor(agentTag: string, sessionId: string, turnKey: string): string {
  return stableId(agentTag, sessionId, turnKey);
}

/** Trace that shows one sub-agent run on its own. */
export function subagentTraceIdFor(agentTag: string, sessionId: string, runKey: string): string {
  return stableId(agentTag, sessionId, 'subagent', runKey);
}

type Step = GenerationStep | ToolStep;

/**
 * Convert a Turn into Langfuse ingestion events:
 *   trace (turn) → agent span → generations / tools (in time order) + events,
 *   with each sub-agent run as an agent span under the tool call that started it.
 * All ids are deterministic so re-sending the same turn upserts it.
 */
export function turnToEvents(turn: Turn, opts: BatchOptions): IngestionEvent[] {
  const s = (v: unknown) => sanitize(v, opts);
  const content = (v: unknown) => opts.captureContent === false ? undefined : s(v);
  const { links, issues } = analyzeTimeline(turn);
  const now = new Date().toISOString();
  const traceId = traceIdFor(opts.agentTag, turn.sessionId, turn.key);
  const rootId = stableId(traceId, 'agent');
  const name = `${opts.agentLabel} - Turn ${turn.index}${turn.complete ? '' : ' (in progress)'}`;
  const ev = (type: string, body: Record<string, unknown>): IngestionEvent => ({
    id: eventId(),
    timestamp: now,
    type,
    body: dropUndefined(body),
  });
  const runs = collectRuns(turn.children);

  const events: IngestionEvent[] = [
    ev('trace-create', {
      id: traceId,
      timestamp: turn.startTime,
      name,
      userId: opts.userId,
      sessionId: turn.sessionId,
      input: content(turn.input),
      output: content(turn.output),
      tags: [opts.agentTag, opts.hostname],
      metadata: s({ ...turn.metadata, complete: turn.complete, turnIndex: turn.index, hostname: opts.hostname,
        device: opts.device, timelineIssueCount: issues.length, subagentRuns: runs.length || undefined }),
      environment: opts.environment,
      release: opts.release,
    }),
    ev('agent-create', {
      id: rootId,
      traceId,
      name: opts.agentLabel,
      startTime: turn.startTime,
      endTime: turn.complete ? turn.endTime : undefined,
      input: content(turn.input),
      output: content(turn.output),
      environment: opts.environment,
    }),
  ];

  /** Steps and events of one agent (the turn itself, or a sub-agent run) under `parentId`. */
  const emit = (trace: string, parentId: string, idOf: (kind: string, key: string) => string, steps: Step[],
    stepLinks: ReturnType<typeof analyzeTimeline>['links'], stepEvents: TurnEvent[], withUsage: boolean): void => {
    for (const step of steps) {
      const id = idOf(step.kind, step.key);
      if (step.kind === 'generation') {
        const usage = step.usage && Object.keys(step.usage).length ? step.usage : undefined;
        events.push(ev(withUsage ? 'generation-create' : 'span-create', {
          id,
          traceId: trace,
          parentObservationId: parentId,
          name: step.name,
          startTime: step.startTime,
          endTime: step.endTime,
          model: withUsage ? step.model : undefined,
          input: content(step.input),
          output: content(step.output),
          usageDetails: withUsage ? usage : undefined,
          // Without usage this is a copy for viewing: say where the tokens are counted.
          metadata: s(withUsage ? step.metadata : { ...step.metadata, model: step.model, usage, usageCountedOnTurnTrace: true }),
          level: step.level,
          statusMessage: step.statusMessage,
          environment: opts.environment,
        }));
      } else {
        const link = stepLinks.get(step.key);
        const generationId = (key?: string) => key ? idOf('generation', key) : undefined;
        events.push(ev('tool-create', {
          id,
          traceId: trace,
          parentObservationId: parentId,
          name: step.name,
          startTime: step.startTime,
          endTime: step.endTime,
          input: content(step.input),
          output: content(step.output),
          metadata: s({ ...step.metadata, toolCallId: step.key,
            issuedByObservationId: generationId(link?.issuedBy?.key),
            consumedByObservationId: generationId(link?.consumedBy?.key),
          }),
          level: step.isError ? 'ERROR' : undefined,
          statusMessage: step.isError ? 'tool returned an error' : undefined,
          environment: opts.environment,
        }));
      }
    }
    for (const e of stepEvents) {
      events.push(ev('event-create', {
        id: idOf('event', e.key),
        traceId: trace,
        parentObservationId: parentId,
        name: e.name,
        startTime: e.time,
        input: content(e.input),
        metadata: s(e.metadata),
        level: e.level,
        environment: opts.environment,
      }));
    }
  };

  emit(traceId, rootId, (kind, key) => stableId(traceId, kind, key), turn.steps, links, [...turn.events, ...issues], true);

  // Sub-agent runs inside the turn's trace: this is where their tokens are counted.
  const emitRun = (run: SubAgentRun, ownerId: string, ownerTool: (key: string) => string, path: string[]): void => {
    const scope = [...path, run.key];
    const idOf = (kind: string, key: string) => stableId(traceId, 'subagent', ...scope, kind, key);
    const runId = stableId(traceId, 'subagent', ...scope);
    const analysis = analyzeTimeline(asTurn(run, turn));
    events.push(ev('agent-create', {
      id: runId,
      traceId,
      parentObservationId: run.parentToolKey ? ownerTool(run.parentToolKey) : ownerId,
      name: `Subagent: ${run.name}`,
      startTime: run.startTime,
      endTime: run.complete ? run.endTime : undefined,
      input: content(run.input),
      output: content(run.output),
      metadata: s({ ...run.metadata, subagent: true, subagentKey: run.key,
        subagentTraceId: opts.subagentTraces === false ? undefined : subagentTraceIdFor(opts.agentTag, turn.sessionId, run.key) }),
      environment: opts.environment,
    }));
    emit(traceId, runId, idOf, run.steps, analysis.links, [...run.events, ...analysis.issues], true);
    for (const child of run.children ?? []) emitRun(child, runId, key => idOf('tool', key), scope);
  };
  for (const run of turn.children ?? []) emitRun(run, rootId, key => stableId(traceId, 'tool', key), []);

  // The same runs as traces of their own, for opening one without its turn.
  if (opts.subagentTraces !== false) {
    for (const run of runs) {
      const id = subagentTraceIdFor(opts.agentTag, turn.sessionId, run.key);
      const root = stableId(id, 'agent');
      const analysis = analyzeTimeline(asTurn(run, turn));
      const label = `Subagent: ${run.name}`;
      const models = run.steps.filter((step): step is GenerationStep => step.kind === 'generation');
      events.push(ev('trace-create', {
        id,
        timestamp: run.startTime,
        name: `${opts.agentLabel} - ${label}${run.complete ? '' : ' (in progress)'}`,
        userId: opts.userId,
        sessionId: turn.sessionId,
        input: content(run.input),
        output: content(run.output),
        tags: [opts.agentTag, opts.hostname, 'subagent'],
        metadata: s({ ...run.metadata, complete: run.complete, turnIndex: turn.index, hostname: opts.hostname, device: opts.device,
          subagent: true, subagentKey: run.key, parentTraceId: traceId, parentTurnKey: turn.key,
          modelCalls: models.length, toolCalls: run.steps.length - models.length,
          usage: sumUsage(models), usageCountedOnTurnTrace: true }),
        environment: opts.environment,
        release: opts.release,
      }), ev('agent-create', {
        id: root,
        traceId: id,
        name: label,
        startTime: run.startTime,
        endTime: run.complete ? run.endTime : undefined,
        input: content(run.input),
        output: content(run.output),
        environment: opts.environment,
      }));
      emit(id, root, (kind, key) => stableId(id, kind, key), run.steps, analysis.links, [...run.events, ...analysis.issues], false);
    }
  }
  return events;
}

function collectRuns(runs: SubAgentRun[] | undefined, out: SubAgentRun[] = []): SubAgentRun[] {
  for (const run of runs ?? []) {
    out.push(run);
    collectRuns(run.children, out);
  }
  return out;
}

function asTurn(run: SubAgentRun, turn: Turn): Turn {
  return { key: run.key, index: turn.index, sessionId: turn.sessionId, startTime: run.startTime, endTime: run.endTime,
    complete: run.complete, steps: run.steps, events: run.events, toolResults: run.toolResults, metadata: {}, offset: 0 };
}

function sumUsage(steps: GenerationStep[]): Usage | undefined {
  const total: Usage = {};
  for (const step of steps) {
    for (const [key, value] of Object.entries(step.usage ?? {})) total[key] = (total[key] ?? 0) + value;
  }
  return Object.keys(total).length ? total : undefined;
}

function dropUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}
