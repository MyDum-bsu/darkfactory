import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactVerdict } from './stage-verifier.mjs';
import { isNonTargetFailure, isTargetFailure, isTestFilePath, verifyTestFirst } from './test-first-adapter.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(cwd, title) {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', title);
  return git(cwd, 'rev-parse', 'HEAD');
}

async function repo(t) {
  const dir = await mkdtemp(join(tmpdir(), 'df-test-first-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  await writeFile(join(dir, 'prod.mjs'), 'export const f = () => 1;\n');
  const baseSha = commit(dir, 'base');
  return { dir, baseSha };
}

test('isTestFilePath / isNonTargetFailure', () => {
  for (const yes of ['a.test.mjs', 'tests/foo.mjs', 'test/unit.mjs', '__tests__/x.js',
    'pkg/test_thing.py', 'src/foo_spec.py', 'x.spec.ts']) {
    assert.ok(isTestFilePath(yes), yes);
  }
  for (const no of ['prod.mjs', 'src/util.js', '../evil.test.mjs', '/abs.test.mjs', 'contest.mjs']) {
    assert.ok(!isTestFilePath(no), no);
  }
  assert.ok(isNonTargetFailure('SyntaxError: bad', 1));
  assert.ok(isNonTargetFailure('Cannot find module x', 1));
  assert.ok(isNonTargetFailure('ModuleNotFoundError', 1));
  assert.ok(isNonTargetFailure('', 126));
  // Авария раннера (SIGSEGV → 139) и прочие коды >= 125 — нецелевое падение.
  assert.ok(isNonTargetFailure('', 139));
  assert.ok(isNonTargetFailure('Segmentation fault', 139));
  assert.ok(isNonTargetFailure('', 130));
  assert.ok(!isNonTargetFailure('assert failed: expected 2 got 1', 1));
  assert.ok(!isNonTargetFailure('2 failures', 2));
  // Позитивное доказательство: код 1 без маркера тестового падения — non-target.
  assert.ok(!isTargetFailure('', 1));
  assert.ok(!isTargetFailure('config error: no such file', 1));
  assert.ok(isTargetFailure('assert failed: expected 2 got 1', 1));
  assert.ok(isTargetFailure('1 failed, 3 passed', 1));
  assert.ok(isTargetFailure('FAIL tests/f.test.mjs', 1));
  assert.ok(!isTargetFailure('1 failed', 139));
});

test('verifyTestFirst: red→green pass with valid artifact', async t => {
  const { dir, baseSha } = await repo(t);
  await mkdir(join(dir, 'tests'));
  await writeFile(join(dir, 'tests/f.test.mjs'), 'assert.equal(f(), 2)\n');
  const redSha = commit(dir, 'red test');
  await writeFile(join(dir, 'prod.mjs'), 'export const f = () => 2;\n');
  const candidateSha = commit(dir, 'impl');
  const runTest = async ({ sha }) => sha === redSha
    ? { exitCode: 1, output: 'assert failed: expected 2 got 1' }
    : { exitCode: 0, output: 'ok' };
  const result = await verifyTestFirst({ worktree: dir, baseSha, redSha, candidateSha, runTest });
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.changedTestFiles, ['tests/f.test.mjs']);
  assert.equal(result.artifact.type, 'test-first');
  assert.equal(result.artifact.touchesProdCode, false);
  assert.equal(artifactVerdict('test-first', result.artifactBytes), 'PASS');
});

test('verifyTestFirst: mutants — green red, prod code in red, import failure', async t => {
  const { dir, baseSha } = await repo(t);
  await mkdir(join(dir, 'tests'));
  await writeFile(join(dir, 'tests/f.test.mjs'), 'assert.ok(true)\n');
  const redSha = commit(dir, 'red test');
  await writeFile(join(dir, 'prod.mjs'), 'export const f = () => 2;\n');
  const candidateSha = commit(dir, 'impl');
  // Тест-пустышка: красный прогон зелёный.
  let r = await verifyTestFirst({ worktree: dir, baseSha, redSha, candidateSha,
    runTest: async () => ({ exitCode: 0, output: 'ok' }) });
  assert.equal(r.verdict, 'REWORK');
  assert.equal(r.reason, 'test_first_red_passed');
  // Ошибка импорта/синтаксиса в красном — нецелевое падение.
  r = await verifyTestFirst({ worktree: dir, baseSha, redSha, candidateSha,
    runTest: async ({ sha }) => sha === redSha
      ? { exitCode: 1, output: 'SyntaxError: unexpected token' } : { exitCode: 0, output: 'ok' } });
  assert.equal(r.reason, 'test_first_non_target_failure');
  // Кандидат не зелёный.
  r = await verifyTestFirst({ worktree: dir, baseSha, redSha, candidateSha,
    runTest: async () => ({ exitCode: 1, output: 'assert failed' }) });
  assert.equal(r.reason, 'test_first_candidate_failed');
});

test('verifyTestFirst: prod code inside red commit → rework', async t => {
  const { dir, baseSha } = await repo(t);
  await mkdir(join(dir, 'tests'));
  await writeFile(join(dir, 'tests/f.test.mjs'), 'assert.equal(f(),2)\n');
  await writeFile(join(dir, 'prod.mjs'), 'export const f = () => 2;\n');
  const redSha = commit(dir, 'red+prod');
  const candidateSha = commit(dir, 'more');
  const r = await verifyTestFirst({ worktree: dir, baseSha, redSha, candidateSha,
    runTest: async () => ({ exitCode: 0, output: 'ok' }) });
  assert.equal(r.verdict, 'REWORK');
  assert.equal(r.reason, 'test_first_touches_prod_code');
  assert.equal(r.artifact.touchesProdCode, true);
});

test('verifyTestFirst: ancestry and sha validation fail-closed', async t => {
  const { dir, baseSha } = await repo(t);
  const other = await repo(t);
  const sha = 'a'.repeat(40);
  for (const args of [
    { baseSha: 'xyz', redSha: sha, candidateSha: 'b'.repeat(40) },
    { baseSha, redSha: sha.slice(0, 39), candidateSha: 'b'.repeat(40) },
    { baseSha, redSha: sha, candidateSha: sha },
    { baseSha, redSha: other.baseSha, candidateSha: 'b'.repeat(40) },
  ]) {
    await assert.rejects(verifyTestFirst({ worktree: dir, runTest: async () => ({}), ...args }),
      /test_first_ancestry_invalid/);
  }
});

test('stage-verifier: four new verifiers PASS/REWORK', () => {
  const h = 'a'.repeat(64);
  const s40 = 'b'.repeat(40);
  const verdict = (type, fields) =>
    artifactVerdict(type, Buffer.from(JSON.stringify({ type, ...fields })));
  assert.equal(verdict('test-first', { redSha: s40, testDiff: h, redExitCode: 1,
    failureReasonDigest: h, touchesProdCode: false, candidateExitCode: 0 }), 'PASS');
  assert.equal(verdict('test-first', { redSha: s40, testDiff: h, redExitCode: 0,
    failureReasonDigest: h, touchesProdCode: false, candidateExitCode: 0 }), 'REWORK');
  assert.equal(verdict('test-first', { redSha: s40, testDiff: h, redExitCode: 127,
    failureReasonDigest: h, touchesProdCode: false, candidateExitCode: 0 }), 'REWORK');
  assert.equal(verdict('test-first', { redSha: s40, testDiff: h, redExitCode: 139,
    failureReasonDigest: h, touchesProdCode: false, candidateExitCode: 0 }), 'REWORK');
  assert.equal(verdict('test-first', { redSha: s40, testDiff: h, redExitCode: 1,
    failureReasonDigest: h, touchesProdCode: true, candidateExitCode: 0 }), 'REWORK');
  // Красный кандидат: артефакт не верифицируется зелёным — ни с реальным
  // кодом выхода, ни когда прогон кандидата не выполнялся (null).
  assert.equal(verdict('test-first', { redSha: s40, testDiff: h, redExitCode: 1,
    failureReasonDigest: h, touchesProdCode: false, candidateExitCode: 1 }), 'REWORK');
  assert.equal(verdict('test-first', { redSha: s40, testDiff: h, redExitCode: 1,
    failureReasonDigest: h, touchesProdCode: false, candidateExitCode: null }), 'REWORK');
  assert.equal(verdict('semantic-fidelity', { specDigest: h, goalsFrozen: true,
    vacuousRisk: 0, unprovenAssumptions: 0, controlsPassed: 2 }), 'PASS');
  assert.equal(verdict('semantic-fidelity', { specDigest: h, goalsFrozen: false,
    vacuousRisk: 0, unprovenAssumptions: 0, controlsPassed: 2 }), 'REWORK');
  assert.equal(verdict('semantic-fidelity', { specDigest: h, goalsFrozen: true,
    vacuousRisk: 1, unprovenAssumptions: 0, controlsPassed: 2 }), 'REWORK');
  const ok = { capture: h, viewports: 2, consoleErrors: 0, a11yViolations: 0, unstyledControls: 0,
    uncollapsedLongLists: 0, missingStates: 0, holdoutFailures: 0, satisfactionScore: 90 };
  assert.equal(verdict('satisfaction-report', ok), 'PASS');
  assert.equal(verdict('satisfaction-report', { ...ok, satisfactionScore: 84 }), 'REWORK');
  assert.equal(verdict('satisfaction-report', { ...ok, viewports: 1 }), 'REWORK');
  assert.equal(verdict('satisfaction-report', { ...ok, missingStates: 1 }), 'REWORK');
  assert.equal(verdict('guide-pack', { guideDigest: h, packDigest: h, guidesChecked: 3,
    missingSections: 0, brokenLinks: 0 }), 'PASS');
  assert.equal(verdict('guide-pack', { guideDigest: h, packDigest: h, guidesChecked: 3,
    missingSections: 1, brokenLinks: 0 }), 'REWORK');
  assert.equal(verdict('guide-pack', { guideDigest: h, packDigest: h, guidesChecked: 3,
    missingSections: 0, brokenLinks: 2 }), 'REWORK');
});

test('red run: TAP not ok от TypeError в setup — non-target crash, не целевое падение', () => {
  // node --test падает в top-level setup до ассерта: exit 1 + 'not ok' без
  // доказанного провала ассерта — JS runtime crash отклоняется.
  const tapCrash = [
    'TAP version 13',
    'not ok 1 - tests/f.test.mjs',
    '  ---',
    '  duration_ms: 12.3',
    '  failureType: testCodeFailure',
    '  error: TypeError: suite.setup is not a function',
    '    at file:///repo/tests/f.test.mjs:4:9',
    '  ...',
  ].join('\n');
  assert.ok(isNonTargetFailure(tapCrash, 1));
  assert.ok(!isTargetFailure(tapCrash, 1));
  // Прочие runtime-краши (не TypeError) — тоже non-target.
  assert.ok(isNonTargetFailure('not ok 1\n  error: RangeError: Maximum call stack', 1));
  assert.ok(!isTargetFailure('not ok 1\n  error: RangeError: Maximum call stack', 1));
  // Реальное падение ассерта по-прежнему целевое: AssertionError — не crash.
  const tapAssert = [
    'not ok 1 - tests/f.test.mjs',
    "  error: 'expected 2, got 1'",
    "  code: 'ERR_ASSERTION'",
  ].join('\n');
  assert.ok(!isNonTargetFailure(tapAssert, 1));
  assert.ok(isTargetFailure(tapAssert, 1));
});

test('verifyTestFirst: red diff над путём с пробелом парсится по \0', async t => {
  const { dir, baseSha } = await repo(t);
  await mkdir(join(dir, 'tests'));
  const spaced = 'tests/my case.test.mjs';
  await writeFile(join(dir, spaced), 'assert.equal(f(), 2)\n');
  const redSha = commit(dir, 'red test with space in path');
  await writeFile(join(dir, 'prod.mjs'), 'export const f = () => 2;\n');
  const candidateSha = commit(dir, 'impl');
  const runTest = async ({ sha }) => sha === redSha
    ? { exitCode: 1, output: 'assert failed: expected 2 got 1' }
    : { exitCode: 0, output: 'ok' };
  const result = await verifyTestFirst({ worktree: dir, baseSha, redSha, candidateSha, runTest });
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.changedTestFiles, [spaced]);
});
