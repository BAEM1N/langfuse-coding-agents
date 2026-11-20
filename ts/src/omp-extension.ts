import { parseOmpSession } from './adapters/omp.ts';
import { turnToEvents } from './core/batch.ts';
import { loadConfig } from './core/config.ts';
import { canExport, exportEvents } from './core/export.ts';
import { createLogger } from './core/log.ts';
import { batchOptions, logPath } from './core/run.ts';
import { attachOmpSubagents } from './core/subagents.ts';

// Structural subset of the OMP extension context, so the tracing package stays dependency-free.
interface OmpContext {
  cwd?: string;
  sessionManager: { getSessionId(): string; getBranch(): unknown[] };
}

interface OmpExtension {
  on(event: 'agent_end' | 'session_shutdown', handler: (event: unknown, ctx: OmpContext) => Promise<void>): void;
}

export default function (omp: OmpExtension): void {
  const env = { ...process.env };
  const cfg = loadConfig('omp', env);
  if (!canExport(cfg)) return;
  const path = logPath(cfg);
  const log = createLogger(path, cfg.debug);
  const pending = new Map<string, Promise<boolean>>();
  const RECENT_TURNS = 3;
  log.debug('OMP extension initialized');

  const sendLatest = async (ctx: OmpContext, closing = false) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const entries = ctx.sessionManager.getBranch().map((value, offset) => ({ value, offset }));
      // The last few turns, not only the newest: a task session started by an
      // earlier turn can finish later. Delivery state keeps what was already
      // accepted from being sent again.
      const turns = parseOmpSession(entries, sessionId).slice(-RECENT_TURNS);
      let turn = turns.at(-1);
      if (!turn) return;
      // The session is closing: a turn still open will get no agent_end, so it
      // is sent as it stands. Otherwise an aborted turn was never sent at all.
      if (closing && !turn.complete) {
        turn = { ...turn, complete: true, metadata: { ...turn.metadata, endedWithoutStop: true } };
        turns[turns.length - 1] = turn;
      }
      if (cfg.subagents) {
        try { attachOmpSubagents(cfg.agentHome, turn.sessionId, turns); } catch { /* sent without task sessions */ }
      }
      const existing = pending.get(sessionId);
      if (existing) await existing;
      const options = { ...batchOptions(cfg), captureContent: env.LANGFUSE_HOOK_CAPTURE_CONTENT === 'true' };
      const delivery = exportEvents(cfg, turns.flatMap(item => turnToEvents(item, options)), log, ctx.cwd).then(result => {
        if (!result.ok) log.error('OMP trace ingestion failed (' + result.errors.length + ' errors)');
        else log.debug('OMP trace sent (' + result.sent + ' events)');
        return result.ok;
      });
      pending.set(sessionId, delivery);
      try { await delivery; } finally { if (pending.get(sessionId) === delivery) pending.delete(sessionId); }
    } catch {
      log.debug('OMP trace could not be reconstructed or sent');
    }
  };
  omp.on('session_shutdown', async (_event, ctx) => {
    await Promise.allSettled(pending.values());
    await sendLatest(ctx, true);
  });
  omp.on('agent_end', async (event, ctx) => {
    const end = event as { yielded?: boolean; willContinue?: boolean };
    if (end.yielded === false || (end.yielded === undefined && end.willContinue)) return;
    await sendLatest(ctx);
  });
}
