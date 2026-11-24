// Тесты Control Room (V2-3): origin-guard (DNS-rebinding/CSRF),
// sanitizeTerminalText, net-health, aggregator (405/read-only, snapshot
// колонки, Шива-счётчик, Branch Drift индикатор, ring-limit, SSE),
// df-herd --once smoke.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { isAllowedHost, isAllowedOrigin, sanitizeTerminalText,
  escapeHtml, SECURITY_HEADERS } from './origin-guard.mjs';
import { createNetHealthMonitor } from './net-health.mjs';
import { createControlRoomAggregator, createBoardObserver,
  createBranchDriftProvider, RING_LIMIT } from './aggregator.mjs';

const execFileAsync = promisify(execFile);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const httpGet = url => new Promise((resolve, reject) => {
  const req = get(url, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
});
const httpRequest = (url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = get({ hostname: u.hostname, port: u.port, path: u.pathname,
    headers: { Host: u.host, ...headers }, method }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
});

async function withServer(deps, fn) {
  const server = createControlRoomAggregator({ port: 0, ...deps });
  await server.start();
  try {
    await fn(server, `http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop();
  }
}

// --- origin-guard -------------------------------------------------------------

test('host: допускается loopback, чужие hostname/порт отвергаются', () => {
  assert.equal(isAllowedHost('127.0.0.1:44110', 44110), true);
  assert.equal(isAllowedHost('localhost:44110', 44110), true);
  assert.equal(isAllowedHost('attacker.localhost:44110', 44110), true);
  // DNS-rebinding: чужой хост на наш IP.
  assert.equal(isAllowedHost('evil.example.com:44110', 44110), false);
  assert.equal(isAllowedHost('0.0.0.0:44110', 44110), false);
  assert.equal(isAllowedHost('', 44110), false);
  assert.equal(isAllowedHost(undefined, 44110), false);
  // Другой порт — rebinding на соседний сервис.
  assert.equal(isAllowedHost('127.0.0.1:9999', 44110), false);
});

test('origin: отсутствие допустимо, чужой origin отвергается', () => {
  assert.equal(isAllowedOrigin(undefined, 44110), true);
  assert.equal(isAllowedOrigin('null', 44110), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:44110', 44110), true);
  assert.equal(isAllowedOrigin('https://evil.example.com', 44110), false);
  assert.equal(isAllowedOrigin('file:///tmp/x', 44110), false);
  assert.equal(isAllowedOrigin('javascript:alert(1)', 44110), false);
});

test('sanitizeTerminalText: режет ANSI/OSC/control, сохраняет текст', () => {
  const dirty = 'ok \x1b]52;c;aGVsbG8=\x07 clip \x1b]8;;http://evil\x07link' +
    '\x1b\\ \x1b[2J\x1b[H\x07\x00\x1b[31mred\x1b[0m end';
  const out = sanitizeTerminalText(dirty);
  assert.equal(out.includes('\x1b'), false, JSON.stringify(out));
  assert.equal(out.includes('\x07'), false);
  assert.equal(out.includes('aGVsbG8'), false);
  assert.ok(out.includes('clip'));
  assert.ok(out.includes('red'));
  assert.equal(sanitizeTerminalText(null), '');
  assert.equal(sanitizeTerminalText(42), '');
  assert.equal(sanitizeTerminalText('line\n\ttab'), 'line\n\ttab');
});

test('escapeHtml экранирует XSS-векторы', () => {
  assert.equal(escapeHtml('<script>"x"</script>'),
    '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});

// --- net-health -----------------------------------------------------------------

test('net-health: classify + stale-while-revalidate + cloud/hot metrics', async () => {
  const calls = [];
  const dir = await mkdtemp(join(tmpdir(), 'cr-net-'));
  try {
    const cloud = join(dir, 'cloud.json');
    await writeFile(cloud, JSON.stringify({ status: 'running', updatedAt: Date.now() }));
    const monitor = createNetHealthMonitor({
      probes: [{ name: 'llm', url: 'http://probe' },
        { name: 'blocked', url: 'http://block' }],
      fetchImpl: async url => {
        calls.push(url);
        if (url === 'http://block') return { status: 403 };
        return { status: 200 };
      },
      cloudStatePath: cloud,
      now: () => 1_000_000 });
    const first = await monitor.snapshot();
    assert.equal(first.probes[0].status, 'pending'); // cached_bg
    await new Promise(r => setTimeout(r, 20));
    const second = await monitor.snapshot();
    assert.equal(second.probes.find(p => p.name === 'llm').status, 'ok');
    assert.equal(second.probes.find(p => p.name === 'blocked').status, 'blocked');
    assert.equal(second.cloudWorker.status, 'running');
    assert.ok(second.host.mem.totalBytes > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('net-health: stale cloud journal → status stale', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-net-'));
  try {
    const cloud = join(dir, 'cloud.json');
    await writeFile(cloud, JSON.stringify({ status: 'running', updatedAt: 1 }));
    const monitor = createNetHealthMonitor({ cloudStatePath: cloud, now: () => Date.now() });
    const snap = await monitor.snapshot();
    assert.equal(snap.cloudWorker.status, 'stale');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- aggregator -----------------------------------------------------------------

test('aggregator: GET/HEAD допускаются, мутирующие методы → 405', async () => {
  await withServer({}, async (server, base) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await httpRequest(`${base}/api/snapshot`, {}, method);
      assert.equal(res.status, 405, method);
      assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
    }
    const res = await httpGet(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });
});

test('aggregator: чужой Host → 403 (DNS-rebinding), чужой Origin → 403 (CSRF)', async () => {
  await withServer({}, async (server, base) => {
    const badHost = await httpRequest(`${base}/api/health`,
      { Host: 'evil.example.com:80' });
    assert.equal(badHost.status, 403);
    assert.equal(JSON.parse(badHost.body).error, 'forbidden_host');
    const badOrigin = await httpRequest(`${base}/api/health`,
      { Origin: 'https://evil.example.com' });
    assert.equal(badOrigin.status, 403);
    assert.equal(JSON.parse(badOrigin.body).error, 'forbidden_origin');
    const good = await httpRequest(`${base}/api/health`,
      { Origin: 'http://localhost:' + server.port });
    assert.equal(good.status, 200);
  });
});

test('aggregator: строгие security-заголовки на всех ответах', async () => {
  await withServer({}, async (server, base) => {
    const res = await httpGet(`${base}/api/health`);
    const csp = res.headers['content-security-policy'];
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(!csp.includes('unsafe-eval'));
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });
});

test('aggregator: snapshot колонки по состояниям Board', async () => {
  const tasks = [
    { task_id: 'T1', state: 'claimed', title: 'run' },
    { task_id: 'T2', state: 'ready', title: 'queue' },
    { task_id: 'T3', state: 'blocked', title: 'owner',
      blocked: { question: 'Пушить?', question_id: 'Q9' } },
    { task_id: 'T4', state: 'completed', title: 'done' }];
  await withServer({ boardTasksProvider: async () => tasks },
    async (server, base) => {
      const res = await httpGet(`${base}/api/snapshot`);
      const snap = JSON.parse(res.body);
      assert.equal(snap.running.length, 1);
      assert.equal(snap.queued.length, 1);
      assert.equal(snap.needsOwner.length, 1);
      assert.equal(snap.needsOwner[0].question, 'Пушить?');
      assert.ok(snap.needsOwner[0].cli.includes('Q9'));
      assert.equal(snap.recentlyCompleted.length, 1);
    });
});

test('aggregator: шива-счётчик помечает лида с двумя задачами как dirty', async () => {
  const threads = [
    { id: 't1', status: 'running', lead_session_id: 'L1', task_id: 'A' },
    { id: 't2', status: 'running', lead_session_id: 'L1', task_id: 'B' },
    { id: 't3', status: 'running', lead_session_id: 'L2', task_id: 'C' }];
  await withServer({ bbThreadsProvider: async () => threads },
    async (server, base) => {
      const snap = JSON.parse((await httpGet(`${base}/api/snapshot`)).body);
      assert.equal(snap.shiva.dirty, 1);
      const dirty = snap.shiva.sessions.find(s => !s.clean);
      assert.equal(dirty.lead, 'L1');
      assert.deepEqual(new Set(dirty.taskIds), new Set(['A', 'B']));
    });
});

test('aggregator: branch-drift индикатор в снапшоте', async () => {
  const drift = { driftDetected: true, unmergedBranches: [{ branch: 'bb/thr_x', fileCount: 3, isBbThread: true }], dirtyWorktrees: [], bbThreadWorktrees: [] };
  await withServer({ branchDriftProvider: async () => drift },
    async (server, base) => {
      const snap = JSON.parse((await httpGet(`${base}/api/snapshot`)).body);
      assert.equal(snap.branchDrift.driftDetected, true);
      assert.equal(snap.branchDrift.unmergedBranches[0].branch, 'bb/thr_x');
    });
});

test('aggregator: ошибка провайдера drift → driftDetected null, сервер жив', async () => {
  await withServer({ branchDriftProvider: async () => { throw new Error('boom'); } },
    async (server, base) => {
      const res = await httpGet(`${base}/api/snapshot`);
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).branchDrift.error, true);
    });
});

test('aggregator: ring-buffer ограничен RING_LIMIT', async () => {
  const server = createControlRoomAggregator({ port: 0, ringLimit: 5 });
  for (let i = 0; i < 20; i++) {
    server.ingest({ kind: 'attempt.phase', seq: i + 1, task_id: 'T', phase: 'working' });
  }
  assert.equal(server.ringSize, 5);
  const snap = await server.snapshot();
  assert.equal(snap.eventsTail.length, 5);
});

test('aggregator: пропуск seq помечает reconcile в снапшоте', async () => {
  const server = createControlRoomAggregator({ port: 0 });
  server.ingest({ kind: 'attempt.phase', seq: 1, task_id: 'T' });
  server.ingest({ kind: 'attempt.phase', seq: 7, task_id: 'T' });
  assert.equal((await server.snapshot()).reconcile, true);
  assert.equal((await server.snapshot()).reconcile, false);
});

test('aggregator: хвост events.ndjson подхватывается при старте', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-ev-'));
  try {
    const events = Array.from({ length: 3 }, (_, i) => JSON.stringify({
      kind: 'attempt.phase', seq: i + 1, task_id: 'T', phase: 'working' }));
    await writeFile(join(dir, 'events.ndjson'), events.join('\n') + '\n');
    const server = createControlRoomAggregator({ port: 0, stateDirs: [dir] });
    await server.start();
    try {
      const snap = await server.snapshot();
      assert.equal(snap.eventsTail.length, 3);
    } finally {
      await server.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregator: inspect отдаёт санитизированный plain-text', async () => {
  await withServer({
    inspectProvider: async id => ({ text: `log \x1b[31m${id}\x1b[0m`,
      artifacts: ['receipt.md'] }) },
    async (server, base) => {
      const res = await httpGet(`${base}/api/inspect/T1`);
      const data = JSON.parse(res.body);
      assert.equal(data.text.includes('\x1b'), false);
      assert.deepEqual(data.artifacts, ['receipt.md']);
    });
});

test('aggregator: SSE отдаёт snapshot при подключении и push-события', async () => {
  await withServer({}, async (server, base) => {
    const chunks = [];
    await new Promise((resolve, reject) => {
      const req = get(`${base}/api/events`, res => {
        res.on('data', c => {
          chunks.push(c.toString());
          if (chunks.join('').includes('"type":"snapshot"')) {
            server.ingest({ kind: 'attempt.phase', seq: 1, task_id: 'T',
              phase: 'checking' });
          }
          if (chunks.join('').includes('"type":"event"')) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', () => resolve());
      setTimeout(() => { req.destroy(); reject(new Error('SSE timeout')); }, 5000);
    });
    const text = chunks.join('');
    assert.ok(text.includes('"type":"snapshot"'));
    assert.ok(text.includes('"phase":"checking"'));
  });
});

test('aggregator: отдаёт web UI с CSP', async () => {
  await withServer({}, async (server, base) => {
    const index = await httpGet(`${base}/`);
    assert.equal(index.status, 200);
    assert.ok(index.body.includes('DF Control Room'));
    const js = await httpGet(`${base}/app.js`);
    assert.equal(js.status, 200);
    const css = await httpGet(`${base}/styles.css`);
    assert.equal(css.status, 200);
    const missing = await httpGet(`${base}/nope`);
    assert.equal(missing.status, 404);
  });
});

test('app.js: нет innerHTML для недоверенных данных', async () => {
  const src = await readFile(join(MODULE_DIR, 'web', 'app.js'), 'utf8');
  assert.equal(src.includes('innerHTML'), false);
  assert.equal(src.includes('outerHTML'), false);
  assert.equal(src.includes('insertAdjacentHTML'), false);
});

// --- df-herd ----------------------------------------------------------------------

test('df-herd --once печатает кадр без ANSI-уязвимостей и выходит', async () => {
  const server = createControlRoomAggregator({ port: 0,
    boardTasksProvider: async () => [
      { task_id: 'T1', state: 'claimed', title: 'x\x1b[2Jbad' }] });
  await server.start();
  try {
    const { stdout } = await execFileAsync('node', [
      join(MODULE_DIR, 'df-herd.mjs'), '--once',
      '--url', `http://127.0.0.1:${server.port}`], { timeout: 15_000 });
    assert.ok(stdout.includes('RUNNING NOW'));
    assert.ok(stdout.includes('#T1'));
    // Весь недоверенный текст санитизирован: нет репозиционирования экрана.
    assert.equal(/\x1b\[2J[\s\S]*x\x1b/.test(stdout), false);
    assert.equal(stdout.includes('\x1b]52'), false);
  } finally {
    await server.stop();
  }
});

// --- P1-2: real drift provider ------------------------------------------------

test('createBranchDriftProvider: real git repo with dirty bb/thr_* worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-drift-'));
  const git = (args, cwd = dir) => execFileAsync('git', args, { cwd });
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 't@t']);
    await git(['config', 'user.name', 't']);
    await writeFile(join(dir, 'a.txt'), 'x');
    await git(['add', '-A']);
    await git(['commit', '-m', 'init']);
    const wt = join(dir, 'wt-thread');
    await git(['worktree', 'add', wt, '-b', 'bb/thr_test']);
    await writeFile(join(wt, 'dirty.txt'), 'd');
    const provider = createBranchDriftProvider([dir]);
    const report = await provider();
    assert.equal(report.driftDetected, true);
    assert.equal(report.bbThreadWorktrees.length, 1);
    assert.equal(report.dirtyWorktrees.some(w => w.isBbThread), true);
    // TTL-кэш: повторный вызов — тот же объект.
    assert.equal(await provider(), report);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createBranchDriftProvider: repo error is fail-closed, not silent clean', async () => {
  const provider = createBranchDriftProvider(['/nonexistent/repo/path']);
  const report = await provider();
  assert.equal(report.driftDetected, true);
  assert.equal(report.repos[0].ok, false);
});

// --- P1-3: Board observer ----------------------------------------------------

test('createBoardObserver: Board 0.54.0 channel format → columns', async () => {
  const channelReply = { threads: [
    { message: { id: 'T1', channel: 'darkfactory', text: 'Задача раз',
      labels: { project: 'df' },
      task: { state: 'claimed', epoch: 3 } } },
    { message: { id: 'T2', channel: 'darkfactory', text: 'Очередь',
      task: { state: 'ready' } } },
    { message: { id: 'T3', channel: 'darkfactory', text: 'Вопрос',
      task: { state: 'blocked', blocked: { question: 'Ок?',
        question_id: 'Q1' } } } },
    { message: { id: 'T4', channel: 'darkfactory', text: 'Готово',
      task: { state: 'completed' } } }] };
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.includes('/tasks') ? { tasks: [] } : channelReply });
  const observer = createBoardObserver({ boardUrl: 'http://board',
    channels: ['darkfactory'], fetchImpl });
  const tasks = await observer();
  assert.equal(tasks.length, 4);
  await withServer({ boardTasksProvider: observer }, async (server, base) => {
    const snap = JSON.parse((await httpGet(`${base}/api/snapshot`)).body);
    assert.equal(snap.running.length, 1);
    assert.equal(snap.queued.length, 1);
    assert.equal(snap.needsOwner.length, 1);
    assert.equal(snap.needsOwner[0].cli.includes('Q1'), true);
    assert.equal(snap.recentlyCompleted.length, 1);
  });
});

test('createBoardObserver: {"version":"0.54.0","sync":[]} — не сбой, пусто', async () => {
  const fetchImpl = async () => ({
    ok: true, json: async () => ({ version: '0.54.0', url: 'x', sync: [] }) });
  const observer = createBoardObserver({ boardUrl: 'http://board',
    channels: ['darkfactory'], fetchImpl });
  const tasks = await observer();
  assert.deepEqual(tasks, []);
});

test('createBoardObserver: GET only + observer headers', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, method: opts.method, headers: opts.headers });
    return { ok: true, json: async () => ({ threads: [] }) };
  };
  await createBoardObserver({ boardUrl: 'http://b', token: 'TOK',
    channels: ['darkfactory'], fetchImpl })();
  assert.ok(seen.length >= 1);
  for (const r of seen) {
    assert.equal(r.method, 'GET');
    assert.equal(r.headers.authorization, 'Bearer TOK');
    assert.equal(r.headers['x-board-profile'], 'control-room-observer');
    assert.equal(r.headers['x-board-can'], 'darkfactory=read');
  }
});

// --- P1-4: sanitize artifacts ---------------------------------------------------

test('aggregator: artifacts and taskId sanitized (OSC 52 stripped)', async () => {
  await withServer({
    inspectProvider: async () => ({
      text: 'log \x1b]52;c;Y2xpcA==\x07 end',
      artifacts: ['a\x1b[2Jb.md', '\x1b]8;;http://x\x07l\x1b\\'] }) },
    async (server, base) => {
      const res = await httpGet(`${base}/api/inspect/T%1B[31m1`);
      const data = JSON.parse(res.body);
      assert.equal(data.text.includes('\x1b'), false);
      for (const a of data.artifacts) assert.equal(a.includes('\x1b'), false);
      assert.equal(data.taskId.includes('\x1b'), false);
    });
});

// --- P2: shiva parentThreadId + attempts bound + latest attempt ----------------

test('aggregator: shiva uses parentThreadId (bb thread list --json field)', async () => {
  const threads = [
    { id: 't1', status: 'running', parentThreadId: 'L1', task_id: 'A' },
    { id: 't2', status: 'running', parentThreadId: 'L1', task_id: 'B' }];
  await withServer({ bbThreadsProvider: async () => threads },
    async (server, base) => {
      const snap = JSON.parse((await httpGet(`${base}/api/snapshot`)).body);
      assert.equal(snap.shiva.dirty, 1);
    });
});

test('aggregator: attempts map bounded (FIFO ≤ 500)', async () => {
  const server = createControlRoomAggregator({ port: 0 });
  for (let i = 0; i < 600; i++) {
    server.ingest({ kind: 'attempt.phase', seq: i + 1, task_id: `T${i}`,
      attempt_id: `a${i}`, phase: 'working' });
  }
  const snap = await server.snapshot();
  assert.equal(snap.attemptsTracked, 500);
});

test('aggregator: columns pick the latest attempt per task_id', async () => {
  const server = createControlRoomAggregator({ port: 0,
    boardTasksProvider: async () => [{ task_id: 'T', state: 'claimed', title: 't' }] });
  server.ingest({ kind: 'attempt.phase', seq: 1, task_id: 'T', attempt_id: 'old',
    ts: '2024-01-01T00:00:00Z', phase: 'working', model: 'm1' });
  server.ingest({ kind: 'attempt.phase', seq: 2, task_id: 'T', attempt_id: 'new',
    ts: '2024-01-02T00:00:00Z', phase: 'checking', model: 'm2' });
  const snap = await server.snapshot();
  assert.equal(snap.running[0].phase, 'checking');
  assert.equal(snap.running[0].model, 'm2');
});
