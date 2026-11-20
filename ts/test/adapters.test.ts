import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseClaudeTranscript } from '../src/adapters/claude.ts';
import { parseCodexRollout } from '../src/adapters/codex.ts';
import { readJsonlFrom } from '../src/core/jsonl.ts';
import type { GenerationStep, ToolStep } from '../src/core/types.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('claude: splits turns at turnPosition prompts', () => {
  const { entries } = readJsonlFrom(fixture('claude-transcript.jsonl'));
  const turns = parseClaudeTranscript(entries, { sessionId: 'x', turnsBefore: 0 });
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.key), ['p1', 'p2']);
  assert.deepEqual(turns.map((t) => t.index), [1, 2]);
  assert.equal(turns[0].sessionId, 'sess-1');
});

test('claude: merges split assistant lines into one generation and skips sidechain', () => {
  const { entries } = readJsonlFrom(fixture('claude-transcript.jsonl'));
  const [t1] = parseClaudeTranscript(entries, { sessionId: 'x', turnsBefore: 0 });
  const gens = t1.steps.filter((s): s is GenerationStep => s.kind === 'generation');
  assert.deepEqual(gens.map((g) => g.key), ['msg_A', 'msg_B']);
  const content = (gens[0].output as any).content.map((c: any) => c.type);
  assert.deepEqual(content, ['thinking', 'tool_use']);
  assert.ok(!JSON.stringify(t1).includes('subagent noise'));
  assert.deepEqual(gens[0].usage, { input: 10, output: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100, total: 2160 });
  assert.equal(gens[0].model, 'claude-opus-5-5');
});

test('claude: pairs tool_use with tool_result and feeds results to the next generation', () => {
  const { entries } = readJsonlFrom(fixture('claude-transcript.jsonl'));
  const [t1, t2] = parseClaudeTranscript(entries, { sessionId: 'x', turnsBefore: 0 });
  const tool = t1.steps.find((s): s is ToolStep => s.kind === 'tool')!;
  assert.equal(tool.name, 'Bash');
  assert.deepEqual(tool.input, { command: 'ls' });
  assert.equal(tool.output, 'a.txt\nb.txt');
  assert.equal(tool.endTime, '2026-11-08T10:00:04.000Z');
  const genB = t1.steps.find((s) => s.key === 'msg_B') as GenerationStep;
  assert.equal((genB.input as any[])[0].role, 'tool');
  assert.equal(genB.startTime, '2026-11-08T10:00:04.000Z');
  const failed = t2.steps.find((s): s is ToolStep => s.kind === 'tool')!;
  assert.equal(failed.isError, true);
});

test('claude: completion and output', () => {
  const { entries } = readJsonlFrom(fixture('claude-transcript.jsonl'));
  const [t1, t2] = parseClaudeTranscript(entries, { sessionId: 'x', turnsBefore: 0 });
  assert.equal(t1.complete, true);
  assert.equal(t1.metadata.durationMs, 6000);
  assert.equal(t1.output, 'There are two files: a.txt and b.txt.');
  assert.equal(t2.complete, false);
  assert.equal(t2.input, 'Now delete b.txt');
});

test('claude: incremental read from a turn offset keeps turn numbering', () => {
  const all = readJsonlFrom(fixture('claude-transcript.jsonl'));
  const turns = parseClaudeTranscript(all.entries, { sessionId: 'x', turnsBefore: 0 });
  const tail = readJsonlFrom(fixture('claude-transcript.jsonl'), turns[1].offset);
  const again = parseClaudeTranscript(tail.entries, { sessionId: 'x', turnsBefore: 1 });
  assert.equal(again.length, 1);
  assert.equal(again[0].key, 'p2');
  assert.equal(again[0].index, 2);
});

test('codex: parses a real rollout into one turn with two generations and a tool', () => {
  const { entries } = readJsonlFrom(fixture('codex-rollout.jsonl'));
  const { turns, context } = parseCodexRollout(entries, { sessionId: 's', turnsBefore: 0, context: {} });
  assert.equal(turns.length, 1);
  const t = turns[0];
  assert.equal(t.complete, true);
  assert.match(String(t.input), /^Reply with exactly: pong/);
  assert.equal(t.output, 'hi');
  assert.equal(context.cliVersion, '0.167.0');
  const gens = t.steps.filter((s): s is GenerationStep => s.kind === 'generation');
  assert.equal(gens.length, 2);
  assert.equal(gens[0].model, 'gpt-6.1-sol');
  // input excludes cached tokens; cached reported separately
  assert.deepEqual(gens[0].usage, { input: 4201, output: 41, input_cached_tokens: 13696, total: 17938 });
  const tool = t.steps.find((s): s is ToolStep => s.kind === 'tool')!;
  assert.equal(tool.name, 'exec');
  assert.match(String(tool.output), /hi/);
  assert.equal((tool.metadata as any).commands[0].command, 'echo hi');
  assert.equal((tool.metadata as any).commands[0].exitCode, 0);
});

test('codex: generations and tools are ordered in time', () => {
  const { entries } = readJsonlFrom(fixture('codex-rollout.jsonl'));
  const [t] = parseCodexRollout(entries, { sessionId: 's', turnsBefore: 0, context: {} }).turns;
  assert.deepEqual(t.steps.map((s) => s.kind), ['generation', 'tool', 'generation']);
  const times = t.steps.map((s) => s.startTime);
  assert.deepEqual([...times].sort(), times);
});

test('claude: a compaction summary row does not start a second turn with the same key', () => {
  const { entries } = readJsonlFrom(fixture('claude-transcript.jsonl'));
  const prompt = entries[1].value;
  const summary = (uuid: string, timestamp: string) => ({ offset: 0, value: { ...prompt, uuid, timestamp, isCompactSummary: true,
    origin: undefined, promptSource: undefined, message: { role: 'user', content: 'SUMMARY-OF-EARLIER-CONTEXT' } } });
  // Once in the middle of turn 1 (it continues afterwards) and once after it ended.
  const withSummaries = [...entries.slice(0, 5), summary('cs-mid', '2026-11-08T10:00:04.200Z'), ...entries.slice(5, 8),
    summary('cs-end', '2026-11-08T10:00:07.000Z'), ...entries.slice(8)].map((entry, offset) => ({ ...entry, offset }));
  const turns = parseClaudeTranscript(withSummaries, { sessionId: 'x', turnsBefore: 0 });
  assert.deepEqual(turns.map((t) => t.key), ['p1', 'p2'], 'still two turns, each key once');
  const before = parseClaudeTranscript(entries, { sessionId: 'x', turnsBefore: 0 })[0];
  assert.deepEqual(turns[0].steps.map((s) => s.key), before.steps.map((s) => s.key), 'model and tool steps stay in the turn they belong to');
  assert.equal(turns[0].input, before.input, 'the prompt is still the user prompt');
  assert.deepEqual(turns[0].events.map((e) => e.name), ['Context compacted', 'Context compacted']);
  assert.ok(!JSON.stringify(turns).includes('SUMMARY-OF-EARLIER-CONTEXT'), 'summary text is not logged as a prompt or model input');
});

test('claude: a model call starts at its request row, and bookkeeping rows do not move the clock', () => {
  const { entries } = readJsonlFrom(fixture('claude-transcript.jsonl'));
  // After the tool result (10:00:04.000): a request row, then a bookkeeping row stamped later than the reply.
  const extra = [
    { type: 'api-request', timestamp: '2026-11-08T10:00:04.100Z', sessionId: 'sess-1' },
    { type: 'file-history-delta', timestamp: '2026-11-08T10:00:30.000Z', sessionId: 'sess-1' },
  ].map((value) => ({ offset: 0, value }));
  const turns = parseClaudeTranscript([...entries.slice(0, 5), ...extra, ...entries.slice(5)].map((e, offset) => ({ ...e, offset })),
    { sessionId: 'x', turnsBefore: 0 });
  const reply = turns[0].steps.find((s) => s.key === 'msg_B') as GenerationStep;
  assert.equal(reply.startTime, '2026-11-08T10:00:04.100Z', 'request time, not the later bookkeeping row');
  assert.ok(Date.parse(reply.endTime) >= Date.parse(reply.startTime), 'never ends before it starts');
  for (const turn of turns) {
    for (const step of turn.steps) assert.ok(!step.endTime || Date.parse(step.endTime) >= Date.parse(step.startTime), step.key);
  }
  assert.ok(Date.parse(turns[0].endTime) < Date.parse('2026-11-08T10:00:30.000Z'), 'turn end follows the conversation, not bookkeeping');
});
