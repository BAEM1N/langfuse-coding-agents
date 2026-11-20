// coverage compares local transcripts with a mock project. Synthetic data only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { traceIdFor } from '../src/core/batch.ts';
import { loadConfig } from '../src/core/config.ts';
import { coverage } from '../src/core/coverage.ts';
import { LangfuseClient } from '../src/core/langfuse.ts';
import { nullLogger } from '../src/core/log.ts';

test('coverage reports missing turns, turns stored short, and model calls without cost', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'lah-coverage-'));
  const project = join(home, 'projects', 'p');
  mkdirSync(project, { recursive: true });
  const rows = readFileSync(new URL('./fixtures/claude-transcript.jsonl', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean).slice(0, 8);
  writeFileSync(join(project, 'sess-1.jsonl'), rows.join('\n') + '\n');
  writeFileSync(join(project, 'sess-9.jsonl'), rows.join('\n').replaceAll('sess-1', 'sess-9') + '\n');
  const stored = traceIdFor('claude-code', 'sess-1', 'p1');
  const never = traceIdFor('claude-code', 'sess-9', 'p1');
  // The project holds the first session's turn, 117 tokens short on one model call and priced on only one.
  const observation = (type: string, extra: object = {}) => ({ id: type + Math.random(), traceId: stored, type, ...extra });
  const full = [observation('AGENT'), observation('TOOL'),
    observation('GENERATION', { model: 'claude-opus-5-5', usageDetails: { input: 10, output: 50, total: 2160 }, totalCost: 0.5, calculatedTotalCost: 0.5 }),
    observation('GENERATION', { model: 'claude-opus-5-5', usageDetails: { input: 5, output: 12, total: 2000 }, totalCost: 0, calculatedTotalCost: 0 })];
  let v2 = true;
  const paths: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    paths.push(url.pathname);
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/public/v2/observations') {
      return v2 ? json(200, { data: url.searchParams.get('sessionId') === 'sess-1' ? full : [], meta: {} }) : json(404, { message: 'not in a v4 write mode' });
    }
    if (url.pathname === '/api/public/traces') {
      return json(200, { data: url.searchParams.get('sessionId') === 'sess-1' ? [{ id: stored, name: 'Claude Code - Turn 1', metadata: { complete: true } }] : [], meta: { totalPages: 1 } });
    }
    if (url.pathname === '/api/public/traces/' + stored) return json(200, { id: stored, observations: full });
    json(404, {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  // The agent home is read from the process environment, so point it at the synthetic one.
  const previous = { home: process.env.CLAUDE_CONFIG_DIR, shared: process.env.LANGFUSE_AGENT_HOOKS_CONFIG_DIR };
  process.env.CLAUDE_CONFIG_DIR = home;
  process.env.LANGFUSE_AGENT_HOOKS_CONFIG_DIR = join(home, 'shared');
  t.after(() => {
    server.close();
    if (previous.home === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous.home;
    if (previous.shared === undefined) delete process.env.LANGFUSE_AGENT_HOOKS_CONFIG_DIR; else process.env.LANGFUSE_AGENT_HOOKS_CONFIG_DIR = previous.shared;
    rmSync(home, { force: true, recursive: true });
  });
  const cfg = loadConfig('claude', { CODING_AGENT_GITHUB_METADATA: 'false' });
  assert.equal(cfg.agentHome, home);
  const client = new LangfuseClient({ baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, publicKey: 'pk-lf-test',
    secretKey: 'sk-lf-test', timeoutMs: 5000, logger: nullLogger });

  for (const api of ['v2', 'legacy'] as const) {
    v2 = api === 'v2';
    const report = await coverage('claude', cfg, client, { since: '2026-11-08T00:00:00.000Z', deep: 10 });
    assert.equal(report.api, api, 'the read API the server offers is used');
    assert.deepEqual({ sessions: report.local.sessions, turns: report.local.turns, finished: report.local.finishedTurns }, { sessions: 2, turns: 2, finished: 2 });
    assert.equal(report.stored.turns, 1);
    assert.equal(report.stored.finishedTurnsMissing, 1);
    assert.equal(report.stored.sessionsWithoutAnyTrace, 1);
    assert.deepEqual(report.missing.map(turn => turn.traceId), [never]);
    assert.equal(report.compared.turns, 1);
    assert.equal(report.compared.sameStepsDifferentTokens, 1);
    assert.equal(report.compared.tokensNotStored, 117);
    assert.deepEqual(report.different.map(turn => [turn.traceId, turn.modelCalls, turn.tools, turn.tokens]), [[stored, '2/2', '1/1', '4160/4277']]);
    assert.deepEqual(report.cost, { modelCallsChecked: 2, withCost: 1, withoutCostByModel: { 'claude-opus-5-5': 1 } });
    assert.ok(!JSON.stringify(report).includes('List files'), 'no prompt text in the report');
  }
  assert.ok(paths.includes('/api/public/traces/' + stored), 'the stored-trace API reads steps trace by trace');
  const later = await coverage('claude', cfg, client, { since: '2026-11-09T00:00:00.000Z', deep: 10 });
  assert.equal(later.local.turns, 0, 'turns before --since are out of scope');
});
