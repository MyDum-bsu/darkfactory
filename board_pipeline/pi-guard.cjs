'use strict';
// Песочный прелоад ревьюера (--require). Три обязанности:
// 1. До старта pi auth.json читается в память и стирается с диска: на ФС его
//    нет ни для тулов, ни для симлинков, ни для внешних утилит. Креденшельный
//    код pi получает байты из замыкания — и только если его вызвал именно
//    креденшельный стек (RuntimeCredentials/ModelsImpl).
// 2. Egress ограничен allowlist PI_ALLOW_CONNECT + api.openai.com/chatgpt.com:443;
//    приватные/loopback адреса и порт 44100 отклоняются ДО allowlist — даже
//    явно разрешённый приватный прокси не пройдёт.
// 3. child_process ограничен read-only утилитами (rg/grep/find/ls), чтобы
//    внутри контейнера нельзя было поднять curl/wget/nc/bash/node без гарда.
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

// Исходники fs фиксируются до обёрток — гард сам пользуется ими без рекурсии.
const origReadFileSync = fs.readFileSync.bind(fs);
const origUnlinkSync = fs.unlinkSync.bind(fs);
const origRealpathSync = fs.realpathSync.bind(fs);
const origReadlinkSync = fs.readlinkSync.bind(fs);
const origLstatSync = fs.lstatSync.bind(fs);
const origStatSync = fs.statSync.bind(fs);
const origExistsSync = fs.existsSync.bind(fs);

const PI_HOME = '/tmp/.pi';
const AUTH = '/tmp/.pi/agent/auth.json';
const ALLOW_DIRS = ['/candidate', '/pi-ro/bin', '/pi-ro/install', '/pi-ro/npm',
  '/pi-guard', '/tmp/session', '/tmp', '/usr', '/lib', '/lib64',
  '/etc', '/proc', '/dev', '/sys', '/run', '/.agents', '/home', '/root', '/opt'];
// Конфиги, к которым после lock доступ имеет только внутренний код pi.
const SECRET_FILES = new Set(['/tmp/.pi/agent/auth.json',
  '/tmp/.pi/agent/auth.json.lock', '/tmp/.pi/agent/settings.json',
  '/tmp/.pi/agent/models.json', '/tmp/.pi/agent/models-store.json',
  '/tmp/.pi/agent/keybindings.json']);

// Секрет уходит в память до любого кода pi: файл исчезает ещё в прелоаде.
let authBytes = null;
if (origExistsSync(AUTH)) {
  authBytes = origReadFileSync(AUTH);
  // Секрет обязан исчезнуть с диска до старта pi. Не смогли удалить —
  // ревью небезопасно: фатально, без тихого продолжения.
  try {
    origUnlinkSync(AUTH);
  } catch (e) {
    process.stderr.write(`pi-guard: cannot remove ${AUTH}: ${e.message}\n`);
    process.exit(1);
  }
  if (origExistsSync(AUTH)) {
    process.stderr.write(`pi-guard: ${AUTH} still present after unlink\n`);
    process.exit(1);
  }
  try { origUnlinkSync(AUTH + '.lock'); } catch { /* lock ещё не создан */ }
}

let locked = false;
const lock = () => { locked = true; };

const eacces = (target, syscall = 'open') => {
  const err = new Error(`EACCES: permission denied, ${syscall} '${target}'`);
  err.code = 'EACCES';
  err.errno = -13;
  err.syscall = syscall;
  err.path = String(target);
  return err;
};

function pathOf(arg) {
  if (typeof arg === 'string') return arg;
  if (Buffer.isBuffer(arg)) return arg.toString('utf8');
  if (arg instanceof URL) return arg.pathname;
  return null;
}

// Внутренний код pi работает в /pi-ro; туловые вызовы идут из /tools/-частей
// бандла. auth.json отдаётся только креденшельным функциям pi — стек
// RuntimeCredentials/readCredential воспроизвести тулом нельзя.
const PI_STACK = /\/pi-ro\//;
const TOOL_STACK = /\/tools\/|\/candidate/;
const CRED_STACK = /RuntimeCredentials|readCredential|CredentialStore|AuthStorage|migrateAuth/;
const stackOf = () => new Error().stack || '';
// Вызов только из кода pi: стек обязан проходить через /pi-ro и не иметь
// туловых/candidate-фреймов; одного совпадения имени недостаточно.
const piInternal = () => {
  const s = stackOf();
  return s.includes('/pi-ro/') && !TOOL_STACK.test(s);
};
const isCredentialRead = () => {
  const s = stackOf();
  return CRED_STACK.test(s) && s.includes('/pi-ro/') && !TOOL_STACK.test(s);
};

// realpath уводит симлинки /candidate за пределы снимка (в т.ч. в /tmp/.pi) —
// такие пути запрещены. Битая ссылка проверяется по lstat+readlink.
function escapesCandidate(norm) {
  try {
    const real = origRealpathSync(norm);
    return real !== '/candidate' && !real.startsWith('/candidate/');
  } catch {
    try {
      if (origLstatSync(norm).isSymbolicLink()) {
        const target = path.resolve(path.dirname(norm), origReadlinkSync(norm));
        return target !== '/candidate' && !target.startsWith('/candidate/');
      }
    } catch { /* файл не существует — пусть реальная fs ответит ENOENT */ }
    return false;
  }
}

function fsForbidden(p) {
  if (p === null) return false;
  const norm = path.resolve(p);
  if (norm === '/pi-cfg' || norm.startsWith('/pi-cfg/')) return true;
  if (norm === PI_HOME || norm.startsWith(PI_HOME + '/')) {
    if (SECRET_FILES.has(norm)) return !piInternal();
    return !piInternal();
  }
  if (norm === '/candidate' || norm.startsWith('/candidate/')) {
    return escapesCandidate(norm);
  }
  return !ALLOW_DIRS.some(dir => norm === dir || norm.startsWith(dir + '/'));
}

// Поддельный stat для auth.json: файл удалён, но креденшельный код pi может
// спросить его размер/тип до чтения.
function fakeAuthStat() {
  const st = origStatSync(__filename);
  try {
    st.size = authBytes ? authBytes.length : 0;
    st.mtime = new Date(0);
    st.mtimeMs = 0;
    st.ctime = st.mtime;
    st.ctimeMs = 0;
  } catch { /* поля могут быть read-only — вернём как есть */ }
  return st;
}

// Ответ на чтение auth.json из памяти по форме оригинальной функции.
function serveAuth(original, args, { asyncCb = false, promise = false } = {}) {
  const encOpt = args[1];
  const enc = typeof encOpt === 'string' ? encOpt
    : (encOpt !== null && typeof encOpt === 'object' ? encOpt.encoding : undefined);
  const buf = () => enc ? authBytes.toString(enc === 'utf8' ? 'utf8' : enc)
    : Buffer.from(authBytes);
  if (promise) return Promise.resolve(buf());
  if (asyncCb) {
    const cb = args.at(-1);
    if (typeof cb === 'function') {
      process.nextTick(cb, null, buf());
      return undefined;
    }
    return Promise.resolve(buf());
  }
  return buf();
}

const DEBUG = !!process.env.PI_GUARD_DEBUG;

function deny(p, args, { asyncCb = false, promise = false } = {}) {
  if (DEBUG) {
    process.stderr.write(`[guard] deny ${p}\n${new Error().stack || ''}\n`);
  }
  const err = eacces(p);
  if (promise) return Promise.reject(err);
  if (asyncCb) {
    const cb = args.at(-1);
    if (typeof cb === 'function') {
      process.nextTick(cb, err);
      return undefined;
    }
    return Promise.reject(err);
  }
  throw err;
}

// Обернуть fs-функцию: отказ до вызова.
function guardFn(obj, key, opts = {}) {
  const original = obj[key];
  if (typeof original !== 'function') return;
  obj[key] = function (...args) {
    const p = pathOf(args[0]);
    if (p !== null && path.resolve(p) === AUTH) {
      // Файла на диске нет: байты из памяти отдаём только креденшельному коду
      // pi (имя функции И строго /pi-ro в стеке, без /tools/ и /candidate).
      if (authBytes !== null && isCredentialRead()) {
        if (key === 'existsSync') return true;
        if (key === 'exists') {
          const cb = args.at(-1);
          if (typeof cb === 'function') process.nextTick(cb, true);
          return undefined;
        }
        if (key === 'statSync' || key === 'lstatSync') return fakeAuthStat();
        if (key === 'stat' || key === 'lstat') {
          const cb = args.at(-1);
          if (typeof cb === 'function') process.nextTick(cb, null, fakeAuthStat());
          return undefined;
        }
        if (key === 'realpath' || key === 'realpathSync') {
          if (key.endsWith('Sync')) return AUTH;
          const cb = args.at(-1);
          if (typeof cb === 'function') return process.nextTick(cb, null, AUTH);
          return Promise.resolve(AUTH);
        }
        if (key === 'access' || key === 'accessSync') {
          const cb = args.at(-1);
          if (typeof cb === 'function') return process.nextTick(cb, null);
          return undefined;
        }
        return serveAuth(original, args, opts);
      }
      return deny(p, args, opts);
    }
    if (fsForbidden(p)) return deny(p, args, opts);
    return original.apply(this, args);
  };
}

for (const key of ['readFile', 'open', 'readdir', 'stat', 'lstat', 'realpath',
  'access', 'opendir', 'exists']) {
  guardFn(fs, key, { asyncCb: true });
}
for (const key of ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync',
  'realpathSync', 'accessSync', 'opendirSync', 'existsSync', 'createReadStream']) {
  guardFn(fs, key);
}
if (fs.promises) {
  for (const key of ['readFile', 'open', 'readdir', 'stat', 'lstat', 'realpath',
    'access', 'opendir']) {
    guardFn(fs.promises, key, { promise: true });
  }
}

const allowEndpoints = new Set((process.env.PI_ALLOW_CONNECT ?? '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

function privateHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::' ||
      h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function connectAllowed(host, port) {
  const h = String(host ?? '').toLowerCase();
  const p = Number(port);
  // Приватное/loopback и порт Board отклоняются ДО allowlist: прокси на
  // приватном адресе не считается разрешённым даже при явном совпадении.
  if (p === 44100 || privateHost(h)) return false;
  if (allowEndpoints.has(`${h}:${p}`)) return true;
  return (h === 'api.openai.com' || h === 'chatgpt.com') && p === 443;
}

const enet = (host, port) => {
  const err = new Error(`ENETUNREACH: review sandbox egress denied ${host}:${port}`);
  err.code = 'ENETUNREACH';
  err.errno = -101;
  err.syscall = 'connect';
  return err;
};

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node 22 нормализует вызов в единый массив [options, listener].
  const opts = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof opts === 'object' && opts !== null && opts.path) {
    return origConnect.apply(this, args);
  }
  const host = typeof opts === 'object' && opts !== null ? (opts.host ?? 'localhost')
    : typeof opts === 'string' ? 'localhost'
    : typeof args[1] === 'string' ? args[1] : 'localhost';
  const port = typeof opts === 'object' && opts !== null ? opts.port
    : typeof opts === 'number' ? opts : undefined;
  if (!connectAllowed(host, port)) {
    process.nextTick(() => this.destroy(enet(host, port)));
    return this;
  }
  lock();
  return origConnect.apply(this, args);
};

function requestTarget(args, defaultPort) {
  const first = args[0];
  if (first instanceof URL) {
    return { host: first.hostname, port: first.port || defaultPort };
  }
  if (typeof first === 'string') {
    try {
      const u = new URL(first);
      return { host: u.hostname, port: u.port || defaultPort };
    } catch {
      return { host: 'localhost', port: defaultPort };
    }
  }
  if (first !== null && typeof first === 'object') {
    const host = first.hostname ?? first.host ?? 'localhost';
    const port = first.port ?? (first._defaultAgent === https.globalAgent ? 443 : defaultPort);
    return { host: String(host).split(':')[0], port };
  }
  return { host: 'localhost', port: defaultPort };
}

function deniedRequest(host, port) {
  const req = new EventEmitter();
  req.write = () => false;
  req.end = () => { process.nextTick(() => req.emit('error', enet(host, port))); return req; };
  req.abort = req.destroy = () => req;
  req.setTimeout = () => req;
  return req;
}

for (const [mod, defPort] of [[http, 80], [https, 443]]) {
  const origRequest = mod.request;
  mod.request = function (...args) {
    const { host, port } = requestTarget(args, defPort);
    if (!connectAllowed(host, port)) return deniedRequest(host, port);
    lock();
    return origRequest.apply(this, args);
  };
}

if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input?.url;
    try {
      const u = new URL(url);
      const port = u.port || (u.protocol === 'https:' ? 443 : 80);
      if (!connectAllowed(u.hostname, port)) {
        return Promise.reject(enet(u.hostname, port));
      }
    } catch (e) {
      if (e?.code === 'ENETUNREACH') throw e;
      return Promise.reject(e instanceof TypeError ? e : enet(String(url), '?'));
    }
    lock();
    return origFetch.call(this, input, init);
  };
}

const origTls = require('tls').connect;
require('tls').connect = function (...args) {
  const opts = args[0];
  const host = typeof opts === 'object' && opts !== null ? (opts.host ?? 'localhost') : 'localhost';
  const port = typeof opts === 'object' && opts !== null ? opts.port : args[0];
  if (!connectAllowed(host, port)) {
    const req = new EventEmitter();
    process.nextTick(() => req.emit('error', enet(host, port)));
    req.setTimeout = () => req;
    req.destroy = () => req;
    return req;
  }
  lock();
  return origTls.apply(this, args);
};

// Только read-only поисковые утилиты: внешние сетевые/шелл-бинарники внутри
// песочницы не поднимаются. NODE_OPTIONS наследуется — гард живёт и в детях.
const cp = require('child_process');
// Только имена read-only утилит либо точные системные пути: произвольный
// путь (особенно из /candidate или /tmp) не считается доверенным.
const CHILD_ALLOW = new Set(['rg', 'grep', 'find', 'ls']);
const CHILD_PATHS = new Set(['/usr/bin/rg', '/usr/bin/grep', '/bin/grep',
  '/usr/bin/find', '/bin/ls', '/usr/bin/ls']);
// find способен исполнять внешние команды — такие флаги закрыты.
const FIND_DENY = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete',
  '-fls', '-fprint', '-fprint0', '-fprintf']);

// Базовые имена резолвятся в точный системный путь, чтобы PATH не участвовал
// в выборе бинарника: злонамеренный PATH в окружении не подсунет свой `ls`.
function resolveChild(file) {
  const f = String(file ?? '');
  if (f.includes('/')) return CHILD_PATHS.has(f) ? f : null;
  if (!CHILD_ALLOW.has(f)) return null;
  if (origExistsSync(`/usr/bin/${f}`)) return `/usr/bin/${f}`;
  return `/bin/${f}`;
}

function argsAllowed(file, rest) {
  if (path.basename(String(file ?? '')) !== 'find') return true;
  const argv = Array.isArray(rest[0]) ? rest[0] : [];
  return !argv.some(a => FIND_DENY.has(String(a)));
}

function optionsAllowed(rest) {
  const opt = rest.find(a => a !== null && typeof a === 'object' && !Array.isArray(a));
  if (!opt) return true;
  if (opt.shell) return false;
  if (opt.cwd !== undefined) {
    // Симлинк внутри /candidate не должен увести cwd наружу — по realpath.
    try {
      const cwd = origRealpathSync(String(opt.cwd));
      if (cwd !== '/candidate' && !cwd.startsWith('/candidate/')) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function guardChild(key, sync) {
  const orig = cp[key];
  if (typeof orig !== 'function') return;
  cp[key] = function (file, ...rest) {
    // exec()/execSync()/fork() всегда через шелл или произвольный модуль —
    // запрещены безусловно.
    const resolved = resolveChild(file);
    const blocked = key === 'exec' || key === 'execSync' || key === 'fork' ||
      resolved === null || !argsAllowed(file, rest) || !optionsAllowed(rest);
    if (blocked) {
      if (DEBUG) {
        process.stderr.write(`[guard] deny ${key} ${file}\n`);
      }
      const err = eacces(String(file), 'spawn');
      // spawnSync не бросает при невозможном spawn — возвращает result с
      // error; иначе синхронный throw ломает инициализацию pi.
      if (key === 'spawnSync') {
        return { status: 126, signal: null, output: [null, '', String(err.message)],
          stdout: '', stderr: String(err.message), error: err, pid: 0 };
      }
      if (sync) throw err;
      const cb = rest.find(a => typeof a === 'function');
      if (cb) process.nextTick(cb, err);
      const fake = new EventEmitter();
      fake.pid = 0;
      fake.kill = () => true;
      fake.stdout = new EventEmitter();
      fake.stderr = new EventEmitter();
      process.nextTick(() => {
        // error только при наличии слушателя: голый EventEmitter без
        // обработчика 'error' ронял бы процесс.
        if (key !== 'exec' && fake.listenerCount('error') > 0) fake.emit('error', err);
        fake.emit('exit', 126, null);
      });
      return fake;
    }
    return orig.call(this, resolved, ...rest);
  };
}
guardChild('spawn');
guardChild('exec');
guardChild('execFile');
guardChild('fork');
guardChild('spawnSync', true);
guardChild('execSync', true);
guardChild('execFileSync', true);
