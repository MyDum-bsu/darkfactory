import assert from 'node:assert/strict';
import test from 'node:test';
import { advance } from './controller.mjs';
import { nativeBoardPort } from './native-board.mjs';
import { loadSdk } from './sdk.mjs';
import * as ws from './worker-selector.mjs';

const workerSelector = (over = {}) => ({ ...ws, ...over });

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
  const effects = { spawn: 0, feedback: [], verify: 0, attempts: [] };
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
      effects.attempts.push(structuredClone(attempt));
      if (submission.candidate_sha.startsWith('b')) return { outcome: 'rework', reason: 'real_test_failed' };
      if (finish === 'deployed') return { outcome: 'verified', receipt: { settle: 'deferred' } };
      await cfg.board.complete(attempt.task_id, attempt.epoch,
        { sha: submission.candidate_sha, subject_digest: 'a'.repeat(64) });
      return { outcome: 'verified', receipt: { settle: 'completed' } };
    },
  };
  const shaOf = ch => typeof ch === 'string' && /^[0-9a-f]{40}$/.test(ch) ? ch : ch?.repeat(40);
  return { cfg, handle, effects, submit: (ch, id) => { candidate = shaOf(ch); wireTaskId = id; turnSeq++; },
    tick: () => advance(cfg), inspect: () => cfg.board.lookup(task.id) };
}

// Очередный (queue-driven) слот: маршрут без taskId, допуск по allowlist, две связанные карточки.
async function queueLab(t, { finish = 'verified', owner = 'board:client', labels = CONTRACT, extra } = {}) {
  const { board, local } = loadSdk();
  const backend = local({ memory: true });
  t.after(() => backend.close());
  const handle = board({ backend });
  await handle.createChannel('pilot');
  const seen = { claim: 0 };
  const ported = {
    ...handle,
    tasks: {
      ...handle.tasks,
      claim: async (...args) => { seen.claim++; return handle.tasks.claim(...args); },
    },
  };
  const created = [];
  if (labels !== null || extra === 'held') {
    const { task } = await handle.tasks.create('pilot', { text: 'Head card', noSync: true,
      labels: { ...(labels ?? CONTRACT), queue: 'vs1', finish } });
    created.push(task);
  }
  if (extra === 'dependent' || extra === 'held') {
    const { task } = await handle.tasks.create('pilot', { text: 'Dependent card',
      needs: created.length ? [created[0].id] : [], noSync: true,
      labels: { ...CONTRACT, queue: 'vs1', finish } });
    created.push(task);
  }
  if (extra === 'held') {
    // Чужой писатель держит голову: ready в очереди нет, зависимая остаётся waiting.
    await handle.tasks.claim(created[0].id);
  }
  const route = { allowlist: { owner, label: { key: 'queue', value: 'vs1' } }, base: 'a'.repeat(40),
    policyVersion: 'lab-1', checkProfile: 'pilot', worktree: '/synthetic', finish };
  let stored;
  let candidate;
  let wireTaskId;
  let turnSeq = 0;
  const effects = { spawn: 0, feedback: [], verify: 0, attempts: [] };
  const cfg = {
    route, authorize: async () => true,
    state: { load: async () => structuredClone(stored), save: async value => { stored = structuredClone(value); } },
    board: nativeBoardPort(ported, { channel: 'pilot', lease: 30 }),
    bb: { async spawn() { effects.spawn++; return { threadId: `thr_queue${effects.spawn}` }; },
      async feedback(packet) { effects.feedback.push(packet); return { confirmed: true }; } },
    submissions: { async read(attempt, after) {
      if (turnSeq <= after) return;
      return { turnSeq, submission: candidate && {
        task_id: wireTaskId ?? attempt.task_id, epoch: attempt.epoch, attempt_id: attempt.attempt_id,
        worker_thread_id: attempt.bb_thread_id, candidate_sha: candidate,
      } };
    } },
    async verify(attempt, submission) {
      effects.verify++;
      effects.attempts.push(structuredClone(attempt));
      if (submission.candidate_sha.startsWith('b')) return { outcome: 'rework', reason: 'real_test_failed' };
      await cfg.board.complete(attempt.task_id, attempt.epoch,
        { sha: submission.candidate_sha, subject_digest: 'a'.repeat(64) });
      return { outcome: 'verified', receipt: { settle: 'completed' } };
    },
  };
  const card = index => handle.thread(created[index].id, { limit: 1 }).then(({ message }) => message.task);
  return { cfg, handle, effects, seen, route, card, headId: () => created[0]?.id,
    submit: (ch, id) => { candidate = typeof ch === 'string' && /^[0-9a-f]{40}$/.test(ch)
      ? ch : ch?.repeat(40);
      wireTaskId = id; turnSeq++; },
    tick: () => advance(cfg), reset: () => { stored = undefined; } };
}

const CONTRACT = { spec_digest: 'a'.repeat(64), policy_digest: 'b'.repeat(64), repo_id: 'fixture-repo',
  profile_id: 'pilot' };

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

test('a recheck without a recorded attempt cannot claim or create a worker', async t => {
  const x = await lab(t);
  x.cfg.recheckRejectedHandoff = true;
  assert.equal((await x.tick()).reason, 'no_rejected_handoff_to_recheck');
  assert.equal(x.effects.spawn, 0);
  assert.equal((await x.inspect()).state, 'ready');
});

test('a legacy record without a turn watermark cannot mistake the old handoff for a new turn', async t => {
  const x = await lab(t);
  await x.tick();
  x.submit('b');
  await x.tick();
  const { turnSeq: _old, ...legacy } = await x.cfg.state.load();
  await x.cfg.state.save(legacy);
  assert.equal((await x.tick()).phase, 'working');
  assert.equal((await x.inspect()).state, 'claimed');
  x.submit('c');
  assert.equal((await x.tick()).phase, 'done');
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

test('queue mode claims only the admitted card, unlocks the dependent and stops when empty', async t => {
  const x = await queueLab(t, { extra: 'dependent' });
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(x.effects.spawn, 1);
  assert.equal(x.seen.claim, 1);
  assert.equal((await x.card(0)).state, 'claimed');
  assert.equal((await x.card(1)).state, 'waiting', 'зависимая карточка ещё waiting');
  x.submit('c');
  assert.equal((await x.tick()).phase, 'done');
  const head = (await x.card(0));
  const receipt = typeof head.result === 'string' ? JSON.parse(head.result) : head.result;
  assert.equal(head.state, 'completed');
  assert.equal(receipt.sha, 'c'.repeat(40));
  assert.equal(receipt.subject_digest, 'a'.repeat(64), 'компактная квитанция несёт subject_digest');
  assert.equal((await x.card(1)).state, 'ready', 'нативная разблокировка needs');
  // Следующий слот подхватывает освободившуюся карточку, пустой тик ничего не делает.
  x.reset();
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(x.effects.spawn, 2);
  assert.equal(x.seen.claim, 2);
  x.submit('c');
  assert.equal((await x.tick()).phase, 'done');
  x.reset();
  assert.equal((await x.tick()).phase, 'idle');
  assert.equal(x.effects.spawn, 2);
  assert.equal(x.seen.claim, 2);
});

test('queue mode pins the card contract into the attempt for the subject manifest', async t => {
  const x = await queueLab(t);
  await x.tick();
  x.submit('c');
  await x.tick();
  const attempt = x.effects.attempts.at(-1);
  assert.equal(attempt.task_id, x.headId());
  assert.equal(attempt.repo_id, 'fixture-repo');
  assert.equal(attempt.spec_digest, CONTRACT.spec_digest);
  assert.equal(attempt.policy_digest, CONTRACT.policy_digest);
  assert.equal(attempt.fixtures_digest, null);
  assert.equal(x.effects.spawn, 1);
});

test('queue mode does not claim foreign, unauthorized, incomplete-contract or held cards', async t => {
  for (const [opts, phase, reason] of [
    [{ owner: 'board:other' }, 'idle', undefined],
    [{ labels: null, extra: 'held' }, 'idle', undefined],
    [{ labels: { spec_digest: CONTRACT.spec_digest, profile_id: CONTRACT.profile_id } }, 'idle', undefined],
  ]) {
    const x = await queueLab(t, opts);
    const result = await x.tick();
    assert.equal(result.phase, phase);
    assert.equal(result.reason, reason);
    assert.equal(x.effects.spawn, 0, `0 spawn: ${JSON.stringify(opts)}`);
    assert.equal(x.seen.claim, 0, `0 claim: ${JSON.stringify(opts)}`);
  }
  const x = await queueLab(t);
  x.cfg.authorize = async () => false;
  const result = await x.tick();
  assert.equal(result.phase, 'hold');
  assert.equal(result.reason, 'route_not_authorized');
  assert.equal(x.effects.spawn, 0);
  assert.equal(x.seen.claim, 0);
  assert.equal((await x.card(0)).state, 'ready');
});

test('queue mode returns rework feedback to the same worker under the same lease', async t => {
  const x = await queueLab(t);
  await x.tick();
  x.submit('b');
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(x.effects.feedback.length, 1);
  assert.equal(x.effects.feedback[0].attempt.task_id, x.effects.attempts[0].task_id);
  x.submit('c');
  assert.equal((await x.tick()).phase, 'done');
  assert.equal(x.effects.spawn, 1);
  assert.equal(x.seen.claim, 1);
});

test('queue mode authorizes without a hardcoded card and binds the claimed card', async t => {
  const x = await queueLab(t);
  const calls = [];
  x.cfg.authorize = async (state, taskId) => {
    calls.push([state, taskId]);
    return true;
  };
  await x.tick();
  x.submit('c');
  await x.tick();
  // authorize('ready') без карточки (allowlist-допуск делает claimReady), затем
  // authorize('claimed') с фактическим taskId захваченной карточки.
  assert.deepEqual(calls, [['ready', undefined], ['claimed', x.headId()]]);
  assert.equal(x.effects.spawn, 1);
  assert.equal((await x.card(0)).state, 'completed');
});

test('queue mode does not admit a card whose profile_id differs from the route profile', async t => {
  const x = await queueLab(t, {
    labels: { spec_digest: CONTRACT.spec_digest, policy_digest: CONTRACT.policy_digest,
      repo_id: CONTRACT.repo_id, profile_id: 'other-profile' },
  });
  const result = await x.tick();
  assert.equal(result.phase, 'idle');
  assert.equal(x.seen.claim, 0);
  assert.equal(x.effects.spawn, 0);
  assert.equal((await x.card(0)).state, 'ready');
});

test('worker selector spawns the agreed fallback only on a confirmed refusal and records the trail', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector();
  x.cfg.route.zcodeQuota = 'available';
  x.cfg.bb.probeAvailability = async w => w.provider === 'acp-devin'
    ? { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 }
    : { status: 'available', activeBackgroundAgentCount: 0, zcodeQuota: 'available' };
  x.cfg.bb.inspectWorktree = async () => ({ clean: true, head: 'a'.repeat(40) });
  x.cfg.bb.spawn = async env => {
    x.effects.spawn++;
    assert.equal(env.executor.provider, 'acp-zcode-start');
    assert.equal(env.executor.model, 'builtin:zai-start-plan\\GLM-5.3-Flash');
    return { threadId: 'thr_glm1' };
  };
  assert.equal((await x.tick()).phase, 'working');
  const record = await x.cfg.state.load();
  assert.equal(record.executor.provider, 'acp-zcode-start');
  assert.equal(record.fallbackReason, 'confirmed_refusal:acp-devin');
  assert.equal(record.attemptedWorkers.length, 2);
  assert.equal(x.effects.spawn, 1, 'первичный не спаунился после probe confirmed_refusal');
  x.submit('c');
  assert.equal((await x.tick()).phase, 'done');
  const attempt = x.effects.attempts.at(-1);
  assert.equal(attempt.executor.provider, 'acp-zcode-start',
    'доверенная попытка несёт фактического исполнителя');
});

test('worker selector quarantines an unknown launch outcome without a second writer', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector();
  x.cfg.bb.probeAvailability = async () => 'unknown_outcome';
  x.cfg.bb.spawn = async () => { x.effects.spawn++; return { threadId: 'thr_never' }; };
  assert.equal((await x.tick()).phase, 'uncertain');
  assert.equal((await x.tick()).reason, 'worker_launch_outcome_unknown');
  assert.equal(x.effects.spawn, 0);
  const record = await x.cfg.state.load();
  assert.equal(record.attemptedWorkers[0].verdict, 'unknown_outcome');
});

// Пункт 3: отказ первичного при грязном worktree — карантин без второго писателя.
test('worker selector quarantines a confirmed refusal on a dirty worktree', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector();
  x.cfg.route.zcodeQuota = 'available';
  x.cfg.bb.probeAvailability = async () =>
    ({ status: 'confirmed_refusal', activeBackgroundAgentCount: 0 });
  x.cfg.bb.inspectWorktree = async () => ({ clean: false, head: 'a'.repeat(40) });
  x.cfg.bb.spawn = async () => { x.effects.spawn++; return { threadId: 'thr_never' }; };
  assert.equal((await x.tick()).phase, 'uncertain');
  assert.equal((await x.tick()).reason, 'worker_launch_outcome_unknown');
  assert.equal(x.effects.spawn, 0);
});

test('a triad violation rejects the route before any claim or spawn', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector();
  x.cfg.route.critic = { provider: 'acp-devin', model: 'swe-2-medium' };
  assert.equal((await x.tick()).reason, 'route_triad_violation:review_same_family');
  assert.equal((await x.inspect()).state, 'ready');
  assert.equal(x.effects.spawn, 0);
});

// Пункт 4: триада проверяется для ВСЕХ кандидатов — резерв ZCode семейства glm
// конфликтует с критиком glm, маршрут отклоняется до claim.
test('a fallback violating the triad rejects the route before claim', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector();
  x.cfg.route.zcodeQuota = 'available';
  x.cfg.route.critic = { provider: 'acp-zcode-start',
    model: 'builtin:zai-start-plan\\GLM-5.3-Flash' };
  assert.equal((await x.tick()).reason, 'route_triad_violation:review_same_family');
  assert.equal((await x.inspect()).state, 'ready');
  assert.equal(x.effects.spawn, 0);
});

test('three converging rework rounds complete without a round cap', async t => {
  const x = await lab(t);
  let arbitrations = 0;
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => { arbitrations++; } });
  await x.tick();
  const bad = {
    ['b' + '1'.repeat(39)]: { outcome: 'rework', reason: 'local_checks_failed',
      feedback: { reason: 'local_checks_failed', evidence: [
        { file: 'checks-a.log', exit: 1, sha256: 'a'.repeat(64) }] } },
    ['b' + '2'.repeat(39)]: { outcome: 'rework', reason: 'review_verdict:REVIEW_BLOCKED',
      feedback: { reason: 'review_verdict:REVIEW_BLOCKED',
        findings: [{ file: 'a.js', expected: 'e1', actual: 'x1' },
          { file: 'a2.js', expected: 'e2', actual: 'x2' }] } },
    ['b' + '3'.repeat(39)]: { outcome: 'rework', reason: 'review_verdict:REVIEW_BLOCKED',
      feedback: { reason: 'review_verdict:REVIEW_BLOCKED',
        findings: [{ file: 'b.js', expected: 'e3', actual: 'x3' }] } },
  };
  x.cfg.verify = async (attempt, submission) => {
    x.effects.verify++;
    const scripted = bad[submission.candidate_sha];
    if (scripted) return scripted;
    await x.cfg.board.complete(attempt.task_id, attempt.epoch, { sha: submission.candidate_sha });
    return { outcome: 'verified', receipt: { settle: 'completed' } };
  };
  for (const sha of Object.keys(bad)) {
    x.submit(sha);
    assert.equal((await x.tick()).phase, 'working', `раунд ${sha.slice(-2)} сходится`);
  }
  x.submit('c');
  assert.equal((await x.tick()).phase, 'done');
  assert.equal(x.effects.feedback.length, 3, 'три сходящихся раунда — три возврата воркеру');
  assert.equal(arbitrations, 0, 'арбитр не вызывался при нормальной сходимости');
  const record = await x.cfg.state.load();
  assert.equal(record.roundsHistory.length, 3);
});

// Пункт 6: L1 починил тест A, упал тест B — разные сигнатуры, починка сходится.
test('different failing checks in L1 converge instead of stalling', async t => {
  const x = await lab(t);
  let arbitrations = 0;
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => { arbitrations++; } });
  await x.tick();
  scriptedVerify(x, {
    [BAD1]: { outcome: 'rework', reason: 'local_checks_failed',
      feedback: { reason: 'local_checks_failed', evidence: [
        { file: 'checks-a.log', exit: 1, sha256: 'a'.repeat(64) },
        { file: 'checks-b.log', exit: 0, sha256: 'b'.repeat(64) }] } },
    [BAD2]: { outcome: 'rework', reason: 'local_checks_failed',
      feedback: { reason: 'local_checks_failed', evidence: [
        { file: 'checks-a.log', exit: 0, sha256: 'c'.repeat(64) },
        { file: 'checks-b.log', exit: 1, sha256: 'd'.repeat(64) }] } },
  });
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(GOOD);
  assert.equal((await x.tick()).phase, 'done');
  assert.equal(arbitrations, 0);
});

// Сдача со структурированным спором: dispute привязывается к конкретной сдаче
// и ссылке на реальное замечание прошлого L2.
function withDispute(x, sha, findingRef) {
  const inner = x.cfg.submissions.read;
  x.cfg.submissions.read = async (attempt, after) => {
    const obs = await inner(attempt, after);
    if (obs?.submission && obs.submission.candidate_sha === sha) {
      obs.submission = { ...obs.submission, dispute: {
        finding_ref: findingRef, justification: 'по спеке это корректно',
        spec_evidence: 'spec.md §2' } };
    }
    return obs;
  };
}

const DIGEST = 'd'.repeat(64);
const L2_REWORK = (findings, extra = {}) => ({
  outcome: 'rework', reason: 'review_verdict:REVIEW_BLOCKED', subject_digest: DIGEST,
  feedback: { reason: 'review_verdict:REVIEW_BLOCKED', findings }, ...extra });

const BAD1 = 'b' + '1'.repeat(39);
const BAD2 = 'b' + '2'.repeat(39);
const BAD3 = 'b' + '3'.repeat(39);
const GOOD = 'c'.repeat(40);
const FINDING = { file: 'a.js', expected: 'spec behaviour', actual: 'other behaviour' };

// Верификатор со сценарием: заскриптованные sha возвращают rework, остальные
// завершают карточку через реальный порт Board.
function scriptedVerify(x, bad) {
  x.cfg.verify = async (attempt, submission) => {
    x.effects.verify++;
    const scripted = bad[submission.candidate_sha];
    if (scripted) return typeof scripted === 'function' ? scripted(attempt, submission) : scripted;
    await x.cfg.board.complete(attempt.task_id, attempt.epoch, { sha: submission.candidate_sha });
    return { outcome: 'verified', receipt: { settle: 'completed' } };
  };
}

// Заглушка полного seal на стороне приёмки: для 'completed' проходит seal и
// вызывает реальный board.complete — для регрессий seal возвращает исход.
function sealStub(x, outcome) {
  return (attempt, submission) => ({
    ...L2_REWORK([{ file: 'b.js' }]),
    sealAndComplete: async arbitrationReceipt => {
      if (outcome !== 'completed') return outcome;
      await x.cfg.board.complete(attempt.task_id, attempt.epoch,
        { sha: submission.candidate_sha, arbitration: arbitrationReceipt });
      return { outcome: 'verified', receipt: { settle: 'completed' } };
    },
  });
}

test('a substantive dispute triggers a third-family arbiter and one directed rework round', async t => {
  const x = await lab(t);
  let arbitrations = 0;
  x.cfg.workerSelector = workerSelector({ arbitrate: async req => {
    arbitrations++;
    assert.equal(req.arbiter.provider, 'google', 'арбитр из третьего семейства');
    assert.equal(req.subject_digest, DIGEST);
    return { decision: 'directed_rework', directive: 'исправь только оспариваемую находку',
      subject_digest: DIGEST };
  } });
  await x.tick();
  scriptedVerify(x, {
    [BAD1]: L2_REWORK([FINDING]),
    [BAD2]: L2_REWORK([{ file: 'b.js', expected: 'e2', actual: 'x2' }]),
  });
  withDispute(x, BAD2, 'a.js');
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(arbitrations, 1);
  const last = x.effects.feedback.at(-1);
  assert.equal(last.reason, 'arbiter_directed_rework');
  assert.equal(last.evidence.directive, 'исправь только оспариваемую находку');
  assert.ok(last.feedbackId.endsWith(':arb'));
  let record = await x.cfg.state.load();
  assert.equal(record.arbitrationUsed, 1);
  x.submit(GOOD);
  assert.equal((await x.tick()).phase, 'done');
});

// Пункт 7: спор по несуществующей ссылке арбитраж не запускает.
test('a dispute against a nonexistent finding ref is not arbitrated', async t => {
  const x = await lab(t);
  let arbitrations = 0;
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => { arbitrations++; } });
  await x.tick();
  scriptedVerify(x, {
    [BAD1]: L2_REWORK([FINDING]),
    [BAD2]: L2_REWORK([{ file: 'b.js', expected: 'e2', actual: 'x2' }]),
  });
  withDispute(x, BAD2, 'ghost.js');
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(arbitrations, 0, 'фейковый dispute не запускает арбитраж');
  assert.equal(x.effects.feedback.length, 2);
});

// Пункт 7: одинаковый tree_sha разных коммитов — отсутствие прогресса.
test('a new commit with a repeated tree_sha triggers no_progress arbitration', async t => {
  const x = await lab(t);
  const seen = [];
  x.cfg.workerSelector = workerSelector({ arbitrate: async req => {
    seen.push(req);
    return { decision: 'directed_rework', directive: 'change the tree',
      subject_digest: DIGEST };
  } });
  await x.tick();
  const TREE = 'f'.repeat(40);
  scriptedVerify(x, {
    [BAD1]: { ...L2_REWORK([FINDING]), tree_sha: TREE },
    [BAD2]: { ...L2_REWORK([{ file: 'b.js' }]), tree_sha: TREE },
  });
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].trigger.kind, 'duplicate_tree_sha');
});

// Пункт 7: взаимоисключающие требования L2 по одному месту — substantive_dispute.
test('contradictory L2 requirements on the same spot trigger arbitration', async t => {
  const x = await lab(t);
  const seen = [];
  x.cfg.workerSelector = workerSelector({ arbitrate: async req => {
    seen.push(req);
    return { decision: 'directed_rework', directive: 'resolve the contradiction',
      subject_digest: DIGEST };
  } });
  await x.tick();
  scriptedVerify(x, {
    [BAD1]: L2_REWORK([{ file: 'x.js', line: 5, expected: 'A', actual: 'B' }]),
    [BAD2]: L2_REWORK([{ file: 'x.js', line: 5, expected: 'B', actual: 'A' }]),
  });
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].trigger.kind, 'contradictory_l2_findings');
  x.submit(GOOD);
  assert.equal((await x.tick()).phase, 'done');
});

test('arbiter accept_with_notes completes the card only through a full seal', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => ({
    decision: 'accept_with_notes', notes: 'cosmetic finding only', subject_digest: DIGEST }) });
  await x.tick();
  scriptedVerify(x, {
    [BAD1]: L2_REWORK([FINDING]),
    [BAD2]: sealStub(x, 'completed'),
  });
  withDispute(x, BAD2, 'a.js');
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  assert.equal((await x.tick()).phase, 'done');
  const head = await x.inspect();
  assert.equal(head.state, 'completed');
  assert.equal(head.result.sha, BAD2);
  const record = await x.cfg.state.load();
  assert.equal(record.arbitration.decision, 'accept_with_notes');
  assert.equal(record.arbitration.arbiter.provider, 'google');
});

// Пункт 1: арбитрованное принятие никогда не обходит seal — грязный worktree,
// дрейф живой метки finish/spec_digest или потеря аренды на seal отменяют complete.
test('accept_with_notes never bypasses the seal: drift or lost lease blocks complete', async t => {
  for (const [sealed, phase, reason] of [
    [{ outcome: 'hold', reason: 'dirty_worktree' }, 'hold', 'dirty_worktree'],
    [{ outcome: 'hold', reason: 'finish_drift' }, 'hold', 'finish_drift'],
    [{ outcome: 'hold', reason: 'spec_digest_drift' }, 'hold', 'spec_digest_drift'],
    [{ outcome: 'denied', reason: 'claim_not_held:409' }, 'lease_lost', 'claim_not_held:409'],
    [{ outcome: 'uncertain', reason: 'complete_failed:lost' }, 'uncertain', 'complete_failed:lost'],
  ]) {
    const x = await lab(t);
    let completes = 0;
    const origComplete = x.cfg.board.complete.bind(x.cfg.board);
    x.cfg.board.complete = async (...args) => { completes++; return origComplete(...args); };
    x.cfg.workerSelector = workerSelector({ arbitrate: async () => ({
      decision: 'accept_with_notes', notes: 'n', subject_digest: DIGEST }) });
    await x.tick();
    scriptedVerify(x, {
      [BAD1]: L2_REWORK([FINDING]),
      [BAD2]: sealStub(x, sealed),
    });
    withDispute(x, BAD2, 'a.js');
    x.submit(BAD1);
    assert.equal((await x.tick()).phase, 'working');
    x.submit(BAD2);
    const out = await x.tick();
    assert.equal(out.phase, phase, sealed.reason);
    assert.equal(out.reason, reason, sealed.reason);
    assert.equal(completes, 0, `complete не вызван при ${sealed.reason}`);
  }
});

// Пункт 2: accept_with_notes с чужим subject_digest отклоняется до seal.
test('accept_with_notes with a foreign subject_digest never reaches the seal', async t => {
  const x = await lab(t);
  let sealCalls = 0;
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => ({
    decision: 'accept_with_notes', notes: 'n', subject_digest: 'f'.repeat(64) }) });
  await x.tick();
  scriptedVerify(x, {
    [BAD1]: L2_REWORK([FINDING]),
    [BAD2]: () => ({ ...L2_REWORK([{ file: 'b.js' }]),
      sealAndComplete: async () => { sealCalls++; } }),
  });
  // Заглушка верификатора несёт манифест; чужой digest арбитра — mismatch.
  withDispute(x, BAD2, 'a.js');
  x.submit(BAD1);
  await x.tick();
  x.submit(BAD2);
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'arbiter_subject_mismatch');
  assert.equal(sealCalls, 0);
});

test('arbiter escalate_owner puts one concrete needs_input question on the card', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => ({
    decision: 'escalate_owner', question: 'Какое поведение верно по spec §3?' }) });
  await x.tick();
  scriptedVerify(x, {
    [BAD1]: L2_REWORK([FINDING]),
    [BAD2]: L2_REWORK([{ file: 'b.js' }]),
  });
  withDispute(x, BAD2, 'a.js');
  let blockedMessage = '';
  const origBlock = x.cfg.board.block.bind(x.cfg.board);
  x.cfg.board.block = async (id, epoch, message) => {
    blockedMessage = message;
    return origBlock(id, epoch, message);
  };
  x.submit(BAD1);
  await x.tick();
  x.submit(BAD2);
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'arbiter_escalated_to_owner');
  assert.equal((await x.inspect()).state, 'blocked');
  assert.match(blockedMessage, /Какое поведение верно по spec §3\?/);
});

test('a second dispute after a directed rework exhausts arbitration into needs_input', async t => {
  const x = await lab(t);
  let calls = 0;
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => {
    calls++;
    return { decision: 'directed_rework', directive: `fix ${calls}`, subject_digest: DIGEST };
  } });
  await x.tick();
  scriptedVerify(x, {
    [BAD1]: L2_REWORK([FINDING]),
    [BAD2]: L2_REWORK([{ file: 'b.js', expected: 'e2', actual: 'x2' }]),
    [BAD3]: L2_REWORK([{ file: 'c.js', expected: 'e3', actual: 'x3' }]),
  });
  // Спор второго раунда ссылается на находку первого (a.js), третьего — второго (b.js).
  const inner = x.cfg.submissions.read;
  x.cfg.submissions.read = async (attempt, after) => {
    const obs = await inner(attempt, after);
    const refs = { [BAD2]: 'a.js', [BAD3]: 'b.js' };
    if (obs?.submission && refs[obs.submission.candidate_sha]) {
      obs.submission = { ...obs.submission, dispute: {
        finding_ref: refs[obs.submission.candidate_sha],
        justification: 'j', spec_evidence: 's' } };
    }
    return obs;
  };
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(calls, 1);
  x.submit(BAD3);
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'arbitration_exhausted');
  assert.equal((await x.inspect()).state, 'blocked');
  assert.equal(calls, 1, 'арбитр вызывается не более одного раза на попытку');
});

test('a harm=10 finding goes straight to the owner, never to arbiter acceptance', async t => {
  const x = await lab(t);
  let arbitrations = 0;
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => {
    arbitrations++;
    return { decision: 'accept_with_notes', notes: 'n', subject_digest: DIGEST };
  } });
  await x.tick();
  scriptedVerify(x, {
    [BAD1]: L2_REWORK([FINDING]),
    // Тот же finding повторяется с harm=10: триггер repeated_l2_finding.
    [BAD2]: L2_REWORK([{ ...FINDING, harm: 10 }]),
  });
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'harm10_requires_owner');
  assert.equal(arbitrations, 0);
  assert.equal((await x.inspect()).state, 'blocked');
});

test('two identical deterministic failures hold without calling the arbiter', async t => {
  const x = await lab(t);
  let arbitrations = 0;
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => { arbitrations++; } });
  await x.tick();
  const l1 = { outcome: 'rework', reason: 'local_checks_failed',
    feedback: { reason: 'local_checks_failed', evidence: [
      { file: 'checks-a.log', exit: 1, sha256: 'a'.repeat(64) }] } };
  scriptedVerify(x, { [BAD1]: l1, [BAD2]: l1 });
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'no_progress_deterministic_gate');
  assert.equal(arbitrations, 0, 'красный детерминированный гейт не арбитрируется');
  assert.equal((await x.inspect()).state, 'blocked');
  assert.equal(x.effects.feedback.length, 1);
});
