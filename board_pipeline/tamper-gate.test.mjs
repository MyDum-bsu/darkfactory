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
    candidate: { 'tests/app.test.js': 'test("a", () => {\n  assert(true);\n});\ntest("b", () => {\n  assert(x === 1);\n});\n' },
  });
  assert.equal(res.ok, true);
});

test('невалидные входы отклоняются до вызова git', async () => {
  await assert.rejects(() => tamperGate({ worktree: '/tmp', base_sha: 'abc', candidate_sha: 'd'.repeat(40) }));
  await assert.rejects(() => tamperGate({ base_sha: 'a'.repeat(40), candidate_sha: 'b'.repeat(40) }));
});

// --- Регрессии независимого ревью Pi/Sol ---

test('RegExp.test() и вызовы методов не считаются удалёнными тестами', async () => {
  const res = await gate({
    base: { 'src/re.js': 'const ok = /x/.test(s);\nre.test(other);\n' },
    candidate: { 'src/re.js': 'const ok = true;\n' },
  });
  assert.equal(res.ok, true, JSON.stringify(res.violations));
});

test('переименование теста за пределы discovery отклоняется', async () => {
  const repo = await mkdtemp(path.join(testRoot, 'repo-'));
  git(repo, 'init', '--initial-branch=pilot');
  await mkdir(path.join(repo, 'tests'));
  await writeFile(path.join(repo, 'tests/app.test.js'), 'test("a", () => {});\n');
  const base = commit(repo, 'Base');
  await mkdir(path.join(repo, 'src'));
  git(repo, 'mv', 'tests/app.test.js', 'src/app.js');
  const candidate = commit(repo, 'Rename');
  const res = await tamperGate({ worktree: repo, base_sha: base, candidate_sha: candidate });
  assert.equal(res.ok, false);
  const v = res.violations.find((x) => x.kind === 'test_file_deleted');
  assert.ok(v, JSON.stringify(res.violations));
  assert.equal(v.file, 'tests/app.test.js');
});

test('смена типа тестового файла на symlink отклоняется', async () => {
  const repo = await mkdtemp(path.join(testRoot, 'repo-'));
  git(repo, 'init', '--initial-branch=pilot');
  await mkdir(path.join(repo, 'tests'));
  await writeFile(path.join(repo, 'tests/app.test.js'), 'test("a", () => {});\n');
  const base = commit(repo, 'Base');
  const { symlink, rm: remove } = await import('node:fs/promises');
  await remove(path.join(repo, 'tests/app.test.js'));
  await symlink('../target.js', path.join(repo, 'tests/app.test.js'));
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=f@x', '-c', 'user.name=F', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Symlink');
  const candidate = git(repo, 'rev-parse', 'HEAD');
  const res = await tamperGate({ worktree: repo, base_sha: base, candidate_sha: candidate });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.kind === 'file_type_changed'), JSON.stringify(res.violations));
});

test('тривиальный assert(true) и подмена test-скрипта отклоняются', async () => {
  const res = await gate({
    base: {
      'src/lib.js': 'assert.strictEqual(x, 1);\nexport const x = 1;\n',
      'package.json': '{"scripts":{"test":"node --test tests/"}}\n',
    },
    candidate: {
      'src/lib.js': 'assert.strictEqual(x, 1);\nassert(true);\nexport const x = 1;\n',
      'package.json': '{"scripts":{"test":"echo done"}}\n',
    },
  });
  assert.equal(res.ok, false);
  const kinds = res.violations.map((v) => v.kind);
  assert.ok(kinds.includes('assertion_weakened'), JSON.stringify(res.violations));
  assert.ok(kinds.includes('gate_bypass'), JSON.stringify(res.violations));
});

test('файл без завершающего перевода строки не сдвигает номера нарушений', async () => {
  const res = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {});\ntest("b", () => {});' },
    candidate: { 'tests/app.test.js': 'test("a", () => {});' },
  });
  assert.equal(res.ok, false);
  const lines = res.violations.filter((x) => x.kind === 'test_deleted').map((x) => x.line);
  assert.deepEqual(lines, [1, 2], JSON.stringify(res.violations));
});

test('конфиг Git и .gitattributes кандидата не влияют на отчёт и не выполняются', async () => {
  const repo = await mkdtemp(path.join(testRoot, 'repo-'));
  git(repo, 'init', '--initial-branch=pilot');
  await writeFile(path.join(repo, 'app.js'), 'const a = 1;\n');
  const base = commit(repo, 'Base');
  // Враждебные атрибуты и diff-драйвер: при исполнении были бы командой кандидата.
  await writeFile(path.join(repo, '.gitattributes'), '*.secret diff=spy\n');
  await writeFile(path.join(repo, 'app.js'), 'const a = 2;\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=f@x', '-c', 'user.name=F', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Attrs');
  const candidate = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'config', 'diff.spy.command', 'echo PWNED >&2; cat');
  await writeFile(path.join(repo, 'x.secret'), 'data\n');
  const res = await tamperGate({ worktree: repo, base_sha: base, candidate_sha: candidate });
  assert.equal(res.ok, true);
  // Тот же вызов повторно даёт тот же digest — отчёт детерминирован.
  const again = await tamperGate({ worktree: repo, base_sha: base, candidate_sha: candidate });
  assert.equal(again.digest, res.digest);
});

test('атрибут -diff кандидата не прячет текстовый diff от гейта', async () => {
  const res = await gate({
    base: {
      'tests/app.test.js': 'test("a", () => {});\ntest("b", () => {});\n',
      '.gitattributes': '*.test.js -diff\n',
    },
    candidate: {
      'tests/app.test.js': 'test("a", () => {});\n',
      '.gitattributes': '*.test.js -diff\n',
    },
  });
  assert.equal(res.ok, false);
  const v = res.violations.find((x) => x.kind === 'test_deleted');
  assert.ok(v, JSON.stringify(res.violations));
  assert.equal(v.file, 'tests/app.test.js');
  assert.equal(v.line, 2);
});

test('удалённый бинарный тест-файл без текстового hunk фиксируется по метаданным', async () => {
  const repo = await mkdtemp(path.join(testRoot, 'repo-'));
  git(repo, 'init', '--initial-branch=pilot');
  await mkdir(path.join(repo, 'tests'));
  await writeFile(path.join(repo, 'tests/bin.test.js'), Buffer.from([0x00, 0x01, 0x02, 0xde, 0xad]));
  const base = commit(repo, 'Base');
  git(repo, 'rm', '-q', 'tests/bin.test.js');
  const candidate = commit(repo, 'Delete');
  const res = await tamperGate({ worktree: repo, base_sha: base, candidate_sha: candidate });
  assert.equal(res.ok, false);
  const v = res.violations.find((x) => x.kind === 'test_file_deleted');
  assert.ok(v, JSON.stringify(res.violations));
  assert.equal(v.file, 'tests/bin.test.js');
});

test('содержательный assert заменён слабым при том же числе строк — отказ', async () => {
  const res = await gate({
    base: { 'src/lib.js': 'assert.strictEqual(x, 1);\nassert(x > 0);\nexport const x = 1;\n' },
    candidate: { 'src/lib.js': 'assert(x);\nassert(y);\nexport const x = 1;\n' },
  });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.kind === 'assertion_weakened'), JSON.stringify(res.violations));
});

test('удалённый scripts.test в package.json — gate_bypass', async () => {
  const res = await gate({
    base: { 'package.json': '{"scripts":{"test":"node --test","lint":"echo ok"}}\n' },
    candidate: { 'package.json': '{"scripts":{"lint":"echo ok"}}\n' },
  });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.kind === 'gate_bypass'), JSON.stringify(res.violations));
});

test('удаление закомментированной проверки не считается ослаблением', async () => {
  const res = await gate({
    base: { 'src/lib.js': 'assert(x === 1);\n// assert(y === 2);\nexport const x = 1;\n' },
    candidate: { 'src/lib.js': 'assert(x === 1);\nexport const x = 1;\n' },
  });
  assert.equal(res.ok, true, JSON.stringify(res.violations));
});

test('локальный color.diff=always в .git/config не меняет нарушения и digest', async () => {
  const { repo, base, candidate } = await fixture({
    base: { 'tests/app.test.js': 'test("a", () => {});\ntest("b", () => {});\n' },
    candidate: { 'tests/app.test.js': 'test("a", () => {});\n' },
  });
  const binding = { worktree: repo, base_sha: base, candidate_sha: candidate };
  git(repo, 'config', 'color.diff', 'always');
  const colored = await tamperGate(binding);
  git(repo, 'config', 'color.diff', 'never');
  const plain = await tamperGate(binding);
  assert.equal(colored.ok, false);
  assert.ok(colored.violations.some((v) => v.kind === 'test_deleted'), JSON.stringify(colored.violations));
  assert.equal(colored.digest, plain.digest, 'digest одинаков при разном color.diff');
});

test('удаление пустого тест-файла с пробелом и " b/" в имени — точный путь', async () => {
  const res = await gate({
    base: { 'tests/dir b/empty': '' },
    candidate: { 'tests/dir b/empty': null },
  });
  assert.equal(res.ok, false);
  const v = res.violations.find((x) => x.kind === 'test_file_deleted');
  assert.ok(v, JSON.stringify(res.violations));
  assert.equal(v.file, 'tests/dir b/empty');
});

test('ослабление порога assert(>= 10) -> assert(>= 0) — отказ', async () => {
  const res = await gate({
    base: { 'src/lib.js': 'assert(value >= 10);\nexport const x = 1;\n' },
    candidate: { 'src/lib.js': 'assert(value >= 0);\nexport const x = 1;\n' },
  });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.kind === 'assertion_weakened'), JSON.stringify(res.violations));
});

test('scripts.test удалён на строке с metadata.test — gate_bypass по семантике JSON', async () => {
  const res = await gate({
    base: { 'package.json': '{"scripts":{"test":"node --test"},"metadata":{"test":"stay"}}\n' },
    candidate: { 'package.json': '{"scripts":{},"metadata":{"test":"stay"}}\n' },
  });
  assert.equal(res.ok, false);
  const v = res.violations.find((x) => x.kind === 'gate_bypass');
  assert.ok(v, JSON.stringify(res.violations));
  assert.match(v.detail, /scripts\.test/);
});

test('одновременное ужесточение разных assert — не ослабление', async () => {
  const res = await gate({
    base: { 'src/lib.js': 'assert(x >= 1);\nassert(y >= 10);\nexport const z = 1;\n' },
    candidate: { 'src/lib.js': 'assert(x >= 2);\nassert(y >= 11);\nexport const z = 1;\n' },
  });
  assert.equal(res.ok, true, JSON.stringify(res.violations));
});

test('неизменный scripts.test при смене metadata.test — не обход гейта', async () => {
  const res = await gate({
    base: { 'package.json': '{"scripts":{"test":"node ./checks.mjs"},"metadata":{"test":"a"}}\n' },
    candidate: { 'package.json': '{"scripts":{"test":"node ./checks.mjs"},"metadata":{"test":"b"}}\n' },
  });
  assert.equal(res.ok, true, JSON.stringify(res.violations));
});

test('ослабление второго операнда в составном assert — отказ', async () => {
  const res = await gate({
    base: { 'src/lib.js': 'assert(x >= 1 && y >= 10);\nexport const z = 1;\n' },
    candidate: { 'src/lib.js': 'assert(x >= 2 && y >= 0);\nexport const z = 1;\n' },
  });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.kind === 'assertion_weakened'), JSON.stringify(res.violations));
});

test('ослабление операнда после && против одиночного assert — отказ', async () => {
  const res = await gate({
    base: { 'src/lib.js': 'assert(y >= 10);\nexport const z = 1;\n' },
    candidate: { 'src/lib.js': 'assert(x >= 1 && y >= 0);\nexport const z = 1;\n' },
  });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.kind === 'assertion_weakened'), JSON.stringify(res.violations));
});
