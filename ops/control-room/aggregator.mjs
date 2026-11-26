// Control Room Aggregator (V2-3, Hybrid Variant B) — единый read-only
// владелец Unix socket (push-события контроллеров через event-bus.mjs) и
// HTTP/SSE сервера на 127.0.0.1:<port> (дефолт 44110, --port /
// DF_CONTROL_ROOM_PORT, 0 для ephemeral).
//
// READ-ONLY ПО УМОЛЧАНИЮ: только GET/HEAD (POST/PUT/PATCH/DELETE → 405), ноль
// mutating-запросов в Board, ноль записи в worktree/state. Host/Origin
// guard против DNS-rebinding/CSRF, строгий CSP, все недоверенные строки
// санитизируются. Единственное исключение — Authenticated Owner Write-API
// (POST /api/owner/answer|unblock|cancel): fail-closed, активно только при
// заданном ownerWriteToken И ownerActions port; constant-time Bearer check,
// строгий Origin/Host guard, тело ≤ 16 KiB, idempotency dedup.
//
// Агрегация по ключу (project, task_id, attempt_id, epoch):
//   - push-события Unix socket + хвост events.ndjson (ring-buffer ≤ 2000);
//   - read-only poll Board (boardTasksProvider);
//   - read-only BB threads (bbThreadsProvider) + гигиена сессий и
//     Шива-счётчик (lead_session_id → Set<task_id>, clean: count ≤ 1);
//   - Branch Drift индикатор (branchDriftProvider / branch-drift.mjs);
//   - netHealth + telemetry провайдеры.
// Только Node stdlib.

import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { normalizeEvent } from '../../board_pipeline/event-bus.mjs';
import { inspectWorktreesAndBranches } from '../../board_pipeline/branch-drift.mjs';
import { isAllowedHost, isAllowedOrigin, isAllowedFetchSite, sanitizeTerminalText,
  SECURITY_HEADERS } from './origin-guard.mjs';
import { createNetHealthMonitor } from './net-health.mjs';
import { createFinopsProvider } from './finops.mjs';
import { loadModelRegistry, registrySnapshot } from '../../board_pipeline/model-registry.mjs';
import { collectTelemetry } from '../../board_pipeline/telemetry-collector.mjs';
import { normalizeCost, normalizeUsage, parseTelemetryLines } from '../../board_pipeline/telemetry.mjs';
import { modelKey, normalizeDomain, normalizeSize, roleInvoked,
  SCORE_ROLES, SCORECARD_SCHEMA } from '../../board_pipeline/model-scorecard.mjs';
import { buildAdaptiveGatesSummary } from '../../board_pipeline/adaptive-gates.mjs';

const execFileAsync = promisify(execFile);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(MODULE_DIR, 'web');

export const DEFAULT_PORT = 44110;
export const RING_LIMIT = 2000;
const TERMINAL = new Set(['done', 'hold', 'uncertain', 'lease_lost', 'completed']);
const MAX_SSE_CLIENTS = 32;
const MAX_BODY_BYTES = 0; // тело не читается никогда (GET/HEAD only)

const jsonHeaders = extra => ({
  'Content-Type': 'application/json; charset=utf-8',
  ...SECURITY_HEADERS, ...extra });

// --- Authenticated Owner Write-API (fail-closed) ------------------------------
//
// Интерактивные действия владельца из Herdr Desktop/Mobile (и будущего
// Telegram/Iva-моста). Write API существует только когда заданы И
// ownerWriteToken, И ownerActions port — иначе любой POST /api/owner/*
// отвечает 403 write_api_disabled, сохраняя read-only дефолт. Bearer-токен
// сравнивается через SHA-256 + timingSafeEqual (constant-time, без утечки
// длины). Idempotency-дедупликация по (endpoint, taskId, idempotencyKey):
// повторный double-click или параллельная отправка из Herdr+Telegram
// возвращает закэшированный ответ без повторного вызова ownerActions.
export const OWNER_WRITE_MAX_BODY_BYTES = 16 * 1024;
export const OWNER_IDEMPOTENCY_TTL_MS = 600_000;
export const OWNER_IDEMPOTENCY_MAX_ENTRIES = 256;
const OWNER_TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OWNER_ENDPOINTS = new Map([
  ['/api/owner/answer', 'answer'],
  ['/api/owner/unblock', 'unblock'],
  ['/api/owner/cancel', 'cancel'],
]);

function bearerTokenEqual(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' ||
      !presented || !expected) return false;
  // SHA-256 выравнивает длину обеих сторон: timingSafeEqual не раскрывает
  // ни длину токена, ни позицию первого несовпадения.
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export const OWNER_WRITE_BODY_TIMEOUT_MS = 10_000;

// Тело читается с жёстким потолком и коротким таймаутом. Переполнение или
// зависший поток отклоняются немедленно, а request разрушается: медленный
// клиент не может удерживать память/сокет Control Room неограниченно долго.
export function readRequestBody(req, limit, { onDestroy } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const destroyWith = error => {
      finish(reject, error);
      // HTTP-handler может синхронно поставить короткий отказ в socket до
      // destroy; само чтение при этом прекращается в том же data/tick.
      try { onDestroy?.(error); } catch { /* noop */ }
      req.destroy();
    };
    const timer = setTimeout(() => {
      destroyWith(Object.assign(new Error('body_read_timeout'), { code: 'body_read_timeout' }));
    }, OWNER_WRITE_BODY_TIMEOUT_MS);
    timer.unref?.();
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        destroyWith(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', error => finish(reject, error));
  });
}

// --- провайдеры по умолчанию (read-only) -------------------------------------

// Board 0.54.0 монтирует HTTP API под /api/board. База нормализуется,
// поэтому 'http://127.0.0.1:44100' и 'http://127.0.0.1:44100/api/board'
// указывают на один endpoint.
export const BOARD_API_PATH = '/api/board';

export function normalizeBoardBaseUrl(boardUrl) {
  if (typeof boardUrl !== 'string' || !boardUrl.trim()) {
    throw new TypeError('boardUrl is required');
  }
  const url = new URL(boardUrl.trim());
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith(BOARD_API_PATH)) url.pathname = `${pathname}${BOARD_API_PATH}`;
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/, '');
}

function jsonObject(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// RO-опрос Board :44100 — только GET чтение очереди. Сбой чтения —
// явная ошибка (не тихий []): вызывающий видит причину, а не пустую
// очередь.
export async function loadBoardTasksFromApi(boardUrl, { fetchImpl, token = null,
  channel = 'darkfactory', timeoutMs = 5000 } = {}) {
  const observer = createBoardObserver({ boardUrl, token, channels: [channel],
    fetchImpl, timeoutMs });
  const result = await observer.fetchTasks();
  if (!result.ok) {
    throw Object.assign(
      new Error(`board read failed: ${result.error ?? result.code ?? 'unknown'}`),
      { code: result.code ?? 'board_fetch_failed', status: result.status ?? null });
  }
  return result.tasks;
}

// RO-наблюдатель Board 0.54.0: строго GET, профиль control-room-observer,
// capability <channel>=read. Board 0.54.0 не имеет GET /channels/<ch>:
// единственный источник — GET /tasks?channel=<ch>&limit=500 с реальным
// форматом { tasks: [{ message: { id, channel, text, labels, task,
// ... }, replies, last }] }; упрощённый вид { message: { state, ... } }
// тоже принимается (совместимость с тестовыми объектами).
// Сбои (401/403, 404, не-JSON, упавший fetch) не глотаются: fetchTasks()
// возвращает { ok: false, tasks, status, code, error }, что видно в
// снапшоте как boardStatus. Ответ {"version":"0.54.0","sync":[]} без
// задач — корректный пустой срез, а не сбой.
export function createBoardObserver({ boardUrl, token = null,
  channels = ['darkfactory'], fetchImpl, timeoutMs = 5000 } = {}) {
  const fetcher = fetchImpl ?? fetch;
  const channelList = (Array.isArray(channels) ? channels : [channels])
    .filter(c => typeof c === 'string' && c);
  if (!channelList.length) throw new Error('board observer requires a channel');
  const base = normalizeBoardBaseUrl(boardUrl);
  const headers = {
    accept: 'application/json',
    'x-board-profile': 'control-room-observer',
    'x-board-can': channelList.map(c => `${c}=read`).join(';'),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  // Одна страница канала → либо { ok: true, status, body }, либо явный сбой.
  const readPage = async (channel, cursor = null) => {
    let res;
    const cursorQuery = cursor === null ? '' : `&after=${encodeURIComponent(String(cursor))}`;
    try {
      res = await fetcher(
        `${base}/tasks?channel=${encodeURIComponent(channel)}&limit=500${cursorQuery}`,
        { method: 'GET', headers, redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return { ok: false, status: null, code: 'board_fetch_failed',
        error: `board fetch failed: ${error?.message ?? error}` };
    }
    const status = Number.isSafeInteger(res?.status) ? res.status : null;
    if (res?.ok !== true) {
      const code = status === 401 || status === 403 ? 'board_unauthorized'
        : status === 404 ? 'board_not_found' : 'board_http_error';
      return { ok: false, status, code,
        error: `GET /tasks → ${status ?? 'request failed'} (${code})` };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (body === undefined || body === null) {
      const type = typeof res.headers?.get === 'function'
        ? res.headers.get('content-type') : null;
      return { ok: false, status, code: 'board_not_json',
        error: `GET /tasks → не JSON (content-type: ${type ?? 'unknown'})` };
    }
    return { ok: true, status, body };
  };

  // Board отдаёт cursor следующей страницы; повтор/пустая страница — конец,
  // а жёсткий bound защищает наблюдателя от бесконечного потока.
  const readChannel = async channel => {
    const maxPages = 100;
    const seen = new Set();
    const tasks = [];
    let cursor = null;
    let status = 200;
    let firstBody = null;
    for (let page = 0; page < maxPages; page++) {
      const outcome = await readPage(channel, cursor);
      if (!outcome.ok) return outcome;
      status = outcome.status;
      firstBody ??= outcome.body;
      const body = outcome.body;
      const entries = Array.isArray(body?.tasks) ? body.tasks
        : Array.isArray(body) ? body : [];
      tasks.push(...entries);
      const next = body?.cursor ?? body?.next_cursor ?? body?.nextCursor ?? null;
      if ((next !== null && typeof next !== 'string' && typeof next !== 'number') ||
          next === null || next === '' || !entries.length || seen.has(String(next))) {
        return { ok: true, status, body: { ...(firstBody && typeof firstBody === 'object' ? firstBody : {}), tasks } };
      }
      seen.add(String(next));
      cursor = String(next);
    }
    return { ok: false, status, code: 'board_pagination_exceeded',
      error: `GET /tasks → cursor pagination exceeded ${maxPages} pages` };
  };

  const toTask = raw => {
    const message = raw?.message ?? raw;
    if (!message || typeof message !== 'object') return null;
    const task = message.task ?? (message.state ? message : null);
    if (!task || typeof task.state !== 'string') return null;
    const labels = message.labels ?? task.labels ?? {};
    const result = jsonObject(task.result) ?? {};
    const updatedAt = task.updatedAt ?? task.updated_at ?? message.updatedAt ??
      message.updated_at ?? (typeof raw?.last === 'string' ? raw.last : raw?.last?.ts ?? raw?.last?.updatedAt);
    const receiptSha = task.receiptSha ?? task.receipt_sha ?? result.sha ?? result.candidate_sha ??
      result.receiptSha ?? result.receipt_sha ?? labels.receipt_sha ?? labels.receiptSha;
    return {
      task_id: task.task_id ?? message.id ?? task.id,
      state: task.state,
      title: task.title ?? String(message.text ?? '').split('\n')[0] ?? '',
      labels,
      epoch: task.epoch ?? null,
      channel: message.channel ?? null,
      ...(task.priority !== undefined || labels.priority !== undefined
        ? { priority: task.priority ?? labels.priority } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(receiptSha !== undefined ? { receiptSha } : {}),
      ...(task.blocked ? { blocked: task.blocked } : {}),
      ...(task.executor ? { executor: task.executor } : {}),
      ...(task.question ? { question: task.question } : {}),
      ...(task.reason ? { reason: task.reason } : {}),
    };
  };

  // Явный результат чтения: { ok, tasks, status, code, error }.
  const fetchTasks = async () => {
    const found = new Map();
    let failure = null;
    for (const channel of channelList) {
      const outcome = await readChannel(channel);
      if (!outcome.ok) {
        failure ??= { ...outcome, channel };
        continue;
      }
      const body = outcome.body;
      const entries = Array.isArray(body?.tasks) ? body.tasks
        : Array.isArray(body) ? body : [];
      for (const entry of entries) {
        const task = toTask(entry);
        if (task?.task_id != null) found.set(String(task.task_id), task);
      }
    }
    const tasks = [...found.values()];
    if (failure) {
      return { ok: false, tasks, status: failure.status, code: failure.code,
        error: `${failure.error} (channel ${failure.channel})` };
    }
    return { ok: true, tasks, status: 200, code: null, error: null };
  };

  // История вызовов: наблюдённые задачи (совместимость с провайдером).
  const observer = async () => (await fetchTasks()).tasks;
  observer.fetchTasks = fetchTasks;
  observer.boardUrl = base;
  observer.channels = [...channelList];
  return observer;
}

// Провайдер задач возвращает либо массив (упрощённый/тестовый вид), либо
// результат observer.fetchTasks(). Второй случай сохраняет явный статус:
// сбой Board виден в снапшоте (boardStatus.ok === false), а сервер
// остаётся read-only и продолжает отвечать 200.
async function readBoardTasks(provider) {
  let result;
  try {
    result = await provider();
  } catch (error) {
    return { tasks: [], boardStatus: { ok: false, status: null,
      code: error?.code ?? 'board_fetch_failed',
      error: sanitizeTerminalText(String(error?.message ?? error ?? 'board fetch failed')) } };
  }
  if (Array.isArray(result)) {
    return { tasks: result, boardStatus: { ok: true, status: 200, code: null, error: null } };
  }
  if (result && Array.isArray(result.tasks)) {
    const success = result.ok !== false;
    return { tasks: result.tasks, boardStatus: {
      ok: success,
      status: Number.isSafeInteger(result.status) ? result.status : null,
      code: success ? null : (result.code ?? 'board_error'),
      error: success ? null
        : sanitizeTerminalText(String(result.error ?? result.code ?? 'board error')) } };
  }
  return { tasks: [], boardStatus: { ok: false, status: null,
    code: 'board_bad_provider', error: 'board provider returned no task list' } };
}

// TTL-кэшированный провайдер Branch Drift по списку репозиториев:
// агрегирует unmergedBranches/dirtyWorktrees/bbThreadWorktrees. Ошибка
// инспекции репо — fail-closed (driftDetected: true + repo error).
export function createBranchDriftProvider(repos, {
  ttlMs = 20_000, execGit, now = () => Date.now() } = {}) {
  let cached = null;
  let cachedAt = -Infinity;
  return async () => {
    if (cached && now() - cachedAt < ttlMs) return cached;
    const merged = { driftDetected: false, repos: [], unmergedBranches: [],
      dirtyWorktrees: [], bbThreadWorktrees: [] };
    for (const repoDir of repos) {
      try {
        const report = await inspectWorktreesAndBranches({ repoDir, execGit });
        merged.repos.push({ repoDir, ok: report.ok });
        for (const k of ['unmergedBranches', 'dirtyWorktrees', 'bbThreadWorktrees']) {
          merged[k].push(...report[k].map(e => ({ ...e, repoDir })));
        }
        if (report.driftDetected) merged.driftDetected = true;
      } catch (error) {
        // Недоступная проверка — не «чисто»: индикатор горит.
        merged.repos.push({ repoDir, ok: false,
          error: sanitizeTerminalText(error.message) });
        merged.driftDetected = true;
      }
    }
    cached = merged;
    cachedAt = now();
    return merged;
  };
}

export const DEFAULT_TELEMETRY_DIR = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'darkfactory', 'telemetry');
export const TELEMETRY_MAX_BYTES = 1024 * 1024;
export const TELEMETRY_MAX_FILES = 32;


const textValue = value => typeof value === 'string' && value.trim()
  ? sanitizeTerminalText(value.trim()) : null;
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const timeValue = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};
const firstText = (...values) => values.map(textValue).find(value => value !== null) ?? null;
const firstNumber = (...values) => values.map(finiteNumber).find(value => value !== null) ?? null;

function copyUsage(raw) {
  const usage = normalizeUsage(raw);
  return usage ? { input: usage.input, output: usage.output, cached: usage.cached } : null;
}

function copyModel(raw) {
  if (typeof raw === 'string' && raw.trim()) {
    const value = sanitizeTerminalText(raw.trim());
    const slash = value.indexOf('/');
    return slash > 0 && slash < value.length - 1
      ? { provider: value.slice(0, slash), model: value.slice(slash + 1) }
      : { provider: null, model: value };
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const provider = textValue(raw.provider);
    const model = textValue(raw.model ?? raw.id ?? raw.model_id);
    if (provider || model) return { provider, model };
  }
  return { provider: null, model: null };
}

function compactTelemetryAttempt(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const taskId = firstText(entry.task_id, entry.taskId, entry.id);
  if (!taskId) return null;
  const startedMs = timeValue(entry.started_at ?? entry.startedAt ?? entry.created_at ?? entry.createdAt);
  const endedMs = timeValue(entry.ended_at ?? entry.endedAt ?? entry.completed_at ?? entry.completedAt);
  const objectValue = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const rawPhases = objectValue(entry.phases_ms) ?? objectValue(entry.phasesMs) ?? {};
  const phaseFailures = {};
  const phasesMs = Object.fromEntries(Object.entries(rawPhases)
    .map(([key, value]) => {
      if (value === null) return [key, null];
      const elapsed = finiteNumber(value) ?? finiteNumber(value?.ms) ?? finiteNumber(value?.elapsedMs);
      if (elapsed === null) return null;
      const failureMarker = marker => marker === true ||
        (typeof marker === 'string' && /fail|error|hold|rework/i.test(marker)) ||
        (finiteNumber(marker) ?? 0) > 0;
      const failed = value !== null && typeof value === 'object' && !Array.isArray(value) &&
        (failureMarker(value.failed) || failureMarker(value.fail) || failureMarker(value.failures) ||
          failureMarker(value.status) || failureMarker(value.outcome));
      if (failed) phaseFailures[key] = true;
      return [key, Number(elapsed)];
    })
    .filter(Boolean));
  for (const source of [entry.phase_failures, entry.phaseFailures, entry.failed_phases, entry.failedPhases]) {
    if (Array.isArray(source)) {
      for (const key of source) if (typeof key === 'string') phaseFailures[key] = true;
    } else if (objectValue(source)) {
      for (const [key, value] of Object.entries(source)) {
        if (value === true || (typeof value === 'string' && /fail|error|hold|rework/i.test(value)) ||
            (finiteNumber(value) ?? 0) > 0) phaseFailures[key] = true;
      }
    }
  }
  const rawRounds = objectValue(entry.rounds);
  const rounds = rawRounds
    ? {
        total: finiteNumber(rawRounds.total),
        rework: finiteNumber(rawRounds.rework),
        pass: finiteNumber(rawRounds.pass),
        arbitration: finiteNumber(rawRounds.arbitration),
        open: finiteNumber(rawRounds.open),
        gates: objectValue(rawRounds.gates) ? { ...rawRounds.gates } : {},
      }
    : { total: null, rework: null, pass: null, arbitration: null, open: null, gates: {} };
  const reworkRounds = finiteNumber(rounds.rework) ?? firstNumber(entry.rework_rounds, entry.reworkRounds);
  if (rounds.rework === null) rounds.rework = reworkRounds;
  const roleCost = role => normalizeCost(entry.costs?.[role]);
  const roleCosts = [roleCost('worker'), roleCost('critic'), roleCost('arbiter')].filter(v => v !== null);
  const roleCostTotal = roleCosts.length ? roleCosts.reduce((a, b) => a + b, 0) : null;
  const labels = entry.labels !== null && typeof entry.labels === 'object' && !Array.isArray(entry.labels)
    ? entry.labels : {};
  return {
    taskId,
    attemptId: firstText(entry.attempt_id, entry.attemptId),
    epoch: Number.isSafeInteger(entry.epoch) ? entry.epoch : null,
    channel: firstText(entry.channel, entry.project, labels.channel),
    title: firstText(entry.title),
    repoId: firstText(entry.repo_id, entry.repoId, labels.repo_id, labels.project),
    outcome: firstText(entry.outcome),
    open: entry.open === true,
    startedAt: startedMs === null ? null : new Date(startedMs).toISOString(),
    endedAt: endedMs === null ? null : new Date(endedMs).toISOString(),
    elapsedMs: finiteNumber(phasesMs.total) ?? firstNumber(entry.elapsed_ms, entry.elapsedMs) ??
      (startedMs !== null && endedMs !== null && endedMs >= startedMs ? endedMs - startedMs : null),
    phasesMs,
    phaseFailures,
    rounds,
    reworkRounds,
    reason: firstText(entry.reason),
    models: {
      worker: copyModel(entry.models?.worker),
      critic: copyModel(entry.models?.critic),
      arbiter: copyModel(entry.models?.arbiter),
    },
    tokens: {
      worker: copyUsage(entry.tokens?.worker),
      critic: copyUsage(entry.tokens?.critic),
      arbiter: copyUsage(entry.tokens?.arbiter),
    },
    costUsd: normalizeCost(entry) ?? roleCostTotal,
    threadId: firstText(entry.thread_id, entry.bb_thread_id, entry.threadId, entry.bbThreadId),
  };
}

async function readTailText(path, maxBytes, size) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isFinite(size) || size <= 0) return '';
  const bytes = Math.floor(maxBytes);
  if (bytes <= 0) return '';
  const start = Math.max(0, size - bytes);
  const chunks = [];
  const stream = createReadStream(path, { start: start > 0 ? start - 1 : 0, end: size - 1 });
  for await (const chunk of stream) chunks.push(chunk);
  let buffer = Buffer.concat(chunks);
  if (start > 0) {
    const precededByNewline = buffer[0] === 10;
    buffer = buffer.subarray(1);
    let text = buffer.toString('utf8');
    if (!precededByNewline) {
      const firstBreak = /\r?\n/.exec(text);
      if (!firstBreak) return '';
      text = text.slice(firstBreak.index + firstBreak[0].length);
    }
    return text;
  }
  return buffer.toString('utf8');
}

// Entries-only analogue of aggregateScorecard(lines, { seed: [] }). Telemetry
// JSONL is parsed exactly once by createTelemetryProvider; collector,
// scorecard and compact attempts all share the same parsed entries instead of
// reparsing the same strings for every snapshot.
function telemetryFirstPassOf(entry) {
  return entry.open !== true && entry.outcome === 'done' && (entry.rounds?.rework ?? 0) === 0;
}

function telemetryIsClosed(entry) {
  return entry.open !== true;
}

function telemetryTokensPerRound(entry, role) {
  const usage = entry.tokens?.[role];
  const rounds = entry.rounds?.total;
  if (usage === null || typeof usage !== 'object' ||
      !Number.isFinite(rounds) || rounds < 1) return null;
  if (usage.input == null && usage.output == null) return null;
  const sum = (usage.input ?? 0) + (usage.output ?? 0);
  return Number.isFinite(sum) ? sum / rounds : null;
}

const emptyTelemetryScoreCell = () => ({
  n: 0, seed_n: 0,
  pass_n: 0, first_pass: 0,
  rounds_sum: 0, rounds_n: 0,
  wall_sum: 0, wall_n: 0,
  token_sum: 0, token_n: 0,
  catch_n: 0, caught: 0,
});

function addTelemetryScore(cell, { firstPass, rounds, wallMs, tokens, caught }) {
  cell.n += 1;
  if (firstPass !== null) { cell.pass_n += 1; if (firstPass) cell.first_pass += 1; }
  if (Number.isFinite(rounds)) { cell.rounds_sum += rounds; cell.rounds_n += 1; }
  if (Number.isFinite(wallMs)) { cell.wall_sum += wallMs; cell.wall_n += 1; }
  if (Number.isFinite(tokens)) { cell.token_sum += tokens; cell.token_n += 1; }
  if (caught !== null) { cell.catch_n += 1; if (caught) cell.caught += 1; }
}

function finalizeTelemetryScore(cell, meta) {
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

function aggregateTelemetryScorecardEntries(entries, corrupt = 0) {
  const buckets = new Map();
  const report = { schema: SCORECARD_SCHEMA, corrupt, entries: 0, cells: {} };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind !== 'attempt_summary') continue;
    report.entries += 1;
    const domain = normalizeDomain(entry?.labels?.domain ?? entry?.domain);
    const size = normalizeSize(entry?.labels?.size ?? entry?.size);
    const firstPass = telemetryFirstPassOf(entry);
    const rounds = Number.isFinite(entry.rounds?.total) ? entry.rounds.total : null;
    const wallMs = Number.isFinite(entry.phases_ms?.total) ? entry.phases_ms.total : null;
    for (const role of SCORE_ROLES) {
      const model = entry.models?.[role];
      const key = modelKey(model);
      if (key === null || !roleInvoked(entry, role)) continue;
      const phaseKey = role === 'critic' ? 'l2_critic' : role === 'arbiter' ? 'arbiter' : null;
      const roleWallMs = phaseKey !== null && Number.isFinite(entry.phases_ms?.[phaseKey])
        ? entry.phases_ms[phaseKey] : wallMs;
      const id = `${key}|${role}|${domain}|${size}`;
      const slot = buckets.get(id) ?? { cell: emptyTelemetryScoreCell(),
        meta: { model: { provider: model.provider, model: model.model }, role, domain, size } };
      addTelemetryScore(slot.cell, {
        firstPass: telemetryIsClosed(entry) ? firstPass : null,
        rounds,
        wallMs: roleWallMs,
        tokens: telemetryTokensPerRound(entry, role),
        caught: role === 'critic' ? (entry.rounds?.gates?.l2 ?? 0) > 0 : null,
      });
      buckets.set(id, slot);
    }
  }
  for (const [id, slot] of [...buckets.entries()].sort(([a], [b]) => a < b ? -1 : 1)) {
    report.cells[id] = finalizeTelemetryScore(slot.cell, slot.meta);
  }
  return report;
}

function boundedCacheSet(map, key, value, maxEntries) {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) map.delete(map.keys().next().value);
}

// Safe read-only telemetry provider. It reads only regular telemetry*.jsonl
// files, caps both file count and per-file tail bytes, ignores corrupt JSONL
// rows, and returns null when no valid run record exists. Missing directories
// and filesystem races are observation gaps, never server failures.
// Parsed file tails are cached by path+mtime+size; unchanged rotated journals
// are not parsed again on every 5s poll.
export function createTelemetryProvider({
  telemetryDir,
  stateDirs = [],
  maxBytes = TELEMETRY_MAX_BYTES,
  maxFiles = TELEMETRY_MAX_FILES,
  now = () => Date.now(),
} = {}) {
  const fileCache = new Map();
  const resultCache = new Map();
  return async () => {
    try {
      const validDirectory = async dir => {
        if (typeof dir !== 'string' || !dir) return false;
        const dirStat = await lstat(dir).catch(() => null);
        return Boolean(dirStat?.isDirectory() && !dirStat.isSymbolicLink());
      };
      const explicitTelemetryDir = telemetryDir !== undefined;
      const primaryDir = telemetryDir ?? process.env.DF_TELEMETRY_DIR ?? DEFAULT_TELEMETRY_DIR;
      const directories = [];
      if (await validDirectory(primaryDir)) directories.push(primaryDir);
      // Без явного telemetryDir дефолт — только первый кандидат: stateDirs
      // остаются источниками даже если общий дефолт существует. Явно заданный
      // путь использует stateDirs только когда сам missing/invalid.
      if (!explicitTelemetryDir || !directories.length) {
        for (const dir of Array.isArray(stateDirs) ? stateDirs : []) {
          if (await validDirectory(dir) && !directories.includes(dir)) directories.push(dir);
        }
      }
      if (!directories.length) return null;

      const files = [];
      for (const dir of directories) {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isFile() && entry.name.startsWith('telemetry') && entry.name.endsWith('.jsonl')) {
            files.push({ dir, name: entry.name });
          }
        }
      }
      files.sort((a, b) => join(a.dir, a.name).localeCompare(join(b.dir, b.name)));
      const numericMaxFiles = Number(maxFiles);
      const fileLimit = Number.isFinite(numericMaxFiles)
        ? Math.max(0, Math.floor(numericMaxFiles)) : TELEMETRY_MAX_FILES;
      const selected = fileLimit ? files.slice(-fileLimit) : [];
      if (!selected.length) return null;

      const parsedFiles = [];
      let latestMtimeMs = 0;
      for (const file of selected) {
        const path = join(file.dir, file.name);
        const fileStat = await lstat(path).catch(() => null);
        if (!fileStat?.isFile() || fileStat.isSymbolicLink()) continue;
        latestMtimeMs = Math.max(latestMtimeMs, fileStat.mtimeMs);
        const signature = `${fileStat.mtimeMs}:${fileStat.size}`;
        let cached = fileCache.get(path);
        if (!cached || cached.signature !== signature) {
          const text = await readTailText(path, maxBytes, fileStat.size).catch(() => '');
          const lines = [];
          for (const line of text.split(/\r?\n/)) if (line.trim()) lines.push(line);
          const parsed = parseTelemetryLines(lines);
          cached = { signature, entries: parsed.entries, corrupt: parsed.corrupt,
            mtimeMs: fileStat.mtimeMs, size: fileStat.size };
        }
        boundedCacheSet(fileCache, path, cached, Math.max(fileLimit, 8));
        parsedFiles.push({ path, ...cached });
      }
      if (!parsedFiles.length) return null;

      const cacheKey = parsedFiles.map(file =>
        `${file.path}:${file.mtimeMs}:${file.size}`).join('\n');
      const cachedResult = resultCache.get(cacheKey);
      if (cachedResult !== undefined) return cachedResult;

      const entries = parsedFiles.flatMap(file => file.entries);
      const corrupt = parsedFiles.reduce((sum, file) => sum + file.corrupt, 0);
      const collected = await collectTelemetry({ telemetryRuns: entries, clock: now });
      if (!collected.sources.telemetry_runs) {
        boundedCacheSet(resultCache, cacheKey, null, 8);
        return null;
      }
      const scorecard = aggregateTelemetryScorecardEntries(entries, corrupt);
      const result = {
        runs: collected.sources.telemetry_runs,
        attempts: entries.map(compactTelemetryAttempt).filter(Boolean).slice(-128),
        firstRoundPassRate: collected.portfolio.first_round_pass_rate,
        avgReworkRounds: collected.portfolio.avg_rework_rounds,
        medianWallClockMs: collected.portfolio.median_wall_clock_ms,
        models: scorecard.cells,
        updatedAt: latestMtimeMs
          ? new Date(latestMtimeMs).toISOString()
          : collected.generated_at,
      };
      boundedCacheSet(resultCache, cacheKey, result, 8);
      return result;
    } catch {
      return null;
    }
  };
}

// --- fleet telemetry -----------------------------------------------------------

export const FLEET_STALE_MS = 900_000;
export const FLEET_MAX_FILE_BYTES = 64 * 1024;
const FLEET_NUMERIC_FIELDS = ['uptimeSec', 'cpuCores', 'load1m', 'memTotalMb',
  'memUsedMb', 'memPct', 'diskTotalGb', 'diskUsedGb', 'diskPct'];

const nowMilliseconds = now => {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  return timeValue(value) ?? Date.now();
};

const roundMetric = value => Number(value.toFixed(4));

// Normalize one collector record. Records with missing, non-finite, negative,
// or semantically impossible core fields are observation noise and are dropped
// by the caller; a partial host object must never become a confident metric.
export function normalizeFleetHost(raw, nowMs = Date.now()) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const host = textValue(raw.host);
  if (!host || typeof raw.ts !== 'string' || !raw.ts.trim()) return null;
  const tsMs = timeValue(raw.ts);
  if (tsMs === null) return null;
  const metrics = {};
  for (const field of FLEET_NUMERIC_FIELDS) {
    const value = finiteNumber(raw[field]);
    if (value === null || value < 0) return null;
    metrics[field] = value;
  }
  if (!Number.isSafeInteger(metrics.cpuCores) || metrics.cpuCores <= 0 ||
      metrics.memTotalMb <= 0 || metrics.diskTotalGb <= 0) return null;
  if (metrics.memPct > 100 || metrics.diskPct > 100) return null;
  if (metrics.memUsedMb > metrics.memTotalMb || metrics.diskUsedGb > metrics.diskTotalGb) return null;

  const ageMs = nowMs - tsMs;
  const ageSec = Math.floor(ageMs / 1000);
  const stale = ageMs > FLEET_STALE_MS;
  const loadThreshold = metrics.cpuCores * 1.5;
  const alerts = [];
  if (metrics.memPct >= 85) alerts.push(`memory usage ${metrics.memPct}% >= 85%`);
  if (metrics.diskPct >= 85) alerts.push(`disk usage ${metrics.diskPct}% >= 85%`);
  if (metrics.load1m >= loadThreshold) {
    alerts.push(`load1m ${metrics.load1m} >= ${roundMetric(loadThreshold)} (cpuCores * 1.5)`);
  }
  if (stale) alerts.push(`host telemetry stale: age ${ageSec}s > 900s`);

  return {
    host,
    ts: textValue(raw.ts) ?? new Date(tsMs).toISOString(),
    ageSec,
    stale,
    uptimeSec: metrics.uptimeSec,
    cpuCores: metrics.cpuCores,
    load1m: metrics.load1m,
    memTotalMb: metrics.memTotalMb,
    memUsedMb: metrics.memUsedMb,
    memPct: metrics.memPct,
    diskTotalGb: metrics.diskTotalGb,
    diskUsedGb: metrics.diskUsedGb,
    diskPct: metrics.diskPct,
    alerts,
  };
}

// Read bounded regular *.json files only. Missing directories, symlinks,
// malformed JSON, oversized files, and filesystem races all degrade to skipped
// records because fleet telemetry is observational, never a control-plane input.
export async function readFleetTelemetryFiles(fleetDir, {
  maxFileBytes = FLEET_MAX_FILE_BYTES } = {}) {
  if (typeof fleetDir !== 'string' || !fleetDir) return [];
  const dirStat = await lstat(fleetDir).catch(() => null);
  if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) return [];
  const entries = await readdir(fleetDir, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort();
  const records = [];
  for (const name of names) {
    const path = join(fleetDir, name);
    const fileStat = await lstat(path).catch(() => null);
    if (!fileStat?.isFile() || fileStat.isSymbolicLink() || fileStat.size > maxFileBytes) continue;
    try {
      records.push(JSON.parse(await readFile(path, 'utf8')));
    } catch { /* malformed host snapshot is ignored */ }
  }
  return records;
}

export function createFleetHostsProvider({ fleetDir = null, now = () => Date.now(),
  maxFileBytes = FLEET_MAX_FILE_BYTES } = {}) {
  return async () => {
    const nowMs = nowMilliseconds(now);
    const records = await readFleetTelemetryFiles(fleetDir, { maxFileBytes });
    return records
      .map(record => normalizeFleetHost(record, nowMs))
      .filter(Boolean)
      .sort((a, b) => a.host.localeCompare(b.host));
  };
}

function hostFleetAnomalies(host) {
  const anomalies = [];
  const push = (kind, message, metric, threshold) => anomalies.push({
    kind, severity: 'warn', host: host.host, message, metric, threshold });
  if (host.memPct >= 85) {
    push('memory_pressure', `${host.host}: memory usage ${host.memPct}% >= 85%`, host.memPct, 85);
  }
  if (host.diskPct >= 85) {
    push('disk_pressure', `${host.host}: disk usage ${host.diskPct}% >= 85%`, host.diskPct, 85);
  }
  const loadThreshold = roundMetric(host.cpuCores * 1.5);
  if (host.load1m >= host.cpuCores * 1.5) {
    push('load_pressure', `${host.host}: load1m ${host.load1m} >= ${loadThreshold}`,
      host.load1m, loadThreshold);
  }
  if (host.stale) {
    push('host_stale', `${host.host}: telemetry age ${host.ageSec}s exceeds 900s`,
      host.ageSec, 900);
  }
  return anomalies;
}

function liveFactoryBurnRate(activeTrees, telemetry) {
  const direct = firstNumber(telemetry?.burnRatePerHrUsd, telemetry?.hourlyBurnUsd,
    telemetry?.liveFactory?.burnRatePerHrUsd, telemetry?.liveFactoryBurnRatePerHrUsd);
  if (direct !== null && direct >= 0) return roundMetric(direct);
  const liveTrees = (Array.isArray(activeTrees) ? activeTrees : [])
    .filter(tree => ['running', 'rework'].includes(tree?.status));
  return roundMetric(liveTrees.reduce((sum, tree) =>
    sum + (finiteNumber(tree?.burnRatePerHr) ?? 0), 0));
}

function recentReworkStats(telemetry) {
  const attempts = Array.isArray(telemetry?.attempts) ? telemetry.attempts : [];
  const runCount = finiteNumber(telemetry?.runs) ?? attempts.length;
  if (runCount < 3) return null;
  const direct = firstNumber(telemetry?.reworkRatio, telemetry?.reworkRate,
    telemetry?.rework_rate, telemetry?.recentReworkRatio);
  if (direct !== null && direct >= 0 && direct <= 1) return { ratio: direct, runCount };
  let evaluatedRuns = 0;
  let reworkedRuns = 0;
  for (const attempt of attempts.slice(-32)) {
    const rework = finiteNumber(attempt?.rounds?.rework);
    if (rework === null) continue;
    evaluatedRuns += 1;
    if (rework > 0) reworkedRuns += 1;
  }
  if (evaluatedRuns < 3) return null;
  return { ratio: reworkedRuns / evaluatedRuns, runCount: evaluatedRuns };
}

// Pure fleet/cost anomaly composition, kept separate from filesystem reads so
// boundary values and repeated invocation are deterministic under test.
export function buildFleetTelemetry({ hosts = [], telemetry = null, activeTrees = [] } = {}) {
  const normalizedHosts = (Array.isArray(hosts) ? hosts : [])
    .filter(host => host !== null && typeof host === 'object')
    .sort((a, b) => String(a.host ?? '').localeCompare(String(b.host ?? '')));
  const anomalies = normalizedHosts.flatMap(hostFleetAnomalies);

  const hourlyBurnUsd = liveFactoryBurnRate(activeTrees, telemetry);
  if (hourlyBurnUsd !== null && hourlyBurnUsd > 2.0) {
    anomalies.push({ kind: 'burn_rate_high', severity: 'bad', host: null,
      message: `factory burn rate $${hourlyBurnUsd}/h exceeds $2/h`,
      metric: hourlyBurnUsd, threshold: 2.0 });
  }

  const rework = recentReworkStats(telemetry);
  if (rework && rework.ratio > 0.5) {
    const ratio = roundMetric(rework.ratio);
    anomalies.push({ kind: 'high_rework_rate', severity: 'warn', host: null,
      message: `recent telemetry rework ratio ${ratio} exceeds 0.5 across ${rework.runCount} runs`,
      metric: ratio, threshold: 0.5 });
  }

  return {
    hosts: normalizedHosts,
    anomalies,
    summary: {
      hostCount: normalizedHosts.length,
      healthyCount: normalizedHosts.filter(host => Array.isArray(host.alerts) && host.alerts.length === 0).length,
      alertCount: anomalies.length,
      hourlyBurnUsd,
      projectedDailyUsd: hourlyBurnUsd === null ? null : roundMetric(hourlyBurnUsd * 24),
    },
  };
}

// RO-список BB-тредов через CLI (bb thread list --json).
export async function loadBbThreadsFromCli({ execImpl } = {}) {
  const exec = execImpl ?? (async (args) =>
    (await execFileAsync('bb', args, { timeout: 9000 })).stdout);
  try {
    const out = await exec(['thread', 'list', '--json']);
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : (parsed.threads ?? []);
  } catch {
    return [];
  }
}

// --- чтение хвоста events.ndjson ----------------------------------------------

export const EVENTS_TAIL_CHUNK_BYTES = 64 * 1024;
export const EVENTS_TAIL_MAX_BYTES_PER_FILE = 4 * 1024 * 1024;

function eventFileGeneration(name) {
  if (name === 'events.ndjson') return 0;
  const rotated = /^events\.(\d+)\.ndjson$/.exec(name);
  if (rotated) return Number(rotated[1]);
  return /^events(?:\..+)?\.ndjson$/.test(name) ? Number.MAX_SAFE_INTEGER : null;
}

function countNewlines(buffer) {
  let count = 0;
  for (const byte of buffer) if (byte === 10) count += 1;
  return count;
}

// Читает только хвост файла bounded chunks с конца к началу. Первый фрагмент
// в середине файла всегда отбрасывается как потенциально неполная строка;
// чтение останавливается, как только набрано достаточно завершённых строк,
// либо по жёсткому байтовому потолку. Ротированный журнал объёмом сотни MiB
// никогда не загружается в память целиком.
async function readNdjsonTailLines(path, needed, {
  chunkBytes = EVENTS_TAIL_CHUNK_BYTES,
  maxBytes = EVENTS_TAIL_MAX_BYTES_PER_FILE,
} = {}) {
  if (!Number.isSafeInteger(needed) || needed <= 0) return [];
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return [];
  try {
    const st = await handle.stat().catch(() => null);
    if (!st?.isFile() || st.size <= 0) return [];
    const chunkLimit = Math.max(1024, Math.floor(chunkBytes));
    const byteLimit = Math.max(chunkLimit, Math.floor(maxBytes));
    let position = st.size;
    let scanned = 0;
    let newlineCount = 0;
    const parts = [];
    while (position > 0 && scanned < byteLimit && newlineCount <= needed) {
      const amount = Math.min(chunkLimit, position, byteLimit - scanned);
      position -= amount;
      const buffer = Buffer.alloc(amount);
      const { bytesRead } = await handle.read(buffer, 0, amount, position);
      if (bytesRead <= 0) break;
      const chunk = bytesRead === amount ? buffer : buffer.subarray(0, bytesRead);
      parts.unshift(chunk);
      scanned += bytesRead;
      newlineCount += countNewlines(chunk);
    }
    let text = Buffer.concat(parts).toString('utf8');
    if (position > 0) {
      const firstBreak = /\r?\n/.exec(text);
      if (!firstBreak) return [];
      text = text.slice(firstBreak.index + firstBreak[0].length);
    }
    return text.split(/\r?\n/).filter(line => line.trim()).slice(-needed);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function listEventFilesNewestFirst(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const generation = eventFileGeneration(entry.name);
    if (generation === null) continue;
    const path = join(dir, entry.name);
    const st = await lstat(path).catch(() => null);
    if (!st?.isFile() || st.isSymbolicLink()) continue;
    files.push({ path, generation, name: entry.name });
  }
  files.sort((a, b) => a.generation - b.generation || a.name.localeCompare(b.name));
  return files.map(file => file.path);
}

async function readEventsTail(stateDirs, limit) {
  const cap = Math.max(0, Math.floor(limit));
  if (!cap) return [];
  const events = [];
  for (const dir of Array.isArray(stateDirs) ? stateDirs : []) {
    const collected = [];
    for (const path of await listEventFilesNewestFirst(dir)) {
      if (collected.length >= cap) break;
      const fileEvents = [];
      for (const line of await readNdjsonTailLines(path, cap - collected.length)) {
        try { fileEvents.push(JSON.parse(line)); } catch { /* пропуск битой строки */ }
      }
      // Файлы обходятся newest→oldest только ради раннего stop; в журнале
      // события остаются в хронологическом порядке даже без ts.
      collected.unshift(...fileEvents);
    }
    events.push(...collected);
  }
  events.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  return events.slice(-cap);
}

// Read-only провайдер модельного реестра. Любая ошибка конфигурации —
// fail-open для Control Room: snapshot живёт, но видит явный models.ok=false.
export function createModelsProvider({ catalogPath, policyPath, configDir, now, quotas } = {}) {
  return async () => {
    try {
      const at = typeof now === 'function' ? now() : now ?? new Date();
      const registry = await loadModelRegistry({ catalogPath, policyPath, configDir, now: at });
      return { ok: true, ...registrySnapshot(registry, { now: at, quotas }) };
    } catch (error) {
      return { ok: false, error: sanitizeTerminalText(error.message) };
    }
  };
}


const BOARD_EXPLORER_STATES = ['ready', 'claimed', 'waiting', 'blocked', 'completed'];

function canonicalBoardState(raw) {
  const state = String(raw ?? '').trim().toLowerCase();
  if (state === 'ready') return 'ready';
  if (state === 'claimed' || state === 'working') return 'claimed';
  if (state === 'blocked' || state === 'awaiting_answer' || state === 'hold') return 'blocked';
  if (state === 'completed' || state === 'done') return 'completed';
  return 'waiting';
}

function taskRepoId(task) {
  const labels = task?.labels !== null && typeof task?.labels === 'object' ? task.labels : {};
  return firstText(task?.repoId, task?.repo_id, labels.repo_id, labels.repoId, labels.project);
}

function receiptShaOf(task) {
  const result = jsonObject(task?.result) ?? {};
  const labels = task?.labels !== null && typeof task?.labels === 'object' ? task.labels : {};
  return firstText(task?.receiptSha, task?.receipt_sha, result.sha, result.candidate_sha,
    result.receipt_sha, result.receiptSha, labels.receipt_sha, labels.receiptSha, labels.sha);
}

function ownerNeedDetails(task) {
  const blocked = jsonObject(task?.blocked) ?? {};
  const reasonPayload = jsonObject(blocked.reason);
  const questionPayload = jsonObject(task?.question) ?? {};
  const questionId = firstText(blocked.question_id, blocked.questionId,
    reasonPayload?.question_id, questionPayload.question_id);
  const question = firstText(blocked.question, questionPayload.prompt, questionPayload.question,
    reasonPayload?.prompt, reasonPayload?.question);
  const evidence = firstText(
    typeof blocked.reason === 'string' && !reasonPayload ? blocked.reason : null,
    reasonPayload?.evidence, questionPayload.evidence, task?.reason);
  return { question, evidence, questionId };
}

function normalizeBoardExplorerTask(task) {
  const labels = task?.labels !== null && typeof task?.labels === 'object' && !Array.isArray(task.labels)
    ? task.labels : {};
  return {
    id: String(task?.task_id ?? task?.id ?? ''),
    channel: firstText(task?.channel, labels.channel) ?? 'unassigned',
    state: canonicalBoardState(task?.state),
    priority: firstText(task?.priority, labels.priority),
    repoId: taskRepoId(task),
    title: firstText(task?.title) ?? '',
    labels,
    updatedAt: firstText(task?.updatedAt, task?.updated_at, task?.last, task?.lastActivityAt),
    receiptSha: receiptShaOf(task),
  };
}

export function buildBoardExplorer(tasks = []) {
  const grouped = new Map();
  for (const raw of Array.isArray(tasks) ? tasks : []) {
    const task = normalizeBoardExplorerTask(raw);
    if (!task.id) continue;
    if (!grouped.has(task.channel)) {
      grouped.set(task.channel, { name: task.channel,
        counts: Object.fromEntries(BOARD_EXPLORER_STATES.map(state => [state, 0])), tasks: [] });
    }
    const channel = grouped.get(task.channel);
    channel.counts[task.state] += 1;
    channel.tasks.push(task);
  }
  const channels = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const channel of channels) {
    channel.tasks.sort((a, b) => {
      const aTime = timeValue(a.updatedAt);
      const bTime = timeValue(b.updatedAt);
      if (aTime !== null && bTime !== null && aTime !== bTime) return bTime - aTime;
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    });
  }
  return { channels };
}

const TREE_STAGE_ORDER = ['l1_local', 'tamper', 'scope_fence', 'l2_critic', 'arbiter'];
const ACTIVE_TREE_STATES = new Set(['claimed', 'working', 'blocked', 'awaiting_answer', 'hold',
  'completed', 'done']);

function canonicalStageKind(raw) {
  const value = String(raw ?? '').toLowerCase();
  if (!value) return null;
  if (value.includes('scope')) return 'scope_fence';
  if (value.includes('tamper')) return 'tamper';
  if (value.includes('arbiter') || value.includes('arbitr')) return 'arbiter';
  if (value.includes('l2') || value.includes('critic') || value.includes('review')) return 'l2_critic';
  if (value.includes('l1') || value.includes('local') || value.includes('docker')) return 'l1_local';
  return null;
}

function eventTime(event, fallback = 0) {
  return timeValue(event?.ts) ?? (Number.isSafeInteger(event?.seq) ? event.seq : fallback);
}

function latestEvent(events) {
  return events.length ? events[events.length - 1] : null;
}

function eventModelParts(raw) {
  const model = copyModel(raw);
  return model;
}

function stageVerdictStatus(value) {
  const verdict = String(value ?? '').trim().toLowerCase();
  if (!verdict) return null;
  if (['pass', 'passed', 'ok', 'success', 'done', 'completed'].includes(verdict)) return 'pass';
  if (['skip', 'skipped', 'not_applicable', 'disabled'].includes(verdict)) return 'skipped';
  if (['fail', 'failed', 'rework', 'blocked', 'hold', 'error'].includes(verdict)) return 'fail';
  if (['running', 'started', 'pending'].includes(verdict)) return verdict;
  return null;
}

const FAILED_ATTEMPT_OUTCOMES = new Set(['hold', 'fail', 'failed', 'error', 'provider_error',
  'crashed', 'timeout', 'aborted', 'uncertain', 'lease_lost', 'rework']);

function telemetryFailedStages(telemetry) {
  const failed = new Set();
  const outcome = String(telemetry?.outcome ?? '').trim().toLowerCase();
  if (!FAILED_ATTEMPT_OUTCOMES.has(outcome) &&
      !/(hold|fail|error|crash|timeout|abort|uncertain|lease_lost|rework|blocked|needs_input)/.test(outcome)) return failed;
  const add = raw => {
    const kind = canonicalStageKind(raw);
    if (kind) failed.add(kind);
  };
  for (const key of Object.keys(telemetry?.phaseFailures ?? {})) add(key);
  for (const key of Object.keys(telemetry?.rounds?.gates ?? {})) add(key);
  const reason = String(telemetry?.reason ?? '').toLowerCase();
  if (/review|critic|\bl2\b/.test(reason)) failed.add('l2_critic');
  if (/local_checks|\bl1\b/.test(reason)) failed.add('l1_local');
  if (/tamper/.test(reason)) failed.add('tamper');
  if (/scope/.test(reason)) failed.add('scope_fence');
  if (/arbiter|arbitration/.test(reason)) failed.add('arbiter');
  return failed;
}

function buildStageNodes(events, telemetry, nowMs) {
  const nodes = new Map(TREE_STAGE_ORDER.map(kind => [kind, {
    kind, status: 'pending', model: null, round: null, elapsedMs: null, reason: null,
  }]));
  const telemetryPhases = telemetry?.phasesMs ?? {};
  const telemetryHasAttempt = telemetry !== null && telemetry !== undefined;
  const telemetryFailures = telemetryFailedStages(telemetry);
  for (const kind of ['l1_local', 'tamper', 'l2_critic', 'arbiter']) {
    if (!Object.hasOwn(telemetryPhases, kind)) continue;
    const node = nodes.get(kind);
    const elapsed = finiteNumber(telemetryPhases[kind]);
    if (elapsed !== null) {
      node.status = telemetryFailures.has(kind) ? 'fail' : 'pass';
      node.elapsedMs = elapsed;
      if (telemetryFailures.has(kind)) node.reason = textValue(telemetry?.reason);
    } else if (telemetryHasAttempt) {
      node.status = telemetryFailures.has(kind) ? 'fail' : 'skipped';
    }
  }
  const gateRound = (node, keys) => {
    const gates = telemetry?.rounds?.gates ?? {};
    for (const key of keys) {
      const value = finiteNumber(gates[key]);
      if (value !== null) node.round = value;
    }
  };
  gateRound(nodes.get('l1_local'), ['l1', 'l1_local', 'local']);
  gateRound(nodes.get('tamper'), ['tamper']);
  gateRound(nodes.get('scope_fence'), ['scope', 'scope_fence']);
  gateRound(nodes.get('l2_critic'), ['l2', 'l2_critic', 'critic']);
  gateRound(nodes.get('arbiter'), ['arbiter', 'arbitration']);
  if (!nodes.get('arbiter').round) {
    nodes.get('arbiter').round = finiteNumber(telemetry?.rounds?.arbitration);
  }
  const criticModel = telemetry?.models?.critic?.model ?? null;
  const arbiterModel = telemetry?.models?.arbiter?.model ?? null;
  if (criticModel) nodes.get('l2_critic').model = criticModel;
  if (arbiterModel) nodes.get('arbiter').model = arbiterModel;

  const started = new Map();
  for (const event of events) {
    if (String(event?.kind ?? '').toLowerCase() === 'adaptive_gate_decision') continue;
    const detail = event?.detail !== null && typeof event?.detail === 'object' ? event.detail : {};
    const kind = [detail.stage, detail.kind, event.role, event.phase, event.kind]
      .map(canonicalStageKind).find(value => value !== null) ?? null;
    if (!kind) continue;
    const node = nodes.get(kind);
    const at = eventTime(event);
    const eventKind = String(event.kind ?? '').toLowerCase();
    const explicit = stageVerdictStatus(detail.status ?? detail.verdict ?? detail.outcome ?? event.reason);
    if (event.model) {
      const model = eventModelParts(event.model).model;
      if (model) node.model = model;
    }
    if (Number.isFinite(event.round)) node.round = event.round;
    if (event.reason) node.reason = textValue(event.reason);
    if (detail.reason) node.reason = textValue(detail.reason);
    if (eventKind.includes('started') || eventKind.includes('start')) {
      started.set(kind, at);
      node.status = 'running';
      node.elapsedMs = Math.max(0, nowMs - at);
    } else if (eventKind.includes('completed') || eventKind.includes('finished') || explicit) {
      node.status = explicit ?? (eventKind.includes('completed') ? 'pass' : 'running');
      const began = started.get(kind);
      if (began !== undefined && at >= began) node.elapsedMs = at - began;
      if (detail.verdict) node.reason = textValue(detail.verdict);
    } else if (event.phase === kind || eventKind === kind) {
      node.status = explicit ?? 'running';
      node.elapsedMs = Math.max(0, nowMs - at);
    }
  }
  return TREE_STAGE_ORDER.map(kind => nodes.get(kind));
}

function threadMatchesTask(thread, taskId, threadId) {
  if (!thread || typeof thread !== 'object') return false;
  if (threadId && [thread.id, thread.threadId, thread.thread_id].some(id => String(id ?? '') === String(threadId))) return true;
  return [thread.task_id, thread.taskId, thread.card_id, thread.cardId].some(id => String(id ?? '') === String(taskId));
}

function treeStatus(boardState, telemetry, last, reworkRounds) {
  const phase = String(last?.phase ?? '').toLowerCase();
  const outcome = String(telemetry?.outcome ?? '').toLowerCase();
  const board = String(boardState ?? '').toLowerCase();
  if (['completed', 'done'].includes(board) || ['completed', 'done'].includes(phase) ||
      ['completed', 'done', 'verified', 'deployed'].includes(outcome)) return 'done';
  if (['blocked', 'awaiting_answer', 'hold'].includes(board) ||
      ['hold', 'uncertain', 'lease_lost', 'awaiting_answer', 'blocked', 'blocking'].includes(phase) ||
      ['hold', 'blocked', 'uncertain', 'lease_lost'].includes(outcome)) return 'hold';
  if (String(last?.kind ?? '').toLowerCase() === 'rework' || reworkRounds > 0) return 'rework';
  return 'running';
}

function buildTreeForTask(taskId, { boardTask, events, telemetry, threads, nowMs }) {
  const last = latestEvent(events);
  const first = events[0] ?? null;
  const labels = boardTask?.labels !== null && typeof boardTask?.labels === 'object' ? boardTask.labels : {};
  const detail = last?.detail !== null && typeof last?.detail === 'object' ? last.detail : {};
  const detailValue = (...keys) => {
    for (const event of [...events].reverse()) {
      const item = event?.detail !== null && typeof event?.detail === 'object' ? event.detail : {};
      for (const key of keys) {
        if (item[key] !== undefined && item[key] !== null) return item[key];
      }
    }
    return null;
  };
  const startedMs = timeValue(telemetry?.startedAt) ?? timeValue(first?.ts);
  const terminal = ['done', 'hold'].includes(treeStatus(boardTask?.state, telemetry, last,
    finiteNumber(telemetry?.rounds?.rework) ?? events.filter(e => String(e.kind ?? '').toLowerCase() === 'rework').length));
  const endedMs = terminal
    ? timeValue(telemetry?.endedAt) ?? timeValue(last?.ts) ?? startedMs
    : nowMs;
  const elapsedMs = finiteNumber(telemetry?.elapsedMs) ??
    (startedMs !== null && endedMs !== null ? Math.max(0, endedMs - startedMs) : null);
  const reworkRounds = finiteNumber(telemetry?.rounds?.rework) ??
    events.filter(e => String(e.kind ?? '').toLowerCase() === 'rework').length;
  const eventRounds = events.map(e => finiteNumber(e.round)).filter(v => v !== null);
  const rounds = finiteNumber(telemetry?.rounds?.total) ??
    (eventRounds.length ? Math.max(...eventRounds) : null) ??
    (events.length ? reworkRounds + 1 : null);
  const estCostUsd = finiteNumber(telemetry?.costUsd);
  const burnRatePerHr = estCostUsd !== null && elapsedMs !== null && elapsedMs > 0
    ? Number((estCostUsd / (elapsedMs / 3_600_000)).toFixed(4)) : null;
  const threadId = firstText(detailValue('threadId', 'thread_id'), last?.bb_thread_id,
    telemetry?.threadId, boardTask?.thread_id, boardTask?.bb_thread_id);
  const thread = (Array.isArray(threads) ? threads : []).find(item => threadMatchesTask(item, taskId, threadId)) ?? null;
  const telemetryWorker = telemetry?.models?.worker ?? { provider: null, model: null };
  const workerEvent = [...events].reverse().find(event =>
    event?.role === 'worker' || event?.phase === 'working' ||
    (event?.model && !canonicalStageKind(event?.detail?.stage ?? event?.role))) ?? last;
  const parsedEventModel = copyModel(workerEvent?.model);
  const provider = firstText(telemetryWorker.provider, parsedEventModel.provider,
    thread?.provider, thread?.providerId, thread?.provider_id);
  const model = firstText(telemetryWorker.model, parsedEventModel.model,
    thread?.model, thread?.modelId, thread?.model_id, boardTask?.executor?.model);
  const eventTokens = [...events].reverse().map(event => finiteNumber(event?.tokens))
    .find(value => value !== null) ?? null;
  const workerTokens = copyUsage(telemetry?.tokens?.worker) ??
    copyUsage(thread?.usage) ?? eventTokens;
  const contextPct = firstNumber(detailValue('contextPct', 'context_pct', 'contextPercent',
    'context_usage_pct'), thread?.contextPct, thread?.context_pct, thread?.context?.pct,
    thread?.context?.percent, thread?.context?.usagePct);
  const workerElapsedMs = finiteNumber(telemetry?.phasesMs?.worker) ?? elapsedMs;
  const usageCache = workerTokens !== null && typeof workerTokens === 'object'
    ? finiteNumber(workerTokens.cached) : null;
  const cacheStatus = firstText(detailValue('cacheStatus', 'cache_status'),
    thread?.cacheStatus, thread?.cache_status) ??
    (usageCache !== null ? (usageCache > 0 ? 'hit' : 'miss') : null);
  const status = treeStatus(boardTask?.state, telemetry, last, reworkRounds);
  return {
    taskId: String(taskId),
    title: firstText(boardTask?.title, telemetry?.title) ?? '',
    channel: firstText(last?.channel, telemetry?.channel, boardTask?.channel, labels.channel) ?? 'unassigned',
    repoId: firstText(telemetry?.repoId, taskRepoId(boardTask ?? {}), detailValue('repoId', 'repo_id')),
    status,
    elapsedMs,
    rounds,
    reworkRounds,
    estCostUsd,
    burnRatePerHr,
    worker: {
      threadId,
      provider,
      model,
      branch: firstText(detailValue('branch', 'worktreeBranch'), thread?.branch, thread?.currentBranch,
        thread?.gitBranch, labels.branch),
      phase: firstText(last?.phase, boardTask?.state) ?? null,
      elapsedMs: workerElapsedMs,
      contextPct,
      cacheStatus,
      tokens: workerTokens,
    },
    stages: buildStageNodes(events, telemetry, nowMs),
  };
}

export function buildActiveTrees({ events = [], tasks = [], telemetryAttempts = [], threads = [],
  now = () => Date.now(), limit = 100 } = {}) {
  const nowValue = now();
  const nowMs = timeValue(nowValue) ?? (nowValue instanceof Date ? nowValue.getTime() : Date.now());
  const boardById = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const id = task?.task_id ?? task?.id;
    if (id !== undefined && id !== null) boardById.set(String(id), task);
  }
  const telemetryByTask = new Map();
  for (const raw of Array.isArray(telemetryAttempts) ? telemetryAttempts : []) {
    const compact = compactTelemetryAttempt(raw);
    if (!compact) continue;
    if (!telemetryByTask.has(compact.taskId)) telemetryByTask.set(compact.taskId, []);
    telemetryByTask.get(compact.taskId).push(compact);
  }
  const telemetryTime = entry => timeValue(entry?.endedAt) ?? timeValue(entry?.startedAt) ?? 0;
  for (const list of telemetryByTask.values()) {
    list.sort((a, b) => telemetryTime(a) - telemetryTime(b));
  }
  const groups = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.task_id === undefined || event?.task_id === null) continue;
    const taskId = String(event.task_id);
    const key = [taskId, event.attempt_id ?? '', event.epoch ?? ''].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const latestGroupByTask = new Map();
  for (const group of groups.values()) {
    group.sort((a, b) => eventTime(a) - eventTime(b));
    const taskId = String(group[0].task_id);
    const currentMax = eventTime(group[group.length - 1]);
    const previous = latestGroupByTask.get(taskId);
    const previousMax = previous ? eventTime(previous[previous.length - 1]) : -Infinity;
    if (!previous || currentMax >= previousMax) latestGroupByTask.set(taskId, group);
  }
  const groupIdentity = group => {
    const withAttempt = [...(group ?? [])].reverse().find(event => textValue(event?.attempt_id));
    const withEpoch = [...(group ?? [])].reverse().find(event => Number.isSafeInteger(event?.epoch));
    return {
      attemptId: textValue(withAttempt?.attempt_id),
      epoch: Number.isSafeInteger(withEpoch?.epoch) ? withEpoch.epoch : null,
    };
  };
  const telemetryForGroup = (taskId, group) => {
    const list = telemetryByTask.get(taskId) ?? [];
    if (!list.length) return null;
    const latest = list[list.length - 1];
    if (!group?.length) return latest;
    const identity = groupIdentity(group);
    if (!identity.attemptId && identity.epoch === null) return latest;
    const matches = list.filter(entry => {
      if (identity.attemptId && entry.attemptId !== identity.attemptId) return false;
      if (identity.epoch !== null && entry.epoch !== identity.epoch) return false;
      return true;
    });
    return matches.length ? matches[matches.length - 1] : null;
  };
  const ids = new Set([...latestGroupByTask.keys(), ...telemetryByTask.keys()]);
  for (const [taskId, task] of boardById) {
    if (ACTIVE_TREE_STATES.has(String(task?.state ?? '').toLowerCase())) ids.add(taskId);
  }
  const trees = [...ids].map(taskId => buildTreeForTask(taskId, {
    boardTask: boardById.get(taskId) ?? null,
    events: latestGroupByTask.get(taskId) ?? [],
    telemetry: telemetryForGroup(taskId, latestGroupByTask.get(taskId)),
    threads,
    nowMs,
  }));
  const rank = { running: 0, rework: 1, hold: 2, done: 3 };
  trees.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
    String(a.taskId).localeCompare(String(b.taskId), undefined, { numeric: true }));
  return trees.slice(0, limit);
}

export function buildRepoSlots(trees = []) {
  const activeByRepo = {};
  for (const tree of Array.isArray(trees) ? trees : []) {
    if (!['running', 'rework'].includes(tree?.status)) continue;
    const repoId = textValue(tree.repoId);
    if (!repoId) continue;
    activeByRepo[repoId] = (activeByRepo[repoId] ?? 0) + 1;
  }
  const multiWriterWarnings = Object.entries(activeByRepo)
    .filter(([, count]) => count > 1)
    .map(([repoId, count]) =>
      `repo_id ${repoId} has ${count} active writers (default max 1); parallelize across repos instead`);
  return { defaultMaxPerRepo: 1, activeByRepo, multiWriterWarnings };
}

// Наблюдаемое состояние операторского kill-switch: валидный файл `run\n`
// означает false (стоп не включён); отсутствие, другое содержимое или ошибка
// чтения — true. Без настроенного пути состояние честно неизвестно (null).
export async function readKillSwitchState(path) {
  if (typeof path !== 'string' || !path) return null;
  try {
    // Observer повторяет fail-closed инварианты createPilotSwitch: при любом
    // ослаблении каталога/файла демон считает switch закрытым, поэтому пульт
    // не имеет права показывать безопасное off по одному содержимому run\n.
    const directory = dirname(path);
    const canonicalDirectory = await realpath(directory).catch(() => null);
    if (canonicalDirectory !== directory) return true;
    const dirStat = await lstat(directory);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0 ||
        (uid !== null && dirStat.uid !== uid)) return true;
    const st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size !== 4 ||
        (st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid)) return true;
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(5);
      const { bytesRead } = await handle.read(buffer, 0, 5, 0);
      return bytesRead === 4 && buffer.subarray(0, 4).toString('utf8') === 'run\n' ? false : true;
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return true;
  }
}

// --- агрегатор -----------------------------------------------------------------

export function createControlRoomAggregator({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  socketPath = null,
  stateDir = null,
  stateDirs = [],
  fleetDir,
  ringLimit = RING_LIMIT,
  boardTasksProvider = async () => [],
  bbThreadsProvider = async () => [],
  branchDriftProvider = null,
  netHealth = null,
  telemetryProvider = null,
  telemetryDir,
  modelsProvider = createModelsProvider(),
  finopsProvider = createFinopsProvider(),
  inspectProvider = async () => ({ text: '', artifacts: [] }),
  webDir = WEB_DIR,
  now = () => Date.now(),
  ownerWriteToken = null,
  ownerActions = null,
  killSwitchPath = null,
  snapshotCacheTtlMs = 0,
} = {}) {
  const readTelemetry = telemetryProvider ?? createTelemetryProvider({ telemetryDir, stateDirs, now });
  const effectiveStateDir = stateDir ?? stateDirs[0] ?? null;
  const effectiveFleetDir = fleetDir !== undefined ? fleetDir
    : effectiveStateDir ? join(effectiveStateDir, 'fleet') : null;
  const readFleetHosts = createFleetHostsProvider({ fleetDir: effectiveFleetDir, now });
  const ring = [];           // ограниченный журнал событий (≤ ringLimit)
  const attempts = new Map(); // key → последнее состояние попытки
  const sseClients = new Set();
  let httpServer = null;
  let sockServer = null;
  let lastSeq = 0;
  let reconcileNeeded = false;
  // Bounded idempotency cache Owner Write-API: key (action|taskId|key) →
  // { at, response }. TTL + FIFO-eviction; кэшируются только успешные ответы.
  const ownerIdempotencyCache = new Map();
  const ownerIdempotencyInFlight = new Map();
  const ownerWriteEnabled = Boolean(ownerWriteToken && ownerActions);

  const attemptKey = e => [e.project ?? '', e.task_id ?? '', e.attempt_id ?? '',
    e.epoch ?? ''].join('|');

  const ingest = raw => {
    const event = normalizeEvent(raw);
    if (!event.kind && !event.phase) return null;
    // Пропуск seq → сверка по хвосту журнала и Board (reconcile).
    if (Number.isSafeInteger(event.seq)) {
      if (lastSeq && event.seq > lastSeq + 1) reconcileNeeded = true;
      lastSeq = Math.max(lastSeq, event.seq);
    }
    ring.push(event);
    if (ring.length > ringLimit) ring.splice(0, ring.length - ringLimit);
    const key = attemptKey(event);
    const prev = attempts.get(key) ?? { key, events: 0 };
    const next = { ...prev, ...event, key, events: prev.events + 1 };
    attempts.set(key, next);
    // Ограничение памяти: FIFO-выталкивание старейших ключей попыток.
    while (attempts.size > 500) attempts.delete(attempts.keys().next().value);
    broadcast({ type: 'event', event });
    return event;
  };

  const broadcast = message => {
    const data = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of sseClients) {
      try { res.write(data); } catch { sseClients.delete(res); }
    }
  };

  // Гигиена сессий: активный вид — живые треды и привязанные к
  // claimed/blocked карточкам/живым attempt.json; завершённые и архивные
  // уходят в archive.
  const ACTIVE_THREAD = new Set(['running', 'active', 'starting', 'working']);
  function sessionHygiene(threads, tasks, attemptMap) {
    const bound = new Set();
    for (const task of tasks) {
      if (['claimed', 'blocked', 'working'].includes(task.state)) {
        if (task.thread_id) bound.add(task.thread_id);
        if (task.bb_thread_id) bound.add(task.bb_thread_id);
      }
    }
    for (const a of attemptMap.values()) {
      if (!TERMINAL.has(a.phase) && a.detail?.threadId) bound.add(a.detail.threadId);
      if (!TERMINAL.has(a.phase) && a.bb_thread_id) bound.add(a.bb_thread_id);
    }
    const active = [];
    const archived = [];
    for (const t of threads) {
      const status = String(t.status ?? t.state ?? '').toLowerCase();
      if (ACTIVE_THREAD.has(status) || bound.has(t.id)) active.push(t);
      else archived.push(t);
    }
    return { active, archived };
  }

  // Шива-счётчик: один лид = одна задача/веха.
  function shivaCounter(threads, tasks) {
    const leadOf = new Map();
    for (const t of threads) {
      const lead = t.lead_session_id ?? t.leadSessionId ?? t.parent_id ??
        t.parentThreadId ?? null;
      const task = t.task_id ?? t.taskId ?? null;
      if (lead && task) {
        if (!leadOf.has(lead)) leadOf.set(lead, new Set());
        leadOf.get(lead).add(String(task));
      }
    }
    const entries = [...leadOf].map(([lead, taskIds]) => ({
      lead, taskIds: [...taskIds], clean: taskIds.size <= 1 }));
    return { sessions: entries, dirty: entries.filter(e => !e.clean).length };
  }

  const columns = tasks => {
    const running = [];
    const queued = [];
    const needsOwner = [];
    const recentlyCompleted = [];
    for (const task of tasks) {
      const card = { task_id: task.task_id ?? task.id, state: task.state,
        title: sanitizeTerminalText(String(task.title ?? '')),
        labels: task.labels ?? {}, epoch: task.epoch ?? null };
      if (task.state === 'claimed' || task.state === 'working') {
        // Самая свежая попытка по task_id (по ts события).
        let key = null;
        for (const a of attempts.values()) {
          if (String(a.task_id) !== String(card.task_id)) continue;
          if (!key || String(a.ts ?? '') >= String(key.ts ?? '')) key = a;
        }
        running.push({ ...card, phase: key?.phase ?? null,
          model: key?.model ?? task.executor?.model ?? null,
          role: key?.role ?? null, round: key?.round ?? null,
          deadline_rem_ms: key?.deadline_rem_ms ?? null,
          tokens: key?.tokens ?? null, lastEvent: key?.reason ?? null });
      } else if (task.state === 'ready' || task.state === 'queued' || task.state === 'waiting') {
        queued.push(card);
      } else if (task.state === 'blocked' || task.state === 'awaiting_answer' || task.state === 'hold') {
        const need = ownerNeedDetails(task);
        needsOwner.push({ ...card,
          question: need.question,
          evidence: need.evidence,
          cli: need.questionId ? `question-gate answer ${need.questionId}` : null });
      } else if (task.state === 'completed' || task.state === 'done') {
        recentlyCompleted.push(card);
      }
    }
    return { running, queued, needsOwner, recentlyCompleted };
  };

  async function buildSnapshot() {
    const [board, threads, telemetry, fleetHosts, killSwitch] = await Promise.all([
      readBoardTasks(boardTasksProvider),
      bbThreadsProvider().catch(() => []),
      readTelemetry().catch(() => null),
      readFleetHosts().catch(() => []),
      readKillSwitchState(killSwitchPath)]);
    const tasks = board.tasks;
    const net = netHealth ? await netHealth.snapshot().catch(() => null) : null;
    const drift = branchDriftProvider
      ? await branchDriftProvider().catch(() => ({ driftDetected: null, error: true }))
      : null;
    const models = modelsProvider
      ? await Promise.resolve().then(() => modelsProvider())
        .catch(error => ({ ok: false, error: sanitizeTerminalText(error.message) }))
      : null;
    const finops = finopsProvider
      ? await Promise.resolve().then(() => finopsProvider())
        .catch(error => ({ ok: false, error: sanitizeTerminalText(error.message) }))
      : null;
    const sessions = sessionHygiene(threads, tasks, attempts);
    const shiva = shivaCounter(threads, tasks);
    const activeTrees = buildActiveTrees({ events: ring, tasks,
      telemetryAttempts: telemetry?.attempts ?? [], threads, now });
    const fleetTelemetry = buildFleetTelemetry({ hosts: fleetHosts, telemetry, activeTrees });
    const boardExplorer = buildBoardExplorer(tasks);
    const repoSlots = buildRepoSlots(activeTrees);
    const adaptiveGates = buildAdaptiveGatesSummary({ attempts: telemetry?.attempts ?? [] });
    const reconciled = reconcileNeeded;
    reconcileNeeded = false;
    return {
      ts: new Date(now()).toISOString(),
      reconcile: reconciled,
      ownerWriteEnabled,
      killSwitch,
      ...columns(tasks),
      boardStatus: board.boardStatus,
      health: { board: board.boardStatus },
      sessions: { active: sessions.active, archivedCount: sessions.archived.length },
      shiva,
      activeTrees,
      boardExplorer,
      repoSlots,
      adaptiveGates,
      branchDrift: drift,
      netHealth: net,
      telemetry,
      fleetTelemetry,
      models,
      finops,
      eventsTail: ring.slice(-50),
      attemptsTracked: attempts.size,
    };
  }

  // Одновременные /api/snapshot и SSE-подключения разделяют один in-flight
  // snapshot: дорогие провайдеры не запускаются пачкой. TTL-кэш выключен по
  // умолчанию, чтобы последовательные вызовы в тестах оставались строго
  // детерминированными; оператор может включить короткий TTL явно.
  let snapshotInFlight = null;
  let snapshotCached = null;
  let snapshotCachedAt = -Infinity;
  function snapshot() {
    const ttl = Number.isFinite(snapshotCacheTtlMs) && snapshotCacheTtlMs > 0
      ? snapshotCacheTtlMs : 0;
    const at = now();
    if (ttl && snapshotCached !== null && at - snapshotCachedAt <= ttl) {
      return Promise.resolve(snapshotCached);
    }
    if (snapshotInFlight) return snapshotInFlight;
    const pending = buildSnapshot();
    snapshotInFlight = pending;
    const clear = () => { if (snapshotInFlight === pending) snapshotInFlight = null; };
    pending.then(clear, clear);
    if (ttl) {
      pending.then(value => {
        snapshotCached = value;
        snapshotCachedAt = now();
      }, () => {});
    }
    return pending;
  }

  // --- HTTP ---------------------------------------------------------------

  const STATIC = new Map();
  const staticFile = async (name, type) => {
    if (!STATIC.has(name)) {
      STATIC.set(name, { body: await readFile(join(webDir, name)), type });
    }
    return STATIC.get(name);
  };

  // Authenticated Owner Write-API: строгий fail-closed порядок проверок —
  // disabled → auth → content-type → body → payload → idempotency → вызов
  // ownerActions. Проверки Host/Origin уже выполнены в respond для всех
  // запросов. Ни один сбой не вызывает ownerActions частично.
  const handleOwnerWrite = async (req, res, pathname) => {
    const action = OWNER_ENDPOINTS.get(pathname);
    const reply = (status, body) => {
      res.writeHead(status, jsonHeaders());
      res.end(JSON.stringify(body));
    };
    const portMethod = ownerActions !== null && typeof ownerActions === 'object'
      ? ownerActions[action] : null;
    if (!ownerWriteToken || typeof ownerWriteToken !== 'string' ||
        typeof portMethod !== 'function') {
      reply(403, { ok: false, error: 'write_api_disabled' });
      return;
    }
    const auth = req.headers.authorization;
    const presented = typeof auth === 'string' && auth.startsWith('Bearer ')
      ? auth.slice('Bearer '.length) : null;
    if (!bearerTokenEqual(presented, ownerWriteToken)) {
      reply(401, { ok: false, error: 'unauthorized' });
      return;
    }
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string' ||
        !contentType.toLowerCase().startsWith('application/json')) {
      reply(415, { ok: false, error: 'unsupported_media_type' });
      return;
    }
    let bodyText;
    try {
      bodyText = await readRequestBody(req, OWNER_WRITE_MAX_BODY_BYTES, {
        onDestroy: () => reply(413, { ok: false, error: 'body_too_large' }),
      });
    } catch {
      if (!res.writableEnded) reply(413, { ok: false, error: 'body_too_large' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      reply(400, { ok: false, error: 'invalid_json' });
      return;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      reply(400, { ok: false, error: 'invalid_payload' });
      return;
    }
    const taskId = payload.taskId;
    if (typeof taskId !== 'string' || !OWNER_TASK_ID_RE.test(taskId)) {
      reply(400, { ok: false, error: 'invalid_task_id' });
      return;
    }
    if (action === 'answer' &&
        (typeof payload.answer !== 'string' || !payload.answer.trim())) {
      reply(400, { ok: false, error: 'invalid_answer' });
      return;
    }
    if (payload.idempotencyKey !== undefined &&
        (typeof payload.idempotencyKey !== 'string' || !payload.idempotencyKey ||
          payload.idempotencyKey.length > 128)) {
      reply(400, { ok: false, error: 'invalid_idempotency_key' });
      return;
    }

    const idemKey = typeof payload.idempotencyKey === 'string' && payload.idempotencyKey
      ? `${action}|${taskId}|${payload.idempotencyKey}` : null;
    if (idemKey) {
      const at = now();
      for (const [key, entry] of ownerIdempotencyCache) {
        if (at - entry.at > OWNER_IDEMPOTENCY_TTL_MS) ownerIdempotencyCache.delete(key);
      }
      const hit = ownerIdempotencyCache.get(idemKey);
      if (hit) {
        reply(200, { ...hit.response, deduplicated: true });
        return;
      }
    }

    const actionPayload = {};
    if (payload.answer !== undefined) actionPayload.answer = payload.answer;
    if (payload.choice !== undefined) actionPayload.choice = payload.choice;
    if (payload.reason !== undefined) actionPayload.reason = payload.reason;
    if (payload.idempotencyKey !== undefined) actionPayload.idempotencyKey = payload.idempotencyKey;
    const executeOwnerAction = async () => {
      let result;
      try {
        result = await portMethod(taskId, actionPayload);
      } catch (error) {
        return { status: 502, body: { ok: false, error: 'action_failed',
          message: sanitizeTerminalText(String(error?.message ?? error ?? 'action failed')) } };
      }
      const responseBody = { ok: true, action, taskId, result: result ?? null,
        deduplicated: false };
      if (idemKey) {
        ownerIdempotencyCache.set(idemKey, { at: now(), response: responseBody });
        while (ownerIdempotencyCache.size > OWNER_IDEMPOTENCY_MAX_ENTRIES) {
          ownerIdempotencyCache.delete(ownerIdempotencyCache.keys().next().value);
        }
      }
      return { status: 200, body: responseBody };
    };

    if (!idemKey) {
      const outcome = await executeOwnerAction();
      reply(outcome.status, outcome.body);
      return;
    }

    // TOCTOU-защита idempotency: параллельные POST с одним ключом ждут один
    // и тот же вызов ownerActions, а не проходят проверку кэша до записи и
    // не исполняют side-effect дважды.
    const existing = ownerIdempotencyInFlight.get(idemKey);
    if (existing) {
      const outcome = await existing;
      reply(outcome.status, outcome.status === 200 && outcome.body?.ok === true
        ? { ...outcome.body, deduplicated: true }
        : outcome.body);
      return;
    }
    const pending = executeOwnerAction();
    ownerIdempotencyInFlight.set(idemKey, pending);
    try {
      const outcome = await pending;
      reply(outcome.status, outcome.body);
    } finally {
      if (ownerIdempotencyInFlight.get(idemKey) === pending) {
        ownerIdempotencyInFlight.delete(idemKey);
      }
    }
  };

  const respond = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const activePort = httpServer?.address()?.port ?? port;
    if (!isAllowedHost(req.headers.host, activePort)) {
      res.writeHead(403, jsonHeaders());
      res.end(JSON.stringify({ error: 'forbidden_host' }));
      return;
    }
    if (!isAllowedOrigin(req.headers.origin, activePort)) {
      res.writeHead(403, jsonHeaders());
      res.end(JSON.stringify({ error: 'forbidden_origin' }));
      return;
    }
    if (!isAllowedFetchSite(req.headers['sec-fetch-site'])) {
      res.writeHead(403, jsonHeaders());
      res.end(JSON.stringify({ error: 'forbidden_fetch_site' }));
      return;
    }
    if (req.method === 'POST' && OWNER_ENDPOINTS.has(url.pathname)) {
      await handleOwnerWrite(req, res, url.pathname);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, jsonHeaders({ Allow: 'GET, HEAD' }));
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    try {
      if (url.pathname === '/api/health') {
        res.writeHead(200, jsonHeaders());
        res.end(JSON.stringify({ ok: true }));
      } else if (url.pathname === '/api/snapshot') {
        res.writeHead(200, jsonHeaders());
        res.end(JSON.stringify(await snapshot()));
      } else if (url.pathname === '/api/events') {
        if (sseClients.size >= MAX_SSE_CLIENTS) {
          res.writeHead(503, jsonHeaders());
          res.end(JSON.stringify({ error: 'sse_full' }));
          return;
        }
        // close-handler регистрируется до первого await: клиент, отключившийся
        // во время дорогого snapshot(), не попадает в sseClients и не течёт.
        let closed = false;
        const cleanupSse = () => {
          closed = true;
          sseClients.delete(res);
        };
        req.on('close', cleanupSse);
        res.on('close', cleanupSse);
        res.writeHead(200, { 'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache', Connection: 'keep-alive', ...SECURITY_HEADERS });
        const initial = await snapshot();
        if (closed || req.destroyed || res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ type: 'snapshot', data: initial })}\n\n`);
        if (!closed && !req.destroyed && !res.writableEnded) sseClients.add(res);
      } else if (url.pathname.startsWith('/api/inspect/')) {
        const taskId = decodeURIComponent(url.pathname.slice(13));
        const data = await inspectProvider(taskId).catch(() => ({ text: '', artifacts: [] }));
        res.writeHead(200, jsonHeaders());
        res.end(JSON.stringify({ taskId: sanitizeTerminalText(taskId),
          text: sanitizeTerminalText(String(data.text ?? '')),
          artifacts: Array.isArray(data.artifacts)
            ? data.artifacts.slice(0, 64).map(a => sanitizeTerminalText(String(a)))
            : [] }));
      } else if (url.pathname === '/' || url.pathname === '/index.html') {
        const file = await staticFile('index.html', 'text/html');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
        res.end(req.method === 'HEAD' ? undefined : file.body);
      } else if (url.pathname === '/app.js' || url.pathname === '/styles.css') {
        const file = await staticFile(url.pathname.slice(1),
          url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
        res.writeHead(200, { 'Content-Type': `${file.type}; charset=utf-8`,
          ...SECURITY_HEADERS });
        res.end(req.method === 'HEAD' ? undefined : file.body);
      } else {
        res.writeHead(404, jsonHeaders());
        res.end(JSON.stringify({ error: 'not_found' }));
      }
    } catch (error) {
      res.writeHead(500, jsonHeaders());
      res.end(JSON.stringify({ error: 'internal', message: sanitizeTerminalText(error.message) }));
    }
  };

  return {
    async start() {
      // Прогрев: хвост events.ndjson из известных state-каталогов.
      if (stateDirs.length) {
        for (const event of await readEventsTail(stateDirs, ringLimit)) ingest(event);
      }
      if (socketPath) {
        await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
        await unlink(socketPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
        sockServer = createNetServer(conn => {
          let buf = '';
          conn.on('data', chunk => {
            buf += chunk;
            if (buf.length > 1024 * 1024) { conn.destroy(); return; }
            let end;
            while ((end = buf.indexOf('\n')) >= 0) {
              try { ingest(JSON.parse(buf.slice(0, end))); } catch { /* битая строка */ }
              buf = buf.slice(end + 1);
            }
          });
          conn.on('error', () => {});
        });
        await new Promise(resolve => sockServer.listen(socketPath, resolve));
      }
      httpServer = createHttpServer((req, res) => {
        respond(req, res).catch(() => {
          try { res.writeHead(500); res.end(); } catch { /* noop */ }
        });
      });
      await new Promise(resolve => httpServer.listen(port, host, resolve));
      return { port: httpServer.address().port, host };
    },
    async stop() {
      for (const res of sseClients) { try { res.end(); } catch { /* noop */ } }
      sseClients.clear();
      if (httpServer) await new Promise(resolve => httpServer.close(resolve));
      if (sockServer) await new Promise(resolve => sockServer.close(resolve));
    },
    snapshot,
    ingest,
    get port() { return httpServer?.address()?.port ?? port; },
    get clients() { return sseClients.size; },
    get ringSize() { return ring.length; },
  };
}

// CLI: node aggregator.mjs [--port N] [--socket PATH] [--state-dir DIR]
//   [--board-url URL] [--board-channels a,b] [--board-token TOK]
//   [--drift-repo DIR ...] [--net-probe name=url ...]
//   [--models-catalog PATH] [--routing-policy PATH]
//   [--resources-budget PATH] [--worker-usage PATH]
async function loadBoardToken(flagValue) {
  if (typeof flagValue === 'string' && flagValue) return flagValue;
  const envToken = process.env.BOARD_TOKEN;
  if (typeof envToken === 'string' && envToken) return envToken;
  // Токен из конфигурации: $XDG_CONFIG_HOME/darkfactory/board-token.
  const confDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const token = await readFile(join(confDir, 'darkfactory', 'board-token'), 'utf8')
    .catch(() => null);
  return token?.trim() || null;
}

// Репозитории для Branch Drift: --drift-repo (повторяемый) + DF_DRIFT_REPOS
// (':'-разделённый). Без заданных — process.cwd() только если это git-репо.
async function resolveDriftRepos(flagRepos) {
  const repos = [...(flagRepos ?? []),
    ...(process.env.DF_DRIFT_REPOS ?? '').split(':').filter(Boolean)];
  if (repos.length) return repos;
  const inside = await execFileAsync('git',
    ['rev-parse', '--is-inside-work-tree'], { timeout: 5000 })
    .then(r => r.stdout.trim() === 'true').catch(() => false);
  return inside ? [process.cwd()] : [];
}

async function cli(argv) {
  const { values } = parseArgs({ args: argv, options: {
    port: { type: 'string' }, socket: { type: 'string' },
    'state-dir': { type: 'string', multiple: true },
    'board-url': { type: 'string' },
    'board-channels': { type: 'string' },
    'board-token': { type: 'string' },
    'drift-repo': { type: 'string', multiple: true },
    'drift-ttl': { type: 'string' },
    'net-probe': { type: 'string', multiple: true },
    'cloud-state': { type: 'string' },
    'models-catalog': { type: 'string' },
    'routing-policy': { type: 'string' },
    'resources-budget': { type: 'string' },
    'worker-usage': { type: 'string' },
    'telemetry-dir': { type: 'string' },
    'fleet-dir': { type: 'string' },
    'kill-switch': { type: 'string' },
    'owner-write-token': { type: 'string' } } });
  const port = values.port !== undefined ? Number(values.port)
    : Number(process.env.DF_CONTROL_ROOM_PORT ?? DEFAULT_PORT);
  const socketPath = values.socket !== undefined ? values.socket
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
        'darkfactory', 'control-room.sock');
  const cloudStatePath = values['cloud-state'] ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
      'darkfactory', 'cloud-worker-state.json');
  const netHealth = createNetHealthMonitor({
    probes: (values['net-probe'] ?? []).map(spec => {
      const i = spec.indexOf('=');
      return { name: spec.slice(0, i), url: spec.slice(i + 1) };
    }),
    cloudStatePath });
  const boardUrl = values['board-url'] ?? process.env.BOARD_URL ??
    `http://127.0.0.1:44100${BOARD_API_PATH}`;
  const channels = (values['board-channels'] ?? 'darkfactory')
    .split(',').map(c => c.trim()).filter(Boolean);
  const boardToken = await loadBoardToken(values['board-token']);
  const observeBoard = createBoardObserver({ boardUrl, token: boardToken, channels });
  const driftRepos = await resolveDriftRepos(values['drift-repo']);
  const driftProvider = driftRepos.length
    ? createBranchDriftProvider(driftRepos,
      { ttlMs: Number(values['drift-ttl'] ?? 20_000) })
    : null;
  const stateDirs = values['state-dir'] ?? [];
  const aggregator = createControlRoomAggregator({
    port, socketPath, stateDir: stateDirs[0] ?? null, stateDirs,
    netHealth,
    boardTasksProvider: observeBoard.fetchTasks,
    bbThreadsProvider: () => loadBbThreadsFromCli(),
    branchDriftProvider: driftProvider,
    modelsProvider: createModelsProvider({
      catalogPath: values['models-catalog'],
      policyPath: values['routing-policy'] }),
    telemetryDir: values['telemetry-dir'],
    fleetDir: values['fleet-dir'],
    finopsProvider: createFinopsProvider({
      budgetPath: values['resources-budget'],
      workerUsagePath: values['worker-usage'],
      workerStatePath: cloudStatePath }),
    // Owner Write-API: токен доступен из CLI/env, но ownerActions port — это
    // программный мост (Herdr Desktop/Mobile, Telegram/Iva); без живого порта
    // write API остаётся fail-closed write_api_disabled даже с токеном.
    ownerWriteToken: values['owner-write-token'] ??
      process.env.DF_CONTROL_ROOM_WRITE_TOKEN ?? null,
    killSwitchPath: values['kill-switch'] ??
      process.env.DF_CONTROL_ROOM_KILL_SWITCH ?? null });
  const { port: actual } = await aggregator.start();
  console.log(JSON.stringify({ control_room: 'listening', host: '127.0.0.1', port: actual,
    socket: socketPath, boardApi: observeBoard.boardUrl, boardChannels: channels,
    driftRepos }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await cli(process.argv.slice(2)); } catch (error) {
    console.error(`control-room: ${error.message}`);
    process.exitCode = 1;
  }
}
