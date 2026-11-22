// VS-3 интеграция: журнал телеметрии → скоркард → policy-bounded роутинг
// ролей в режимах shadow/active с инвариантом кросс-семейственной триады.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateScorecard, bucketKey, modelKey } from './model-scorecard.mjs';
import {
  DEFAULT_ARBITER,
  DEFAULT_CRITIC,
  normalizeRoutingPolicy,
  PRIMARY_WORKER,
  routeRole,
  routeTriad,
  workerFamily,
} from './worker-selector.mjs';
import { ReviewDenied } from './review-runner.mjs';

const DEVIN = PRIMARY_WORKER; // cognition
const GLM = { provider: 'acp-zcode-start', model: 'builtin:zai-start-plan\\GLM-5.3-Flash', effort: 'max' };
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
  // GLM доказанно сильнее DEVIN в клетке backend/S.
  const lines = [...journal(GLM, 6), ...journal(DEVIN, 6, { failEvery: 2 })];
  const scorecard = aggregateScorecard(lines, { seed: [] });
  const notes = [];
  const step = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('shadow', { worker: [DEVIN, GLM], critic: [NEON], arbiter: [SOL] }),
    scorecard, base: DEVIN, others: { critic: NEON, arbiter: SOL },
    log: note => notes.push(note),
  });
  assert.equal(step.outcome, 'shadow');
  assert.equal(step.selected, DEVIN); // выбор не изменился
  assert.equal(modelKey(step.recommended), modelKey(GLM)); // рекомендация — GLM
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'route_recommendation');
  assert.equal(modelKey(notes[0].recommended), modelKey(GLM));
});

test('active: доказанный кандидат вытесняет базу строго внутри allowlist', () => {
  const lines = [...journal(GLM, 6), ...journal(DEVIN, 6, { failEvery: 2 })];
  const scorecard = aggregateScorecard(lines, { seed: [] });
  const step = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('active', { worker: [DEVIN, GLM], critic: [NEON], arbiter: [SOL] }),
    scorecard, base: DEVIN, others: { critic: NEON, arbiter: SOL },
  });
  assert.equal(step.outcome, 'routed');
  assert.equal(modelKey(step.selected), modelKey(GLM));
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
    policy: policy('active', { worker: [DEVIN, GLM], critic: [NEON], arbiter: [SOL] }),
    scorecard, base: DEVIN, others: { critic: NEON, arbiter: SOL },
  });
  assert.equal(step.outcome, 'rejected');
  assert.equal(step.reason, 'route_no_proven_candidate');
  // И в shadow вне allowlist рекомендации нет — журналируется null.
  const shadow = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('shadow', { worker: [DEVIN, GLM], critic: [NEON], arbiter: [SOL] }),
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
    policy: policy('shadow', { worker: [GLM], critic: [NEON], arbiter: [SOL] }),
    scorecard: aggregateScorecard([], { seed: [] }),
    base: DEVIN, // база вне allowlist — противоречивая политика
  });
  assert.equal(step.outcome, 'rejected');
  assert.equal(step.reason, 'route_base_not_in_allowlist');
});

test('гистерезис в active: недоказанный кандидат базу не вытесняет', () => {
  const lines = journal(GLM, 2); // 2 < min_observations
  const scorecard = aggregateScorecard(lines, { seed: [] });
  const step = routeRole({
    role: 'worker', size: 'S', domain: 'backend',
    policy: policy('active', { worker: [DEVIN, GLM], critic: [NEON], arbiter: [SOL] }),
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
  const scorecard = aggregateScorecard([...journal(GLM, 6), ...badCriticJournal], { seed: [] });
  const res = routeTriad({
    size: 'S', domain: 'backend',
    policy: policy('active', {
      worker: [DEVIN, GLM], critic: [NEON, openaiCritic], arbiter: [SOL] }),
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
  const scorecard = aggregateScorecard(journal(GLM, 6), { seed: [] });
  const res = routeTriad({
    size: 'S', domain: 'backend',
    policy: policy('shadow', {
      worker: [DEVIN, GLM], critic: [NEON], arbiter: [SOL] }),
    scorecard,
    base: { worker: DEVIN, critic: NEON, arbiter: SOL },
  });
  assert.equal(res.outcome, 'shadow');
  assert.equal(res.selected.worker, DEVIN);
  assert.equal(res.selected.critic, NEON);
  assert.equal(res.selected.arbiter, SOL);
  assert.equal(modelKey(res.steps.worker.recommended), modelKey(GLM));
});

test('end-to-end: реальный журнал на диске → отчёт и роутинг', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scorecard-'));
  try {
    const lines = [...journal(GLM, 6), ...journal(DEVIN, 6, { failEvery: 2 })];
    await writeFile(join(dir, 'telemetry.jsonl'), lines.join('\n') + '\n', { mode: 0o600 });
    const text = await readFile(join(dir, 'telemetry.jsonl'), 'utf8');
    const scorecard = aggregateScorecard(text.split('\n').filter(l => l.trim()), { seed: [] });
    assert.equal(scorecard.entries, 12);
    const cell = scorecard.cells[bucketKey(GLM, 'worker', 'backend', 'S')];
    assert.equal(cell.observations, 6);
    assert.equal(cell.first_pass_rate, 1);
    const step = routeRole({
      role: 'worker', size: 'S', domain: 'backend',
      policy: policy('active', { worker: [DEVIN, GLM], critic: [NEON], arbiter: [SOL] }),
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
