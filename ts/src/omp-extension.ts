import { parseOmpSession } from './adapters/omp.ts';
import { turnToEvents } from './core/batch.ts';
import { loadConfig } from './core/config.ts';
import { canExport, exportEvents } from './core/export.ts';
import { createLogger } from './core/log.ts';
import { batchOptions, logPath } from './core/run.ts';

// Structural subset of the OMP extension context, so the tracing package stays dependency-free.
interface OmpExtension {
  on(event: 'agent_end' | 'session_shutdown', handler: (event: unknown, ctx: {
    sessionManager: { getSessionId(): string; getBranch(): unknown[] };
  }) => Promise<void>): void;
}

export default function (omp: OmpExtension): void {
  const env = { ...process.env };
  const cfg = loadConfig('omp', env);
  if (!canExport(cfg)) return;
  const path = logPath(cfg);
  const log = createLogger(path, cfg.debug);
  const pending = new Set<Promise<void>>();
  log.debug('OMP extension initialized');

  omp.on('session_shutdown', async () => {
    await Promise.allSettled(pending);
  });
  omp.on('agent_end', async (event, ctx) => {
    const end = event as { yielded?: boolean; willContinue?: boolean };
    if (end.yielded === false || (end.yielded === undefined && end.willContinue)) return;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const entries = ctx.sessionManager.getBranch().map((value, offset) => ({ value, offset }));
      const turn = parseOmpSession(entries, sessionId).at(-1);
      if (!turn) return;
      const events = turnToEvents(turn, { ...batchOptions(cfg), captureContent: env.LANGFUSE_HOOK_CAPTURE_CONTENT === 'true' });
      const delivery = exportEvents(cfg, events, log).then(result => {
        if (!result.ok) log.error('OMP trace ingestion failed (' + result.errors.length + ' errors)');
        else log.debug('OMP trace sent (' + result.sent + ' events)');
      });
      pending.add(delivery);
      try { await delivery; } finally { pending.delete(delivery); }
    } catch {
      log.debug('OMP trace could not be reconstructed or sent');
    }
  });
}
