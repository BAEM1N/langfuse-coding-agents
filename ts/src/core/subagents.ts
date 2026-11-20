import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseClaudeTranscript } from '../adapters/claude.ts';
import { parseCodexRollout } from '../adapters/codex.ts';
import { parseOmpSession } from '../adapters/omp.ts';
import { readJsonlFrom } from './jsonl.ts';
import type { SubAgentRun, Turn } from './types.ts';

// Sub-agent work is not in the transcript a hook is handed. Claude Code writes
// each agent to its own file next to the session; Codex writes each spawned
// thread to its own rollout and runs no hooks for it. Both are read here and
// attached to the turn that started them.

type Owner = { children?: SubAgentRun[]; steps: Turn['steps'] };

/**
 * Claude Code: <session>.jsonl has <session>/subagents/agent-<id>.jsonl plus
 * agent-<id>.meta.json, whose toolUseId names the tool call that started it.
 * Only agents started by the given turns (or by their agents) are read.
 */
export function attachClaudeSubagents(transcriptPath: string, turns: Turn[]): void {
  const dir = join(transcriptPath.replace(/\.jsonl$/i, ''), 'subagents');
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  const pending = new Map<string, { file: string; meta: Record<string, unknown> }>();
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
      const file = join(dir, name.replace(/\.meta\.json$/, '.jsonl'));
      if (typeof meta.toolUseId === 'string' && existsSync(file)) pending.set(meta.toolUseId, { file, meta });
    } catch {
      /* unreadable meta: that agent is skipped */
    }
  }
  if (!pending.size) return;
  const queue: Owner[] = [...turns];
  for (let owner = queue.shift(); owner && pending.size; owner = queue.shift()) {
    for (const step of owner.steps) {
      const found = step.kind === 'tool' ? pending.get(step.key) : undefined;
      if (!found) continue;
      pending.delete(step.key);
      const run = readClaudeAgent(found.file, found.meta, step.key);
      if (!run) continue;
      (owner.children ??= []).push(run);
      queue.push(run); // an agent can start agents of its own
    }
  }
}

function readClaudeAgent(file: string, meta: Record<string, unknown>, parentToolKey: string): SubAgentRun | undefined {
  let turn: Turn | undefined;
  try {
    [turn] = parseClaudeTranscript(readJsonlFrom(file).entries, { sessionId: '', turnsBefore: 0, sidechain: true });
  } catch {
    return undefined;
  }
  if (!turn) return undefined;
  const type = typeof meta.agentType === 'string' && meta.agentType ? meta.agentType : 'agent';
  return { key: basename(file, '.jsonl').replace(/^agent-/, ''), name: type, startTime: turn.startTime, endTime: turn.endTime,
    input: turn.input, output: turn.output, complete: meta.finished !== false, parentToolKey, steps: turn.steps,
    events: turn.events, toolResults: turn.toolResults,
    metadata: { agentType: type, model: typeof meta.model === 'string' ? meta.model : undefined,
      spawnDepth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : undefined } };
}

/**
 * Oh My Pi: the `task` tool runs each task in a session of its own, written to
 * <session>/<TaskName>.jsonl beside the parent's <session>.jsonl. The task name
 * in the tool call's arguments is the file name.
 */
export function attachOmpSubagents(agentHome: string, sessionId: string, turns: Turn[]): void {
  if (!turns.length || !sessionId) return;
  const root = join(agentHome, 'sessions');
  let dir: string | undefined;
  const list = (path: string) => { try { return readdirSync(path, { withFileTypes: true }); } catch { return []; } };
  for (const group of list(root)) {
    if (!group.isDirectory()) continue;
    const hit = list(join(root, group.name)).find(entry => entry.isDirectory() && entry.name.endsWith('_' + sessionId));
    if (hit) { dir = join(root, group.name, hit.name); break; }
  }
  if (!dir) return;
  const files = list(dir).filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && entry.name !== 'changes.jsonl');
  for (const file of files) {
    const task = file.name.replace(/\.jsonl$/, '');
    // The tool call that named this task owns it.
    let owner: Turn | undefined;
    let call: string | undefined;
    for (const turn of turns) {
      const step = turn.steps.find(candidate => candidate.kind === 'tool' && candidate.name === 'task'
        && Array.isArray((candidate.input as { tasks?: Array<{ name?: unknown }> } | undefined)?.tasks)
        && (candidate.input as { tasks: Array<{ name?: unknown }> }).tasks.some(item => item?.name === task));
      if (step) { owner = turn; call = step.key; }
    }
    if (!owner) continue;
    try {
      const entries = readJsonlFrom(join(dir, file.name)).entries.map((entry, offset) => ({ value: entry.value, offset }));
      for (const turn of parseOmpSession(entries, task)) {
        (owner.children ??= []).push({ key: `${task}:${turn.key}`, name: task, startTime: turn.startTime, endTime: turn.endTime,
          input: turn.input, output: turn.output, complete: turn.complete, parentToolKey: call, steps: turn.steps,
          events: turn.events, toolResults: turn.toolResults, metadata: { agentType: task, taskSession: turn.sessionId } });
      }
    } catch {
      /* an unreadable task session does not stop the others */
    }
  }
}

interface ThreadEntry {
  /** Session the thread belongs to; absent for files that are not sub-agent threads. */
  session?: string;
  thread?: string;
  nickname?: string;
  historyStart?: number;
  /** Parent turn IDs seen in the file at `size` bytes. */
  size?: number;
  parents?: string[];
}
interface ThreadIndex { version: 1; files: Record<string, ThreadEntry> }

const HEAD_BYTES = 1_000_000;

/** session_meta rows sit at the top of a rollout; read only that much. */
function readHead(path: string): any[] {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const text = buffer.toString('utf8', 0, read);
    const complete = read < HEAD_BYTES ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    return complete.split('\n').slice(0, 8).flatMap(line => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
  } finally {
    closeSync(fd);
  }
}

/** True for the rollout of a thread another Codex session spawned. */
export function isCodexThread(path: string): boolean {
  try {
    return readHead(path).some(row => row?.type === 'session_meta'
      && (row.payload?.thread_source === 'subagent' || (row.payload?.source && typeof row.payload.source === 'object')));
  } catch {
    return false;
  }
}

/**
 * Codex: a spawned thread's rollout carries the parent's session_id, and each
 * of its turns names the parent turn in turn_attribution. A forked thread
 * starts with a copy of the parent's history, which is skipped.
 */
export function attachCodexSubagents(rolloutPath: string, sessionId: string, turns: Turn[], persistIndex = true): void {
  const layout = /^(.*[\\/]sessions)[\\/](\d{4})[\\/](\d{2})[\\/](\d{2})[\\/][^\\/]+$/.exec(rolloutPath);
  if (!layout || !turns.length) return;
  const [, root, year, month, day] = layout;
  const since = `${year}/${month}/${day}`;
  const indexPath = join(dirname(root), 'state', 'langfuse_agent_hooks_threads.json');
  let index: ThreadIndex = { version: 1, files: {} };
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as ThreadIndex;
    if (parsed?.version === 1 && parsed.files) index = parsed;
  } catch {
    /* first run */
  }
  let changed = false;
  const list = (dir: string) => { try { return readdirSync(dir).sort(); } catch { return []; } };
  const candidates: Array<{ path: string; entry: ThreadEntry }> = [];
  for (const y of list(root)) for (const m of list(join(root, y))) for (const d of list(join(root, y, m))) {
    if (`${y}/${m}/${d}` < since) continue; // a thread cannot start before its parent
    for (const name of list(join(root, y, m, d))) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(root, y, m, d, name);
      const key = `${y}/${m}/${d}/${name}`;
      let entry = index.files[key];
      if (!entry) {
        entry = {};
        try {
          const meta = readHead(path).find(row => row?.type === 'session_meta'
            && (row.payload?.thread_source === 'subagent' || (row.payload?.source && typeof row.payload.source === 'object')))?.payload;
          if (meta && typeof meta.session_id === 'string' && meta.id !== meta.session_id) {
            entry = { session: meta.session_id, thread: String(meta.id), nickname: typeof meta.agent_nickname === 'string' ? meta.agent_nickname : undefined,
              historyStart: typeof meta.subagent_history_start_ordinal === 'number' ? meta.subagent_history_start_ordinal : undefined };
          }
        } catch {
          continue; // unreadable now; look again next time
        }
        index.files[key] = entry;
        changed = true;
      }
      if (entry.session === sessionId && path !== rolloutPath) candidates.push({ path, entry });
    }
  }
  const wanted = new Map(turns.map(turn => [turn.key, turn]));
  for (const { path, entry } of candidates) {
    try {
      const size = statSync(path).size;
      const own = (row: any) => entry.historyStart === undefined || typeof row?.ordinal !== 'number' || row.ordinal >= entry.historyStart;
      let entries: ReturnType<typeof readJsonlFrom>['entries'] | undefined;
      const parentOf = new Map<string, string>();
      if (entry.size !== size || !entry.parents) {
        entries = readJsonlFrom(path).entries.filter(e => own(e.value));
        for (const { value } of entries) {
          const p = value?.payload;
          if (value?.type !== 'event_msg' || p?.type !== 'task_started' || !p.turn_id) continue;
          const parent = p.turn_attribution?.parent_turn_id ?? p.turn_attribution?.root_turn_id;
          if (typeof parent === 'string') parentOf.set(String(p.turn_id), parent);
        }
        entry.size = size;
        entry.parents = [...new Set(parentOf.values())];
        changed = true;
      }
      if (!entry.parents.some(id => wanted.has(id))) continue;
      entries ??= readJsonlFrom(path).entries.filter(e => own(e.value));
      if (!parentOf.size) {
        for (const { value } of entries) {
          const p = value?.payload;
          const parent = p?.turn_attribution?.parent_turn_id ?? p?.turn_attribution?.root_turn_id;
          if (value?.type === 'event_msg' && p?.type === 'task_started' && p.turn_id && typeof parent === 'string') parentOf.set(String(p.turn_id), parent);
        }
      }
      for (const turn of parseCodexRollout(entries, { sessionId, turnsBefore: 0, context: {} }).turns) {
        const owner = wanted.get(parentOf.get(turn.key) ?? '');
        if (!owner) continue;
        // The first tool call of the turn that names this thread is the one that spawned it.
        const spawn = owner.steps.find(step => step.kind === 'tool' && entry.thread
          && ((step.metadata as { subagentThreadIds?: string[] } | undefined)?.subagentThreadIds ?? []).includes(entry.thread));
        (owner.children ??= []).push({ key: `${entry.thread}:${turn.key}`, name: entry.nickname || 'thread', startTime: turn.startTime,
          endTime: turn.endTime, input: turn.input, output: turn.output, complete: turn.complete, parentToolKey: spawn?.key,
          steps: turn.steps, events: turn.events, toolResults: turn.toolResults,
          metadata: { threadId: entry.thread, nickname: entry.nickname, model: (turn.metadata as { model?: unknown }).model } });
      }
    } catch {
      /* one unreadable thread does not stop the others */
    }
  }
  if (changed && persistIndex) {
    try {
      mkdirSync(dirname(indexPath), { recursive: true });
      const tmp = `${indexPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(index));
      renameSync(tmp, indexPath);
    } catch {
      /* the index is a cache */
    }
  }
}
