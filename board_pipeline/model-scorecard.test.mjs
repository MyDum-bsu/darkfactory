import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateScorecard,
  bucketKey,
  cellProven,
  DEFAULT_MIN_OBSERVATIONS,
  formatScorecardReport,
  modelKey,
  normalizeDomain,
  normalizeSize,
  rankCandidates,
  SEED_PROFILE,
} from './model-scorecard.mjs';

const DEVIN = { provider: 'acp-devin', model: 'swe-2-high' };
const GLM = { provider: 'acp-zcode-start', model: 'builtin:zai-start-plan\\GLM-5.3-Flash', effort: 'max' };
const NEON = { provider: 'google', model: 'gemini-4-neon' };
const SOL = { provider: 'openai', model: 'gpt-6.2-sol' };

// Строка журнала attempt_summary с метками разреза и показателями попытки.
const line = ({ models = {}, labels = null, rounds = {}, phases = {}, tokens = {},
  outcome = 'done', open = false, extra = {} } = {}) =>
  JSON.stringify({
    kind: 'attempt_summary', schema: 1,
    task_id: '1', attempt_id: 'a', epoch: 1,
    ...(labels ? { labels } : {}),
    models, rounds, phases_ms: phases, tokens,
    outcome, open,
    ...extra,
  });

const workerAttempt = (worker, { labels, rounds, phases, tokens, outcome, open } = {}) =>
  line({ models: { worker, critic: NEON, arbiter: SOL },
    labels, rounds: { total: 1, rework: 0, pass: 1, arbitration: 0, open: 0, ...rounds },
    phases: { total: 1000, ...phases }, tokens, outcome, open });

test('пересчёт: метрики по role × domain × size', () => {
  const lines = [
    workerAttempt(DEVIN, { labels: { size: 'S', domain: 'backend' },
      rounds: { total: 1, rework: 0 }, phases: { total: 60000 },
      tokens: { worker: { input: 30000, output: 10000, cached: null } } }),
    workerAttempt(DEVIN, { labels: { size: 'S', domain: 'backend' },
      rounds: { total: 2, rework: 1 }, phases: { total: 120000 },
      tokens: { worker: { input: 50000, output: 30000, cached: null } } }),
  ];
  const sc = aggregateScorecard(lines, { seed: [] });
  const cell = sc.cells[bucketKey(DEVIN, 'worker', 'backend', 'S')];
  assert.equal(cell.observations, 2);
  assert.equal(cell.first_pass_rate, 0.5);
  assert.equal(cell.avg_rounds, 1.5);
  assert.equal(cell.avg_wall_ms, 90000);
  // (40000/1 + 80000/2) / 2 = 40000
  assert.equal(cell.token_efficiency, 40000);
  assert.equal(cell.defect_catch_rate, null);
});

test('defect_catch_rate критика: доля попыток с L2-rework', () => {
  const lines = [
    line({ models: { worker: DEVIN, critic: NEON },
      labels: { size: 'M', domain: 'ui' },
      rounds: { total: 2, rework: 1, gates: { l2: 1 } } }),
    line({ models: { worker: DEVIN, critic: NEON },
      labels: { size: 'M', domain: 'ui' },
      rounds: { total: 1, rework: 0 } }),
  ];
  const sc = aggregateScorecard(lines, { seed: [] });
  const cell = sc.cells[bucketKey(NEON, 'critic', 'ui', 'M')];
  assert.equal(cell.observations, 2);
  assert.equal(cell.defect_catch_rate, 0.5);
});

test('невалидные/отсутствующие метки → клетка unknown; битые строки в corrupt', () => {
  const lines = [
    workerAttempt(DEVIN, { labels: { size: 'XL', domain: 'qa' } }),
    workerAttempt(DEVIN),
    'not json',
    JSON.stringify({ kind: 'other', schema: 1 }),
  ];
  const sc = aggregateScorecard(lines, { seed: [] });
  assert.equal(sc.corrupt, 1);
  assert.equal(sc.entries, 2);
  const cell = sc.cells[bucketKey(DEVIN, 'worker', 'unknown', 'unknown')];
  assert.equal(cell.observations, 2);
  assert.equal(sc.cells[bucketKey(DEVIN, 'worker', 'qa', 'XL')], undefined);
});

test('seed-профиль: вес подтверждённых замеров и wildcard-клетки', () => {
  const sc = aggregateScorecard([], {});
  const cell = sc.cells[bucketKey(DEVIN, 'worker', 'backend', 'S')];
  assert.equal(cell.observations, 8);
  assert.equal(cell.seed_observations, 8);
  assert.equal(cell.measured, 0);
  assert.equal(cell.first_pass_rate, 0.75);
  // Живое наблюдение складывается с seed-весом, а не заменяет его.
  const lines = [workerAttempt(DEVIN, { labels: { size: 'S', domain: 'backend' },
    rounds: { total: 1, rework: 0 } })];
  const sc2 = aggregateScorecard(lines, {});
  const cell2 = sc2.cells[bucketKey(DEVIN, 'worker', 'backend', 'S')];
  assert.equal(cell2.observations, 9);
  assert.equal(cell2.seed_observations, 8);
  assert.equal(cell2.measured, 1);
  // (0.75*8 + 1*1) / 9
  assert.ok(Math.abs(cell2.first_pass_rate - 7 / 9) < 1e-9);
});

test('гистерезис: клетка ниже min_observations недоказана и не ранжируется', () => {
  const lines = Array.from({ length: 4 }, () =>
    workerAttempt(DEVIN, { labels: { size: 'S', domain: 'backend' } }));
  const sc = aggregateScorecard(lines, { seed: [] });
  const cell = sc.cells[bucketKey(DEVIN, 'worker', 'backend', 'S')];
  assert.equal(cellProven(cell, DEFAULT_MIN_OBSERVATIONS), false);
  assert.equal(rankCandidates(sc, { role: 'worker', domain: 'backend', size: 'S' }).length, 0);
  const oneMore = [...lines, workerAttempt(DEVIN, { labels: { size: 'S', domain: 'backend' } })];
  const sc2 = aggregateScorecard(oneMore, { seed: [] });
  assert.equal(cellProven(sc2.cells[bucketKey(DEVIN, 'worker', 'backend', 'S')]), true);
  const ranked = rankCandidates(sc2, { role: 'worker', domain: 'backend', size: 'S' });
  assert.equal(ranked.length, 1);
  assert.equal(modelKey(ranked[0].model), 'acp-devin/swe-2-high');
});

test('ранжирование детерминированно: first_pass, затем раунды и стоимость', () => {
  const mk = (model, fpr, rounds) => Array.from({ length: 5 }, (_, i) =>
    workerAttempt(model, { labels: { size: 'M', domain: 'backend' },
      rounds: { total: rounds, rework: i < 5 * (1 - fpr) ? rounds - 1 : 0 },
      phases: { total: 50000 } }));
  const lines = [
    ...mk(DEVIN, 0.6, 2),
    ...mk(GLM, 1.0, 1),
  ];
  const sc = aggregateScorecard(lines, { seed: [] });
  const ranked = rankCandidates(sc, { role: 'worker', domain: 'backend', size: 'M' });
  assert.equal(ranked.length, 2);
  assert.equal(modelKey(ranked[0].model), 'acp-zcode-start/builtin:zai-start-plan\\GLM-5.3-Flash');
  const again = rankCandidates(sc, { role: 'worker', domain: 'backend', size: 'M' });
  assert.deepEqual(again.map(c => modelKey(c.model)), ranked.map(c => modelKey(c.model)));
});

test('rankCandidates ограничен allowlist-моделями и нужной ролью', () => {
  const lines = Array.from({ length: 5 }, () =>
    workerAttempt(DEVIN, { labels: { size: 'S', domain: 'docs' } }));
  const sc = aggregateScorecard(lines, { seed: [] });
  assert.equal(rankCandidates(sc, { role: 'worker', domain: 'docs', size: 'S',
    models: [GLM] }).length, 0);
  assert.equal(rankCandidates(sc, { role: 'critic', domain: 'docs', size: 'S',
    models: [DEVIN] }).length, 0);
  const ranked = rankCandidates(sc, { role: 'worker', domain: 'docs', size: 'S',
    models: [DEVIN, GLM] });
  assert.equal(ranked.length, 1);
});

test('отчёт таблицей для владельца/CTO', () => {
  const lines = [workerAttempt(DEVIN, { labels: { size: 'S', domain: 'backend' } })];
  const report = formatScorecardReport(aggregateScorecard(lines, {}));
  assert.match(report, /Model scorecard: 1 attempts/);
  assert.match(report, /acp-devin\/swe-2-high \| worker \| backend \| S/);
  assert.match(report, /first_pass/);
});

test('tokensPerRound: input и output оба null — метрика null, а не 0', () => {
  const lines = [
    workerAttempt(DEVIN, { labels: { size: 'S', domain: 'backend' },
      tokens: { worker: { input: null, output: null, cached: 500 } } }),
    workerAttempt(DEVIN, { labels: { size: 'S', domain: 'backend' },
      tokens: { worker: { input: null, output: null, cached: null } } }),
  ];
  const sc = aggregateScorecard(lines, { seed: [] });
  const cell = sc.cells[bucketKey(DEVIN, 'worker', 'backend', 'S')];
  assert.equal(cell.token_efficiency, null);
});

test('открытые попытки полностью исключены из first_pass_rate', () => {
  const lines = [
    workerAttempt(DEVIN, { labels: { size: 'S', domain: 'backend' } }), // closed first-pass
    workerAttempt(DEVIN, { labels: { size: 'S', domain: 'backend' },
      open: true, outcome: null }), // открытая — исход неизвестен
  ];
  const sc = aggregateScorecard(lines, { seed: [] });
  const cell = sc.cells[bucketKey(DEVIN, 'worker', 'backend', 'S')];
  assert.equal(cell.observations, 2); // в n попытка есть
  assert.equal(cell.first_pass_rate, 1); // но знаменатель — только закрытая
});

test('нормализация size/domain: запрос и каноны', () => {
  assert.equal(normalizeSize('s'), 'S');
  assert.equal(normalizeSize(' M '), 'M');
  assert.equal(normalizeSize('XL'), 'unknown');
  assert.equal(normalizeSize(null), 'unknown');
  assert.equal(normalizeDomain('Backend'), 'backend');
  assert.equal(normalizeDomain('UI'), 'ui');
  assert.equal(normalizeDomain('qa'), 'unknown');
  assert.equal(normalizeDomain(undefined), 'unknown');
  // rankCandidates принимает «сырые» метки: 's'/'Backend' находят клетку 'S'/'backend'.
  const lines = Array.from({ length: 5 }, () =>
    workerAttempt(DEVIN, { labels: { size: 'S', domain: 'backend' } }));
  const sc = aggregateScorecard(lines, { seed: [] });
  const ranked = rankCandidates(sc, { role: 'worker', domain: 'Backend', size: 's' });
  assert.equal(ranked.length, 1);
});

test('seed по умолчанию — подтверждённый профиль', () => {
  const sc = aggregateScorecard([]);
  assert.ok(Object.keys(sc.cells).length > 0);
  assert.ok(SEED_PROFILE.every(e => Number.isSafeInteger(e.observations) && e.observations >= 1));
});

test('невызванный arbiter не зачитывается: модель в models — не доказательство вызова', () => {
  const silent = line({ models: { worker: DEVIN, critic: NEON, arbiter: SOL },
    labels: { size: 'S', domain: 'backend' },
    rounds: { total: 1, rework: 0, pass: 1, arbitration: 0 },
    phases: { total: 1000, arbiter: null } });
  const sc = aggregateScorecard([silent], { seed: [] });
  assert.equal(sc.cells[bucketKey(SOL, 'arbiter', 'backend', 'S')], undefined);
});

test('вызванный arbiter зачитывается: arbitration, измеренная фаза, статус, токены', () => {
  const key = bucketKey(SOL, 'arbiter', 'backend', 'S');
  // arbitration > 0 — вызван; фаза arbiter не измерена — wall падает на total.
  const byArbitration = line({ models: { worker: DEVIN, arbiter: SOL },
    labels: { size: 'S', domain: 'backend' },
    rounds: { total: 2, rework: 1, pass: 1, arbitration: 1 },
    phases: { total: 5000, arbiter: null } });
  const cell = aggregateScorecard([byArbitration], { seed: [] }).cells[key];
  assert.equal(cell.observations, 1);
  assert.equal(cell.avg_wall_ms, 5000);
  // Конечная phases_ms.arbiter — вызван; wall — его собственная фаза, не total.
  const byPhase = line({ models: { worker: DEVIN, arbiter: SOL },
    labels: { size: 'S', domain: 'backend' },
    rounds: { total: 2, arbitration: 0 },
    phases: { total: 9000, arbiter: 3000 } });
  const cell2 = aggregateScorecard([byPhase], { seed: [] }).cells[key];
  assert.equal(cell2.observations, 1);
  assert.equal(cell2.avg_wall_ms, 3000);
  // phases_status.arbiter — доказательство вызова само по себе.
  const byStatus = line({ models: { worker: DEVIN, arbiter: SOL },
    labels: { size: 'S', domain: 'backend' },
    rounds: { total: 1, arbitration: 0 },
    phases: { total: 1000, arbiter: null },
    extra: { phases_status: { arbiter: 'fail' } } });
  assert.equal(aggregateScorecard([byStatus], { seed: [] }).cells[key].observations, 1);
  // Токены арбитра — доказательство вызова; объект из одних null — нет.
  const byTokens = line({ models: { worker: DEVIN, arbiter: SOL },
    labels: { size: 'S', domain: 'backend' },
    rounds: { total: 1, arbitration: 0 },
    phases: { total: 1000, arbiter: null },
    tokens: { arbiter: { input: 10, output: null, cached: null } } });
  assert.equal(aggregateScorecard([byTokens], { seed: [] }).cells[key].observations, 1);
  const nullTokens = line({ models: { worker: DEVIN, arbiter: SOL },
    labels: { size: 'S', domain: 'backend' },
    rounds: { total: 1, arbitration: 0 },
    phases: { total: 1000, arbiter: null },
    tokens: { arbiter: { input: null, output: null, cached: null } } });
  assert.equal(aggregateScorecard([nullTokens], { seed: [] }).cells[key], undefined);
  // Legacy-фикстура без собственного ключа arbiter — прежнее поведение,
  // как и для critic: минимальные записи старых журналов не теряются.
  const legacy = line({ models: { worker: DEVIN, arbiter: SOL },
    labels: { size: 'S', domain: 'backend' },
    rounds: { total: 1, arbitration: 0 },
    phases: { total: 1000 } });
  assert.equal(aggregateScorecard([legacy], { seed: [] }).cells[key].observations, 1);
});

test('невызванный critic не зачитывается: l2_critic null и нет следов вызова', () => {
  // Реальная запись telemetry.mjs: фаза l2_critic присутствует, но null —
  // попытка развернулась на L1 до ревью.
  const skipped = line({ models: { worker: DEVIN, critic: NEON },
    labels: { size: 'M', domain: 'ui' },
    rounds: { total: 1, rework: 1, gates: { l1: 1 } },
    phases: { total: 1000, l2_critic: null } });
  const sc = aggregateScorecard([skipped], { seed: [] });
  assert.equal(sc.cells[bucketKey(NEON, 'critic', 'ui', 'M')], undefined);
  // Воркер при этом зачитывается по-прежнему.
  assert.equal(sc.cells[bucketKey(DEVIN, 'worker', 'ui', 'M')].observations, 1);
});

test('вызванный critic зачитывается со своей фазой wall time', () => {
  const key = bucketKey(NEON, 'critic', 'ui', 'M');
  // l2_critic измерен — вызван; avg_wall — 45000 фазы, а не 60000 total.
  const invoked = line({ models: { worker: DEVIN, critic: NEON },
    labels: { size: 'M', domain: 'ui' },
    rounds: { total: 1, rework: 0 },
    phases: { total: 60000, l2_critic: 45000 } });
  const cell = aggregateScorecard([invoked], { seed: [] }).cells[key];
  assert.equal(cell.observations, 1);
  assert.equal(cell.avg_wall_ms, 45000);
  // L2-гейт поймал дефект — критик вызван, даже если фаза null; wall — total.
  const byGate = line({ models: { worker: DEVIN, critic: NEON },
    labels: { size: 'M', domain: 'ui' },
    rounds: { total: 2, rework: 1, gates: { l2: 1 } },
    phases: { total: 7000, l2_critic: null } });
  const cell2 = aggregateScorecard([byGate], { seed: [] }).cells[key];
  assert.equal(cell2.observations, 1);
  assert.equal(cell2.avg_wall_ms, 7000);
  // Токены критика — доказательство вызова при null-фазе.
  const byTokens = line({ models: { worker: DEVIN, critic: NEON },
    labels: { size: 'M', domain: 'ui' },
    rounds: { total: 1 },
    phases: { total: 1000, l2_critic: null },
    tokens: { critic: { input: 10, output: 2, cached: null } } });
  assert.equal(aggregateScorecard([byTokens], { seed: [] }).cells[key].observations, 1);
  // phases_status.l2_critic — доказательство вызова само по себе.
  const byStatus = line({ models: { worker: DEVIN, critic: NEON },
    labels: { size: 'M', domain: 'ui' },
    rounds: { total: 1 },
    phases: { total: 1000, l2_critic: null },
    extra: { phases_status: { l2_critic: 'ok' } } });
  assert.equal(aggregateScorecard([byStatus], { seed: [] }).cells[key].observations, 1);
  // Legacy-фикстура без собственного ключа l2_critic — прежнее поведение.
  const legacy = line({ models: { worker: DEVIN, critic: NEON },
    labels: { size: 'M', domain: 'ui' },
    rounds: { total: 1 },
    phases: { total: 1000 } });
  assert.equal(aggregateScorecard([legacy], { seed: [] }).cells[key].observations, 1);
});
