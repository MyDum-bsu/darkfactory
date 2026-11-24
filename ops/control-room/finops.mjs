// FinOps provider Control Room — декларативный read-only реестр ресурсов,
// бюджетов, кредитов и карты рабочего пространства. Только Node stdlib + yaml.
// Любая ошибка конфигурации возвращает { ok:false, error }, но не роняет
// aggregator. Сам budget-файл symlink'ом быть не должен; symlink родительского
// каталога допустим (проверяется lstat конечного пути).

import { lstat, readFile, stat } from 'node:fs/promises';
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
    const n = Number(value.replace(/[€$\s]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
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
  return (await stat(userPath).catch(() => null))?.isFile() ? userPath : EXAMPLE_BUDGET_PATH;
}

async function readYamlFile(path) {
  const lst = await lstat(path);
  if (lst.isSymbolicLink()) throw new Error(`finops_budget_symlink_rejected: ${path}`);
  if (!lst.isFile()) throw new Error(`finops_budget_not_file: ${path}`);
  let parsed;
  try {
    parsed = parse(await readFile(path, 'utf8'));
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
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
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

function publicEntry(entry, extra = {}) {
  const out = {};
  for (const [key, value] of Object.entries({ ...entry, ...extra })) {
    if (typeof value === 'string') out[key] = clean(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || value == null) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map(item => typeof item === 'string' ? clean(item) : item);
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

function usageFor(vm, usage) {
  if (!isRecord(usage)) return null;
  const key = text(vm.usage_key ?? vm.id);
  const nested = isRecord(usage.vms) && key ? usage.vms[key] : null;
  const source = isRecord(nested) ? { ...usage, ...nested } : usage;
  const metered = vm.metered === true || key === 'cloud-bb-worker' || key === text(usage.vmId);
  if (!metered) return null;
  return {
    runningMinutesToday: Math.max(0, num(source.runningMinutesToday) ?? 0),
    runningMinutesMonth: Math.max(0, num(source.runningMinutesMonth) ?? 0),
    wakesMonth: Math.max(0, num(source.wakesMonth) ?? 0),
    updatedAt: iso(source.updatedAt) ?? null,
    state: text(source.state ?? source.status) ?? null,
  };
}

function daysInMonth(at) {
  const d = new Date(at);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

function normalize(raw, usage, sourcePath, at) {
  const alerts = [];
  const usdToEur = num(raw.usd_to_eur ?? raw.fx?.usd_to_eur) ?? 0.92;
  const monthlyBudgetEur = num(raw.monthly_budget_eur ?? raw.budgets?.monthly_eur) ?? null;
  const utilizationThresholdPct = num(raw.underutilized_below_pct ??
    raw.budgets?.utilization_alert_below_pct) ?? 5;

  const cloudCredits = entries(raw.cloud_credits).map((entry, index) => publicEntry(entry, {
    id: text(entry.id) ?? `credit-${index + 1}`,
    provider: text(entry.provider) ?? null,
    totalEur: num(entry.total_eur ?? entry.totalEur),
    remainingEur: num(entry.remaining_eur ?? entry.remainingEur),
    monthlyEur: num(entry.monthly_eur ?? entry.monthlyEur),
    expires: iso(entry.expires ?? entry.until),
    notes: text(entry.notes) ?? null,
  }));

  let spentMonthCostEur = 0;
  let spentTodayCostEur = 0;
  let runningMinutesMonth = 0;
  let runningMinutesToday = 0;
  const computeVms = entries(raw.compute_vms).map((entry, index) => {
    const id = text(entry.id) ?? `vm-${index + 1}`;
    const hourlyUsd = num(entry.hourly_cost_usd ?? entry.hourlyCostUsd);
    const hourlyEur = num(entry.hourly_cost_eur ?? entry.hourlyCostEur) ??
      (hourlyUsd == null ? 0 : hourlyUsd * usdToEur);
    const live = usageFor({ ...entry, id }, usage);
    const monthMinutes = live?.runningMinutesMonth ?? 0;
    const todayMinutes = live?.runningMinutesToday ?? 0;
    const monthCost = hourlyEur * monthMinutes / 60;
    const todayCost = hourlyEur * todayMinutes / 60;
    spentMonthCostEur += monthCost;
    spentTodayCostEur += todayCost;
    runningMinutesMonth += monthMinutes;
    runningMinutesToday += todayMinutes;
    return publicEntry(entry, {
      id,
      machineType: text(entry.machine_type ?? entry.machineType) ?? null,
      hourlyCostUsd: hourlyUsd,
      hourlyCostEur: Number(hourlyEur.toFixed(6)),
      pricing: text(entry.pricing ?? entry.price_note) ?? null,
      state: live?.state ?? text(entry.state) ?? null,
      runningMinutesToday: todayMinutes,
      runningMinutesMonth: monthMinutes,
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
  const remainingCreditsEur = cloudCredits.reduce((sum, credit) =>
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

  const workspaceLinks = flattenWorkspace(raw.workspace_links, alerts);
  const round2 = n => Number(n.toFixed(2));
  const totals = {
    currency: text(raw.currency) ?? 'EUR',
    usdToEur,
    monthlyBudgetEur,
    runningMinutesToday,
    runningMinutesMonth,
    runningHoursToday: Number((runningMinutesToday / 60).toFixed(2)),
    runningHoursMonth: Number((runningMinutesMonth / 60).toFixed(2)),
    spentTodayCostEur: Number(spentTodayCostEur.toFixed(4)),
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
    alerts: alerts.map(alert => ({ ...alert, message: clean(alert.message) })),
  };
}

export function createFinopsProvider({ budgetPath, workerUsagePath, workerStatePath, now } = {}) {
  return async () => {
    try {
      const at = nowMs(now);
      const resolved = await resolveBudgetPath(budgetPath);
      const usagePath = workerUsagePath ??
        join(stateHome(), 'darkfactory', 'cloud-worker-usage.json');
      const [raw, usageJournal, stateJournal] = await Promise.all([
        readYamlFile(resolved), readWorkerUsage(usagePath),
        readWorkerUsage(workerStatePath)]);
      const usage = usageJournal || stateJournal
        ? { ...(stateJournal ?? {}), ...(usageJournal ?? {}) } : null;
      return normalize(raw, usage, resolved, at);
    } catch (error) {
      return { ok: false, error: clean(error?.message ?? error ?? 'finops read failed') };
    }
  };
}
