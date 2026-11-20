import type { Logger } from './log.ts';
import { redact } from './text.ts';

export interface IngestionEvent {
  id: string;
  timestamp: string;
  type: string;
  body: Record<string, unknown>;
}

export interface IngestResult {
  ok: boolean;
  sent: number;
  errors: Array<{ id?: string; status?: number; message?: string }>;
}

export interface ClientOptions {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  timeoutMs: number;
  logger: Logger;
}

// Langfuse rejects ingestion requests over ~3.5MB; stay well under.
const MAX_BATCH_BYTES = 2_500_000;

/** Thin client for the Langfuse public ingestion API (no SDK, no dependencies). */
export class LangfuseClient {
  private readonly opts: ClientOptions;
  private readonly auth: string;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.auth = `Basic ${Buffer.from(`${opts.publicKey}:${opts.secretKey}`).toString('base64')}`;
  }

  async read<T>(path: string): Promise<T> {
    const res = await fetch(this.opts.baseUrl + path, {
      headers: { Authorization: this.auth },
      redirect: 'error',
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new Error('Langfuse read failed (HTTP ' + res.status + ')');
    return await res.json() as T;
  }

  /** Delete one trace. Used only to remove the self-test's own synthetic traces. */
  async deleteTrace(traceId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.opts.baseUrl}/api/public/traces/${encodeURIComponent(traceId)}`, {
        method: 'DELETE', headers: { Authorization: this.auth }, redirect: 'error', signal: AbortSignal.timeout(this.opts.timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ingest(events: IngestionEvent[]): Promise<IngestResult> {
    const result: IngestResult = { ok: true, sent: 0, errors: [] };
    for (const chunk of chunkBySize(events, MAX_BATCH_BYTES)) {
      const r = await this.post(chunk);
      result.sent += r.sent;
      result.errors.push(...r.errors);
      if (!r.ok) result.ok = false;
    }
    return result;
  }

  private async post(batch: IngestionEvent[]): Promise<IngestResult> {
    const url = `${this.opts.baseUrl}/api/public/ingestion`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      const text = await res.text();
      if (res.status !== 200 && res.status !== 207) {
        // The response body is not logged: an error page can echo the request.
        return { ok: false, sent: 0, errors: [{ status: res.status, message: 'Langfuse ingestion failed (HTTP ' + res.status + ')' }] };
      }
      let errors: IngestResult['errors'] = [];
      try {
        const body = JSON.parse(text) as { errors?: IngestResult['errors'] };
        // A 207 reports each rejected event separately. Keep the ID and status only.
        errors = (Array.isArray(body.errors) ? body.errors : []).map((error) => ({
          id: typeof error?.id === 'string' ? error.id : undefined,
          status: typeof error?.status === 'number' ? error.status : undefined,
          message: typeof error?.message === 'string' ? redact(error.message).slice(0, 200) : undefined,
        }));
      } catch {
        /* 200 without JSON body */
      }
      return { ok: errors.length === 0, sent: batch.length - errors.length, errors };
    } catch (e) {
      const timedOut = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
      return { ok: false, sent: 0, errors: [{ message: timedOut ? 'Langfuse ingestion timed out' : 'Langfuse ingestion request failed' }] };
    }
  }

  /** Returns true when the keys are valid for this host. */
  async authCheck(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetch(`${this.opts.baseUrl}/api/public/projects`, {
        headers: { Authorization: this.auth },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ name?: string }> };
        return { ok: true, message: `project: ${body.data?.[0]?.name ?? '?'}` };
      }
      return { ok: false, message: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}

function chunkBySize(events: IngestionEvent[], maxBytes: number): IngestionEvent[][] {
  const chunks: IngestionEvent[][] = [];
  let cur: IngestionEvent[] = [];
  let size = 0;
  for (const ev of events) {
    const s = Buffer.byteLength(JSON.stringify(ev));
    if (cur.length && size + s > maxBytes) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(ev);
    size += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
