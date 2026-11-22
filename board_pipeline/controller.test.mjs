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
  let wireTaskId;
  let turnSeq = 0;
  const effects = { spawn: 0, feedback: [], verify: 0 };
  const cfg = {
    route, authorize: async () => true, state: { load: async () => structuredClone(stored), save: async value => { stored = structuredClone(value); } },
    board: nativeBoardPort(handle, { channel: 'pilot', lease: 30 }),
    bb: { async spawn() { effects.spawn++; return { threadId: 'thr_fixture' }; },
      async feedback(packet) { effects.feedback.push(packet); return { confirmed: true }; } },
    submissions: { async read(attempt, after) {
      if (turnSeq <= after) return;
      return { turnSeq, submission: candidate && {
        task_id: wireTaskId ?? task.id, epoch: attempt.epoch, attempt_id: attempt.attempt_id,
        worker_thread_id: attempt.bb_thread_id, candidate_sha: candidate,
      } };
    } },
    async verify(attempt, submission) {
      effects.verify++;
      if (submission.candidate_sha.startsWith('b')) return { outcome: 'rework', reason: 'real_test_failed' };
      if (finish === 'deployed') return { outcome: 'verified', receipt: { settle: 'deferred' } };
      await cfg.board.complete(task.id, attempt.epoch, { sha: submission.candidate_sha });
      return { outcome: 'verified', receipt: { settle: 'completed' } };
    },
  };
  return { cfg, handle, effects, submit: (ch, id) => { candidate = ch?.repeat(40); wireTaskId = id; turnSeq++; },
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

test('a completed first turn without a handoff blocks the card, not another spawn', async t => {
  const x = await lab(t);
  await x.tick();
  assert.equal((await x.tick()).phase, 'working');
  x.submit();
  assert.equal((await x.tick()).reason, 'worker_turn_finished_without_handoff');
  assert.equal((await x.inspect()).state, 'blocked');
  assert.equal((await x.tick()).phase, 'hold');
  assert.equal(x.effects.spawn, 1);
  assert.equal(x.effects.verify, 0);
});

test('after feedback an old completed turn is not treated as a missing new handoff', async t => {
  const x = await lab(t);
  await x.tick();
  x.submit('b');
  await x.tick();
  assert.equal((await x.tick()).phase, 'working');
  x.submit('b');
  assert.equal((await x.tick()).reason, 'worker_turn_finished_without_new_handoff');
  assert.equal((await x.inspect()).state, 'blocked');
  assert.equal(x.effects.feedback.length, 1);
  assert.equal(x.effects.verify, 1);
});

test('a safe integer Board id normalizes to the enrolled string, without weakening the binding', async t => {
  const x = await lab(t);
  await x.tick();
  x.submit('c', Number(x.cfg.route.taskId));
  assert.equal((await x.tick()).phase, 'done');
  assert.equal(x.effects.verify, 1);
});

test('operator can recheck a previously rejected first envelope on the same held attempt', async t => {
  const x = await lab(t);
  const started = await x.tick();
  const record = await x.cfg.state.load();
  await x.cfg.state.save({ ...record, phase: 'hold', reason: 'invalid_or_stale_submission' });
  x.submit('c', Number(x.cfg.route.taskId));
  assert.equal((await x.tick()).phase, 'hold');
  x.cfg.recheckRejectedHandoff = true;
  const result = await x.tick();
  assert.equal(result.phase, 'done');
  assert.equal(result.epoch, started.epoch);
  assert.equal(result.threadId, started.threadId);
  assert.equal(x.effects.spawn, 1);
  assert.equal(x.effects.verify, 1);
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

test('owner and label still match after another actor took the claim, but no worker is spawned', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1780000000000 });
  const x = await lab(t);
  x.cfg.authorize = async state => {
    if (state === 'claimed') {
      t.mock.timers.tick(31_000);
      await x.handle.tasks.claim(x.cfg.route.taskId);
    }
    return true;
  };
  assert.equal((await x.tick()).reason, 'lease_lost_before_spawn');
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
