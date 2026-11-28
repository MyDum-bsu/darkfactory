import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { createActionServer } from './server.mjs';

const token = 'private-operator-token-for-fixtures';
const ABSENT = Symbol('omit header');
const click = { action: 'kill', session: 't7', task: '18806' };
const terminal = { state: 'live', address: 't7', name: 'df-18806-0123456789', created_ms: 10,
  pid: 999, labels: { 'darkfactory.task': '18806', 'darkfactory.attempt': 'attempt-1' } };

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'action-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const auditPath = join(root, 'clicks.jsonl');
  const calls = [];
  const exec = async (file, args, opts) => {
    assert.equal(opts.shell, false);
    calls.push([file, args]);
    if (file === '/mock/hc' && args[0] === 'get') return { stdout: JSON.stringify(terminal) };
    if (file === '/mock/hc' && args[0] === 'kill') return { stdout: JSON.stringify({ ...terminal, state: 'finished' }) };
    if (file === '/mock/controller') return { stdout: '{"accepted":true}' };
    throw Error('unexpected command');
  };
  const server = createActionServer({ auditPath, token, actor: 'operator', hcPath: '/mock/hc',
    releaseAdapter: '/mock/controller', exec, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const all = Object.fromEntries(Object.entries({ origin, 'content-type': 'application/json', ...headers }).filter(([, v]) => v !== ABSENT));
    const req = request(origin + path, { method: 'POST', servername: '127.0.0.1', headers: all }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const login = async () => {
    const r = await post('/api/action-session', {}, { authorization: `Bearer ${token}` });
    assert.equal(r.status, 200);
    return { authorization: `Bearer ${r.sessionId}`, 'x-csrf-nonce': r.nonce };
  };
  return { post, login, calls, root, auditPath, origin, send: (headers, body = click) => post('/api/action', body, headers),
    rows: async () => (await readFile(auditPath, 'utf8')).trimEnd().split('\n').map(s => JSON.parse(s)) };
}

test('both session minting and actions require the exact browser origin/host; nonces belong to one login', async t => {
  const f = await fixture(t);
  const first = await f.login(), second = await f.login();
  assert.notEqual(first['x-csrf-nonce'], second['x-csrf-nonce']);
  const alias = f.origin.replace('127.0.0.1', 'localhost');
  const rejected = [{ origin: ABSENT }, { origin: '' }, { origin: 'null' }, { origin: alias },
    { host: new URL(alias).host, origin: alias }, { origin: `${f.origin}/` }, { origin: f.origin.replace('http:', 'https:') },
    { origin: [f.origin, f.origin] }, { host: [new URL(f.origin).host, new URL(f.origin).host] }, { 'sec-fetch-site': 'cross-site' }];
  for (const headers of rejected) {
    assert.equal((await f.post('/api/action-session', {}, { authorization: `Bearer ${token}`, ...headers })).status, 403);
    assert.equal((await f.send({ ...first, ...headers })).status, 403);
  }
  for (const headers of [{}, { authorization: first.authorization }, { ...first, 'x-csrf-nonce': second['x-csrf-nonce'] }]) {
    assert.equal((await f.send(headers)).status, 403);
  }
  assert.equal((await f.post('/api/action-session', {}, { authorization: 'Bearer wrong' })).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.rows()).filter(row => row.action === 'kill' && row.outcome === 'denied').length, rejected.length + 3);
});

test('reject non-allowlisted verbs, targets, fields and stale task bindings', async t => {
  const f = await fixture(t), auth = await f.login();
  for (const fields of [{ action: 'send' }, { action: 'constructor' }, { args: [] }, { actor: 'owner' },
    { session: '--all' }, { session: 'remote/t7' }, { session: 't7;id' }, { task: 18806 }, { task: null }, { attempt: null }, { attempt: '' }, { address: terminal.name },
    { session: terminal.name }]) {
    assert.equal((await f.send(auth, { ...click, ...fields })).status, 400);
  }
  assert.equal(f.calls.length, 0);
  assert.notEqual((await f.send(auth, { ...click, task: '42' })).status, 200);
  assert.deepEqual(f.calls, [['/mock/hc', ['get', '--json', '--', 't7']]]);
});

test('finished and retired release targets stay bound to the clicked task, attempt and address', async t => {
  let state = 'finished';
  const accepted = [];
  const f = await fixture(t, { exec: async (file, args) => {
    if (file === '/mock/hc' && args[0] === 'get') return { stdout: JSON.stringify({ ...terminal, state }) };
    assert.equal(file, '/mock/controller'); accepted.push(args); return { stdout: '{"accepted":true}' };
  } });
  const auth = { ...await f.login(), 'content-type': 'application/json; charset=utf-8' };
  const bound = { ...click, session: terminal.name, address: terminal.address, attempt: 'attempt-1' };
  for (state of ['finished', 'retired']) {
    for (const action of ['approve-red-stop', 'trigger-deploy-rollback']) {
      for (const mismatch of [{ attempt: 'attempt-old' }, { address: 't1' }, { task: '42' }]) {
        assert.deepEqual(await f.send(auth, { ...bound, action, ...mismatch }), { status: 409, error: 'target_mismatch' });
      }
      assert.equal((await f.send(auth, { ...bound, action })).status, 200);
      assert.deepEqual(accepted.at(-1), [action, '--', terminal.address, click.task, bound.attempt]);
      const receipt = (await f.rows()).at(-1);
      assert.equal(receipt.attempt, bound.attempt); assert.equal(receipt.address, bound.address);
    }
    for (const action of ['kill', 'pause', 'resume']) assert.equal((await f.send(auth, { ...bound, action })).status, 409);
  }
  state = 'live';
  assert.deepEqual(await f.send(auth, { ...bound, attempt: 'attempt-old' }), { status: 409, error: 'target_mismatch' });
  assert.equal(accepted.length, 4);
});

test('immutable address works without a name but cannot match a recycled name', async t => {
  let t7 = terminal;
  const f = await fixture(t, { exec: async (_, args) => {
    if (args[0] === 'get') return { stdout: JSON.stringify(t7) };
    assert.deepEqual(args, ['kill', '--json', '--', 't7']);
    return { stdout: JSON.stringify({ ...terminal, state: 'finished' }) };
  } });
  const auth = await f.login();
  assert.equal((await f.send(auth, { action: 'kill', task: click.task, address: 't7' })).status, 200);
  t7 = { ...terminal, name: 't7', address: 't8' };
  assert.deepEqual(await f.send(auth), { status: 409, error: 'target_mismatch' });
});

test('append intent before dispatch and retain earlier receipts, including on repeated clicks', async t => {
  const f = await fixture(t), auth = await f.login();
  for (const action of ['kill', 'approve-red-stop', 'trigger-deploy-rollback']) {
    const before = await readFile(f.auditPath, 'utf8');
    assert.equal((await f.send(auth, { ...click, action })).status, 200);
    assert.ok((await readFile(f.auditPath, 'utf8')).startsWith(before));
    const [started, done] = (await f.rows()).slice(-2);
    assert.equal(started.outcome, 'started'); assert.equal(done.outcome, 'succeeded');
    assert.equal(started.clickId, done.clickId);
    for (const row of [started, done]) {
      assert.equal(row.actor, 'operator'); assert.equal(row.session, 't7'); assert.equal(row.task, '18806');
      assert.equal(row.action, action); assert.ok(Number.isFinite(Date.parse(row.timestamp)));
    }
    assert.deepEqual(f.calls.at(-1), action === 'kill' ? ['/mock/hc', ['kill', '--json', '--', 't7']] :
      ['/mock/controller', [action, '--', 't7', '18806', 'attempt-1']]);
  }
  const log = await readFile(f.auditPath, 'utf8');
  for (const secret of [token, auth.authorization.slice(7), auth['x-csrf-nonce']]) assert.ok(!log.includes(secret));
  const other = join(f.root, 'other'); await writeFile(other, 'untouched');
  await rm(f.auditPath); await symlink(other, f.auditPath);
  const count = f.calls.length;
  assert.equal((await f.send(auth)).status, 503); assert.equal(f.calls.length, count);
  assert.equal(await readFile(other, 'utf8'), 'untouched');
  await rm(f.auditPath);
  assert.equal((await f.send(auth)).status, 200); // repaired audit destination
});

// Required Node-only contract: mock the OS boundary, not the gate. No hc,
// executable temp files, Python installation or signal permission in L1.
test('pause/resume use only the attested hc identity and fail closed on helper refusal', async t => {
  const calls = [];
  let refuse = false;
  const f = await fixture(t, { exec: async (file, args, opts) => {
    calls.push([file, args]);
    assert.equal(opts.shell, false);
    if (file === '/mock/hc') return { stdout: JSON.stringify(terminal) };
    if (refuse) throw Error('pidfd unavailable');
    return { stdout: '' };
  } });
  const auth = await f.login();
  for (const [action, unavailable] of [['pause', false], ['resume', false], ['pause', true]]) {
    refuse = unavailable;
    calls.length = 0;
    const r = await f.send(auth, { ...click, session: terminal.name, attempt: 'attempt-1', action });
    assert.equal(r.status, refuse ? 502 : 200);
    assert.equal((await f.rows()).at(-1).outcome, refuse ? 'failed' : 'succeeded');
    assert.equal(calls.length, 2); // No signal-by-PID fallback, even on failure.
    assert.deepEqual(calls[0], ['/mock/hc', ['get', '--json', '--', terminal.name]]);
    const [file, args] = calls[1];
    assert.equal(file, '/usr/bin/python3'); assert.deepEqual(args.slice(0, 2), ['-I', '-c']);
    assert.deepEqual(args.slice(3), ['/mock/hc', 't7', '18806', 'attempt-1', '10', '999', action]);
  }
});

test('Linux pidfd helper rechecks the hc binding before signaling the fixture process', async t => {
  const python = '/usr/bin/python3', run = promisify(execFile);
  // Determine the expected outcome independently of the gate. On Node-only
  // hosts the same clicks must fail closed and leave failure receipts.
  let hasPidfd = true;
  try {
    await run(python, ['-I', '-c', `import errno, os, signal, sys
try: signal.pidfd_send_signal(os.pidfd_open(os.getpid()), 0)
except (AttributeError, NotImplementedError, PermissionError): sys.exit(77)
except OSError as e:
    if e.errno != errno.ENOSYS: raise
    sys.exit(77)`]);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 77) throw err;
    hasPidfd = false;
  }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  t.after(async () => { child.kill('SIGKILL'); await exited; });
  const live = { ...terminal, pid: child.pid };
  let current = { ...live, created_ms: live.created_ms + 1 };
  const f = await fixture(t, { exec: async (file, args, opts) => {
    if (file === '/mock/hc') return { stdout: JSON.stringify(live) };
    assert.equal(file, python);
    // Supply only the second hc get result. Execute the production helper
    // with real pidfd syscalls, without installing a shim on L1's /tmp.
    const mockGet = `import os, subprocess\ndef get(argv, timeout):\n    assert argv == ['/mock/hc','get','--json','--','t7']\n    return os.environ['MOCK_HC_JSON']\nsubprocess.check_output = get\n`;
    return run(file, [...args.slice(0, 2), mockGet + args[2], ...args.slice(3)],
      { ...opts, env: { ...opts.env, MOCK_HC_JSON: JSON.stringify(current) } });
  } });
  const auth = await f.login();
  const stopped = async () => /^State:\s+T/m.test(await readFile(`/proc/${child.pid}/status`, 'utf8'));
  assert.equal((await f.send(auth, { ...click, action: 'pause' })).status, 502);
  assert.equal((await f.rows()).at(-1).outcome, 'failed');
  if (process.platform === 'linux') assert.equal(await stopped(), false);
  current = live;
  for (const action of ['pause', 'resume']) {
    const result = await f.send(auth, { ...click, action });
    assert.equal(result.status, hasPidfd ? 200 : 502);
    const [intent, receipt] = (await f.rows()).slice(-2);
    assert.equal(intent.outcome, 'started'); assert.equal(intent.clickId, receipt.clickId);
    assert.equal(receipt.action, action);
    assert.equal(receipt.outcome, hasPidfd ? 'succeeded' : 'failed');
    if (!hasPidfd) assert.equal(result.error, 'action_unconfirmed');
    if (process.platform === 'linux') {
      // Successful signal delivery need not change /proc state synchronously.
      const expectedStop = hasPidfd && action === 'pause';
      const deadline = performance.now() + 2000;
      while ((await stopped()) !== expectedStop && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(await stopped(), expectedStop);
    }
  }
});

test('served console unlocks and submits a confirmed click without exposing credentials in the URL', async t => {
  const f = await fixture(t);
  const response = await fetch(f.origin);
  assert.equal(response.status, 200);
  const html = await response.text();
  const nodes = new Map(Array.from(html.matchAll(/id="(hc-[a-z]+)"/g), ([, id]) =>
    [id, { value: '', disabled: id === 'hc-controls', addEventListener(type, fn) { this[type] = fn; } }]));
  for (const action of ['pause', 'resume', 'kill', 'approve-red-stop', 'trigger-deploy-rollback']) {
    assert.ok(html.includes(`<option>${action}</option>`));
  }
  const app = await fetch(f.origin + '/app.js');
  const $ = id => nodes.get(id);
  let confirm = false;
  runInNewContext(await app.text(), { document: { body: { dataset: { view: 'action-gate' } }, getElementById: $ },
    window: { confirm: () => confirm }, fetch: (path, opts) => {
      assert.ok(['/api/action-session', '/api/action'].includes(path));
      return fetch(f.origin + path, { ...opts, headers: { ...opts.headers, origin: f.origin } });
    } });
  $('hc-token').value = token;
  await $('hc-login').click();
  assert.equal($('hc-token').value, ''); assert.equal($('hc-controls').disabled, false);
  for (const [key, value] of Object.entries(click)) $(`hc-${key}`).value = value;
  await $('hc-submit').click(); assert.equal(f.calls.length, 0);
  confirm = true;
  await $('hc-submit').click();
  assert.deepEqual(f.calls.at(-1), ['/mock/hc', ['kill', '--json', '--', 't7']]);
  assert.match($('hc-status').textContent, /Accepted: kill on t7/);
  $('hc-session').value = terminal.name; $('hc-attempt').value = 'attempt-1';
  await $('hc-submit').click();
  assert.equal((await f.rows()).at(-1).attempt, 'attempt-1');
  assert.match($('hc-status').textContent, /Accepted: kill on df-/);
});

test('audit truncation fails one click closed; later intents survive truncation and rotation', async t => {
  const f = await fixture(t), auth = await f.login();
  await writeFile(f.auditPath, '');
  assert.equal((await f.send(auth)).status, 503);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.send(auth)).status, 200);
  await rename(f.auditPath, join(f.root, 'old.jsonl'));
  assert.equal((await f.send(auth)).status, 200);
  assert.deepEqual((await f.rows()).map(r => r.outcome), ['started', 'succeeded']);
});

test('denial audits have a shared bounded budget; authorized clicks and later denials still get receipts', async t => {
  let now = 123;
  const f = await fixture(t, { now: () => now });
  const auth = await f.login();
  for (let i = 0; i < 40; i++) {
    const r = await f.send(i % 2 ? {} : { ...auth, 'x-csrf-nonce': 'bad' });
    assert.ok([403, 429].includes(r.status));
  }
  const n = (await f.rows()).length;
  assert.ok(n > 1 && n < 41);
  assert.equal((await f.send(auth)).status, 200);
  now += 60_000;
  assert.equal((await f.send({})).status, 403);
  assert.equal((await f.rows()).length, n + 3);
});

test('expired sessions, missing controller adapters and failed hc calls never report success', async t => {
  let now = 100;
  const f = await fixture(t, { now: () => now, releaseAdapter: null }), auth = await f.login();
  assert.equal((await f.send(auth, { ...click, action: 'trigger-deploy-rollback' })).status, 503);
  assert.equal((await f.rows()).at(-1).code, 'release_adapter_unavailable');
  now += 900_000;
  assert.equal((await f.send(auth)).status, 403);
  const bad = await fixture(t, { exec: async () => { throw Error('private error detail'); } });
  assert.equal((await bad.send(await bad.login())).status, 502);
  assert.equal((await bad.rows()).at(-1).code, 'action_unconfirmed');
});
