// Fail-open эмиттер структурированных JSON-событий фабрики (V2-3).
// Два канала доставки, оба необязательные и ни один не способен уронить или
// затормозить контроллер:
//   1. <stateDir>/events.ndjson — локальный журнал с ротацией по размеру
//      (как RotatingJournal в daemon.mjs), права 0o600. Это источник
//      восстановления агрегатора после разрыва.
//   2. Unix domain socket (control-room.sock) — best-effort push для живого
//      Control Room. Недоступный/отказавший сокет, переполнение очереди и
//      таймаут НИКОГДА не бросают ошибку: ограниченная очередь с
//      drop-on-overflow, запись уходит в журнал независимо от сокета.
// Только встроенные модули Node.

import { open, rename, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_SOCKET_PATH = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'darkfactory', 'control-room.sock');

export const EVENT_FIELDS = Object.freeze(['seq', 'ts', 'project', 'channel',
  'task_id', 'attempt_id', 'epoch', 'kind', 'phase', 'role', 'mode', 'model',
  'deadline_rem_ms', 'tokens', 'round', 'reason', 'detail']);

const STRING_FIELDS = new Set(['project', 'channel', 'task_id', 'attempt_id',
  'kind', 'phase', 'role', 'mode', 'model', 'reason']);
const NUMBER_FIELDS = new Set(['seq', 'epoch', 'deadline_rem_ms', 'tokens', 'round']);

const str = (value, max = 1024) =>
  typeof value === 'string' && value ? value.slice(0, max) : null;
const num = value => Number.isSafeInteger(value) ? value :
  (typeof value === 'number' && Number.isFinite(value) ? value : null);

// Нормализация события в фиксированную схему: неизвестные ключи отбрасываются,
// строки обрезаются, числа проверяются на конечность. detail — произвольный
// JSON-подобъект (санитизирован до примитивов глубиной 2, строки ≤ 1024).
export function normalizeEvent(event) {
  const out = {};
  for (const field of EVENT_FIELDS) {
    const value = event?.[field];
    if (value === undefined || value === null) continue;
    if (field === 'ts') {
      out.ts = typeof value === 'string' ? value.slice(0, 64) : new Date(value).toISOString();
    } else if (STRING_FIELDS.has(field)) {
      const v = str(value);
      if (v !== null) out[field] = v;
    } else if (NUMBER_FIELDS.has(field)) {
      const v = num(value);
      if (v !== null) out[field] = v;
    } else if (field === 'detail') {
      const v = sanitizeDetail(value);
      if (v !== null) out.detail = v;
    }
  }
  return out;
}

function sanitizeDetail(value, depth = 0) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 1024);
  if (depth >= 2 || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    return value.slice(0, 64).map(item => sanitizeDetail(item, depth + 1));
  }
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    if (typeof key !== 'string' || !key || key.length > 128) continue;
    const v = sanitizeDetail(item, depth + 1);
    if (v !== null && v !== undefined) out[key] = v;
  }
  return out;
}

// Журнал событий с ротацией по размеру: events.ndjson, при переполнении
// сдвигается в events.N.ndjson, хранится keep поколений. Записи
// сериализуются цепочкой промисов — порядок seq сохраняется, ошибки ФС
// поглощаются (fail-open).
class NdjsonJournal {
  constructor({ directory, name = 'events', maxBytes = 10 * 1024 * 1024, keep = 3 }) {
    this.directory = directory;
    this.path = join(directory, `${name}.ndjson`);
    this.name = name;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.written = null; // null = размер ещё не известен (ленивый stat)
    this.chain = Promise.resolve();
  }

  append(line) {
    this.chain = this.chain.then(() => this.write(line)).catch(() => {});
    return this.chain;
  }

  async write(line) {
    const bytes = Buffer.byteLength(line);
    if (this.written === null) {
      this.written = (await stat(this.path).catch(() => null))?.size ?? 0;
    }
    if (this.written > 0 && this.written + bytes > this.maxBytes) {
      await this.rotate();
      this.written = 0;
    }
    const fd = await open(this.path, 'a', 0o600);
    try {
      await fd.write(line);
      this.written += bytes;
    } finally {
      await fd.close();
    }
  }

  async rotate() {
    for (let i = this.keep - 1; i >= 1; i--) {
      await rename(join(this.directory, `${this.name}.${i}.ndjson`),
        join(this.directory, `${this.name}.${i + 1}.ndjson`)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await rename(this.path, join(this.directory, `${this.name}.1.ndjson`)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

// Best-effort push в Unix domain socket. Постоянное соединение с
// переподключением: пока сокет недоступен, события копятся в ограниченной
// очереди (drop-on-overflow — журнал остаётся источником истины).
// connect/write/timeout ошибки гасятся и переводят сокет в «покой» до
// следующей попытки подключения.
class SocketPush {
  constructor({ socketPath, queueLimit = 256, connectTimeoutMs = 250, reconnectMs = 1000 }) {
    this.path = socketPath;
    this.queueLimit = queueLimit;
    this.connectTimeoutMs = connectTimeoutMs;
    this.reconnectMs = reconnectMs;
    this.queue = [];
    this.socket = null;
    this.connecting = false;
    this.backoffUntil = 0;
    this.closed = false;
  }

  push(line) {
    if (this.closed || this.path === null) return;
    if (this.socket) {
      this.writeLine(line);
      return;
    }
    if (this.queue.length >= this.queueLimit) this.queue.shift();
    this.queue.push(line);
    this.ensureConnected();
  }

  ensureConnected() {
    if (this.connecting || this.socket || this.closed || Date.now() < this.backoffUntil) return;
    this.connecting = true;
    const socket = createConnection(this.path);
    // Сокет не удерживает процесс: контроллер выходит без живого пульта.
    socket.unref?.();
    socket.setTimeout(this.connectTimeoutMs);
    socket.once('connect', () => {
      this.connecting = false;
      socket.setTimeout(0);
      this.socket = socket;
      socket.once('error', () => this.drop(socket));
      socket.once('close', () => this.drop(socket));
      const pending = this.queue;
      this.queue = [];
      for (const line of pending) this.writeLine(line);
    });
    socket.once('error', () => {
      this.connecting = false;
      this.backoffUntil = Date.now() + this.reconnectMs;
      socket.destroy();
    });
    socket.once('timeout', () => {
      this.connecting = false;
      this.backoffUntil = Date.now() + this.reconnectMs;
      socket.destroy();
    });
  }

  writeLine(line) {
    try {
      // Медленный читатель: буфер ядра растёт — рвём соединение и
      // возвращаем строку в ограниченную очередь (журнал — источник истины).
      if (this.socket.writableLength > 1024 * 1024) {
        this.drop(this.socket);
        this.push(line);
        return;
      }
      this.socket.write(line, () => {});
    } catch {
      this.drop(this.socket);
    }
  }

  drop(socket) {
    if (this.socket === socket) this.socket = null;
    try { socket.destroy(); } catch { /* noop */ }
  }

  close() {
    this.closed = true;
    this.queue = [];
    if (this.socket) {
      try {
        this.socket.unref?.();
        this.socket.end();
      } catch { /* noop */ }
      this.socket = null;
    }
  }
}

// createEventBus({ stateDir, socketPath, project, channel, ... })
//   stateDir   — приватный каталог попытки (events.ndjson пишется туда).
//   socketPath — путь Unix socket Control Room; null отключает push.
//   project/channel — дефолтные поля событий этого контроллера.
// emit() никогда не бросает и возвращает нормализованное событие (с seq/ts).
// close() дожидается цепочки записи журнала и закрывает сокет.
export function createEventBus({
  stateDir,
  socketPath = DEFAULT_SOCKET_PATH,
  project = null,
  channel = null,
  maxBytes = 10 * 1024 * 1024,
  keep = 3,
  queueLimit = 256,
  connectTimeoutMs = 250,
  reconnectMs = 1000,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof stateDir !== 'string' || !stateDir) throw new Error('event_bus_state_dir_required');
  const journal = new NdjsonJournal({ directory: stateDir, maxBytes, keep });
  const push = socketPath === null ? null : new SocketPush({
    socketPath, queueLimit, connectTimeoutMs, reconnectMs });
  let seq = 0;
  let closed = false;
  return {
    emit(event) {
      if (closed) return null;
      let normalized;
      try {
        normalized = normalizeEvent(event);
      } catch {
        return null;
      }
      normalized.seq = ++seq;
      normalized.ts = normalized.ts ?? now();
      if (normalized.project === undefined && project) normalized.project = project;
      if (normalized.channel === undefined && channel) normalized.channel = channel;
      const line = `${JSON.stringify(normalized)}\n`;
      journal.append(line).catch(() => {});
      push?.push(line);
      return normalized;
    },
    async close() {
      closed = true;
      push?.close();
      await journal.chain.catch(() => {});
    },
  };
}

// Бесшумный bus для контуров без Control Room: та же поверхность
// (emit/close), 0 записей, 0 сокетов.
export function createNoopEventBus() {
  return { emit: () => null, close: async () => {} };
}
