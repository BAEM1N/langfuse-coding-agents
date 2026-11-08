import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** File logger. Never writes to stdout — agents may parse hook stdout. */
export function createLogger(file: string, debugEnabled: boolean): Logger {
  let ready = false;
  const write = (level: string, msg: string) => {
    try {
      if (!ready) {
        mkdirSync(dirname(file), { recursive: true });
        try {
          if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
        } catch {
          /* no log yet */
        }
        ready = true;
      }
      appendFileSync(file, `${new Date().toISOString()} [${level}] ${msg}\n`);
    } catch {
      /* logging must never break the hook */
    }
  };
  return {
    debug: (m) => debugEnabled && write('DEBUG', m),
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
