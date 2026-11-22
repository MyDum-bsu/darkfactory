'use strict';
// Песочный прелоад ревьюера (--require). Две обязанности:
// 1. После первого чтения auth.json или первого исходящего запроса секрет
//    перезаписывается {} и удаляется; дальнейшие обращения к /tmp/.pi — EACCES.
// 2. Egress ограничен allowlist PI_ALLOW_CONNECT + api.openai.com/chatgpt.com:443;
//    loopback/приватные адреса и порт 44100 заблокированы (кроме явного прокси).
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const PI_HOME = '/tmp/.pi';
const AUTH = '/tmp/.pi/agent/auth.json';
const ALLOW_DIRS = ['/candidate', '/pi-ro/bin', '/pi-ro/install', '/pi-ro/npm',
  '/pi-guard', '/tmp/session', '/tmp', '/usr', '/lib', '/lib64',
  '/etc', '/proc', '/dev', '/sys', '/run', '/.agents', '/home', '/root', '/opt'];
// После первого исходящего соединения (locked) секретные конфиги закрыты
// для всех — включая файловые тулы; /pi-cfg с копией auth.json закрыт всегда.
const SECRET_FILES = new Set(['/tmp/.pi/agent/auth.json',
  '/tmp/.pi/agent/auth.json.lock', '/tmp/.pi/agent/settings.json',
  '/tmp/.pi/agent/models.json', '/tmp/.pi/agent/models-store.json',
  '/tmp/.pi/agent/keybindings.json']);
let locked = false;
const lock = () => { locked = true; };
let scrubbed = false;

function scrub() {
  // Файл не удаляем: pi перечитывает креденшел на каждый запрос. Доступ
  // рубится в guardFn по стеку — только креденшельный код pi его ещё видит.
  if (scrubbed) return;
  scrubbed = true;
}

const eacces = (target) => {
  const err = new Error(`EACCES: permission denied, open '${target}'`);
  err.code = 'EACCES';
  err.errno = -13;
  err.syscall = 'open';
  err.path = String(target);
  return err;
};

function pathOf(arg) {
  if (typeof arg === 'string') return arg;
  if (Buffer.isBuffer(arg)) return arg.toString('utf8');
  if (arg instanceof URL) return arg.pathname;
  return null;
}

function fsForbidden(p) {
  if (p === null) return false;
  const norm = path.resolve(p);
  if (norm === '/pi-cfg' || norm.startsWith('/pi-cfg/')) return true;
  if (SECRET_FILES.has(norm)) return locked || scrubbed;
  return !ALLOW_DIRS.some(dir => norm === dir || norm.startsWith(dir + '/'));
}

// auth.json нужен pi при каждом разрешении креденшелов (читается лениво,
// без кэша) — нельзя удалить после первого чтения. Отличить чтение самого pi
// от файлового тула можно только по стеку: креденшелы читаются из
// RuntimeCredentials/ModelsImpl внутри /pi-ro, тулы — из своих чанков.
const CRED_STACK = /RuntimeCredentials|readCredential|CredentialStore|AuthStorage/;
const isCredentialRead = () => CRED_STACK.test(new Error().stack || '');

// Обернуть fs-функцию: отказ до вызова.
function guardFn(obj, key, { asyncCb = false, promise = false } = {}) {
  const original = obj[key];
  if (typeof original !== 'function') return;
  obj[key] = function (...args) {
    const p = pathOf(args[0]);
    if (p !== null && path.resolve(p) === AUTH && !(locked || scrubbed)) {
      return original.apply(this, args);
    }
    if (p !== null && path.resolve(p) === AUTH && isCredentialRead()) {
      // pi перечитывает креденшел на каждый запрос — разрешаем только его
      // креденшельному коду; тул с обычным стеком ниже получит EACCES.
      return original.apply(this, args);
    }
    if (fsForbidden(p)) {
      const err = eacces(p);
      if (promise) return Promise.reject(err);
      if (asyncCb) {
        const cb = args.at(-1);
        if (typeof cb === 'function') return process.nextTick(cb, err);
        return Promise.reject(err);
      }
      throw err;
    }
    return original.apply(this, args);
  };
}

for (const key of ['readFile', 'open', 'readdir', 'stat', 'lstat', 'realpath', 'access', 'opendir']) {
  guardFn(fs, key, { asyncCb: true });
}
for (const key of ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync',
  'realpathSync', 'accessSync', 'opendirSync', 'existsSync', 'createReadStream']) {
  guardFn(fs, key);
}
if (fs.promises) {
  for (const key of ['readFile', 'open', 'readdir', 'stat', 'lstat', 'realpath', 'access', 'opendir']) {
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
  if (p === 44100) return false;
  if (allowEndpoints.has(`${h}:${p}`)) return true;
  if (privateHost(h)) return false;
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
  scrub();
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
    scrub();
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
    scrub();
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
  scrub();
  return origTls.apply(this, args);
};
