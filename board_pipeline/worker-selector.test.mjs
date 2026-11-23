import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertTriadIndependent,
  attemptSpawnWithFallback,
  DEFAULT_ARBITER,
  DEFAULT_CRITIC,
  ESCALATION_FALLBACK_NEON_HIGH,
  ESCALATION_FALLBACK_PI_SOL,
  ESCALATION_REVIEWER_OPUS,
  evaluateReworkProgress,
  FALLBACK_ANTIGRAVITY_NEON,
  hasDodViolation,
  maxHarmOf,
  NARROW_RESERVE_PI,
  normalizeRoutingPolicy,
  opencodeGoPolicyViolation,
  PRIMARY_WORKER,
  resolveArbitration,
  roundSignature,
  selectEscalationReviewer,
  selectWorker,
  workerFamily,
} from './worker-selector.mjs';
import { ReviewDenied } from './review-runner.mjs';

const BASE = 'a'.repeat(40);
const ATTEMPT = { task_id: '7', epoch: 3, attempt_id: 'att-1', base_sha: BASE };
const DIGEST = 'd'.repeat(64);

// Чистая инспекция worktree: clean и HEAD на base_sha — обязательное
// доказательство для любого перехода на резерв.
const cleanTree = async () => ({ clean: true, head: BASE });
const QUOTA_OK = { status: 'available', activeBackgroundAgentCount: 0 };

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

test('selectWorker: acp-devin первым, затем pi/deepseek и antigravity/gemini', () => {
  // Routing Policy v2: резервы ZCode в плане нет; два согласованных резерва
  // независимых семейств идут сразу за первичным.
  assert.deepEqual(selectWorker({ route: {} }),
    [PRIMARY_WORKER, NARROW_RESERVE_PI, FALLBACK_ANTIGRAVITY_NEON]);
  assert.deepEqual(selectWorker(),
    [PRIMARY_WORKER, NARROW_RESERVE_PI, FALLBACK_ANTIGRAVITY_NEON]);
  // Никакого acp-zcode-start в плане.
  assert.ok(selectWorker().every(w => w.provider !== 'acp-zcode-start'));
});

test('workerFamily различает cognition, deepseek, openai, google, anthropic', () => {
  assert.equal(workerFamily(PRIMARY_WORKER), 'cognition');
  assert.equal(workerFamily(FALLBACK_ANTIGRAVITY_NEON), 'google');
  assert.equal(workerFamily(NARROW_RESERVE_PI), 'deepseek');
  assert.equal(workerFamily(DEFAULT_CRITIC), 'google');
  assert.equal(workerFamily(DEFAULT_ARBITER), 'openai');
  assert.equal(workerFamily({ provider: 'unknown', model: 'unknown' }), null);
});

test('доступный первичный исполнитель запускается без резерва и fallbackReason', async () => {
  const { calls, spawn } = spawnLog([{ threadId: 'thr_devin1' }]);
  const selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn,
    probe: async () => QUOTA_OK, inspectWorktree: cleanTree,
  });
  assert.equal(selection.outcome, 'spawned');
  assert.equal(selection.worker.provider, 'acp-devin');
  assert.equal(selection.fallbackReason, null);
  assert.equal(calls.length, 1);
});

test('подтверждённый отказ первичного → резерв pi/deepseek с fallbackReason', async () => {
  const { calls, spawn } = spawnLog([{ threadId: 'thr_ds1' }]);
  const selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn, inspectWorktree: cleanTree,
    probe: async worker => worker.provider === 'acp-devin'
      ? { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 }
      : QUOTA_OK,
  });
  assert.equal(selection.outcome, 'spawned');
  assert.equal(selection.worker.provider, 'pi');
  assert.equal(selection.worker.model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(selection.fallbackReason, 'confirmed_refusal:acp-devin');
  assert.deepEqual(calls.map(c => c.provider), ['pi']);
  // google-критик ломает antigravity/gemini — он записан пропущенным до попыток.
  assert.equal(selection.attemptedWorkers.length, 3);
  assert.equal(selection.attemptedWorkers[0].verdict, 'skipped');
});

// Резерв, нарушающий триаду, пропускается: критик google ломает
// antigravity/gemini, критик deepseek — pi; маршрут идёт дальше.
test('резерв-нарушитель триады пропускается, следующий кандидат запускается', async () => {
  const { calls, spawn } = spawnLog([{ threadId: 'thr_neon1' }]);
  const selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn, inspectWorktree: cleanTree,
    critic: { provider: 'opencode-go', model: 'deepseek-v4' },
    probe: async worker => worker.provider === 'acp-devin'
      ? { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 }
      : QUOTA_OK,
  });
  assert.equal(selection.outcome, 'spawned');
  assert.equal(selection.worker.provider, 'acp-antigravity-acp');
  assert.equal(selection.worker.model, 'gemini-4-neon');
  assert.equal(selection.fallbackReason, 'confirmed_refusal:acp-devin');
  assert.deepEqual(calls.map(c => c.provider), ['acp-antigravity-acp']);
  const skipped = selection.attemptedWorkers.find(w => w.provider === 'pi');
  assert.equal(skipped.verdict, 'skipped');
  assert.match(skipped.reason, /^triad_violation:/);
});

test('подтверждённый отказ spawn первого хода при чистом worktree допускает резерв', async () => {
  const { spawn } = spawnLog([
    { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 },
    { threadId: 'thr_ds2' },
  ]);
  const selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn, inspectWorktree: cleanTree,
    probe: async () => QUOTA_OK,
  });
  assert.equal(selection.outcome, 'spawned');
  assert.equal(selection.worker.provider, 'pi');
});

// Пункт 3: после probe-refusal при живом агенте, грязном дереве или сдвинутом
// HEAD переход на резерв запрещён — uncertain без второго писателя.
test('probe refusal без доказанной чистоты — uncertain, резерв не запускается', async () => {
  const cases = [
    { probe: async () => ({ status: 'confirmed_refusal', activeBackgroundAgentCount: 1 }),
      inspect: cleanTree },
    { probe: async () => ({ status: 'confirmed_refusal', activeBackgroundAgentCount: 0 }),
      inspect: async () => ({ clean: false, head: BASE }) },
    { probe: async () => ({ status: 'confirmed_refusal', activeBackgroundAgentCount: 0 }),
      inspect: async () => ({ clean: true, head: 'b'.repeat(40) }) },
    { probe: async () => ({ status: 'confirmed_refusal' }), inspect: cleanTree },
    { probe: async () => ({ status: 'confirmed_refusal', activeBackgroundAgentCount: 0 }),
      inspect: async () => { throw new Error('inspect failed'); } },
    { probe: async () => ({ status: 'confirmed_refusal', activeBackgroundAgentCount: 0 }),
      inspect: undefined },
  ];
  for (const { probe, inspect } of cases) {
    const { calls, spawn } = spawnLog([{ threadId: 'thr_never' }]);
    const selection = await attemptSpawnWithFallback({
      attempt: ATTEMPT, spawn, probe, inspectWorktree: inspect,
    });
    assert.equal(selection.outcome, 'uncertain');
    assert.equal(selection.reason, 'worker_launch_outcome_unknown');
    assert.equal(calls.length, 0);
  }
});

// Пункт 3: spawn-refusal при чистом дереве, но сдвинутом HEAD — uncertain.
test('spawn refusal при сдвинутом HEAD или фоновом агенте — uncertain', async () => {
  const cases = [
    { refusal: { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 },
      inspect: async () => ({ clean: true, head: 'f'.repeat(40) }) },
    { refusal: { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 },
      inspect: async () => ({ clean: false, head: BASE }) },
    { refusal: { status: 'confirmed_refusal', activeBackgroundAgentCount: 1 },
      inspect: cleanTree },
    { refusal: { status: 'confirmed_refusal' }, inspect: cleanTree },
    { refusal: { unexpected: 'shape' }, inspect: cleanTree },
  ];
  for (const { refusal, inspect } of cases) {
    const { calls, spawn } = spawnLog([refusal, { threadId: 'thr_never' }]);
    const selection = await attemptSpawnWithFallback({
      attempt: ATTEMPT, spawn, inspectWorktree: inspect,
      probe: async () => QUOTA_OK,
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
    const selection = await attemptSpawnWithFallback({
      attempt: ATTEMPT, spawn, probe, inspectWorktree: cleanTree,
    });
    assert.equal(selection.outcome, 'uncertain');
    assert.equal(selection.reason, 'worker_launch_outcome_unknown');
    assert.equal(calls.length, 0);
  }
  const { calls, spawn } = spawnLog([new Error('spawn ack lost'), { threadId: 'thr_never' }]);
  const selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn, probe: async () => QUOTA_OK, inspectWorktree: cleanTree,
  });
  assert.equal(selection.outcome, 'uncertain');
  assert.equal(calls.length, 1);
});

// Подтверждённые отказы всей цепочки — unavailable; pi/deepseek и
// antigravity/gemini участвуют в резерве без дополнительных допусков.
test('подтверждённый отказ всех кандидатов цепочки — unavailable', async () => {
  const refused = { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 };
  const x = spawnLog([{ threadId: 'thr_never' }]);
  const selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn: x.spawn, route: {},
    probe: async () => refused, inspectWorktree: cleanTree,
  });
  assert.equal(selection.outcome, 'unavailable');
  assert.equal(x.calls.length, 0);
  // И при отказе только первичного резерв pi подхватывает без допусков.
  const y = spawnLog([{ threadId: 'thr_pi1' }]);
  const sel2 = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn: y.spawn, route: {},
    probe: async w => w.provider === 'pi' ? QUOTA_OK : refused,
    inspectWorktree: cleanTree,
  });
  assert.equal(sel2.outcome, 'spawned');
  assert.equal(sel2.worker.provider, 'pi');
  assert.equal(y.calls.length, 1);
});

// Пункт 4: нарушение триады первичным — отказ маршрута до spawn; нарушение
// резервом — пропуск резерва, маршрут продолжается.
test('нарушение триады первичным отклоняет маршрут до spawn', async () => {
  const { calls, spawn } = spawnLog([{ threadId: 'thr_never' }]);
  const selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn,
    // Критик семейства cognition конфликтует с первичным acp-devin.
    critic: { provider: 'acp-devin', model: 'swe-2-medium' },
    probe: async () => QUOTA_OK, inspectWorktree: cleanTree,
  });
  assert.equal(selection.outcome, 'rejected');
  assert.equal(selection.reason, 'route_triad_violation:review_same_family');
  assert.equal(calls.length, 0);
});

// Политика opencode-go в цепочке: не-DeepSeek резерв отклоняется с явной
// причиной, а не молча запускается.
test('не-DeepSeek резерв opencode-go в плане — пропуск с opencode_go_non_deepseek_disallowed', async () => {
  const refused = { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 };
  const { calls, spawn } = spawnLog([{ threadId: 'thr_neon2' }]);
  const selection = await attemptSpawnWithFallback({
    attempt: ATTEMPT, spawn,
    // Критик deepseek: antigravity/google триаду сохраняет, pi/qwen ловит
    // запрет opencode-go до любого spawn.
    critic: { provider: 'opencode-go', model: 'deepseek-v4' },
    plan: [PRIMARY_WORKER,
      { provider: 'pi', model: 'opencode-go/qwen3-coder' },
      FALLBACK_ANTIGRAVITY_NEON],
    probe: async w => w.provider === 'acp-devin' ? refused : QUOTA_OK,
    inspectWorktree: cleanTree,
  });
  assert.equal(selection.outcome, 'spawned');
  assert.equal(selection.worker.provider, 'acp-antigravity-acp');
  const skipped = selection.attemptedWorkers.find(w => w.provider === 'pi');
  assert.equal(skipped.verdict, 'skipped');
  assert.equal(skipped.reason, 'opencode_go_non_deepseek_disallowed');
  assert.equal(calls.length, 1);
});

test('assertTriadIndependent требует три разных семейства', () => {
  assert.deepEqual(assertTriadIndependent({ executor: PRIMARY_WORKER }),
    { executor: 'cognition', critic: 'google', arbiter: 'openai' });
  assert.deepEqual(assertTriadIndependent({ executor: FALLBACK_ANTIGRAVITY_NEON,
    critic: { provider: 'opencode-go', model: 'deepseek-v4' } }),
    { executor: 'google', critic: 'deepseek', arbiter: 'openai' });
  assert.deepEqual(assertTriadIndependent({ executor: NARROW_RESERVE_PI }),
    { executor: 'deepseek', critic: 'google', arbiter: 'openai' });
  assert.throws(() => assertTriadIndependent({ executor: 'pi/openai/gpt-6.2-sol' }),
    e => e.reason === 'arbiter_family_not_independent');
  assert.throws(() => assertTriadIndependent({ executor: 'google/gemini-4-neon' }),
    e => e.reason === 'review_same_family');
  assert.throws(() => assertTriadIndependent({
    executor: PRIMARY_WORKER,
    critic: { provider: 'acp-devin', model: 'swe-2-medium' },
  }), e => e instanceof ReviewDenied && e.reason === 'review_same_family');
  assert.throws(() => assertTriadIndependent({
    executor: PRIMARY_WORKER, arbiter: DEFAULT_CRITIC,
  }), e => e.reason === 'arbiter_family_not_independent');
  assert.throws(() => assertTriadIndependent({
    executor: PRIMARY_WORKER, arbiter: { provider: 'mystery', model: 'x' },
  }), e => e.reason === 'arbiter_unknown_family');
});

const l2Round = (over = {}) => ({
  sha: 'c'.repeat(40), tree_sha: null, gate: 'l2',
  signature: 'review_verdict:REVIEW_BLOCKED|src/a.js||expect X|got Y', blocking: 1,
  findings: [{ file: 'src/a.js', expected: 'expect X', actual: 'got Y' }],
  excerpt: null, checkpoint: null, dispute: null, contradictory: false, ...over,
});
const detRound = (gate, sig, over = {}) => ({
  sha: 'b'.repeat(40), tree_sha: null, gate, signature: `${gate}|${sig}`,
  blocking: null, findings: [], excerpt: null, checkpoint: null,
  dispute: null, contradictory: false, ...over,
});

test('сходящаяся починка любой длины не даёт триггеров — нет правила «два круга»', () => {
  const history = [
    detRound('l1', 'sig-1'),
    detRound('l1', 'sig-2'),
    l2Round({ signature: 's1', findings: [{ file: 'a', expected: 'e1', actual: 'x1' }], blocking: 3 }),
    l2Round({ signature: 's2', findings: [{ file: 'b', expected: 'e2', actual: 'x2' }], blocking: 2 }),
    l2Round({ signature: 's3', findings: [{ file: 'c', expected: 'e3', actual: 'x3' }], blocking: 1 }),
  ];
  assert.equal(evaluateReworkProgress({ roundsHistory: history }).trigger, null);
});

test('no_progress: повторный tree_sha', () => {
  const history = [
    l2Round({ tree_sha: 'f'.repeat(40), signature: 's1' }),
    l2Round({ tree_sha: 'f'.repeat(40), signature: 's2', findings: [{ file: 'z' }] }),
  ];
  const p = evaluateReworkProgress({ roundsHistory: history });
  assert.equal(p.trigger, 'no_progress');
  assert.equal(p.kind, 'duplicate_tree_sha');
});

test('no_progress: два раза подряд красный детерминированный гейт с той же сигнатурой', () => {
  for (const gate of ['l1', 'tamper', 'l3']) {
    const history = [detRound(gate, 'same-sig'), detRound(gate, 'same-sig')];
    const p = evaluateReworkProgress({ roundsHistory: history });
    assert.equal(p.trigger, 'no_progress', gate);
    assert.equal(p.kind, 'repeated_deterministic_failure');
    assert.equal(p.deterministicGate, true);
  }
});

// Пункт 6: разные упавшие проверки L1 дают разные сигнатуры — починка сходится.
test('пункт 6: тест A → тест B в L1 — разные сигнатуры, не repeated', () => {
  const failA = {
    outcome: 'rework', reason: 'local_checks_failed',
    feedback: { reason: 'local_checks_failed', evidence: [
      { file: 'checks-a.log', exit: 1, sha256: 'a'.repeat(64) },
      { file: 'checks-b.log', exit: 0, sha256: 'b'.repeat(64) },
    ] },
  };
  const failB = {
    outcome: 'rework', reason: 'local_checks_failed',
    feedback: { reason: 'local_checks_failed', evidence: [
      { file: 'checks-a.log', exit: 0, sha256: 'c'.repeat(64) },
      { file: 'checks-b.log', exit: 1, sha256: 'd'.repeat(64) },
    ] },
  };
  assert.notEqual(roundSignature(failA), roundSignature(failB));
  const p = evaluateReworkProgress({ roundsHistory: [
    detRound('l1', roundSignature(failA)), detRound('l1', roundSignature(failB)),
  ] });
  assert.equal(p.trigger, null);
  // А тот же упавший тест два раза подряд — отсутствие прогресса.
  const same = evaluateReworkProgress({ roundsHistory: [
    detRound('l1', roundSignature(failA)), detRound('l1', roundSignature(failA)),
  ] });
  assert.equal(same.kind, 'repeated_deterministic_failure');
});

// Пункт 6: repeated_l2_finding — только при повторе ТОГО ЖЕ finding или excerpt.
test('пункт 6: finding A → finding B в L2 — прогресс, повтор того же finding — стоп', () => {
  const findingA = { file: 'a.js', line: 3, expected: 'e1', actual: 'x1' };
  const findingB = { file: 'b.js', line: 9, expected: 'e2', actual: 'x2' };
  const different = evaluateReworkProgress({ roundsHistory: [
    l2Round({ findings: [findingA], signature: 's-a', blocking: 1 }),
    l2Round({ findings: [findingB], signature: 's-b', blocking: 1 }),
  ] });
  assert.equal(different.trigger, null, 'разные замечания — починка идёт');
  const repeated = evaluateReworkProgress({ roundsHistory: [
    l2Round({ findings: [findingA, findingB], signature: 's-1', blocking: 2 }),
    l2Round({ findings: [{ file: 'c.js', expected: 'e3', actual: 'x3' }, findingA],
      signature: 's-2', blocking: 2 }),
  ] });
  assert.equal(repeated.kind, 'repeated_l2_finding', 'finding A повторился');
  const sameExcerpt = evaluateReworkProgress({ roundsHistory: [
    l2Round({ findings: [], excerpt: 'missing guard', signature: 's-e', blocking: 1 }),
    l2Round({ findings: [], excerpt: 'missing guard', signature: 's-e2', blocking: 1 }),
  ] });
  assert.equal(sameExcerpt.kind, 'repeated_l2_finding');
});

// Пункт 7: спор признаётся только по finding_ref реального прошлого замечания.
test('пункт 7: dispute по несуществующей ссылке — не триггер', () => {
  const prev = l2Round({ findings: [{ file: 'a.js', expected: 'e', actual: 'x' }] });
  for (const ref of ['a.js', 'a.js:3']) {
    const withLine = ref === 'a.js:3'
      ? { ...prev, findings: [{ file: 'a.js', line: 3, expected: 'e', actual: 'x' }] }
      : prev;
    const p = evaluateReworkProgress({ roundsHistory: [
      withLine,
      l2Round({ findings: [{ file: 'b.js' }], signature: 's2',
        dispute: { finding_ref: ref, justification: 'j', spec_evidence: 's' } }),
    ] });
    assert.equal(p.trigger, 'substantive_dispute', ref);
    assert.equal(p.kind, 'worker_dispute');
  }
  // Ссылка на несуществующую находку — спор не признаётся.
  const fake = evaluateReworkProgress({ roundsHistory: [
    prev,
    l2Round({ findings: [{ file: 'b.js' }], signature: 's2',
      dispute: { finding_ref: 'ghost.js', justification: 'j', spec_evidence: 's' } }),
  ] });
  assert.equal(fake.trigger, null);
  // Спор на первом же раунде без прошлого L2 — не триггер.
  const noPrev = evaluateReworkProgress({ roundsHistory: [
    l2Round({ dispute: { finding_ref: 'a.js', justification: 'j', spec_evidence: 's' } }),
  ] });
  assert.equal(noPrev.trigger, null);
  // Checkpoint прошлого L2 — НЕ допустимая ссылка (п.12: только реальные
  // findings; к тому же у прошлого раунда findings пусты).
  const viaCheckpoint = evaluateReworkProgress({ roundsHistory: [
    l2Round({ checkpoint: 'abc123' }),
    l2Round({ findings: [{ file: 'b.js' }], signature: 's2',
      dispute: { finding_ref: 'abc123', justification: 'j', spec_evidence: 's' } }),
  ] });
  assert.equal(viaCheckpoint.trigger, null);
  // И при непустых findings ссылка на checkpoint всё равно не считается:
  // finding_ref обязан совпасть с элементом findings (id, file, file:line).
  const checkpointWithFindings = evaluateReworkProgress({ roundsHistory: [
    l2Round({ checkpoint: 'abc123', findings: [{ file: 'a.js', expected: 'e', actual: 'x' }] }),
    l2Round({ findings: [{ file: 'b.js' }], signature: 's2',
      dispute: { finding_ref: 'abc123', justification: 'j', spec_evidence: 's' } }),
  ] });
  assert.equal(checkpointWithFindings.trigger, null);
  // Пустой массив findings у прошлого раунда — спор не признаётся вообще.
  const emptyPrev = evaluateReworkProgress({ roundsHistory: [
    l2Round({ findings: [] }),
    l2Round({ findings: [{ file: 'b.js' }], signature: 's2',
      dispute: { finding_ref: 'a.js', justification: 'j', spec_evidence: 's' } }),
  ] });
  assert.equal(emptyPrev.trigger, null);
});

// Пункт 7: взаимоисключающие требования L2 по одному месту — substantive_dispute.
test('пункт 7: противоречивые L2-раунды по одному file+line', () => {
  const p = evaluateReworkProgress({ roundsHistory: [
    l2Round({ signature: 's1',
      findings: [{ file: 'x.js', line: 5, expected: 'A', actual: 'B' }] }),
    l2Round({ signature: 's2',
      findings: [{ file: 'x.js', line: 5, expected: 'B', actual: 'A' }] }),
  ] });
  assert.equal(p.trigger, 'substantive_dispute');
  assert.equal(p.kind, 'contradictory_l2_findings');
  // Разные строки — не противоречие.
  const ok = evaluateReworkProgress({ roundsHistory: [
    l2Round({ signature: 's1', findings: [{ file: 'x.js', line: 5, expected: 'A', actual: 'B' }] }),
    l2Round({ signature: 's2', findings: [{ file: 'x.js', line: 9, expected: 'B', actual: 'A' }] }),
  ] });
  assert.equal(ok.trigger, null);
});

const arbAttempt = { ...ATTEMPT, executor: PRIMARY_WORKER };
const liveHeld = async (id, epoch) => ({ epoch });
const disputeTrigger = { trigger: 'substantive_dispute', kind: 'worker_dispute', evidence: { findings: [] } };

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
  const arbitrate = async () => { called++; return {
    decision: 'accept_with_notes', notes: 'n', subject_digest: DIGEST }; };
  assert.equal((await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, maxHarm: 10, arbitrate,
  })).reason, 'harm10_requires_owner');
  assert.equal((await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, arbiter: null, arbitrate,
  })).reason, 'arbiter_unavailable');
  assert.equal((await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, arbitrationUsed: 1, arbitrate,
  })).reason, 'arbitration_exhausted');
  assert.equal((await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, arbiter: DEFAULT_CRITIC, arbitrate,
  })).reason, 'arbiter_unavailable');
  assert.equal(called, 0);
});

test('resolveArbitration: directed_rework обязан нести валидный subject_digest', async () => {
  const seen = [];
  const r = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: DIGEST,
    verifyHeld: liveHeld,
    arbitrate: async req => { seen.push(req); return {
      decision: 'directed_rework', directive: 'fix only the disputed finding',
      subject_digest: DIGEST }; },
  });
  assert.equal(r.decision, 'directed_rework');
  assert.equal(r.arbitrationUsed, 1);
  assert.equal(seen[0].subject_digest, DIGEST);
  // Отсутствующий, невалидный или чужой digest — mismatch.
  for (const ruling of [
    { decision: 'directed_rework', directive: 'x' },
    { decision: 'directed_rework', directive: 'x', subject_digest: 'not-hex' },
    { decision: 'directed_rework', directive: 'x', subject_digest: 'f'.repeat(64) },
  ]) {
    const bad = await resolveArbitration({
      attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: DIGEST,
      verifyHeld: liveHeld, arbitrate: async () => ruling,
    });
    assert.equal(bad.decision, 'hold', JSON.stringify(ruling));
    assert.equal(bad.reason, 'arbiter_subject_mismatch');
  }
});

// Пункт 2: accept_with_notes без subject_digest и с чужим — hold.
test('пункт 2: accept_with_notes требует совпадающий subject_digest', async () => {
  for (const ruling of [
    { decision: 'accept_with_notes', notes: 'n' },
    { decision: 'accept_with_notes', notes: 'n', subject_digest: 'f'.repeat(64) },
    { decision: 'accept_with_notes', notes: 'n', subject_digest: 'junk' },
  ]) {
    const bad = await resolveArbitration({
      attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: DIGEST,
      verifyHeld: liveHeld, arbitrate: async () => ruling,
    });
    assert.equal(bad.decision, 'hold');
    assert.equal(bad.reason, 'arbiter_subject_mismatch');
  }
  // Даже валидный digest решения бессилен без digest манифеста.
  const noManifest = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: null,
    verifyHeld: liveHeld,
    arbitrate: async () => ({ decision: 'accept_with_notes', notes: 'n', subject_digest: DIGEST }),
  });
  assert.equal(noManifest.reason, 'arbiter_subject_mismatch');
});

test('resolveArbitration: accept_with_notes фиксирует ArbitrationReceipt', async () => {
  const r = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: DIGEST,
    verifyHeld: liveHeld, maxHarm: 3,
    arbitrate: async () => ({ decision: 'accept_with_notes', notes: 'minor style only',
      subject_digest: DIGEST }),
  });
  assert.equal(r.decision, 'accept_with_notes');
  assert.equal(r.receipt.kind, 'arbitration');
  assert.equal(r.receipt.subject_digest, DIGEST);
  const noNotes = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: DIGEST,
    verifyHeld: liveHeld,
    arbitrate: async () => ({ decision: 'accept_with_notes', notes: ' ', subject_digest: DIGEST }),
  });
  assert.equal(noNotes.reason, 'arbiter_response_invalid');
});

// Пункт 8: accept_with_notes запрещён при DoD-нарушении и harm>=10.
test('пункт 8: accept_with_notes при DoD-нарушении — dod_or_harm10_violation', async () => {
  const accept = async () => ({ decision: 'accept_with_notes', notes: 'n', subject_digest: DIGEST });
  // Арбитр сам признал нарушение DoD.
  const rulBreach = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: DIGEST,
    verifyHeld: liveHeld,
    arbitrate: async () => ({ decision: 'accept_with_notes', notes: 'n',
      subject_digest: DIGEST, dod_satisfied: false }),
  });
  assert.equal(rulBreach.decision, 'hold');
  assert.equal(rulBreach.reason, 'dod_or_harm10_violation');
  // DoD-флаг в замечаниях контекста.
  const ctxBreach = await resolveArbitration({
    attempt: arbAttempt, subjectDigest: DIGEST, verifyHeld: liveHeld, arbitrate: accept,
    trigger: { ...disputeTrigger, evidence: { findings: [{ file: 'a', dod_violation: true }] } },
  });
  assert.equal(ctxBreach.decision, 'hold');
  assert.equal(ctxBreach.reason, 'dod_or_harm10_violation');
  const flagBreach = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: DIGEST,
    dodViolation: true, verifyHeld: liveHeld, arbitrate: accept,
  });
  assert.equal(flagBreach.reason, 'dod_or_harm10_violation');
});

// Пункт 8: fail-closed maxHarmOf — 10.5, 'high', NaN, Infinity и DoD-флаги.
test('пункт 8: maxHarmOf fail-closed на невалидном harm и DoD-флагах', () => {
  assert.equal(maxHarmOf(undefined), 0);
  assert.equal(maxHarmOf([{ harm: 3 }, { harm: 9.9 }]), 9.9);
  for (const h of [10, 10.5, Number.NaN, Infinity, 'high', '5', {}, []]) {
    assert.equal(maxHarmOf([{ harm: h }]), 10, JSON.stringify(h));
  }
  assert.equal(maxHarmOf([{ harm: 2, dod_violation: true }]), 10);
  assert.equal(maxHarmOf([{ harm: 2, violates_dod: true }]), 10);
  assert.equal(hasDodViolation([{ dod_violation: true }]), true);
  assert.equal(hasDodViolation([{ harm: 5 }]), false);
});

test('resolveArbitration: escalate_owner с вопросом и потеря аренды до вызова', async () => {
  const r = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: DIGEST, verifyHeld: liveHeld,
    arbitrate: async () => ({ decision: 'escalate_owner', question: 'Какое поведение верно по §3?',
      subject_digest: DIGEST }),
  });
  assert.equal(r.decision, 'escalate_owner');
  const noLease = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: DIGEST,
    verifyHeld: async () => ({ epoch: 99 }),
    arbitrate: async () => ({ decision: 'escalate_owner', question: 'q', subject_digest: DIGEST }),
  });
  assert.equal(noLease.decision, 'lease_lost');
});

// Пункт 5: subject_digest обязателен для ВСЕХ решений арбитра, включая
// escalate_owner. Отсутствие манифеста, невалидный или чужой digest — hold.
test('пункт 5: escalate_owner тоже привязан к subject_digest', async () => {
  for (const [subjectDigest, ruling] of [
    [DIGEST, { decision: 'escalate_owner', question: 'q' }],
    [DIGEST, { decision: 'escalate_owner', question: 'q', subject_digest: 'f'.repeat(64) }],
    [DIGEST, { decision: 'escalate_owner', question: 'q', subject_digest: 'junk' }],
    [null, { decision: 'escalate_owner', question: 'q', subject_digest: DIGEST }],
    ['not-hex', { decision: 'escalate_owner', question: 'q', subject_digest: 'not-hex' }],
  ]) {
    const r = await resolveArbitration({
      attempt: arbAttempt, trigger: disputeTrigger, subjectDigest,
      verifyHeld: liveHeld, arbitrate: async () => ruling,
    });
    assert.equal(r.decision, 'hold', JSON.stringify([subjectDigest, ruling]));
    assert.equal(r.reason, 'arbiter_subject_mismatch');
  }
});

// Пункт 9: pi-харнесс с моделью 'opencode-go/deepseek-v4.1-flash' — одна
// таблица семейств и в селекторе, и в acceptHeld.
test('пункт 9: pi/opencode-go/deepseek-v4.1-flash распознаётся как deepseek', () => {
  assert.equal(workerFamily({ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' }), 'deepseek');
  assert.equal(workerFamily(NARROW_RESERVE_PI), 'deepseek');
  // Триада pi-executor / openai-критик / google-арбитр — полностью независима.
  const triad = assertTriadIndependent({
    executor: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
    critic: DEFAULT_CRITIC, arbiter: DEFAULT_ARBITER });
  assert.equal(triad.executor, 'deepseek');
  // Критик того же семейства deepseek отклоняется и для pi-исполнителя.
  assert.throws(() => assertTriadIndependent({
    executor: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
    critic: { provider: 'opencode-go', model: 'deepseek-v4' },
    arbiter: DEFAULT_ARBITER }), /same_family/);
});

// Пункт 10: имя файла лога (candidate_sha + UUID) не входит в сигнатуру L1 —
// два побайтово одинаковых падения дают одну сигнатуру.
test('пункт 10: сигнатура L1 игнорирует случайное имя файла лога', () => {
  const mk = file => ({
    outcome: 'rework', reason: 'local_checks_failed',
    feedback: { reason: 'local_checks_failed', evidence: [
      { file, exit: 1, sha256: 'f'.repeat(64) }] },
  });
  const sigA = roundSignature(mk('checks-7-aaa-uuid1.log'));
  const sigB = roundSignature(mk('checks-7-bbb-uuid2.log'));
  assert.equal(sigA, sigB, 'одинаковый лог — одна сигнатура');
  const p = evaluateReworkProgress({ roundsHistory: [
    { gate: 'l1', signature: sigA, blocking: null, findings: [], excerpt: null,
      checkpoint: null, dispute: null, contradictory: false },
    { gate: 'l1', signature: sigB, blocking: null, findings: [], excerpt: null,
      checkpoint: null, dispute: null, contradictory: false },
  ] });
  assert.equal(p.kind, 'repeated_deterministic_failure');
  // А разный sha256 при одинаковом имени файла — разные сигнатуры.
  const other = { outcome: 'rework', reason: 'local_checks_failed',
    feedback: { reason: 'local_checks_failed', evidence: [
      { file: 'checks-7-aaa-uuid1.log', exit: 1, sha256: 'e'.repeat(64) }] } };
  assert.notEqual(roundSignature(other), sigA);
});

// Пункт 11: ключ finding через JSON.stringify — склейка разделителем не
// склеивает разные находки в одну.
test('пункт 11: findingKey не допускает коллизий через разделитель', () => {
  const f1 = { file: 'a', line: 1, expected: 'A|B', actual: 'C' };
  const f2 = { file: 'a', line: 1, expected: 'A', actual: 'B|C' };
  const p = evaluateReworkProgress({ roundsHistory: [
    l2Round({ findings: [f1], signature: 's1', blocking: 1 }),
    l2Round({ findings: [f2], signature: 's2', blocking: 1 }),
  ] });
  assert.equal(p.trigger, null, 'разные findings не склеиваются в одну строку');
});

// Пункт 12: взаимоисключающие требования фиксируются только при обоих
// направлениях (&&): одностороннее совпадение — не противоречие.
test('пункт 12: одностороннее совпадение expected/actual — не противоречие', () => {
  // Только pe === ca: новая находка лишь подтверждает старую — уточнение.
  const oneWay = evaluateReworkProgress({ roundsHistory: [
    l2Round({ signature: 's1', findings: [{ file: 'x.js', line: 5, expected: 'A', actual: 'B' }] }),
    l2Round({ signature: 's2', findings: [{ file: 'x.js', line: 5, expected: 'X', actual: 'A' }] }),
  ] });
  assert.equal(oneWay.trigger, null);
  // prev.expected === prev.actual (вырожденная пара) — тоже не противоречие.
  const degenerate = evaluateReworkProgress({ roundsHistory: [
    l2Round({ signature: 's1', findings: [{ file: 'x.js', line: 5, expected: 'A', actual: 'A' }] }),
    l2Round({ signature: 's2', findings: [{ file: 'x.js', line: 5, expected: 'A', actual: 'A' }] }),
  ] });
  assert.notEqual(degenerate.kind, 'contradictory_l2_findings');
});

// Пункт 13: заданный (в т.ч. null/undefined/отрицательный) harm не в
// диапазоне 0<=harm<10 — fail-closed 10.
test('пункт 13: maxHarmOf — собственный ключ harm вне диапазона даёт 10', () => {
  for (const f of [{ harm: null }, { harm: undefined }, { harm: -1 }, { harm: '3' }]) {
    assert.equal(maxHarmOf([f]), 10, JSON.stringify(f));
  }
  // Отсутствие ключа harm — не нарушение.
  assert.equal(maxHarmOf([{ file: 'a' }]), 0);
});

// Пункт 13: receipt арбитражного принятия несёт max_harm для валидации в seal.
test('пункт 13: accept_with_notes receipt содержит max_harm', async () => {
  const r = await resolveArbitration({
    attempt: arbAttempt, trigger: disputeTrigger, subjectDigest: DIGEST,
    verifyHeld: liveHeld, maxHarm: 4,
    arbitrate: async () => ({ decision: 'accept_with_notes', notes: 'n', subject_digest: DIGEST }),
  });
  assert.equal(r.receipt.max_harm, 4);
  assert.equal(r.receipt.dod_violation, false);
});

// Пункт 5 (ревью #3): digest проверяется строго как строка — массив/объект
// не проходит через приведение типа в RegExp.test.
test('пункт 5: subjectDigest нестрокового типа — arbiter_subject_mismatch', async () => {
  for (const [subjectDigest, ruling] of [
    [[DIGEST], { decision: 'directed_rework', directive: 'x', subject_digest: DIGEST }],
    [DIGEST, { decision: 'directed_rework', directive: 'x', subject_digest: [DIGEST] }],
    [undefined, { decision: 'escalate_owner', question: 'q', subject_digest: 'undefined' }],
    [DIGEST, { decision: 'accept_with_notes', notes: 'n', subject_digest: [DIGEST] }],
  ]) {
    const r = await resolveArbitration({
      attempt: arbAttempt, trigger: disputeTrigger, subjectDigest,
      verifyHeld: liveHeld, arbitrate: async () => ruling,
    });
    assert.equal(r.decision, 'hold', JSON.stringify([typeof subjectDigest, ruling.decision]));
    assert.equal(r.reason, 'arbiter_subject_mismatch');
  }
});

// ── Routing Policy v2: opencode-go — строго DeepSeek ───────────────────────
test('opencodeGoPolicyViolation: deepseek допущены, прочие opencode-go — отказ', () => {
  for (const spec of [
    { provider: 'opencode-go', model: 'deepseek-v4' },
    { provider: 'opencode-go', model: 'deepseek-reasoner' },
    { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
  ]) assert.equal(opencodeGoPolicyViolation(spec), null, JSON.stringify(spec));
  for (const spec of [
    { provider: 'opencode-go', model: 'qwen3-coder' },
    { provider: 'opencode-go', model: 'kimi-k2' },
    { provider: 'opencode-go', model: 'deepseek' }, // голое имя без версии
    { provider: 'pi', model: 'opencode-go/qwen3-coder' },
  ]) assert.equal(opencodeGoPolicyViolation(spec), 'opencode_go_non_deepseek_disallowed',
    JSON.stringify(spec));
  // Не opencode-go — политика не применяется.
  for (const spec of [PRIMARY_WORKER, DEFAULT_CRITIC,
      { provider: 'pi', model: 'openai/gpt-6.2-sol' }, null, 'opencode-go/qwen']) {
    assert.equal(opencodeGoPolicyViolation(spec), null);
  }
});

test('normalizeRoutingPolicy: не-DeepSeek opencode-go в allowlist — отказ политики', () => {
  assert.throws(() => normalizeRoutingPolicy({
    routing: { mode: 'active', allowlist: {
      worker: [{ provider: 'opencode-go', model: 'qwen3-coder' }] } },
  }), e => e instanceof ReviewDenied && e.reason === 'opencode_go_non_deepseek_disallowed');
  assert.throws(() => normalizeRoutingPolicy({
    routing: { allowlist: { critic: [{ provider: 'pi', model: 'opencode-go/kimi-k2' }] } },
  }), e => e.reason === 'opencode_go_non_deepseek_disallowed');
  // Допущенная политика с deepseek нормализуется.
  const ok = normalizeRoutingPolicy({ routing: { mode: 'active', allowlist: {
    worker: [{ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' }] } } });
  assert.equal(ok.mode, 'active');
});

// ── Routing Policy v2: точечный Opus 5.5 escalation gate ───────────────────
const OPUS_QUOTA_OK = { status: 'available', remaining: 1, used: 0, cap: 3 };
const TRIAD = { worker: PRIMARY_WORKER, critic: DEFAULT_CRITIC }; // cognition + google

test('selectEscalationReviewer: триггер + квота + триада → слот Opus 5.5', () => {
  for (const trigger of ['security_gate', 'release_gate', 'critical_math_or_arch',
      { kind: 'release_gate' }, { dispute_rounds: 2 }, { dispute_rounds: 5 }]) {
    const sel = selectEscalationReviewer({ trigger, quota: OPUS_QUOTA_OK, triad: TRIAD });
    assert.equal(sel.outcome, 'selected', JSON.stringify(trigger));
    assert.equal(sel.reviewer, ESCALATION_REVIEWER_OPUS);
    assert.equal(sel.family, 'anthropic');
  }
});

test('selectEscalationReviewer: нет триггера — детерминированный fallback на Pi/Sol', () => {
  for (const trigger of [undefined, null, 'visual_gate_failed', { dispute_rounds: 1 },
      { kind: 'no_progress' }]) {
    const sel = selectEscalationReviewer({ trigger, quota: OPUS_QUOTA_OK, triad: TRIAD });
    assert.equal(sel.outcome, 'fallback', JSON.stringify(trigger));
    assert.equal(sel.reason, 'no_escalation_trigger');
    assert.equal(sel.reviewer, ESCALATION_FALLBACK_PI_SOL);
    assert.equal(sel.family, 'openai');
  }
});

test('selectEscalationReviewer: исчерпанная квота — fallback с opus_quota_exhausted', () => {
  for (const quota of [undefined, null, {}, { status: 'unavailable', remaining: 5 },
      { status: 'available', remaining: 0 }, { status: 'available', remaining: -1 },
      { status: 'available', remaining: 1, used: 3, cap: 3 },
      { status: 'available', remaining: 1, used: 4, cap: 3 },
      { status: 'degraded', remaining: 9 }]) {
    const sel = selectEscalationReviewer({ trigger: 'security_gate', quota, triad: TRIAD });
    assert.equal(sel.outcome, 'fallback', JSON.stringify(quota));
    assert.equal(sel.reason, 'opus_quota_exhausted');
    assert.equal(sel.reviewer, ESCALATION_FALLBACK_PI_SOL);
  }
});

test('selectEscalationReviewer: семейство Opus совпало с критиком — opus_triad_violation', () => {
  const sel = selectEscalationReviewer({
    trigger: 'release_gate', quota: OPUS_QUOTA_OK,
    triad: { worker: PRIMARY_WORKER, critic: { provider: 'agy', model: 'claude-opus-5.5' } },
  });
  assert.equal(sel.outcome, 'fallback');
  assert.equal(sel.reason, 'opus_triad_violation');
  // Pi/Sol (openai) независим от cognition-воркера и anthropic-критика.
  assert.equal(sel.reviewer, ESCALATION_FALLBACK_PI_SOL);
});

test('selectEscalationReviewer: fallback тоже ломает триаду — следующий кандидат', () => {
  // Воркер openai + критик deepseek: Pi/Sol (openai) ломает инвариант,
  // Gemini 4 Neon high (google) — сохраняет.
  const triad = { worker: { provider: 'openai', model: 'gpt-6.2-sol' },
    critic: { provider: 'opencode-go', model: 'deepseek-v4' } };
  const sel = selectEscalationReviewer({
    trigger: { dispute_rounds: 2 }, quota: OPUS_QUOTA_OK, triad });
  // anthropic ≠ openai ≠ deepseek — Opus доступен.
  assert.equal(sel.outcome, 'selected');
  // А при исчерпанной квоте fallback пропускает Pi/Sol → Neon high.
  const fb = selectEscalationReviewer({
    trigger: { dispute_rounds: 2 }, quota: { status: 'available', remaining: 0 }, triad });
  assert.equal(fb.outcome, 'fallback');
  assert.equal(fb.reason, 'opus_quota_exhausted');
  assert.equal(fb.reviewer, ESCALATION_FALLBACK_NEON_HIGH);
  assert.equal(fb.family, 'google');
});

test('selectEscalationReviewer: ни один вариант не сохраняет триаду — rejected', () => {
  // Воркер openai + критик google: Pi/Sol = openai, Neon = google — оба ломают.
  const sel = selectEscalationReviewer({
    trigger: 'security_gate', quota: { status: 'available', remaining: 0 },
    triad: { worker: { provider: 'openai', model: 'gpt-6.2-sol' }, critic: DEFAULT_CRITIC },
  });
  // Neon high тут ещё валиден (google ≠ openai-воркер? нет: critic=google=neon).
  assert.equal(sel.outcome, 'rejected');
  assert.equal(sel.reason, 'escalation_reviewer_unavailable');
  assert.equal(sel.fallbackReason, 'opus_quota_exhausted');
  // Неаттестованное семейство триады не доказывает независимость — тоже rejected.
  const unknown = selectEscalationReviewer({
    trigger: 'security_gate', quota: OPUS_QUOTA_OK,
    triad: { worker: { provider: 'mystery', model: 'x' }, critic: DEFAULT_CRITIC },
  });
  assert.equal(unknown.outcome, 'rejected');
});
