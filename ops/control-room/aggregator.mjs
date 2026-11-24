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
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
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

// RO-опрос Board :44100 — только GET чтение очереди.
export async function loadBoardTasksFromApi(boardUrl, { fetchImpl } = {}) {
  const fetcher = fetchImpl ?? fetch;
  const res = await fetcher(new URL('/api/board', boardUrl),
    { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return [];
  const body = await res.json();
  return Array.isArray(body?.tasks) ? body.tasks : Array.isArray(body) ? body : [];
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
  telemetryProvider = async () => null,
  inspectProvider = async () => ({ text: '', artifacts: [] }),
  webDir = WEB_DIR,
  now = () => Date.now(),
} = {}) {
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
      const lead = t.lead_session_id ?? t.leadSessionId ?? t.parent_id ?? null;
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
        title: task.title ?? '', labels: task.labels ?? {}, epoch: task.epoch ?? null };
      if (task.state === 'claimed' || task.state === 'working') {
        const key = [...attempts.values()]
          .find(a => String(a.task_id) === String(card.task_id));
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
    const [tasks, threads, telemetry] = await Promise.all([
      boardTasksProvider().catch(() => []),
      bbThreadsProvider().catch(() => []),
      telemetryProvider().catch(() => null)]);
    const net = netHealth ? await netHealth.snapshot().catch(() => null) : null;
    const drift = branchDriftProvider
      ? await branchDriftProvider().catch(() => ({ driftDetected: null, error: true }))
      : null;
    const sessions = sessionHygiene(threads, tasks, attempts);
    const shiva = shivaCounter(threads, tasks);
    const reconciled = reconcileNeeded;
    reconcileNeeded = false;
    return {
      ts: new Date(now()).toISOString(),
      reconcile: reconciled,
      ...columns(tasks),
      sessions: { active: sessions.active, archivedCount: sessions.archived.length },
      shiva,
      branchDrift: drift,
      netHealth: net,
      telemetry,
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
        res.end(JSON.stringify({ taskId,
          text: sanitizeTerminalText(String(data.text ?? '')),
          artifacts: Array.isArray(data.artifacts) ? data.artifacts.slice(0, 64) : [] }));
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
//   [--board-url URL] [--net-probe name=url ...]
async function cli(argv) {
  const { values } = parseArgs({ args: argv, options: {
    port: { type: 'string' }, socket: { type: 'string' },
    'state-dir': { type: 'string', multiple: true },
    'board-url': { type: 'string' },
    'net-probe': { type: 'string', multiple: true },
    'cloud-state': { type: 'string' } } });
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
    cloudStatePath: values['cloud-state'] ?? null });
  const boardUrl = values['board-url'] ?? process.env.BOARD_URL ?? 'http://127.0.0.1:44100';
  const aggregator = createControlRoomAggregator({
    port, socketPath, stateDirs: values['state-dir'] ?? [],
    netHealth,
    boardTasksProvider: () => loadBoardTasksFromApi(boardUrl),
    bbThreadsProvider: () => loadBbThreadsFromCli() });
  const { port: actual } = await aggregator.start();
  console.log(JSON.stringify({ control_room: 'listening', host: '127.0.0.1', port: actual,
    socket: socketPath }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await cli(process.argv.slice(2)); } catch (error) {
    console.error(`control-room: ${error.message}`);
    process.exitCode = 1;
  }
}
