// FinOps provider Control Room — декларативный read-only реестр ресурсов,
// бюджетов, кредитов и карты рабочего пространства. Только Node stdlib + yaml.
// Любая ошибка конфигурации возвращает { ok:false, error }, но не роняет
// aggregator. Сам budget-файл symlink'ом быть не должен; symlink родительского
// каталога допустим (проверяется lstat конечного пути).

import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { sanitizeTerminalText } from './origin-guard.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE_BUDGET_PATH = join(MODULE_DIR, '..', 'local', 'resources-budget.example.yaml');

const clean = value => sanitizeTerminalText(String(value ?? ''));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const num = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    let normalized = value.trim().replace(/[€$\s]/g, '');
    const commas = normalized.match(/,/g)?.length ?? 0;
    const dots = normalized.match(/\./g)?.length ?? 0;
    if (commas && dots) {
      normalized = normalized.lastIndexOf(',') > normalized.lastIndexOf('.')
        ? normalized.replace(/\./g, '').replace(',', '.')
        : normalized.replace(/,/g, '');
    } else if (commas === 1) {
      const parts = normalized.split(',');
      normalized = parts[1].length === 3 && /^\d+$/.test(parts[1])
        ? normalized.replace(',', '')
        : normalized.replace(',', '.');
    } else if (commas > 1) {
      if (!/^-?\d{1,3}(,\d{3})+$/.test(normalized)) return null;
      normalized = normalized.replace(/,/g, '');
    }
    if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const nonNegativeNum = value => {
  const n = num(value);
  return n !== null && n >= 0 ? n : null;
};
const text = value => typeof value === 'string' && value.trim() ? clean(value.trim()) : null;
const iso = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const s = text(value);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
};
const nowMs = now => {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return Date.now();
};

function configHome() {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}

function stateHome() {
  return process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
}

async function resolveBudgetPath(explicitPath) {
  if (typeof explicitPath === 'string' && explicitPath) return explicitPath;
  const userPath = join(configHome(), 'darkfactory', 'resources-budget.yaml');
  const lst = await lstat(userPath).catch(() => null);
  // Битый или живой symlink пользовательского файла — явная ошибка в
  // readYamlFile, а не тихий откат на example. Symlink родителя допустим.
  return lst?.isFile() || lst?.isSymbolicLink() ? userPath : EXAMPLE_BUDGET_PATH;
}

async function readYamlFile(path) {
  const lst = await lstat(path);
  if (lst.isSymbolicLink()) throw new Error(`finops_budget_symlink_rejected: ${path}`);
  if (!lst.isFile()) throw new Error(`finops_budget_not_file: ${path}`);
  if (lst.size > 256 * 1024) throw new Error(`finops_budget_too_large: ${path}`);
  let parsed;
  try {
    parsed = parse(await readFile(path, 'utf8'), { maxAliasCount: 0 });
  } catch (cause) {
    throw new Error(`finops_budget_yaml_invalid: ${path}`, { cause });
  }
  if (!isRecord(parsed)) throw new Error(`finops_budget_invalid: ${path}`);
  return parsed;
}

async function readWorkerUsage(path) {
  if (!path) return null;
  try {
    const lst = await lstat(path);
    if (lst.isSymbolicLink() || !lst.isFile() || lst.size > 256 * 1024) return null;
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null; // usage — необязательный живой журнал; отсутствие/битость не блокирует пульт.
  }
}

function entries(value) {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) {
    return Object.entries(value).map(([id, item]) =>
      isRecord(item) ? { id, ...item } : null).filter(Boolean);
  }
  return [];
}

// Public FinOps contract — explicit allowlist. YAML является декларативной
// конфигурацией, но не доверенным API-контрактом: произвольные ключи вроде
// api_key/billing_account никогда не копируются в snapshot.
const PUBLIC_FINOPS_ENTRY_KEYS = new Set([
  'id', 'label', 'provider', 'totalEur', 'remainingEur', 'monthlyEur', 'usedMonthEur', 'expires', 'notes',
  'machineType', 'hourlyCostUsd', 'hourlyCostEur', 'pricing', 'state',
  'runningMinutesToday', 'runningMinutesMonth', 'activeMinutesToday', 'wakesMonth',
  'usageUpdatedAt', 'costTodayEur', 'costMonthEur', 'source', 'activeTasks', 'activeSlots', 'claimedTasks',
  'unit', 'totalUnits', 'usedUnits', 'utilizationPct', 'status',
  'model', 'quota', 'reset',
]);

// The public contract is scalar: every key above accepts ONLY primitive
// values — strings terminal-sanitized, numbers/booleans/null verbatim.
// Plain objects are never forwarded, and arrays in a scalar field such as
// `label` or `status` are rejected wholesale: the key is omitted from the
// public entry rather than coerced. No array-typed key exists in the
// contract today; when one is introduced it must be registered explicitly
// in PUBLIC_FINOPS_ENTRY_ARRAY_KEYS — arrays are accepted only on those
// keys, and even there only primitive items survive (strings sanitized),
// so nested objects/arrays can never leak into the public snapshot.
const PUBLIC_FINOPS_ENTRY_ARRAY_KEYS = new Set([]);
const isForwardablePrimitive = value =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

function publicEntry(entry, extra = {}) {
  const out = {};
  for (const [key, value] of Object.entries({ ...entry, ...extra })) {
    if (!PUBLIC_FINOPS_ENTRY_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      if (!PUBLIC_FINOPS_ENTRY_ARRAY_KEYS.has(key)) continue;
      out[key] = value
        .filter(isForwardablePrimitive)
        .map(item => typeof item === 'string' ? clean(item) : item);
    } else if (typeof value === 'string') {
      out[key] = clean(value);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
      out[key] = value;
    }
  }
  return out;
}

function validHttpUrl(value) {
  const s = text(value);
  if (!s) return null;
  try {
    const url = new URL(s);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function flattenWorkspace(raw, alerts, group = null) {
  const result = [];
  const pushEntry = (id, entry, inheritedGroup) => {
    if (!isRecord(entry)) return;
    const urlRaw = entry.url ?? entry.href ?? null;
    const url = urlRaw == null ? null : validHttpUrl(urlRaw);
    if (urlRaw != null && url === null) {
      alerts.push({ severity: 'warn', code: 'workspace_link_rejected',
        resourceId: clean(id), message: `workspace link rejected: ${clean(id)}` });
    }
    result.push({
      id: clean(id),
      group: clean(entry.group ?? inheritedGroup ?? 'workspace'),
      title: text(entry.title ?? entry.name ?? id) ?? clean(id),
      url,
      path: text(entry.path) ?? null,
      command: text(entry.command) ?? null,
      notes: text(entry.notes) ?? null,
    });
  };
  if (Array.isArray(raw)) {
    raw.forEach((entry, index) => pushEntry(entry.id ?? entry.name ?? `link-${index + 1}`, entry, group));
  } else if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (isRecord(value) && (value.url || value.href || value.path || value.command)) {
        pushEntry(key, { group: group ?? key, ...value }, group);
      } else if (Array.isArray(value) || isRecord(value)) {
        result.push(...flattenWorkspace(value, alerts, key));
      }
    }
  }
  return result;
}

const meteredVm = vm => vm.metered === true || text(vm.usage_key ?? vm.id) === 'cloud-bb-worker';

function usageFor(vm, usage, { allowRootUsage = true } = {}) {
  if (!isRecord(usage)) return null;
  const key = text(vm.usage_key ?? vm.id);
  const nested = isRecord(usage.vms) && key ? usage.vms[key] : null;
  const explicitRoot = key === text(usage.vmId);
  const metered = meteredVm(vm) || explicitRoot || isRecord(nested);
  if (!metered) return null;
  // Плоский корневой usage относится к одной машине. При нескольких metered
  // VM он применяется только к явно названной (vmId/вложенный ключ); иначе
  // одни и те же минуты были бы посчитаны несколько раз.
  if (!nested && !explicitRoot && (!allowRootUsage || usage.vmId || usage.vms)) return null;
  const source = isRecord(nested) ? nested : usage;
  if (!['runningMinutesToday', 'runningMinutesMonth', 'activeMinutesToday', 'activeMinutes', 'state', 'status',
    'activeTasks', 'activeSlots', 'claimedTasks', 'wakesMonth'].some(k => source[k] != null)) return null;
  return {
    runningMinutesToday: nonNegativeNum(source.runningMinutesToday),
    runningMinutesMonth: Math.max(0, num(source.runningMinutesMonth) ?? 0),
    activeMinutesToday: nonNegativeNum(source.activeMinutesToday ?? source.activeMinutes),
    activeSlots: nonNegativeNum(source.activeSlots),
    activeTasks: nonNegativeNum(source.activeTasks),
    claimedTasks: nonNegativeNum(source.claimedTasks),
    wakesMonth: Math.max(0, num(source.wakesMonth) ?? 0),
    updatedAt: iso(source.updatedAt) ?? null,
    state: text(source.state ?? source.status) ?? null,
  };
}

function journalTimeMs(value) {
  const raw = value?.updatedAt ?? value?.updated_at;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function mergeUsageJournals(stateJournal, usageJournal) {
  const journals = [stateJournal, usageJournal].filter(isRecord);
  if (!journals.length) return null;
  if (journals.length === 1) return journals[0];
  const stateMs = journalTimeMs(stateJournal);
  const usageMs = journalTimeMs(usageJournal);
  const stateIsFresher = (stateMs ?? -Infinity) > (usageMs ?? -Infinity);
  const older = stateIsFresher ? usageJournal : stateJournal;
  const fresher = stateIsFresher ? stateJournal : usageJournal;
  const olderMs = stateIsFresher ? usageMs : stateMs;
  const fresherMs = stateIsFresher ? stateMs : usageMs;
  const merged = { ...older, ...fresher };
  if (isRecord(older.vms) && isRecord(fresher.vms)) {
    const vms = { ...older.vms };
    for (const [id, freshEntry] of Object.entries(fresher.vms)) {
      const oldEntry = vms[id];
      if (isRecord(oldEntry) && isRecord(freshEntry)) {
        const oldAt = journalTimeMs(oldEntry) ?? olderMs ?? -Infinity;
        const freshAt = journalTimeMs(freshEntry) ?? fresherMs ?? -Infinity;
        vms[id] = freshAt >= oldAt ? freshEntry : oldEntry;
      } else {
        vms[id] = freshEntry;
      }
    }
    merged.vms = vms;
  }
  return merged;
}

function daysInMonth(at) {
  const d = new Date(at);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

// --- Spend Dynamics & Dead-Load Detector --------------------------------------
//
// Чистые детерминированные функции: вход — уже нормализованные записи VM и
// журнал usage, выход — timeseries расхода и флаги мёртвой нагрузки.
// Ноль работы — наблюдение; отсутствие счётчиков не равно нулю.

const round2 = n => Number(n.toFixed(2));
const round4 = n => Number(n.toFixed(4));

export function analyzeDeadLoad({ vmUsage, activeTasks = null, claimedTasks = null, activeSlots = null,
  idleMinutesSinceLastTask = 0, deadLoadThresholdMinutes = 20 } = {}) {
  activeTasks = nonNegativeNum(activeTasks);
  claimedTasks = nonNegativeNum(claimedTasks);
  idleMinutesSinceLastTask = Math.max(0, num(idleMinutesSinceLastTask) ?? 0);
  deadLoadThresholdMinutes = Math.max(0, num(deadLoadThresholdMinutes) ?? 20);
  const vms = (Array.isArray(vmUsage) ? vmUsage : []).filter(isRecord).map(entry => {
    const runningMinutes = Math.max(0, num(entry.runningMinutesToday ??
      entry.runningMinutes) ?? 0);
    const activeMinutes = Math.min(runningMinutes,
      Math.max(0, num(entry.activeMinutesToday ?? entry.activeMinutes) ?? 0));
    const explicitIdle = nonNegativeNum(entry.idleMinutesToday ?? entry.idleMinutes);
    const idleMinutes = explicitIdle ?? Math.max(0, runningMinutes - activeMinutes);
    const idleWastePct = runningMinutes > 0 ? round4(idleMinutes / runningMinutes * 100) : 0;
    const running = typeof entry.state === 'string' && entry.state.trim().toLowerCase() === 'running';
    const counts = [entry.activeSlots ?? activeSlots, entry.activeTasks ?? activeTasks,
      entry.claimedTasks ?? claimedTasks].map(nonNegativeNum).filter(n => n !== null);
    const noWork = counts.every(n => n === 0) &&
      [entry.activeSlots ?? activeSlots, entry.activeTasks ?? activeTasks].some(n => nonNegativeNum(n) === 0);
    const idleObserved = !counts.length && idleMinutesSinceLastTask > 0 && idleMinutesSinceLastTask >= deadLoadThresholdMinutes;
    const unusedToday = runningMinutes > 30 && nonNegativeNum(entry.activeMinutesToday ?? entry.activeMinutes) === 0;
    const deadLoad = entry.source !== 'static' && (unusedToday || (running && (noWork || idleObserved)));
    return {
      id: clean(entry.id ?? ''),
      state: text(entry.state) ?? null,
      pricing: text(entry.pricing) ?? null,
      runningMinutes: round4(runningMinutes),
      activeMinutes: round4(activeMinutes),
      idleMinutes: round4(idleMinutes),
      idleWastePct,
      deadLoad, unusedToday,
    };
  });
  const alerts = [];
  for (const vm of vms) {
    if (!vm.deadLoad) continue;
    alerts.push({ severity: 'bad', code: 'dead_load_detected', resourceId: vm.id,
      message: vm.unusedToday ? `${vm.id}: ${vm.runningMinutes} running minutes today, zero active minutes`
        : `${vm.id}: running idle without active slots/tasks` });
  }
  const totalRunning = vms.reduce((sum, vm) => sum + vm.runningMinutes, 0);
  const totalIdle = vms.reduce((sum, vm) => sum + vm.idleMinutes, 0);
  return {
    vms,
    alerts,
    deadLoadDetected: vms.some(vm => vm.deadLoad),
    idleWastePct: totalRunning > 0 ? round4(totalIdle / totalRunning * 100) : 0,
    activeTasks,
    claimedTasks,
    idleMinutesSinceLastTask,
    thresholdMinutes: deadLoadThresholdMinutes,
  };
}

// dailyHistory — завершённые дни текущего месяца (числа EUR или записи
// { date, eur }); todayEur — частичный расход сегодня. Проекция повторяет
// модель normalize(): средний расход за истёкшие дни × daysInMonth.
// Тренд сравнивает среднее первой и второй половин ряда с зоной ±10%.
export function buildSpendDynamics({ dailyHistory = [], todayEur = 0,
  monthlyTargetEur = 25, dayOfMonth = 1, daysInMonth = 30,
  spentMonthCostEur = null, projectedMonthCostEur = null } = {}) {
  const daily = [];
  for (const entry of Array.isArray(dailyHistory) ? dailyHistory : []) {
    const eur = nonNegativeNum(isRecord(entry) ? entry.eur ?? entry.costEur ?? entry.amount : entry);
    if (eur === null) continue;
    daily.push({ date: isRecord(entry) ? text(entry.date ?? entry.day) ?? null : null,
      eur: round4(eur) });
  }
  const hasDailyHistory = daily.length > 0;
  const today = nonNegativeNum(todayEur) ?? 0;
  daily.push({ date: null, eur: round4(today), today: true });

  const elapsed = Math.max(1, num(dayOfMonth) ?? 1);
  const span = Math.max(1, num(daysInMonth) ?? 30);
  const observedTotalEur = daily.reduce((sum, point) => sum + point.eur, 0);
  let totalEur = observedTotalEur;
  let projected = null;
  if (!hasDailyHistory) {
    // Пустой journal daily history не означает нулевой месяц: у агрегатора
    // уже есть фактическая месячная стоимость и честная проекция из totals.
    const spentFallback = nonNegativeNum(spentMonthCostEur);
    const projectedFallback = nonNegativeNum(projectedMonthCostEur);
    if (spentFallback !== null) totalEur = spentFallback;
    if (projectedFallback !== null) projected = projectedFallback;
  }
  const avgDaily = totalEur / elapsed;
  if (projected === null) projected = avgDaily * span;
  const target = nonNegativeNum(monthlyTargetEur) ?? 25;

  let trend = 'stable';
  if (daily.length >= 2) {
    const mid = Math.floor(daily.length / 2);
    const firstHalf = daily.slice(0, mid);
    const secondHalf = daily.slice(mid);
    const mean = list => list.reduce((sum, point) => sum + point.eur, 0) / list.length;
    const firstMean = mean(firstHalf);
    const secondMean = mean(secondHalf);
    if (firstMean === 0) {
      if (secondMean > 0) trend = 'rising';
    } else if (secondMean > firstMean * 1.1) {
      trend = 'rising';
    } else if (secondMean < firstMean * 0.9) {
      trend = 'falling';
    }
  }

  const projectedMonthEur = Number(projected.toFixed(2));
  return {
    daily,
    avgDailyEur: round4(avgDaily),
    projectedMonthEur,
    targetEur: target,
    overTarget: projectedMonthEur > target,
    trend,
  };
}

// Read only the bounded tail of the optional append-only journal. A torn
// last write, oversized line or rotated/missing journal is an observation gap.
async function readHistory(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch(() => null);
  if (!fd) return [];
  try {
    const st = await fd.stat();
    if (!st.isFile()) return [];
    const start = Math.max(0, st.size - 2 * 1024 * 1024);
    const buf = Buffer.alloc(st.size - start);
    const { bytesRead } = await fd.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8', 0, bytesRead).split('\n');
    if (start) lines.shift();
    const rows = [];
    for (const line of lines) {
      try { const row = JSON.parse(line); if (isRecord(row)) rows.push(row); } catch { /* partial row */ }
    }
    return rows;
  } catch { return []; } finally { await fd.close(); }
}

const DAY_MS = 86400000;
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

// Rows describe bucket TOTALS, not deltas: a repeated sample replaces its
// bucket. Timestamped eur rows are hourly; spentTodayCostEur is cumulative
// for that UTC day. An explicit daily total supersedes the sum of its hours.
function spendSeries(history, dailyHistory, todayEstimate, at) {
  const today = utcDay(at), midnight = Date.parse(today);
  const days = new Map(), hours = new Map();
  function put(row) {
    const stamp = row?.date ?? row?.day ?? row?.hour ?? row?.ts ?? row?.updatedAt;
    if (typeof stamp !== 'string' || !/^\d{4}-\d\d-\d\d(?:T|$)/.test(stamp)) return;
    const ms = Date.parse(stamp);
    const cumulative = row.spentTodayCostEur ?? row.totals?.spentTodayCostEur;
    const eur = nonNegativeNum(cumulative ?? row.eur ?? row.costEur ?? row.amount);
    if (!Number.isFinite(ms) || ms > at || eur === null) return;
    if (stamp.length === 10 || cumulative != null || row.granularity === 'daily') days.set(utcDay(ms), eur);
    else hours.set(new Date(ms).toISOString().slice(0, 13) + ':00:00Z', eur);
  }
  dailyHistory.forEach((row, i) => put(isRecord(row) ? row : {
    date: utcDay(midnight - (dailyHistory.length - i) * DAY_MS), eur: row }));
  history.forEach(put);
  const totals = new Map();
  const hourly = [...hours].sort(([a], [b]) => a.localeCompare(b)).map(([date, eur]) => {
    const day = date.slice(0, 10);
    totals.set(day, (totals.get(day) ?? 0) + eur);
    return { date, eur: round4(eur) };
  });
  for (const [day, total] of days) totals.set(day, total);
  if (!totals.has(today) && todayEstimate != null) totals.set(today, todayEstimate);
  // Missing days aren't observations of zero spend. Exclude the current
  // day, even when it already has a partial daily snapshot.
  const baseline = date => {
    const ms = Date.parse(date), prior = [];
    for (let i = 1; i <= 7; i++) {
      const n = totals.get(utcDay(ms - i * DAY_MS));
      if (n !== undefined) prior.push(n);
    }
    return prior.length ? prior.reduce((sum, n) => sum + n, 0) / prior.length : null;
  };
  const series = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([date, eur]) => {
    const avg = baseline(date);
    return { date, eur: round4(eur), baseline7dEur: avg === null ? null : round4(avg),
      burnRatio: avg > 0 ? round4(eur / avg) : null };
  });
  const base = baseline(today), current = totals.get(today);
  return { series, hourly, baseline7dEur: base === null ? null : round4(base),
    burnRatio: base > 0 && current != null ? round4(current / base) : null,
    spike: base !== null && current > 2 * base };
}

// Monthly usage accepts per-service summaries or service-tagged cost rows.
// Prefer the summary for a service when both representations are supplied.
function aiMonthlySpend(usage, at) {
  const month = utcDay(at).slice(0, 7);
  const tagged = entries(usage?.services ?? usage?.entries);
  const groups = [
    [usage?.vertexAi ?? usage?.vertexAI ?? usage?.vertex_ai, 'vertex'],
    [usage?.embeddings ?? usage?.embedding, 'embedding'],
  ];
  const category = row => {
    const name = row.service ?? row.id ?? '';
    return /embedding/i.test(name) ? 'embedding' : /vertex/i.test(name) ? 'vertex' : null;
  };
  let total = 0;
  for (const [summary, service] of groups) {
    const rows = summary == null ? tagged.filter(row => category(row) === service)
      : Array.isArray(summary) ? summary : [summary];
    for (const row of rows) {
      const period = row?.month ?? row?.date ?? row?.ts ?? usage?.month;
      if (period && String(period).slice(0, 7) !== month) continue;
      total += nonNegativeNum(row?.costMonthEur ?? row?.costEur ?? row?.eur) ?? 0;
    }
  }
  return total;
}

function monthlyCreditBalances(rawCredits, spentMonthCostEur) {
  const credits = entries(rawCredits).map((entry, index) => publicEntry(entry, {
    id: text(entry.id) ?? `credit-${index + 1}`,
    provider: text(entry.provider) ?? null,
    totalEur: num(entry.total_eur ?? entry.totalEur),
    remainingEur: num(entry.remaining_eur ?? entry.remainingEur),
    monthlyEur: num(entry.monthly_eur ?? entry.monthlyEur),
    usedMonthEur: 0,
    source: 'static',
    expires: iso(entry.expires ?? entry.until),
    notes: text(entry.notes) ?? null,
  }));

  let remainingSpendToCover = spentMonthCostEur;
  function draw(credit, allowance) {
    if (!(remainingSpendToCover > 0)) return;
    const baseRemaining = credit.remainingEur ?? allowance;
    const used = Math.min(Math.max(0, baseRemaining), remainingSpendToCover);
    credit.remainingEur = round2(Math.max(0, baseRemaining - used));
    credit.usedMonthEur = round2(used);
    if (used > 0) credit.source = 'estimated';
    remainingSpendToCover -= used;
  }

  // Allocate recurring credit first, without reordering the public snapshot.
  for (const credit of credits) {
    if (credit.monthlyEur > 0) draw(credit, credit.monthlyEur);
  }
  for (const credit of credits) {
    if (credit.totalEur > 0 && !credit.monthlyEur) draw(credit, credit.totalEur);
  }
  return credits;
}

function normalize(raw, usage, sourcePath, at, history) {
  const alerts = [];
  const usdToEur = nonNegativeNum(raw.usd_to_eur ?? raw.fx?.usd_to_eur) ?? 0.92;
  const monthlyBudgetEur = num(raw.monthly_budget_eur ?? raw.budgets?.monthly_eur) ?? null;
  const utilizationThresholdPct = num(raw.underutilized_below_pct ??
    raw.budgets?.utilization_alert_below_pct) ?? 5;

  let spentMonthCostEur = aiMonthlySpend(usage, at);
  let spentTodayCostEur = 0;
  let observedTodaySpend = false;
  let runningMinutesMonth = 0;
  let runningMinutesToday = 0;
  const vmEntries = entries(raw.compute_vms);
  const known = new Set(vmEntries.map(vm => text(vm.usage_key ?? vm.id)));
  for (const [id, sample] of Object.entries(isRecord(usage?.vms) ? usage.vms : {})) {
    if (!known.has(id) && isRecord(sample)) vmEntries.push({ id });
  }
  const meteredCount = vmEntries.filter(meteredVm).length;
  const computeVms = vmEntries.map((entry, index) => {
    const id = text(entry.id) ?? `vm-${index + 1}`;
    const rawHourlyUsd = entry.hourly_cost_usd ?? entry.hourlyCostUsd;
    const rawHourlyEur = entry.hourly_cost_eur ?? entry.hourlyCostEur;
    const hourlyUsd = nonNegativeNum(rawHourlyUsd);
    const parsedHourlyEur = nonNegativeNum(rawHourlyEur);
    if ((rawHourlyUsd != null && hourlyUsd === null) ||
        (rawHourlyEur != null && parsedHourlyEur === null)) {
      alerts.push({ severity: 'warn', code: 'invalid_config_value', resourceId: id,
        message: `${id}: negative or malformed hourly rate rejected` });
    }
    const hourlyEur = parsedHourlyEur ??
      (hourlyUsd == null ? 0 : hourlyUsd * usdToEur);
    const live = usageFor({ ...entry, id }, usage,
      { allowRootUsage: meteredCount <= 1 });
    const monthMinutes = live?.runningMinutesMonth ?? 0;
    const todayMinutes = live?.runningMinutesToday ?? 0;
    if (live?.runningMinutesToday != null && (parsedHourlyEur !== null || hourlyUsd !== null)) observedTodaySpend = true;
    const monthCost = hourlyEur * monthMinutes / 60;
    const todayCost = hourlyEur * todayMinutes / 60;
    spentMonthCostEur += monthCost;
    spentTodayCostEur += todayCost;
    runningMinutesMonth += monthMinutes;
    runningMinutesToday += todayMinutes;
    const state = live?.state ?? text(entry.state);
    const stopped = /^(stopped|terminated|suspended|stopping)$/i.test(state ?? '');
    const pricing = text(entry.pricing ?? entry.price_note);
    return publicEntry(entry, {
      id,
      source: live ? 'metered' : 'static',
      activeTasks: live?.activeTasks ?? null, activeSlots: live?.activeSlots ?? null,
      claimedTasks: live?.claimedTasks ?? null,
      machineType: text(entry.machine_type ?? entry.machineType) ?? null,
      hourlyCostUsd: hourlyUsd,
      hourlyCostEur: Number(hourlyEur.toFixed(6)),
      pricing: stopped && /(?:\/\s*h|per hour)/i.test(pricing ?? '') ? null : pricing,
      state,
      runningMinutesToday: todayMinutes,
      runningMinutesMonth: monthMinutes,
      activeMinutesToday: live?.activeMinutesToday ?? null,
      wakesMonth: live?.wakesMonth ?? 0,
      usageUpdatedAt: live?.updatedAt ?? null,
      costTodayEur: Number(todayCost.toFixed(4)),
      costMonthEur: Number(monthCost.toFixed(4)),
      notes: text(entry.notes) ?? null,
    });
  });

  const computeQuotas = entries(raw.compute_quotas).map((entry, index) => {
    const id = text(entry.id) ?? `quota-${index + 1}`;
    const totalTib = num(entry.total_tib ?? entry.totalTib);
    const usedGib = num(entry.used_gib ?? entry.usedGib);
    const total = num(entry.total_units ?? entry.totalUnits) ?? totalTib;
    const usedRaw = num(entry.used_units ?? entry.usedUnits);
    const used = usedGib != null && totalTib != null ? usedGib / 1024 : usedRaw;
    const pct = num(entry.utilization_pct ?? entry.utilizationPct) ??
      (total && used != null ? (used / total) * 100 : null);
    const explicit = text(entry.status)?.toLowerCase();
    const trackUtilization = entry.track_utilization !== false;
    const underutilized = explicit === 'underutilized' ||
      (trackUtilization && total != null && total > 0 && pct != null && pct < utilizationThresholdPct);
    if (underutilized) {
      alerts.push({ severity: 'warn', code: 'underutilized_resource', resourceId: id,
        message: `${id}: использовано ${pct == null ? '—' : pct.toFixed(1)}% при доступном лимите` });
    }
    return publicEntry(entry, {
      id,
      label: text(entry.label ?? entry.name ?? id) ?? id,
      unit: text(entry.unit) ?? null,
      totalUnits: total,
      usedUnits: used,
      utilizationPct: pct == null ? null : Number(pct.toFixed(2)),
      status: underutilized ? 'underutilized' : explicit ?? 'ok',
      notes: text(entry.notes) ?? null,
    });
  });

  const aiSubscriptions = entries(raw.ai_subscriptions).map((entry, index) => publicEntry(entry, {
    id: text(entry.id) ?? `subscription-${index + 1}`,
    label: text(entry.label ?? entry.name ?? entry.model ?? entry.id) ?? `subscription-${index + 1}`,
    model: text(entry.model) ?? null,
    status: text(entry.status) ?? 'active',
    quota: text(entry.quota) ?? null,
    reset: iso(entry.reset ?? entry.until),
    notes: text(entry.notes) ?? null,
  }));

  const dim = daysInMonth(at);
  const elapsedDays = Math.max(1, new Date(at).getUTCDate());
  const projectedMonthCostEur = spentMonthCostEur / elapsedDays * dim;
  const dailyBurnEur = projectedMonthCostEur / dim;
  const cloudCredits = monthlyCreditBalances(raw.cloud_credits, spentMonthCostEur);
  // A provider-reported balance is already net of usage. Never apply the
  // estimate again, and never let a source label in YAML assert metering.
  const balances = new Map(entries(usage?.cloudCredits).map(c => [text(c.id), nonNegativeNum(c.remainingEur)]));
  for (const credit of cloudCredits) {
    const balance = balances.get(credit.id);
    if (balance != null) { credit.source = 'metered'; credit.remainingEur = balance; }
  }
  const activeCredits = cloudCredits.filter(credit =>
    !credit.expires || Date.parse(credit.expires) >= at);
  const remainingCreditsEur = activeCredits.reduce((sum, credit) =>
    sum + (credit.remainingEur ?? 0), 0);

  for (const credit of cloudCredits) {
    if (!credit.expires) continue;
    const days = Math.ceil((Date.parse(credit.expires) - at) / 86_400_000);
    if (days < 0) {
      alerts.push({ severity: 'bad', code: 'credit_expired', resourceId: credit.id,
        message: `${credit.id}: срок действия истёк` });
    } else if (days <= 30) {
      alerts.push({ severity: 'warn', code: 'credit_expiring', resourceId: credit.id,
        message: `${credit.id}: истекает через ${days} дн.` });
    }
  }
  if (monthlyBudgetEur != null && monthlyBudgetEur > 0 &&
      projectedMonthCostEur > monthlyBudgetEur) {
    alerts.push({ severity: 'bad', code: 'budget_exceeded_projection', resourceId: 'monthly_budget',
      message: `прогноз расхода €${projectedMonthCostEur.toFixed(2)} выше бюджета €${monthlyBudgetEur.toFixed(2)}` });
  } else if (monthlyBudgetEur != null && monthlyBudgetEur > 0 &&
      projectedMonthCostEur > monthlyBudgetEur * 0.8) {
    alerts.push({ severity: 'warn', code: 'budget_threshold', resourceId: 'monthly_budget',
      message: `прогноз расхода превышает 80% месячного бюджета` });
  }

  // Spend Dynamics & Dead-Load: живые счётчики задач и простой читаются из
  // usage/state журнала (приоритет) или явных полей бюджета; порог — из
  // dead_load_threshold_minutes. Алерты dead_load_detected входят в общий
  // alerts[] наряду с кредитами и бюджетом.
  const journalNumber = (...keys) => {
    for (const key of keys) {
      const value = nonNegativeNum(usage?.[key]);
      if (value !== null) return value;
    }
    return null;
  };
  const deadLoadAnalysis = analyzeDeadLoad({
    vmUsage: computeVms,
    activeSlots: journalNumber('activeSlots', 'active_slots'),
    activeTasks: journalNumber('activeTasks', 'active_tasks') ?? nonNegativeNum(raw.active_tasks),
    claimedTasks: journalNumber('claimedTasks', 'claimed_tasks') ?? nonNegativeNum(raw.claimed_tasks),
    idleMinutesSinceLastTask: journalNumber('idleMinutesSinceLastTask',
      'idle_minutes_since_last_task', 'idleMinutes') ?? 0,
    deadLoadThresholdMinutes: nonNegativeNum(raw.dead_load_threshold_minutes) ?? 20,
  });
  alerts.push(...deadLoadAnalysis.alerts);
  const { alerts: _deadLoadAlerts, ...deadLoad } = deadLoadAnalysis;

  const dailyHistoryRaw = usage?.dailySpendEur ?? usage?.daily_history ??
    raw.spend_daily_eur ?? raw.daily_history ?? [];
  const hourlyHistory = Array.isArray(usage?.hourlySpendEur) ? usage.hourlySpendEur : [];
  const snapshots = Array.isArray(usage?.snapshots) ? usage.snapshots : [];
  const { spike, ...dynamics } = spendSeries([...hourlyHistory, ...snapshots, ...history],
    Array.isArray(dailyHistoryRaw) ? dailyHistoryRaw : [],
    nonNegativeNum(usage?.spentTodayCostEur) ?? (observedTodaySpend ? spentTodayCostEur : null), at);
  const today = utcDay(at);
  const todayEur = dynamics.series.find(p => p.date === today)?.eur ?? spentTodayCostEur;
  const spendDynamics = { ...dynamics, ...buildSpendDynamics({
    dailyHistory: dynamics.series.filter(p => p.date !== today && p.date.startsWith(today.slice(0, 7))),
    todayEur,
    monthlyTargetEur: monthlyBudgetEur ?? 25,
    dayOfMonth: elapsedDays,
    daysInMonth: dim,
    spentMonthCostEur,
    projectedMonthCostEur,
  }) };
  const deadLoads = [...deadLoadAnalysis.alerts];
  if (spike) {
    const alert = { severity: 'bad', code: 'spend_spike', resourceId: 'daily_spend',
      message: `Daily spend exceeds twice the trailing 7-day baseline (€${dynamics.baseline7dEur})` };
    deadLoads.push(alert);
    alerts.push(alert);
  }

  const workspaceLinks = flattenWorkspace(raw.workspace_links, alerts);
  const totals = {
    currency: text(raw.currency) ?? 'EUR',
    usdToEur,
    monthlyBudgetEur,
    runningMinutesToday,
    runningMinutesMonth,
    runningHoursToday: Number((runningMinutesToday / 60).toFixed(2)),
    runningHoursMonth: Number((runningMinutesMonth / 60).toFixed(2)),
    spentTodayCostEur: round4(todayEur),
    spentMonthCostEur: Number(spentMonthCostEur.toFixed(4)),
    estimatedMonthCostEur: Number(spentMonthCostEur.toFixed(4)),
    projectedMonthCostEur: round2(projectedMonthCostEur),
    remainingCreditsEur: round2(remainingCreditsEur),
  };
  const creditRunway = {
    days: dailyBurnEur > 0 ? Math.floor(remainingCreditsEur / dailyBurnEur) : null,
    remainingCreditsEur: round2(remainingCreditsEur),
    dailyBurnEur: Number(dailyBurnEur.toFixed(4)),
  };

  return {
    ok: true,
    sourcePath: clean(basename(sourcePath)),
    generatedAt: new Date(at).toISOString(),
    cloudCredits,
    computeVms,
    computeQuotas,
    aiSubscriptions,
    workspaceLinks,
    totals,
    estimatedMonthCostEur: totals.estimatedMonthCostEur,
    creditRunway,
    spendDynamics,
    deadLoads,
    deadLoad,
    alerts: alerts.map(alert => ({ ...alert, message: clean(alert.message) })),
  };
}

export function createFinopsProvider({ budgetPath, workerUsagePath, workerStatePath, historyPath, now } = {}) {
  return async () => {
    try {
      const at = nowMs(now);
      const resolved = await resolveBudgetPath(budgetPath);
      const usagePath = workerUsagePath ??
        join(stateHome(), 'darkfactory', 'cloud-worker-usage.json');
      const [raw, usageJournal, stateJournal, history] = await Promise.all([
        readYamlFile(resolved), readWorkerUsage(usagePath),
        readWorkerUsage(workerStatePath), readHistory(historyPath ?? join(dirname(usagePath), 'finops-history.ndjson'))]);
      const usage = mergeUsageJournals(stateJournal, usageJournal);
      return normalize(raw, usage, resolved, at, history);
    } catch (error) {
      return { ok: false, error: clean(error?.message ?? error ?? 'finops read failed') };
    }
  };
}
