import assert from 'node:assert/strict';
import {
  closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BASELINE_SCHEMA, DEFAULT_BASELINE_TTL_MS, baselineCacheKey, compareAgainstBaseline,
  extractFailedTests, readBaselineCache, writeBaselineCache,
} from './baseline-cache.mjs';

const baseSha = 'ac'.repeat(20);
const inputs = { baseSha, l1Profile: 'node', commandsDigest: 'commands:v1' };
const key = baselineCacheKey(inputs);
const record = { baseSha, l1Profile: 'node', ok: false, exitCode: 1, failedTests: ['z', 'a', 'a'], recordedAt: 1000 };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'baseline-cache-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const worktree = join(root, 'repo');
  mkdirSync(worktree);
  const dir = join(root, 'repo-cache'); // shares a prefix, not a descendant
  return { root, worktree, dir, file: join(dir, `${key}.json`) };
}

test('extracts, normalizes and sorts TAP, spec reporter and pytest identifiers', () => {
  assert.deepEqual(extractFailedTests([
    '    not ok 12 - tests are named (12.3ms)  ', '✖ tests are named (1ms)', '✖ failing tests:',
    '\u001b[31m✖ A (label) (0.2ms)\u001b[0m', 'FAILED test_a.py::test_b[param - 2] - ValueError: no',
    '  FAILED test_a.py::test_b[param - 2]', 'FAILED test_c.py::test_c',
    'ok 4 - not ok 1 - ignore', '# ✖ diagnostic', 'assert "FAILED other"',
  ].join('\r\n')), ['A (label)', 'test_a.py::test_b[param - 2]', 'test_c.py::test_c', 'tests are named']);
  assert.deepEqual(extractFailedTests('process terminated\n✖ (2ms)'), []);
});

test('cache key binds each validated field without delimiter collisions', () => {
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(baselineCacheKey({ ...inputs }), key);
  for (const override of [{ baseSha: 'b'.repeat(40) }, { l1Profile: 'python' }, { commandsDigest: 'v2' }]) {
    assert.notEqual(baselineCacheKey({ ...inputs, ...override }), key);
  }
  assert.notEqual(baselineCacheKey({ baseSha, l1Profile: 'a:b', commandsDigest: 'c' }),
    baselineCacheKey({ baseSha, l1Profile: 'a', commandsDigest: 'b:c' }));
  for (const input of [null, undefined, { ...inputs, baseSha: 'a'.repeat(39) }, { ...inputs, baseSha: baseSha.toUpperCase() },
    { ...inputs, l1Profile: ' ' }, { ...inputs, commandsDigest: '' }, { ...inputs, commandsDigest: 2 }]) {
    assert.throws(() => baselineCacheKey(input), /baseline_key_invalid/);
  }
});

test('writes only canonical fields, privately and by atomic replacement', t => {
  const { dir, file, worktree } = fixture(t);
  const read = () => readBaselineCache(dir, key, { worktree, now: () => 1050 });
  assert.equal(read(), null);
  writeBaselineCache(dir, key, { ...record, schema: 'bogus', key: 'wrong', extra: true }, { worktree });
  const first = { ...record, key, schema: 'darkfactory.baseline.v1', failedTests: ['a', 'z'] };
  assert.deepEqual(read(), first);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const old = openSync(file, 'r');
  try {
    writeBaselineCache(dir, key, { ...record, exitCode: 0, ok: true, failedTests: [] }, { worktree });
    assert.notEqual(fstatSync(old).ino, statSync(file).ino);
    assert.deepEqual(JSON.parse(readFileSync(old, 'utf8')), first);
    assert.deepEqual(read(), { ...first, exitCode: 0, ok: true, failedTests: [] });
    assert.deepEqual(readdirSync(dir), [`${key}.json`]);
  } finally { closeSync(old); }
});

test('TTL is inclusive at the boundary and cannot accept future or non-finite ages', t => {
  const { dir } = fixture(t);
  writeBaselineCache(dir, key, record);
  const read = (age, ttlMs) => readBaselineCache(dir, key, { now: () => record.recordedAt + age, ttlMs });
  assert.equal(DEFAULT_BASELINE_TTL_MS, 86_400_000);
  assert.equal(read(DEFAULT_BASELINE_TTL_MS).key, key);
  assert.equal(read(DEFAULT_BASELINE_TTL_MS + 1), null);
  assert.equal(read(0, 0).key, key);
  for (const age of [-1, 1, NaN]) assert.equal(read(age, 0), null);
});

test('missing, corrupt, mismatched and malformed cache entries are misses', t => {
  const { dir, file } = fixture(t);
  mkdirSync(dir);
  const read = () => readBaselineCache(dir, key, { now: () => record.recordedAt });
  assert.equal(read(), null);
  const good = { ...record, schema: BASELINE_SCHEMA, key };
  for (const value of ['{', 'null', ...[{ key: 'other' }, { schema: 'v0' }, { failedTests: 'oops' },
    { failedTests: [''] }, { recordedAt: 'unknown' }].map(change => JSON.stringify({ ...good, ...change }))]) {
    writeFileSync(file, value);
    assert.equal(read(), null);
  }
});

test('both operations enforce key, worktree and symlink boundaries before use', t => {
  const { dir, worktree, root, file } = fixture(t);
  const operations = [
    (d, k) => readBaselineCache(d, k, { worktree }),
    (d, k) => writeBaselineCache(d, k, record, { worktree }),
  ];
  const alias = join(root, 'alias');
  symlinkSync(worktree, alias);
  mkdirSync(dir);
  symlinkSync(join(worktree, 'nonexistent'), file);
  for (const op of operations) {
    for (const invalid of ['../escape', 'g'.repeat(64), 'a'.repeat(63), null]) {
      assert.throws(() => op(dir, invalid), /baseline_key_invalid/);
    }
    for (const d of [worktree, join(worktree, 'cache')]) assert.throws(() => op(d, key), /baseline_cache_inside_worktree/);
    for (const d of [alias, join(alias, 'nested'), dir]) assert.throws(() => op(d, key), /baseline_cache_symlink/);
  }
  assert.deepEqual(readdirSync(worktree), []);
});

const red = (...failedTests) => ({ ok: false, failedTests });
const green = { ok: true, failedTests: [] };

test('ratchet admits only known red failures and reports fixes; green candidates are clean in either mode', () => {
  const baseline = red('c', 'b', 'a');
  for (const [candidate, preexistingFailures, fixedFailures] of [
    [red('c', 'a', 'b', 'a'), ['a', 'b', 'c'], []], [red('c'), ['c'], ['a', 'b']],
  ]) {
    assert.deepEqual(compareAgainstBaseline(baseline, candidate),
      { status: 'preexisting_red', ok: true, newFailures: [], preexistingFailures, fixedFailures });
  }
  for (const mode of ['ratchet', 'strict']) assert.deepEqual(compareAgainstBaseline(baseline, green, { mode }),
    { status: 'clean', ok: true, newFailures: [], preexistingFailures: [], fixedFailures: ['a', 'b', 'c'] });
});

test('strict never waives red; ratchet fails closed on regressions, missing evidence and crashes', () => {
  for (const [baseline, candidate, newFailures, preexistingFailures, fixedFailures, mode] of [
    [red('z', 'a'), red('b', 'a', 'c'), ['b', 'c'], ['a'], ['z']],
    [green, red('a'), ['a'], [], []], [null, red('b', 'a'), ['a', 'b'], [], []],
    [red(), red(), [], [], []], [red('a'), red(), [], [], ['a']], [red('a'), null, [], [], ['a']],
    [red('a'), { ok: false, failedTests: 'a' }, [], [], ['a']],
    [red('a'), red('a'), [], ['a'], [], 'strict'],
  ]) assert.deepEqual(compareAgainstBaseline(baseline, candidate, { mode }),
    { status: 'regressed', ok: false, newFailures, preexistingFailures, fixedFailures });
  assert.throws(() => compareAgainstBaseline(null, green, { mode: 'permissive' }), /baseline_mode_invalid/);
});
