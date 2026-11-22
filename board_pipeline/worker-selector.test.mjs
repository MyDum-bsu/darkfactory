import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertTriadIndependent,
  attemptSpawnWithFallback,
  DEFAULT_ARBITER,
  DEFAULT_CRITIC,
  evaluateReworkProgress,
  FALLBACK_ZCODE,
  maxHarmOf,
  NARROW_RESERVE_PI,
  PRIMARY_WORKER,
  resolveArbitration,
  selectWorker,
  workerFamily,
} from './worker-selector.mjs';
import { ReviewDenied } from './review-runner.mjs';

const ATTEMPT = { task_id: '7', epoch: 3, attempt_id: 'att-1' };

function spawnLog(results) {
  const calls = [];
  return {
    calls,
    spawn: async envelope => {
      calls.push(envelope.executor);
      const next = results.length > 1 ? results.shift() : results[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('selectWorker ставит acp-devin/swe-2-high первым, ZCode резервом, pi — только по допуску', () => {
  const plan = selectWorker({ route: {} });
  assert.equal(plan[0].provider, 'acp-devin');
  assert.equal(plan[0].model, 'swe-2-high');
  assert.deepEqual(plan[1], FALLBACK_ZCODE);
  assert.equal(plan.length, 2, 'узкий резерв не входит в план без allowNarrowReserve');
  const wide = selectWorker({ route: { allowNarrowReserve: true } });
  assert.equal(wide.length, 3);
  assert.deepEqual(wide[2], NARROW_RESERVE_PI);
});

test('workerFamily различает cognition, glm, deepseek, openai, google', () => {
  assert.equal(workerFamily(PRIMARY_WORKER), 'cognition');
  assert.equal(workerFamily(FALLBACK_ZCODE), 'glm');
  assert.equal(workerFamily(NARROW_RESERVE_PI), 'deepseek');
  assert.equal(workerFamily(DEFAULT_CRITIC), 'openai');
  assert.equal(workerFamily(DEFAULT_ARBITER), 'google');
  assert.equal(workerFamily({ provider: 'unknown', model: 'unknown' }), null);
});

test('доступный первичный исполнитель запускается без резерва и fallbackReason', async () => {
  const { calls, spawn } = spawnLog([{ threadId: 'thr_devin1' }]);
  const selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn,
    probe: async () => ({ status: 'available' }),
  });
  assert.equal(selection.outcome, 'spawned');
  assert.equal(selection.worker.provider, 'acp-devin');
  assert.equal(selection.fallbackReason, null);
  assert.equal(calls.length, 1);
  assert.equal(selection.attemptedWorkers.length, 1);
  assert.equal(selection.attemptedWorkers[0].verdict, 'spawned');
});

test('подтверждённый отказ первичного + доступная квота ZCode → резерв GLM с fallbackReason', async () => {
  const { calls, spawn } = spawnLog([{ threadId: 'thr_glm1' }]);
  const probes = [];
  const selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn,
    probe: async worker => {
      probes.push(worker.provider);
      return worker.provider === 'acp-devin'
        ? { status: 'confirmed_refusal' }
        : { status: 'available', zcodeQuota: 'available' };
    },
  });
  assert.equal(selection.outcome, 'spawned');
  assert.equal(selection.worker.provider, 'acp-zcode-start');
  assert.equal(selection.worker.model, 'builtin:zai-start-plan\\GLM-5.3-Flash');
  assert.equal(selection.worker.effort, 'max');
  assert.equal(selection.fallbackReason, 'confirmed_refusal:acp-devin');
  assert.deepEqual(calls.map(c => c.provider), ['acp-zcode-start'],
    'первичный даже не спаунится после probe confirmed_refusal');
  assert.equal(selection.attemptedWorkers.length, 2);
});

test('подтверждённый отказ spawn первого хода при чистом worktree и 0 фоновых агентов допускает резерв', async () => {
  const { spawn } = spawnLog([
    { status: 'confirmed_refusal', activeBackgroundAgentCount: 0, worktreeClean: true },
    { threadId: 'thr_glm2' },
  ]);
  const selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn,
    probe: async () => ({ status: 'available', zcodeQuota: 'available' }),
  });
  assert.equal(selection.outcome, 'spawned');
  assert.equal(selection.worker.provider, 'acp-zcode-start');
  assert.equal(selection.fallbackReason, 'confirmed_refusal:acp-devin');
});

test('отказ spawn при живом фоновом агенте или грязном worktree — uncertain без второго писателя', async () => {
  for (const refusal of [
    { status: 'confirmed_refusal', activeBackgroundAgentCount: 1, worktreeClean: true },
    { status: 'confirmed_refusal', activeBackgroundAgentCount: 0, worktreeClean: false },
    { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 },
    { unexpected: 'shape' },
  ]) {
    const { calls, spawn } = spawnLog([refusal, { threadId: 'thr_never' }]);
    const selection = await attemptSpawnWithFallback({
      attempt: ATTEMPT, spawn,
      probe: async () => ({ status: 'available', zcodeQuota: 'available' }),
    });
    assert.equal(selection.outcome, 'uncertain', JSON.stringify(refusal));
    assert.equal(selection.reason, 'worker_launch_outcome_unknown');
    assert.equal(calls.length, 1, 'второй писатель не запускался');
  }
});

test('неизвестный исход probe или потерянный ответ spawn — uncertain без переключения', async () => {
  for (const probe of [
    async () => 'unknown_outcome',
    async () => undefined,
    async () => { throw new Error('lost transport'); },
    async () => ({ status: 'timeout' }),
  ]) {
    const { calls, spawn } = spawnLog([{ threadId: 'thr_never' }]);
    const selection = await attemptSpawnWithFallback({ attempt: ATTEMPT, spawn, probe });
    assert.equal(selection.outcome, 'uncertain');
    assert.equal(selection.reason, 'worker_launch_outcome_unknown');
    assert.equal(calls.length, 0, 'spawn не вызывался при неизвестном probe');
  }
  const { calls, spawn } = spawnLog([new Error('spawn ack lost'), { threadId: 'thr_never' }]);
  const selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn, probe: async () => 'available',
  });
  assert.equal(selection.outcome, 'uncertain');
  assert.equal(calls.length, 1);
});

test('квота ZCode не подтверждена — резерв не запускается; узкий резерв только по допуску', async () => {
  const refused = { status: 'confirmed_refusal' };
  // Без allowNarrowReserve: все резервы закрыты → unavailable.
  const x = spawnLog([{ threadId: 'thr_never' }]);
  let selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn: x.spawn, route: {},
    probe: async w => w.provider === 'acp-zcode-start'
      ? { status: 'available', zcodeQuota: 'exhausted' } : refused,
  });
  assert.equal(selection.outcome, 'unavailable');
  assert.equal(x.calls.length, 0);
  // С allowNarrowReserve: узкий резерв pi/deepseek пробуется и запускается.
  const y = spawnLog([{ threadId: 'thr_pi1' }]);
  selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn: y.spawn, route: { allowNarrowReserve: true },
    probe: async w => {
      if (w.provider === 'acp-zcode-start') return { status: 'available', zcodeQuota: 'exhausted' };
      if (w.provider === 'pi') return { status: 'available' };
      return refused;
    },
  });
  assert.equal(selection.outcome, 'spawned');
  assert.equal(selection.worker.provider, 'pi');
  assert.equal(selection.worker.model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(y.calls.length, 1);
  assert.equal(selection.attemptedWorkers.length, 3);
});

test('assertTriadIndependent требует три разных семейства', () => {
  assert.deepEqual(
    assertTriadIndependent({ executor: PRIMARY_WORKER }),
    { executor: 'cognition', critic: 'openai', arbiter: 'google' });
  assert.deepEqual(assertTriadIndependent({ executor: FALLBACK_ZCODE }),
    { executor: 'glm', critic: 'openai', arbiter: 'google' });
  assert.deepEqual(assertTriadIndependent({ executor: NARROW_RESERVE_PI }),
    { executor: 'deepseek', critic: 'openai', arbiter: 'google' });
  // Критик того же семейства, что исполнитель — отказ.
  assert.throws(() => assertTriadIndependent({
    executor: PRIMARY_WORKER,
    critic: { provider: 'acp-devin', model: 'swe-2-medium' },
  }), e => e instanceof ReviewDenied && e.reason === 'review_same_family');
  // Арбитр обязан быть третьим семейством, а не критиком и не исполнителем.
  assert.throws(() => assertTriadIndependent({
    executor: PRIMARY_WORKER, arbiter: DEFAULT_CRITIC,
  }), e => e.reason === 'arbiter_family_not_independent');
  assert.throws(() => assertTriadIndependent({
    executor: PRIMARY_WORKER,
    arbiter: { provider: 'acp-devin', model: 'swe-2-low' },
  }), e => e.reason === 'arbiter_family_not_independent');
  assert.throws(() => assertTriadIndependent({
    executor: PRIMARY_WORKER, arbiter: { provider: 'mystery', model: 'x' },
  }), e => e.reason === 'arbiter_unknown_family');
});

const l2Round = (over = {}) => ({
  sha: 'c'.repeat(40), tree_sha: null, gate: 'l2',
  signature: 'src/a.js|expect X|got Y', blocking: 1, dispute: null,
  contradictory: false, ...over,
});
const detRound = (gate, sig, over = {}) => ({
  sha: 'b'.repeat(40), tree_sha: null, gate, signature: `${gate}|${sig}`,
  blocking: null, dispute: null, contradictory: false, ...over,
});

test('сходящаяся починка любой длины не даёт триггеров — нет правила «два круга»', () => {
  const history = [
    detRound('l1', 'sig-1'),
    detRound('l1', 'sig-2'),
    l2Round({ signature: 'a|e1|x1', blocking: 3 }),
    l2Round({ signature: 'b|e2|x2', blocking: 2 }),
    l2Round({ signature: 'c|e3|x3', blocking: 1 }),
  ];
  assert.equal(evaluateReworkProgress({ roundsHistory: history }).trigger, null);
});

test('no_progress: повторный tree_sha', () => {
  const history = [
    l2Round({ tree_sha: 'f'.repeat(40), signature: 'a|e|x' }),
    l2Round({ tree_sha: 'f'.repeat(40), signature: 'b|e|y', blocking: 0 }),
  ];
  const p = evaluateReworkProgress({ roundsHistory: history });
  assert.equal(p.trigger, 'no_progress');
  assert.equal(p.kind, 'duplicate_tree_sha');
  assert.equal(p.deterministicGate, false);
});

test('no_progress: два раза подряд красный детерминированный гейт с той же сигнатурой', () => {
  for (const gate of ['l1', 'tamper', 'l3']) {
    const history = [detRound(gate, 'same-sig'), detRound(gate, 'same-sig')];
    const p = evaluateReworkProgress({ roundsHistory: history });
    assert.equal(p.trigger, 'no_progress', gate);
    assert.equal(p.kind, 'repeated_deterministic_failure');
    assert.equal(p.deterministicGate, true);
  }
  // Разная сигнатура — это прогресс, не триггер.
  const p = evaluateReworkProgress({
    roundsHistory: [detRound('l1', 'sig-a'), detRound('l1', 'sig-b')],
  });
  assert.equal(p.trigger, null);
});

test('no_progress: повторный L2-дефект или неубывающее число блокирующих findings', () => {
  const same = evaluateReworkProgress({ roundsHistory: [l2Round(), l2Round()] });
  assert.equal(same.kind, 'repeated_l2_finding');
  const stuck = evaluateReworkProgress({ roundsHistory: [
    l2Round({ signature: 'a|e|x', blocking: 2 }),
    l2Round({ signature: 'b|e|y', blocking: 2 }),
  ] });
  assert.equal(stuck.kind, 'repeated_l2_finding');
  const converging = evaluateReworkProgress({ roundsHistory: [
    l2Round({ signature: 'a|e|x', blocking: 2 }),
    l2Round({ signature: 'b|e|y', blocking: 1 }),
  ] });
  assert.equal(converging.trigger, null);
});

test('substantive_dispute: валидный структурированный спор на L2 и противоречащие требования', () => {
  const dispute = { finding_ref: 'f1', justification: 'spec says X', spec_evidence: 'spec.md §2' };
  const p = evaluateReworkProgress({ roundsHistory: [l2Round({ dispute })] });
  assert.equal(p.trigger, 'substantive_dispute');
  assert.equal(p.kind, 'worker_dispute');
  const c = evaluateReworkProgress({ roundsHistory: [l2Round({ contradictory: true })] });
  assert.equal(c.trigger, 'substantive_dispute');
  assert.equal(c.kind, 'contradictory_l2_requirements');
  // Невалидный спор и спор не на L2 — не триггеры.
  assert.equal(evaluateReworkProgress({ roundsHistory: [
    l2Round({ dispute: { finding_ref: 'f1', justification: '', spec_evidence: 'x' } }),
  ] }).trigger, null);
  assert.equal(evaluateReworkProgress({ roundsHistory: [
    detRound('l1', 's', { dispute }),
  ] }).trigger, null);
});

const arbAttempt = { ...ATTEMPT, executor: PRIMARY_WORKER };
const liveHeld = async (id, epoch) => ({ epoch });
const disputeTrigger = { trigger: 'substantive_dispute', kind: 'worker_dispute', evidence: {} };

test('resolveArbitration: красный детерминированный гейт — прямой hold без вызова арбитра', async () => {
  let called = 0;
  const r = await resolveArbitration({
    attempt: arbAttempt,
    trigger: { trigger: 'no_progress', kind: 'repeated_deterministic_failure', deterministicGate: true },
    verifyHeld: liveHeld,
    arbitrate: async () => { called++; },
  });
  assert.equal(r.decision, 'hold');
  assert.equal(r.reason, 'no_progress_deterministic_gate');
  assert.equal(called, 0);
});

test('resolveArbitration: harm=10, отсутствие арбитра и исчерпание — hold владельцу', async () => {
  let called = 0;
  const arbitrate = async () => { called++; return { decision: 'accept_with_notes', notes: 'n' }; };
  assert.equal((await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, maxHarm: 10, arbitrate,
  })).reason, 'harm10_requires_owner');
  assert.equal((await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, arbiter: null, arbitrate,
  })).reason, 'arbiter_unavailable');
  assert.equal((await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, arbitrationUsed: 1, arbitrate,
  })).reason, 'arbitration_exhausted');
  // Арбитр из семейства критика независимым не считается.
  assert.equal((await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, arbiter: DEFAULT_CRITIC, arbitrate,
  })).reason, 'arbiter_unavailable');
  assert.equal(called, 0, 'арбитр не вызывался ни в одной из ветвей hold');
});

test('resolveArbitration: directed_rework — один направленный раунд с обязательным directive/findings', async () => {
  const seen = [];
  const r = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: 'd'.repeat(64),
    verifyHeld: liveHeld,
    arbitrate: async req => { seen.push(req); return {
      decision: 'directed_rework', directive: 'fix only the disputed finding',
      subject_digest: 'd'.repeat(64) }; },
  });
  assert.equal(r.decision, 'directed_rework');
  assert.equal(r.arbitrationUsed, 1);
  assert.equal(r.directive, 'fix only the disputed finding');
  assert.equal(seen[0].subject_digest, 'd'.repeat(64));
  assert.equal(seen[0].arbiter.provider, 'google');
  // Пустой directive и пустые findings — невалидное решение.
  const bad = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, verifyHeld: liveHeld,
    arbitrate: async () => ({ decision: 'directed_rework', findings: [] }),
  });
  assert.equal(bad.decision, 'hold');
  assert.equal(bad.reason, 'arbiter_response_invalid');
});

test('resolveArbitration: accept_with_notes фиксирует ArbitrationReceipt и привязку к subject_digest', async () => {
  const digest = 'e'.repeat(64);
  const r = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: digest,
    verifyHeld: liveHeld, maxHarm: 3,
    arbitrate: async () => ({ decision: 'accept_with_notes', notes: 'minor style only',
      subject_digest: digest }),
  });
  assert.equal(r.decision, 'accept_with_notes');
  assert.equal(r.receipt.kind, 'arbitration');
  assert.equal(r.receipt.subject_digest, digest);
  assert.equal(r.receipt.task_id, ATTEMPT.task_id);
  // Несовпавший subject_digest и пустые notes отвергаются.
  for (const ruling of [
    { decision: 'accept_with_notes', notes: 'n', subject_digest: 'f'.repeat(64) },
    { decision: 'accept_with_notes', notes: '  ' },
    { decision: 'nonsense' },
    null,
  ]) {
    const bad = await resolveArbitration({
      attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: digest,
      verifyHeld: liveHeld, arbitrate: async () => ruling,
    });
    assert.equal(bad.decision, 'hold');
    assert.equal(bad.reason, 'arbiter_response_invalid');
  }
});

test('resolveArbitration: escalate_owner с вопросом и потеря аренды до вызова', async () => {
  const r = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, verifyHeld: liveHeld,
    arbitrate: async () => ({ decision: 'escalate_owner', question: 'Какое поведение верно по §3?' }),
  });
  assert.equal(r.decision, 'escalate_owner');
  assert.equal(r.question, 'Какое поведение верно по §3?');
  const noLease = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger,
    verifyHeld: async () => ({ epoch: 99 }),
    arbitrate: async () => ({ decision: 'escalate_owner', question: 'q' }),
  });
  assert.equal(noLease.decision, 'lease_lost');
  const noQuestion = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, verifyHeld: liveHeld,
    arbitrate: async () => ({ decision: 'escalate_owner' }),
  });
  assert.equal(noQuestion.reason, 'arbiter_response_invalid');
});

test('maxHarmOf считает максимум по findings', () => {
  assert.equal(maxHarmOf(undefined), 0);
  assert.equal(maxHarmOf([{ harm: 3 }, { harm: 10 }, { harm: 1 }]), 10);
});
