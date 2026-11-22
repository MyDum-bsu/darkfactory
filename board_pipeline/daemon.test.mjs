import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RotatingJournal, runDaemon } from './daemon.mjs';
import { createPilotSwitch } from './pilot-gate.mjs';
import { loadSdk } from './sdk.mjs';

const instant = () => Promise.resolve();
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function privateDir(t, base) {
  const dir = await mkdtemp(join(base ?? tmpdir(), 'df-daemon-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('daemon loop: empty ticks cost nothing and stop on abort', async t => {
  const dir = await privateDir(t);
  const journal = new RotatingJournal({ directory: dir });
  let calls = 0;
  const ac = new AbortController();
  const done = runDaemon({
    intervalMs: 1000, journal, sleep: instant, signal: ac.signal,
    installSignalHandlers: false,
    tick: async () => { calls++; if (calls === 5) ac.abort(); return { phase: 'idle' }; },
  });
  const result = await done;
  assert.equal(result.ticks, 5);
  assert.equal(result.stopped, 'signal');
  const log = await readFile(join(dir, 'daemon.jsonl'), 'utf8');
  const events = log.trim().split('\n').map(line => JSON.parse(line).event);
  assert.equal(events[0], 'daemon_start');
  assert.equal(events.at(-1), 'daemon_stop');
  assert.equal(events.filter(e => e === 'tick').length, 5);
});

test('daemon loop: interval is validated', async () => {
  await assert.rejects(() => runDaemon({ tick: async () => ({}), intervalMs: 10 }),
    /interval must be an integer/);
  await assert.rejects(() => runDaemon({ tick: async () => ({}), intervalMs: 1.5 }),
    /interval must be an integer/);
});

test('daemon loop: startup disk preflight blocks before first tick', async () => {
  let calls = 0;
  await assert.rejects(() => runDaemon({
    intervalMs: 1000, installSignalHandlers: false, sleep: instant,
    checkDisk: async () => { throw new Error('disk budget: 2 GiB free; worktree requires 8 GiB'); },
    tick: async () => { calls++; return { phase: 'idle' }; },
  }), /disk budget/);
  assert.equal(calls, 0);
});

test('daemon loop: disk budget blocks ticks without LLM and recovers', async t => {
  const dir = await privateDir(t);
  const journal = new RotatingJournal({ directory: dir });
  let checks = 0;
  let calls = 0;
  const ac = new AbortController();
  const result = await runDaemon({
    intervalMs: 1000, journal, sleep: instant, signal: ac.signal,
    installSignalHandlers: false,
    // Стартовый preflight проходит; два тика ниже бюджета; дальше место появилось.
    checkDisk: async () => {
      checks++;
      if (checks === 2 || checks === 3) throw new Error('disk budget: low');
    },
    tick: async () => { calls++; if (calls === 2) ac.abort(); return { phase: 'idle' }; },
  });
  assert.equal(calls, 2);
  assert.equal(result.stopped, 'signal');
  const log = await readFile(join(dir, 'daemon.jsonl'), 'utf8');
  assert.match(log, /disk_budget_blocked/);
});

test('daemon loop: kill-switch file stops polling', async t => {
  const dir = await privateDir(t);
  await writeFile(join(dir, 'switch'), 'run\n', { mode: 0o600 });
  const assertOpen = await createPilotSwitch(join(dir, 'switch'));
  let calls = 0;
  const result = await runDaemon({
    intervalMs: 1000, installSignalHandlers: false, sleep: instant, assertOpen,
    tick: async () => {
      calls++;
      if (calls === 3) await writeFile(join(dir, 'switch'), 'stop\n', { mode: 0o600 });
      return { phase: 'idle' };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.stopped, 'kill_switch');
});

test('daemon loop: deleted kill-switch also stops', async t => {
  const dir = await privateDir(t);
  await writeFile(join(dir, 'switch'), 'run\n', { mode: 0o600 });
  const assertOpen = await createPilotSwitch(join(dir, 'switch'));
  const result = await runDaemon({
    intervalMs: 1000, installSignalHandlers: false, sleep: instant, assertOpen,
    tick: async () => {
      await rm(join(dir, 'switch'));
      return { phase: 'idle' };
    },
  });
  assert.equal(result.stopped, 'kill_switch');
});

test('daemon loop: SIGTERM waits for the in-flight tick', async t => {
  const dir = await privateDir(t);
  const journal = new RotatingJournal({ directory: dir });
  let releaseTick;
  let finished = false;
  const run = runDaemon({
    intervalMs: 1000, journal, sleep: instant,
    tick: async () => {
      await new Promise(resolve => { releaseTick = resolve; });
      finished = true;
      return { phase: 'working' };
    },
  });
  while (!releaseTick) await delay(5);
  releaseTick();
  // Сигнал приходит, пока тик ещё завершается; цикл дожидается его и выходит.
  process.emit('SIGTERM');
  const result = await run;
  assert.equal(finished, true);
  assert.equal(result.stopped, 'signal');
  const log = await readFile(join(dir, 'daemon.jsonl'), 'utf8');
  const events = log.trim().split('\n').map(line => JSON.parse(line).event);
  assert.deepEqual(events, ['daemon_start', 'tick', 'daemon_stop']);
});

test('daemon loop: onTick can stop after a terminal phase', async () => {
  let calls = 0;
  const result = await runDaemon({
    intervalMs: 1000, installSignalHandlers: false, sleep: instant,
    tick: async () => { calls++; return { phase: 'done' }; },
    onTick: async r => r.phase === 'done' ? 'stop' : undefined,
  });
  assert.equal(calls, 1);
  assert.equal(result.stopped, 'terminal');
});

test('daemon loop: tick errors are journaled and polling continues', async t => {
  const dir = await privateDir(t);
  const journal = new RotatingJournal({ directory: dir });
  let calls = 0;
  const ac = new AbortController();
  const result = await runDaemon({
    intervalMs: 1000, journal, sleep: instant, signal: ac.signal,
    installSignalHandlers: false,
    tick: async () => {
      calls++;
      if (calls === 1) throw new Error('transport lost');
      if (calls === 3) ac.abort();
      return { phase: 'idle' };
    },
  });
  assert.equal(calls, 3);
  const log = await readFile(join(dir, 'daemon.jsonl'), 'utf8');
  assert.match(log, /tick_error.*transport lost/);
});

test('RotatingJournal: rotates at maxBytes and keeps bounded files', async t => {
  const dir = await privateDir(t);
  const journal = new RotatingJournal({ directory: dir, name: 'j', maxBytes: 1024, keep: 3 });
  for (let i = 0; i < 30; i++) await journal.append({ event: 'tick', ticks: i, pad: 'x'.repeat(80) });
  const names = (await readdir(dir)).sort();
  assert.ok(names.includes('j.jsonl'));
  assert.ok(names.length <= 4, `expected bounded rotation, got ${names.join(',')}`);
  const current = await readFile(join(dir, 'j.jsonl'), 'utf8');
  const first = JSON.parse(current.trim().split('\n')[0]);
  assert.ok(first.ticks > 0, 'current file holds recent events');
});

test('RotatingJournal: limits are validated', async t => {
  const dir = await privateDir(t);
  assert.throws(() => new RotatingJournal({ directory: dir, maxBytes: 10 }), /invalid journal limits/);
  assert.throws(() => new RotatingJournal({}), /journal directory is required/);
});

test('daemon loop: real statfs disk preflight lets ticks run', async t => {
  // Фикстура на той же ФС, что и рабочие worktree: бюджет 8 GiB здесь выполнен.
  const dir = await privateDir(t, repoRoot);
  const journal = new RotatingJournal({ directory: dir });
  let calls = 0;
  const ac = new AbortController();
  const result = await runDaemon({
    intervalMs: 1000, journal, diskPath: dir, sleep: instant, signal: ac.signal,
    installSignalHandlers: false,
    tick: async () => { calls++; if (calls === 2) ac.abort(); return { phase: 'idle' }; },
  });
  assert.equal(calls, 2);
  assert.equal(result.stopped, 'signal');
  const log = await readFile(join(dir, 'daemon.jsonl'), 'utf8');
  assert.doesNotMatch(log, /disk_budget_blocked/);
});

// Интеграция ветки --daemon: реальный дочерний процесс run-isolated, пустая
// очередь на живом vb serve, kill-switch и SIGTERM, проверка daemon.jsonl.
function boardCli() {
  const cli = join(homedir(), '.local/share/vercel-board/node_modules/@vercel/board/dist/cli.mjs');
  readFileSync(cli);
  return cli;
}

async function startBoard(cli, t) {
  const dir = await mkdtemp(join(repoRoot, '.df-daemon-board-'));
  const child = spawnProcess(process.execPath, [cli, 'serve', '--port', '0',
    '--dir', join(dir, '.board'), '--no-inspect', '--no-open'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    child.kill('SIGKILL');
    await new Promise(resolve => child.on('exit', resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`vb serve did not report a URL: ${buffer}`)), 20_000);
    child.stdout.on('data', data => {
      buffer += String(data);
      const match = /serving a local board at (http:\/\/127\.0\.0\.1:\d+\/api\/board)/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('exit', code => reject(new Error(`vb serve exited early: ${code}`)));
  });
  return { url, dir };
}

async function daemonFixture(t, url) {
  // Фикстура на ФС с реальными правами и >= 8 GiB (state/switch требуют 0700,
  // дисковый preflight проверяет tree): worktree-раздел может не давать 0700.
  const base = await mkdtemp(join(homedir(), '.df-daemon-it-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const tree = join(base, 'tree');
  await mkdir(tree, { mode: 0o700 });
  const git = (...args) => execFileSync('git', ['-C', tree, ...args]).toString().trim();
  git('init', '--initial-branch=pilot');
  await writeFile(join(tree, 'seed'), 'seed\n');
  git('add', 'seed');
  git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'seed');
  const baseSha = git('rev-parse', 'HEAD');
  const state = join(base, 'state');
  const inbox = join(base, 'inbox');
  const switchDir = join(base, 'switch');
  const ops = join(base, 'ops');
  const gate = join(ops, 'gate');
  const xdg = join(base, 'xdg');
  await mkdir(state, { recursive: true, mode: 0o700 });
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await mkdir(switchDir, { recursive: true, mode: 0o700 });
  await mkdir(gate, { recursive: true, mode: 0o700 });
  await mkdir(xdg, { recursive: true, mode: 0o700 });
  await writeFile(join(ops, 'brief.md'), 'Synthetic daemon brief\n');
  await writeFile(join(ops, 'review.md'), 'Synthetic review prompt\n');
  await writeFile(join(ops, 'logika.md'), 'Synthetic review skill\n');
  await writeFile(join(gate, 'gate.json'), '{}\n');
  await writeFile(join(gate, 'routes.json'), '{}\n');
  const policy = join(ops, 'policy.json');
  await writeFile(policy, JSON.stringify({
    scope: 'isolated', boardUrl: url, channel: 'pilot', version: 'daemon-it-1',
    owner: 'daemon-it', label: { key: 'queue', value: 'daemon-it' },
    waitMs: 1000,
    bb: { provider: 'acp-devin', model: 'swe-2-high', project: 'proj_daemonit' },
    route: { base: baseSha, worktree: tree, policyVersion: 'daemon-it-1',
      checkProfile: 'pilot', finish: 'verified', repoId: 'repo-daemon-it' },
    profiles: { pilot: { branch: 'pilot',
      review: { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'medium',
        skills: ['logika'] } } },
    reviewSkillFiles: { logika: join(ops, 'logika.md') },
    brief: join(ops, 'brief.md'), reviewPrompt: join(ops, 'review.md'),
    reviewGate: join(gate, 'gate.json'), handoffDir: inbox,
  }));
  const switchFile = join(switchDir, 'daemon.switch');
  const spawn = () => {
    const child = spawnProcess(process.execPath,
      [join(repoRoot, 'board_pipeline', 'run-isolated.mjs'), '--execute', '--daemon',
        '--policy', policy, '--state', state, '--interval-ms', '300', '--switch', switchFile],
      { env: { ...process.env, XDG_STATE_HOME: xdg }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', d => { output += String(d); });
    child.stderr.on('data', d => { output += String(d); });
    child.done = new Promise(resolve =>
      child.on('exit', (code, sig) => resolve({ code, sig, output })));
    return child;
  };
  const journal = join(state, 'daemon.jsonl');
  const waitTicks = async (count, ms = 20_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const log = await readFile(journal, 'utf8').catch(() => '');
      const events = log.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (events.filter(e => e.event === 'tick' && e.phase === 'idle').length >= count) return events;
      if (Date.now() > deadline) throw new Error(`daemon journal did not reach ${count} idle ticks: ${log}`);
      await delay(100);
    }
  };
  const stop = child => child.done;
  return { base, tree, state, inbox, switchDir, switchFile, xdg, spawn, journal, waitTicks, stop };
}

test('run-isolated --daemon: empty ticks, kill-switch stop and SIGTERM (real child)', async t => {
  const { url } = await startBoard(boardCli(), t);
  process.env.BOARD_URL = url;
  const { board } = loadSdk();
  const handle = board();
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { await handle.createChannel('pilot'); break; }
    catch (error) { if (attempt === 5) throw error; await delay(300); }
  }
  const fx = await daemonFixture(t, url);
  await writeFile(fx.switchFile, 'run\n', { mode: 0o600 });
  assert.equal((await lstat(fx.switchFile)).mode & 0o777, 0o600);
  assert.equal((await lstat(fx.switchDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(fx.state)).mode & 0o777, 0o700);

  // Пустая очередь: холостые тики без spawn и без LLM.
  const child = fx.spawn();
  t.after(() => child.kill('SIGKILL'));
  await fx.waitTicks(2);
  await writeFile(fx.switchFile, 'stop\n', { mode: 0o600 });
  const stopped = await fx.stop(child);
  assert.equal(stopped.code, 0, 'kill-switch stop must exit cleanly');
  let log = await readFile(fx.journal, 'utf8');
  let events = log.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).event, 'daemon_stop');
  assert.equal(events.at(-1).reason, 'kill_switch');
  assert.equal((await lstat(fx.journal)).mode & 0o777, 0o600);

  // Перезапуск с 'run', реальный SIGTERM — graceful stop.
  await writeFile(fx.switchFile, 'run\n', { mode: 0o600 });
  const child2 = fx.spawn();
  t.after(() => child2.kill('SIGKILL'));
  const before = events.length;
  const deadline = Date.now() + 20_000;
  for (;;) {
    log = await readFile(fx.journal, 'utf8');
    events = log.trim().split('\n').map(line => JSON.parse(line));
    if (events.length > before && events.at(-1).event === 'daemon_start') break;
    if (Date.now() > deadline) throw new Error('second daemon did not start');
    await delay(50);
  }
  child2.kill('SIGTERM');
  const term = await fx.stop(child2);
  assert.equal(term.code, 0, 'SIGTERM must exit cleanly');
  events = (await readFile(fx.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).event, 'daemon_stop');
  assert.equal(events.at(-1).reason, 'signal');
});

test('run-isolated --daemon: starting under stop switch exits 0 without ticks', async t => {
  const { url } = await startBoard(boardCli(), t);
  const fx = await daemonFixture(t, url);
  await writeFile(fx.switchFile, 'stop\n', { mode: 0o600 });
  const child = fx.spawn();
  t.after(() => child.kill('SIGKILL'));
  const stopped = await fx.stop(child);
  assert.equal(stopped.code, 0, 'stopped switch must not crash-loop under Restart=on-failure');
  const events = (await readFile(fx.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).event, 'daemon_stop');
  assert.equal(events.at(-1).reason, 'kill_switch');
  assert.equal(events.filter(e => e.event === 'tick').length, 0);
});
