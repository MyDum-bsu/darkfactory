'use strict';
// Песочный прелоад ревьюера (--require). Три обязанности:
// 1. До старта pi auth.json читается в память и стирается с диска: на ФС его
//    нет ни для тулов, ни для симлинков, ни для внешних утилит. Креденшельный
//    код pi получает байты из замыкания — и только если его вызвал именно
//    креденшельный стек (RuntimeCredentials/ModelsImpl).
// 2. Egress is limited to pinned model authorities and the sandbox-local
//    proxy listener. Its host broker has a separate CONNECT allowlist.
// 3. child_process ограничен read-only утилитами (rg/grep/find/ls), чтобы
//    внутри контейнера нельзя было поднять curl/wget/nc/bash/node без гарда.
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { fileURLToPath } = require('url');

// Исходники fs фиксируются до обёрток — гард сам пользуется ими без рекурсии.
const origReadFileSync = fs.readFileSync.bind(fs);
const origUnlinkSync = fs.unlinkSync.bind(fs);
const origRealpathSync = fs.realpathSync.bind(fs);
const origRealpathNativeSync = fs.realpathSync.native.bind(fs.realpathSync);
const origReadlinkSync = fs.readlinkSync.bind(fs);
const origLstatSync = fs.lstatSync.bind(fs);
const origStatSync = fs.statSync.bind(fs);
const origExistsSync = fs.existsSync.bind(fs);

const PI_HOME = '/tmp/.pi';
const AUTH = '/tmp/.pi/agent/auth.json';
const ALLOW_DIRS = ['/candidate', '/pi-ro/bin', '/pi-ro/install', '/pi-ro/npm',
  '/pi-guard', '/review', '/tmp/session', '/tmp', '/usr', '/lib', '/lib64',
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
  if (arg instanceof URL) {
    try {
      return fileURLToPath(arg);
    } catch {
      return '/pi-cfg/.pi-guard-invalid-url';
    }
  }
  return null;
}

function pathValues(arg) {
  if (Array.isArray(arg)) return arg.flatMap(item => pathValues(item));
  const value = pathOf(arg);
  return value === null ? [] : [value];
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

// /proc/<pid>/{root,cwd,fd,mem,environ,map_files} — ловушки обхода песочницы:
// /proc/self/root — симлинк на '/', через который доступен весь хост,
// /proc/self/environ выдаёт переменные окружения (с секретами), fd/mem —
// чужие дескрипторы и память процесса.
const PROC_BYPASS = /^\/proc\/[^/]+\/(?:root|cwd|fd|mem|environ|map_files)(?:\/|$)/;

function fsForbiddenLexical(norm) {
  if (PROC_BYPASS.test(norm)) return true;
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

function fsForbidden(p) {
  if (p === null) return false;
  const norm = path.resolve(p);
  if (fsForbiddenLexical(norm)) return true;
  // Симлинки резолвятся до проверки: ссылка из разрешённого поддерева
  // (/tmp/x -> /proc/self/root или -> /pi-cfg) не выводит за периметр.
  // Несуществующие пути не резолвятся — остаётся лексическая проверка.
  let real = null;
  try { real = origRealpathSync(norm); } catch { /* цели нет — лексики достаточно */ }
  if (real !== null && real !== norm && fsForbiddenLexical(real)) return true;
  return false;
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
  const pathArgs = opts.pathArgs ?? [0];
  obj[key] = function (...args) {
    const first = pathOf(args[0]);
    if (first !== null && path.resolve(first) === AUTH) {
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
        if (key === 'realpath' || key === 'realpathSync' || key === 'realpathSyncNative') {
          if (key.endsWith('Sync') || key.endsWith('SyncNative')) return AUTH;
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
      return deny(first, args, opts);
    }
    for (const index of pathArgs) {
      for (const p of pathValues(args[index])) {
        if (fsForbidden(p)) return deny(p, args, opts);
      }
    }
    return original.apply(this, args);
  };
}

function globStaticRoot(pattern) {
  const magic = pattern.search(/[*?{}[\]]/);
  const before = magic === -1 ? pattern : pattern.slice(0, magic);
  const slash = before.lastIndexOf('/');
  return slash === -1 ? '' : (before.slice(0, slash) || '/');
}

function globReachesSecret(pattern, cwdNorm, dot) {
  const root = path.resolve(cwdNorm, globStaticRoot(pattern) || '.');
  const protectedRoots = [PI_HOME, '/pi-cfg'];
  const broad = /[*?{}[\]]/.test(pattern) || dot === true;
  return broad && protectedRoots.some(target =>
    root === target || target.startsWith(root === '/' ? '/' : root + '/'));
}

// glob принимает patterns и options.cwd: обе части проверяются до перечисления,
// включая рекурсивную форму, способную дойти до /tmp/.pi или /pi-cfg.
function guardGlobFn(obj, key, opts = {}) {
  const original = obj[key];
  if (typeof original !== 'function') return;
  obj[key] = function (...args) {
    const options = args[1] !== null && typeof args[1] === 'object' ? args[1] : {};
    const cwd = pathOf(options.cwd) ?? process.cwd();
    const cwdNorm = path.resolve(cwd);
    if (fsForbidden(cwdNorm)) return deny(cwdNorm, args, opts);
    const patterns = Array.isArray(args[0]) ? args[0] : [args[0]];
    for (const raw of patterns) {
      if (typeof raw !== 'string') continue;
      const pattern = raw.replace(/^!+/, '');
      const norm = path.resolve(cwdNorm, pattern);
      if (fsForbidden(norm) || globReachesSecret(norm, cwdNorm, options.dot)) {
        return deny(norm, args, opts);
      }
    }
    return original.apply(this, args);
  };
}

for (const key of ['readFile', 'open', 'readdir', 'stat', 'lstat', 'realpath',
  'access', 'opendir', 'exists', 'readlink']) {
  guardFn(fs, key, { asyncCb: true });
}
guardFn(fs, 'copyFile', { asyncCb: true, pathArgs: [0, 1] });
guardFn(fs, 'cp', { asyncCb: true, pathArgs: [0, 1] });
guardFn(fs, 'openAsBlob', { promise: true });
guardGlobFn(fs, 'glob', { asyncCb: true });
for (const key of ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync',
  'realpathSync', 'accessSync', 'opendirSync', 'existsSync', 'createReadStream',
  'copyFileSync', 'cpSync', 'readlinkSync']) {
  guardFn(fs, key, key === 'copyFileSync' || key === 'cpSync' ? { pathArgs: [0, 1] } : {});
}
guardGlobFn(fs, 'globSync');
if (typeof origRealpathNativeSync === 'function') {
  const native = { realpathSyncNative: origRealpathNativeSync };
  guardFn(native, 'realpathSyncNative');
  try { fs.realpathSync.native = native.realpathSyncNative; } catch { /* function object sealed */ }
}
if (fs.promises) {
  for (const key of ['readFile', 'open', 'readdir', 'stat', 'lstat', 'realpath',
    'access', 'opendir', 'readlink']) {
    guardFn(fs.promises, key, { promise: true });
  }
  guardFn(fs.promises, 'copyFile', { promise: true, pathArgs: [0, 1] });
  guardFn(fs.promises, 'cp', { promise: true, pathArgs: [0, 1] });
  guardFn(fs.promises, 'openAsBlob', { promise: true });
  guardGlobFn(fs.promises, 'glob', { promise: true });
}

const allowEndpoints = new Set((process.env.PI_ALLOW_CONNECT ?? '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const bridgePort = Number(process.env.DF_MODEL_PROXY_PORT);

function privateHost(host) {
  let h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-mapped IPv6 (::ffff:127.0.0.1, ::ffff:7f00:1) — тот же частный
  // адрес в иной записи: нормализуем до IPv4 перед проверками диапазонов.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) h = mapped[1];
  else {
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      h = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    }
  }
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
  if (p === 44100) return false;
  // This address is inside --network=none, never the host's loopback.
  if (h === '127.0.0.1' && p === bridgePort && Number.isSafeInteger(p) && p > 0 && p <= 65535) return true;
  if (privateHost(h)) return false;
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
    // Unix domain socket — тоже путь ФС: /proc/self/root/... или симлинк
    // в запрещённое поддерево закрыт той же политикой, что и fs.
    if (fsForbidden(String(opts.path))) {
      const err = eacces(String(opts.path), 'connect');
      process.nextTick(() => this.destroy(err));
      return this;
    }
    lock();
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

function deniedRequest(host, port, err) {
  const req = new EventEmitter();
  req.write = () => false;
  req.end = () => {
    process.nextTick(() => req.emit('error', err ?? enet(host, port)));
    return req;
  };
  req.abort = req.destroy = () => req;
  req.setTimeout = () => req;
  return req;
}

// Опции http(s).request могут нести Unix domain socket: его путь подчиняется
// той же fs-политике, что и в net.connect — иначе сокет в /proc/self/root
// или за симлинком обходит периметр.
function socketPathOf(args) {
  const first = args[0];
  if (first !== null && typeof first === 'object' && !(first instanceof URL) &&
      typeof first.socketPath === 'string') {
    return first.socketPath;
  }
  return null;
}

for (const [mod, defPort] of [[http, 80], [https, 443]]) {
  const origRequest = mod.request;
  mod.request = function (...args) {
    const socketPath = socketPathOf(args);
    if (socketPath !== null && fsForbidden(socketPath)) {
      return deniedRequest(socketPath, 0, eacces(socketPath, 'connect'));
    }
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
const FIND_FOLLOW_DENY = new Set(['-H', '-L', '-follow']);
const RG_DENY_LONG = new Set(['pre', 'pre-glob', 'follow', 'ignore-file', 'file',
  'ignore-file-case-insensitive']);
const GREP_DENY_LONG = new Set(['file', 'exclude-from', 'dereference-recursive']);
const LONG_VALUE = {
  rg: new Set(['after-context', 'before-context', 'context', 'colors', 'encoding', 'engine',
    'field-context-separator', 'field-match-separator', 'glob', 'iglob', 'max-columns',
    'max-count', 'max-depth', 'max-filesize', 'path-separator', 'regexp', 'replace',
    'sort', 'sortr', 'threads', 'type', 'type-not', 'type-add']),
  grep: new Set(['after-context', 'before-context', 'context', 'binary-files',
    'devices', 'directories', 'exclude', 'exclude-dir', 'include', 'label',
    'max-count', 'regexp']),
  ls: new Set(['block-size', 'format', 'hide', 'indicator-style',
    'quoting-style', 'sort', 'time', 'time-style', 'width', 'tabsize']),
};
const SHORT_VALUE = {
  rg: new Set(['A', 'B', 'C', 'E', 'e', 'g', 'j', 'm', 'M', 't', 'T']),
  grep: new Set(['A', 'B', 'C', 'D', 'd', 'e', 'm']),
  ls: new Set(['I', 'T', 'w']),
};

// Базовые имена резолвятся в точный системный путь, чтобы PATH не участвовал
// в выборе бинарника: злонамеренный PATH в окружении не подсунет свой `ls`.
function resolveChild(file) {
  const f = String(file ?? '');
  if (f.includes('/')) return CHILD_PATHS.has(f) ? f : null;
  if (!CHILD_ALLOW.has(f)) return null;
  if (origExistsSync(`/usr/bin/${f}`)) return `/usr/bin/${f}`;
  return `/bin/${f}`;
}

function scanSearchArgs(cmd, argv) {
  const positional = [];
  let patternSupplied = false;
  let filesMode = false;
  let options = true;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (options && token === '--') {
      options = false;
      continue;
    }
    if (options && token.startsWith('--')) {
      const name = token.slice(2).split('=', 1)[0];
      if ((cmd === 'rg' && RG_DENY_LONG.has(name)) ||
          (cmd === 'grep' && GREP_DENY_LONG.has(name))) return null;
      if (cmd === 'rg' && name === 'files') filesMode = true;
      if (name === 'regexp') patternSupplied = true;
      if (LONG_VALUE[cmd].has(name) && !token.includes('=')) i++;
      continue;
    }
    if (options && token.length > 1 && token.startsWith('-')) {
      const body = token.slice(1);
      for (let j = 0; j < body.length; j++) {
        const flag = body[j];
        if (cmd === 'rg' && (flag === 'f' || flag === 'L')) return null;
        if (cmd === 'grep' && (flag === 'f' || flag === 'R')) return null;
        if (flag === 'e') patternSupplied = true;
        if (SHORT_VALUE[cmd].has(flag)) {
          if (j === body.length - 1) i++;
          break;
        }
      }
      continue;
    }
    positional.push(token);
  }
  if (filesMode) return positional;
  return patternSupplied ? positional : positional.slice(1);
}

function scanLsArgs(argv) {
  const positional = [];
  let options = true;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (options && token === '--') {
      options = false;
      continue;
    }
    if (options && token.startsWith('--')) {
      const name = token.slice(2).split('=', 1)[0];
      // --dereference заставляет ls ходить по симлинкам за пределы снимка.
      if (name === 'dereference') return null;
      if (LONG_VALUE.ls.has(name) && !token.includes('=')) i++;
      continue;
    }
    if (options && token.length > 1 && token.startsWith('-')) {
      const body = token.slice(1);
      for (let j = 0; j < body.length; j++) {
        // -L dereference: stat целей симлинков за пределами /candidate.
        if (body[j] === 'L') return null;
        if (SHORT_VALUE.ls.has(body[j])) {
          if (j === body.length - 1) i++;
          break;
        }
      }
      continue;
    }
    positional.push(token);
  }
  return positional;
}

function scanFindArgs(argv) {
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-P' || token === '--') continue;
    if (token.startsWith('-O') && token.length > 2) continue;
    if (token === '-D' || token === '-O') {
      i++;
      continue;
    }
    if (token.startsWith('-') || token === '!' || token === '(' || token === ')' || token === ',') break;
    paths.push(token);
  }
  return paths;
}

function childCwd(rest) {
  const opt = rest.find(a => a !== null && typeof a === 'object' && !Array.isArray(a));
  return typeof opt?.cwd === 'string' ? opt.cwd : '/candidate';
}

function childPathAllowed(raw, cwd) {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) return false;
  if (raw.split('/').includes('..')) return false;
  const resolved = path.resolve(cwd, raw);
  const inCandidate = resolved === '/candidate' || resolved.startsWith('/candidate/');
  const inReview = resolved === '/review' || resolved.startsWith('/review/');
  if (!inCandidate && !inReview) return false;
  return !inCandidate || noSymlinkInCandidate(resolved);
}

function argsAllowed(file, rest) {
  const cmd = path.basename(String(file ?? ''));
  const argv = Array.isArray(rest[0]) ? rest[0] : [];
  if (!argv.every(a => typeof a === 'string')) return false;
  let paths;
  if (cmd === 'find') {
    if (argv.some(a => FIND_DENY.has(a) || FIND_FOLLOW_DENY.has(a) ||
        a === '-samefile' || a === '-files0-from' || a.startsWith('-newer'))) return false;
    paths = scanFindArgs(argv);
  } else if (cmd === 'rg' || cmd === 'grep') {
    paths = scanSearchArgs(cmd, argv);
    if (paths === null) return false;
  } else if (cmd === 'ls') {
    paths = scanLsArgs(argv);
    if (paths === null) return false;
  } else {
    return false;
  }
  const cwd = childCwd(rest);
  return paths.every(p => childPathAllowed(p, cwd));
}

// Проверка каждого компонента пути под /candidate: симлинк не должен
// выводить наружу — его цель тоже канонизируется через native realpath.
function noSymlinkInCandidate(raw) {
  const lex = path.resolve(String(raw));
  if (lex !== '/candidate' && !lex.startsWith('/candidate/')) return false;
  let cur = '/candidate';
  for (const seg of lex.slice('/candidate/'.length).split('/')) {
    if (!seg) continue;
    cur = `${cur}/${seg}`;
    let st;
    try { st = origLstatSync(cur); } catch { return false; }
    if (st.isSymbolicLink()) {
      let target;
      try {
        const t = origReadlinkSync(cur);
        const abs = path.isAbsolute(t) ? t : path.resolve(path.dirname(cur), t);
        target = origRealpathNativeSync(abs);
      } catch { return false; }
      if (target !== '/candidate' && !target.startsWith('/candidate/')) return false;
      cur = target;
    }
  }
  return true;
}

// Возвращает rest с канонизированным options.cwd либо null при отказе.
// В оригинальный spawn уходит только проверенный путь — сырой cwd с '..'
// никогда не доходит до chdir.
function cwdOptions(rest) {
  const idx = rest.findIndex(a => a !== null && typeof a === 'object' && !Array.isArray(a));
  if (idx === -1) return rest;
  const opt = rest[idx];
  if (opt.shell) return null;
  if (opt.cwd === undefined) return rest;
  const raw = String(opt.cwd);
  let real;
  try {
    // native realpath(3) резолвит симлинки ДО '..' — лексическая проверка
    // fs.realpathSync пропускала бы '/candidate/symlink_out/..'.
    real = origRealpathNativeSync(raw);
  } catch { return null; }
  if (real !== '/candidate' && !real.startsWith('/candidate/')) return null;
  if (!noSymlinkInCandidate(raw)) return null;
  const next = rest.slice();
  next[idx] = { ...opt, cwd: real };
  return next;
}

function guardChild(key, sync) {
  const orig = cp[key];
  if (typeof orig !== 'function') return;
  cp[key] = function (file, ...rest) {
    // exec()/execSync()/fork() всегда через шелл или произвольный модуль —
    // запрещены безусловно.
    const resolved = resolveChild(file);
    const cleanRest = cwdOptions(rest);
    const blocked = key === 'exec' || key === 'execSync' || key === 'fork' ||
      resolved === null || cleanRest === null || !argsAllowed(resolved ?? file, cleanRest ?? rest);
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
    return orig.call(this, resolved, ...cleanRest);
  };
}
guardChild('spawn');
guardChild('exec');
guardChild('execFile');
guardChild('fork');
guardChild('spawnSync', true);
guardChild('execSync', true);
guardChild('execFileSync', true);
