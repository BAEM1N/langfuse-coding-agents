import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentHome } from './core/config.ts';
import type { AgentName } from './core/types.ts';

/** Events registered per agent. Pre/PostToolUse are deliberately not used:
 *  tool calls are reconstructed from the transcript at turn end. */
export const HOOK_EVENTS: Record<AgentName, string[]> = {
  claude: ['Stop', 'Notification'],
  codex: ['UserPromptSubmit', 'PermissionRequest', 'Stop'],
};

const MARKERS = ['langfuse_hook', 'langfuse-agent-hooks'];

export function installRoot(): string {
  return process.env.LANGFUSE_AGENT_HOOKS_HOME || join(homedir(), '.local', 'share', 'langfuse-agent-hooks');
}

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

const fwd = (p: string) => p.replace(/\\/g, '/');

function isOurs(entry: unknown): boolean {
  const s = JSON.stringify(entry);
  return MARKERS.some((m) => s.includes(m));
}

function readJson(path: string): any {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  return text.trim() ? JSON.parse(text) : {};
}

function backup(path: string): void {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  copyFileSync(path, `${path}.bak-${stamp}`);
}

/** Remove our entries from every event; add fresh ones for `events`. Returns the new hooks object. */
export function mergeHooks(hooks: Record<string, unknown[]>, events: string[], entry: unknown): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [ev, list] of Object.entries(hooks ?? {})) {
    const kept = (Array.isArray(list) ? list : []).filter((e) => !isOurs(e));
    if (kept.length) out[ev] = kept;
  }
  for (const ev of events) out[ev] = [...(out[ev] ?? []), entry];
  return out;
}

export interface InstallPlan {
  agent: AgentName;
  file: string;
  before: unknown;
  after: unknown;
}

export function planInstall(agent: AgentName, cliPath: string, nodePath = process.execPath, remove = false): InstallPlan {
  const home = agentHome(agent);
  if (agent === 'claude') {
    const file = join(home, 'settings.json');
    const before = readJson(file);
    const entry = {
      hooks: [{ type: 'command', command: fwd(nodePath), args: [fwd(cliPath), 'hook', 'claude'], async: true, timeout: 30 }],
    };
    const hooks = mergeHooks(before.hooks ?? {}, remove ? [] : HOOK_EVENTS.claude, entry);
    const after = { ...before, hooks };
    if (!Object.keys(hooks).length) delete (after as any).hooks;
    return { agent, file, before, after };
  }
  const file = join(home, 'hooks.json');
  const before = readJson(file);
  const entry = { hooks: [{ type: 'command', command: `"${nodePath}" "${cliPath}" hook codex` }] };
  const after = { ...before, hooks: mergeHooks(before.hooks ?? {}, remove ? [] : HOOK_EVENTS.codex, entry) };
  return { agent, file, before, after };
}

export function applyPlan(plan: InstallPlan): void {
  mkdirSync(dirname(plan.file), { recursive: true });
  backup(plan.file);
  writeFileSync(plan.file, `${JSON.stringify(plan.after, null, 2)}\n`);
}

/** Copy this package to a stable location so hooks survive moving/deleting the repo. */
export function deployPackage(): string {
  const src = packageRoot();
  const dst = installRoot();
  if (resolve(src) !== resolve(dst)) {
    mkdirSync(dst, { recursive: true });
    cpSync(join(src, 'src'), join(dst, 'src'), { recursive: true, force: true });
    copyFileSync(join(src, 'package.json'), join(dst, 'package.json'));
  }
  return join(dst, 'src', 'cli.ts');
}
