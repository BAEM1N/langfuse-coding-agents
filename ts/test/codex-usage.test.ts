import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCodexRollout } from '../src/adapters/codex.ts';

const rows = readFileSync(new URL('./fixtures/codex-rollout.jsonl', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean)
  .map(line => JSON.parse(line));
const parse = (values: any[]) => parseCodexRollout(values.map((value, offset) => ({ value, offset })),
  { sessionId: 'session', turnsBefore: 0, context: {} }).turns;
const billed = (values: any[]) => values.filter(row => row.type === 'token_usage_record')
  .reduce((sum, row) => sum + row.payload.usage.input_tokens + row.payload.usage.output_tokens, 0);
const reported = (values: any[]) => parse(values).flatMap(turn => turn.steps).filter(step => step.kind === 'generation')
  .reduce((sum, step) => sum + (step.usage ? step.usage.input + step.usage.output
    + (step.usage.input_cached_tokens ?? 0) + (step.usage.output_reasoning_tokens ?? 0) : 0), 0);

test('Codex: a billed model call that left no response item keeps its tokens', () => {
  assert.equal(reported(rows), billed(rows), 'fixture totals agree before the change');
  // A model call right after the tool output that recorded usage but no output.
  const at = rows.findIndex(row => row.type === 'response_item' && row.payload?.type === 'custom_tool_call_output');
  const template = rows.find(row => row.type === 'token_usage_record');
  const silent = { ...template, timestamp: rows[at].timestamp, payload: { ...template.payload, response_id: 'resp_silent',
    usage: { input_tokens: 900, cached_input_tokens: 500, cache_write_input_tokens: 0, output_tokens: 60, reasoning_output_tokens: 40, total_tokens: 960 } } };
  const withSilent = [...rows.slice(0, at + 1), silent, ...rows.slice(at + 1)];

  assert.equal(reported(withSilent), billed(withSilent), 'every usage record is counted once');
  const [turn] = parse(withSilent);
  const generation = turn.steps.find(step => step.kind === 'generation' && step.key === 'resp_silent');
  assert.ok(generation?.kind === 'generation', 'the call is kept as a generation');
  assert.deepEqual(generation.usage, { input: 400, output: 20, input_cached_tokens: 500, output_reasoning_tokens: 40, total: 960 });
  assert.deepEqual(generation.metadata, { recordedOutput: false });
  assert.equal(parse(withSilent)[0].steps.filter(step => step.kind === 'generation').length,
    parse(rows)[0].steps.filter(step => step.kind === 'generation').length + 1, 'other model calls keep their own usage');
});
