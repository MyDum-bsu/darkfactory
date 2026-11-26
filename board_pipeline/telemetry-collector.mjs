#!/usr/bin/env node
// VS-4.4 Unified Multi-Project Telemetry Collector & Trend Snapshots (#1268).
// Расширяет board_pipeline/telemetry.mjs до 4 уровней метрик (портфель,
// проект/канал, отдельная карточка, модели/провайдеры), снимков с историей
// history.jsonl, честного trend diff (null-safe) и автономного HTML-дашборда
// без внешних зависимостей и CDN.

import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import {
  computeMedian,
  normalizeCost,
  normalizeUsage,
  parseTelemetryLines,
  readTelemetryLines,
  sumCosts,
  sumUsages,
  TELEMETRY_SCHEMA,
  threadUsage,
} from './telemetry.mjs';

const execFileAsync = promisify(execFile);

export const COLLECTOR_SCHEMA = 1;
export const HISTORY_SCHEMA = 1;
export const DEFAULT_HISTORY_FILE = 'history.jsonl';

const ROLES = ['worker', 'critic', 'arbiter'];
const CLOSED_STATUSES = new Set([
  'done', 'completed', 'closed', 'verified', 'deployed', 'merged', 'resolved',
]);
const SUCCESS_OUTCOMES = new Set([
  'done', 'completed', 'verified', 'deployed', 'merged', 'resolved', 'pass', 'success',
]);
const FAILURE_STATUSES = new Set([
  'error', 'failed', 'crashed', 'provider_error', 'timeout', 'aborted',
]);
const PROVIDER_FAILURE_REASON_RE =
  /(provider|timeout|rate_limit|quota|unavailable|crash|spawn_failed|review_failed|review_error|critic_failed|arbiter_failed|model_error|api_error)/i;
const SAFE_DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T_-][0-9]{2}-[0-9]{2}-[0-9]{2})?$/;
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+$/;
const SNAPSHOT_FILE_RE = /^snapshot-(\d{4}-\d{2}-\d{2}(?:[T_-]\d{2}-\d{2}-\d{2})?)(?:-(\d+))?\.json$/;

export function compareSnapshotFilenames(a, b) {
  const ma = SNAPSHOT_FILE_RE.exec(a);
  const mb = SNAPSHOT_FILE_RE.exec(b);
  if (ma && mb) {
    if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
    const seqA = ma[2] ? Number.parseInt(ma[2], 10) : 1;
    const seqB = mb[2] ? Number.parseInt(mb[2], 10) : 1;
    if (seqA !== seqB) return seqA - seqB;
  }
  return a < b ? -1 : (a > b ? 1 : 0);
}

function attemptTimestampMs(entry) {
  for (const key of ['finished_at', 'ended_at', 'completed_at', 'updated_at', 'started_at', 'created_at']) {
    const raw = entry?.[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) {
      const ts = Date.parse(raw);
      if (Number.isFinite(ts)) return ts;
    }
  }
  return null;
}

const finiteNonNeg = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function isClosedStatus(status) {
  return typeof status === 'string' && CLOSED_STATUSES.has(status.trim().toLowerCase());
}

function isSuccessOutcome(status) {
  return typeof status === 'string' && SUCCESS_OUTCOMES.has(status.trim().toLowerCase());
}

function normalizeStatus(raw) {
  if (typeof raw !== 'string') return 'unknown';
  const trimmed = raw.trim().toLowerCase();
  return trimmed || 'unknown';
}

function normalizeChannel(raw) {
  if (typeof raw !== 'string') return 'unassigned';
  const trimmed = raw.trim();
  return trimmed || 'unassigned';
}

export function normalizeModelSpec(raw) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const slash = trimmed.indexOf('/');
    if (slash > 0 && slash < trimmed.length - 1) {
      const provider = trimmed.slice(0, slash);
      const model = trimmed.slice(slash + 1);
      return { model_id: `${provider}/${model}`, provider, model };
    }
    return { model_id: `unknown/${trimmed}`, provider: 'unknown', model: trimmed };
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const provider = typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim() : null;
    const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null;
    if (provider && model) {
      return { model_id: `${provider}/${model}`, provider, model };
    }
    if (typeof raw.model_id === 'string' && raw.model_id.trim()) {
      return normalizeModelSpec(raw.model_id);
    }
    if (model) return normalizeModelSpec(model);
  }
  return null;
}

function parseIsoDurationMs(startRaw, endRaw) {
  if (typeof startRaw !== 'string' || typeof endRaw !== 'string') return null;
  const start = Date.parse(startRaw);
  const end = Date.parse(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function extractTaskId(raw) {
  const candidates = [
    raw?.task_id,
    raw?.taskId,
    raw?.id,
    raw?.metadata?.task_id,
    raw?.labels?.task_id,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  }
  return null;
}

function extractBoardTask(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const msg = raw?.message && typeof raw.message === 'object' ? raw.message : raw;
  const taskId = extractTaskId(msg);
  if (!taskId) return null;

  const nested = msg.task !== null && typeof msg.task === 'object' && !Array.isArray(msg.task) ? msg.task : null;
  const status = normalizeStatus(nested?.state ?? msg.status ?? msg.state);
  const channel = normalizeChannel(msg.channel ?? msg.project ?? msg.labels?.channel ?? msg.labels?.repo_id);
  const titleRaw = msg.title ?? nested?.title ?? (typeof msg.text === 'string' ? msg.text.split('\n')[0] : null);
  const title = typeof titleRaw === 'string' && titleRaw.trim() ? titleRaw.trim() : null;

  const wallClock = finiteNonNeg(msg.wall_clock_ms ?? msg.wallClockMs ?? nested?.wall_clock_ms) ??
    parseIsoDurationMs(
      msg.started_at ?? msg.created_at ?? msg.createdAt,
      msg.completed_at ?? msg.closed_at ?? msg.ended_at ?? msg.completedAt ?? msg.closedAt,
    );

  const explicitRework = finiteNonNeg(msg.rework_rounds ?? msg.reworkRounds ?? nested?.rework_rounds);
  const models = [];
  if (Array.isArray(msg.models)) {
    for (const item of msg.models) {
      const spec = normalizeModelSpec(item);
      if (spec) models.push(spec);
    }
  }
  const usage = normalizeUsage(msg.tokens ?? msg.usage);
  const cost = normalizeCost(msg);

  return {
    task_id: taskId,
    channel,
    title,
    status,
    wall_clock_ms: wallClock,
    explicit_rework_rounds: explicitRework,
    models,
    usage,
    cost_usd: cost,
  };
}

function extractBbThread(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  const taskId = (() => {
    const val = raw.task_id ?? raw.taskId ?? raw.metadata?.task_id ?? raw.labels?.task_id;
    if (typeof val === 'string' && val.trim()) return val.trim();
    if (typeof val === 'number' && Number.isSafeInteger(val)) return String(val);
    return null;
  })();
  const channel = normalizeChannel(
    raw.channel ?? raw.project ?? raw.projectId ?? raw.project_id ?? raw.metadata?.channel ?? raw.metadata?.projectId,
  );
  const status = normalizeStatus(raw.status ?? raw.state);
  const provider = raw.provider ?? raw.providerId ?? raw.provider_id;
  const modelName = raw.model ?? raw.modelId ?? raw.model_id ?? raw.agent?.model;
  // Не выдумываем модель из одного providerId: модель фиксируется только если она явно задана.
  const modelSpec = normalizeModelSpec(
    provider && modelName ? { provider, model: modelName } : modelName,
  );
  const usage = threadUsage(raw) ?? normalizeUsage(raw.tokens);
  const cost = normalizeCost(raw);
  const durationMs = finiteNonNeg(raw.duration_ms ?? raw.wall_clock_ms) ??
    parseIsoDurationMs(raw.started_at ?? raw.created_at ?? raw.createdAt, raw.ended_at ?? raw.completed_at ?? raw.updated_at ?? raw.updatedAt);
  const isFailure = raw.provider_failure === true ||
    Boolean(raw.error) ||
    FAILURE_STATUSES.has(status) ||
    (typeof raw.reason === 'string' && PROVIDER_FAILURE_REASON_RE.test(raw.reason));
  const isOpen = raw.open === true || status === 'running' || status === 'in_progress' || status === 'pending' || status === 'open';
  const reworkRounds = finiteNonNeg(raw.rework_rounds ?? raw.rounds?.rework);

  return {
    id,
    task_id: taskId,
    channel,
    status,
    model: modelSpec,
    role: typeof raw.role === 'string' && ROLES.includes(raw.role) ? raw.role : 'worker',
    usage,
    cost_usd: cost,
    duration_ms: durationMs,
    provider_failure: isFailure,
    open: isOpen,
    rework_rounds: reworkRounds,
  };
}

function isRoleInvoked(entry, role, { roleUsage, roleCost, failCount, linkedThread }) {
  if (roleUsage !== null || roleCost !== null || failCount > 0) return true;
  const phases = entry?.phases_ms;
  const rounds = entry?.rounds;
  if (role === 'arbiter') {
    return finiteNonNeg(phases?.arbiter) !== null ||
      (finiteNonNeg(rounds?.arbitration) ?? 0) > 0 ||
      (finiteNonNeg(rounds?.gates?.arbiter) ?? 0) > 0;
  }
  if (role === 'critic') {
    return finiteNonNeg(phases?.l2_critic) !== null ||
      (finiteNonNeg(rounds?.gates?.l2) ?? 0) > 0;
  }
  if (role === 'worker') {
    return finiteNonNeg(phases?.spawn) !== null ||
      finiteNonNeg(phases?.worker) !== null ||
      finiteNonNeg(phases?.worker_feedback) !== null ||
      linkedThread !== null ||
      (finiteNonNeg(rounds?.total) ?? 0) > 0;
  }
  return false;
}

function extractAttemptCostByRole(entry) {
  const result = { worker: null, critic: null, arbiter: null };
  if (entry?.costs !== null && typeof entry?.costs === 'object' && !Array.isArray(entry.costs)) {
    for (const role of ROLES) {
      result[role] = normalizeCost(entry.costs[role]);
    }
  }
  for (const role of ROLES) {
    if (result[role] === null) {
      result[role] = normalizeCost(entry?.tokens?.[role]);
    }
  }
  return result;
}

function detectFailedRoles(entry) {
  const failed = new Set();
  if (Array.isArray(entry?.failed_roles)) {
    for (const role of entry.failed_roles) {
      if (ROLES.includes(role)) failed.add(role);
    }
  }
  const reason = typeof entry?.reason === 'string' ? entry.reason : '';
  const outcome = typeof entry?.outcome === 'string' ? entry.outcome.toLowerCase() : '';
  const hasFailureSignal = entry?.provider_failure === true ||
    outcome === 'provider_error' || outcome === 'crashed' || outcome === 'error' ||
    PROVIDER_FAILURE_REASON_RE.test(reason);

  if (hasFailureSignal && failed.size === 0) {
    if (/arbiter/i.test(reason)) failed.add('arbiter');
    else if (/critic|review/i.test(reason)) failed.add('critic');
    else if (entry?.models?.worker) failed.add('worker');
    else {
      for (const role of ROLES) {
        if (entry?.models?.[role]) failed.add(role);
      }
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------
// Источники данных (файлы, Board API, BB CLI) с чистой инъекцией для тестов.
// ---------------------------------------------------------------------------

export async function loadBoardTasksFromFile(filePath) {
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.tasks)) return raw.tasks;
  if (Array.isArray(raw?.messages)) return raw.messages;
  return [];
}

export async function loadBoardTasksFromApi({ url, token = null, fetchImpl = globalThis.fetch } = {}) {
  if (typeof url !== 'string' || !url) throw new Error('Board API url is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const headers = { accept: 'application/json' };
  if (typeof token === 'string' && token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, { headers });
  if (!response?.ok) {
    throw new Error(`Board API request failed: ${response?.status ?? 'unknown'}`);
  }
  const raw = await response.json();
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.tasks)) return raw.tasks;
  if (Array.isArray(raw?.messages)) return raw.messages;
  return [];
}

export async function loadBbThreadsFromFile(filePath) {
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.threads)) return raw.threads;
  return [];
}

export async function loadBbThreadsFromCli({ execBb = null, project = null } = {}) {
  const runner = execBb ?? ((args, opts) => execFileAsync('bb', args, opts));
  const args = ['thread', 'list', '--json'];
  if (typeof project === 'string' && project) args.push('--project', project);
  const { stdout } = await runner(args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const raw = JSON.parse(stdout);
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.threads)) return raw.threads;
  return [];
}

export async function loadTelemetryLinesFromPaths(paths) {
  const lines = [];
  for (const target of paths ?? []) {
    if (typeof target !== 'string' || !target) continue;
    const stats = await lstat(target).catch(() => null);
    const filePath = stats?.isDirectory() ? join(target, 'telemetry.jsonl') : target;
    const fileLines = await readTelemetryLines(filePath).catch(() => []);
    lines.push(...fileLines);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Единый сборщик 4 уровней метрик.
// ---------------------------------------------------------------------------

export async function collectTelemetry({
  boardTasks = null,
  bbThreads = null,
  telemetryRuns = null,
  telemetryLines = null,
  sources = {},
  clock = () => Date.now(),
} = {}) {
  const resolvedBoard = Array.isArray(boardTasks)
    ? boardTasks
    : (typeof sources.loadBoardTasks === 'function' ? await sources.loadBoardTasks() : []);

  const resolvedThreads = Array.isArray(bbThreads)
    ? bbThreads
    : (typeof sources.loadBbThreads === 'function' ? await sources.loadBbThreads() : []);

  let corruptTelemetryLines = 0;
  let resolvedRuns = [];
  if (Array.isArray(telemetryRuns)) {
    resolvedRuns = telemetryRuns.filter(r => r !== null && typeof r === 'object');
  } else if (typeof sources.loadTelemetryRuns === 'function') {
    const loaded = await sources.loadTelemetryRuns();
    resolvedRuns = Array.isArray(loaded) ? loaded.filter(r => r !== null && typeof r === 'object') : [];
  }

  const linesToParse = Array.isArray(telemetryLines)
    ? telemetryLines
    : (typeof sources.loadTelemetryLines === 'function' ? await sources.loadTelemetryLines() : null);

  if (Array.isArray(linesToParse)) {
    const parsed = parseTelemetryLines(linesToParse);
    corruptTelemetryLines += parsed.corrupt;
    resolvedRuns = [...resolvedRuns, ...parsed.entries];
  }

  // Индекс задач (уровень в).
  const taskMap = new Map();
  const ensureTask = (taskId, defaults = {}) => {
    let rec = taskMap.get(taskId);
    if (!rec) {
      rec = {
        task_id: taskId,
        channel: normalizeChannel(defaults.channel),
        title: defaults.title ?? null,
        status: normalizeStatus(defaults.status),
        has_board_status: false,
        board_wall_clock_ms: null,
        explicit_rework_rounds: null,
        attempt_wall_ms_parts: [],
        thread_duration_parts: [],
        rework_sum: 0,
        has_attempt_rounds: false,
        attempts: 0,
        closed_attempts: 0,
        any_attempt_passed: false,
        last_attempt_outcome: null,
        last_attempt_ts: null,
        models: new Set(),
        usages: [],
        costs: [],
      };
      taskMap.set(taskId, rec);
    }
    return rec;
  };

  for (const rawTask of resolvedBoard ?? []) {
    const task = extractBoardTask(rawTask);
    if (!task) continue;
    const rec = ensureTask(task.task_id, { channel: task.channel, title: task.title, status: task.status });
    rec.channel = task.channel;
    if (task.title) rec.title = task.title;
    rec.status = task.status;
    rec.has_board_status = true;
    if (task.wall_clock_ms !== null) rec.board_wall_clock_ms = task.wall_clock_ms;
    if (task.explicit_rework_rounds !== null) rec.explicit_rework_rounds = task.explicit_rework_rounds;
    for (const spec of task.models) rec.models.add(spec.model_id);
    if (task.usage) rec.usages.push(task.usage);
    if (task.cost_usd !== null) rec.costs.push(task.cost_usd);
  }

  // Индекс BB-тредов с дедупликацией по id до подсчёта и агрегации.
  const normalizedThreads = [];
  const threadById = new Map();
  for (const rawThread of resolvedThreads ?? []) {
    const thread = extractBbThread(rawThread);
    if (!thread) continue;
    if (thread.id) {
      if (threadById.has(thread.id)) continue;
      threadById.set(thread.id, thread);
    }
    normalizedThreads.push(thread);
  }
  const linkedThreadIds = new Set();

  // Индекс моделей/провайдеров (уровень г).
  const modelMap = new Map();
  const ensureModel = spec => {
    let rec = modelMap.get(spec.model_id);
    if (!rec) {
      rec = {
        model_id: spec.model_id,
        provider: spec.provider,
        model: spec.model,
        roles: new Set(),
        runs: 0,
        closed_runs: 0,
        first_round_passes: 0,
        rework_sum: 0,
        rework_n: 0,
        provider_failures: 0,
        usages: [],
        costs: [],
        runs_with_usage: 0,
        runs_with_cost: 0,
      };
      modelMap.set(spec.model_id, rec);
    }
    return rec;
  };

  // Обработка прогонов telemetry.mjs / run-isolated.mjs.
  for (const entry of resolvedRuns) {
    if (entry.schema !== undefined && entry.schema !== TELEMETRY_SCHEMA) continue;
    if (entry.kind !== undefined && entry.kind !== 'attempt_summary') continue;

    const taskId = extractTaskId(entry);
    const threadId = typeof (entry.thread_id ?? entry.bb_thread_id) === 'string'
      ? (entry.thread_id ?? entry.bb_thread_id)
      : null;
    const linkedThread = threadId ? threadById.get(threadId) ?? null : null;
    if (linkedThread?.id) linkedThreadIds.add(linkedThread.id);

    const attemptWall = finiteNonNeg(entry.phases_ms?.total) ??
      parseIsoDurationMs(entry.started_at, entry.ended_at);
    const rework = finiteNonNeg(entry.rounds?.rework);
    const isOpen = entry.open === true;
    const outcome = normalizeStatus(entry.outcome);
    const roleCosts = extractAttemptCostByRole(entry);
    const topCost = normalizeCost(entry);
    const failedRoles = detectFailedRoles(entry);

    let taskRec = null;
    if (taskId) {
      const fallbackChannel = entry.channel ?? entry.project ?? linkedThread?.channel ?? 'unassigned';
      taskRec = ensureTask(taskId, { channel: fallbackChannel, status: isOpen ? 'in_progress' : outcome });
      if (taskRec.channel === 'unassigned' && fallbackChannel !== 'unassigned') {
        taskRec.channel = normalizeChannel(fallbackChannel);
      }
      taskRec.attempts += 1;
      if (!isOpen) taskRec.closed_attempts += 1;
      if (attemptWall !== null) taskRec.attempt_wall_ms_parts.push(attemptWall);
      if (rework !== null) {
        taskRec.rework_sum += rework;
        taskRec.has_attempt_rounds = true;
      } else if (entry.rounds !== null && typeof entry.rounds === 'object') {
        taskRec.has_attempt_rounds = true;
      }
      if (!isOpen && isSuccessOutcome(outcome)) taskRec.any_attempt_passed = true;
      const entryTs = attemptTimestampMs(entry);
      const isNewerAttempt = taskRec.attempts === 1 ||
        (entryTs !== null && (taskRec.last_attempt_ts === null || entryTs >= taskRec.last_attempt_ts)) ||
        (entryTs === null && taskRec.last_attempt_ts === null);
      if (isNewerAttempt) {
        if (entryTs !== null) taskRec.last_attempt_ts = entryTs;
        if (!isOpen && outcome !== 'unknown') taskRec.last_attempt_outcome = outcome;
        if (!taskRec.has_board_status) {
          if (isOpen) taskRec.status = 'in_progress';
          else if (outcome !== 'unknown') taskRec.status = outcome;
        } else if (taskRec.status === 'unknown' && outcome !== 'unknown') {
          taskRec.status = outcome;
        }
      }
    }

    // Если явный объект provider_failures задан по model_id.
    const explicitModelFailures = entry.provider_failures !== null &&
      typeof entry.provider_failures === 'object' &&
      !Array.isArray(entry.provider_failures)
      ? entry.provider_failures
      : null;

    // Роли и модели попытки: учитываем только фактически задействованные роли,
    // а не просто настроенные в конфиге (например, арбитр без вызовов).
    const invokedRoleSpecs = [];
    for (const role of ROLES) {
      const spec = normalizeModelSpec(entry.models?.[role]);
      if (!spec) continue;

      const roleUsage = normalizeUsage(entry.tokens?.[role]) ??
        (role === 'worker' && linkedThread?.usage ? linkedThread.usage : null);
      const roleCost = roleCosts[role] ??
        (role === 'worker' && linkedThread?.cost_usd != null ? linkedThread.cost_usd : null);

      let failCount = 0;
      if (explicitModelFailures && finiteNonNeg(explicitModelFailures[spec.model_id]) !== null) {
        failCount = explicitModelFailures[spec.model_id];
      } else if (explicitModelFailures && finiteNonNeg(explicitModelFailures[role]) !== null) {
        failCount = explicitModelFailures[role];
      } else if (failedRoles.has(role) || (role === 'worker' && linkedThread?.provider_failure)) {
        failCount = 1;
      }

      if (!isRoleInvoked(entry, role, { roleUsage, roleCost, failCount, linkedThread })) {
        continue;
      }

      invokedRoleSpecs.push({ role, spec, roleUsage, roleCost, failCount });
      if (taskRec) taskRec.models.add(spec.model_id);
    }

    let anyRoleCost = false;
    for (const { role, spec, roleUsage, roleCost, failCount } of invokedRoleSpecs) {
      const mRec = ensureModel(spec);
      mRec.roles.add(role);
      mRec.runs += 1;

      if (roleUsage) {
        mRec.usages.push(roleUsage);
        mRec.runs_with_usage += 1;
        if (taskRec) taskRec.usages.push(roleUsage);
      }

      if (roleCost !== null) {
        anyRoleCost = true;
        mRec.costs.push(roleCost);
        mRec.runs_with_cost += 1;
        if (taskRec) taskRec.costs.push(roleCost);
      }

      mRec.provider_failures += failCount;

      if (!isOpen) {
        mRec.closed_runs += 1;
        if (rework !== null) {
          mRec.rework_sum += rework;
          mRec.rework_n += 1;
        }
        if (isSuccessOutcome(outcome) && (rework ?? 0) === 0 && failCount === 0) {
          mRec.first_round_passes += 1;
        }
      }
    }

    if (!anyRoleCost && topCost !== null) {
      if (taskRec) taskRec.costs.push(topCost);
      if (invokedRoleSpecs.length === 1) {
        const mRec = ensureModel(invokedRoleSpecs[0].spec);
        mRec.costs.push(topCost);
        mRec.runs_with_cost += 1;
      }
    }
  }

  // Обработка несвязанных BB-тредов (не покрытых telemetry.jsonl).
  for (const thread of normalizedThreads) {
    if (thread.id && linkedThreadIds.has(thread.id)) continue;

    let taskRec = null;
    if (thread.task_id) {
      taskRec = ensureTask(thread.task_id, { channel: thread.channel, status: thread.status });
      if (taskRec.channel === 'unassigned' && thread.channel !== 'unassigned') {
        taskRec.channel = thread.channel;
      }
      if (thread.duration_ms !== null) taskRec.thread_duration_parts.push(thread.duration_ms);
      if (thread.model) taskRec.models.add(thread.model.model_id);
      if (thread.usage) taskRec.usages.push(thread.usage);
      if (thread.cost_usd !== null) taskRec.costs.push(thread.cost_usd);
    }

    if (thread.model) {
      const mRec = ensureModel(thread.model);
      mRec.roles.add(thread.role);
      mRec.runs += 1;
      if (thread.usage) {
        mRec.usages.push(thread.usage);
        mRec.runs_with_usage += 1;
      }
      if (thread.cost_usd !== null) {
        mRec.costs.push(thread.cost_usd);
        mRec.runs_with_cost += 1;
      }
      if (thread.provider_failure) {
        mRec.provider_failures += 1;
      }
      if (!thread.open) {
        mRec.closed_runs += 1;
        if (thread.rework_rounds !== null) {
          mRec.rework_sum += thread.rework_rounds;
          mRec.rework_n += 1;
        }
        if (isSuccessOutcome(thread.status) && !thread.provider_failure && (thread.rework_rounds ?? 0) === 0) {
          mRec.first_round_passes += 1;
        }
      }
    }
  }

  // Финализация уровня (в) — задачи.
  const tasks = [...taskMap.values()]
    .map(rec => {
      const closed = isClosedStatus(rec.status) ||
        (rec.status === 'unknown' && rec.closed_attempts > 0 && rec.any_attempt_passed);
      const wallClockMs = rec.attempt_wall_ms_parts.length > 0
        ? rec.attempt_wall_ms_parts.reduce((a, b) => a + b, 0)
        : (rec.board_wall_clock_ms !== null
          ? rec.board_wall_clock_ms
          : (rec.thread_duration_parts.length > 0
            ? rec.thread_duration_parts.reduce((a, b) => a + b, 0)
            : null));
      const reworkRounds = rec.has_attempt_rounds
        ? rec.rework_sum
        : (rec.explicit_rework_rounds ?? 0);
      const hasRoundEvidence = rec.closed_attempts > 0 || rec.explicit_rework_rounds !== null;
      const firstRoundPass = closed && hasRoundEvidence
        ? (isSuccessOutcome(rec.status) || rec.any_attempt_passed) && reworkRounds === 0
        : (rec.closed_attempts > 0 && !closed ? false : null);

      return {
        task_id: rec.task_id,
        channel: rec.channel,
        title: rec.title,
        status: rec.status,
        closed,
        wall_clock_ms: wallClockMs,
        rework_rounds: reworkRounds,
        first_round_pass: firstRoundPass,
        attempts: rec.attempts,
        models: [...rec.models].sort(),
        tokens: sumUsages(rec.usages),
        cost_usd: sumCosts(rec.costs),
      };
    })
    .sort((a, b) => a.task_id.localeCompare(b.task_id, 'en', { numeric: true }));

  // Хелпер агрегации группы задач (для портфеля и каждого канала).
  const summarizeTaskGroup = groupTasks => {
    const totalTasks = groupTasks.length;
    const closedTasks = groupTasks.filter(t => t.closed).length;
    const openTasks = totalTasks - closedTasks;
    const completionRate = totalTasks > 0 ? closedTasks / totalTasks : null;
    const medianWallClockMs = computeMedian(groupTasks.map(t => t.wall_clock_ms));
    const eligibleFirstPass = groupTasks.filter(t => t.first_round_pass !== null);
    const firstRoundPassRate = eligibleFirstPass.length > 0
      ? eligibleFirstPass.filter(t => t.first_round_pass === true).length / eligibleFirstPass.length
      : null;
    const reworkEligible = groupTasks.filter(t => t.attempts > 0 || t.first_round_pass !== null);
    const avgReworkRounds = reworkEligible.length > 0
      ? reworkEligible.reduce((acc, t) => acc + t.rework_rounds, 0) / reworkEligible.length
      : null;
    const attempts = groupTasks.reduce((acc, t) => acc + t.attempts, 0);
    const tokens = sumUsages(groupTasks.map(t => t.tokens));
    const costUsd = sumCosts(groupTasks.map(t => t.cost_usd));

    return {
      total_tasks: totalTasks,
      closed_tasks: closedTasks,
      open_tasks: openTasks,
      completion_rate: completionRate,
      median_wall_clock_ms: medianWallClockMs,
      first_round_pass_rate: firstRoundPassRate,
      avg_rework_rounds: avgReworkRounds,
      attempts,
      tokens,
      cost_usd: costUsd,
    };
  };

  // Финализация уровня (б) — каналы / проекты.
  const channelGroups = new Map();
  const channelThreads = new Map();
  for (const task of tasks) {
    const list = channelGroups.get(task.channel) ?? [];
    list.push(task);
    channelGroups.set(task.channel, list);
  }
  for (const thread of normalizedThreads) {
    if (thread.channel !== 'unassigned' && !channelGroups.has(thread.channel)) {
      channelGroups.set(thread.channel, []);
    }
    if (channelGroups.has(thread.channel)) {
      channelThreads.set(thread.channel, (channelThreads.get(thread.channel) ?? 0) + 1);
    }
  }
  const channels = [...channelGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([channel, groupTasks]) => ({
      channel,
      ...summarizeTaskGroup(groupTasks),
      bb_threads: channelThreads.get(channel) ?? 0,
    }));

  // Финализация уровня (г) — модели / провайдеры.
  const models = [...modelMap.values()]
    .sort((a, b) => a.model_id.localeCompare(b.model_id))
    .map(m => ({
      model_id: m.model_id,
      provider: m.provider,
      model: m.model,
      roles: [...m.roles].sort(),
      runs: m.runs,
      closed_runs: m.closed_runs,
      first_round_pass_rate: m.closed_runs > 0 ? m.first_round_passes / m.closed_runs : null,
      avg_rework_rounds: m.rework_n > 0 ? m.rework_sum / m.rework_n : null,
      provider_failures: m.provider_failures,
      tokens: sumUsages(m.usages),
      cost_usd: sumCosts(m.costs),
      runs_with_usage: m.runs_with_usage,
      runs_with_cost: m.runs_with_cost,
    }));

  // Финализация уровня (а) — портфель.
  const portfolioBase = summarizeTaskGroup(tasks);
  // Если часть токенов/стоимости пришла из BB-тредов без task_id, учитываем их в портфеле.
  const unattributedThreadUsages = normalizedThreads
    .filter(t => !t.task_id && !(t.id && linkedThreadIds.has(t.id)))
    .map(t => t.usage);
  const unattributedThreadCosts = normalizedThreads
    .filter(t => !t.task_id && !(t.id && linkedThreadIds.has(t.id)))
    .map(t => t.cost_usd);

  const portfolio = {
    total_tasks: portfolioBase.total_tasks,
    closed_tasks: portfolioBase.closed_tasks,
    open_tasks: portfolioBase.open_tasks,
    completion_rate: portfolioBase.completion_rate,
    median_wall_clock_ms: portfolioBase.median_wall_clock_ms,
    first_round_pass_rate: portfolioBase.first_round_pass_rate,
    avg_rework_rounds: portfolioBase.avg_rework_rounds,
    total_attempts: resolvedRuns.length,
    total_bb_threads: normalizedThreads.length,
    tokens: sumUsages([portfolioBase.tokens, ...unattributedThreadUsages]),
    cost_usd: sumCosts([portfolioBase.cost_usd, ...unattributedThreadCosts]),
  };

  const nowTs = clock();
  const generatedAt = new Date(Number.isFinite(nowTs) ? nowTs : Date.now()).toISOString();

  return {
    schema: COLLECTOR_SCHEMA,
    generated_at: generatedAt,
    sources: {
      board_tasks: (resolvedBoard ?? []).length,
      bb_threads: normalizedThreads.length,
      telemetry_runs: resolvedRuns.length,
      corrupt_telemetry_lines: corruptTelemetryLines,
    },
    portfolio,
    channels,
    tasks,
    models,
  };
}

// ---------------------------------------------------------------------------
// Форматирование, Snapshots, History (history.jsonl) и Trend Diff.
// ---------------------------------------------------------------------------

const fmtPct = rate => rate == null ? 'N/A' : `${(rate * 100).toFixed(1)}%`;
const fmtDuration = ms => {
  if (ms == null || !Number.isFinite(ms)) return 'N/A';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
};
const fmtNum = (val, digits = 2) => val == null || !Number.isFinite(val) ? 'N/A' : val.toFixed(digits);
const fmtCost = val => val == null || !Number.isFinite(val) ? 'N/A' : `$${val.toFixed(4)}`;
const fmtUsage = u => u == null ? 'N/A' : `${u.input ?? 'N/A'} / ${u.output ?? 'N/A'} / ${u.cached ?? 'N/A'}`;
const fmtSignedPct = val => val == null ? 'N/A' : `${val >= 0 ? '+' : ''}${(val * 100).toFixed(1)}pp`;
const fmtSignedRelPct = val => val == null ? 'N/A' : `${val >= 0 ? '+' : ''}${(val * 100).toFixed(1)}%`;
const fmtSignedNum = (val, digits = 2) => val == null ? 'N/A' : `${val >= 0 ? '+' : ''}${val.toFixed(digits)}`;
const fmtSignedCost = val => val == null ? 'N/A' : `${val >= 0 ? '+' : '-'}$${Math.abs(val).toFixed(4)}`;

export function sanitizeSnapshotDate(date, generatedAt) {
  const candidate = typeof date === 'string' && date.trim()
    ? date.trim()
    : (typeof generatedAt === 'string' && generatedAt.length >= 10 ? generatedAt.slice(0, 10) : new Date().toISOString().slice(0, 10));
  if (!SAFE_DATE_RE.test(candidate)) {
    throw new Error(`Invalid snapshot date: ${candidate}`);
  }
  return candidate;
}

export function toHistoryEntry(snapshot, date = null) {
  const snapDate = sanitizeSnapshotDate(date, snapshot?.generated_at);
  const p = snapshot?.portfolio ?? {};
  return {
    schema: HISTORY_SCHEMA,
    date: snapDate,
    generated_at: snapshot?.generated_at ?? null,
    portfolio: {
      total_tasks: p.total_tasks ?? 0,
      closed_tasks: p.closed_tasks ?? 0,
      open_tasks: p.open_tasks ?? 0,
      completion_rate: p.completion_rate ?? null,
      median_wall_clock_ms: p.median_wall_clock_ms ?? null,
      first_round_pass_rate: p.first_round_pass_rate ?? null,
      avg_rework_rounds: p.avg_rework_rounds ?? null,
      tokens: p.tokens ?? null,
      cost_usd: p.cost_usd ?? null,
    },
    channels: (snapshot?.channels ?? []).map(c => ({
      channel: c.channel,
      total_tasks: c.total_tasks,
      closed_tasks: c.closed_tasks,
      completion_rate: c.completion_rate,
      median_wall_clock_ms: c.median_wall_clock_ms,
      first_round_pass_rate: c.first_round_pass_rate,
    })),
    models: (snapshot?.models ?? []).map(m => ({
      model_id: m.model_id,
      runs: m.runs,
      first_round_pass_rate: m.first_round_pass_rate,
      avg_rework_rounds: m.avg_rework_rounds,
      provider_failures: m.provider_failures,
      tokens: m.tokens,
      cost_usd: m.cost_usd,
    })),
  };
}

export function formatSnapshotMarkdown(snapshot) {
  const p = snapshot.portfolio;
  const lines = [
    `# Telemetry Snapshot (${snapshot.generated_at})`,
    '',
    '## Portfolio',
    '',
    `- **Total tasks:** ${p.total_tasks} (closed: ${p.closed_tasks}, open: ${p.open_tasks})`,
    `- **Completion rate:** ${fmtPct(p.completion_rate)}`,
    `- **Median wall-clock:** ${fmtDuration(p.median_wall_clock_ms)}`,
    `- **1st-round pass rate:** ${fmtPct(p.first_round_pass_rate)}`,
    `- **Avg REWORK rounds:** ${fmtNum(p.avg_rework_rounds)}`,
    `- **Tokens (in / out / cached):** ${fmtUsage(p.tokens)}`,
    `- **Cost (USD):** ${fmtCost(p.cost_usd)}`,
    '',
    '## Projects / Channels',
    '',
  ];

  if (snapshot.channels.length) {
    lines.push('| Channel | Total | Closed | Open | Completion | Median Wall-Clock | 1st-Round Pass | Avg Rework | Cost |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const c of snapshot.channels) {
      lines.push(`| ${c.channel} | ${c.total_tasks} | ${c.closed_tasks} | ${c.open_tasks} | ${fmtPct(c.completion_rate)} | ${fmtDuration(c.median_wall_clock_ms)} | ${fmtPct(c.first_round_pass_rate)} | ${fmtNum(c.avg_rework_rounds)} | ${fmtCost(c.cost_usd)} |`);
    }
  } else {
    lines.push('_No channels recorded._');
  }

  lines.push('', '## Models / Providers', '');
  if (snapshot.models.length) {
    lines.push('| Model | Runs | 1st-Round Pass | Avg Rework | Provider Failures | Tokens (in/out/cached) | Cost |');
    lines.push('| --- | ---: | ---: | ---: | ---: | --- | ---: |');
    for (const m of snapshot.models) {
      lines.push(`| ${m.model_id} | ${m.runs} | ${fmtPct(m.first_round_pass_rate)} | ${fmtNum(m.avg_rework_rounds)} | ${m.provider_failures} | ${fmtUsage(m.tokens)} | ${fmtCost(m.cost_usd)} |`);
    }
  } else {
    lines.push('_No models recorded._');
  }

  lines.push('', '## Tasks', '');
  if (snapshot.tasks.length) {
    lines.push('| Task | Channel | Status | Wall-Clock | Rework | Models | Cost |');
    lines.push('| --- | --- | --- | ---: | ---: | --- | ---: |');
    for (const t of snapshot.tasks) {
      lines.push(`| ${t.task_id} | ${t.channel} | ${t.status} | ${fmtDuration(t.wall_clock_ms)} | ${t.rework_rounds} | ${t.models.join(', ') || '-'} | ${fmtCost(t.cost_usd)} |`);
    }
  } else {
    lines.push('_No tasks recorded._');
  }

  return `${lines.join('\n')}\n`;
}

export async function readHistory(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch {
      // Fail-open on corrupt history line.
    }
  }
  return entries;
}

export function sanitizeHistoryFile(historyFile = DEFAULT_HISTORY_FILE) {
  if (typeof historyFile !== 'string' || !historyFile.trim()) {
    throw new Error('Invalid historyFile: must be a non-empty filename');
  }
  const name = historyFile.trim();
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || !SAFE_FILENAME_RE.test(name)) {
    throw new Error(`Invalid historyFile: ${historyFile}`);
  }
  return name;
}

export async function writeSnapshot(snapshot, {
  outDir,
  date = null,
  historyFile = DEFAULT_HISTORY_FILE,
  writeHtml = false,
} = {}) {
  if (typeof outDir !== 'string' || !outDir) throw new Error('outDir is required');
  const snapDate = sanitizeSnapshotDate(date, snapshot.generated_at);
  const safeHistoryFile = sanitizeHistoryFile(historyFile);
  await mkdir(outDir, { recursive: true });

  // Не затираем предыдущий снимок за ту же дату: атомарно подбираем уникальный суффикс.
  let jsonPath = null;
  let mdPath = null;
  let snapshotFile = null;
  const jsonBody = `${JSON.stringify(snapshot, null, 2)}\n`;
  const mdBody = formatSnapshotMarkdown(snapshot);

  for (let seq = 1; ; seq += 1) {
    const stem = seq === 1 ? `snapshot-${snapDate}` : `snapshot-${snapDate}-${seq}`;
    const candidateJson = join(outDir, `${stem}.json`);
    const candidateMd = join(outDir, `${stem}.md`);
    try {
      await writeFile(candidateJson, jsonBody, { encoding: 'utf8', flag: 'wx' });
      try {
        await writeFile(candidateMd, mdBody, { encoding: 'utf8', flag: 'wx' });
      } catch (mdError) {
        await unlink(candidateJson).catch(() => {});
        throw mdError;
      }
      jsonPath = candidateJson;
      mdPath = candidateMd;
      snapshotFile = `${stem}.json`;
      break;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }

  const historyPath = join(outDir, safeHistoryFile);
  const historyEntry = { ...toHistoryEntry(snapshot, snapDate), snapshot_file: snapshotFile };

  // Если непустой history.jsonl не оканчивается на \n, добавляем ведущий \n.
  const existingHistory = await readFile(historyPath, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  const prefix = existingHistory.length > 0 && !existingHistory.endsWith('\n') ? '\n' : '';
  await appendFile(historyPath, `${prefix}${JSON.stringify(historyEntry)}\n`, 'utf8');

  let htmlPath = null;
  if (writeHtml) {
    const history = await readHistory(historyPath);
    htmlPath = join(outDir, 'dashboard.html');
    await writeFile(htmlPath, renderTelemetryDashboardHtml(history, snapshot), 'utf8');
  }

  return { date: snapDate, snapshotFile, jsonPath, mdPath, historyPath, htmlPath, historyEntry };
}

function numericDelta(before, after) {
  const b = typeof before === 'number' && Number.isFinite(before) ? before : null;
  const a = typeof after === 'number' && Number.isFinite(after) ? after : null;
  if (b === null || a === null) {
    return { before: b, after: a, delta: null, pct_change: null };
  }
  const delta = a - b;
  const pctChange = b !== 0 ? delta / b : null;
  return { before: b, after: a, delta, pct_change: pctChange };
}

function wallClockDelta(before, after) {
  const base = numericDelta(before, after);
  const speedupPct = base.before !== null && base.before > 0 && base.after !== null
    ? (base.before - base.after) / base.before
    : null;
  return { ...base, speedup_pct: speedupPct };
}

function tokenTotal(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  const hasIn = typeof usage.input === 'number' && Number.isFinite(usage.input);
  const hasOut = typeof usage.output === 'number' && Number.isFinite(usage.output);
  if (!hasIn || !hasOut) return null;
  return usage.input + usage.output;
}

function usageDelta(before, after) {
  return {
    input: numericDelta(before?.input ?? null, after?.input ?? null),
    output: numericDelta(before?.output ?? null, after?.output ?? null),
    cached: numericDelta(before?.cached ?? null, after?.cached ?? null),
    total: numericDelta(tokenTotal(before), tokenTotal(after)),
  };
}

export function diffSnapshots(snapshotA, snapshotB) {
  const pA = snapshotA?.portfolio ?? {};
  const pB = snapshotB?.portfolio ?? {};

  const chanA = new Map((snapshotA?.channels ?? []).map(c => [c.channel, c]));
  const chanB = new Map((snapshotB?.channels ?? []).map(c => [c.channel, c]));
  const allChannels = [...new Set([...chanA.keys(), ...chanB.keys()])].sort();

  const modA = new Map((snapshotA?.models ?? []).map(m => [m.model_id, m]));
  const modB = new Map((snapshotB?.models ?? []).map(m => [m.model_id, m]));
  const allModels = [...new Set([...modA.keys(), ...modB.keys()])].sort();

  return {
    schema: COLLECTOR_SCHEMA,
    from: snapshotA?.generated_at ?? null,
    to: snapshotB?.generated_at ?? null,
    portfolio: {
      total_tasks: numericDelta(pA.total_tasks ?? null, pB.total_tasks ?? null),
      closed_tasks: numericDelta(pA.closed_tasks ?? null, pB.closed_tasks ?? null),
      open_tasks: numericDelta(pA.open_tasks ?? null, pB.open_tasks ?? null),
      completion_rate: numericDelta(pA.completion_rate ?? null, pB.completion_rate ?? null),
      median_wall_clock_ms: wallClockDelta(pA.median_wall_clock_ms ?? null, pB.median_wall_clock_ms ?? null),
      first_round_pass_rate: numericDelta(pA.first_round_pass_rate ?? null, pB.first_round_pass_rate ?? null),
      avg_rework_rounds: numericDelta(pA.avg_rework_rounds ?? null, pB.avg_rework_rounds ?? null),
      tokens: usageDelta(pA.tokens ?? null, pB.tokens ?? null),
      cost_usd: numericDelta(pA.cost_usd ?? null, pB.cost_usd ?? null),
    },
    channels: allChannels.map(channel => {
      const a = chanA.get(channel) ?? {};
      const b = chanB.get(channel) ?? {};
      return {
        channel,
        total_tasks: numericDelta(a.total_tasks ?? null, b.total_tasks ?? null),
        closed_tasks: numericDelta(a.closed_tasks ?? null, b.closed_tasks ?? null),
        completion_rate: numericDelta(a.completion_rate ?? null, b.completion_rate ?? null),
        median_wall_clock_ms: wallClockDelta(a.median_wall_clock_ms ?? null, b.median_wall_clock_ms ?? null),
        first_round_pass_rate: numericDelta(a.first_round_pass_rate ?? null, b.first_round_pass_rate ?? null),
        avg_rework_rounds: numericDelta(a.avg_rework_rounds ?? null, b.avg_rework_rounds ?? null),
        cost_usd: numericDelta(a.cost_usd ?? null, b.cost_usd ?? null),
      };
    }),
    models: allModels.map(modelId => {
      const a = modA.get(modelId) ?? {};
      const b = modB.get(modelId) ?? {};
      return {
        model_id: modelId,
        runs: numericDelta(a.runs ?? null, b.runs ?? null),
        first_round_pass_rate: numericDelta(a.first_round_pass_rate ?? null, b.first_round_pass_rate ?? null),
        avg_rework_rounds: numericDelta(a.avg_rework_rounds ?? null, b.avg_rework_rounds ?? null),
        provider_failures: numericDelta(a.provider_failures ?? null, b.provider_failures ?? null),
        tokens: usageDelta(a.tokens ?? null, b.tokens ?? null),
        cost_usd: numericDelta(a.cost_usd ?? null, b.cost_usd ?? null),
      };
    }),
  };
}

export function formatDiffMarkdown(diff) {
  const p = diff.portfolio;
  const lines = [
    `# Telemetry Trend Diff (${diff.from ?? 'unknown'} -> ${diff.to ?? 'unknown'})`,
    '',
    '## Portfolio Delta',
    '',
    `- **Completion rate:** ${fmtPct(p.completion_rate.before)} -> ${fmtPct(p.completion_rate.after)} (${fmtSignedPct(p.completion_rate.delta)})`,
    `- **Median wall-clock:** ${fmtDuration(p.median_wall_clock_ms.before)} -> ${fmtDuration(p.median_wall_clock_ms.after)} (speedup: ${fmtSignedRelPct(p.median_wall_clock_ms.speedup_pct)})`,
    `- **1st-round pass rate:** ${fmtPct(p.first_round_pass_rate.before)} -> ${fmtPct(p.first_round_pass_rate.after)} (${fmtSignedPct(p.first_round_pass_rate.delta)})`,
    `- **Avg REWORK rounds:** ${fmtNum(p.avg_rework_rounds.before)} -> ${fmtNum(p.avg_rework_rounds.after)} (${fmtSignedNum(p.avg_rework_rounds.delta)})`,
    `- **Total tokens (in+out):** ${p.tokens.total.before ?? 'N/A'} -> ${p.tokens.total.after ?? 'N/A'} (${fmtSignedNum(p.tokens.total.delta, 0)})`,
    `- **Cost (USD):** ${fmtCost(p.cost_usd.before)} -> ${fmtCost(p.cost_usd.after)} (${fmtSignedCost(p.cost_usd.delta)})`,
  ];

  if (diff.channels.length) {
    lines.push('', '## Channels Delta', '');
    lines.push('| Channel | Completion | Median Wall-Clock (Speedup) | 1st-Round Pass | Avg Rework |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const c of diff.channels) {
      lines.push(`| ${c.channel} | ${fmtPct(c.completion_rate.before)} -> ${fmtPct(c.completion_rate.after)} | ${fmtDuration(c.median_wall_clock_ms.before)} -> ${fmtDuration(c.median_wall_clock_ms.after)} (${fmtSignedRelPct(c.median_wall_clock_ms.speedup_pct)}) | ${fmtPct(c.first_round_pass_rate.before)} -> ${fmtPct(c.first_round_pass_rate.after)} | ${fmtNum(c.avg_rework_rounds.before)} -> ${fmtNum(c.avg_rework_rounds.after)} |`);
    }
  }

  if (diff.models.length) {
    lines.push('', '## Models Delta', '');
    lines.push('| Model | Runs | 1st-Round Pass | Avg Rework | Failures | Cost |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const m of diff.models) {
      lines.push(`| ${m.model_id} | ${m.runs.before ?? 'N/A'} -> ${m.runs.after ?? 'N/A'} | ${fmtPct(m.first_round_pass_rate.before)} -> ${fmtPct(m.first_round_pass_rate.after)} | ${fmtNum(m.avg_rework_rounds.before)} -> ${fmtNum(m.avg_rework_rounds.after)} | ${m.provider_failures.before ?? 'N/A'} -> ${m.provider_failures.after ?? 'N/A'} | ${fmtCost(m.cost_usd.before)} -> ${fmtCost(m.cost_usd.after)} |`);
    }
  }

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Автономный single-file HTML-дашборд (без CDN, строгий XSS-экранировщик).
// ---------------------------------------------------------------------------

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderTrendSvg(points, { title, color, formatValue, maxFixed = null }) {
  const valid = points.filter(pt => typeof pt.value === 'number' && Number.isFinite(pt.value));
  const width = 320;
  const height = 110;
  const pad = 16;

  if (!valid.length) {
    return `<div class="chart-card"><div class="chart-title">${escapeHtml(title)}</div><div class="empty">No measured data</div></div>`;
  }

  const maxVal = maxFixed ?? Math.max(...valid.map(p => p.value), 1);
  const minVal = 0;
  const span = Math.max(maxVal - minVal, 1e-9);
  const stepX = valid.length > 1 ? (width - pad * 2) / (valid.length - 1) : 0;

  const coords = valid.map((pt, idx) => {
    const x = valid.length > 1 ? pad + idx * stepX : width / 2;
    const norm = (pt.value - minVal) / span;
    const y = height - pad - norm * (height - pad * 2);
    return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), label: pt.label, value: pt.value };
  });

  const polyline = coords.map(c => `${c.x},${c.y}`).join(' ');
  const circles = coords.map(c =>
    `<circle cx="${c.x}" cy="${c.y}" r="3.5" fill="${escapeHtml(color)}"><title>${escapeHtml(c.label)}: ${escapeHtml(formatValue(c.value))}</title></circle>`,
  ).join('');
  const latest = valid[valid.length - 1];

  return [
    '<div class="chart-card">',
    `  <div class="chart-head"><span class="chart-title">${escapeHtml(title)}</span><span class="chart-latest">${escapeHtml(formatValue(latest.value))}</span></div>`,
    `  <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escapeHtml(title)}">`,
    `    <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#334155" stroke-width="1" />`,
    valid.length > 1
      ? `    <polyline fill="none" stroke="${escapeHtml(color)}" stroke-width="2.2" points="${polyline}" />`
      : '',
    `    ${circles}`,
    '  </svg>',
    `  <div class="chart-foot"><span>${escapeHtml(valid[0].label)}</span><span>${escapeHtml(latest.label)}</span></div>`,
    '</div>',
  ].join('\n');
}

export function renderTelemetryDashboardHtml(history = [], latestSnapshot = null) {
  const hist = Array.isArray(history) ? history : [];
  const snap = latestSnapshot ?? {
    generated_at: hist.length ? hist[hist.length - 1]?.generated_at ?? '' : '',
    portfolio: hist.length ? hist[hist.length - 1]?.portfolio ?? {} : {},
    channels: hist.length ? hist[hist.length - 1]?.channels ?? [] : [],
    tasks: [],
    models: hist.length ? hist[hist.length - 1]?.models ?? [] : [],
  };
  const p = snap.portfolio ?? {};

  const completionSeries = hist.map(h => ({ label: String(h.date ?? h.generated_at ?? ''), value: h.portfolio?.completion_rate ?? null }));
  const passSeries = hist.map(h => ({ label: String(h.date ?? h.generated_at ?? ''), value: h.portfolio?.first_round_pass_rate ?? null }));
  const wallSeries = hist.map(h => ({ label: String(h.date ?? h.generated_at ?? ''), value: h.portfolio?.median_wall_clock_ms ?? null }));
  const costSeries = hist.map(h => ({ label: String(h.date ?? h.generated_at ?? ''), value: h.portfolio?.cost_usd ?? null }));

  const channelRows = (snap.channels ?? []).map(c => `<tr>
      <td>${escapeHtml(c.channel)}</td>
      <td class="num">${escapeHtml(c.total_tasks)}</td>
      <td class="num">${escapeHtml(c.closed_tasks)}</td>
      <td class="num">${escapeHtml(c.open_tasks ?? (c.total_tasks - c.closed_tasks))}</td>
      <td class="num">${escapeHtml(fmtPct(c.completion_rate))}</td>
      <td class="num">${escapeHtml(fmtDuration(c.median_wall_clock_ms))}</td>
      <td class="num">${escapeHtml(fmtPct(c.first_round_pass_rate))}</td>
      <td class="num">${escapeHtml(fmtNum(c.avg_rework_rounds))}</td>
      <td class="num">${escapeHtml(fmtCost(c.cost_usd))}</td>
    </tr>`).join('\n');

  const modelRows = (snap.models ?? []).map(m => `<tr>
      <td><code>${escapeHtml(m.model_id)}</code></td>
      <td class="num">${escapeHtml(m.runs)}</td>
      <td class="num">${escapeHtml(fmtPct(m.first_round_pass_rate))}</td>
      <td class="num">${escapeHtml(fmtNum(m.avg_rework_rounds))}</td>
      <td class="num">${escapeHtml(m.provider_failures)}</td>
      <td>${escapeHtml(fmtUsage(m.tokens))}</td>
      <td class="num">${escapeHtml(fmtCost(m.cost_usd))}</td>
    </tr>`).join('\n');

  const taskRows = (snap.tasks ?? []).map(t => `<tr>
      <td><code>${escapeHtml(t.task_id)}</code></td>
      <td>${escapeHtml(t.channel)}</td>
      <td>${escapeHtml(t.title ?? '-')}</td>
      <td><span class="badge">${escapeHtml(t.status)}</span></td>
      <td class="num">${escapeHtml(fmtDuration(t.wall_clock_ms))}</td>
      <td class="num">${escapeHtml(t.rework_rounds)}</td>
      <td>${escapeHtml((t.models ?? []).join(', ') || '-')}</td>
      <td class="num">${escapeHtml(fmtCost(t.cost_usd))}</td>
    </tr>`).join('\n');

  const historyRows = hist.map(h => `<tr>
      <td>${escapeHtml(h.date ?? h.generated_at ?? '-')}</td>
      <td class="num">${escapeHtml(h.portfolio?.closed_tasks ?? 0)} / ${escapeHtml(h.portfolio?.total_tasks ?? 0)}</td>
      <td class="num">${escapeHtml(fmtPct(h.portfolio?.completion_rate))}</td>
      <td class="num">${escapeHtml(fmtDuration(h.portfolio?.median_wall_clock_ms))}</td>
      <td class="num">${escapeHtml(fmtPct(h.portfolio?.first_round_pass_rate))}</td>
      <td class="num">${escapeHtml(fmtCost(h.portfolio?.cost_usd))}</td>
    </tr>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Darkfactory Telemetry Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #1e293b;
      --border: #334155;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #38bdf8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 24px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.45;
    }
    h1, h2 { margin: 0 0 12px; font-weight: 600; }
    h1 { font-size: 1.5rem; }
    h2 { font-size: 1.1rem; margin-top: 28px; color: var(--accent); }
    .meta { color: var(--muted); font-size: 0.9rem; margin-bottom: 20px; }
    .kpi-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px;
    }
    .kpi {
      background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px;
    }
    .kpi-label { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .kpi-value { font-size: 1.35rem; font-weight: 700; margin-top: 4px; }
    .charts {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px;
    }
    .chart-card {
      background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px;
    }
    .chart-head { display: flex; justify-content: space-between; font-size: 0.85rem; margin-bottom: 6px; }
    .chart-title { color: var(--muted); font-weight: 600; }
    .chart-latest { font-weight: 700; }
    .chart-foot { display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--muted); }
    .empty { color: var(--muted); font-size: 0.85rem; padding: 20px 0; text-align: center; }
    table {
      width: 100%; border-collapse: collapse; background: var(--panel);
      border: 1px solid var(--border); border-radius: 8px; overflow: hidden; font-size: 0.88rem;
    }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; }
    th { color: var(--muted); font-weight: 600; background: #162033; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.84rem; }
    .badge {
      display: inline-block; padding: 2px 7px; border-radius: 999px;
      border: 1px solid var(--border); font-size: 0.78rem; background: #0f172a;
    }
  </style>
</head>
<body>
  <h1>Darkfactory Multi-Project Telemetry</h1>
  <div class="meta">Generated at: ${escapeHtml(snap.generated_at || 'N/A')} &middot; History points: ${escapeHtml(hist.length)}</div>

  <h2>Portfolio</h2>
  <div class="kpi-grid">
    <div class="kpi"><div class="kpi-label">Tasks (Closed / Total)</div><div class="kpi-value">${escapeHtml(p.closed_tasks ?? 0)} / ${escapeHtml(p.total_tasks ?? 0)}</div></div>
    <div class="kpi"><div class="kpi-label">Open Tasks</div><div class="kpi-value">${escapeHtml(p.open_tasks ?? 0)}</div></div>
    <div class="kpi"><div class="kpi-label">Completion Rate</div><div class="kpi-value">${escapeHtml(fmtPct(p.completion_rate))}</div></div>
    <div class="kpi"><div class="kpi-label">Median Wall-Clock</div><div class="kpi-value">${escapeHtml(fmtDuration(p.median_wall_clock_ms))}</div></div>
    <div class="kpi"><div class="kpi-label">1st-Round Pass Rate</div><div class="kpi-value">${escapeHtml(fmtPct(p.first_round_pass_rate))}</div></div>
    <div class="kpi"><div class="kpi-label">Avg Rework Rounds</div><div class="kpi-value">${escapeHtml(fmtNum(p.avg_rework_rounds))}</div></div>
    <div class="kpi"><div class="kpi-label">Tokens (in/out/cached)</div><div class="kpi-value" style="font-size:1rem">${escapeHtml(fmtUsage(p.tokens))}</div></div>
    <div class="kpi"><div class="kpi-label">Total Cost</div><div class="kpi-value">${escapeHtml(fmtCost(p.cost_usd))}</div></div>
  </div>

  <h2>Trends (history.jsonl)</h2>
  <div class="charts">
    ${renderTrendSvg(completionSeries, { title: 'Completion Rate', color: '#38bdf8', formatValue: fmtPct, maxFixed: 1 })}
    ${renderTrendSvg(passSeries, { title: '1st-Round Pass Rate', color: '#4ade80', formatValue: fmtPct, maxFixed: 1 })}
    ${renderTrendSvg(wallSeries, { title: 'Median Wall-Clock', color: '#f59e0b', formatValue: fmtDuration })}
    ${renderTrendSvg(costSeries, { title: 'Cost (USD)', color: '#c084fc', formatValue: fmtCost })}
  </div>

  <h2>Projects / Channels</h2>
  <table>
    <thead>
      <tr><th>Channel</th><th class="num">Total</th><th class="num">Closed</th><th class="num">Open</th><th class="num">Completion</th><th class="num">Median Wall-Clock</th><th class="num">1st-Round Pass</th><th class="num">Avg Rework</th><th class="num">Cost</th></tr>
    </thead>
    <tbody>${channelRows || '<tr><td colspan="9" class="empty">No channels</td></tr>'}</tbody>
  </table>

  <h2>Models / Providers</h2>
  <table>
    <thead>
      <tr><th>Model</th><th class="num">Runs</th><th class="num">1st-Round Pass</th><th class="num">Avg Rework</th><th class="num">Failures</th><th>Tokens (in/out/cached)</th><th class="num">Cost</th></tr>
    </thead>
    <tbody>${modelRows || '<tr><td colspan="7" class="empty">No models</td></tr>'}</tbody>
  </table>

  <h2>Tasks</h2>
  <table>
    <thead>
      <tr><th>Task</th><th>Channel</th><th>Title</th><th>Status</th><th class="num">Wall-Clock</th><th class="num">Rework</th><th>Models</th><th class="num">Cost</th></tr>
    </thead>
    <tbody>${taskRows || '<tr><td colspan="8" class="empty">No tasks</td></tr>'}</tbody>
  </table>

  <h2>History Log</h2>
  <table>
    <thead>
      <tr><th>Date</th><th class="num">Closed / Total</th><th class="num">Completion</th><th class="num">Median Wall-Clock</th><th class="num">1st-Round Pass</th><th class="num">Cost</th></tr>
    </thead>
    <tbody>${historyRows || '<tr><td colspan="6" class="empty">No history</td></tr>'}</tbody>
  </table>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// CLI entrypoint: snapshot | diff | dashboard
// ---------------------------------------------------------------------------

export async function runCli(argv = process.argv.slice(2), io = { stdout: console.log, stderr: console.error }) {
  const [command, ...rest] = argv;

  if (command === 'snapshot') {
    const { values } = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        'out-dir': { type: 'string' },
        date: { type: 'string' },
        telemetry: { type: 'string', multiple: true },
        'board-tasks': { type: 'string' },
        'board-url': { type: 'string' },
        'board-token': { type: 'string' },
        'bb-threads': { type: 'string' },
        'bb-project': { type: 'string' },
        'bb-cli': { type: 'boolean' },
        html: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    });

    if (!values['out-dir']) {
      io.stderr('Usage: node board_pipeline/telemetry-collector.mjs snapshot --out-dir <dir> [--date YYYY-MM-DD] [--telemetry <path>]... [--board-tasks <file>] [--board-url <url>] [--bb-threads <file>] [--bb-cli] [--html] [--json]');
      return 1;
    }

    const sources = {};
    if (values['board-tasks']) {
      sources.loadBoardTasks = () => loadBoardTasksFromFile(values['board-tasks']);
    } else if (values['board-url']) {
      sources.loadBoardTasks = () => loadBoardTasksFromApi({
        url: values['board-url'],
        token: values['board-token'] ?? process.env.BOARD_TOKEN ?? null,
      });
    }
    if (values['bb-threads']) {
      sources.loadBbThreads = () => loadBbThreadsFromFile(values['bb-threads']);
    } else if (values['bb-cli']) {
      sources.loadBbThreads = () => loadBbThreadsFromCli({ project: values['bb-project'] ?? null });
    }
    if (values.telemetry?.length) {
      sources.loadTelemetryLines = () => loadTelemetryLinesFromPaths(values.telemetry);
    }

    const snapshot = await collectTelemetry({ sources });
    const written = await writeSnapshot(snapshot, {
      outDir: values['out-dir'],
      date: values.date ?? null,
      writeHtml: values.html === true,
    });
    if (values.json) {
      io.stdout(JSON.stringify({ ...written, snapshot }, null, 2));
    } else {
      io.stdout(`Snapshot written: ${written.jsonPath}, ${written.mdPath}, ${written.historyPath}${written.htmlPath ? `, ${written.htmlPath}` : ''}`);
    }
    return 0;
  }

  if (command === 'diff') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
      },
    });
    if (positionals.length !== 2) {
      io.stderr('Usage: node board_pipeline/telemetry-collector.mjs diff <a.json> <b.json> [--json]');
      return 1;
    }
    const snapA = JSON.parse(await readFile(positionals[0], 'utf8'));
    const snapB = JSON.parse(await readFile(positionals[1], 'utf8'));
    const diff = diffSnapshots(snapA, snapB);
    if (values.json) io.stdout(JSON.stringify(diff, null, 2));
    else io.stdout(formatDiffMarkdown(diff));
    return 0;
  }

  if (command === 'dashboard') {
    const { values } = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        'out-dir': { type: 'string' },
        history: { type: 'string' },
        snapshot: { type: 'string' },
        out: { type: 'string' },
      },
    });
    const dir = values['out-dir'] ?? null;
    const historyPath = values.history ?? (dir ? join(dir, DEFAULT_HISTORY_FILE) : null);
    const outPath = values.out ?? (dir ? join(dir, 'dashboard.html') : null);
    let snapshotPath = values.snapshot ?? null;

    if (!outPath) {
      io.stderr('Usage: node board_pipeline/telemetry-collector.mjs dashboard --out-dir <dir> [--out <file.html>]');
      return 1;
    }
    const history = historyPath ? await readHistory(historyPath) : [];
    if (!snapshotPath && dir) {
      const lastEntryFile = history.length ? history[history.length - 1]?.snapshot_file : null;
      if (typeof lastEntryFile === 'string' && lastEntryFile) {
        try {
          const candidate = join(dir, sanitizeHistoryFile(lastEntryFile));
          const st = await lstat(candidate).catch(() => null);
          if (st?.isFile()) snapshotPath = candidate;
        } catch {
          // Игнорируем невалидное имя snapshot_file и переходим к fallback по каталогу.
        }
      }
      if (!snapshotPath) {
        const files = await readdir(dir).catch(() => []);
        const snaps = files.filter(f => f.startsWith('snapshot-') && f.endsWith('.json')).sort(compareSnapshotFilenames);
        if (snaps.length) snapshotPath = join(dir, snaps[snaps.length - 1]);
      }
    }
    const latestSnapshot = snapshotPath ? JSON.parse(await readFile(snapshotPath, 'utf8')) : null;
    await writeFile(outPath, renderTelemetryDashboardHtml(history, latestSnapshot), 'utf8');
    io.stdout(`Dashboard written: ${outPath}`);
    return 0;
  }

  io.stderr('Usage: node board_pipeline/telemetry-collector.mjs <snapshot|diff|dashboard> [options]');
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const code = await runCli();
  process.exitCode = code;
}
