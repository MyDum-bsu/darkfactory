// VS-3 интеграция: журнал телеметрии → скоркард → policy-bounded роутинг
// ролей в режимах shadow/active с инвариантом кросс-семейственной триады.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateScorecard, bucketKey, modelKey } from './model-scorecard.mjs';
import {
  attemptSpawnWithFallback,
  DEFAULT_ARBITER,
  DEFAULT_CRITIC,
  normalizeRoutingPolicy,
  opencodeGoPolicyViolation,
  PRIMARY_WORKER,
  routeRole,
  routeTriad,
  selectEscalationReviewer,
  workerFamily,
} from './worker-selector.mjs';
import { ReviewDenied } from './review-runner.mjs';

const DEVIN = PRIMARY_WORKER; // cognition
const DS = { provider: 'opencode-go', model: 'deepseek-v4' };
const NEON = DEFAULT_CRITIC; // google
const SOL = DEFAULT_ARBITER; // openai
const DEEPSEEK = { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' };

const attempt = (worker, { labels, rework = 0, rounds = 1, wall = 60000,
  outcome = 'done' } = {}) =>
  JSON.stringify({
    kind: 'attempt_summary', schema: 1,
    models: { worker, critic: NEON, arbiter: SOL },
    labels: labels ?? { size: 'S', domain: 'backend' },
    rounds: { total: rounds, rework, pass: rounds - rework, arbitration: 0, open: 0 },
    phases_ms: { total: wall },
    outcome, open: false,
  });

// N успешных попыток модели: rework раз в failEvery-й попытке.
const journal = (worker, n, { failEvery = 0, labels } = {}) =>
  Array.from({ length: n }, (_, i) =>
    attempt(worker, { labels, rework: failEvery && i % failEvery === 0 ? 1 : 0,
      rounds: failEvery && i % failEvery === 0 ? 2 : 1 }));

const policy = (mode, allowlist) => ({
  routing: { mode, min_observations: 5, allowlist },
});

test('shadow: рекомендация журналируется, выбор не меняется', () => {
  // DS доказанно сильнее DEVIN в клетке backend/S.
  const lines = [...journal(DS, 6), ...journal(DEVIN, 6, { failEvery: 2 })];
  const scorecard = aggregateScorecard(lines, { seed: [] });
  const notes = [];
  const step = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('shadow', { worker: [DEVIN, DS], critic: [NEON], arbiter: [SOL] }),
    scorecard, base: DEVIN, others: { critic: NEON, arbiter: SOL },
    log: note => notes.push(note),
  });
  assert.equal(step.outcome, 'shadow');
  assert.equal(step.selected, DEVIN); // выбор не изменился
  assert.equal(modelKey(step.recommended), modelKey(DS)); // рекомендация — DS
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'route_recommendation');
  assert.equal(modelKey(notes[0].recommended), modelKey(DS));
});

test('active: доказанный кандидат вытесняет базу строго внутри allowlist', () => {
  const lines = [...journal(DS, 6), ...journal(DEVIN, 6, { failEvery: 2 })];
  const scorecard = aggregateScorecard(lines, { seed: [] });
  const step = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('active', { worker: [DEVIN, DS], critic: [NEON], arbiter: [SOL] }),
    scorecard, base: DEVIN, others: { critic: NEON, arbiter: SOL },
  });
  assert.equal(step.outcome, 'routed');
  assert.equal(modelKey(step.selected), modelKey(DS));
});

test('active: кандидат того же семейства, что критик, пропускается; все — отказ', () => {
  // google-модель сильная по метрикам, но ломает триаду с критиком NEON.
  const googleWorker = { provider: 'google', model: 'gemini-4-neon' };
  const lines = journal(googleWorker, 6);
  const scorecard = aggregateScorecard(lines, { seed: [] });
  const step = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('active', {
      worker: [DEVIN, googleWorker], critic: [NEON], arbiter: [SOL] }),
    scorecard, base: DEVIN, others: { critic: NEON, arbiter: SOL },
  });
  assert.equal(step.outcome, 'rejected');
  assert.equal(step.reason, 'route_triad_violation');
  assert.equal(step.skipped.length, 1);
  assert.equal(step.skipped[0].reason, 'triad_violation');
});

test('allowlist — жёсткая граница: доказанная модель вне списка не выбирается', () => {
  // DEEPSEEK доказан, но allowlist его не содержит.
  const lines = journal(DEEPSEEK, 6);
  const scorecard = aggregateScorecard(lines, { seed: [] });
  const step = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('active', { worker: [DEVIN, DS], critic: [NEON], arbiter: [SOL] }),
    scorecard, base: DEVIN, others: { critic: NEON, arbiter: SOL },
  });
  assert.equal(step.outcome, 'rejected');
  assert.equal(step.reason, 'route_no_proven_candidate');
  // И в shadow вне allowlist рекомендации нет — журналируется null.
  const shadow = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('shadow', { worker: [DEVIN, DS], critic: [NEON], arbiter: [SOL] }),
    scorecard, base: DEVIN,
  });
  assert.equal(shadow.outcome, 'shadow');
  assert.equal(shadow.recommended, null);
  assert.equal(shadow.selected, DEVIN);
});

test('политика: allowlist с неизвестным семейством и база вне списка — отказ', () => {
  assert.throws(() => normalizeRoutingPolicy({
    routing: { mode: 'active', allowlist: { worker: [{ provider: 'x', model: 'y' }] } },
  }), ReviewDenied);
  const step = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('shadow', { worker: [DS], critic: [NEON], arbiter: [SOL] }),
    scorecard: aggregateScorecard([], { seed: [] }),
    base: DEVIN, // база вне allowlist — противоречивая политика
  });
  assert.equal(step.outcome, 'rejected');
  assert.equal(step.reason, 'route_base_not_in_allowlist');
});

test('гистерезис в active: недоказанный кандидат базу не вытесняет', () => {
  const lines = journal(DS, 2); // 2 < min_observations
  const scorecard = aggregateScorecard(lines, { seed: [] });
  const step = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('active', { worker: [DEVIN, DS], critic: [NEON], arbiter: [SOL] }),
    scorecard, base: DEVIN, others: { critic: NEON, arbiter: SOL },
  });
  assert.equal(step.outcome, 'rejected');
  assert.equal(step.reason, 'route_no_proven_candidate');
});

test('routeTriad: три роли разных семейств, частичная триада не применяется', () => {
  // Критик-замена: openai-модель в allowlist критиков ломает триаду с арбитром.
  const openaiCritic = { provider: 'openai', model: 'gpt-6.1-sol' };
  const badCriticJournal = Array.from({ length: 6 }, () => JSON.stringify({
    kind: 'attempt_summary', schema: 1,
    models: { worker: DEVIN, critic: openaiCritic, arbiter: SOL },
    labels: { size: 'S', domain: 'backend' },
    rounds: { total: 2, rework: 1, pass: 1, arbitration: 0, open: 0, gates: { l2: 1 } },
    phases_ms: { total: 60000 }, outcome: 'done', open: false,
  }));
  const scorecard = aggregateScorecard([...journal(DS, 6), ...badCriticJournal], { seed: [] });
  const res = routeTriad({
    size: 'S', domain: 'backend',
    policy: policy('active', {
      worker: [DEVIN, DS], critic: [NEON, openaiCritic], arbiter: [SOL] }),
    scorecard,
    base: { worker: DEVIN, critic: NEON, arbiter: SOL },
  });
  // Критик: сильнейший кандидат — openai (ловит больше), но ломает триаду
  // с арбитром SOL и пропускается; следующий в allowlist — NEON.
  assert.equal(res.outcome, 'routed');
  assert.deepEqual(res.selected.critic, NEON);
  assert.equal(res.steps.critic.skipped[0].reason, 'triad_violation');
  // Инвариант семейств триады выполнен после динамического выбора.
  const fams = new Set([workerFamily(res.selected.worker),
    workerFamily(res.selected.critic), workerFamily(res.selected.arbiter)]);
  assert.equal(fams.size, 3);
});

test('routeTriad shadow: выборы неизменны, рекомендации видны', () => {
  const scorecard = aggregateScorecard(journal(DS, 6), { seed: [] });
  const res = routeTriad({
    size: 'S', domain: 'backend',
    policy: policy('shadow', {
      worker: [DEVIN, DS], critic: [NEON], arbiter: [SOL] }),
    scorecard,
    base: { worker: DEVIN, critic: NEON, arbiter: SOL },
  });
  assert.equal(res.outcome, 'shadow');
  assert.equal(res.selected.worker, DEVIN);
  assert.equal(res.selected.critic, NEON);
  assert.equal(res.selected.arbiter, SOL);
  assert.equal(modelKey(res.steps.worker.recommended), modelKey(DS));
});

test('availability/квота: недоступная и исчерпавшая квоту модель пропускается', () => {
  // DS сильнее DEVIN, но квота исчерпана; DEEPSEEK недоступен.
  const lines = [...journal(DS, 6), ...journal(DEVIN, 6, { failEvery: 2 }),
    ...journal(DEEPSEEK, 6)];
  const scorecard = aggregateScorecard(lines, { seed: [] });
  const allow = { worker: [DEVIN, DS, DEEPSEEK], critic: [NEON], arbiter: [SOL] };
  const availability = {
    [modelKey(DS)]: 'quota_exhausted',
    [modelKey(DEEPSEEK)]: 'unavailable',
    [modelKey(DEVIN)]: 'available',
  };
  const active = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('active', allow), scorecard, base: DEVIN,
    others: { critic: NEON, arbiter: SOL }, availability,
  });
  assert.equal(active.outcome, 'routed');
  assert.equal(modelKey(active.selected), modelKey(DEVIN)); // единственный доступный
  const reasons = active.skipped.map(s => s.reason).sort();
  assert.deepEqual(reasons, ['quota_exhausted', 'unavailable']);
  // В shadow недоступная модель не рекомендуется.
  const shadow = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('shadow', allow), scorecard, base: DEVIN,
    others: { critic: NEON, arbiter: SOL }, availability,
  });
  assert.equal(shadow.outcome, 'shadow');
  assert.equal(modelKey(shadow.recommended), modelKey(DEVIN));
  // Предикат-форма availability и неизвестный статус — тоже отказ.
  const pred = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('active', allow), scorecard, base: DEVIN,
    others: { critic: NEON, arbiter: SOL },
    availability: spec => spec.provider === 'acp-devin' ? 'weird' : 'available',
  });
  // DEVIN помечен неизвестным статусом → 'unavailable'; DS/DEEPSEEK available
  // → лучший из них выбирается.
  assert.equal(pred.outcome, 'routed');
  assert.notEqual(modelKey(pred.selected), modelKey(DEVIN));
});

test('триада для base: невалидный по семействам base — отказ и в shadow', () => {
  const googleWorker = { provider: 'google', model: 'gemini-4-neon' }; // семейство критика
  const scorecard = aggregateScorecard(journal(DEVIN, 6), { seed: [] });
  for (const mode of ['shadow', 'active']) {
    const step = routeRole({
      role: 'worker', size: 'S', domain: 'backend',
      policy: policy(mode, {
        worker: [DEVIN, googleWorker], critic: [NEON], arbiter: [SOL] }),
      scorecard, base: googleWorker, // base в allowlist, но ломает триаду
      others: { critic: NEON, arbiter: SOL },
    });
    assert.equal(step.outcome, 'rejected', `mode=${mode}`);
    assert.equal(step.reason, 'route_base_triad_violation');
    assert.equal(step.selected, null);
  }
});

test('routeTriad: worker-шаг видит переданные base.critic/base.arbiter', () => {
  // Кастомный base.critic — deepseek-семейство: кандидат-executor DS легален
  // против дефолтного NEON (google), но ломает триаду против этого base.
  const dsCritic = { provider: 'opencode-go', model: 'deepseek-reasoner' };
  const scorecard = aggregateScorecard(journal(DS, 6), { seed: [] });
  const res = routeTriad({
    size: 'S', domain: 'backend',
    policy: policy('active', {
      worker: [DEVIN, DS], critic: [dsCritic], arbiter: [SOL] }),
    scorecard,
    base: { worker: DEVIN, critic: dsCritic, arbiter: SOL },
  });
  assert.equal(res.outcome, 'rejected');
  assert.equal(res.role, 'worker');
  assert.equal(res.reason, 'route_triad_violation');
  assert.equal(res.steps.worker.skipped[0].reason, 'triad_violation');
});

test('routeRole нормализует метки: size=\'s\', domain=\'Backend\' находят клетку', () => {
  const scorecard = aggregateScorecard(journal(DS, 6), { seed: [] });
  const step = routeRole({
    role: 'worker', size: 's', domain: 'Backend',
    policy: policy('active', { worker: [DEVIN, DS], critic: [NEON], arbiter: [SOL] }),
    scorecard, base: DEVIN, others: { critic: NEON, arbiter: SOL },
  });
  assert.equal(step.outcome, 'routed');
  assert.equal(modelKey(step.selected), modelKey(DS));
  assert.equal(step.note.size, 'S');
  assert.equal(step.note.domain, 'backend');
});

test('end-to-end: реальный журнал на диске → отчёт и роутинг', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scorecard-'));
  try {
    const lines = [...journal(DS, 6), ...journal(DEVIN, 6, { failEvery: 2 })];
    await writeFile(join(dir, 'telemetry.jsonl'), lines.join('\n') + '\n', { mode: 0o600 });
    const text = await readFile(join(dir, 'telemetry.jsonl'), 'utf8');
    const scorecard = aggregateScorecard(text.split('\n').filter(l => l.trim()), { seed: [] });
    assert.equal(scorecard.entries, 12);
    const cell = scorecard.cells[bucketKey(DS, 'worker', 'backend', 'S')];
    assert.equal(cell.observations, 6);
    assert.equal(cell.first_pass_rate, 1);
    const step = routeRole({
      role: 'worker', size: 'S', domain: 'backend',
      policy: policy('active', { worker: [DEVIN, DS], critic: [NEON], arbiter: [SOL] }),
      scorecard, base: DEVIN, others: { critic: NEON, arbiter: SOL },
    });
    assert.equal(step.outcome, 'routed');
    // Выбранное семейство отличается от критика и арбитра.
    const fams = new Set([workerFamily(step.selected), workerFamily(NEON), workerFamily(SOL)]);
    assert.equal(fams.size, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Routing Policy v2 интеграция: opencode-go и Opus 5.5 escalation ────────
test('opencode-go: не-DeepSeek модель в allowlist — явный отказ политики', () => {
  // DeepSeek допускается и маршрутизируется.
  const ok = normalizeRoutingPolicy(policy('active', {
    worker: [DEVIN, DEEPSEEK], critic: [NEON], arbiter: [SOL] }));
  assert.equal(ok.allowlist.worker.length, 2);
  // Не-DeepSeek opencode-go — отказ с причиной политики, в т.ч. через pi-харнесс.
  for (const spec of [{ provider: 'opencode-go', model: 'deepseek-v4' },
      { provider: 'pi', model: 'opencode-go/kimi-k2' }]) {
    const violation = opencodeGoPolicyViolation(spec);
    const expected = spec.model.endsWith('kimi-k2')
      ? 'opencode_go_non_deepseek_disallowed' : null;
    assert.equal(violation, expected, JSON.stringify(spec));
  }
  assert.throws(() => normalizeRoutingPolicy(policy('active', {
    worker: [DEVIN, { provider: 'pi', model: 'opencode-go/qwen3-coder' }],
    critic: [NEON], arbiter: [SOL] })),
    e => e instanceof ReviewDenied && e.reason === 'opencode_go_non_deepseek_disallowed');
});

test('Opus 5.5 escalation: все три условия → anthropic; иначе graceful fallback', () => {
  const triad = { worker: DEVIN, critic: NEON };
  const quota = { status: 'available', remaining: 1, used: 0, cap: 3 };
  // High-stakes триггер + квота + инвариант → слот Opus 5.5.
  const opus = selectEscalationReviewer({ trigger: 'release_gate', quota, triad });
  assert.equal(opus.outcome, 'selected');
  assert.equal(opus.reviewer.provider, 'agy');
  assert.equal(opus.family, 'anthropic');
  // Семейство ревьюера независимо от воркера и критика триады.
  const fams = new Set([opus.family, workerFamily(DEVIN), workerFamily(NEON)]);
  assert.equal(fams.size, 3);
  // Исчерпанная квота → детерминированный fallback Pi/Sol с явной причиной.
  const fb = selectEscalationReviewer({
    trigger: { dispute_rounds: 3 }, quota: { status: 'available', remaining: 0 }, triad });
  assert.equal(fb.outcome, 'fallback');
  assert.equal(fb.reason, 'opus_quota_exhausted');
  assert.equal(fb.reviewer.provider, 'pi');
  // Без триггера — тот же детерминированный fallback, другая причина.
  const noTrig = selectEscalationReviewer({ trigger: 'local_checks_failed', quota, triad });
  assert.equal(noTrig.outcome, 'fallback');
  assert.equal(noTrig.reason, 'no_escalation_trigger');
});

test('acp-zcode-start выведен из обращения: allowlist и план его отклоняют', async () => {
  const zcode = { provider: 'acp-zcode-start',
    model: 'builtin:zai-start-plan\\GLM-5.3-Flash', effort: 'max' };
  // В allowlist.worker — явный отказ политики.
  assert.throws(() => normalizeRoutingPolicy(policy('active', {
    worker: [DEVIN, zcode], critic: [NEON], arbiter: [SOL] })),
    e => e instanceof ReviewDenied && e.reason === 'zcode_provider_retired');
  // В явном плане попытки — резерв пропускается с той же причиной, маршрут
  // идёт по DeepSeek/Neon.
  const selection = await attemptSpawnWithFallback({
    attempt: { task_id: '9', epoch: 1, attempt_id: 'a1', base_sha: 'a'.repeat(40) },
    plan: [PRIMARY_WORKER, zcode, { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' }],
    probe: async w => w.provider === 'acp-devin'
      ? { status: 'confirmed_refusal', activeBackgroundAgentCount: 0 }
      : { status: 'available', activeBackgroundAgentCount: 0 },
    spawn: async () => ({ threadId: 'thr_ok' }),
    inspectWorktree: async () => ({ clean: true, head: 'a'.repeat(40) }),
  });
  assert.equal(selection.outcome, 'spawned');
  assert.equal(selection.worker.provider, 'pi');
  const retired = selection.attemptedWorkers.find(w => w.provider === 'acp-zcode-start');
  assert.equal(retired.verdict, 'skipped');
  assert.equal(retired.reason, 'zcode_provider_retired');
});

// ── Board #1263: активация routeTriad в active-режиме с безопасным откатом ──
import {
  FALLBACK_ANTIGRAVITY_NEON,
  NARROW_RESERVE_PI,
  resolveTriad,
} from './worker-selector.mjs';

const allowAll = { worker: [DEVIN, DS], critic: [NEON], arbiter: [SOL] };

test('resolveTriad: режим не задан — shadow, проверенный план', () => {
  const res = resolveTriad({ policy: {}, scorecard: null });
  assert.equal(res.outcome, 'shadow');
  assert.deepEqual(res.selected, { worker: DEVIN, critic: NEON, arbiter: SOL });
  // FALLBACK_NEON (google) разделяет семейство с критиком NEON — в план не
  // попадает: резервы валидируются попарной независимостью триады.
  assert.deepEqual(res.plan, [DEVIN, NARROW_RESERVE_PI]);
});

test('resolveTriad active: доказанный кандидат вытесняет базу, план — резервы', () => {
  const lines = [...journal(DS, 6), ...journal(DEVIN, 6, { failEvery: 2 })];
  const scorecard = aggregateScorecard(lines, { seed: [] });
  const res = resolveTriad({ size: 'S', domain: 'backend',
    policy: policy('active', allowAll), scorecard });
  assert.equal(res.outcome, 'routed');
  assert.equal(modelKey(res.selected.worker), modelKey(DS));
  // Инвариант трёх независимых семейств выполнен на выбранной триаде.
  const fams = new Set([workerFamily(res.selected.worker),
    workerFamily(res.selected.critic), workerFamily(res.selected.arbiter)]);
  assert.equal(fams.size, 3);
  // План начинается с динамического первичного, резервы без дублей и все —
  // внутри allowlist и независимые от выбранных критика/арбитра.
  assert.equal(modelKey(res.plan[0]), modelKey(DS));
  assert.equal(new Set(res.plan.map(modelKey)).size, res.plan.length);
  for (const reserve of res.plan.slice(1)) {
    assert.ok(allowAll.worker.some(w => modelKey(w) === modelKey(reserve)));
    assert.notEqual(workerFamily(reserve), workerFamily(res.selected.critic));
    assert.notEqual(workerFamily(reserve), workerFamily(res.selected.arbiter));
  }
});

test('resolveTriad active: деградация скоркарда — откат с явной причиной', () => {
  const notes = [];
  for (const scorecard of [null, undefined, {}, { cells: null }, 'junk']) {
    const res = resolveTriad({ size: 'S', domain: 'backend',
      policy: policy('active', allowAll), scorecard,
      log: note => notes.push(note) });
    assert.equal(res.outcome, 'fallback', JSON.stringify(scorecard));
    assert.equal(res.reason, 'scorecard_unavailable');
    assert.deepEqual(res.selected, { worker: DEVIN, critic: NEON, arbiter: SOL });
  }
  assert.equal(notes.length, 5);
  assert.equal(notes[0].kind, 'route_fallback');
  assert.equal(notes[0].reason, 'scorecard_unavailable');
});

test('resolveTriad: битые строки журнала (corrupt>0) — scorecard_corrupt', () => {
  const lines = [...journal(DS, 6), 'not json at all', '{"broken":'];
  const scorecard = aggregateScorecard(lines, { seed: [] });
  assert.equal(scorecard.corrupt, 2);
  for (const mode of ['shadow', 'active']) {
    const res = resolveTriad({ size: 'S', domain: 'backend',
      policy: policy(mode, allowAll), scorecard });
    assert.equal(res.outcome, 'fallback', mode);
    assert.equal(res.reason, 'scorecard_corrupt');
    // Откат несёт проверенную базовую триаду и валидный план.
    assert.deepEqual(res.selected, { worker: DEVIN, critic: NEON, arbiter: SOL });
    assert.ok(res.plan.length >= 1);
  }
});

test('resolveTriad active: нет доказанных кандидатов — откат, не частичная триада', () => {
  const scorecard = aggregateScorecard(journal(DS, 2), { seed: [] }); // < min_obs
  const res = resolveTriad({ size: 'S', domain: 'backend',
    policy: policy('active', allowAll), scorecard });
  assert.equal(res.outcome, 'fallback');
  assert.match(res.reason, /^route_active_rejected:/);
  assert.equal(res.selected.worker, DEVIN);
  assert.equal(res.plan[0], DEVIN);
});

test('resolveTriad: битая политика — откат, исключение не улетает наружу', () => {
  const bad = policy('active', {
    worker: [{ provider: 'mystery', model: 'unknown' }], critic: [NEON], arbiter: [SOL] });
  const res = resolveTriad({ scorecard: aggregateScorecard([], { seed: [] }),
    policy: bad });
  assert.equal(res.outcome, 'fallback');
  assert.match(res.reason, /^routing_policy_invalid:/);
  assert.equal(res.selected.worker, DEVIN);
  assert.deepEqual(res.plan, [DEVIN]); // резервы без проверенного allowlist не доказаны
});

test('resolveTriad: невалидная база — явный rejected в обоих режимах', () => {
  const scorecard = aggregateScorecard(journal(DS, 6), { seed: [] });
  // Критик и арбитр одного семейства — триада не доказана.
  const badBase = { worker: DEVIN, critic: NEON,
    arbiter: { provider: 'google', model: 'gemini-4-neon' } };
  for (const mode of ['shadow', 'active']) {
    const res = resolveTriad({ policy: policy(mode, allowAll), scorecard, base: badBase });
    assert.equal(res.outcome, 'rejected', mode);
    assert.match(res.reason, /^route_base_triad_violation:/);
    assert.equal(res.selected, null);
    assert.deepEqual(res.plan, []);
  }
  // База вне непустого allowlist — тоже rejected, а не тихий selected.
  const res = resolveTriad({ policy: policy('shadow', {
      worker: [DS], critic: [NEON], arbiter: [SOL] }), scorecard });
  assert.equal(res.outcome, 'rejected');
  assert.equal(res.reason, 'route_base_not_in_allowlist');
});

test('resolveTriad: резерв вне allowlist.worker в план не попадает', () => {
  // DS доказанно сильнее, но вне allowlist; резервы DeepSeek/Neon тоже вне
  // allowlist.worker — в план не попадает никто из недопущенных.
  const scorecard = aggregateScorecard(
    [...journal(DEVIN, 6), ...journal(DS, 6)], { seed: [] });
  const res = resolveTriad({ size: 'S', domain: 'backend',
    policy: policy('active', { worker: [DEVIN], critic: [NEON], arbiter: [SOL] }),
    scorecard });
  assert.equal(res.outcome, 'routed');
  assert.deepEqual(res.plan, [DEVIN]);
});

test('resolveTriad shadow: рекомендация считается, назначение не меняется', () => {
  const lines = [...journal(DS, 6), ...journal(DEVIN, 6, { failEvery: 2 })];
  const scorecard = aggregateScorecard(lines, { seed: [] });
  const res = resolveTriad({ size: 'S', domain: 'backend',
    policy: policy('shadow', allowAll), scorecard });
  assert.equal(res.outcome, 'shadow');
  assert.equal(res.selected.worker, DEVIN); // назначение не изменилось
  assert.equal(modelKey(res.recommended), modelKey(DS)); // рекомендация видна
});
