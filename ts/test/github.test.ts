import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubSlug, matchingPullRequest } from '../src/core/github.ts';
import { otlpPayload } from '../src/core/otlp.ts';
import type { IngestionEvent } from '../src/core/langfuse.ts';

test('normalizes GitHub origins without exporting URL credentials', () => {
  assert.equal(githubSlug('https://user:fake-token@github.com/owner/repo.git?secret=value'), 'owner/repo');
  assert.equal(githubSlug('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(githubSlug('ssh://git@github.com/owner/repo.git'), 'owner/repo');
  assert.equal(githubSlug('https://github.com.example.org/owner/repo.git'), undefined);
  assert.equal(githubSlug('C:/dev/owner/repo'), undefined);
});

test('selects a PR only for an unambiguous matching head or merge commit', () => {
  const pr = { number: 8, head: { sha: 'head' }, merge_commit_sha: 'merge', base: { repo: { full_name: 'Owner/Repo' } } };
  assert.equal(matchingPullRequest([pr], 'owner/repo', 'head'), pr);
  assert.equal(matchingPullRequest([pr], 'owner/repo', 'merge'), pr);
  assert.equal(matchingPullRequest([pr], 'owner/repo', 'other'), undefined);
  assert.equal(matchingPullRequest([pr], 'owner/fork', 'head'), undefined);
  assert.equal(matchingPullRequest([pr, { ...pr, number: 9 }], 'owner/repo', 'head'), undefined);
});

test('emits GitHub attributes on the root span for its own trace', () => {
  const github = {
    repository: 'owner/repo',
    repositoryUrl: 'https://github.com/owner/repo',
    commit: 'deadbeef',
    commitUrl: 'https://github.com/owner/repo/commit/deadbeef',
    pullRequest: { number: 8, url: 'https://github.com/owner/repo/pull/8' },
  };
  const time = '2026-01-01T00:00:00Z';
  const event = (type: string, body: IngestionEvent['body']): IngestionEvent => ({ id: 'event', timestamp: time, type, body });
  const events = [
    event('trace-create', { id: 'one', timestamp: time, metadata: { github } }),
    event('agent-create', { id: 'root', traceId: 'one', startTime: time }),
    event('generation-create', { id: 'model', traceId: 'one', parentObservationId: 'root', startTime: time }),
    event('trace-create', { id: 'two', timestamp: time }),
    event('agent-create', { id: 'other', traceId: 'two', startTime: time }),
  ];
  const [root, model, other] = otlpPayload(events, 'codex', { captureContent: false }).resourceSpans[0].scopeSpans[0].spans;
  assert.deepEqual(root.attributes.find(attribute => attribute.key === 'vcs.change.id')?.value, { stringValue: '8' });
  assert.deepEqual(root.attributes.find(attribute => attribute.key === 'vcs.ref.head.revision')?.value, { stringValue: 'deadbeef' });
  for (const span of [model, other]) assert.ok(!span.attributes.some(attribute => attribute.key.startsWith('vcs.')));
});
