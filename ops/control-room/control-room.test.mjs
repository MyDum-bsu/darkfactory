// Тесты Control Room (V2-3): origin-guard (DNS-rebinding/CSRF),
// sanitizeTerminalText, net-health, aggregator (405/read-only, snapshot
// колонки, Шива-счётчик, Branch Drift индикатор, ring-limit, SSE),
// df-herd --once smoke.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
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
  createBranchDriftProvider, createModelsProvider, createTelemetryProvider,
  buildFleetTelemetry, normalizeFleetHost, RING_LIMIT } from './aggregator.mjs';
import { createFinopsProvider } from './finops.mjs';

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

test('sanitizeTerminalText: режет bidi-спуфинг, сохраняет текст', () => {
  const out = sanitizeTerminalText('a\u202Eb\u202Ac\u2066d\u200Ee\u061Cf\u200F');
  assert.equal(out, 'abcdef');
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

test('aggregator V2-8: activeTrees hierarchy, boardExplorer groups and repoSlots warning', async () => {
  const fixedNow = Date.parse('2026-01-01T01:00:00.000Z');
  const telemetryProvider = async () => ({ attempts: [{
    task_id: 'T9', attempt_id: 'att-9', epoch: 1, outcome: 'done', repo_id: 'repo-gamma',
    channel: 'darkfactory', title: 'Telemetry done',
    started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:30:00.000Z',
    phases_ms: { spawn: 1000, worker: 600000, l1_local: 60000, tamper: 30000,
      l3_visual: null, l2_critic: 120000, arbiter: null, total: 1800000 },
    rounds: { total: 2, rework: 1, pass: 1, arbitration: 1, open: 0,
      gates: { l1: 1, tamper: 1, l2: 1, arbiter: 1 } },
    models: { worker: { provider: 'acp-devin', model: 'swe-2-high' },
      critic: { provider: 'google', model: 'gemini-review' },
      arbiter: { provider: 'openai', model: 'sol-arbiter' } },
    tokens: { worker: { input: 1000, output: 200, cached: 300 }, critic: null, arbiter: null },
    costs: { worker: 1.2, critic: 0.3 },
  }] });
  const tasks = [
    { task_id: 'T1', state: 'claimed', title: 'Active tree', channel: 'darkfactory',
      labels: { repo_id: 'repo-alpha', priority: 'P1' }, priority: 'P1',
      updatedAt: '2026-01-01T00:59:00.000Z' },
    { task_id: 'T2', state: 'claimed', title: 'Second writer', channel: 'darkfactory',
      labels: { repo_id: 'repo-alpha', priority: 'P2' } },
    { task_id: 'T3', state: 'ready', title: 'Idea', channel: 'ideas',
      labels: { repo_id: 'repo-beta', priority: 'P3' }, receiptSha: 'a'.repeat(40) },
    { task_id: 'T4', state: 'waiting', title: 'Waiting', channel: 'darkfactory/friction',
      labels: { repo_id: 'repo-beta' } },
    { task_id: 'T5', state: 'blocked', title: 'Blocked', channel: 'ideas',
      labels: { repo_id: 'repo-beta' } },
    { task_id: 'T6', state: 'completed', title: 'Done', channel: 'optimization/core',
      labels: { repo_id: 'repo-gamma' }, receiptSha: 'b'.repeat(40) },
    { task_id: 'T9', state: 'completed', title: 'Telemetry done', channel: 'darkfactory',
      labels: { repo_id: 'repo-gamma' } },
  ];
  const server = createControlRoomAggregator({ port: 0, now: () => fixedNow,
    boardTasksProvider: async () => tasks, telemetryProvider });
  server.ingest({ kind: 'phase', phase: 'working', task_id: 'T1', attempt_id: 'att-1', epoch: 1,
    ts: '2026-01-01T00:00:00.000Z', channel: 'darkfactory', model: 'acp-devin/swe-2-high', tokens: 1234,
    detail: { threadId: 'thr-worker', branch: 'feat/t1', contextPct: 47, cacheStatus: 'hit' } });
  server.ingest({ kind: 'stage.started', phase: 'stages', task_id: 'T1', attempt_id: 'att-1', epoch: 1,
    ts: '2026-01-01T00:05:00.000Z', detail: { stage: 'l1_local' } });
  server.ingest({ kind: 'stage.completed', phase: 'stages', task_id: 'T1', attempt_id: 'att-1', epoch: 1,
    ts: '2026-01-01T00:10:00.000Z', detail: { stage: 'l1_local', verdict: 'PASS' } });
  server.ingest({ kind: 'stage.completed', phase: 'stages', task_id: 'T1', attempt_id: 'att-1', epoch: 1,
    ts: '2026-01-01T00:12:00.000Z', detail: { stage: 'tamper', verdict: 'PASS' } });
  server.ingest({ kind: 'stage.completed', phase: 'stages', task_id: 'T1', attempt_id: 'att-1', epoch: 1,
    ts: '2026-01-01T00:13:00.000Z', detail: { stage: 'scope_fence', verdict: 'PASS' } });
  server.ingest({ kind: 'stage.started', phase: 'stages', task_id: 'T1', attempt_id: 'att-1', epoch: 1,
    ts: '2026-01-01T00:15:00.000Z', model: 'google/gemini-review', detail: { stage: 'l2_critic' } });

  const snap = await server.snapshot();
  const tree = snap.activeTrees.find(item => item.taskId === 'T1');
  assert.ok(tree, 'T1 tree exists');
  assert.equal(tree.title, 'Active tree');
  assert.equal(tree.channel, 'darkfactory');
  assert.equal(tree.repoId, 'repo-alpha');
  assert.equal(tree.status, 'running');
  assert.equal(tree.elapsedMs, 3600000);
  assert.equal(tree.worker.threadId, 'thr-worker');
  assert.equal(tree.worker.provider, 'acp-devin');
  assert.equal(tree.worker.model, 'swe-2-high');
  assert.equal(tree.worker.branch, 'feat/t1');
  assert.equal(tree.worker.contextPct, 47);
  assert.equal(tree.worker.cacheStatus, 'hit');
  assert.equal(tree.worker.tokens, 1234);
  assert.deepEqual(tree.stages.map(stage => stage.kind),
    ['l1_local', 'tamper', 'scope_fence', 'l2_critic', 'arbiter']);
  assert.equal(tree.stages[0].status, 'pass');
  assert.equal(tree.stages[0].elapsedMs, 300000);
  assert.equal(tree.stages[1].status, 'pass');
  assert.equal(tree.stages[2].status, 'pass');
  assert.equal(tree.stages[3].status, 'running');
  assert.equal(tree.stages[3].model, 'gemini-review');
  assert.equal(tree.stages[4].status, 'pending');

  const telemetryTree = snap.activeTrees.find(item => item.taskId === 'T9');
  assert.ok(telemetryTree, 'telemetry tree exists');
  assert.equal(telemetryTree.status, 'done');
  assert.equal(telemetryTree.rounds, 2);
  assert.equal(telemetryTree.reworkRounds, 1);
  assert.equal(telemetryTree.estCostUsd, 1.5);
  assert.equal(telemetryTree.burnRatePerHr, 3);
  assert.equal(telemetryTree.worker.model, 'swe-2-high');
  assert.deepEqual(telemetryTree.worker.tokens, { input: 1000, output: 200, cached: 300 });
  assert.equal(telemetryTree.stages.find(stage => stage.kind === 'l2_critic').elapsedMs, 120000);
  assert.equal(telemetryTree.stages.find(stage => stage.kind === 'arbiter').status, 'skipped');

  assert.equal(snap.repoSlots.defaultMaxPerRepo, 1);
  assert.equal(snap.repoSlots.activeByRepo['repo-alpha'], 2);
  assert.equal(snap.repoSlots.multiWriterWarnings.length, 1);
  assert.ok(snap.repoSlots.multiWriterWarnings[0].includes('repo-alpha'));

  const df = snap.boardExplorer.channels.find(channel => channel.name === 'darkfactory');
  const ideas = snap.boardExplorer.channels.find(channel => channel.name === 'ideas');
  const friction = snap.boardExplorer.channels.find(channel => channel.name === 'darkfactory/friction');
  const optimization = snap.boardExplorer.channels.find(channel => channel.name === 'optimization/core');
  assert.ok(df && ideas && friction && optimization);
  assert.deepEqual(df.counts, { ready: 0, claimed: 2, waiting: 0, blocked: 0, completed: 1 });
  assert.deepEqual(ideas.counts, { ready: 1, claimed: 0, waiting: 0, blocked: 1, completed: 0 });
  assert.equal(friction.counts.waiting, 1);
  assert.equal(optimization.counts.completed, 1);
  const readyIdea = ideas.tasks.find(task => task.id === 'T3');
  assert.equal(readyIdea.priority, 'P3');
  assert.equal(readyIdea.repoId, 'repo-beta');
  assert.equal(readyIdea.receiptSha, 'a'.repeat(40));
  assert.equal(df.tasks.find(task => task.id === 'T1').updatedAt, '2026-01-01T00:59:00.000Z');
});

test('aggregator V2-8: additive snapshot preserves existing keys', async () => {
  const server = createControlRoomAggregator({ port: 0 });
  const snap = await server.snapshot();
  for (const key of ['ts', 'reconcile', 'running', 'queued', 'needsOwner', 'recentlyCompleted',
    'boardStatus', 'health', 'sessions', 'shiva', 'branchDrift', 'netHealth', 'telemetry',
    'models', 'finops', 'eventsTail', 'attemptsTracked']) {
    assert.ok(Object.hasOwn(snap, key), key);
  }
  for (const key of ['activeTrees', 'boardExplorer', 'repoSlots']) {
    assert.ok(Object.hasOwn(snap, key), key);
  }
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

test('aggregator telemetry: populates compact live summary from JSONL records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-telemetry-'));
  try {
    const run = (task, outcome, rework, total, pass) => JSON.stringify({
      schema: 1, kind: 'attempt_summary', task_id: task, attempt_id: `att-${task}`,
      outcome, open: false,
      started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:10.000Z',
      phases_ms: { spawn: 1, worker: 2, l1_local: 1, tamper: 0, l3_visual: null,
        l2_critic: 1, arbiter: null, total },
      rounds: { total: rework + 1, rework, pass, arbitration: 0, open: 0, gates: {} },
      models: { worker: { provider: 'acp-devin', model: 'swe-2-high' } },
      labels: { domain: 'backend', size: 'S' },
    });
    const original = [
      run('T1', 'done', 0, 1000, 1),
      run('T2', 'done', 2, 3000, 1),
      '{"corrupt"',
    ].join('\n') + '\n';
    await writeFile(join(dir, 'telemetry.jsonl'), original, { mode: 0o600 });
    await writeFile(join(dir, 'notes.txt'), '{"ignored":true}\n');

    await withServer({ telemetryDir: dir }, async (server, base) => {
      const snap = JSON.parse((await httpGet(`${base}/api/snapshot`)).body);
      assert.equal(snap.telemetry.runs, 2);
      assert.equal(snap.telemetry.firstRoundPassRate, 0.5);
      assert.equal(snap.telemetry.avgReworkRounds, 1);
      assert.equal(snap.telemetry.medianWallClockMs, 2000);
      assert.ok(snap.telemetry.updatedAt);
      const cells = Object.values(snap.telemetry.models);
      assert.equal(cells.length, 1);
      assert.equal(cells[0].model.model, 'swe-2-high');
      assert.equal(cells[0].observations, 2);
    });

    assert.equal(await readFile(join(dir, 'telemetry.jsonl'), 'utf8'), original);
    assert.deepEqual((await readdir(dir)).sort(), ['notes.txt', 'telemetry.jsonl']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregator telemetry: real provider attempts survive activeTrees compaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-telemetry-active-'));
  try {
    const record = {
      schema: 1,
      kind: 'attempt_summary',
      task_id: 'T-DOUBLE-COMPACT',
      attempt_id: 'att-double-compact',
      epoch: 1,
      outcome: 'done',
      open: false,
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T00:30:00.000Z',
      phases_ms: {
        worker: 600000,
        l1_local: 60000,
        tamper: 30000,
        l2_critic: 120000,
        arbiter: null,
        total: 1800000,
      },
      rounds: {
        total: 1,
        rework: 0,
        pass: 1,
        arbitration: 0,
        open: 0,
        gates: { l1: 1, tamper: 1, l2: 1 },
      },
      models: {
        worker: { provider: 'acp-devin', model: 'swe-2-high' },
        critic: { provider: 'google', model: 'gemini-review' },
        arbiter: null,
      },
      tokens: {
        worker: { input: 1000, output: 200, cached: 300 },
        critic: { input: 500, output: 100, cached: 50 },
        arbiter: null,
      },
    };
    await writeFile(join(dir, 'telemetry.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });

    const telemetryProvider = createTelemetryProvider({ telemetryDir: dir });
    const telemetry = await telemetryProvider();
    assert.ok(telemetry, 'real telemetry provider loads the JSONL record');
    assert.equal(telemetry.attempts.length, 1);
    assert.equal(telemetry.attempts[0].phasesMs.worker, 600000);

    const server = createControlRoomAggregator({ port: 0,
      telemetryProvider,
      modelsProvider: null,
      finopsProvider: null });
    const snap = await server.snapshot();
    const tree = snap.activeTrees[0];
    assert.ok(tree, 'telemetry-only active tree exists');
    assert.equal(tree.taskId, 'T-DOUBLE-COMPACT');
    assert.equal(tree.elapsedMs, 1800000);
    assert.equal(tree.worker.elapsedMs, 600000);
    const stage = kind => tree.stages.find(item => item.kind === kind);
    assert.equal(stage('l1_local').status, 'pass');
    assert.equal(stage('l1_local').elapsedMs, 60000);
    assert.equal(stage('tamper').status, 'pass');
    assert.equal(stage('tamper').elapsedMs, 30000);
    assert.equal(stage('l2_critic').status, 'pass');
    assert.equal(stage('l2_critic').elapsedMs, 120000);
    assert.equal(stage('arbiter').status, 'skipped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregator telemetry: empty, missing, and corrupt-only directories degrade to null', async () => {
  const missing = join(tmpdir(), 'cr-telemetry-missing-definitely');
  assert.equal(await createTelemetryProvider({ telemetryDir: missing })(), null);

  const dir = await mkdtemp(join(tmpdir(), 'cr-telemetry-empty-'));
  try {
    assert.equal(await createTelemetryProvider({ telemetryDir: dir })(), null);
    await writeFile(join(dir, 'telemetry.jsonl'), 'not json\n{"wrong":true}\n');
    assert.equal(await createTelemetryProvider({ telemetryDir: dir })(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregator telemetry: DF_TELEMETRY_DIR selects the default read-only source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-telemetry-env-'));
  const previous = process.env.DF_TELEMETRY_DIR;
  try {
    await writeFile(join(dir, 'telemetry.jsonl'), JSON.stringify({
      schema: 1, kind: 'attempt_summary', task_id: 'ENV', attempt_id: 'env-1',
      outcome: 'done', open: false,
      phases_ms: { total: 10 }, rounds: { total: 1, rework: 0, pass: 1, arbitration: 0, open: 0, gates: {} },
      models: { worker: { provider: 'acp-devin', model: 'swe-2-high' } },
    }) + '\n');
    process.env.DF_TELEMETRY_DIR = dir;
    const telemetry = await createTelemetryProvider()();
    assert.equal(telemetry.runs, 1);
    assert.equal(telemetry.firstRoundPassRate, 1);
  } finally {
    if (previous === undefined) delete process.env.DF_TELEMETRY_DIR;
    else process.env.DF_TELEMETRY_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregator telemetry: file reads are bounded without crashing on large corrupt input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-telemetry-large-'));
  try {
    await writeFile(join(dir, 'telemetry.jsonl'), `${'x'.repeat(20000)}\n`);
    const provider = createTelemetryProvider({ telemetryDir: dir, maxBytes: 128 });
    assert.equal(await provider(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('createBoardObserver: Board 0.54.0 /api/board/tasks формат → колонки', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        tasks: [
          { message: { id: '1672', channel: 'darkfactory', text: 'Задача раз',
            labels: { 'board.task': 'claimed' },
            task: { state: 'claimed', epoch: 2 } }, replies: 1, last: null },
          { message: { id: '1673', channel: 'darkfactory', text: 'Очередь',
            labels: { 'board.task': 'ready' }, task: { state: 'ready' } } },
          { message: { id: '1674', channel: 'darkfactory', text: 'Вопрос',
            labels: { 'board.task': 'blocked' },
            task: { state: 'blocked',
              blocked: { question: 'Ок?', question_id: 'Q1' } } } },
          { message: { id: '1675', channel: 'darkfactory', text: 'Готово',
            labels: { 'board.task': 'completed' },
            task: { state: 'completed' } } },
        ],
      }),
    };
  };
  const observer = createBoardObserver({ boardUrl: 'http://127.0.0.1:44100',
    channels: ['darkfactory'], fetchImpl });
  // База без /api/board нормализуется до /api/board; других путей нет.
  const result = await observer.fetchTasks();
  assert.equal(result.ok, true);
  assert.deepEqual(urls,
    ['http://127.0.0.1:44100/api/board/tasks?channel=darkfactory&limit=500']);
  assert.equal(result.tasks.length, 4);
  assert.equal(result.tasks[0].task_id, '1672');
  assert.equal(result.tasks[0].state, 'claimed');
  assert.equal(result.tasks[0].epoch, 2);
  await withServer({ boardTasksProvider: observer.fetchTasks }, async (server, base) => {
    const snap = JSON.parse((await httpGet(`${base}/api/snapshot`)).body);
    assert.equal(snap.boardStatus.ok, true);
    assert.equal(snap.running.length, 1);
    assert.equal(snap.queued.length, 1);
    assert.equal(snap.needsOwner.length, 1);
    assert.equal(snap.needsOwner[0].cli.includes('Q1'), true);
    assert.equal(snap.recentlyCompleted.length, 1);
  });
});

test('createBoardObserver: дедупликация по message.id между каналами', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
    tasks: [{ message: { id: '900', channel: 'darkfactory', text: 'x',
      task: { state: 'ready' } } }] }) });
  const observer = createBoardObserver({ boardUrl: 'http://b',
    channels: ['darkfactory', 'intake'], fetchImpl });
  const result = await observer.fetchTasks();
  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 1);
});

test('createBoardObserver: явный /api/board в boardUrl не дублируется', async () => {
  const seen = [];
  const fetchImpl = async url => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => ({ tasks: [] }) };
  };
  const observer = createBoardObserver({
    boardUrl: 'http://127.0.0.1:44100/api/board/', channels: ['c1', 'c2'],
    fetchImpl });
  const result = await observer.fetchTasks();
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [
    'http://127.0.0.1:44100/api/board/tasks?channel=c1&limit=500',
    'http://127.0.0.1:44100/api/board/tasks?channel=c2&limit=500']);
});

test('createBoardObserver: {"version":"0.54.0","sync":[]} — не сбой, пусто', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ version: '0.54.0', url: 'x', sync: [] }) });
  const observer = createBoardObserver({ boardUrl: 'http://board',
    channels: ['darkfactory'], fetchImpl });
  const result = await observer.fetchTasks();
  assert.deepEqual(result.tasks, []);
  assert.equal(result.ok, true);
});

test('createBoardObserver: 401/404/не-JSON/fetch-сбой — явный boardStatus', async () => {
  const cases = [
    [{ ok: false, status: 401,
      headers: new Headers({ 'content-type': 'application/json' }) },
    'board_unauthorized', 401],
    [{ ok: false, status: 404,
      headers: new Headers({ 'content-type': 'text/plain' }) },
    'board_not_found', 404],
    [{ ok: true, status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      json: async () => { throw new SyntaxError('Unexpected token <'); } },
    'board_not_json', 200],
    [() => { throw new Error('ECONNREFUSED 127.0.0.1:44100'); },
      'board_fetch_failed', null],
  ];
  for (const [response, code, status] of cases) {
    const fetchImpl = typeof response === 'function' ? response : async () => response;
    const observer = createBoardObserver({ boardUrl: 'http://127.0.0.1:44100',
      channels: ['darkfactory'], fetchImpl });
    const result = await observer.fetchTasks();
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code);
    assert.equal(result.status, status);
    assert.equal(result.tasks.length, 0);
    assert.ok(result.error && result.error.length > 0, `${code}: error обязателен`);
    // Read-only сервер жив: 200 на снапшот, сбой виден флагом.
    await withServer({ boardTasksProvider: observer.fetchTasks },
      async (server, base) => {
        const res = await httpGet(`${base}/api/snapshot`);
        assert.equal(res.status, 200);
        const snap = JSON.parse(res.body);
        assert.equal(snap.boardStatus.ok, false);
        assert.equal(snap.boardStatus.code, code);
        assert.equal(snap.health.board.ok, false);
        assert.equal(typeof snap.boardStatus.error, 'string');
        assert.equal(snap.running.length, 0);
        assert.equal(snap.queued.length, 0);
      });
  }
});

test('createBoardObserver: нет задачи — не оправдание тихого []', async () => {
  // Промах провайдера (не объект) тоже виден в снапшоте.
  await withServer({ boardTasksProvider: async () => null },
    async (server, base) => {
      const snap = JSON.parse((await httpGet(`${base}/api/snapshot`)).body);
      assert.equal(snap.boardStatus.ok, false);
      assert.equal(snap.boardStatus.code, 'board_bad_provider');
    });
});

test('createBoardObserver: GET only + observer headers', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, method: opts.method, headers: opts.headers });
    return { ok: true, status: 200, json: async () => ({ tasks: [] }) };
  };
  await createBoardObserver({ boardUrl: 'http://b', token: 'TOK',
    channels: ['darkfactory'], fetchImpl })();
  assert.equal(seen.length, 1);
  for (const r of seen) {
    assert.equal(r.method, 'GET');
    assert.ok(r.url.startsWith('http://b/api/board/tasks?'));
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


// --- DF-V2-MODEL-REG: read-only model registry exposure -------------------------

test('aggregator: snapshot включает read-only models snapshot из явных YAML', async () => {
  const catalogPath = join(MODULE_DIR, '..', 'local', 'models-catalog.example.yaml');
  const policyPath = join(MODULE_DIR, '..', 'local', 'routing-policy.example.yaml');
  await withServer({ modelsProvider: createModelsProvider({ catalogPath, policyPath }) },
    async (server, base) => {
      const res = await httpGet(`${base}/api/snapshot`);
      assert.equal(res.status, 200);
      const snap = JSON.parse(res.body);
      assert.equal(snap.models.ok, true);
      assert.equal(snap.models.models.length, 9);
      assert.equal(snap.models.mode, 'balanced');
      assert.equal(snap.models.triad.coder.family, 'cognition');
      assert.equal(snap.models.triad.reviewer.family, 'google');
      assert.notEqual(snap.models.triad.coder.family, snap.models.triad.reviewer.family);
    });
});

test('aggregator: повреждённый models config fail-open, сервер и read-only API живы', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-models-'));
  try {
    const catalogPath = join(dir, 'models-catalog.yaml');
    const policyPath = join(dir, 'routing-policy.yaml');
    await writeFile(catalogPath, 'models: [broken\n');
    await writeFile(policyPath, 'version: 1\n');
    await withServer({ modelsProvider: createModelsProvider({ catalogPath, policyPath }) },
      async (server, base) => {
        const res = await httpGet(`${base}/api/snapshot`);
        assert.equal(res.status, 200);
        const snap = JSON.parse(res.body);
        assert.equal(snap.models.ok, false);
        assert.match(snap.models.error, /model_registry_yaml_invalid/);
        const post = await httpRequest(`${base}/api/snapshot`, {}, 'POST');
        assert.equal(post.status, 405);
      });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


// --- DF-V2-COCKPIT: finops + terminal tabs -------------------------------------

test('aggregator: snapshot включает read-only finops snapshot', async () => {
  const budgetPath = join(MODULE_DIR, '..', 'local', 'resources-budget.example.yaml');
  await withServer({ finopsProvider: createFinopsProvider({ budgetPath,
      now: new Date('2026-11-24T12:00:00Z') }) },
    async (server, base) => {
      const res = await httpGet(`${base}/api/snapshot`);
      assert.equal(res.status, 200);
      const snap = JSON.parse(res.body);
      assert.equal(snap.finops.ok, true);
      assert.equal(snap.finops.computeQuotas.some(q => q.id === 'colab_pro_plus'), true);
      assert.equal(snap.finops.workspaceLinks.length >= 5, true);
      assert.equal(JSON.stringify(snap.finops).includes('javascript:'), false);
      const post = await httpRequest(`${base}/api/snapshot`, {}, 'POST');
      assert.equal(post.status, 405);
    });
});

test('df-herd --once рендерит все 4 вкладки и санитизирует ANSI/OSC/bidi', async () => {
  const evil = 'evil\x1b[2J\x1b]52;c;aGVsbG8=\x07\u202e';
  const modelsProvider = async () => ({ ok: true, mode: 'balanced',
    triad: {
      coder: { id: `coder-${evil}`, family: 'cognition', alternatives: [] },
      reviewer: { id: 'reviewer', family: 'google', alternatives: [] },
      arbiter: { id: 'arbiter', family: 'deepseek', alternatives: [] },
      lead: { id: 'lead', family: 'cognition', alternatives: [] },
      ux_critic: { id: 'ux', family: 'google', alternatives: [] } },
    models: [{ id: `model-${evil}`, provider: 'acp', model: 'm', family: 'cognition',
      status: 'promo_free', effectiveStatus: 'promo_free', until: '2026-12-08' }] });
  const finopsProvider = async () => ({ ok: true,
    cloudCredits: [{ id: `credit-${evil}`, totalEur: 10, remainingEur: 9 }],
    computeVms: [{ id: `vm-${evil}`, machineType: 'spot', state: 'stopped',
      costTodayEur: 0, costMonthEur: 0, runningMinutesMonth: 0 }],
    computeQuotas: [{ id: 'colab_pro_plus', totalUnits: 1006.02, usedUnits: 0,
      utilizationPct: 0, status: 'underutilized', unit: 'CU' }],
    aiSubscriptions: [{ id: `sub-${evil}`, model: 'm', status: 'active' }],
    workspaceLinks: [{ id: `link-${evil}`, group: 'control_room', title: `Control ${evil}`,
      url: 'http://127.0.0.1:44110/', command: `df-herd-${evil}` }],
    totals: { spentMonthCostEur: 0, spentTodayCostEur: 0, monthlyBudgetEur: 1,
      remainingCreditsEur: 9, runningHoursMonth: 0 },
    estimatedMonthCostEur: 0,
    creditRunway: { days: 99, remainingCreditsEur: 9, dailyBurnEur: 0.01 },
    alerts: [{ severity: 'warn', code: `alert-${evil}`, message: `message-${evil}` }] });
  const server = createControlRoomAggregator({ port: 0,
    boardTasksProvider: async () => [{ task_id: 'T1', state: 'claimed', title: `title-${evil}` }],
    modelsProvider, finopsProvider });
  await server.start();
  try {
    for (const [tab, marker] of [['ops', 'RUNNING NOW'], ['models', 'MODEL REGISTRY'],
      ['finops', 'Compute quotas'], ['workspace', 'WORKSPACE MAP']]) {
      const { stdout } = await execFileAsync('node', [
        join(MODULE_DIR, 'df-herd.mjs'), '--once', '--tab', tab,
        '--url', `http://127.0.0.1:${server.port}`], { timeout: 15_000 });
      assert.ok(stdout.includes(marker), `${tab}: missing ${marker}`);
      assert.equal(stdout.includes('\x1b]52'), false, `${tab}: OSC 52`);
      assert.equal(stdout.includes('\x1b[2J'), false, `${tab}: clear-screen injection`);
      assert.equal(stdout.includes('\u202e'), false, `${tab}: bidi override`);
    }
  } finally {
    await server.stop();
  }
});

test('df-herd: https: схема принимается парсером и не отклоняется как unsupported', async () => {
  const src = await readFile(join(MODULE_DIR, 'df-herd.mjs'), 'utf8');
  assert.equal(src.includes("from 'node:https'"), true);
  assert.equal(src.includes("parsed.protocol === 'https:'"), true);
  const { stderr } = await execFileAsync('node', [
    join(MODULE_DIR, 'df-herd.mjs'), '--once', '--url', 'https://127.0.0.1:1'],
    { timeout: 15_000 }).catch(error => ({ stderr: error.stderr ?? String(error) }));
  assert.equal(stderr.includes('unsupported URL scheme'), false);
});

test('web app: 4 вкладки, safe URL validation и mobile CSS присутствуют', async () => {
  const app = await readFile(join(MODULE_DIR, 'web', 'app.js'), 'utf8');
  const html = await readFile(join(MODULE_DIR, 'web', 'index.html'), 'utf8');
  const css = await readFile(join(MODULE_DIR, 'web', 'styles.css'), 'utf8');
  for (const label of ['Operations', 'Models &amp; Routing', 'Resources &amp; FinOps', 'Workspace Map']) {
    assert.ok(html.includes(label), label);
  }
  assert.equal(app.includes('new URL(value)'), true);
  assert.equal(app.includes("url.protocol === 'https:' || url.protocol === 'http:'"), true);
  assert.equal(app.includes('javascript:'), false);
  assert.equal(css.includes('@media (max-width: 720px)'), true);
  assert.equal(app.includes('navigator.clipboard?.writeText'), true);
  assert.equal(app.includes('fallbackCopyText'), true);
  assert.equal(app.includes('copyCommandChip'), true);
});

test('web app V2-8: Board Explorer tab и app.js syntax check', async () => {
  const app = await readFile(join(MODULE_DIR, 'web', 'app.js'), 'utf8');
  const html = await readFile(join(MODULE_DIR, 'web', 'index.html'), 'utf8');
  assert.ok(html.includes('Board'));
  assert.equal(html.includes('data-tab="board"'), true);
  assert.equal(html.includes('id="board-explorer"'), true);
  assert.equal(app.includes('renderBoardExplorer'), true);
  assert.equal(app.includes('renderAgentTrees'), true);
  assert.equal(app.includes('textContent'), true);
  await execFileAsync(process.execPath, ['--check', join(MODULE_DIR, 'web', 'app.js')]);
});


test('df-herd: width contract 80/120 на всех вкладках, ANSI закрыт', async () => {
  const catalogPath = join(MODULE_DIR, '..', 'local', 'models-catalog.example.yaml');
  const policyPath = join(MODULE_DIR, '..', 'local', 'routing-policy.example.yaml');
  const budgetPath = join(MODULE_DIR, '..', 'local', 'resources-budget.example.yaml');
  const stripSgr = text => text.replace(/\x1b\[[0-9;]*m/g, '');
  const unclosedSgr = line => {
    let open = 0;
    for (const match of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
      if (match[1] === '0') open = Math.max(0, open - 1);
      else open++;
    }
    return open;
  };
  await withServer({
    boardTasksProvider: async () => [
      { task_id: 'WIDTH-RUN', state: 'claimed', title: `running-${'x'.repeat(160)}` },
      { task_id: 'WIDTH-QUEUE', state: 'ready', title: `queued-${'y'.repeat(160)}` },
      { task_id: 'WIDTH-OWNER', state: 'blocked', title: `owner-${'z'.repeat(160)}` }],
    modelsProvider: createModelsProvider({ catalogPath, policyPath }),
    finopsProvider: createFinopsProvider({ budgetPath,
      now: new Date('2026-11-24T12:00:00Z') }) },
    async (server, base) => {
      for (const width of [80, 120]) {
        for (const tab of ['ops', 'models', 'finops', 'workspace']) {
          const { stdout } = await execFileAsync('node', [
            join(MODULE_DIR, 'df-herd.mjs'), '--once', '--tab', tab,
            '--width', String(width), '--url', base], { timeout: 15_000 });
          const lines = stdout.split('\n');
          for (const line of lines) {
            assert.ok(stripSgr(line).length <= width,
              `${tab}@${width}: visible width ${stripSgr(line).length}: ${stripSgr(line)}`);
            assert.equal(unclosedSgr(line), 0,
              `${tab}@${width}: unclosed SGR in ${JSON.stringify(line)}`);
          }
          if (tab === 'models' && width === 80) {
            const plain = stripSgr(stdout);
            assert.ok(plain.includes('PROMO FREE'));
            assert.ok(plain.includes('ACTIVE'));
          }
          if (tab === 'models' && width === 120) {
            assert.ok(stripSgr(stdout).includes('2026-12-08'));
          }
        }
      }
    });
});

// --- DF-OBS-FLEET: fleet telemetry and cost anomaly monitor ---------------------

test('aggregator fleetTelemetry: reads real host snapshots and emits resource/cost anomalies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-fleet-'));
  try {
    const fleetDir = join(dir, 'fleet');
    await mkdir(fleetDir);
    const fixedNow = Date.parse('2026-01-01T01:00:00.000Z');
    const healthy = {
      host: 'a-healthy', ts: '2026-01-01T00:59:00Z', uptimeSec: 3600,
      cpuCores: 4, load1m: 1.2, memTotalMb: 1024, memUsedMb: 384,
      memPct: 37.5, diskTotalGb: 100, diskUsedGb: 40, diskPct: 40,
    };
    const pressured = {
      host: 'b-pressured', ts: '2026-01-01T00:30:00Z', uptimeSec: 7200,
      cpuCores: 4, load1m: 7, memTotalMb: 1000, memUsedMb: 900,
      memPct: 90, diskTotalGb: 100, diskUsedGb: 92, diskPct: 92,
    };
    await writeFile(join(fleetDir, 'b-pressured.json'), JSON.stringify(pressured));
    await writeFile(join(fleetDir, 'a-healthy.json'), JSON.stringify(healthy));
    await writeFile(join(fleetDir, 'malformed.json'), '{"host":');
    await writeFile(join(fleetDir, 'invalid.json'), JSON.stringify({
      ...healthy, host: 'c-invalid', memPct: '90' }));

    const telemetryAttempt = (id, total, rework) => ({
      task_id: id, attempt_id: `att-${id}`, epoch: 1, open: true,
      startedAt: '2026-01-01T00:00:00.000Z', elapsedMs: 3_600_000,
      costUsd: 0.8,
      rounds: { total, rework, pass: total - rework, arbitration: 0, open: 0, gates: {} },
    });
    const telemetryProvider = async () => ({
      runs: 3,
      attempts: [
        telemetryAttempt('FLEET-T1', 3, 2),
        telemetryAttempt('FLEET-T2', 3, 2),
        telemetryAttempt('FLEET-T3', 1, 0),
      ],
    });
    const server = createControlRoomAggregator({ port: 0, stateDir: dir,
      now: () => fixedNow, telemetryProvider,
      modelsProvider: null, finopsProvider: null });
    const snap = await server.snapshot();
    const fleet = snap.fleetTelemetry;

    assert.deepEqual(fleet.hosts.map(host => host.host), ['a-healthy', 'b-pressured']);
    assert.equal(fleet.hosts[0].ageSec, 60);
    assert.equal(fleet.hosts[0].stale, false);
    assert.deepEqual(fleet.hosts[0].alerts, []);
    assert.equal(fleet.hosts[1].ageSec, 1800);
    assert.equal(fleet.hosts[1].stale, true);
    assert.equal(fleet.hosts[1].alerts.length, 4);
    assert.ok(fleet.hosts[1].alerts.some(alert => alert.includes('memory usage')));
    assert.ok(fleet.hosts[1].alerts.some(alert => alert.includes('disk usage')));
    assert.ok(fleet.hosts[1].alerts.some(alert => alert.includes('load1m')));
    assert.ok(fleet.hosts[1].alerts.some(alert => alert.includes('stale')));
    assert.equal(fleet.hosts.some(host => host.host === 'c-invalid'), false);

    const kinds = fleet.anomalies.map(anomaly => anomaly.kind).sort();
    assert.deepEqual(kinds, ['burn_rate_high', 'disk_pressure', 'high_rework_rate',
      'host_stale', 'load_pressure', 'memory_pressure'].sort());
    const memory = fleet.anomalies.find(anomaly => anomaly.kind === 'memory_pressure');
    assert.equal(memory.host, 'b-pressured');
    assert.equal(memory.metric, 90);
    assert.equal(memory.threshold, 85);
    const disk = fleet.anomalies.find(anomaly => anomaly.kind === 'disk_pressure');
    assert.equal(disk.metric, 92);
    assert.equal(disk.threshold, 85);
    const stale = fleet.anomalies.find(anomaly => anomaly.kind === 'host_stale');
    assert.equal(stale.metric, 1800);
    assert.equal(stale.threshold, 900);
    const burn = fleet.anomalies.find(anomaly => anomaly.kind === 'burn_rate_high');
    assert.equal(burn.host, null);
    assert.equal(burn.metric, 2.4);
    assert.equal(burn.threshold, 2.0);
    const rework = fleet.anomalies.find(anomaly => anomaly.kind === 'high_rework_rate');
    assert.equal(rework.metric, 0.6667);
    assert.equal(rework.threshold, 0.5);

    assert.deepEqual(fleet.summary, {
      hostCount: 2,
      healthyCount: 1,
      alertCount: 6,
      hourlyBurnUsd: 2.4,
      projectedDailyUsd: 57.6,
    });
    assert.deepEqual((await server.snapshot()).fleetTelemetry, fleet,
      'repeated reads are deterministic and read-only');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregator fleetTelemetry: missing fleet directory degrades to empty snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cr-fleet-missing-'));
  try {
    const server = createControlRoomAggregator({ port: 0,
      fleetDir: join(dir, 'missing'), telemetryProvider: async () => null,
      modelsProvider: null, finopsProvider: null });
    const snap = await server.snapshot();
    assert.deepEqual(snap.fleetTelemetry.hosts, []);
    assert.deepEqual(snap.fleetTelemetry.anomalies, []);
    assert.deepEqual(snap.fleetTelemetry.summary, {
      hostCount: 0,
      healthyCount: 0,
      alertCount: 0,
      hourlyBurnUsd: 0,
      projectedDailyUsd: 0,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('normalizeFleetHost: staleness and alert thresholds are boundary-exact', () => {
  const now = Date.parse('2026-01-01T01:00:00.000Z');
  const base = {
    host: 'boundary', ts: '2026-01-01T00:45:00Z', uptimeSec: 1,
    cpuCores: 4, load1m: 5.9, memTotalMb: 100, memUsedMb: 84,
    memPct: 84, diskTotalGb: 100, diskUsedGb: 84, diskPct: 84,
  };
  const exactStalenessBoundary = normalizeFleetHost(base, now);
  assert.equal(exactStalenessBoundary.ageSec, 900);
  assert.equal(exactStalenessBoundary.stale, false);
  assert.deepEqual(exactStalenessBoundary.alerts, []);

  const oneMsStale = normalizeFleetHost({ ...base, ts: '2026-01-01T00:44:59.999Z' }, now);
  assert.equal(oneMsStale.stale, true);
  assert.ok(oneMsStale.alerts.some(alert => alert.includes('stale')));

  const atAlertThresholds = normalizeFleetHost({
    ...base, ts: '2026-01-01T00:59:59Z', load1m: 6,
    memUsedMb: 85, memPct: 85, diskUsedGb: 85, diskPct: 85,
  }, now);
  assert.equal(atAlertThresholds.stale, false);
  assert.equal(atAlertThresholds.alerts.length, 3);
  assert.ok(atAlertThresholds.alerts.some(alert => alert.includes('memory usage')));
  assert.ok(atAlertThresholds.alerts.some(alert => alert.includes('disk usage')));
  assert.ok(atAlertThresholds.alerts.some(alert => alert.includes('load1m')));

  assert.equal(normalizeFleetHost(null, now), null);
  assert.equal(normalizeFleetHost({ ...base, memPct: null }, now), null);
  assert.equal(normalizeFleetHost({ ...base, memPct: 101 }, now), null);
  assert.equal(normalizeFleetHost({ ...base, cpuCores: 0 }, now), null);
  assert.deepEqual(normalizeFleetHost(base, now), normalizeFleetHost(base, now));
});

test('buildFleetTelemetry: cost and rework anomaly thresholds are strict', () => {
  const attempt = (id, rework) => ({ task_id: id,
    rounds: { total: rework + 1, rework, pass: 1, arbitration: 0, open: 0, gates: {} } });
  const exactBoundaries = buildFleetTelemetry({
    hosts: [],
    activeTrees: [{ status: 'running', burnRatePerHr: 2.0 }],
    telemetry: { runs: 4, attempts: [
      attempt('R1', 1), attempt('R2', 1), attempt('R3', 0), attempt('R4', 0)] },
  });
  assert.equal(exactBoundaries.summary.hourlyBurnUsd, 2.0);
  assert.equal(exactBoundaries.anomalies.some(a => a.kind === 'burn_rate_high'), false,
    'burn rate must exceed, not merely equal, 2.0');
  assert.equal(exactBoundaries.anomalies.some(a => a.kind === 'high_rework_rate'), false,
    'rework ratio must exceed, not merely equal, 0.5');

  const insufficientSample = buildFleetTelemetry({
    hosts: [], activeTrees: [],
    telemetry: { runs: 2, attempts: [attempt('R1', 1), attempt('R2', 1)] },
  });
  assert.equal(insufficientSample.anomalies.some(a => a.kind === 'high_rework_rate'), false);

  const overThreshold = buildFleetTelemetry({
    hosts: [], activeTrees: [{ status: 'running', burnRatePerHr: 2.0001 }],
    telemetry: { runs: 3, attempts: [attempt('R1', 1), attempt('R2', 1), attempt('R3', 0)] },
  });
  assert.equal(overThreshold.anomalies.find(a => a.kind === 'burn_rate_high').metric, 2.0001);
  assert.equal(overThreshold.anomalies.find(a => a.kind === 'high_rework_rate').metric, 0.6667);
});
