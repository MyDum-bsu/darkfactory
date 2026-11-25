// Control Room Aggregator (V2-3, Hybrid Variant B) — единый read-only
// владелец Unix socket (push-события контроллеров через event-bus.mjs) и
// HTTP/SSE сервера на 127.0.0.1:<port> (дефолт 44110, --port /
// DF_CONTROL_ROOM_PORT, 0 для ephemeral).
//
// СТРОГО READ-ONLY: только GET/HEAD (POST/PUT/PATCH/DELETE → 405), ноль
// mutating-запросов в Board, ноль записи в worktree/state. Host/Origin
// guard против DNS-rebinding/CSRF, строгий CSP, все недоверенные строки
// санитизируются.
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
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { normalizeEvent } from '../../board_pipeline/event-bus.mjs';
import { inspectWorktreesAndBranches } from '../../board_pipeline/branch-drift.mjs';
import { isAllowedHost, isAllowedOrigin, sanitizeTerminalText,
  SECURITY_HEADERS } from './origin-guard.mjs';
import { createNetHealthMonitor } from './net-health.mjs';
import { createFinopsProvider } from './finops.mjs';
import { loadModelRegistry, registrySnapshot } from '../../board_pipeline/model-registry.mjs';
import { collectTelemetry } from '../../board_pipeline/telemetry-collector.mjs';
import { normalizeCost, normalizeUsage, parseTelemetryLines } from '../../board_pipeline/telemetry.mjs';
import { aggregateScorecard } from '../../board_pipeline/model-scorecard.mjs';

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

  // Один канал → либо { ok: true, status, body }, либо явный сбой.
  const readChannel = async channel => {
    let res;
    try {
      res = await fetcher(
        `${base}/tasks?channel=${encodeURIComponent(channel)}&limit=500`,
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

  const toTask = raw => {
    const message = raw?.message ?? raw;
    if (!message || typeof message !== 'object') return null;
    const task = message.task ?? (message.state ? message : null);
    if (!task || typeof task.state !== 'string') return null;
    const labels = message.labels ?? task.labels ?? {};
    const result = task.result && typeof task.result === 'object' ? task.result : {};
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
      ...(task.blocked && typeof task.blocked === 'object' ? { blocked: task.blocked } : {}),
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
  const phasesMs = Object.fromEntries(Object.entries(rawPhases)
    .filter(([, value]) => value === null || Number.isFinite(value))
    .map(([key, value]) => [key, value === null ? null : Number(value)]));
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

async function readBoundedText(path, maxBytes) {
  const chunks = [];
  let total = 0;
  const stream = createReadStream(path, { encoding: 'utf8', end: maxBytes - 1 });
  for await (const chunk of stream) {
    total += Buffer.byteLength(chunk);
    if (total > maxBytes) break;
    chunks.push(chunk);
  }
  return chunks.join('');
}

// Safe read-only telemetry provider. It reads only regular *.jsonl files in
// one directory, caps both file count and bytes, ignores corrupt JSONL rows,
// and returns null when no valid run record exists. Missing directories and
// filesystem races are observation gaps, never server failures.
export function createTelemetryProvider({
  telemetryDir = process.env.DF_TELEMETRY_DIR ?? DEFAULT_TELEMETRY_DIR,
  maxBytes = TELEMETRY_MAX_BYTES,
  maxFiles = TELEMETRY_MAX_FILES,
  now = () => Date.now(),
} = {}) {
  return async () => {
    try {
      if (typeof telemetryDir !== 'string' || !telemetryDir) return null;
      const dirStat = await lstat(telemetryDir).catch(() => null);
      if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) return null;
      const entries = await readdir(telemetryDir, { withFileTypes: true })
        .catch(() => []);
      const names = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(entry => entry.name)
        .sort()
        .slice(0, maxFiles);
      if (!names.length) return null;

      const lines = [];
      let remaining = maxBytes;
      let latestMtimeMs = 0;
      for (const name of names) {
        if (remaining <= 0) break;
        const path = join(telemetryDir, name);
        const fileStat = await lstat(path).catch(() => null);
        if (!fileStat?.isFile() || fileStat.isSymbolicLink()) continue;
        latestMtimeMs = Math.max(latestMtimeMs, fileStat.mtimeMs);
        const text = await readBoundedText(path, Math.min(remaining, maxBytes)).catch(() => '');
        remaining -= Math.min(maxBytes, Buffer.byteLength(text));
        for (const line of text.split(/\r?\n/)) if (line.trim()) lines.push(line);
      }

      const collected = await collectTelemetry({ telemetryLines: lines, clock: now });
      if (!collected.sources.telemetry_runs) return null;
      const scorecard = aggregateScorecard(lines, { seed: [] });
      const parsed = parseTelemetryLines(lines);
      return {
        runs: collected.sources.telemetry_runs,
        attempts: parsed.entries.map(compactTelemetryAttempt).filter(Boolean).slice(-128),
        firstRoundPassRate: collected.portfolio.first_round_pass_rate,
        avgReworkRounds: collected.portfolio.avg_rework_rounds,
        medianWallClockMs: collected.portfolio.median_wall_clock_ms,
        models: scorecard.cells,
        updatedAt: latestMtimeMs
          ? new Date(latestMtimeMs).toISOString()
          : collected.generated_at,
      };
    } catch {
      return null;
    }
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

async function readEventsTail(stateDirs, limit) {
  const files = [];
  for (const dir of stateDirs) {
    for (const name of ['events.ndjson', 'events.1.ndjson', 'events.2.ndjson',
      'events.3.ndjson'].reverse()) {
      const path = join(dir, name);
      const st = await stat(path).catch(() => null);
      if (st?.isFile()) files.push(path);
    }
  }
  const events = [];
  for (const path of files) {
    const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* пропуск битой строки */ }
    }
  }
  events.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  return events.slice(-limit);
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
  const result = task?.result !== null && typeof task?.result === 'object' ? task.result : {};
  const labels = task?.labels !== null && typeof task?.labels === 'object' ? task.labels : {};
  return firstText(task?.receiptSha, task?.receipt_sha, result.sha, result.candidate_sha,
    result.receipt_sha, result.receiptSha, labels.receipt_sha, labels.receiptSha, labels.sha);
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

function buildStageNodes(events, telemetry, nowMs) {
  const nodes = new Map(TREE_STAGE_ORDER.map(kind => [kind, {
    kind, status: 'pending', model: null, round: null, elapsedMs: null, reason: null,
  }]));
  const telemetryPhases = telemetry?.phasesMs ?? {};
  const telemetryHasAttempt = telemetry !== null && telemetry !== undefined;
  for (const kind of ['l1_local', 'tamper', 'l2_critic', 'arbiter']) {
    if (!Object.hasOwn(telemetryPhases, kind)) continue;
    const node = nodes.get(kind);
    const elapsed = finiteNumber(telemetryPhases[kind]);
    if (elapsed !== null) {
      node.status = 'pass';
      node.elapsedMs = elapsed;
    } else if (telemetryHasAttempt) {
      node.status = 'skipped';
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
    const previous = telemetryByTask.get(compact.taskId);
    const currentTs = timeValue(compact.endedAt) ?? timeValue(compact.startedAt) ?? 0;
    const previousTs = previous ? (timeValue(previous.endedAt) ?? timeValue(previous.startedAt) ?? 0) : -1;
    if (!previous || currentTs >= previousTs) telemetryByTask.set(compact.taskId, compact);
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
  const ids = new Set([...latestGroupByTask.keys(), ...telemetryByTask.keys()]);
  for (const [taskId, task] of boardById) {
    if (ACTIVE_TREE_STATES.has(String(task?.state ?? '').toLowerCase())) ids.add(taskId);
  }
  const trees = [...ids].map(taskId => buildTreeForTask(taskId, {
    boardTask: boardById.get(taskId) ?? null,
    events: latestGroupByTask.get(taskId) ?? [],
    telemetry: telemetryByTask.get(taskId) ?? null,
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

// --- агрегатор -----------------------------------------------------------------

export function createControlRoomAggregator({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  socketPath = null,
  stateDirs = [],
  ringLimit = RING_LIMIT,
  boardTasksProvider = async () => [],
  bbThreadsProvider = async () => [],
  branchDriftProvider = null,
  netHealth = null,
  telemetryProvider = null,
  telemetryDir = process.env.DF_TELEMETRY_DIR ?? DEFAULT_TELEMETRY_DIR,
  modelsProvider = createModelsProvider(),
  finopsProvider = createFinopsProvider(),
  inspectProvider = async () => ({ text: '', artifacts: [] }),
  webDir = WEB_DIR,
  now = () => Date.now(),
} = {}) {
  const readTelemetry = telemetryProvider ?? createTelemetryProvider({ telemetryDir, now });
  const ring = [];           // ограниченный журнал событий (≤ ringLimit)
  const attempts = new Map(); // key → последнее состояние попытки
  const sseClients = new Set();
  let httpServer = null;
  let sockServer = null;
  let lastSeq = 0;
  let reconcileNeeded = false;

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
      } else if (task.state === 'ready' || task.state === 'queued') {
        queued.push(card);
      } else if (task.state === 'blocked' || task.state === 'awaiting_answer') {
        needsOwner.push({ ...card,
          question: task.blocked?.question ?? task.question ?? null,
          evidence: task.blocked?.reason ?? task.reason ?? null,
          cli: task.blocked?.question_id ?? task.question?.question_id
            ? `question-gate answer ${task.blocked?.question_id ?? task.question.question_id}` : null });
      } else if (task.state === 'completed' || task.state === 'done') {
        recentlyCompleted.push(card);
      }
    }
    return { running, queued, needsOwner, recentlyCompleted };
  };

  async function snapshot() {
    const [board, threads, telemetry] = await Promise.all([
      readBoardTasks(boardTasksProvider),
      bbThreadsProvider().catch(() => []),
      readTelemetry().catch(() => null)]);
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
    const boardExplorer = buildBoardExplorer(tasks);
    const repoSlots = buildRepoSlots(activeTrees);
    const reconciled = reconcileNeeded;
    reconcileNeeded = false;
    return {
      ts: new Date(now()).toISOString(),
      reconcile: reconciled,
      ...columns(tasks),
      boardStatus: board.boardStatus,
      health: { board: board.boardStatus },
      sessions: { active: sessions.active, archivedCount: sessions.archived.length },
      shiva,
      activeTrees,
      boardExplorer,
      repoSlots,
      branchDrift: drift,
      netHealth: net,
      telemetry,
      models,
      finops,
      eventsTail: ring.slice(-50),
      attemptsTracked: attempts.size,
    };
  }

  // --- HTTP ---------------------------------------------------------------

  const STATIC = new Map();
  const staticFile = async (name, type) => {
    if (!STATIC.has(name)) {
      STATIC.set(name, { body: await readFile(join(webDir, name)), type });
    }
    return STATIC.get(name);
  };

  const respond = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const port = httpServer?.address()?.port ?? port;
    if (!isAllowedHost(req.headers.host, port)) {
      res.writeHead(403, jsonHeaders());
      res.end(JSON.stringify({ error: 'forbidden_host' }));
      return;
    }
    if (!isAllowedOrigin(req.headers.origin, port)) {
      res.writeHead(403, jsonHeaders());
      res.end(JSON.stringify({ error: 'forbidden_origin' }));
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
        res.writeHead(200, { 'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache', Connection: 'keep-alive', ...SECURITY_HEADERS });
        res.write(`data: ${JSON.stringify({ type: 'snapshot', data: await snapshot() })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
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
    'telemetry-dir': { type: 'string' } } });
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
  const aggregator = createControlRoomAggregator({
    port, socketPath, stateDirs: values['state-dir'] ?? [],
    netHealth,
    boardTasksProvider: observeBoard.fetchTasks,
    bbThreadsProvider: () => loadBbThreadsFromCli(),
    branchDriftProvider: driftProvider,
    modelsProvider: createModelsProvider({
      catalogPath: values['models-catalog'],
      policyPath: values['routing-policy'] }),
    telemetryDir: values['telemetry-dir'],
    finopsProvider: createFinopsProvider({
      budgetPath: values['resources-budget'],
      workerUsagePath: values['worker-usage'],
      workerStatePath: cloudStatePath }) });
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
