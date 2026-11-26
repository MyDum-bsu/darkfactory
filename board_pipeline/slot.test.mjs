import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
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

// --- Astra #13: canonical state directory exclusive lock ---------------------

test('stateDir option: two different worktrees sharing one state dir are mutually exclusive', async t => {
  const x = await paths(t);
  const parent = join(x.tree, '..');
  const tree2 = join(parent, 'tree2');
  await mkdir(tree2, { mode: 0o700 });
  const first = await reserveWorktree(x.registry, x.tree, x.first, { stateDir: x.first });
  // Другое дерево с тем же state-каталогом: бронь обязана отклониться ещё до
  // любой записи — иначе оба писателя перетирают один attempt.json.
  await assert.rejects(reserveWorktree(x.registry, tree2, x.first, { stateDir: x.first }),
    /already locked by another writer/);
  await first();
  // После снятия брони state-каталог свободен для следующего писателя.
  const second = await reserveWorktree(x.registry, tree2, x.first, { stateDir: x.first });
  await second();
});

test('stateDir option: canonical realpath is locked, symlinks cannot evade it', async t => {
  const x = await paths(t);
  const parent = join(x.tree, '..');
  const tree2 = join(parent, 'tree2');
  const alias = join(parent, 'state-alias');
  await mkdir(tree2, { mode: 0o700 });
  await symlink(x.first, alias);
  const first = await reserveWorktree(x.registry, x.tree, x.first, { stateDir: x.first });
  // Симлинк на тот же канонический каталог — та же бронь, обход невозможен.
  await assert.rejects(reserveWorktree(x.registry, tree2, x.first, { stateDir: alias }),
    /already locked by another writer/);
  await first();
});

test('stateDir option: distinct state dirs on distinct worktrees do not conflict', async t => {
  const x = await paths(t);
  const parent = join(x.tree, '..');
  const tree2 = join(parent, 'tree2');
  await mkdir(tree2, { mode: 0o700 });
  const first = await reserveWorktree(x.registry, x.tree, x.first, { stateDir: x.first });
  const second = await reserveWorktree(x.registry, tree2, x.second, { stateDir: x.second });
  await first();
  await second();
});

test('stateDir option: failure to acquire the state lock releases the worktree lock too', async t => {
  const x = await paths(t);
  const parent = join(x.tree, '..');
  const tree2 = join(parent, 'tree2');
  await mkdir(tree2, { mode: 0o700 });
  const holder = await reserveWorktree(x.registry, tree2, x.first, { stateDir: x.first });
  // x.tree захватывает worktree-lock, затем падает на state-lock: после отказа
  // worktree-lock обязан быть свободен (нет утечки частичной брони).
  await assert.rejects(reserveWorktree(x.registry, x.tree, x.first, { stateDir: x.first }),
    /already locked by another writer/);
  const retry = await reserveWorktree(x.registry, x.tree, x.first, { stateDir: x.second });
  await retry();
  await holder();
});

test('journalDir option is locked too, stateDir and journalDir dedupe on the same canonical path', async t => {
  const x = await paths(t);
  const parent = join(x.tree, '..');
  const tree2 = join(parent, 'tree2');
  await mkdir(tree2, { mode: 0o700 });
  const first = await reserveWorktree(x.registry, x.tree, x.first, { journalDir: x.first });
  await assert.rejects(reserveWorktree(x.registry, tree2, x.first, { journalDir: x.first }),
    /already locked by another writer/);
  // Пересекающиеся stateDir/journalDir любой комбинации конфликтуют.
  await assert.rejects(reserveWorktree(x.registry, tree2, x.first, { stateDir: x.first }),
    /already locked by another writer/);
  await first();
  // Одинаковые stateDir и journalDir в одной брони — один lock, без самоблокировки.
  const both = await reserveWorktree(x.registry, x.tree, x.first,
    { stateDir: x.first, journalDir: x.first });
  await both();
});

test('backward compatibility: omitted stateDir keeps the historical behavior', async t => {
  const x = await paths(t);
  // Без опции state-каталог не блокируется: последовательная бронь того же
  // дерева после release работает ровно как раньше.
  const first = await reserveWorktree(x.registry, x.tree, x.first);
  await first();
  const second = await reserveWorktree(x.registry, x.tree, x.first);
  await second();
});

test('stateDir option: same tree and same state dir twice concurrently is rejected', async t => {
  const x = await paths(t);
  const first = await reserveWorktree(x.registry, x.tree, x.first, { stateDir: x.first });
  // Даже worktree-lock отклоняет повторную бронь живого писателя.
  await assert.rejects(reserveWorktree(x.registry, x.tree, x.first, { stateDir: x.first }),
    /already running|already locked/);
  await first();
});
