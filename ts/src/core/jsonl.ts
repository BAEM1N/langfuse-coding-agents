import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface JsonlEntry {
  /** Byte offset of the line start. */
  offset: number;
  value: any;
}

export interface JsonlRead {
  entries: JsonlEntry[];
  /** File size at read time. */
  size: number;
  /** Offset actually used (0 if the file shrank / was replaced). */
  from: number;
}

/**
 * Read JSON lines starting at a byte offset. A trailing partial line (still being
 * written by the agent) is ignored. Malformed lines are skipped.
 */
export function readJsonlFrom(path: string, offset = 0): JsonlRead {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const from = offset > size ? 0 : offset;
    const len = size - from;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    const entries: JsonlEntry[] = [];
    let lineStart = 0;
    for (let i = 0; i < read; i++) {
      if (buf[i] !== 0x0a) continue;
      pushLine(buf, lineStart, i, from, entries);
      lineStart = i + 1;
    }
    return { entries, size, from };
  } finally {
    closeSync(fd);
  }
}

function pushLine(buf: Buffer, start: number, end: number, base: number, out: JsonlEntry[]): void {
  let e = end;
  if (e > start && buf[e - 1] === 0x0d) e--;
  if (e <= start) return;
  const text = buf.toString('utf8', start, e);
  try {
    out.push({ offset: base + start, value: JSON.parse(text) });
  } catch {
    /* skip malformed line */
  }
}
