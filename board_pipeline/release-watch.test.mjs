import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmedWatchRelease, watchPolicy } from './release-watch.mjs';

const config = { boardUrl: 'http://127.0.0.1:44980/api/board', url: 'http://127.0.0.1:44981',
  releaseTask: '101', owner: 'local:user:operator', repo: 'fixture', target: 'staging',
  instance: 'abcf1234-0000-4444-1111-123456789abc' };
const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const promotion = 'c'.repeat(64);
const receipt = { schema: 'darkfactory.release-receipt.v1', task_id: '101', epoch: 2,
  attempt_id: 'fixture-02', finish: 'deployed', sha, digest, target: 'staging',
  target_digest: 'd'.repeat(64), subject_digest: 'e'.repeat(64), approval_digest: 'f'.repeat(64),
  promotion, readback: digest, smoke: 'pass' };
const root = { id: '101', channel: 'pilot', re: null, deleted: false,
  labels: { repo_id: 'fixture', finish: 'deployed' },
  task: { owner: 'local:user:operator', state: 'completed', epoch: 2, result: JSON.stringify(receipt) } };

test('only a native completed release in the configured scope can be observed', () => {
  const policy = watchPolicy(config);
  assert.deepEqual(confirmedWatchRelease(root, policy), { sha, digest, operation: promotion });
  for (const change of [{ channel: 'intake' }, { id: '102' }, { re: '100' }, { deleted: true },
    { labels: { ...root.labels, repo_id: 'other' } },
    { task: { ...root.task, owner: 'local:user:other' } }, { task: { ...root.task, state: 'claimed' } },
    { task: { ...root.task, epoch: 3 } }]) {
    assert.throws(() => confirmedWatchRelease({ ...root, ...change }, policy), { code: 'watch_release_unconfirmed' });
  }
  for (const change of [{ promotion: null }, { target: 'other' }, { smoke: 'fail' }, { readback: 'd'.repeat(64) }]) {
    const changed = { ...root, task: { ...root.task, result: JSON.stringify({ ...receipt, ...change }) } };
    assert.throws(() => confirmedWatchRelease(changed, policy), { code: 'watch_release_unconfirmed' });
  }
});

test('watch policy excludes the live Board, arbitrary endpoints and overlapping Board/target', () => {
  assert.doesNotThrow(() => watchPolicy(config));
  for (const change of [{ boardUrl: 'http://127.0.0.1:44100/api/board' },
    { boardUrl: 'http://127.0.0.1:44981/api/board' }, { url: 'http://127.0.0.1:44981/another-path' },
    { url: 'http://localhost:44981' }, { url: 'http://127.0.0.1:44100' }, { instance: 'unknown' },
    { releaseTask: '101/edit' }, { deploy: true }]) {
    assert.throws(() => watchPolicy({ ...config, ...change }), { code: 'watch_policy_invalid' });
  }
});
