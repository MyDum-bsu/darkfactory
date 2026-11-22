// Детерминированный L1 tamper-gate: статический разбор `git diff base..candidate`.
// Код кандидата не выполняется: внешние diff-драйверы, textconv, цвет, quoting и
// любой конфиг/атрибуты Git отключены и выключены из окружения. Гейт ловит до
// запуска L3/L2: удаление/переименование тестов без явного допуска профиля,
// skip/only-маркеры, смену типа файла, ослабление проверок, подмену test-runner'а
// и утечку секретов.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalDigest } from './subject.mjs';

const exec = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;

// Файл считается тестовым по типичным каталогам и суффиксам JS/TS/Python.
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.py$/;
// Удалённое определение тестового кейса: JS/TS test(, it(, describe( и Python def test_.
// Граница слева не допускает '.': вызов RegExp.test() не является тест-кейсом.
const TEST_DEF = /(?:^|[^\w$.])(?:it|test|describe)\s*\(|(?:^|[^\w$])def\s+test_/;
// Маркеры отключения/фокусировки тестов на добавленной строке.
const SKIP_MARK = /\b(?:it|test|describe|context|xit|xtest)\s*\.\s*(?:skip|only)\s*\(|\.only\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)|@?unittest\.skip|@skip\b/;
// Проверки/утверждения: удаление без замены — ослабление гейта.
const ASSERT_MARK = /\bassert\b|\bexpect\s*\(|\.assert\w*\s*\(/;
// Строка-комментарий не является действующей проверкой.
const COMMENT_MARK = /^\s*(?:\/\/|#|\*|<!--)/;
// Содержательная проверка: сравнение, исключение или предикат expect(...).to*.
const STRONG_ASSERT = /\bassert[\w.]*\s*\([^)]*(?:==|!=|>=|<=|>|<|\b(?:not\s+)?in\b|\b(?:raise|throws?|error)\w*\b)|\bassert[\w.]*(?:equal|strict|throws?|raises?|match|regex|contain|instance|true|false|close)\w*\s*\(|\bexpect\s*\([^)]*\)\s*\.\s*to\w+/i;
// Тривиальное утверждение на месте содержательного — ослабление, а не проверка.
const TRIVIAL_ASSERT = /\bassert\s*\(\s*(?:true|1)\s*\)|\bassert\s+True\b|\bexpect\s*\(\s*true\s*\)|\.assertTrue\s*\(\s*True/;
// Сравнение с числовым порогом внутри проверки: `>= 10`, `=== 5`, `< 0.5`.
const CMP_BOUND = /(===|!==|==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)/g;
// Файлы, из которых запускаются проверки.
const RUNNER_FILE = /(^|\/)(package\.json|Makefile|makefile|scripts?\/)|\.(?:ya?ml|sh|ps1|bat)$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;
// Подмена результата проверки: принудительный нулевой код или «… || true».
const EXIT_OK = /\bexit\s+0\b|\|\|\s*(?:true|:)\b/;
const RUNS_TESTS = /test|jest|mocha|vitest|pytest|tap\b|ava\b/;
const RUNNER_WORDS = /test|jest|mocha|vitest|pytest|tap|ava/g;
const NOOP_SCRIPT = /^\s*(?:true|:|exit\s+0\b|echo\b)/;

const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private_key'],
  [/ghp_[A-Za-z0-9]{20,}/, 'github_token'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'github_token'],
  [/sk-[A-Za-z0-9]{20,}/, 'api_key'],
  [/AKIA[0-9A-Z]{16}/, 'aws_access_key'],
  [/BOARD_TOKEN\s*=\s*\S+/, 'board_token'],
];

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Метаданные изменений из `git diff-tree -r -z --no-commit-id -M base cand`:
// NUL-разделитель даёт точные пути с пробелами и ' b/', точные статусы и режимы.
function parseDiffTree(raw) {
  const entries = [];
  const tokens = String(raw).split('\0');
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i++];
    if (!head.startsWith(':')) continue;
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([ACDMRTUX])\d*$/.exec(head);
    if (!meta) continue;
    const [, oldMode, newMode, status] = meta;
    const oldPath = tokens[i++] ?? null;
    const path = (status === 'R' || status === 'C') ? (tokens[i++] ?? oldPath) : oldPath;
    entries.push({ oldMode, newMode, status, oldPath, path });
  }
  return entries;
}

export function analyzeDiffTree(raw, { allowTestDeletion = false } = {}) {
  const violations = [];
  for (const { oldMode, newMode, status, oldPath, path } of parseDiffTree(raw)) {
    const isTest = (name) => typeof name === 'string' && TEST_FILE.test(name);
    if (!allowTestDeletion) {
      if (status === 'D' && isTest(path)) {
        violations.push({ kind: 'test_file_deleted', file: path, line: 0,
          detail: `deleted test file ${path}` });
      }
      if (status === 'R' && isTest(oldPath) && !isTest(path)) {
        violations.push({ kind: 'test_file_deleted', file: oldPath, line: 0,
          detail: `test file ${oldPath} renamed to ${path}` });
      }
    }
    const subject = isTest(path) ? path : isTest(oldPath) ? oldPath : null;
    if (subject !== null && newMode !== '000000' && oldMode !== newMode &&
        newMode !== '100644' && newMode !== '100755') {
      violations.push({ kind: 'file_type_changed', file: subject, line: 0,
        detail: `test file ${subject} changed type ${oldMode} -> ${newMode}` });
    }
  }
  return violations;
}

// Построчный разбор unified=0 diff: содержимое hunk'ов. Имена файлов берутся
// только из заголовков '---'/'+++' — строка содержимого не может сойти за заголовок.
export function analyzeDiff(diff, { allowTestDeletion = false } = {}) {
  const violations = [];
  const asserts = new Map();
  const bounds = new Map();
  let oldName = null;
  let file = null;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  const push = (kind, line, detail, target = file) => violations.push({ kind, file: target, line, detail });
  const tallyFor = (map, name) => {
    const tally = map.get(name) ?? { removed: [], added: [], strongRemoved: 0, strongAdded: 0 };
    map.set(name, tally);
    return tally;
  };
  const boundTally = () => {
    const tally = bounds.get(file) ?? { removed: [], added: [], removedAnds: 0, addedAnds: 0 };
    bounds.set(file, tally);
    return tally;
  };
  // Комментарии не считаются ни удалённой, ни добавленной проверкой.
  const isAssert = (text) => ASSERT_MARK.test(text) && !COMMENT_MARK.test(text);

  for (const raw of String(diff).split('\n')) {
    if (raw.startsWith('diff --git ')) {
      oldName = null;
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith('rename to ')) {
      file = raw.slice(10);
      continue;
    }
    if (!inHunk && raw.startsWith('--- ')) {
      oldName = raw.slice(4).trim();
      continue;
    }
    if (!inHunk && raw.startsWith('+++ ')) {
      const newName = raw.slice(4).trim();
      file = newName === '/dev/null'
        ? (typeof oldName === 'string' && oldName.startsWith('a/') ? oldName.slice(2) : oldName)
        : newName.replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk && file !== null) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!inHunk || file === null) continue;
    // '\ No newline at end of file' — служебная строка, не содержимое файла.
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('-')) {
      const text = raw.slice(1);
      if (!allowTestDeletion && TEST_DEF.test(text)) {
        push('test_deleted', oldLine, 'removed test case');
      }
      if (isAssert(text)) {
        const tally = tallyFor(asserts, file);
        tally.removed.push(oldLine);
        if (STRONG_ASSERT.test(text)) tally.strongRemoved++;
        const tallyB = boundTally();
        tallyB.removed.push(...[...text.matchAll(CMP_BOUND)]
          .map((m) => ({ op: m[1], num: Number(m[2]) })));
        tallyB.removedAnds += (text.match(/&&|\|\|/g) ?? []).length;
      }
      oldLine++;
    } else if (raw.startsWith('+')) {
      const text = raw.slice(1);
      if (SKIP_MARK.test(text)) {
        push('test_skipped', newLine, 'added test skip/only marker');
      }
      if (TRIVIAL_ASSERT.test(text)) {
        push('assertion_weakened', newLine, 'trivial assertion added');
      }
      for (const [rule, label] of SECRET_RULES) {
        if (rule.test(text)) push('secret_leak', newLine, label);
      }
      if (RUNNER_FILE.test(file) && EXIT_OK.test(text)) {
        push('gate_bypass', newLine, 'added forced success in check runner');
      }
      if (isAssert(text)) {
        const tally = tallyFor(asserts, file);
        tally.added.push(newLine);
        if (STRONG_ASSERT.test(text)) tally.strongAdded++;
        const tallyB = boundTally();
        tallyB.added.push(...[...text.matchAll(CMP_BOUND)]
          .map((m) => ({ op: m[1], num: Number(m[2]) })));
        tallyB.addedAnds += (text.match(/&&|\|\|/g) ?? []).length;
      }
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
    } else if (tally.strongRemoved > tally.strongAdded) {
      violations.push({
        kind: 'assertion_weakened',
        file: name,
        line: tally.removed[0] ?? 0,
        detail: `strict assertions reduced ${tally.strongRemoved} -> ${tally.strongAdded}`,
      });
    }
  }
  for (const [name, tally] of bounds) {
    const isLower = (op) => op === '>=' || op === '>';
    const isUpper = (op) => op === '<=' || op === '<';
    const isEq = (op) => op === '===' || op === '==';
    const weakened = tally.removed.some((r) =>
      (isLower(r.op) && tally.added.some((a) => isLower(a.op) && a.num < r.num)) ||
      (isUpper(r.op) && tally.added.some((a) => isUpper(a.op) && a.num > r.num)) ||
      (isEq(r.op) && tally.added.some((a) => !isEq(a.op) && a.op !== '!=' && a.op !== '!==')));
    const droppedConditions = tally.removedAnds > tally.addedAnds && tally.removedAnds > 0;
    if (weakened || droppedConditions) {
      violations.push({
        kind: 'assertion_weakened',
        file: name,
        line: 0,
        detail: weakened ? 'check threshold relaxed' : 'fewer asserted conditions',
      });
    }
  }
  return violations;
}

const ORDER = { test_file_deleted: 0, test_deleted: 1, file_type_changed: 2, test_skipped: 3,
  assertion_weakened: 4, gate_bypass: 5, secret_leak: 6 };

function sortViolations(violations) {
  violations.sort((a, b) =>
    cmpStr(String(a.file), String(b.file)) ||
    a.line - b.line ||
    (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));
  return violations;
}

// Детерминированный вызов git: без внешних diff-драйверов, textconv, цвета,
// quoting-путей и любого конфига/атрибутов; локаль и окружение зафиксированы.
function gitEnv() {
  return {
    PATH: process.env.PATH,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_LOCAL: '/dev/null',
    GIT_CONFIG_COUNT: '0',
    GIT_ATTR_SOURCE: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  };
}

const GIT_PINS = ['-c', 'color.ui=false', '-c', 'color.diff=false',
  '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.noprefix=false',
  '-c', 'core.quotepath=false', '-c', 'core.attributesFile=/dev/null'];

async function gitIsolated(worktree, args, maxBuffer = 16 * 1024 * 1024) {
  return (await exec('git', ['-C', worktree, ...GIT_PINS, ...args],
    { timeout: 30_000, maxBuffer, env: gitEnv() })).stdout;
}

async function gitShow(worktree, sha, path) {
  try {
    return await gitIsolated(worktree, ['show', `${sha}:${path}`]);
  } catch {
    return null;
  }
}

// Семантика package.json: удалённый/пустой/ослабленный scripts.test — обход гейта.
// Строковый разбор не ловит scripts.test на одной строке с metadata.test;
// здесь сравниваются распарсенные объекты base и candidate.
async function packageJsonViolations(worktree, baseSha, candidateSha, path) {
  if (path === null) return [];
  const baseText = await gitShow(worktree, baseSha, path);
  const candText = await gitShow(worktree, candidateSha, path);
  let basePkg = null;
  let candPkg = null;
  try { basePkg = JSON.parse(baseText ?? 'null'); } catch { basePkg = null; }
  try { candPkg = JSON.parse(candText ?? 'null'); } catch { candPkg = null; }
  const baseTest = basePkg?.scripts?.test;
  if (typeof baseTest !== 'string' || !baseTest.trim()) return [];
  const push = (detail) => [{ kind: 'gate_bypass', file: path, line: 0, detail }];
  const candTest = candPkg?.scripts?.test;
  if (typeof candTest !== 'string' || !candTest.trim()) {
    return push('scripts.test removed');
  }
  if (NOOP_SCRIPT.test(candTest) || !RUNS_TESTS.test(candTest)) {
    return push('scripts.test no longer runs tests');
  }
  const runners = (cmd) => new Set((cmd.match(RUNNER_WORDS) ?? []).map((w) => w));
  const lost = [...runners(baseTest)].filter((w) => !runners(candTest).has(w));
  if (lost.length > 0) {
    return push(`test runner weakened: dropped ${lost.join(',')}`);
  }
  return [];
}

// Порт CheckPort: git diff base..candidate без выполнения кода кандидата.
// Результат: { ok, sha, base_sha, violations, digest } — digest от канонического отчёта.
export async function tamperGate(binding, profile = {}) {
  const { worktree, base_sha, candidate_sha } = binding ?? {};
  if (typeof worktree !== 'string' || !SHA.test(base_sha ?? '') || !SHA.test(candidate_sha ?? '')) {
    throw new Error('tamper_gate_requires_worktree_and_full_shas');
  }
  const allowTestDeletion = profile?.allowTestDeletion === true;
  const [rawList, patch] = await Promise.all([
    gitIsolated(worktree,
      ['diff-tree', '-r', '-z', '--no-commit-id', '-M', base_sha, candidate_sha]),
    gitIsolated(worktree,
      ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=0',
        `${base_sha}..${candidate_sha}`]),
  ]);
  const violations = [
    ...analyzeDiffTree(rawList, { allowTestDeletion }),
    ...analyzeDiff(patch, { allowTestDeletion }),
  ];
  // Семантический разбор package.json по распарсенным объектам обеих версий.
  const pkgPaths = new Set();
  for (const { oldPath, path } of parseDiffTree(rawList)) {
    for (const name of [oldPath, path]) {
      if (typeof name === 'string' && PACKAGE_JSON.test(name)) pkgPaths.add(name);
    }
  }
  for (const path of pkgPaths) {
    violations.push(...await packageJsonViolations(worktree, base_sha, candidate_sha, path));
  }
  sortViolations(violations);
  const report = { ok: violations.length === 0, sha: candidate_sha, base_sha, violations };
  return { ...report, digest: canonicalDigest(report) };
}
