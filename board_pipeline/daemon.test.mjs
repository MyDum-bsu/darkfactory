import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RotatingJournal, runDaemon } from './daemon.mjs';
import { createPilotSwitch } from './pilot-gate.mjs';

const instant = () => Promise.resolve();

async function privateDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'df-daemon-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('daemon loop: empty ticks cost nothing and stop on abort', async () => {
  const dir = await privateDir(test);
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
