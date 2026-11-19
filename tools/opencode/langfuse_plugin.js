import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { homedir } from 'node:os';

const ALLOWED_EVENTS = new Set([
  'session.created',
  'session.idle',
  'session.error',
  'session.compacted',
  'message.updated',
  'message.part.updated',
]);

function resolveHookPath() {
  if (process.env.OPENCODE_LANGFUSE_HOOK_PATH) {
    return process.env.OPENCODE_LANGFUSE_HOOK_PATH;
  }
  return path.join(homedir(), '.config', 'opencode', 'hooks', 'langfuse_hook.py');
}

function debugDump(payload) {
  try {
    const enabled = String(process.env.OPENCODE_LANGFUSE_PLUGIN_DEBUG || '').toLowerCase();
    if (!['1', 'true', 'yes', 'on'].includes(enabled)) return;
    const stateDir = process.env.OPENCODE_LANGFUSE_STATE_DIR || path.join(homedir(), '.config', 'opencode', 'state', 'langfuse');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(
      path.join(stateDir, 'plugin_events.ndjson'),
      JSON.stringify({ ts: new Date().toISOString(), payload }) + '\n',
      'utf8',
    );
  } catch {
    // fail-open
  }
}

let python;
function findPython() {
  if (python) return python;
  const venv = path.join(homedir(), '.config', 'opencode', 'langfuse-venv');
  const scopedPython = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  const candidates = [process.env.OPENCODE_LANGFUSE_PYTHON, fs.existsSync(scopedPython) ? scopedPython : undefined, 'python3', 'python'];
  for (const cmd of candidates.filter(Boolean)) {
    try {
      const result = spawnSync(cmd, ['--version'], { timeout: 5000 });
      if (result.status === 0) {
        python = cmd;
        return python;
      }
    } catch {}
  }
  return 'python3'; // fallback
}

function forwardToHook(payload, directory) {
  try {
    debugDump(payload);
    spawnSync(findPython(), [resolveHookPath()], {
      input: JSON.stringify(payload || {}),
      stdio: ['pipe', 'ignore', 'ignore'],
      env: process.env,
      cwd: typeof directory === 'string' && path.isAbsolute(directory) ? directory : undefined,
      timeout: 15000,
    });
  } catch {
    // fail-open: never block OpenCode
  }
}

export const LangfuseOpenCodePlugin = async ({ directory } = {}) => {
  return {
    event: async ({ event }) => {
      const eventType = String(event?.type || '').toLowerCase();
      if (!ALLOWED_EVENTS.has(eventType)) {
        return;
      }
      forwardToHook({
        source: 'opencode-plugin',
        captured_at: new Date().toISOString(),
        event,
      }, directory);
    },
  };
};
