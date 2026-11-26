// Регрессионные тесты pi-guard.cjs: прелоад нельзя require'ить в процессе
// теста (он патчит fs/net/child_process глобально), поэтому каждый зонд —
// отдельный child-процесс node --require pi-guard.cjs -e '<script>',
// печатающий JSON с кодами ошибок. Проверяются только пути отказов и
// безопасные контрольные случаи: guard не трётся о реальный /tmp/.pi
// (auth.json на хосте отсутствует), а запрещённые операции не выполняются.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pi-guard.cjs');

function probe(script) {
  const stdout = execFileSync(process.execPath,
    ['--require', GUARD, '-e', script],
    { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).at(-1);
  return JSON.parse(line);
}

test('v2: /proc/self/{root,cwd,fd,mem,environ,map_files} закрыты для fs', () => {
  const out = probe(`
    const fs = require('fs');
    const out = {};
    const tries = {
      procroot: '/proc/self/root/etc/passwd',
      procrootexact: '/proc/self/root',
      proccwd: '/proc/self/cwd/x',
      procenviron: '/proc/self/environ',
      procfd: '/proc/self/fd/0',
      procmem: '/proc/self/mem',
      procmap: '/proc/self/map_files/0',
      procpid: '/proc/1/root/etc/passwd',
      picfg: '/pi-cfg/secret',
    };
    for (const [key, target] of Object.entries(tries)) {
      try { fs.readFileSync(target); out[key] = 'ALLOWED'; }
      catch (e) { out[key] = e.code; }
    }
    try { fs.readdirSync('/proc/self/fd'); out.fdreaddir = 'ALLOWED'; }
    catch (e) { out.fdreaddir = e.code; }
    console.log(JSON.stringify(out));
  `);
  for (const key of ['procroot', 'procrootexact', 'proccwd', 'procenviron',
    'procfd', 'procmem', 'procmap', 'procpid', 'picfg', 'fdreaddir']) {
    assert.equal(out[key], 'EACCES', `${key}: ${JSON.stringify(out)}`);
  }
});

test('v2: симлинк из разрешённого поддерева наружу резолвится и запрещается', () => {
  const out = probe(`
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const out = {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-test-'));
    fs.symlinkSync('/', path.join(dir, 'rootlink'));
    fs.symlinkSync('/var', path.join(dir, 'varlink'));
    fs.symlinkSync('/etc', path.join(dir, 'etclink'));
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'hi');
    // Контрольная цепочка симлинков внутри разрешённого /tmp.
    fs.symlinkSync(path.join(dir, 'ok.txt'), path.join(dir, 'oklink'));
    for (const key of ['rootlink', 'varlink', 'etclink']) {
      try { fs.readdirSync(path.join(dir, key)); out[key] = 'ALLOWED'; }
      catch (e) { out[key] = e.code; }
    }
    try { fs.readFileSync(path.join(dir, 'ok.txt'), 'utf8'); out.plain = 'ALLOWED'; }
    catch (e) { out.plain = e.code; }
    try { fs.readFileSync(path.join(dir, 'oklink'), 'utf8'); out.innerlink = 'ALLOWED'; }
    catch (e) { out.innerlink = e.code; }
    console.log(JSON.stringify(out));
  `);
  // '/' и '/var' вне ALLOW_DIRS — резолв запрещён, хотя лексически путь в /tmp.
  assert.equal(out.rootlink, 'EACCES', JSON.stringify(out));
  assert.equal(out.varlink, 'EACCES', JSON.stringify(out));
  // '/etc' внутри периметра ALLOW_DIRS — резолв в него разрешён политикой.
  assert.equal(out.etclink, 'ALLOWED', JSON.stringify(out));
  // Легитимные чтения внутри /tmp (в т.ч. через симлинк внутрь /tmp) работают.
  assert.equal(out.plain, 'ALLOWED', JSON.stringify(out));
  assert.equal(out.innerlink, 'ALLOWED', JSON.stringify(out));
});

test('v2: ls -L и --dereference запрещены, обычный ls разрешён', () => {
  const out = probe(`
    const cp = require('child_process');
    const out = {};
    const run = (key, args) => {
      const r = cp.spawnSync('ls', args);
      out[key] = r.error ? r.error.code : 'status' + r.status;
    };
    run('plain', []);
    run('la', ['-la']);
    run('dashL', ['-L']);
    run('clusterL', ['-lL']);
    run('deref', ['--dereference']);
    console.log(JSON.stringify(out));
  `);
  assert.equal(out.plain, 'status0', JSON.stringify(out));
  assert.equal(out.la, 'status0', JSON.stringify(out));
  assert.equal(out.dashL, 'EACCES', JSON.stringify(out));
  assert.equal(out.clusterL, 'EACCES', JSON.stringify(out));
  assert.equal(out.deref, 'EACCES', JSON.stringify(out));
});

test('v2: rg --ignore-file-case-insensitive и прочие deny-флаги запрещены', () => {
  const out = probe(`
    const cp = require('child_process');
    const out = {};
    const run = (key, cmd, args) => {
      const r = cp.spawnSync(cmd, args);
      out[key] = r.error ? r.error.code : 'status' + r.status;
    };
    run('rgCase', 'rg', ['--ignore-file-case-insensitive', 'x']);
    run('rgCaseEq', 'rg', ['--ignore-file-case-insensitive=yes', 'x']);
    run('rgFollow', 'rg', ['--follow', 'x']);
    run('rgPre', 'rg', ['--pre', 'cat', 'x']);
    run('rgFile', 'rg', ['--file', '/etc/passwd']);
    run('rgEtc', 'rg', ['--files', '/etc']);
    run('grepR', 'grep', ['-R', 'x']);
    run('findExec', 'find', ['/tmp', '-exec', 'id', ';']);
    console.log(JSON.stringify(out));
  `);
  for (const key of Object.keys(out)) {
    assert.equal(out[key], 'EACCES', `${key}: ${JSON.stringify(out)}`);
  }
});

test('v2: произвольные бинарники и exec по-прежнему запрещены', () => {
  const out = probe(`
    const cp = require('child_process');
    const out = {};
    const r1 = cp.spawnSync('bash', ['-c', 'echo hi']);
    out.bash = r1.error ? r1.error.code : 'status' + r1.status;
    const r2 = cp.spawnSync('curl', ['https://x']);
    out.curl = r2.error ? r2.error.code : 'status' + r2.status;
    const r3 = cp.spawnSync('/tmp/evil-ls', []);
    out.tmpbin = r3.error ? r3.error.code : 'status' + r3.status;
    try { cp.execSync('echo hi'); out.exec = 'ALLOWED'; }
    catch (e) { out.exec = e.code; }
    console.log(JSON.stringify(out));
  `);
  assert.equal(out.bash, 'EACCES', JSON.stringify(out));
  assert.equal(out.curl, 'EACCES', JSON.stringify(out));
  assert.equal(out.tmpbin, 'EACCES', JSON.stringify(out));
  assert.equal(out.exec, 'EACCES', JSON.stringify(out));
});

test('v2: IPv4-mapped IPv6 нормализуется к частному адресу и запрещается', () => {
  const out = probe(`
    const net = require('net');
    const out = {};
    const keys = ['mapped', 'mappedhex', 'mappedpub', 'plain', 'pub'];
    const targets = {
      mapped: { host: '::ffff:127.0.0.1', port: 80 },
      mappedhex: { host: '::ffff:7f00:1', port: 80 },
      mappedpub: { host: '::ffff:8.8.8.8', port: 44100 },
      plain: { host: '127.0.0.1', port: 80 },
      pub: { host: '203.0.113.1', port: 80 },
    };
    let pending = keys.length;
    const done = () => { if (--pending === 0) console.log(JSON.stringify(out)); };
    for (const key of keys) {
      const s = net.connect(targets[key]);
      s.on('error', (e) => { out[key] = e.code; s.destroy(); done(); });
      s.on('connect', () => { out[key] = 'CONNECTED'; s.destroy(); done(); });
    }
    setTimeout(() => { out.timeout = true; console.log(JSON.stringify(out)); process['exit'](0); }, 8000).unref();
  `);
  // ::ffff:127.0.0.1 и hex-форма — частные: отказ egress до коннекта.
  assert.equal(out.mapped, 'ENETUNREACH', JSON.stringify(out));
  assert.equal(out.mappedhex, 'ENETUNREACH', JSON.stringify(out));
  assert.equal(out.plain, 'ENETUNREACH', JSON.stringify(out));
  assert.equal(out.pub, 'ENETUNREACH', JSON.stringify(out));
  // 44100 запрещён всегда, даже для публичного адреса.
  assert.equal(out.mappedpub, 'ENETUNREACH', JSON.stringify(out));
});

test('v2: unix domain socket путь проверяется по fs-политике в net.connect', () => {
  const out = probe(`
    const net = require('net');
    const out = {};
    const keys = ['picfg', 'procroot', 'pi', 'allowed'];
    const targets = {
      picfg: { path: '/pi-cfg/x.sock' },
      procroot: { path: '/proc/self/root/tmp/x.sock' },
      pi: { path: '/tmp/.pi/agent/x.sock' },
      allowed: { path: '/tmp/nonexistent-pg-probe.sock' },
    };
    let pending = keys.length;
    const done = () => { if (--pending === 0) console.log(JSON.stringify(out)); };
    for (const key of keys) {
      const s = net.connect(targets[key]);
      s.on('error', (e) => { out[key] = e.code; s.destroy(); done(); });
      s.on('connect', () => { out[key] = 'CONNECTED'; s.destroy(); done(); });
    }
    setTimeout(() => { out.timeout = true; console.log(JSON.stringify(out)); process['exit'](0); }, 8000).unref();
  `);
  assert.equal(out.picfg, 'EACCES', JSON.stringify(out));
  assert.equal(out.procroot, 'EACCES', JSON.stringify(out));
  assert.equal(out.pi, 'EACCES', JSON.stringify(out));
  // Разрешённый путь доходит до реального connect: ENOENT, а не отказ гарда.
  assert.equal(out.allowed, 'ENOENT', JSON.stringify(out));
});

test('v2: http.request с socketPath проверяется по fs-политике', () => {
  const out = probe(`
    const http = require('http');
    const out = {};
    let pending = 2;
    const done = () => { if (--pending === 0) console.log(JSON.stringify(out)); };
    const r1 = http.request({ socketPath: '/pi-cfg/x.sock', path: '/' });
    r1.on('error', (e) => { out.picfg = e.code; done(); });
    r1.end();
    const r2 = http.request({ socketPath: '/proc/self/root/tmp/x.sock', path: '/' });
    r2.on('error', (e) => { out.procroot = e.code; done(); });
    r2.end();
    setTimeout(() => { out.timeout = true; console.log(JSON.stringify(out)); process['exit'](0); }, 8000).unref();
  `);
  assert.equal(out.picfg, 'EACCES', JSON.stringify(out));
  assert.equal(out.procroot, 'EACCES', JSON.stringify(out));
});

test('v2: egress на публичный неразрешённый хост запрещён в http и fetch', () => {
  const out = probe(`
    const out = {};
    let pending = 2;
    const done = () => { if (--pending === 0) console.log(JSON.stringify(out)); };
    const http = require('http');
    const r1 = http.request({ host: '203.0.113.1', port: 80, path: '/' });
    r1.on('error', (e) => { out.http = e.code; done(); });
    r1.end();
    fetch('http://203.0.113.1/').then(
      () => { out.fetch = 'ALLOWED'; done(); },
      (e) => { out.fetch = e.code ?? e.message; done(); });
    setTimeout(() => { out.timeout = true; console.log(JSON.stringify(out)); process['exit'](0); }, 8000).unref();
  `);
  assert.equal(out.http, 'ENETUNREACH', JSON.stringify(out));
  assert.equal(out.fetch, 'ENETUNREACH', JSON.stringify(out));
});
