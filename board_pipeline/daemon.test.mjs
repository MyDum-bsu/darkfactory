import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RotatingJournal, runDaemon } from './daemon.mjs';
import { normalizeEvent } from './event-bus.mjs';
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

test('daemon loop: tick_error journal and normalized bus event carry the same error detail', async () => {
  const errors = [
    Object.assign(new Error('other_reason: details'), { code: 'lease_lost' }),
    Object.assign(new Error('poll_failed: timeout'), { code: 'EIO' }),
    new Error('No leading code'),
  ];
  const reports = [];
  const events = [];
  let index = 0;
  await runDaemon({
    intervalMs: 250, installSignalHandlers: false, sleep: instant,
    journal: { append: async entry => reports.push(entry) },
    eventBus: { emit: event => events.push(normalizeEvent(event)) },
    tick: () => { if (index < errors.length) throw errors[index++]; },
    onTick: () => 'stop',
  });
  const expected = ['lease_lost', 'poll_failed', 'tick_error'].map((code, i) => ({
    code, message: errors[i].message, consecutiveErrors: i + 1, backoffMs: 250 * 2 ** i,
  }));
  assert.deepEqual(reports.filter(e => e.event === 'tick_error'),
    expected.map(detail => ({ event: 'tick_error', ...detail })));
  assert.deepEqual(events.filter(e => e.kind === 'daemon.tick_error'),
    expected.map(detail => ({ kind: 'daemon.tick_error', role: 'daemon', detail })));
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

async function daemonFixture(t, url, { pilot = false } = {}) {
  // Фикстура на ФС с реальными правами и >= 8 GiB (state/switch требуют 0700,
  // дисковый preflight проверяет tree): worktree-раздел (fuseblk) не даёт 0700,
  // а home-раздел может оказаться заполнен — tmpdir подходит по обоим.
  const base = await mkdtemp(join(tmpdir(), 'df-daemon-it-'));
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
  const switchFile = join(switchDir, 'daemon.switch');
  const policy = join(ops, 'policy.json');
  await writeFile(policy, JSON.stringify({
    ...(pilot
      ? { scope: 'pilot', channel: 'fixture-pilot',
          pilot: { enabled: true, killSwitch: switchFile } }
      : { scope: 'isolated', channel: 'pilot' }),
    boardUrl: url, version: 'daemon-it-1',
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
  const spawn = (env = {}) => {
    const child = spawnProcess(process.execPath,
      [join(repoRoot, 'board_pipeline', 'run-isolated.mjs'), '--execute', '--daemon',
        '--policy', policy, '--state', state, '--interval-ms', '300', '--switch', switchFile],
      { env: { ...process.env, DF_AGY_KEYRING_ITEM: '/org/freedesktop/secrets/collection/fixture/0',
          ...env, DF_PILOT_CHANNEL: 'fixture-pilot', XDG_STATE_HOME: xdg },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', d => { output += String(d); });
    child.stderr.on('data', d => { output += String(d); });
    child.done = new Promise(resolve =>
      child.on('exit', (code, sig) => resolve({ code, sig, output })));
    return child;
  };
  const journal = join(state, 'daemon.jsonl');
  const waitTicks = async (count, { timeoutMs = 20_000, child } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        const { output } = await child.done;
        throw new Error(`daemon exited before idle: ${output}`);
      }
      const log = await readFile(journal, 'utf8').catch(() => '');
      const events = log.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (events.filter(e => e.event === 'tick' && e.phase === 'idle').length >= count) return events;
      if (Date.now() > deadline) throw new Error(`daemon journal did not reach ${count} idle ticks: ${log}`);
      await delay(100);
    }
  };
  const stop = child => child.done;
  return { base, tree, state, inbox, switchDir, switchFile, xdg, policy, spawn, journal, waitTicks, stop };
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

test('run-isolated --daemon: pinned intake and separate telemetry for two cards', { timeout: 35_000 }, async t => {
  const { url } = await startBoard(boardCli(), t);
  process.env.BOARD_URL = url;
  const handle = loadSdk().board();
  await handle.createChannel('pilot');
  const fx = await daemonFixture(t, url);
  const cfg = JSON.parse(await readFile(fx.policy, 'utf8'));
  cfg.owner = (await handle.me()).principal;
  // P1-12: тест написан под BB-транспорт (фейковый бинарь bb в PATH) — маршрут
  // закрепляется явно, а не унаследованным дефолтом рантайма.
  cfg.workerRuntime = 'bb';
  const answers = join(fx.base, 'answers');
  await mkdir(answers, { mode: 0o700 });
  cfg.questionGate = { exclusiveBoardOwner: true, inbox: answers, ttlMs: 60_000,
    publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) };
  await writeFile(fx.policy, JSON.stringify(cfg));
  const decision = 'Принятые решения: ручная выгрузка — CSV.';
  await writeFile(cfg.brief, decision);

  const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  // Реальный отпечаток входов слота: тот же порядок файлов и та же схема, что
  // readOperatorInputs — [policy, brief, reviewPrompt, reviewGate, routes, ...skills].
  // Без совпадающего policy_digest queue-допуск справедливо не отдаёт карточки слоту.
  const fileDigest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const digestPaths = [fx.policy, cfg.brief, cfg.reviewPrompt, cfg.reviewGate,
    join(dirname(cfg.reviewGate), 'routes.json'), cfg.reviewSkillFiles.logika];
  const policyDigest = createHash('sha256')
    .update(JSON.stringify(digestPaths.map(fileDigest))).digest('hex');
  const labels = text => ({ queue: 'daemon-it', repo_id: 'repo-daemon-it', profile_id: 'pilot',
    finish: 'verified', spec_digest: sha256(text), policy_digest: policyDigest });
  const specs = ['Fixture 1 card specification', 'Fixture 2 card specification'];
  const first = (await handle.tasks.create('pilot', { text: specs[0], labels: labels(specs[0]) })).task.id;
  const second = (await handle.tasks.create('pilot', { text: specs[1], labels: labels(specs[1]) })).task.id;
  const bin = join(fx.base, 'bin');
  await mkdir(bin, { mode: 0o700 });
  const prompts = join(fx.base, 'prompts.jsonl');
  await writeFile(join(bin, 'bb'), `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const [group, action, id] = process.argv.slice(2);
const out = value => console.log(JSON.stringify(value));
if (group !== 'thread') process.exit(86);
if (action === 'spawn') {
  const prompt = readFileSync(process.argv[process.argv.indexOf('--prompt-file') + 1], 'utf8');
  appendFileSync(${JSON.stringify(prompts)}, JSON.stringify(prompt) + '\\n');
  out({ id: 'thr_fixture' });
} else if (action === 'stop') {
  out({ stopped: true });
} else if (action === 'show') {
  out({ thread: { id, status: 'idle', activeBackgroundAgentCount: 0, queuedMessageCount: 0 },
    environment: { path: ${JSON.stringify(fx.tree)} } });
} else if (action === 'log') {
  out([{ type: 'turn/completed', threadId: id, seq: 10, data: { status: 'completed' } }]);
} else process.exit(86);
`, { mode: 0o700 });
  await writeFile(fx.switchFile, 'run\n', { mode: 0o600 });
  const child = fx.spawn({ PATH: bin + delimiter + process.env.PATH });
  t.after(() => child.kill('SIGKILL'));
  await fx.waitTicks(1, { child });
  await writeFile(fx.switchFile, 'stop\n', { mode: 0o600 });
  const stopped = await fx.stop(child);
  assert.equal(stopped.code, 0, stopped.output);

  const journal = await readFile(join(fx.state, 'telemetry.jsonl'), 'utf8');
  const attempts = journal.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(attempts.map(entry => entry.task_id), [first, second]);
  assert.ok(attempts.every(entry => entry.open === false && entry.outcome === 'hold'));
  assert.notEqual(attempts[0].attempt_id, attempts[1].attempt_id);
  for (const id of [first, second]) {
    assert.equal((await handle.thread(id)).message.task.state, 'blocked');
  }

  const observed = (await readFile(prompts, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(observed.length, 2);
  for (const [index, id] of [first, second].entries()) {
    assert.ok(observed[index].startsWith(decision));
    assert.ok(observed[index].includes(`"task_id":"${id}"`));
    assert.ok(observed[index].includes(
      `Task specification (verified spec_digest ${sha256(specs[index])}):\n${specs[index]}`));
    assert.ok(!observed[index].includes(specs[1 - index]));
    assert.match(observed[index], /without asking again/);
  }
});

test('run-isolated --daemon: pilot scope under stop switch also exits 0', async t => {
  // scope=pilot активирует eager switchOpen: регрессия — остановленный
  // kill-switch обязан дойти до runDaemon (kill_switch, exit 0), а не бросать
  // PilotDenied до цикла.
  const { url } = await startBoard(boardCli(), t);
  const fx = await daemonFixture(t, url, { pilot: true });
  await writeFile(fx.switchFile, 'stop\n', { mode: 0o600 });
  const child = fx.spawn();
  t.after(() => child.kill('SIGKILL'));
  const stopped = await fx.stop(child);
  assert.equal(stopped.code, 0, `pilot stopped switch must exit cleanly, output: ${stopped.output}`);
  const events = (await readFile(fx.journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).event, 'daemon_stop');
  assert.equal(events.at(-1).reason, 'kill_switch');
  assert.equal(events.filter(e => e.event === 'tick').length, 0);
});

// --- Astra #17 + Opus P2-8: degraded preflight, onTick isolation, backoff ----

test('daemon loop: disk failure with active in-flight attempt still ticks with preflightFailed', async t => {
  const dir = await privateDir(t);
  const journal = new RotatingJournal({ directory: dir });
  const seen = [];
  const ac = new AbortController();
  let checks = 0;
  const result = await runDaemon({
    intervalMs: 1000, journal, sleep: instant, signal: ac.signal,
    installSignalHandlers: false,
    checkDisk: async () => { checks++; if (checks > 1) throw new Error('disk budget: low'); },
    hasActiveAttempt: () => true,
    tick: async ctx => {
      seen.push(ctx);
      if (seen.length === 2) ac.abort();
      return { phase: 'working' };
    },
  });
  assert.equal(seen.length, 2, 'lease maintenance тика продолжается несмотря на preflight');
  assert.ok(seen.every(ctx => ctx?.preflightFailed === true),
    'тик обязан получать preflightFailed: true при отказе диска');
  const log = await readFile(join(dir, 'daemon.jsonl'), 'utf8');
  assert.match(log, /disk_budget_degraded/);
  assert.match(log, /disk_budget_blocked/);
});

test('daemon loop: disk failure without active attempt skips ticks (backward compatible)', async () => {
  let checks = 0;
  let calls = 0;
  const ac = new AbortController();
  const result = await runDaemon({
    intervalMs: 1000, sleep: instant, signal: ac.signal,
    installSignalHandlers: false,
    checkDisk: async () => {
      checks++;
      // Стартовый preflight (checks === 1) проходит, диск заполняется позже.
      if (checks === 5) ac.abort();
      if (checks > 1) throw new Error('disk budget: low');
    },
    hasActiveAttempt: () => false,
    tick: async () => { calls++; return { phase: 'idle' }; },
  });
  assert.equal(calls, 0, 'без активной попытки тики пропускаются');
  assert.equal(result.stopped, 'signal');
});

test('daemon loop: hasActiveAttempt probe failure preserves lease maintenance', async t => {
  const dir = await privateDir(t);
  const journal = new RotatingJournal({ directory: dir });
  let calls = 0;
  const ac = new AbortController();
  let checks = 0;
  await runDaemon({
    intervalMs: 1000, journal, sleep: instant, signal: ac.signal,
    installSignalHandlers: false,
    checkDisk: async () => { checks++; if (checks > 1) throw new Error('disk budget: low'); },
    hasActiveAttempt: () => { throw new Error('probe broken'); },
    tick: async ctx => {
      calls++;
      assert.equal(ctx.preflightFailed, true);
      if (calls === 2) ac.abort();
      return { phase: 'working' };
    },
  });
  assert.equal(calls, 2, 'неопределённость трактуется в пользу сохранения lease');
  const log = await readFile(join(dir, 'daemon.jsonl'), 'utf8');
  assert.match(log, /has_active_attempt_error/);
});

test('daemon loop: healthy disk passes preflightFailed false to tick', async () => {
  const seen = [];
  const ac = new AbortController();
  await runDaemon({
    intervalMs: 1000, sleep: instant, signal: ac.signal,
    installSignalHandlers: false,
    checkDisk: async () => {},
    tick: async ctx => { seen.push(ctx); if (seen.length === 1) ac.abort(); return { phase: 'idle' }; },
  });
  assert.deepEqual(seen, [{ preflightFailed: false }]);
});

test('daemon loop: onTick exception cannot crash the daemon and is journaled', async t => {
  const dir = await privateDir(t);
  const journal = new RotatingJournal({ directory: dir });
  let calls = 0;
  const ac = new AbortController();
  const result = await runDaemon({
    intervalMs: 1000, journal, sleep: instant, signal: ac.signal,
    installSignalHandlers: false,
    tick: async () => { calls++; if (calls === 3) ac.abort(); return { phase: 'idle' }; },
    onTick: async () => { throw new Error('policy exploded'); },
  });
  assert.equal(calls, 3, 'цикл продолжает работать после исключения в onTick');
  assert.equal(result.stopped, 'signal');
  const log = await readFile(join(dir, 'daemon.jsonl'), 'utf8');
  assert.match(log, /ontick_error.*policy exploded/);
});

test('daemon loop: repeated tick_error waits grow exponentially and stay bounded', async t => {
  const dir = await privateDir(t);
  const journal = new RotatingJournal({ directory: dir });
  const waits = [];
  let calls = 0;
  const ac = new AbortController();
  await runDaemon({
    intervalMs: 1000, journal, signal: ac.signal,
    installSignalHandlers: false,
    maxTickErrorBackoffMs: 3000,
    sleep: async ms => { waits.push(ms); },
    tick: async () => {
      calls++;
      if (calls <= 4) throw new Error(`boom ${calls}`);
      if (calls === 5) return { phase: 'idle' }; // успех сбрасывает backoff
      if (calls === 6) throw new Error('boom again');
      ac.abort();
      return { phase: 'idle' };
    },
  });
  assert.equal(calls, 7);
  // 1000, 2000, cap 3000, cap 3000; успех — обычный интервал; сброшенный backoff — снова 1000.
  assert.deepEqual(waits, [1000, 2000, 3000, 3000, 1000, 1000]);
  const log = await readFile(join(dir, 'daemon.jsonl'), 'utf8');
  const errors = log.trim().split('\n').map(line => JSON.parse(line))
    .filter(entry => entry.event === 'tick_error');
  assert.deepEqual(errors.map(entry => entry.consecutiveErrors), [1, 2, 3, 4, 1]);
  assert.deepEqual(errors.map(entry => entry.backoffMs), [1000, 2000, 3000, 3000, 1000]);
});

test('daemon loop: maxTickErrorBackoffMs is validated', async () => {
  await assert.rejects(() => runDaemon({
    tick: async () => ({}), intervalMs: 1000, maxTickErrorBackoffMs: 0,
  }), /maxTickErrorBackoffMs must be a positive integer/);
});

test('daemon loop: startup disk failure with active attempt starts degraded instead of crashing', async t => {
  const dir = await privateDir(t);
  const journal = new RotatingJournal({ directory: dir });
  let calls = 0;
  const ac = new AbortController();
  const result = await runDaemon({
    intervalMs: 1000, journal, sleep: instant, signal: ac.signal,
    installSignalHandlers: false,
    checkDisk: async () => { throw new Error('disk budget: low'); },
    hasActiveAttempt: () => true,
    tick: async ctx => {
      calls++;
      assert.equal(ctx.preflightFailed, true, 'восстановленная попытка тикается в degraded-режиме');
      if (calls === 1) ac.abort();
      return { phase: 'working' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.stopped, 'signal');
  const log = await readFile(join(dir, 'daemon.jsonl'), 'utf8');
  assert.match(log, /disk_budget_degraded/);
});

test('daemon loop: startup disk failure without active attempt still refuses to start', async () => {
  let calls = 0;
  await assert.rejects(() => runDaemon({
    intervalMs: 1000, installSignalHandlers: false, sleep: instant,
    checkDisk: async () => { throw new Error('disk budget: low'); },
    hasActiveAttempt: () => false,
    tick: async () => { calls++; return { phase: 'idle' }; },
  }), /disk budget/);
  assert.equal(calls, 0);
});
