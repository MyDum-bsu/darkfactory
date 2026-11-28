// node ops/factory-dispatch.mjs --config /operator/fleet.yaml [--allow-live-pilot]
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDocument } from 'yaml';
import { checkChannel } from '../board_pipeline/board-stigmergy.mjs';
import { canonicalPolicyPath } from '../board_pipeline/config-compiler.mjs';
import { calculateSlotCapacity, createDispatcher } from '../board_pipeline/dispatcher.mjs';
import { inside } from '../board_pipeline/fs-safe.mjs';
import { resolveHerdrSpace, worktreeRepoDir } from '../board_pipeline/herdr-spaces.mjs';
import { boardActivation } from '../board_pipeline/pilot-gate.mjs';
import { runFactory } from './factory-run.mjs';

const fail = code => { throw new Error(code); };
const id = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
const overlaps = (a, b) => inside(a, b) || inside(b, a);
function fields(object, allowed) {
  if (!object || typeof object !== 'object' || Array.isArray(object) ||
      Object.keys(object).some(k => !allowed.includes(k))) fail('fleet_config_invalid');
}

export async function loadFleet(path, { allowLive = false } = {}) {
  await canonicalPolicyPath(path, 'file');
  const doc = parseDocument(await readFile(path, 'utf8'), { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) fail('fleet_yaml_invalid');
  const cfg = doc.toJS({ maxAliasCount: 0 });
  fields(cfg, ['projects', 'pool', 'intervalMs']);
  const { projects, pool = {}, intervalMs = 5000 } = cfg;
  fields(pool, ['minSlots', 'maxSlots', 'memoryPerSlotMiB']);
  calculateSlotCapacity({ availableMemoryBytes: 0, cpuCount: 0 }, pool);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 2 ** 31 - 1 ||
      !Array.isArray(projects) || !projects.length) fail('fleet_config_invalid');
  const enrolled = [];
  for (const p of projects) {
    fields(p, ['repo_id', 'repo_dir', 'herdr_space_name', 'channel', 'policy', 'state', 'worktree']);
    checkChannel(p.channel);
    if (!id(p.repo_id) || typeof p.herdr_space_name !== 'string' || !p.herdr_space_name.trim()) {
      fail('fleet_project_invalid');
    }
    for (const k of ['repo_dir', 'worktree', 'state', 'policy']) await canonicalPolicyPath(p[k], k === 'policy' ? 'file' : 'dir');
    const bytes = await readFile(p.policy, 'utf8');
    const policy = JSON.parse(bytes);
    if (policy.channel !== p.channel || policy.route?.repoId !== p.repo_id || policy.route.taskId !== undefined ||
        policy.route.worktree !== p.worktree || !policy.bb?.provider || !policy.bb.model || !policy.pilot?.killSwitch) {
      fail('fleet_policy_mismatch');
    }
    boardActivation(policy, { allowLive, pilotChannel: p.channel });
    await canonicalPolicyPath(policy.handoffDir, 'dir');
    if (p.worktree === p.repo_dir || await worktreeRepoDir(p.worktree) !== p.repo_dir) fail('fleet_worktree_mismatch');
    enrolled.push({ ...p, bytes, policyData: policy });
  }
  // No aliasing across registrations, including controller state or submission
  // inboxes placed under another project's writable checkout.
  const reserved = enrolled.flatMap(p => [p.worktree, p.state, p.policyData.handoffDir]);
  const operatorFiles = [path, ...enrolled.map(p => p.policy)];
  if (new Set(enrolled.map(p => p.repo_id)).size !== enrolled.length ||
      new Set(enrolled.map(p => p.repo_dir)).size !== enrolled.length ||
      reserved.some((dir, i) => reserved.slice(i + 1).some(other => overlaps(dir, other)) ||
        operatorFiles.some(file => inside(dir, file)) || enrolled.some(p => overlaps(dir, p.repo_dir)))) {
    fail('fleet_paths_overlap');
  }
  return { projects: enrolled, intervalMs, pool };
}

export async function pollProject(p, { fetchImpl = fetch } = {}) {
  // Recovery must not depend on a fresh ready card. Only the controller may
  // interpret or advance its WAL; never delete it to free a slot.
  const wal = await readFile(join(p.state, 'attempt.json'), 'utf8').catch(e => {
    if (e.code === 'ENOENT') return 'null'; throw e;
  });
  if (JSON.parse(wal) !== null) return true;
  const policy = p.policyData;
  const url = new URL(`${policy.boardUrl}/tasks`);
  url.search = new URLSearchParams({ channel: p.channel, state: 'ready', owner: policy.owner, limit: '1' });
  url.searchParams.append('label', `repo_id=${p.repo_id}`);
  url.searchParams.append('label', `${policy.label.key}=${policy.label.value}`);
  const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: {
    'x-board-profile': 'control-room-observer', 'x-board-can': `${checkChannel(p.channel)}=read`, accept: 'application/json',
    ...(process.env.BOARD_TOKEN ? { authorization: `Bearer ${process.env.BOARD_TOKEN}` } : {}),
  } });
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    const retryAfterMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
    throw Object.assign(new Error(`board_http_${res.status}`), { status: res.status, retryAfterMs });
  }
  const body = await res.json();
  if (!Array.isArray(body.tasks)) fail('board_tasks_invalid');
  return body.tasks.length !== 0;
}

async function quotaObservation(result, state) {
  let observation = result;
  if (result.reason === 'see_private_attempt' && result.attemptId && result.phase === 'hold') {
    // Live pilots redact reasons on stdout. Only trust the matching WAL, not
    // a previous card's log line, a prompt substring or generic exit code.
    try { observation = JSON.parse(await readFile(join(state, 'attempt.json'), 'utf8')); } catch { return; }
    if (observation?.attemptId !== result.attemptId || observation.epoch !== result.epoch ||
        observation.phase !== result.phase) return;
  }
  if (['quota_exhausted', 'rate_limit', 'rate_limited'].includes(observation.reason)) {
    return Object.assign(new Error(observation.reason), { code: observation.reason, retryAfterMs: observation.retryAfterMs });
  }
}

// In daemon mode the accepted controller, unlike a one-shot run, stops the
// writer, resets the queue worktree and clears its WAL on done/hold. Request
// graceful retirement after one card so a hot queue cannot monopolize a slot.
async function runOneCard(cmd, argv, env, state, signal) {
  signal?.throwIfAborted(); // drain may have started during policy/worktree checks
  let observation, retiring = false;
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const retire = () => { if (!retiring) retiring = child.kill('SIGTERM'); };
    signal?.addEventListener('abort', retire, { once: true });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let result;
      try { result = JSON.parse(line); } catch { return; }
      if (observation || !['idle', 'done', 'hold'].includes(result?.phase)) return;
      observation = quotaObservation(result, state);
      retire();
    });
    child.once('error', reject);
    child.once('close', (code, exitSignal) => {
      signal?.removeEventListener('abort', retire);
      resolve({ code, exitSignal });
    });
  });
  const limit = await observation;
  if (limit) throw limit;
  if (exit.code !== 0 && !(retiring && (exit.exitSignal === 'SIGTERM' || exit.code === 143))) {
    throw new Error(`controller_exit_${exit.code ?? exit.exitSignal}`);
  }
  return { code: exit.code, ...(exit.exitSignal ? { signal: exit.exitSignal } : {}) };
}

export async function launchProject(p, { allowLive = false, factory = runFactory, docsPath, signal } = {}) {
  if (await readFile(p.policy, 'utf8') !== p.bytes) fail('fleet_policy_changed');
  if (await worktreeRepoDir(p.worktree) !== p.repo_dir) fail('fleet_worktree_mismatch');
  const { repo_id, repo_dir, herdr_space_name, worktree } = p;
  const { bb, route } = p.policyData;
  const owner = { repo_id, repo_dir, herdr_space_name, worktree };
  owner.herdrSpaceId = await resolveHerdrSpace({ ...owner, herdrSpaceId: route.herdrSpaceId }, { docsPath });
  return factory(['--runtime', 'hc', '--daemon', '--provider', bb.provider, '--model', bb.model,
    '--policy', p.policy, '--worktree', worktree, '--state', p.state, ...(allowLive ? ['--allow-live-pilot'] : [])], {
    env: { ...process.env, DF_HERDR_PROJECT: JSON.stringify(owner), DF_PILOT_CHANNEL: p.channel },
    run: (cmd, argv, env) => runOneCard(cmd, argv, env, p.state, signal),
  });
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { config: { type: 'string' }, 'allow-live-pilot': { type: 'boolean' } } });
  const opts = { allowLive: values['allow-live-pilot'] === true };
  const fleet = await loadFleet(values.config, opts);
  const d = createDispatcher({ ...fleet, poll: pollProject, launch: (p, { signal }) => launchProject(p, { ...opts, signal }),
    onError: (p, e) => console.error(`${p.repo_id}: ${e.message}`) });
  const ac = new AbortController();
  let shutdown;
  const stop = () => { ac.abort(); shutdown ??= d.drain(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!ac.signal.aborted) {
      await d.tick();
      await delay(fleet.intervalMs, null, { signal: ac.signal }).catch(e => { if (!ac.signal.aborted) throw e; });
    }
  } finally {
    stop();
    await shutdown;
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch(e => { console.error(`factory-dispatch: ${e.message}`); process.exitCode = 2; });
}
