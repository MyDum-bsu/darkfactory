import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { reserveWorktree } from './slot.mjs';

async function paths(t) {
  const parent = await mkdtemp(join(tmpdir(), 'pilot-slot-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const [registry, tree, first, second] = ['registry', 'tree', 'first', 'second'].map(name => join(parent, name));
  await Promise.all([tree, first, second].map(path => mkdir(path, { mode: 0o700 })));
  return { registry, tree, first, second };
}

test('same worktree stays reserved even when another controller uses a different state directory', async t => {
  const x = await paths(t);
  const release = await reserveWorktree(x.registry, x.tree, x.first);
  try { await assert.rejects(reserveWorktree(x.registry, x.tree, x.second), /already running/); }
  finally { await release(); }
  await assert.rejects(reserveWorktree(x.registry, x.tree, x.second), /still reserved/);
});

test('a SIGKILL leaves the reservation but releases the kernel process lock', async t => {
  const x = await paths(t);
  const url = new URL('./slot.mjs', import.meta.url).href;
  const worker = spawn(process.execPath, ['--input-type=module', '-e',
    `import {reserveWorktree} from ${JSON.stringify(url)}; await reserveWorktree(...process.argv.slice(1)); console.log('ready')`,
    x.registry, x.tree, x.first], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(worker, 'exit');
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); });
  const ready = await Promise.race([once(worker.stdout, 'data').then(([data]) => data.toString().trim()), exited.then(() => 'exit')]);
  assert.equal(ready, 'ready');
  worker.kill('SIGKILL');
  await exited;
  let release;
  for (let i = 0; i < 10; i++) {
    try { release = await reserveWorktree(x.registry, x.tree, x.first); break; }
    catch (error) { if (!/already running/.test(error.message)) throw error; await delay(35); }
  }
  assert.equal(typeof release, 'function');
  await release();
  await assert.rejects(reserveWorktree(x.registry, x.tree, x.second), /still reserved/);
});
