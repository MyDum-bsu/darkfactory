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
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { normalizeEvent } from '../../board_pipeline/event-bus.mjs';
import { isAllowedHost, isAllowedOrigin, isAllowedFetchSite, sanitizeTerminalText,
  SECURITY_HEADERS } from './origin-guard.mjs';
import { createNetHealthMonitor } from './net-health.mjs';
import { createFinopsProvider } from './finops.mjs';
import { buildAdaptiveGatesSummary } from '../../board_pipeline/adaptive-gates.mjs';
import { BOARD_API_PATH, buildBoardColumns, buildBoardExplorer, createBoardObserver,
  createBranchDriftProvider, readBoardTasks } from './board-observer.mjs';
import { buildActiveTrees, buildFleetTelemetry, buildRepoSlots, createFleetHostsProvider,
  createModelsProvider, createTelemetryProvider, readEventsTail } from './telemetry-fleet.mjs';

export { BOARD_API_PATH, buildBoardExplorer, createBoardObserver, createBranchDriftProvider,
  loadBoardTasksFromApi, normalizeBoardBaseUrl } from './board-observer.mjs';
export { DEFAULT_TELEMETRY_DIR, EVENTS_TAIL_CHUNK_BYTES, EVENTS_TAIL_MAX_BYTES_PER_FILE,
  FLEET_MAX_FILE_BYTES, FLEET_STALE_MS, TELEMETRY_MAX_BYTES, TELEMETRY_MAX_FILES,
  buildActiveTrees, buildFleetTelemetry, buildRepoSlots, createFleetHostsProvider,
  createModelsProvider, createTelemetryProvider, normalizeFleetHost,
  readFleetTelemetryFiles } from './telemetry-fleet.mjs';

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
      ...buildBoardColumns(tasks, attempts),
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
//   [--resources-budget PATH] [--worker-usage PATH] [--worker-state-file PATH]
// Worker state: --worker-state-file > legacy --cloud-state > DF_WORKER_STATE_FILE > XDG default.
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

export function parseControlRoomArgs(argv, env = process.env) {
  const { values } = parseArgs({ args: argv, options: {
    port: { type: 'string' }, socket: { type: 'string' },
    'state-dir': { type: 'string', multiple: true },
    'board-url': { type: 'string' },
    'board-channels': { type: 'string' },
    'board-token': { type: 'string' },
    'drift-repo': { type: 'string', multiple: true },
    'drift-ttl': { type: 'string' },
    'net-probe': { type: 'string', multiple: true },
    'worker-state-file': { type: 'string' },
    'cloud-state': { type: 'string' },
    'models-catalog': { type: 'string' },
    'routing-policy': { type: 'string' },
    'resources-budget': { type: 'string' },
    'worker-usage': { type: 'string' },
    'telemetry-dir': { type: 'string' },
    'fleet-dir': { type: 'string' },
    'kill-switch': { type: 'string' },
    'owner-write-token': { type: 'string' } } });
  const workerStatePath = values['worker-state-file'] ?? values['cloud-state'] ??
    env.DF_WORKER_STATE_FILE ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
      'darkfactory', 'cloud-worker-state.json');
  return { values, workerStatePath };
}

async function cli(argv) {
  const { values, workerStatePath } = parseControlRoomArgs(argv);
  const port = values.port !== undefined ? Number(values.port)
    : Number(process.env.DF_CONTROL_ROOM_PORT ?? DEFAULT_PORT);
  const socketPath = values.socket !== undefined ? values.socket
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
        'darkfactory', 'control-room.sock');
  const netHealth = createNetHealthMonitor({
    probes: (values['net-probe'] ?? []).map(spec => {
      const i = spec.indexOf('=');
      return { name: spec.slice(0, i), url: spec.slice(i + 1) };
    }),
    cloudStatePath: workerStatePath });
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
      workerStatePath }),
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
