import assert from 'node:assert/strict';
import test from 'node:test';
import { advance } from './controller.mjs';
import { nativeBoardPort } from './native-board.mjs';
import { loadSdk } from './sdk.mjs';
import { memoryBoardSdk } from './board-test-fixture.mjs';
import * as ws from './worker-selector.mjs';

const workerSelector = (over = {}) => ({ ...ws, ...over });

// Детерминированный check-контейнер (rootless Docker, --network=none) не
// содержит приватного host-SDK: там тесты идут на in-memory Board той же
// формы. На хосте с установленным SDK — как и раньше через loadSdk.
function sdk() {
  try {
    return loadSdk();
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND' && error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return memoryBoardSdk();
  }
}

async function lab(t, finish = 'verified') {
  const { board, local } = sdk();
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
  const { board, local } = sdk();
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

test('queue mode pins the card l1_profile label into the attempt', async t => {
  // Явный L1-выбор оператора при постановке — контрактная метка:
  // попытка несёт её в verify, а не дефолт repo_id контроллера.
  const x = await queueLab(t, { labels: { ...CONTRACT, l1_profile: 'python-node' } });
  await x.tick();
  x.submit('c');
  await x.tick();
  assert.equal(x.effects.attempts.at(-1).l1_profile, 'python-node');
  // Без метки попытка не несёт явного выбора — действует дефолт.
  const plain = await queueLab(t);
  await plain.tick();
  plain.submit('c');
  await plain.tick();
  assert.equal(plain.effects.attempts.at(-1).l1_profile, undefined);
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

test('queue mode never claims a card of a foreign repo_id', async t => {
  const x = await queueLab(t); // карточка с repo_id = fixture-repo
  x.route.allowlist.repoId = 'other-repo';
  const result = await x.tick();
  assert.equal(result.phase, 'idle');
  assert.equal(x.seen.claim, 0, '0 claim на чужом repo_id');
  assert.equal((await x.card(0)).state, 'ready');
  x.route.allowlist.repoId = 'fixture-repo';
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(x.seen.claim, 1);
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
  x.cfg.bb.probeAvailability = async w => w.provider === 'acp-devin'
    ? { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 }
    : { status: 'available', activeBackgroundAgentCount: 0 };
  x.cfg.bb.inspectWorktree = async () => ({ clean: true, head: 'a'.repeat(40) });
  x.cfg.bb.spawn = async env => {
    x.effects.spawn++;
    assert.equal(env.executor.provider, 'pi');
    assert.equal(env.executor.model, 'opencode-go/deepseek-v4.1-flash');
    return { threadId: 'thr_ds1' };
  };
  assert.equal((await x.tick()).phase, 'working');
  const record = await x.cfg.state.load();
  assert.equal(record.executor.provider, 'pi');
  assert.equal(record.fallbackReason, 'confirmed_refusal:acp-devin');
  // google-критик по умолчанию исключает antigravity/gemini — он записан
  // пропущенным до подтверждённого отказа первичного и spawn резерва.
  assert.equal(record.attemptedWorkers.length, 3);
  assert.equal(record.attemptedWorkers[0].verdict, 'skipped');
  assert.equal(x.effects.spawn, 1, 'первичный не спаунился после probe confirmed_refusal');
  x.submit('c');
  assert.equal((await x.tick()).phase, 'done');
  const attempt = x.effects.attempts.at(-1);
  assert.equal(attempt.executor.provider, 'pi',
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
  assert.equal(record.attemptedWorkers.find(w => w.provider === 'acp-devin').verdict, 'unknown_outcome');
});

// Пункт 3: отказ первичного при грязном worktree — карантин без второго писателя.
test('worker selector quarantines a confirmed refusal on a dirty worktree', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector();
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

test('pre-claim triad validation uses configured baseWorker over selectWorker fallback', async t => {
  const x = await lab(t);
  const configured = { provider: 'acp-devin', model: 'swe-2-1-max' };
  x.cfg.route.critic = { provider: 'acp-devin', model: 'swe-2-medium' };
  x.cfg.workerSelector = workerSelector({
    baseWorker: configured,
    selectWorker: () => [{ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' }],
  });
  assert.equal((await x.tick()).reason, 'route_triad_violation:review_same_family');
  assert.equal((await x.inspect()).state, 'ready');
  assert.equal(x.effects.spawn, 0);
});

test('pre-claim triad validation accepts an independent configured baseWorker', async t => {
  const x = await lab(t);
  const configured = { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' };
  const critic = { provider: 'acp-devin', model: 'swe-2-medium' };
  x.cfg.route.critic = critic;
  x.cfg.workerSelector = workerSelector({
    critic,
    baseWorker: configured,
    selectWorker: () => [ws.PRIMARY_WORKER],
    pinTriad: async () => ({ plan: [configured], critic, arbiter: ws.DEFAULT_ARBITER }),
  });
  x.cfg.bb.probeAvailability = async () => ({ status: 'available', activeBackgroundAgentCount: 0 });
  x.cfg.bb.inspectWorktree = async () => ({ clean: true, head: 'a'.repeat(40) });
  x.cfg.bb.spawn = async envelope => {
    x.effects.spawn++;
    assert.deepEqual(envelope.executor, configured);
    return { threadId: 'thr_configured' };
  };
  assert.equal((await x.tick()).phase, 'working');
  const record = await x.cfg.state.load();
  assert.deepEqual(record.executor, configured);
  assert.equal(x.effects.spawn, 1);
});

test('pre-claim triad validation keeps the selectWorker fallback when baseWorker is undefined', async t => {
  const x = await lab(t);
  let selected = 0;
  x.cfg.route.critic = { provider: 'acp-devin', model: 'swe-2-medium' };
  x.cfg.workerSelector = workerSelector({
    selectWorker: () => {
      selected++;
      return [ws.PRIMARY_WORKER];
    },
  });
  assert.equal((await x.tick()).reason, 'route_triad_violation:review_same_family');
  assert.equal(selected, 1);
  assert.equal((await x.inspect()).state, 'ready');
  assert.equal(x.effects.spawn, 0);
});

// Пункт 4: нарушение триады первичным отклоняет маршрут до claim; нарушение
// резервом — пропуск резерва, маршрут продолжается со следующим кандидатом.
test('a fallback violating the triad is skipped, the route continues', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector();
  // Критик deepseek: резерв pi/deepseek ломает триаду и пропускается,
  // antigravity/gemini остаётся допустимым резервом.
  x.cfg.route.critic = { provider: 'opencode-go', model: 'deepseek-v4' };
  x.cfg.bb.probeAvailability = async w => w.provider === 'acp-devin'
    ? { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 }
    : { status: 'available', activeBackgroundAgentCount: 0 };
  x.cfg.bb.inspectWorktree = async () => ({ clean: true, head: 'a'.repeat(40) });
  x.cfg.bb.spawn = async env => {
    x.effects.spawn++;
    assert.equal(env.executor.provider, 'acp-antigravity-acp');
    return { threadId: 'thr_neon1' };
  };
  assert.equal((await x.tick()).phase, 'working');
  const record = await x.cfg.state.load();
  assert.equal(record.executor.provider, 'acp-antigravity-acp');
  const skipped = record.attemptedWorkers.find(w => w.provider === 'pi');
  assert.equal(skipped.verdict, 'skipped');
  assert.match(skipped.reason, /^triad_violation:/);
  assert.equal(x.effects.spawn, 1);
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

// Board #1666: circuit breaker L2 REWORK — четвёртый L2-раунд останавливает
// попытку без пятого круга; даже триггер no_progress не доходит до арбитража.
test('the fourth L2 rework round stops with l2_rework_limit_exceeded and no fifth round', async t => {
  const x = await lab(t);
  let arbitrations = 0;
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => { arbitrations++; } });
  await x.tick();
  const rework = (finding, extra = {}) => ({ outcome: 'rework',
    reason: 'review_verdict:REVIEW_BLOCKED',
    feedback: { reason: 'review_verdict:REVIEW_BLOCKED', findings: [finding] }, ...extra });
  const bad = {
    [BAD1]: rework({ file: 'a.js', expected: 'e1', actual: 'x1' }),
    [BAD2]: rework({ file: 'b.js', expected: 'e2', actual: 'x2' }),
    [BAD3]: rework({ file: 'c.js', expected: 'e3', actual: 'x3' }),
    // Четвёртый раунд повторяет находку третьего: без потолка здесь был бы
    // триггер repeated_l2_finding и арбитраж; потолок срабатывает раньше.
    ['b' + '4'.repeat(39)]: rework({ file: 'c.js', expected: 'e3', actual: 'x3' }),
  };
  x.cfg.verify = async (attempt, submission) => {
    x.effects.verify++;
    const scripted = bad[submission.candidate_sha];
    if (scripted) return scripted;
    await x.cfg.board.complete(attempt.task_id, attempt.epoch, { sha: submission.candidate_sha });
    return { outcome: 'verified', receipt: { settle: 'completed' } };
  };
  for (const sha of Object.keys(bad).slice(0, 3)) {
    x.submit(sha);
    assert.equal((await x.tick()).phase, 'working', `раунд ${sha.slice(-2)} — обычный возврат`);
  }
  x.submit('b' + '4'.repeat(39));
  const stopped = await x.tick();
  assert.equal(stopped.phase, 'hold');
  assert.equal(stopped.reason, 'l2_rework_limit_exceeded');
  assert.equal(x.effects.feedback.length, 3, 'четвёртый REWORK не вернулся воркеру — пятого круга нет');
  assert.equal(arbitrations, 0, 'арбитраж после лимитного раунда не запускается');
  const record = await x.cfg.state.load();
  assert.equal(record.roundsHistory.length, 4);
  assert.match((await x.inspect()).blocked.reason, /l2_rework_limit_exceeded/);
  // Пятый раунд невозможен: новый handoff по той же попытке не возобновляет проверку.
  const verifies = x.effects.verify;
  x.submit('c');
  const after = await x.tick();
  assert.equal(after.phase, 'hold');
  assert.equal(x.effects.verify, verifies, 'verify на пятый раунд не вызывался');
});

// Board #1666 r5: circuit breaker не зависит от селектора — без workerSelector
// четвёртый L2 REWORK так же останавливает попытку hold'ом и не возвращается
// воркеру четвёртым feedback; пятый кандидат не проверяется.
test('the fourth L2 rework stops with l2_rework_limit_exceeded without workerSelector', async t => {
  const x = await lab(t);
  await x.tick();
  const rework = finding => ({ outcome: 'rework', reason: 'review_verdict:REVIEW_BLOCKED',
    feedback: { reason: 'review_verdict:REVIEW_BLOCKED', findings: [finding] } });
  const bad = {
    [BAD1]: rework({ file: 'a.js', expected: 'e1', actual: 'x1' }),
    [BAD2]: rework({ file: 'b.js', expected: 'e2', actual: 'x2' }),
    [BAD3]: rework({ file: 'c.js', expected: 'e3', actual: 'x3' }),
    ['b' + '4'.repeat(39)]: rework({ file: 'd.js', expected: 'e4', actual: 'x4' }),
  };
  x.cfg.verify = async (attempt, submission) => {
    x.effects.verify++;
    const scripted = bad[submission.candidate_sha];
    if (scripted) return scripted;
    await x.cfg.board.complete(attempt.task_id, attempt.epoch, { sha: submission.candidate_sha });
    return { outcome: 'verified', receipt: { settle: 'completed' } };
  };
  for (const sha of [BAD1, BAD2, BAD3]) {
    x.submit(sha);
    assert.equal((await x.tick()).phase, 'working', `раунд ${sha.slice(-2)} — обычный возврат`);
  }
  x.submit('b' + '4'.repeat(39));
  const stopped = await x.tick();
  assert.equal(stopped.phase, 'hold');
  assert.equal(stopped.reason, 'l2_rework_limit_exceeded');
  assert.equal(x.effects.feedback.length, 3, 'четвёртый REWORK не вернулся воркеру');
  const record = await x.cfg.state.load();
  assert.equal(record.roundsHistory.length, 4);
  assert.match((await x.inspect()).blocked.reason, /l2_rework_limit_exceeded/);
  const verifies = x.effects.verify;
  x.submit('c');
  const after = await x.tick();
  assert.equal(after.phase, 'hold');
  assert.equal(x.effects.verify, verifies, 'verify на пятый раунд не вызывался');
});

test('route.maxL2ReworkRounds настраивает потолок L2-раундов', async t => {
  const x = await lab(t);
  x.cfg.route.maxL2ReworkRounds = 2;
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => ({ decision: 'directed_rework' }) });
  await x.tick();
  const rework = finding => ({ outcome: 'rework', reason: 'review_verdict:REVIEW_BLOCKED',
    feedback: { reason: 'review_verdict:REVIEW_BLOCKED', findings: [finding] } });
  x.cfg.verify = async (attempt, submission) => submission.candidate_sha === BAD1
    ? rework({ file: 'a.js', expected: 'e1', actual: 'x1' })
    : rework({ file: 'b.js', expected: 'e2', actual: 'x2' });
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  const stopped = await x.tick();
  assert.equal(stopped.phase, 'hold');
  assert.equal(stopped.reason, 'l2_rework_limit_exceeded');
  assert.equal(x.effects.feedback.length, 1);
});

// Лимит маршрута только ужесточает потолок: значение выше дефолтного не
// ослабляет circuit breaker — четвёртый L2 REWORK всё равно лимитный.
test('route.maxL2ReworkRounds выше дефолта не отменяет остановку на четвёртом REWORK', async t => {
  const x = await lab(t);
  x.cfg.route.maxL2ReworkRounds = 5;
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => { throw new Error('no arbitration'); } });
  await x.tick();
  const rework = finding => ({ outcome: 'rework', reason: 'review_verdict:REVIEW_BLOCKED',
    feedback: { reason: 'review_verdict:REVIEW_BLOCKED', findings: [finding] } });
  x.cfg.verify = async (attempt, submission) =>
    rework({ file: 'a.js', expected: 'e', actual: `x-${submission.candidate_sha.slice(0, 4)}` });
  for (const sha of [BAD1, BAD2, BAD3]) {
    x.submit(sha);
    assert.equal((await x.tick()).phase, 'working');
  }
  x.submit('b' + '4'.repeat(39));
  const stopped = await x.tick();
  assert.equal(stopped.phase, 'hold');
  assert.equal(stopped.reason, 'l2_rework_limit_exceeded');
  assert.equal(x.effects.feedback.length, 3);
  // Причина владельцу сообщает фактически применённый лимит, а не сырое
  // значение маршрута выше потолка (#1666 r4).
  assert.match((await x.inspect()).blocked?.reason ?? '', /\{"limit":4\}/);
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
    assert.deepEqual(req.arbiter, { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' });
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
  assert.deepEqual(record.arbitration.arbiter, { provider: 'openai', model: 'gpt-6.2-sol' });
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
    decision: 'escalate_owner', question: 'Какое поведение верно по spec §3?',
    subject_digest: DIGEST }) });
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

// Пункт 8: расхождение route.critic с фактическим критиком селектора —
// отказ маршрута до claim (review_profile_mismatch).
test('a route critic conflicting with the selector critic is rejected before claim', async t => {
  const x = await lab(t);
  x.cfg.route.critic = { provider: 'openai', model: 'gpt-6.1-sol' };
  x.cfg.workerSelector = workerSelector({
    critic: { provider: 'openai', model: 'gpt-6.2-sol' },
    arbitrate: async () => { throw new Error('unreachable'); } });
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'review_profile_mismatch');
  assert.equal((await x.inspect()).state, 'ready', 'карточка не заявлена');
  assert.equal(x.effects.spawn, 0);
  // Совпадающий критик маршрута и селектора — маршрут допускается.
  const y = await lab(t);
  y.cfg.route.critic = { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'medium' };
  y.cfg.workerSelector = workerSelector({ critic: { ...y.cfg.route.critic } });
  assert.equal((await y.tick()).phase, 'working');
});

// Пункт 13: harm=10 или DoD-нарушение в ПРОШЛОМ L2-раунде учитывается при
// арбитраже спора текущего раунда — accept_with_notes невозможен.
test('a dispute is judged by combined findings: prior-round harm10 blocks acceptance', async t => {
  const x = await lab(t);
  let arbitrations = 0;
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => {
    arbitrations++;
    return { decision: 'accept_with_notes', notes: 'n', subject_digest: DIGEST };
  } });
  await x.tick();
  scriptedVerify(x, {
    // Первый раунд: находка с harm=10.
    [BAD1]: L2_REWORK([{ ...FINDING, harm: 10 }]),
    // Второй: новая находка + спор по находке первого раунда.
    [BAD2]: L2_REWORK([{ file: 'b.js', expected: 'e2', actual: 'x2' }]),
  });
  withDispute(x, BAD2, 'a.js');
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'harm10_requires_owner');
  assert.equal(arbitrations, 0, 'арбитр не вызывается при harm=10 в истории');
  assert.equal((await x.inspect()).state, 'blocked');
});

test('a dispute is judged by combined findings: prior-round DoD violation blocks acceptance', async t => {
  const x = await lab(t);
  let arbitrations = 0;
  x.cfg.workerSelector = workerSelector({ arbitrate: async () => {
    arbitrations++;
    return { decision: 'accept_with_notes', notes: 'n', subject_digest: DIGEST };
  } });
  await x.tick();
  scriptedVerify(x, {
    // Первый раунд: DoD-нарушение без harm.
    [BAD1]: L2_REWORK([{ ...FINDING, dod_violation: true }]),
    // Второй: спор по той находке.
    [BAD2]: L2_REWORK([{ file: 'b.js', expected: 'e2', actual: 'x2' }]),
  });
  withDispute(x, BAD2, 'a.js');
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  // DoD-флаг в прошлом раунде — fail-closed harm 10: стоп до вызова арбитра.
  assert.equal(out.reason, 'harm10_requires_owner');
  assert.equal(arbitrations, 0);
  assert.equal((await x.inspect()).state, 'blocked');
});

test('allowlist rejects empty or null repoId instead of silently dropping filter', async t => {
  for (const badRepoId of ['', null]) {
    const x = await lab(t);
    delete x.cfg.route.taskId;
    x.cfg.route.allowlist = {
      owner: 'owner-1',
      label: { key: 'automation', value: 'vs1' },
      repoId: badRepoId,
    };
    await assert.rejects(() => x.tick(), /A trusted, enrolled route is required/);
  }
});

// ── Board #1263: закреплённая триада попытки ───────────────────────────────
test('pinned triad: одна триада для spawn, L2, арбитража — резолвится один раз', async t => {
  const x = await lab(t);
  const PINNED_CRITIC = { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' };
  const PINNED_ARBITER = { provider: 'openai', model: 'gpt-5.6-sol' };
  let pins = 0;
  let arbiterSeen = null;
  x.cfg.workerSelector = workerSelector({
    pinTriad: async () => {
      pins++;
      return { plan: [ws.PRIMARY_WORKER], critic: PINNED_CRITIC, arbiter: PINNED_ARBITER };
    },
    arbitrate: async req => {
      arbiterSeen = req.arbiter;
      return { decision: 'escalate_owner', question: 'Развилка?', subject_digest: DIGEST };
    },
  });
  const seen = [];
  x.cfg.verify = async attempt => {
    seen.push(structuredClone(attempt.triad));
    return L2_REWORK([FINDING]);
  };
  // Claim + spawn: триада закреплена в записи попытки.
  assert.equal((await x.tick()).phase, 'working');
  const spawned = await x.cfg.state.load();
  assert.deepEqual(spawned.triad, {
    worker: ws.PRIMARY_WORKER, critic: PINNED_CRITIC, arbiter: PINNED_ARBITER });
  // Два одинаковых L2 REWORK → repeated_l2_finding → арбитраж на закреплённом
  // арбитре, а не на дефолтном Sol.
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2);
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'arbiter_escalated_to_owner');
  assert.deepEqual(arbiterSeen, PINNED_ARBITER);
  // Скоркард резолвится один раз на попытку — не на каждый тик.
  assert.equal(pins, 1);
  // Оба раунда L2 видели ту же закреплённую триаду.
  assert.equal(seen.length, 2);
  for (const triad of seen) assert.deepEqual(triad, spawned.triad);
  // «Рестарт»: следующий тик читает triad из записи, pinTriad не вызывается.
  assert.equal((await x.tick()).phase, 'hold');
  assert.equal(pins, 1);
});

test('rejected pinTriad — явный hold без spawn', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector({
    pinTriad: async () => ({ outcome: 'rejected', reason: 'route_base_triad_violation:x' }),
  });
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'route_base_triad_violation:x');
  assert.equal(x.effects.spawn, 0);
  // Отказ после claim: карточка заблокирована с причиной, а не оставлена
  // захваченной до истечения аренды (#1666 r3).
  const card = await x.inspect();
  assert.equal(card.state, 'blocked');
  assert.match(card.blocked?.reason ?? '', /route_base_triad_violation/);
});

test('исключение pinTriad — fail-closed hold, дефолтный воркер не запускается', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector({
    pinTriad: async () => { throw new Error('scorecard exploded'); },
  });
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'route_pin_failed');
  assert.equal(x.effects.spawn, 0);
});

test('reconcileSpawn после lost spawn восстанавливает закреплённую триаду', async t => {
  const x = await lab(t);
  const PINNED_CRITIC = { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' };
  const PINNED_ARBITER = { provider: 'openai', model: 'gpt-5.6-sol' };
  let pins = 0;
  let seenAtReconcile = null;
  x.cfg.workerSelector = workerSelector({
    pinTriad: async () => {
      pins++;
      return { plan: [ws.PRIMARY_WORKER], critic: PINNED_CRITIC, arbiter: PINNED_ARBITER };
    },
  });
  // Ответ spawn теряется: запись 'launching' + intent остаётся, триада уже
  // закреплена в ней ДО внешнего вызова.
  x.cfg.bb.spawn = async () => { x.effects.spawn++; throw new Error('lost transport response'); };
  assert.equal((await x.tick()).phase, 'uncertain');
  assert.equal(x.effects.spawn, 1);
  const inflight = await x.cfg.state.load();
  assert.deepEqual(inflight.triad,
    { worker: ws.PRIMARY_WORKER, critic: PINNED_CRITIC, arbiter: PINNED_ARBITER });
  // Симулируем обрыв процесса с незакрытым intent(spawn): рестарт видит
  // 'launching' — сверка идёт через reconcileSpawn с записью триады.
  await x.cfg.state.save({ ...inflight, phase: 'launching', reason: undefined, receipt: undefined });
  x.cfg.bb.reconcileSpawn = async attempt => {
    seenAtReconcile = structuredClone(attempt);
    return { status: 'matched', threadId: 'thr_found' };
  };
  assert.equal((await x.tick()).phase, 'working');
  const record = await x.cfg.state.load();
  assert.equal(record.threadId, 'thr_found');
  assert.deepEqual(record.triad,
    { worker: ws.PRIMARY_WORKER, critic: PINNED_CRITIC, arbiter: PINNED_ARBITER });
  // reconcileSpawn получил попытку уже с триадой и известным исполнителем.
  assert.deepEqual(seenAtReconcile.triad, record.triad);
  assert.deepEqual(seenAtReconcile.executor, ws.PRIMARY_WORKER);
  // Повторный pin не требуется — триада читается из записи.
  assert.equal(pins, 1);
  // Сдача: попытка в verify несёт ту же закреплённую триаду и исполнителя.
  x.submit('b'.repeat(40));
  await x.tick();
  assert.deepEqual(x.effects.attempts[0].triad, record.triad);
  assert.deepEqual(x.effects.attempts[0].executor, ws.PRIMARY_WORKER);
});

test('reconcileSpawn после потери ответа резервного кандидата восстанавливает его, а не первичного', async t => {
  const x = await lab(t);
  const PINNED_CRITIC = { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' };
  const PINNED_ARBITER = { provider: 'openai', model: 'gpt-5.6-sol' };
  // Резерв — третье независимое семейство (критик deepseek, арбитр openai).
  const RESERVE = { provider: 'agy', model: 'claude-opus-5.5' };
  let seenAtReconcile = null;
  x.cfg.workerSelector = workerSelector({
    pinTriad: async () =>
      ({ plan: [ws.PRIMARY_WORKER, RESERVE], critic: PINNED_CRITIC, arbiter: PINNED_ARBITER }),
  });
  // Первичный — подтверждённый отказ; у резервного ответ spawn теряется.
  x.cfg.bb.probeAvailability = async w => w.provider === 'acp-devin'
    ? { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 }
    : { status: 'available', activeBackgroundAgentCount: 0 };
  x.cfg.bb.inspectWorktree = async () => ({ clean: true, head: 'a'.repeat(40) });
  x.cfg.bb.spawn = async env => {
    x.effects.spawn++;
    assert.equal(env.executor.provider, 'agy');
    throw new Error('lost transport response');
  };
  assert.equal((await x.tick()).phase, 'uncertain');
  assert.equal(x.effects.spawn, 1);
  const inflight = await x.cfg.state.load();
  // До внешнего spawn запись уже несёт РЕЗЕРВНОГО кандидата как
  // worker триады и executor — reconcile не «откатит» её к первичному.
  assert.deepEqual(inflight.triad,
    { worker: RESERVE, critic: PINNED_CRITIC, arbiter: PINNED_ARBITER });
  assert.deepEqual(inflight.executor, RESERVE);
  await x.cfg.state.save({ ...inflight, phase: 'launching', reason: undefined, receipt: undefined });
  x.cfg.bb.reconcileSpawn = async attempt => {
    seenAtReconcile = structuredClone(attempt);
    return { status: 'matched', threadId: 'thr_reserve' };
  };
  assert.equal((await x.tick()).phase, 'working');
  const record = await x.cfg.state.load();
  assert.equal(record.threadId, 'thr_reserve');
  assert.deepEqual(record.triad.worker, RESERVE);
  assert.deepEqual(record.executor, RESERVE);
  assert.deepEqual(seenAtReconcile.triad, record.triad);
  assert.deepEqual(seenAtReconcile.executor, RESERVE);
  x.submit('b'.repeat(40));
  await x.tick();
  assert.deepEqual(x.effects.attempts[0].executor, RESERVE);
  assert.deepEqual(x.effects.attempts[0].triad, record.triad);
});

// Board #1670: находки критика с произвольными ключами/значениями проецируются
// на whitelist validateAttempt до передачи в verification.prior_findings —
// раунд 2+ не падает с invalid_prior_findings на грязной находке раунда 1.
test('prior_findings are projected onto the acceptance whitelist before verify', async t => {
  const x = await lab(t);
  await x.tick();
  const messy = {
    file: 'a.js', line: 12, expected: 'e1', actual: 'x'.repeat(2500),
    severity: 'P1', title: 'stray critic key', violates_dod: true,
    harm: ['arrays', 'dropped'], input: { nested: 'object' }, freq: 3,
  };
  const bad = {
    [BAD1]: { outcome: 'rework', reason: 'review_verdict:REVIEW_BLOCKED',
      feedback: { reason: 'review_verdict:REVIEW_BLOCKED', findings: [messy] } },
  };
  const seen = [];
  x.cfg.verify = async (attempt, submission) => {
    seen.push(attempt.prior_findings);
    const scripted = bad[submission.candidate_sha];
    if (scripted) return scripted;
    await x.cfg.board.complete(attempt.task_id, attempt.epoch, { sha: submission.candidate_sha });
    return { outcome: 'verified', receipt: { settle: 'completed' } };
  };
  x.submit(BAD1);
  assert.equal((await x.tick()).phase, 'working');
  x.submit('c');
  assert.equal((await x.tick()).phase, 'done');
  assert.deepEqual(seen[1], [{ file: 'a.js', line: 12, expected: 'e1',
    actual: 'x'.repeat(2000), freq: 3, severity: 'P1', dod_violation: true }]);
});

test('queue mode pins allowed_paths into the contract and verification attempt', async t => {
  const scoped = 'board_pipeline/,ops/control-room/';
  const x = await queueLab(t, { labels: { ...CONTRACT, allowed_paths: scoped } });
  await x.tick();
  const record = await x.cfg.state.load();
  assert.equal(record.contract.allowed_paths, scoped);
  assert.equal(record.contract.labels.allowed_paths, scoped);
  x.submit('c');
  await x.tick();
  const attempt = x.effects.attempts.at(-1);
  assert.equal(attempt.allowed_paths, scoped);
  assert.equal(attempt.labels.allowed_paths, undefined);
  assert.deepEqual(attempt.labels, {});

  const empty = await queueLab(t, { labels: { ...CONTRACT, allowed_paths: '' } });
  await empty.tick();
  const emptyRecord = await empty.cfg.state.load();
  assert.equal(emptyRecord.contract.allowed_paths, undefined);
  assert.equal(emptyRecord.contract.labels.allowed_paths, undefined);
});

test('claim_not_held verification outcomes and lease-loss throws become lease_lost', async t => {
  for (const verify of [
    async () => ({ outcome: 'denied', reason: 'claim_not_held:409' }),
    async () => { throw new Error('Lease lost'); },
  ]) {
    const x = await lab(t);
    await x.tick();
    x.cfg.verify = verify;
    x.submit('c');
    const out = await x.tick();
    assert.equal(out.phase, 'lease_lost');
    const record = await x.cfg.state.load();
    assert.equal(record.phase, 'lease_lost');
    assert.equal(x.effects.feedback.length, 0);
  }
});

test('an interrupted queue claiming attempt without a task is cleared and retried cleanly', async t => {
  const x = await queueLab(t);
  const claimReady = x.cfg.board.claimReady.bind(x.cfg.board);
  x.cfg.board.claimReady = async () => { throw new Error('transient board read'); };
  assert.equal((await x.tick()).phase, 'idle');
  assert.equal(await x.cfg.state.load(), null);
  assert.equal(x.effects.spawn, 0);
  x.cfg.board.claimReady = claimReady;
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(x.effects.spawn, 1);
});

test('route change before spawn blocks the claimed card instead of orphaning the lease', async t => {
  const x = await lab(t);
  x.cfg.authorize = async state => state !== 'claimed';
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'route_changed_before_spawn');
  assert.equal((await x.inspect()).state, 'blocked');
  assert.equal(x.effects.spawn, 0);
});

test('confirmed refusal of every pre-spawn worker blocks the claimed card', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector({
    pinTriad: async () => ({ plan: [ws.PRIMARY_WORKER] }),
  });
  x.cfg.bb.probeAvailability = async () => ({ status: 'confirmed_refusal', activeBackgroundAgentCount: 0 });
  x.cfg.bb.inspectWorktree = async () => ({ clean: true, head: 'a'.repeat(40) });
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'all_workers_confirmed_refused');
  assert.equal((await x.inspect()).state, 'blocked');
  assert.equal(x.effects.spawn, 0);
});

test('pinTriad exceptions block the claimed card instead of orphaning the lease', async t => {
  const x = await lab(t);
  x.cfg.workerSelector = workerSelector({
    pinTriad: async () => { throw new Error('scorecard exploded'); },
  });
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'route_pin_failed');
  assert.equal((await x.inspect()).state, 'blocked');
  assert.equal(x.effects.spawn, 0);
});

test('a crashed worker is resumed at most twice and then held deterministically', async t => {
  const x = await lab(t);
  const resumes = [];
  x.cfg.bb.resume = async packet => {
    resumes.push(packet);
    return { resumed: true, threadId: packet.attempt.bb_thread_id };
  };
  x.cfg.submissions.read = async (attempt, after) => ({
    turnSeq: after + 1, completed: false, state: 'exited', exitCode: 1,
  });
  assert.equal((await x.tick()).phase, 'working');
  assert.equal((await x.tick()).phase, 'working');
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(resumes.length, 2);
  assert.deepEqual(resumes.map(packet => packet.crashResumes), [0, 1]);
  const record = await x.cfg.state.load();
  assert.equal(record.crashResumes, 2);
  assert.equal(record.phase, 'working');
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'worker_turn_finished_without_new_handoff');
  assert.equal(resumes.length, 2);
  assert.equal((await x.inspect()).state, 'blocked');
});

test('a typed invalid handoff blocks as invalid instead of crashing verification', async t => {
  const x = await lab(t);
  await x.tick();
  x.cfg.submissions.read = async () => ({ turnSeq: 1, completed: true, state: 'idle', submission: null });
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'invalid_or_stale_submission');
  assert.equal((await x.inspect()).state, 'blocked');
  assert.equal(x.effects.verify, 0);
});
