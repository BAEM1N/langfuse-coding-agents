import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TranscriptState {
  /** Byte offset of the first line of the last (possibly still growing) turn. */
  offset: number;
  /** Number of turns that start before `offset`. */
  turnsBefore: number;
  /** Agent-specific context that is only written at the top of the file. */
  context?: Record<string, unknown>;
  updatedAt: string;
}

export interface StateFile {
  version: 1;
  transcripts: Record<string, TranscriptState>;
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function loadState(path: string): StateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StateFile;
    if (parsed && parsed.version === 1 && parsed.transcripts) return parsed;
  } catch {
    /* missing or corrupt: start fresh */
  }
  return { version: 1, transcripts: {} };
}

/** Atomic write (tmp + rename) so concurrent hooks never see a half-written file. */
export function saveState(path: string, state: StateFile): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [k, v] of Object.entries(state.transcripts)) {
    if (Date.parse(v.updatedAt) < cutoff) delete state.transcripts[k];
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}
