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

test('удаление driver.py и изменение runtime assert вне тестов не являются assertion_weakened', async () => {
  const res = await gate({
    base: {
      'fixture-app/src/fixture_app/driver.py': 'def old_driver(value):\n    assert value > 0\n    return value\n',
      'src/runtime.js': 'assert(value >= 10);\n',
    },
    candidate: {
      'fixture-app/src/fixture_app/driver.py': null,
      'src/runtime.js': 'assert(value >= 0);\nassert(true);\n',
    },
  });
  assert.deepEqual(res.violations, []);
});

test('разрешение переименования теста не разрешает ослабление его проверок', async () => {
  const lines = 'export const unchanged = 1;\n'.repeat(12);
  const result = await gate({
    base: { 'tests/invariant.mjs': `${lines}assert(value >= 10);\n` },
    candidate: { 'tests/invariant.mjs': null, 'src/invariant.mjs': `${lines}assert(value >= 0);\n` },
  }, { allowTestDeletion: true });
  assert.ok(result.violations.some(v => v.kind === 'assertion_weakened' && v.file === 'src/invariant.mjs'));
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
      'src/lib.test.js': 'assert(typeof x === "number");\nassert(x > 0);\nexport const x = 1;\n',
      'package.json': '{"scripts":{"test":"node --test"}}\n',
    },
    candidate: {
      'src/lib.test.js': 'export const x = 1;\n',
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
      'src/lib.test.js': 'assert.strictEqual(x, 1);\nexport const x = 1;\n',
      'package.json': '{"scripts":{"test":"node --test tests/"}}\n',
    },
    candidate: {
      'src/lib.test.js': 'assert.strictEqual(x, 1);\nassert(true);\nexport const x = 1;\n',
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
    base: { 'src/lib.test.js': 'assert.strictEqual(x, 1);\nassert(x > 0);\nexport const x = 1;\n' },
    candidate: { 'src/lib.test.js': 'assert(x);\nassert(y);\nexport const x = 1;\n' },
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
    base: { 'src/lib.test.js': 'assert(x === 1);\n// assert(y === 2);\nexport const x = 1;\n' },
    candidate: { 'src/lib.test.js': 'assert(x === 1);\nexport const x = 1;\n' },
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
    base: { 'src/lib.test.js': 'assert(value >= 10);\nexport const x = 1;\n' },
    candidate: { 'src/lib.test.js': 'assert(value >= 0);\nexport const x = 1;\n' },
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
    base: { 'src/lib.test.js': 'assert(x >= 1);\nassert(y >= 10);\nexport const z = 1;\n' },
    candidate: { 'src/lib.test.js': 'assert(x >= 2);\nassert(y >= 11);\nexport const z = 1;\n' },
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
    base: { 'src/lib.test.js': 'assert(x >= 1 && y >= 10);\nexport const z = 1;\n' },
    candidate: { 'src/lib.test.js': 'assert(x >= 2 && y >= 0);\nexport const z = 1;\n' },
  });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.kind === 'assertion_weakened'), JSON.stringify(res.violations));
});

test('ослабление операнда после && против одиночного assert — отказ', async () => {
  const res = await gate({
    base: { 'src/lib.test.js': 'assert(y >= 10);\nexport const z = 1;\n' },
    candidate: { 'src/lib.test.js': 'assert(x >= 1 && y >= 0);\nexport const z = 1;\n' },
  });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.kind === 'assertion_weakened'), JSON.stringify(res.violations));
});

test('AUDIT-0c: не-test prose it (see below) не считается удалением теста', async () => {
  const res = await gate({
    base: { 'docs/guide.md': 'it (see below)\n' },
    candidate: { 'docs/guide.md': 'see below\n' },
  });
  assert.equal(res.ok, true, JSON.stringify(res.violations));
  assert.equal(res.violations.some((v) => v.kind === 'test_deleted'), false);

  const underTestsDir = await gate({
    base: { 'tests/README.md': 'it (see below)\n' },
    candidate: { 'tests/README.md': 'see below\n' },
  });
  assert.equal(underTestsDir.violations.some((v) => v.kind === 'test_deleted'), false,
    JSON.stringify(underTestsDir.violations));

  const commentedOut = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {});\n// test("old", () => {});\n' },
    candidate: { 'tests/app.test.js': 'test("a", () => {});\n' },
  });
  assert.equal(commentedOut.violations.some((v) => v.kind === 'test_deleted'), false,
    JSON.stringify(commentedOut.violations));
});

test('AUDIT-0c: переименование title, async callback и перемещение кейса не test_deleted', async () => {
  const rename = await gate({
    base: { 'tests/app.test.js': 'test("old title", () => {});\n' },
    candidate: { 'tests/app.test.js': 'test("new title", () => {});\n' },
  });
  assert.equal(rename.violations.some((v) => v.kind === 'test_deleted'), false,
    JSON.stringify(rename.violations));

  const asyncEdit = await gate({
    base: { 'tests/app.test.js': 'test("case", () => {});\n' },
    candidate: { 'tests/app.test.js': 'test("case", async () => {});\n' },
  });
  assert.equal(asyncEdit.violations.some((v) => v.kind === 'test_deleted'), false,
    JSON.stringify(asyncEdit.violations));

  const moved = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {});\ntest("b", () => {});\n' },
    candidate: { 'tests/app.test.js': 'test("b", () => {});\ntest("a", () => {});\n' },
  });
  assert.equal(moved.violations.some((v) => v.kind === 'test_deleted'), false,
    JSON.stringify(moved.violations));
});

test('AUDIT-0c: фактическое net deletion тестов по-прежнему отклоняется', async () => {
  const res = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {});\ntest("b", () => {});\n' },
    candidate: { 'tests/app.test.js': 'test("a", () => {});\n' },
  });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.kind === 'test_deleted'), JSON.stringify(res.violations));
});

test('AUDIT-0c: расширенные skip/only маркеры отклоняются', async () => {
  for (const [name, file, line] of [
    ['xit', 'tests/xit.test.js', 'x' + 'it("off", () => {});\n'],
    ['xtest', 'tests/xtest.test.js', 'x' + 'test("off", () => {});\n'],
    ['xdescribe', 'tests/xdescribe.test.js', 'x' + 'describe("off", () => {});\n'],
    ['fit', 'tests/fit.test.js', 'f' + 'it("focus", () => {});\n'],
    ['fdescribe', 'tests/fdescribe.test.js', 'f' + 'describe("focus", () => {});\n'],
    ['skip option', 'tests/option.test.js', 'test("off", { skip' + ': true }, () => {});\n'],
    ['only option', 'tests/only.test.js', 'test("focus", { only' + ': true }, () => {});\n'],
    ['test.todo', 'tests/todo.test.js', 'test.' + 'todo("later");\n'],
    ['t.skip', 'tests/tskip.test.js', 'test("off", (t) => {\n  t.' + 'skip();\n});\n'],
    ['pytest.skip', 'tests/py_test.py', 'def test_off():\n    pytest.' + 'skip("off")\n'],
  ]) {
    const res = await gate({
      base: { 'tests/base.test.js': 'test("base", () => {});\n' },
      candidate: {
        'tests/base.test.js': 'test("base", () => {});\n',
        [file]: line,
      },
    });
    assert.equal(res.ok, false, name);
    assert.ok(res.violations.some((v) => v.kind === 'test_skipped'),
      `${name}: ${JSON.stringify(res.violations)}`);
  }
});

test('AUDIT-0c: || true внутри assertion — assertion_weakened', async () => {
  const res = await gate({
    base: { 'tests/app.test.js': 'assert(value >= 10);\n' },
    candidate: { 'tests/app.test.js': 'assert(value >= 10 |' + '| true);\n' },
  });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.kind === 'assertion_weakened'),
    JSON.stringify(res.violations));
});

test('AUDIT-0c: block-comment suppression и early return в test hunk отклоняются', async () => {
  const commented = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {\n  assert(x === 1);\n});\n' },
    candidate: { 'tests/app.test.js': '/' + '*\ntest("a", () => {\n  assert(x === 1);\n});\n*/\n' },
  });
  assert.ok(commented.violations.some((v) => v.kind === 'assertion_weakened'),
    JSON.stringify(commented.violations));

  const earlyReturn = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {\n  assert(x === 1);\n});\n' },
    candidate: { 'tests/app.test.js': 'test("a", () => {\n  ret' + 'urn;\n  assert(x === 1);\n});\n' },
  });
  assert.ok(earlyReturn.violations.some((v) => v.kind === 'assertion_weakened'),
    JSON.stringify(earlyReturn.violations));
});

test('AUDIT-0c: comment-only node -e и удаление runner executable — gate_bypass', async () => {
  const commentOnly = await gate({
    base: { 'package.json': '{"scripts":{"test":"node --test"}}\n' },
    candidate: { 'package.json': '{"scripts":{"test":"node -e \'/* test */\'"}}\n' },
  });
  assert.equal(commentOnly.ok, false);
  assert.ok(commentOnly.violations.some((v) => v.kind === 'gate_bypass'),
    JSON.stringify(commentOnly.violations));

  for (const [name, script] of [
    ['runner name inside eval string', 'node -e \'console.log(\\\"jest\\\")\''],
    ['bare eval identifier', 'node -e \'jest\''],
  ]) {
    const stripped = await gate({
      base: { 'package.json': '{"scripts":{"test":"jest --coverage"}}\n' },
      candidate: { 'package.json': `{"scripts":{"test":"${script}"}}\n` },
    });
    assert.equal(stripped.ok, false, name);
    assert.ok(stripped.violations.some((v) => v.kind === 'gate_bypass'),
      `${name}: ${JSON.stringify(stripped.violations)}`);
  }
});

test('AUDIT-0c regression: .fit()-метод и конфиг skip вне тестов — не test_skipped', async () => {
  const res = await gate({
    base: { 'src/model.js': 'export const x = 1;\n' },
    candidate: {
      'src/model.js': 'export const x = 1;\n' +
        'export const r = model.fit(data);\n' +
        'export const cfg = { skip' + ': true, retries: 2 };\n' +
        'export const alt = { only' + ': true };\n',
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res.violations));
  assert.deepEqual(res.violations, []);
});

test('WAVE2-5a: удаление тест-файла с assert — test_file_deleted и assertion_weakened по умолчанию', async () => {
  const res = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {\n  assert(x === 1);\n});\n' },
    candidate: { 'tests/app.test.js': null },
  });
  assert.equal(res.ok, false);
  const kinds = res.violations.map((v) => v.kind);
  assert.ok(kinds.includes('test_file_deleted'), JSON.stringify(res.violations));
  assert.ok(kinds.includes('assertion_weakened'), JSON.stringify(res.violations));
});

test('WAVE2-5a: удаление тест-файла с assert проходит чисто при allowTestDeletion: true', async () => {
  const res = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {\n  assert(x === 1);\n  assert(y >= 2);\n});\n' },
    candidate: { 'tests/app.test.js': null },
  }, { allowTestDeletion: true });
  assert.equal(res.ok, true, JSON.stringify(res.violations));
  assert.equal(res.violations.length, 0, JSON.stringify(res.violations));
});

test('WAVE2-5a: ослабление assert в изменённом (не удалённом) тест-файле отклоняется даже при allowTestDeletion: true', async () => {
  const res = await gate({
    base: { 'tests/app.test.js': 'assert(x === 1);\nassert(y === 2);\nexport const z = 1;\n' },
    candidate: { 'tests/app.test.js': 'export const z = 1;\n' },
  }, { allowTestDeletion: true });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.kind === 'assertion_weakened'), JSON.stringify(res.violations));
});

test('AUDIT-0c regression: .fit()/.xit() методы в тестовом файле — не фокусировка', async () => {
  const res = await gate({
    base: { 'tests/ml.test.js': 'test("a", () => {});\n' },
    candidate: {
      'tests/ml.test.js': 'test("a", () => {});\n' +
        'const r = model.fit(data);\n' +
        'obj.xit(1, 2);\n' +
        'pipe.fdescribe(run);\n',
    },
  });
  assert.deepEqual(res.violations.filter((v) => v.kind === 'test_skipped'), [],
    JSON.stringify(res.violations));
  // Контроль: глобальный fit(...) в тестовом файле по-прежнему отклоняется.
  const focus = await gate({
    base: { 'tests/ml.test.js': 'test("a", () => {});\n' },
    candidate: {
      'tests/ml.test.js': 'test("a", () => {});\n' + 'f' + 'it("focus", () => {});\n',
    },
  });
  assert.ok(focus.violations.some((v) => v.kind === 'test_skipped'),
    JSON.stringify(focus.violations));
});

// --- v2.0 cross-review: ужесточение tamper-gate ------------------------------

const syntheticDiff = (minusLines, plusLines, file = 'tests/app.test.js') => {
  const body = [];
  if (minusLines.length) {
    body.push(`@@ -1,${minusLines.length} +0,0 @@`);
    for (const line of minusLines) body.push(`-${line}`);
  }
  if (plusLines.length) {
    body.push(`@@ -0,0 +1,${plusLines.length} @@`);
    for (const line of plusLines) body.push(`+${line}`);
  }
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${body.join('\n')}\n`;
};

test('v2: блочный комментарий внутри строкового литерала не маскирует удалённые тесты', () => {
  const diff = 'diff --git a/tests/app.test.js b/tests/app.test.js\n' +
    '--- a/tests/app.test.js\n+++ b/tests/app.test.js\n' +
    '@@ -1,3 +0,0 @@\n' +
    '-const s = "/' + '*";\n' +
    '-test("b", () => {});\n' +
    '-assert(x === 1);\n';
  const violations = analyzeDiff(diff);
  assert.ok(violations.some((v) => v.kind === 'test_deleted'),
    JSON.stringify(violations));
  assert.ok(violations.some((v) => v.kind === 'assertion_weakened'),
    JSON.stringify(violations));
});

test('v2: состояние блочного комментария сбрасывается на каждом hunk header', () => {
  // Открывающий комментарий первого hunk'а не должен маскировать удаления второго.
  const diff = 'diff --git a/tests/app.test.js b/tests/app.test.js\n' +
    '--- a/tests/app.test.js\n+++ b/tests/app.test.js\n' +
    '@@ -1,1 +0,0 @@\n' +
    '-/' + '*\n' +
    '@@ -10,1 +9,0 @@\n' +
    '-test("b", () => {});\n';
  const violations = analyzeDiff(diff);
  assert.ok(violations.some((v) => v.kind === 'test_deleted'),
    JSON.stringify(violations));
});

test('v2: реальный блочный комментарий внутри одного hunk по-прежнему скрывает проверки', () => {
  // Строка внутри настоящего блочного комментария — не действующая проверка:
  // удаление закомментированной проверки не считается ослаблением.
  const res = analyzeDiff(syntheticDiff([
    '/' + '*',
    'assert(y === 2);',
    '*' + '/',
    'assert(x === 1);',
  ], ['assert(x === 1);'], 'src/lib.test.js'));
  assert.deepEqual(res, [], JSON.stringify(res));
});

test('v2: ранний return с литералом/undefined в тестовом hunk отклоняется', async () => {
  for (const [name, line] of [
    ['literal zero return', 'ret' + 'urn 0;'],
    ['literal true return', 'ret' + 'urn true;'],
    ['literal null return', 'ret' + 'urn null;'],
    ['undefined return', 'ret' + 'urn undefined;'],
    ['bare return', 'ret' + 'urn;'],
    ['process exit zero', 'process.' + 'exit(0);'],
    ['process exit zero spaced', 'process.' + 'exit( 0 );'],
    ['dead branch false', 'if ' + '(false) {'],
    ['dead branch zero', 'if ' + '(0) {'],
  ]) {
    const violations = analyzeDiff(syntheticDiff([], [line]));
    assert.ok(violations.some((v) => v.kind === 'assertion_weakened'),
      `${name}: ${JSON.stringify(violations)}`);
  }
  // Контроль: обычный возврат значения и код вне тестов — не нарушение.
  assert.deepEqual(analyzeDiff(syntheticDiff([], ['ret' + 'urn value;'])), []);
  assert.deepEqual(analyzeDiff(syntheticDiff([], ['ret' + 'urn false;'])), []);
  assert.deepEqual(analyzeDiff(syntheticDiff([], ['ret' + 'urn 0;'], 'src/app.js')), []);
  assert.deepEqual(analyzeDiff(syntheticDiff([], ['process.' + 'exit(0);'], 'src/app.js')), []);
  assert.deepEqual(analyzeDiff(syntheticDiff([], ['if ' + '(false) {'], 'src/app.js')), []);
  assert.deepEqual(analyzeDiff(syntheticDiff([], ['process.' + 'exit(1);'])), []);
});

test('v2: тавтологии идентичных литералов в тестовом hunk отклоняются', () => {
  for (const line of [
    'ass' + 'ert.strictEqual(1, 1);',
    'ass' + 'ert.equal("a", "a");',
    'ass' + "ert.equal('a', \"a\");",
    'ass' + 'ert.deepEqual(true, true);',
    'ass' + 'ert.strictEqual(null, null);',
    'exp' + 'ect(1).toBe(1);',
    'exp' + 'ect("x").toBe("x");',
    'exp' + 'ect(0.5).toEqual(0.5);',
  ]) {
    const violations = analyzeDiff(syntheticDiff([], [line]));
    assert.ok(violations.some((v) => v.kind === 'assertion_weakened' &&
      v.detail.includes('identical-literal')),
      `${line}: ${JSON.stringify(violations)}`);
  }
  // Контроль: содержательные проверки — не тавтологии.
  for (const line of [
    'assert.strictEqual(x, 1);',
    'assert.strictEqual(1, 2);',
    'assert.equal("a", "b");',
    'expect(count).toBe(1);',
    'expect(1).toBe(2);',
  ]) {
    const violations = analyzeDiff(syntheticDiff([], [line]));
    assert.equal(violations.filter((v) => v.detail?.includes('identical-literal')).length,
      0, `${line}: ${JSON.stringify(violations)}`);
  }
});

test('v2: добавленные test-filter флаги в scripts.test* — gate_bypass', async () => {
  for (const [name, script] of [
    ['--test-name-pattern', 'node --test --test-name-pattern=smoke'],
    ['--test-name-pattern split', 'node --test --test-name-pattern smoke'],
    ['--grep', 'jest --grep happy'],
    ['-k', 'pytest -k smoke'],
    ['-t', 'vitest -t smoke'],
    ['--skip', 'node --test --skip=slow'],
    ['filter in test:unit key', 'node --test --test-name-pattern=x'],
  ]) {
    const key = name === 'filter in test:unit key' ? 'test:unit' : 'test';
    const base = { 'package.json': `{"scripts":{"${key}":"node --test"}}\n` };
    const candidate = { 'package.json': `{"scripts":{"${key}":"${script}"}}\n` };
    const res = await gate({ base, candidate });
    assert.equal(res.ok, false, name);
    assert.ok(res.violations.some((v) => v.kind === 'gate_bypass' &&
      v.detail.includes('filter')), `${name}: ${JSON.stringify(res.violations)}`);
  }
});

test('v2: неизменные/отсутствующие test-filter флаги — не нарушение', async () => {
  const unchanged = await gate({
    base: {
      'package.json': '{"scripts":{"test":"node --test --test-name-pattern=x"}}\n',
      'src/app.js': 'export const a = 1;\n',
    },
    candidate: {
      'package.json': '{"scripts":{"test":"node --test --test-name-pattern=x","lint":"echo ok"}}\n',
      'src/app.js': 'export const a = 2;\n',
    },
  });
  // package.json изменился (новый lint), но фильтры scripts.test не добавлены —
  // флаги были в base в том же виде.
  assert.equal(unchanged.ok, true, JSON.stringify(unchanged.violations));
  const plain = await gate({
    base: { 'package.json': '{"scripts":{"test":"node --test"}}\n' },
    candidate: { 'package.json': '{"scripts":{"test":"node --test tests/"}}\n' },
  });
  assert.equal(plain.ok, true, JSON.stringify(plain.violations));
});

test('v2: allowTestDeletion строго ограничен удалёнными файлами (status D)', async () => {
  // Изменённый (не удалённый) тестовый файл с удалённым кейсом — нарушение
  // даже при allowTestDeletion: true.
  const modified = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {});\ntest("b", () => {});\n' },
    candidate: { 'tests/app.test.js': 'test("a", () => {});\n' },
  }, { allowTestDeletion: true });
  assert.equal(modified.ok, false);
  assert.ok(modified.violations.some((v) => v.kind === 'test_deleted'),
    JSON.stringify(modified.violations));

  // Переименование теста вне discovery — нарушение даже при допуске.
  const repo = await mkdtemp(path.join(testRoot, 'repo-'));
  git(repo, 'init', '--initial-branch=pilot');
  await mkdir(path.join(repo, 'tests'));
  await writeFile(path.join(repo, 'tests/app.test.js'), 'test("a", () => {});\n');
  const base = commit(repo, 'Base');
  await mkdir(path.join(repo, 'src'));
  git(repo, 'mv', 'tests/app.test.js', 'src/app.js');
  const candidate = commit(repo, 'Rename');
  const renamed = await tamperGate(
    { worktree: repo, base_sha: base, candidate_sha: candidate },
    { allowTestDeletion: true });
  assert.equal(renamed.ok, false);
  assert.ok(renamed.violations.some((v) => v.kind === 'test_file_deleted'),
    JSON.stringify(renamed.violations));

  // Контроль: настоящее удаление файла со статусом D по-прежнему проходит.
  const deleted = await gate({
    base: { 'tests/app.test.js': 'test("a", () => {});\n' },
    candidate: { 'tests/app.test.js': null },
  }, { allowTestDeletion: true });
  assert.equal(deleted.ok, true, JSON.stringify(deleted.violations));
});
