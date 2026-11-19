import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from './config.ts';
import { LangfuseClient, type IngestionEvent, type IngestResult } from './langfuse.ts';
import type { Logger } from './log.ts';
import { exportOtlp } from './otlp.ts';

const launch = promisify(execFile);

export function canExport(config: Config): boolean {
  return Boolean(config.otlp || config.otlpError || (config.enabled && config.publicKey && config.secretKey));
}

export async function exportEvents(config: Config, events: IngestionEvent[], logger: Logger): Promise<IngestResult> {
  const sends = [];
  if (config.otlpError) sends.push(Promise.resolve({ ok: false, sent: 0, errors: [{ message: config.otlpError }] }));
  if (config.otlp) {
    const open = new Set(events.filter(event => event.type === 'trace-create' &&
      (event.body.metadata as { complete?: boolean } | undefined)?.complete === false).map(event => event.body.id));
    const completed = events.filter(event => !open.has(event.type === 'trace-create' ? event.body.id : event.body.traceId));
    if (completed.length) {
      const otlp = config.otlp;
      const deliver = async () => {
        if (config.collectorLauncher) {
          const node = config.nodeExecutable || (process.versions.bun ? 'node' : process.execPath);
          try { await launch(node, [config.collectorLauncher], { timeout: 4000, windowsHide: true }); }
          catch { return { ok: false, sent: 0, errors: [{ message: 'Local Collector did not start' }] }; }
        }
        return exportOtlp(otlp, completed, config.agent);
      };
      sends.push(deliver());
    }
  }
  if (config.enabled && config.publicKey && config.secretKey) {
    const client = new LangfuseClient({ ...config, publicKey: config.publicKey, secretKey: config.secretKey, logger });
    sends.push(client.ingest(events));
  }
  const results = await Promise.all(sends);
  return { ok: results.every(result => result.ok), sent: results.reduce((total, result) => total + result.sent, 0),
    errors: results.flatMap(result => result.errors) };
}
