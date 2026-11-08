// Agent-neutral model of one conversation turn. Adapters parse an agent's
// transcript into Turn objects; core/batch.ts turns them into Langfuse events.

export type AgentName = 'claude' | 'codex';

export type Level = 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';

export type Usage = Record<string, number>;

export interface GenerationStep {
  kind: 'generation';
  /** Stable key within the turn (e.g. API message id / response id). */
  key: string;
  name: string;
  model?: string;
  startTime: string;
  endTime: string;
  input?: unknown;
  output?: unknown;
  usage?: Usage;
  metadata?: Record<string, unknown>;
  level?: Level;
  statusMessage?: string;
}

export interface ToolStep {
  kind: 'tool';
  /** Stable key within the turn (tool call id). */
  key: string;
  name: string;
  startTime: string;
  endTime?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface TurnEvent {
  key: string;
  name: string;
  time: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  level?: Level;
}

export interface Turn {
  /** Stable key within the session (prompt id / turn id). */
  key: string;
  /** 1-based turn number shown in the trace name. */
  index: number;
  sessionId: string;
  startTime: string;
  endTime: string;
  input?: unknown;
  output?: unknown;
  complete: boolean;
  steps: Array<GenerationStep | ToolStep>;
  events: TurnEvent[];
  metadata: Record<string, unknown>;
  /** Byte offset in the transcript where this turn starts (for incremental reads). */
  offset: number;
}

export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  cwd?: string;
  turn_id?: string;
  message?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  last_assistant_message?: string;
  [key: string]: unknown;
}
