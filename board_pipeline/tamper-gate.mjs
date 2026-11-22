// Детерминированный L1 tamper-gate: статический разбор `git diff base..candidate`.
// Код кандидата не выполняется. Гейт ловит до запуска L3/L2: удаление существующих
// тестовых файлов/кейсов без явного допуска профиля, добавление skip/only-маркеров,
// ослабление проверок, подмену test-runner'а и утечку секретов.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalDigest } from './subject.mjs';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;

// Файл считается тестовым по типичным каталогам и суффиксам JS/TS/Python.
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.py$/;
// Удалённое определение тестового кейса: JS/TS test(, it(, describe( и Python def test_.
const TEST_DEF = /\b(?:it|test|describe)\s*\(|\bdef\s+test_/;
// Маркеры отключения/фокусировки тестов на добавленной строке.
const SKIP_MARK = /\b(?:it|test|describe|context|xit|xtest)\s*\.\s*(?:skip|only)\s*\(|\.only\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)|@?unittest\.skip|@skip\b/;
// Проверки/утверждения: удаление без замены — ослабление гейта.
const ASSERT_MARK = /\bassert\b|\bexpect\s*\(|\.assert\w*\s*\(/;
// Файлы, из которых запускаются проверки: подмена `exit 0` объявляет красное зелёным.
const RUNNER_FILE = /(^|\/)(package\.json|Makefile|makefile|scripts?\/)|\.(?:ya?ml|sh|ps1|bat)$/;
const EXIT_OK = /\bexit\s+0\b/;

const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private_key'],
  [/ghp_[A-Za-z0-9]{20,}/, 'github_token'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'github_token'],
  [/sk-[A-Za-z0-9]{20,}/, 'api_key'],
  [/AKIA[0-9A-Z]{16}/, 'aws_access_key'],
  [/BOARD_TOKEN\s*=\s*\S+/, 'board_token'],
];

// Разбор unified=0 diff: считаем нарушения по добавленным/удалённым строкам.
// Возвращает стабильно отсортированный список { kind, file, line, detail }.
export function analyzeDiff(diff, { allowTestDeletion = false } = {}) {
  const violations = [];
  const asserts = new Map();
  let file = null;
  let oldName = null;
  let oldLine = 0;
  let newLine = 0;

  const push = (kind, line, detail) => violations.push({ kind, file, line, detail });
  const assertTally = (side, line) => {
    if (!ASSERT_MARK.test(side)) return null;
    const tally = asserts.get(file) ?? { removed: [], added: [] };
    asserts.set(file, tally);
    return tally;
  };

  for (const raw of String(diff).split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null;
      oldName = null;
      continue;
    }
    if (raw.startsWith('--- ')) {
      oldName = raw.slice(4).trim();
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const newName = raw.slice(4).trim();
      file = newName === '/dev/null'
        ? (typeof oldName === 'string' && oldName.startsWith('a/') ? oldName.slice(2) : oldName)
        : newName.replace(/^b\//, '');
      if (newName === '/dev/null' && file && TEST_FILE.test(file) && !allowTestDeletion) {
        push('test_file_deleted', 0, `deleted test file ${file}`);
      }
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (file === null) continue;
    if (raw.startsWith('-')) {
      const text = raw.slice(1);
      if (!allowTestDeletion && TEST_DEF.test(text)) {
        push('test_deleted', oldLine, 'removed test case');
      }
      const tally = assertTally(text, oldLine);
      if (tally) tally.removed.push(oldLine);
      oldLine++;
    } else if (raw.startsWith('+')) {
      const text = raw.slice(1);
      if (SKIP_MARK.test(text)) {
        push('test_skipped', newLine, 'added test skip/only marker');
      }
      for (const [rule, label] of SECRET_RULES) {
        if (rule.test(text)) push('secret_leak', newLine, label);
      }
      if (RUNNER_FILE.test(file) && EXIT_OK.test(text)) {
        push('gate_bypass', newLine, 'added exit 0 in check runner');
      }
      const tally = assertTally(text, newLine);
      if (tally) tally.added.push(newLine);
      newLine++;
    } else {
      oldLine++;
      newLine++;
    }
  }

  for (const [name, tally] of asserts) {
    if (tally.removed.length > tally.added.length) {
      violations.push({
        kind: 'assertion_weakened',
        file: name,
        line: tally.removed[tally.added.length],
        detail: `removed ${tally.removed.length} assertion(s), added ${tally.added.length}`,
      });
    }
  }

  const order = { test_file_deleted: 0, test_deleted: 1, test_skipped: 2,
    assertion_weakened: 3, gate_bypass: 4, secret_leak: 5 };
  violations.sort((a, b) =>
    String(a.file).localeCompare(String(b.file)) ||
    a.line - b.line ||
    (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  return violations;
}

// Порт CheckPort: git -C <worktree> diff --unified=0 base..candidate без выполнения кода.
// Результат: { ok, sha, base_sha, violations, digest } — digest от канонического отчёта.
export async function tamperGate(binding, profile = {}) {
  const { worktree, base_sha, candidate_sha } = binding ?? {};
  if (typeof worktree !== 'string' || !SHA.test(base_sha ?? '') || !SHA.test(candidate_sha ?? '')) {
    throw new Error('tamper_gate_requires_worktree_and_full_shas');
  }
  const { stdout } = await exec('git',
    ['-C', worktree, 'diff', '--unified=0', `${base_sha}..${candidate_sha}`],
    { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const violations = analyzeDiff(stdout, {
    allowTestDeletion: profile?.allowTestDeletion === true,
  });
  const report = { ok: violations.length === 0, sha: candidate_sha, base_sha, violations };
  return { ...report, digest: canonicalDigest(report) };
}
