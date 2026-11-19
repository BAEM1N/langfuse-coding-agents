import { eventId, stableId } from './ids.ts';
import type { IngestionEvent } from './langfuse.ts';
import { sanitize, type SanitizeOptions } from './text.ts';
import { analyzeTimeline } from './timeline.ts';
import type { Turn } from './types.ts';

export interface BatchOptions extends SanitizeOptions {
  agentLabel: string; // "Claude Code"
  agentTag: string; // "claude-code"
  userId: string;
  hostname: string;
  device?: Record<string, string | number>;
  environment?: string;
  release?: string;
  captureContent?: boolean;
}

export function traceIdFor(agentTag: string, sessionId: string, turnKey: string): string {
  return stableId(agentTag, sessionId, turnKey);
}

/**
 * Convert a Turn into Langfuse ingestion events:
 *   trace (turn) → agent span → generations / tools (in time order) + events.
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
        device: opts.device, timelineIssueCount: issues.length }),
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

  for (const step of turn.steps) {
    const id = stableId(traceId, step.kind, step.key);
    if (step.kind === 'generation') {
      events.push(
        ev('generation-create', {
          id,
          traceId,
          parentObservationId: rootId,
          name: step.name,
          startTime: step.startTime,
          endTime: step.endTime,
          model: step.model,
          input: content(step.input),
          output: content(step.output),
          usageDetails: step.usage && Object.keys(step.usage).length ? step.usage : undefined,
          metadata: s(step.metadata),
          level: step.level,
          statusMessage: step.statusMessage,
          environment: opts.environment,
        }),
      );
    } else {
      const link = links.get(step.key);
      const generationId = (key?: string) => key ? stableId(traceId, 'generation', key) : undefined;
      events.push(
        ev('tool-create', {
          id,
          traceId,
          parentObservationId: rootId,
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
        }),
      );
    }
  }

  for (const e of [...turn.events, ...issues]) {
    events.push(
      ev('event-create', {
        id: stableId(traceId, 'event', e.key),
        traceId,
        parentObservationId: rootId,
        name: e.name,
        startTime: e.time,
        input: content(e.input),
        metadata: s(e.metadata),
        level: e.level,
        environment: opts.environment,
      }),
    );
  }
  return events;
}

function dropUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}
