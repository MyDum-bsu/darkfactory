// VS-3 Model Scorecard: детерминированный агрегатор умений моделей по журналу
// telemetry.jsonl (#961). Без LLM: чистые функции над строками журнала.
// Профиль каждой модели — в разрезе (role × domain × size S/M/L):
// first_pass_rate, avg_rounds, avg_wall_ms, token_efficiency и
// defect_catch_rate (для критиков). Стартовый seed-профиль из подтверждённых
// замеров складывается с наблюдениями; минимальный порог наблюдений
// (гистерезис) не даёт одному случайному сбою выкинуть модель из выбора.

import { TELEMETRY_SCHEMA } from './telemetry.mjs';

export const SCORECARD_SCHEMA = 1;

// Метки карточки из feature-blueprint (#492): только эти значения участвуют
// в разрезе; прочее/отсутствующее — 'unknown', не выдуманная размерность.
export const SCORE_SIZES = Object.freeze(['S', 'M', 'L']);
export const SCORE_DOMAINS = Object.freeze(['backend', 'ui', 'security', 'docs', 'research']);
export const SCORE_ROLES = Object.freeze(['worker', 'critic', 'arbiter']);
const UNKNOWN = 'unknown';

// Исход попытки, считающийся успешной сдачей в журнале телеметрии.
const PASS_OUTCOME = 'done';
// Собранный минимум наблюдений по умолчанию: ниже порога клетка считается
// недоказанной и не вытесняет действующий выбор (гистерезис).
export const DEFAULT_MIN_OBSERVATIONS = 5;

// Подтверждённые стартовые замеры до накопления живой телеметрии.
// Каждая запись — { model, role, domain, size, observations, ...метрики };
// домен/размер '*' означают подтверждённый агрегат по всем разрезам и
// применяются к любой клетке до появления собственных наблюдений.
export const SEED_PROFILE = Object.freeze([
  {
    model: { provider: 'acp-devin', model: 'swe-2-high' },
    role: 'worker', domain: '*', size: '*',
    observations: 8,
    first_pass_rate: 0.75, avg_rounds: 1.5, avg_wall_ms: 900000,
    tokens_per_round: 42000,
  },
  {
    model: { provider: 'google', model: 'gemini-4-neon' },
    role: 'critic', domain: '*', size: '*',
    observations: 8,
    first_pass_rate: null, avg_rounds: null, avg_wall_ms: 120000,
    tokens_per_round: 30000, defect_catch_rate: 0.6,
  },
  {
    model: { provider: 'openai', model: 'gpt-6.2-sol' },
    role: 'arbiter', domain: '*', size: '*',
    observations: 4,
    first_pass_rate: null, avg_rounds: null, avg_wall_ms: 90000,
    tokens_per_round: 25000,
  },
]);

// Метка разреза из записи журнала: labels {size, domain} либо верхнеуровневые
// поля; валидные значения приводятся к канону, остальное — 'unknown'.
function sizeOf(entry) {
  const raw = entry?.labels?.size ?? entry?.size;
  const size = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return SCORE_SIZES.includes(size) ? size : UNKNOWN;
}

function domainOf(entry) {
  const raw = entry?.labels?.domain ?? entry?.domain;
  const domain = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return SCORE_DOMAINS.includes(domain) ? domain : UNKNOWN;
}

export const modelKey = model =>
  typeof model?.provider === 'string' && typeof model?.model === 'string' &&
  model.provider && model.model ? `${model.provider}/${model.model}` : null;

export const bucketKey = (model, role, domain, size) =>
  `${modelKey(model)}|${role}|${domain}|${size}`;

// Исход «с первого раза»: закрытая успешная попытка без раундов rework.
// Открытые и неуспешные попытки first-pass не засчитывают, но в знаменатель
// входят — скрытая недооценка хуже честной оценки.
function firstPassOf(entry) {
  return entry.open !== true && entry.outcome === PASS_OUTCOME &&
    (entry.rounds?.rework ?? 0) === 0;
}

function isClosed(entry) {
  return entry.open !== true;
}

// Среднее токенов (input+output) на раунд для роли: меньше — эффективнее.
// Без usage провайдера — null, метрика просто не участвует в сравнении.
function tokensPerRound(entry, role) {
  const usage = entry.tokens?.[role];
  const rounds = entry.rounds?.total;
  if (usage === null || typeof usage !== 'object' ||
      !Number.isFinite(rounds) || rounds < 1) return null;
  const sum = (usage.input ?? 0) + (usage.output ?? 0);
  return Number.isFinite(sum) ? sum / rounds : null;
}

// Доля попыток, где критик реально поймал дефект: L2-гейт дал раунд rework.
// Для ролей вне критика метрика не определена (null).
function criticCaught(entry) {
  return (entry.rounds?.gates?.l2 ?? 0) > 0;
}

const emptyCell = () => ({
  n: 0, seed_n: 0,
  pass_n: 0, first_pass: 0,
  rounds_sum: 0, rounds_n: 0,
  wall_sum: 0, wall_n: 0,
  token_sum: 0, token_n: 0,
  catch_n: 0, caught: 0,
});

// Взвешенное слияние наблюдения в клетку. count — вес записи (для seed —
// число подтверждённых замеров); null-метрики знаменатель не увеличивают.
function addToCell(cell, { firstPass, rounds, wallMs, tokens, caught }, count = 1) {
  cell.n += count;
  if (firstPass !== null) { cell.pass_n += count; if (firstPass) cell.first_pass += count; }
  if (Number.isFinite(rounds)) { cell.rounds_sum += rounds * count; cell.rounds_n += count; }
  if (Number.isFinite(wallMs)) { cell.wall_sum += wallMs * count; cell.wall_n += count; }
  if (Number.isFinite(tokens)) { cell.token_sum += tokens * count; cell.token_n += count; }
  if (caught !== null) { cell.catch_n += count; if (caught) cell.caught += count; }
}

function finalizeCell(cell, meta) {
  const rate = (num, den) => den > 0 ? num / den : null;
  return {
    ...meta,
    observations: cell.n,
    seed_observations: cell.seed_n,
    measured: cell.n - cell.seed_n,
    first_pass_rate: rate(cell.first_pass, cell.pass_n),
    avg_rounds: rate(cell.rounds_sum, cell.rounds_n),
    avg_wall_ms: rate(cell.wall_sum, cell.wall_n),
    token_efficiency: rate(cell.token_sum, cell.token_n),
    defect_catch_rate: rate(cell.caught, cell.catch_n),
  };
}

// Применение seed-профиля: запись с domain/size '*' применяется к ЛЮБОЙ
// клетке той же модели и роли (подтверждённый агрегат); конкретные метки —
// только к своей клетке. Вес записи — observations (гистерезис против
// одиночного случайного наблюдения).
function applySeed(buckets, seed) {
  for (const entry of seed ?? []) {
    const key = modelKey(entry?.model);
    const role = entry?.role;
    const weight = entry?.observations;
    if (key === null || !SCORE_ROLES.includes(role) ||
        !Number.isSafeInteger(weight) || weight < 1) continue;
    const domains = entry.domain === '*' ? [...SCORE_DOMAINS, UNKNOWN]
      : [SCORE_DOMAINS.includes(entry.domain) ? entry.domain : UNKNOWN];
    const sizes = entry.size === '*' ? [...SCORE_SIZES, UNKNOWN]
      : [SCORE_SIZES.includes(entry.size) ? entry.size : UNKNOWN];
    for (const domain of domains) {
      for (const size of sizes) {
        const id = `${key}|${role}|${domain}|${size}`;
        const slot = buckets.get(id) ?? { cell: emptyCell(),
          meta: { model: entry.model, role, domain, size } };
        slot.cell.n += weight;
        slot.cell.seed_n += weight;
        if (Number.isFinite(entry.first_pass_rate)) {
          slot.cell.pass_n += weight;
          slot.cell.first_pass += entry.first_pass_rate * weight;
        }
        if (Number.isFinite(entry.avg_rounds)) {
          slot.cell.rounds_sum += entry.avg_rounds * weight;
          slot.cell.rounds_n += weight;
        }
        if (Number.isFinite(entry.avg_wall_ms)) {
          slot.cell.wall_sum += entry.avg_wall_ms * weight;
          slot.cell.wall_n += weight;
        }
        if (Number.isFinite(entry.tokens_per_round)) {
          slot.cell.token_sum += entry.tokens_per_round * weight;
          slot.cell.token_n += weight;
        }
        if (Number.isFinite(entry.defect_catch_rate)) {
          slot.cell.catch_n += weight;
          slot.cell.caught += entry.defect_catch_rate * weight;
        }
        buckets.set(id, slot);
      }
    }
  }
}

// Пересчёт скоркарда по строкам журнала. Чужие/битые строки — в corrupt.
// Открытые попытки входят в знаменатели, first-pass им не засчитывается.
export function aggregateScorecard(lines, { seed = SEED_PROFILE } = {}) {
  const buckets = new Map();
  applySeed(buckets, seed);
  const report = { schema: SCORECARD_SCHEMA, corrupt: 0, entries: 0, cells: {} };
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { report.corrupt += 1; continue; }
    if (entry?.kind !== 'attempt_summary' || entry?.schema !== TELEMETRY_SCHEMA) continue;
    report.entries += 1;
    const domain = domainOf(entry);
    const size = sizeOf(entry);
    const firstPass = firstPassOf(entry);
    const rounds = Number.isFinite(entry.rounds?.total) ? entry.rounds.total : null;
    const wallMs = Number.isFinite(entry.phases_ms?.total) ? entry.phases_ms.total : null;
    for (const role of SCORE_ROLES) {
      const model = entry.models?.[role];
      const key = modelKey(model);
      if (key === null) continue;
      const id = `${key}|${role}|${domain}|${size}`;
      const slot = buckets.get(id) ?? { cell: emptyCell(),
        meta: { model: { provider: model.provider, model: model.model }, role, domain, size } };
      addToCell(slot.cell, {
        firstPass: isClosed(entry) ? firstPass : null,
        rounds, wallMs,
        tokens: tokensPerRound(entry, role),
        caught: role === 'critic' ? criticCaught(entry) : null,
      });
      buckets.set(id, slot);
    }
  }
  for (const [id, slot] of [...buckets.entries()].sort(([a], [b]) => a < b ? -1 : 1)) {
    report.cells[id] = finalizeCell(slot.cell, slot.meta);
  }
  return report;
}

// Гистерезис: клетка доказана при observations >= minObservations.
// Недоказанная клетка не вытесняет действующий выбор и не участвует
// в ранжировании active-режима.
export function cellProven(cell, minObservations = DEFAULT_MIN_OBSERVATIONS) {
  return cell !== null && typeof cell === 'object' &&
    Number.isSafeInteger(cell.observations) && cell.observations >= minObservations;
}

// Детерминированный композитный балл клетки для роли. Числа сравниваются
// в фиксированном порядке — одинаковые данные всегда дают одинаковый ранг.
function cellScore(cell, role) {
  if (role === 'critic') {
    // Критик ценен умением ловить дефекты при умеренной цене раунда.
    return [
      cell.defect_catch_rate ?? 0,
      -(cell.avg_wall_ms ?? Number.MAX_SAFE_INTEGER),
      -(cell.token_efficiency ?? Number.MAX_SAFE_INTEGER),
    ];
  }
  return [
    cell.first_pass_rate ?? 0,
    -(cell.avg_rounds ?? Number.MAX_SAFE_INTEGER),
    -(cell.avg_wall_ms ?? Number.MAX_SAFE_INTEGER),
    -(cell.token_efficiency ?? Number.MAX_SAFE_INTEGER),
  ];
}

const cmpScore = (a, b) => {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

// Ранжирование кандидатов роли в клетке (domain,size). wildcard === true
// собирает клетки '*' и конкретные; только доказанные клетки ранжируются.
// Возврат — упорядоченный список { model, role, domain, size, cell, score }.
export function rankCandidates(scorecard, { role, domain = UNKNOWN, size = UNKNOWN,
  minObservations = DEFAULT_MIN_OBSERVATIONS, models = null } = {}) {
  if (!SCORE_ROLES.includes(role)) return [];
  const wanted = Array.isArray(models)
    ? new Set(models.map(modelKey).filter(k => k !== null)) : null;
  const out = [];
  for (const [id, cell] of Object.entries(scorecard?.cells ?? {})) {
    const [key, r, d, s] = id.split('|');
    if (r !== role) continue;
    if (d !== domain || s !== size) continue;
    if (wanted !== null && !wanted.has(key)) continue;
    if (!cellProven(cell, minObservations)) continue;
    const [provider, ...rest] = key.split('/');
    out.push({ model: { provider, model: rest.join('/') }, role, domain, size,
      cell, score: cellScore(cell, role) });
  }
  out.sort((a, b) => cmpScore(a.score, b.score) || (modelKey(a.model) < modelKey(b.model) ? -1 : 1));
  return out;
}

// Таблица скоркарда для владельца/CTO: по одной строке на клетку.
export function formatScorecardReport(scorecard) {
  const lines = [`Model scorecard: ${scorecard?.entries ?? 0} attempts, ` +
    `${Object.keys(scorecard?.cells ?? {}).length} cells, corrupt lines: ${scorecard?.corrupt ?? 0}`];
  const cells = Object.entries(scorecard?.cells ?? {});
  if (!cells.length) return lines.join('\n');
  lines.push('model | role | domain | size | n(seed) | first_pass | avg_rounds | ' +
    'avg_wall | tok/round | catch_rate');
  const fmt = (v, f) => v === null || v === undefined ? '-' : f(v);
  for (const [id, cell] of cells) {
    const [key, role, domain, size] = id.split('|');
    lines.push([
      key, role, domain, size,
      `${cell.observations}(${cell.seed_observations})`,
      fmt(cell.first_pass_rate, v => v.toFixed(2)),
      fmt(cell.avg_rounds, v => v.toFixed(2)),
      fmt(cell.avg_wall_ms, v => `${(v / 1000).toFixed(1)}s`),
      fmt(cell.token_efficiency, v => Math.round(v).toString()),
      fmt(cell.defect_catch_rate, v => v.toFixed(2)),
    ].join(' | '));
  }
  return lines.join('\n');
}
