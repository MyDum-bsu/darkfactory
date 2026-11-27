import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { globMatch, inside, reapStaleLock } from './fs-safe.mjs';

test('inside compares complete path components after lexical resolution', () => {
  for (const target of ['/a/b', '/a/b/', '/a/b/./child', '/a/b/..backup']) {
    assert.equal(inside('/a/b', target), true, target);
  }
  for (const target of ['/a/bc', '/a', '/elsewhere', '/a/b/..', '/a/b/child/../../sibling', '/a/b/link/../file']) {
    assert.equal(inside('/a/b', target), false, target);
  }
  for (const invalid of ['', null, undefined, 1, {}, '/a/b/\0']) {
    assert.equal(inside('/a/b', invalid), false);
    assert.equal(inside(invalid, '/a/b'), false);
  }
});

test('globMatch is anchored, component-aware, and treats non-glob syntax literally', () => {
  const directChildren = ['src', '*'].join('/');
  for (const [pattern, path, expected] of [
    ['src', 'src/a', false], [directChildren, 'src/a', true], [directChildren, 'src/a/b', false],
    ['a*b', 'ab', true], ['a?b', 'ab', false], ['a?b', 'a/b', false], ['a?b', 'a.b', true],
    ['**/*.js', '.root.js', true], ['**/*.js', 'a/b/c.js', true], ['**/*.js', 'x.jsx', false],
    ['a/**/b', 'a/b', true], ['a/**/b', 'a/c/d/b', true], ['a/**/b', 'a/c/d/e', false],
    ['x/[a]+.(b)', 'x/[a]+.(b)', true], ['x/[a]+.(b)', 'x/aaab', false],
    ['**/**/end', 'end', true], ['**/**/end', 'x/end/more', false],
    ['*a'.repeat(100) + 'z', 'a'.repeat(200), false],
  ]) assert.equal(globMatch(pattern, path), expected, `${pattern}: ${path}`);
});

test('globMatch refuses malformed and non-relative policy paths', () => {
  for (const bad of [null, undefined, 1, '', '/', '/src', '../src', 'src/../out', './x', 'a//b', 'a\0b']) {
    assert.equal(globMatch('**', bad), false);
    assert.equal(globMatch(bad, 'x'), false);
  }
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fs-safe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, lock: join(dir, 'store.lock') };
}

const created = Date.UTC(2025, 0, 1);
const threshold = { staleMs: 1000, nowMs: created + 1000 };
const expired = { ...threshold, nowMs: threshold.nowMs + 1 };

test('legacy locks use mtime and expire strictly after the threshold', async t => {
  const { lock } = await fixture(t);
  for (const raw of ['', 'partial', '{"createdAt":"unknown"}']) {
    await writeFile(lock, raw);
    await utimes(lock, new Date(created), new Date(created));
    assert.deepEqual(await reapStaleLock(lock, threshold), { reaped: false, reason: 'fresh' });
    assert.equal(await readFile(lock, 'utf8'), raw);
    assert.deepEqual(await reapStaleLock(lock, expired), { reaped: true, reason: 'stale' });
    await assert.rejects(lstat(lock), { code: 'ENOENT' });
    assert.deepEqual(await reapStaleLock(lock, expired), { reaped: false, reason: 'missing' });
  }
});

test('JSON locks use createdAt, and age alone never evicts a live owner', async t => {
  const { lock } = await fixture(t);
  const meta = { createdAt: new Date(created).toISOString(), pid: process.pid, token: 'owner' };
  await writeFile(lock, JSON.stringify(meta));
  assert.deepEqual(await reapStaleLock(lock, expired), { reaped: false, reason: 'live_owner' });
  assert.deepEqual(JSON.parse(await readFile(lock)), meta);
  delete meta.pid;
  await writeFile(lock, JSON.stringify(meta));
  assert.equal((await reapStaleLock(lock, threshold)).reaped, false);
  assert.equal((await reapStaleLock(lock, expired)).reaped, true);
});

test('reaping skips directories, symlink locks (including dangling), and aliased parents', async t => {
  const { lock, dir } = await fixture(t);
  const target = join(dir, 'target');
  await writeFile(target, JSON.stringify({ createdAt: new Date(created).toISOString() }));
  await symlink(target, lock);
  assert.deepEqual(await reapStaleLock(lock, expired), { reaped: false, reason: 'symlink' });
  assert.ok((await lstat(lock)).isSymbolicLink());
  const alias = join(dir, 'alias');
  await symlink(dir, alias);
  assert.equal((await reapStaleLock(join(alias, 'target'), expired)).reaped, false);
  assert.ok((await lstat(target)).isFile());
  await rm(target);
  assert.deepEqual(await reapStaleLock(lock, expired), { reaped: false, reason: 'symlink' });
  assert.ok((await lstat(lock)).isSymbolicLink());
  assert.deepEqual(await reapStaleLock(dir, expired), { reaped: false, reason: 'not_file' });
});

test('invalid reaper inputs fail closed', async t => {
  const { lock } = await fixture(t);
  await writeFile(lock, '{}');
  for (const options of [null, undefined, {}, { staleMs: -1 }, { staleMs: NaN }, { staleMs: 0, nowMs: Infinity }]) {
    assert.deepEqual(await reapStaleLock(lock, options), { reaped: false, reason: 'invalid' });
  }
  for (const path of [null, undefined, '', 'x\0', `${lock}/../store.lock`]) {
    assert.deepEqual(await reapStaleLock(path, expired), { reaped: false, reason: 'invalid' });
  }
  assert.equal(await readFile(lock, 'utf8'), '{}');
});
