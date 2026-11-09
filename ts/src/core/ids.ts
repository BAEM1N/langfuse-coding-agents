import { createHash, randomUUID } from 'node:crypto';

/**
 * Deterministic 32-hex id (W3C trace-id shaped). The same inputs always give the
 * same id, so re-sending a turn upserts it in Langfuse instead of duplicating it.
 */
export function stableId(...parts: Array<string | number | undefined>): string {
  return createHash('sha256')
    .update(parts.map((p) => String(p ?? '')).join('␟'))
    .digest('hex')
    .slice(0, 32);
}

export function eventId(): string {
  return randomUUID();
}
