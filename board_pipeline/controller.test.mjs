import assert from 'node:assert/strict';
import test from 'node:test';
import { advance } from './controller.mjs';
import { nativeBoardPort } from './native-board.mjs';
import { loadSdk } from './sdk.mjs';

async function lab(t, finish = 'verified') {
  const { board, local } = loadSdk();
  const backend = local({ memory: true });
  t.after(() => backend.close());
  const handle = board({ backend });
  await handle.createChannel('pilot');
  const { task } = await handle.tasks.create('pilot', { text: 'Synthetic work', noSync: true });
  const route = { taskId: task.id, base: 'a'.repeat(40), policyVersion: 'lab-1', checkProfile: 'fixture',
    worktree: '/synthetic', finish };
  let stored;
  let candidate;
  const effects = { spawn: 0, feedback: [], verify: 0 };
  const cfg = {
    route, authorize: async () => true, state: { load: async () => structuredClone(stored), save: async value => { stored = structuredClone(value); } },
    board: nativeBoardPort(handle, { channel: 'pilot', lease: 30 }),
    bb: { async spawn() { effects.spawn++; return { threadId: 'thr_fixture' }; },
      async feedback(packet) { effects.feedback.push(packet); return { confirmed: true }; } },
    submissions: { async read(attempt) { return candidate && {
      task_id: task.id, epoch: attempt.epoch, attempt_id: attempt.attempt_id,
      worker_thread_id: attempt.bb_thread_id, candidate_sha: candidate,
    }; } },
    async verify(attempt, submission) {
      effects.verify++;
      if (submission.candidate_sha.startsWith('b')) return { outcome: 'rework', reason: 'real_test_failed' };
      if (finish === 'deployed') return { outcome: 'verified', receipt: { settle: 'deferred' } };
      await cfg.board.complete(task.id, attempt.epoch, { sha: submission.candidate_sha });
      return { outcome: 'verified', receipt: { settle: 'completed' } };
    },
  };
  return { cfg, handle, effects, submit: ch => { candidate = ch.repeat(40); },
    tick: () => advance(cfg), inspect: () => cfg.board.lookup(task.id) };
}

test('ready launches once, restart adopts the lease, red returns once and new SHA completes', async t => {
  const x = await lab(t);
  assert.equal((await x.tick()).phase, 'working');
  x.cfg.board = nativeBoardPort(x.handle, { channel: 'pilot' }); // empty adapter after restart
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(x.effects.spawn, 1);
  x.submit('b');
  assert.equal((await x.tick()).phase, 'working');
  assert.equal((await x.inspect()).state, 'claimed');
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(x.effects.feedback.length, 1);
  assert.equal(x.effects.feedback[0].attempt.bb_thread_id, 'thr_fixture');
  x.submit('c');
  assert.equal((await x.tick()).phase, 'done');
  assert.equal((await x.inspect()).result.sha, 'c'.repeat(40));
  assert.equal((await x.tick()).phase, 'done');
  assert.equal(x.effects.verify, 2);
});

test('lost lease with a still-bound worker neither verifies nor launches a second writer', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1780000000000 });
  const x = await lab(t);
  await x.tick();
  t.mock.timers.tick(31_000);
  x.submit('c');
  assert.equal((await x.tick()).phase, 'lease_lost');
  assert.equal((await x.tick()).phase, 'lease_lost');
  assert.equal(x.effects.spawn, 1);
  assert.equal(x.effects.verify, 0);
});

test('an unapproved route does not take a claim or spawn', async t => {
  const x = await lab(t);
  x.cfg.authorize = async () => false;
  assert.equal((await x.tick()).reason, 'route_not_authorized');
  assert.equal((await x.inspect()).state, 'ready');
  assert.equal(x.effects.spawn, 0);
});

test('an ambiguous spawn response does not retry after restart', async t => {
  const x = await lab(t);
  x.cfg.bb.spawn = async () => { x.effects.spawn++; throw new Error('lost transport response'); };
  assert.equal((await x.tick()).phase, 'uncertain');
  assert.equal((await x.tick()).phase, 'uncertain');
  assert.equal(x.effects.spawn, 1);
});

test('verified code is not a deployed result', async t => {
  const x = await lab(t, 'deployed');
  await x.tick();
  x.submit('c');
  const outcome = await x.tick();
  assert.equal(outcome.phase, 'hold');
  assert.equal(outcome.reason, 'release_not_authorized');
  assert.equal((await x.inspect()).state, 'blocked');
});
