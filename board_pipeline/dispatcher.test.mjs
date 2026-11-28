import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { loadFleet, launchProject, pollProject } from '../ops/factory-dispatch.mjs';
import { buildWorkerTransport, readSubmissionEnvelope } from './run-transport.mjs';
import { deterministicRuntimeId } from './worker-runtime.mjs';
import { calculateSlotCapacity, createDispatcher } from './dispatcher.mjs';

const readyQueues = new Set(['a', 'b', 'c']);
const projects = [...readyQueues].map(repo_id => ({ repo_id }));
const host = (memoryMiB, cpuCount) => ({ availableMemoryBytes: memoryMiB * 2 ** 20, cpuCount });
const pool = { memoryPerSlotMiB: 512, minSlots: 1, maxSlots: 12 };

test('capacity tracks host RAM, CPU and explicit bounds, including zero safe slots', () => {
  assert.equal(calculateSlotCapacity(host(5120, 32), pool), 10);
  assert.equal(calculateSlotCapacity(host(5120, 2), pool), 2);
  assert.equal(calculateSlotCapacity(host(511, 16), pool), 0);
  assert.equal(calculateSlotCapacity(host(8192, 16), pool), 12);
  assert.equal(calculateSlotCapacity({ ...host(5120, 8), cpuLoad: 7 }, { ...pool, minSlots: 3 }), 3);
  assert.equal(calculateSlotCapacity({ ...host(1024, 8), cpuLoad: 7 }, { ...pool, minSlots: 3 }), 2);
  assert.throws(() => calculateSlotCapacity(host(512, 1), { ...pool, memoryPerSlotMiB: 0 }));
});

test('polls each channel; rotates admissions and retains occupied slots across ticks and pressure', async () => {
  const polls = [], starts = [], finish = new Map(); let resources = host(512, 8);
  const d = createDispatcher({ projects: [{ repo_id: 'idle' }, ...projects], pool, resources: () => resources,
    poll: async p => { polls.push(p.repo_id); return readyQueues.has(p.repo_id); },
    launch: p => { starts.push(p.repo_id); return new Promise(r => finish.set(p.repo_id, r)); } });
  await d.tick(); assert.deepEqual(polls, ['idle','a','b','c']); assert.deepEqual(starts, ['a']);
  resources = host(1024, 8); await d.tick(); assert.deepEqual(starts, ['a','b']);
  finish.get('a')(); resources = host(0, 8); await d.tick(); assert.deepEqual(starts, ['a','b']);
  resources = host(1024, 8); await d.tick(); assert.deepEqual(starts, ['a','b','c']);
  finish.get('b')(); finish.get('c')(); await d.drain();
});

test('an observed limit defers only its route; ordinary errors do not imply exhausted quota', async () => {
  let now = 100; const starts = [], errors = []; const polls = new Map();
  const d = createDispatcher({ projects, pool, resources: () => host(4096, 8), now: () => now,
    poll: async p => {
      polls.set(p.repo_id, (polls.get(p.repo_id) ?? 0) + 1);
      if (polls.get(p.repo_id) === 1) {
        if (p.repo_id === 'a') throw Object.assign(new Error('429'), { status: 429, retryAfterMs: 500 });
        if (p.repo_id === 'b') throw new Error('unavailable');
      }
      return readyQueues.has(p.repo_id);
    }, onError: (p, e) => errors.push([p.repo_id, e.message]), launch: async p => { starts.push(p.repo_id); } });
  await d.tick(); await d.drain(); assert.deepEqual(starts, ['c']);
  now += 499; await d.tick(); await d.drain(); assert.equal(starts.includes('a'), false);
  assert.equal(starts.includes('b'), true); assert.equal(polls.get('a'), 1);
  now++; await d.tick(); await d.drain(); assert.equal(starts.includes('a'), true);
  assert.deepEqual(errors, [['a','429'], ['b','unavailable']]);
});

test('only failed launches back off exponentially up to a cap; a successful exit resets the delay', async () => {
  let now = 0, starts = 0, fail = true;
  const d = createDispatcher({ projects: [projects[0]], now: () => now, poll: () => true,
    resources: () => host(4096, 8), launch: () => { starts++; if (fail) throw Error('controller_exit_1'); } });
  async function tick() { await d.tick(); await new Promise(resolve => setImmediate(resolve)); }
  await tick();
  for (const [i, wait] of [10, 20, 40, 80, 160, 300, 300].entries()) {
    now += wait * 1000 - 1; await tick(); assert.equal(starts, i + 1);
    now++; fail = i !== 6; await tick(); assert.equal(starts, i + 2);
  }
  fail = true; await tick(); assert.equal(starts, 9);
  now += 10_000; await tick(); assert.equal(starts, 10);
  await d.drain();
});

test('managed watcher retries independently of ready polling and per-project healer deadlines', async () => {
  let now = 0, watches = 0, polls = 0; const heals = [];
  const managed = { repo_id: 'm', channel: 'optimization/tracker', policyData: { intake_mode: 'managed_dispatcher' } };
  const d = createDispatcher({ projects: [managed, projects[0]], now: () => now, ciHealerIntervalMs: 42_000,
    ciHealer: p => heals.push(p.repo_id), poll: () => { polls++; return false; }, launch: assert.fail,
    resources: () => host(4096, 8), watchRequests: (_, { signal }) => {
      if (++watches < 3) throw Error('offline');
      return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } });
  for (const [at, count] of [[0, 1], [9999, 1], [10_000, 2], [29_999, 2], [30_000, 3], [42_000, 3]]) {
    now = at; await d.tick(); assert.equal(watches, count);
  }
  assert.deepEqual(heals, ['m', 'a', 'm', 'a']); assert.equal(polls, 12);
  await d.drain();
});

test('a completed watch restarts on the next tick and resets its failure backoff', async () => {
  let now = 0, watches = 0;
  const managed = { repo_id: 'm', policyData: { intake_mode: 'managed_dispatcher' } };
  const d = createDispatcher({ projects: [managed], now: () => now, resources: () => host(4096, 8),
    poll: () => false, ciHealer: () => {}, launch: assert.fail, watchRequests: async () => {
      if (++watches !== 2) throw new Error('feed offline');
    } });
  for (const [at, count] of [[0, 1], [9999, 1], [10_000, 2], [10_000, 3], [19_999, 3], [20_000, 4]]) {
    now = at;
    await d.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(watches, count);
  }
  await d.drain();
});

test('missing PTY uses the attempt handoff only if a valid submission survived', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'df-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const attempt_id = 'attempt-1', task_id = '42';
  const submission = { task_id, attempt_id, worker_thread_id: deterministicRuntimeId('hc', task_id, attempt_id),
    epoch: 1, candidate_sha: 'a'.repeat(40) };
  const runtime = { observe: () => ({ state: 'exited', exitCode: 137, missing: true }),
    probeAvailability: assert.fail, spawn: assert.fail, feedback: assert.fail };
  const transport = buildWorkerTransport({ kind: 'hc', runtime, prepareSpawn: assert.fail, prepareFeedback: assert.fail });
  const observed = await transport.observeTurn({ runtimeId: submission.worker_thread_id, after: 1 });
  assert.deepEqual(observed, { turnSeq: 2, completed: false, state: 'exited', exitCode: 137, missing: true });
  await mkdir(join(dir, attempt_id));
  const source = join(dir, attempt_id, 'submission.json');
  const read = () => readSubmissionEnvelope({ observed, source });
  assert.deepEqual(await read(), observed);
  for (const text of ['{', 'null', '{}', JSON.stringify({ ...submission, candidate_sha: 'short' }),
    JSON.stringify({ ...submission, epoch: 0 }), JSON.stringify({ ...submission, worker_thread_id: 'other' }),
    JSON.stringify({ ...submission, attempt_id: 'other' })]) {
    await writeFile(source, text); assert.deepEqual(await read(), observed);
  }
  await writeFile(source, JSON.stringify(submission));
  const recovered = await read(); assert.equal(recovered.completed, true); assert.equal(recovered.turnSeq, 2);
  assert.deepEqual(recovered.submission, submission);
});

test('a Board wake admits disjoint scope during managed intake and CI failure; drain waits for both lifetimes', async () => {
  const [writer, managed, overlap] = ['writer', 'managed', 'overlap'].map(worktree =>
    ({ repo_id: 'repo', channel: 'cards', worktree }));
  managed.policyData = { intake_mode: 'managed_dispatcher' };
  const page = Promise.withResolvers(), inPass = Promise.withResolvers(), continuePass = Promise.withResolvers();
  const admitted = Promise.withResolvers(), writersDone = Promise.withResolvers(), watchDone = Promise.withResolvers();
  const calls = [], launched = [], errors = [], subscriptions = [];
  let ready = false, passes = 0;
  const d = createDispatcher({ projects: [writer, managed, overlap], pool,
    feedFor: p => p === managed && { poll: q => q.last ? { cursor: 'initial' } : page.promise },
    watchRequests: (p, { signal }) => { subscriptions.push({ p, signal }); return watchDone.promise; },
    ciHealer: p => { calls.push(`heal:${p.worktree}`); if (p === managed) throw new Error('CI offline'); },
    onError: (p, e) => errors.push([p, e.message]),
    poll: p => {
      calls.push(`poll:${p.worktree}`);
      if (p === managed && !ready) return false;
      return { taskId: p.worktree, allowed_paths: p === managed ? 'docs/' : 'src/' };
    },
    resources: async () => {
      if (++passes === 2) { inPass.resolve(); await continuePass.promise; }
      return host(4096, 8);
    },
    launch: p => { launched.push(p); if (p === managed) admitted.resolve(); return writersDone.promise; },
  });
  await d.tick();
  assert.deepEqual(launched, [writer]);
  const running = d.tick();
  await inPass.promise;
  assert.equal(d.tick(), running);
  ready = true;
  page.resolve({ cursor: 'ready', events: [{}] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(passes, 2, 'feed did not start a concurrent pass');
  continuePass.resolve();
  await running;
  await admitted.promise; // no timer or manual third tick
  assert.deepEqual(launched, [writer, managed]);
  assert.equal(passes, 3);
  assert.deepEqual(subscriptions.map(s => s.p), [managed]);
  assert.deepEqual(calls.filter(c => c.endsWith(':managed')), ['heal:managed', 'poll:managed', 'poll:managed', 'poll:managed']);
  assert.equal(errors.length, 1);
  assert.ok(errors.every(([p, reason]) => p === managed && reason === 'CI offline'));
  let drained = false;
  const draining = d.drain().then(() => { drained = true; });
  assert.ok(subscriptions[0].signal.aborted);
  assert.throws(() => d.tick(), /dispatch_draining/);
  writersDone.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false, 'managed watcher still cleaning up');
  watchDone.resolve();
  await draining;
});

test('fleet adapters bind each read and accepted controller to its enrolled channel, worktree and native space', async t => {
  const root = await mkdtemp(join(tmpdir(), 'df-fleet-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, 'fleet.yaml'), docsPath = join(root, 'docs.json');
  const entries = [], spaces = [];
  for (const key of ['a', 'b']) {
    const p = { repo_id: key, channel: `channel-${key}`, herdr_space_name: `Project ${key}`,
      repo_dir: join(root, key), state: join(root, `state-${key}`), worktree: join(root, `slot-${key}`),
      policy: join(root, `${key}.json`) };
    const handoffDir = join(root, `inbox-${key}`);
    await Promise.all([p.repo_dir, p.state, handoffDir].map(dir => mkdir(dir)));
    const git = (...args) => execFileSync('git', ['-C', p.repo_dir, ...args], { stdio: 'pipe' });
    git('init', '-q'); git('-c', 'user.name=Fixture', '-c', 'user.email=t@example.org', 'commit', '-qm', 'base', '--allow-empty');
    git('worktree', 'add', '--detach', p.worktree);
    await writeFile(p.policy, JSON.stringify({ scope: 'pilot', channel: p.channel, owner: 'lead',
      boardUrl: 'http://127.0.0.1:12345/api/board', pilot: { enabled: true, killSwitch: join(root, 'switch') },
      label: { key: 'queue', value: 'v12' }, route: { repoId: key, worktree: p.worktree, checkProfile: 'test', finish: 'verified' },
      bb: { provider: 'pi', model: 'test' }, handoffDir }));
    entries.push(p); spaces.push({ id: `sp-${key}`, name: p.herdr_space_name, folder: p.repo_dir });
  }
  await writeFile(docsPath, JSON.stringify({ 'herdr-app': { value: { spaces } } }));
  await writeFile(registry, JSON.stringify({ projects: entries }));
  const fleet = await loadFleet(registry);
  const launched = [], reads = [];
  const dispatcher = createDispatcher({ ...fleet, feedFor: () => null, resources: () => host(8192, 8),
    poll: p => pollProject(p, { fetchImpl: async (url, req) => {
      reads.push([url.searchParams.get('channel'), url.searchParams.getAll('label'), req.headers['x-board-can']]);
      return new Response(JSON.stringify({ tasks: [{}] }));
    } }),
    launch: p => launchProject(p, { docsPath, factory: async (argv, { env }) => {
      const owner = JSON.parse(env.DF_HERDR_PROJECT);
      launched.push([owner.herdrSpaceId, owner.worktree, env.DF_PILOT_CHANNEL, argv]);
    } }), onError: (_, e) => { throw e; } });
  await dispatcher.tick(); await dispatcher.drain();
  for (const [i, p] of entries.entries()) {
    assert.deepEqual(reads.find(r => r[0] === p.channel), [p.channel, [`repo_id=${p.repo_id}`, 'queue=v12'], `${p.channel}=read`]);
    const call = launched.find(r => r[2] === p.channel);
    assert.deepEqual(call, [`sp-${p.repo_id}`, p.worktree, p.channel, ['--runtime', 'hc', '--daemon', '--provider', 'pi',
      '--model', 'test', '--policy', p.policy, '--worktree', p.worktree, '--state', p.state]]);
    // No ready card is required for recovery of an existing WAL.
    await writeFile(join(p.state, 'attempt.json'), '{}');
    assert.equal(await pollProject(fleet.projects[i], { fetchImpl: assert.fail }), true);
  }
  const [p] = fleet.projects;
  const slash = { ...p, channel: 'optimization/tracker' };
  await rm(join(slash.state, 'attempt.json'));
  const hierarchical = createDispatcher({ projects: [slash], feedFor: () => null, ciHealer: () => {},
    poll: project => pollProject(project, { fetchImpl: async (_, req) => {
      assert.equal(req.headers['x-board-can'], 'optimization/tracker=read'); return Response.json({ tasks: [] });
    } }), launch: assert.fail, onError: (_, e) => { throw e; } });
  await hierarchical.tick(); await hierarchical.drain();
  for (const channel of ['Optimization/tracker', 'repo.name', 'repo:name']) {
    assert.throws(() => createDispatcher({ projects: [{ ...p, channel }] }), /invalid_board_channel/);
    await writeFile(registry, JSON.stringify({ projects: [{ ...entries[0], channel }] }));
    await assert.rejects(loadFleet(registry), /invalid_board_channel/);
  }
  // Exercise the actual controller transport without contacting Board or hc:
  // a quota refusal is reported after graceful retirement, with its observed delay.
  const hold = { phase: 'hold', attemptId: 'attempt-a', epoch: 1 };
  await writeFile(join(p.state, 'attempt.json'), JSON.stringify({ ...hold, reason: 'quota_exhausted', retryAfterMs: 900 }));
  const summary = JSON.stringify({ ...hold, reason: 'see_private_attempt' });
  const program = `
    const watchdog = setTimeout(() => { throw new Error('controller did not retire'); }, 5000);
    process.once('SIGTERM', () => { clearTimeout(watchdog); process.exitCode = 143; });
    console.log(process.argv[1]);
  `;
  await assert.rejects(launchProject(p, { docsPath,
    factory: (_, { run, env }) => run(process.execPath, ['-e', program, summary], env) }),
  e => e.code === 'quota_exhausted' && e.retryAfterMs === 900);
  const started = Promise.withResolvers(), exits = [], errors = [];
  const d = createDispatcher({ projects: [p], feedFor: () => null, poll: () => true, ciHealer: () => {},
    resources: () => host(4096, 8), onError: (_, e) => errors.push(e),
    launch: (_, { signal }) => launchProject(p, { docsPath, signal, factory: async (_, { run, env }) => {
      const exit = run(process.execPath, ['-e', 'setTimeout(() => process.exit(79), 5000)'], env);
      started.resolve(); exits.push(await exit);
    } }) });
  await d.tick(); await started.promise; await d.drain();
  assert.deepEqual(exits, [{ code: null, signal: 'SIGTERM' }]); assert.deepEqual(errors, []);
  await assert.rejects(launchProject({ ...p, policyData: { ...p.policyData, route: { ...p.policyData.route, herdrSpaceId: 'sp-b' } } },
    { docsPath, factory: assert.fail }), /herdr_space_mismatch/);
  await writeFile(registry, JSON.stringify({ projects: [entries[0], { ...entries[1], state: entries[0].state }] }));
  await assert.rejects(loadFleet(registry), /fleet_paths_overlap/);
});
