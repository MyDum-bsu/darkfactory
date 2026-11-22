import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyzeDiff, tamperGate } from './tamper-gate.mjs';

const testRoot = await mkdtemp(path.join(tmpdir(), 'tamper-gate-tests-'));
process.on('exit', () => rm(testRoot, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, message) => {
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture',
    '-c', 'commit.gpgsign=false', 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};

async function fixture(files) {
  const repo = await mkdtemp(path.join(testRoot, 'repo-'));
  git(repo, 'init', '--initial-branch=pilot');
  const put = async (name, text) => {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), text);
  };
  for (const [name, text] of Object.entries(files.base)) await put(name, text);
  const base = commit(repo, 'Base');
  for (const [name, text] of Object.entries(files.candidate ?? {})) {
    if (text === null) {
      git(repo, 'rm', '-q', name);
    } else {
      await put(name, text);
    }
  }
  const candidate = commit(repo, 'Candidate');
  return { repo, base, candidate };
}

const gate = (files, profile) => fixture(files)
  .then(({ repo, base, candidate }) => tamperGate({ worktree: repo, base_sha: base, candidate_sha: candidate }, profile));

test('чистый дифф: новый код и новый тест проходят, digest стабилен', async () => {
  const res = await gate({
    base: { 'src/app.js': 'export const a = 1;\n' },
    candidate: {
      'src/app.js': 'export const a = 2;\n',
      'src/app.test.js': 'import test from "node:test";\ntest("a", () => {});\n',
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.violations, []);
  assert.equal(res.sha.length, 40);
  assert.match(res.digest, /^[0-9a-f]{64}$/);
  const again = analyzeDiff('');
  assert.deepEqual(again, []);
});

test('удаление тестового файла и тест-кейса отклоняются', async () => {
  const res = await gate({
    base: {
      'tests/app.test.js': 'test("a", () => {});\ntest("b", () => {});\n',
      'checks/util_test.py': 'def test_ok():\n    assert True\n',
    },
    candidate: {
      'tests/app.test.js': null,
      'checks/util_test.py': 'def helper():\n    return True\n',
    },
  });
  assert.equal(res.ok, false);
  const kinds = res.violations.map((v) => v.kind);
  assert.ok(kinds.includes('test_file_deleted'), JSON.stringify(res.violations));
  assert.ok(kinds.includes('test_deleted'), JSON.stringify(res.violations));
  for (const v of res.violations) {
    assert.ok(v.file && typeof v.line === 'number' && v.detail);
  }
});

test('удаление test() внутри обычного файла ловится, а не только в test-файлах', async () => {
  const res = await gate({
    base: { 'suite.mjs': 'test("keeps", () => {});\nexport const x = 1;\n' },
    candidate: { 'suite.mjs': 'export const x = 1;\n' },
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.violations.map((v) => v.kind), ['test_deleted']);
});

test('явный допуск allowTestDeletion пропускает удаление тестов', async () => {
  const res = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {});\n' },
    candidate: { 'tests/app.test.js': null },
  }, { allowTestDeletion: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.violations, []);
});

test('добавленные skip/only/xfail маркеры отклоняются', async () => {
  const res = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {});\n' },
    candidate: {
      'tests/app.test.js': 'test.skip("a", () => {});\nit.only("b", () => {});\n',
      'tests/py_test.py': '@pytest.mark.skip\ndef test_x():\n    pass\n',
      'tests/py2_test.py': '@pytest.mark.xfail\ndef test_y():\n    pass\n',
    },
  });
  assert.equal(res.ok, false);
  const skipped = res.violations.filter((v) => v.kind === 'test_skipped');
  assert.equal(skipped.length >= 4, true, JSON.stringify(skipped));
});

test('ослабление проверок: удалённые assert без замены и exit 0 в runner', async () => {
  const res = await gate({
    base: {
      'src/lib.js': 'assert(typeof x === "number");\nassert(x > 0);\nexport const x = 1;\n',
      'package.json': '{"scripts":{"test":"node --test"}}\n',
    },
    candidate: {
      'src/lib.js': 'export const x = 1;\n',
      'package.json': '{"scripts":{"test":"node --test || exit 0"}}\n',
    },
  });
  assert.equal(res.ok, false);
  const kinds = res.violations.map((v) => v.kind);
  assert.ok(kinds.includes('assertion_weakened'), JSON.stringify(res.violations));
  assert.ok(kinds.includes('gate_bypass'), JSON.stringify(res.violations));
});

test('утечка секретов в диффе отклоняется', async () => {
  for (const [name, line] of [
    ['github PAT', 'const t = "ghp_abcdefghijklmnopqrstuvwx";\n'],
    ['private key', '-----BEGIN PRIVATE KEY-----\n'],
    ['board token', 'BOARD_TOKEN=vb-secret-token\n'],
    ['aws key', 'const k = "AKIAIOSFODNN7EXAMPLE";\n'],
  ]) {
    const res = await gate({
      base: { 'src/app.js': 'export const a = 1;\n' },
      candidate: { 'src/app.js': `export const a = 1;\n${line}` },
    });
    assert.equal(res.ok, false, name);
    assert.equal(res.violations.some((v) => v.kind === 'secret_leak'), true,
      `${name}: ${JSON.stringify(res.violations)}`);
  }
});

test('добавленные test(/assert не считаются нарушением', async () => {
  const res = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {\n  assert(true);\n});\n' },
    candidate: { 'tests/app.test.js': 'test("a", () => {\n  assert(true);\n});\ntest("b", () => {\n  assert(true);\n});\n' },
  });
  assert.equal(res.ok, true);
});

test('невалидные входы отклоняются до вызова git', async () => {
  await assert.rejects(() => tamperGate({ worktree: '/tmp', base_sha: 'abc', candidate_sha: 'd'.repeat(40) }));
  await assert.rejects(() => tamperGate({ base_sha: 'a'.repeat(40), candidate_sha: 'b'.repeat(40) }));
});
