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
const isTest = name => typeof name === 'string' && TEST_FILE.test(name);
// Удалённое определение тестового кейса: JS/TS test(, it(, describe( и Python def test_.
// Граница слева не допускает '.': вызов RegExp.test() не является тест-кейсом.
const TEST_DEF = /(?:^|[^\w$.])(?:it|test|describe)\s*\(|(?:^|[^\w$])def\s+test_/;
// Маркеры отключения/фокусировки тестов на добавленной строке.
// xit/fit-семейство — только глобальные вызовы: граница слева не допускает
// '.', иначе метод вида model.fit() ложно считается фокусировкой теста.
const SKIP_MARK = /(?:^|[^\w$.])(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|\b(?:it|test|describe|context)\s*\.\s*(?:skip|only|todo)\s*\(|\.only\s*\(|\.todo\s*\(|\bt\s*\.\s*skip\s*\(|\bpytest\s*\.\s*skip\s*\(|\{[^{}]*\b(?:skip|only)\s*:\s*true\b[^{}]*\}|\b(?:skip|only)\s*:\s*true\b|@pytest\.mark\.(?:skip|skipif|xfail)|@?unittest\.skip|@[s]kip\b/;
const STRONG_TEST_DEF = /(?:^|[^\w$.])(?:it|test|describe)\s*\(.*(?:=>|function\b|,)|(?:^|[^\w$])def\s+test_[A-Za-z0-9_]*\s*\(/;
const JS_TEST_DEF_OPEN = /(?:^|[^\w$.])(?:it|test|describe)\s*\((.*)$/;
const PY_TEST_DEF_OPEN = /(?:^|[^\w$])def\s+test_[A-Za-z0-9_]*\s*\(/;
const isPlausibleTestDef = (text) => {
  if (PY_TEST_DEF_OPEN.test(text)) return true;
  const open = JS_TEST_DEF_OPEN.exec(text);
  if (!open) return false;
  const rest = open[1];
  return rest.trim() === '' || /^\s*["'`]/.test(rest) || rest.includes(',') ||
    rest.includes('=>') || /\bfunction\b/.test(rest);
};
// Проверки/утверждения: удаление без замены — ослабление гейта.
const ASSERT_MARK = /\bassert\b|\bexpect\s*\(|\.assert\w*\s*\(/;
// Строка-комментарий не является действующей проверкой.
const COMMENT_MARK = /^\s*(?:\/\/|\/\*|#|\*|<!--)/;
// Содержательная проверка: сравнение, исключение или предикат expect(...).to*.
const STRONG_ASSERT = /\bassert[\w.]*\s*\([^)]*(?:==|!=|>=|<=|>|<|\b(?:not\s+)?in\b|\b(?:raise|throws?|error)\w*\b)|\bassert[\w.]*(?:equal|strict|throws?|raises?|match|regex|contain|instance|true|false|close)\w*\s*\(|\bexpect\s*\([^)]*\)\s*\.\s*to\w+/i;
// Тривиальное утверждение на месте содержательного — ослабление, а не проверка.
const TRIVIAL_ASSERT = /\bassert\s*\(\s*(?:true|1)\s*\)|\bassert\s+True\b|\bexpect\s*\(\s*true\s*\)|\.assertTrue\s*\(\s*True/;
const ASSERT_TAUTOLOGY = /\|\|\s*(?:true|1)\b|\b(?:true|1)\b\s*\|\||\bor\s+True\b/;
// Тавтология сравнения литерала с самим собой: assert.strictEqual(1, 1),
// assert.equal("a", "a"), expect(1).toBe(1) — проверка не проверяет ничего.
const LIT_SRC = String.raw`-?\d+(?:\.\d+)?|true|false|null|undefined|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const ASSERT_SAME_LIT = new RegExp(
  String.raw`\bassert\s*\.\s*(?:strictEqual|equal|deepEqual|deepStrictEqual)\s*\(\s*(${LIT_SRC})\s*,\s*(${LIT_SRC})\s*\)`);
const EXPECT_SAME_LIT = new RegExp(
  String.raw`\bexpect\s*\(\s*(${LIT_SRC})\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*(${LIT_SRC})\s*\)`);
const canonLiteral = (lit) => {
  const t = String(lit).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
};
const isIdenticalLiteralAssert = (text) => {
  for (const rule of [ASSERT_SAME_LIT, EXPECT_SAME_LIT]) {
    const m = rule.exec(text);
    if (m && canonLiteral(m[1]) === canonLiteral(m[2])) return true;
  }
  return false;
};
// Сравнение с числовым порогом внутри проверки: `>= 10`, `=== 5`, `< 0.5`.
const CMP_BOUND = /(===|!==|==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)/g;
// Файлы, из которых запускаются проверки.
const RUNNER_FILE = /(^|\/)(package\.json|Makefile|makefile|scripts?\/)|\.(?:ya?ml|sh|ps1|bat)$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;
// Подмена результата проверки: принудительный нулевой код или «… || true».
const EXIT_OK = /\bexit\s+0\b|\|\|\s*(?:true|:)\b/;
const RUNS_TESTS = /test|jest|mocha|vitest|pytest|tap\b|ava\b/;
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

// Ключ сравнения — непосредственный левый операнд оператора: от последнего
// разделителя (&&, ||, (, ,, ;, ?, :) до позиции оператора, без пробелов.
// Тогда в `assert(x >= 1 && y >= 10)` ключи — 'x' и 'y', и ослабление одного
// операнда при ужесточении другого сопоставляется и ловится точно.
const operandKey = (text, index) => {
  const left = text.slice(0, index);
  let cut = -1;
  let sepLen = 0;
  for (const sep of ['&&', '||', '(', ',', ';', '?', ':']) {
    const at = left.lastIndexOf(sep);
    if (at > cut) {
      cut = at;
      sepLen = sep.length;
    }
  }
  return left.slice(cut + sepLen).replace(/\s+/g, '');
};

// Разбор блочных комментариев с учётом строковых литералов: '/*' внутри
// "..." или '...' — содержимое строки, а не начало комментария, иначе
// удалённая строка вида const s = "/*" маскировала бы все последующие
// удалённые тесты и проверки под видом закомментированных.
const stripBlockCommented = (text, inBlock) => {
  let out = '';
  let state = inBlock;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    if (state) {
      if (text[i] === '*' && text[i + 1] === '/') {
        state = false;
        i++;
      }
      continue;
    }
    if (quote !== null) {
      out += text[i];
      if (text[i] === '\\') {
        if (i + 1 < text.length) out += text[i + 1];
        i++;
        continue;
      }
      if (text[i] === quote) quote = null;
      continue;
    }
    if (text[i] === '"' || text[i] === "'" || text[i] === '`') {
      quote = text[i];
      out += text[i];
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      state = true;
      i++;
      continue;
    }
    out += text[i];
  }
  return { text: out, state };
};

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
    // Допуск действует строго на удалённые файлы (status D): переименование
    // теста вне discovery — не удаление по решению оператора, а маскировка.
    if (!allowTestDeletion && status === 'D' && isTest(path)) {
      violations.push({ kind: 'test_file_deleted', file: path, line: 0,
        detail: `deleted test file ${path}` });
    }
    if (status === 'R' && isTest(oldPath) && !isTest(path)) {
      violations.push({ kind: 'test_file_deleted', file: oldPath, line: 0,
        detail: `test file ${oldPath} renamed to ${path}` });
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
  const testDefs = new Map();
  let oldName = null;
  let file = null;
  let inHunk = false;
  let testHunk = false;
  let isDeletedFile = false;
  let oldLine = 0;
  let newLine = 0;
  let oldBlockComment = false;
  let newBlockComment = false;

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
  const testDefTally = (name) => {
    const tally = testDefs.get(name) ?? { removed: [], added: [] };
    testDefs.set(name, tally);
    return tally;
  };
  const isTestDef = (text) => isPlausibleTestDef(text) && !COMMENT_MARK.test(text) &&
    (testHunk || STRONG_TEST_DEF.test(text));
  // Комментарии не считаются ни удалённой, ни добавленной проверкой.
  const isAssert = (text) => ASSERT_MARK.test(text) && !COMMENT_MARK.test(text);

  for (const raw of String(diff).split('\n')) {
    if (raw.startsWith('diff --git ')) {
      oldName = null;
      file = null;
      inHunk = false;
      isDeletedFile = false;
      oldBlockComment = false;
      newBlockComment = false;
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
      isDeletedFile = newName === '/dev/null';
      file = isDeletedFile
        ? (typeof oldName === 'string' && oldName.startsWith('a/') ? oldName.slice(2) : oldName)
        : newName.replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk && file !== null) {
      inHunk = true;
      testHunk = isTest(file) || isTest(oldName?.replace(/^a\//, ''));
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      // При --unified=0 hunk'и разрознены: состояние блочного комментария
      // не может переноситься через невидимый разрыв — иначе '/*' в одном
      // hunk'е маскирует удалённые тесты всех последующих hunk'ов файла.
      oldBlockComment = false;
      newBlockComment = false;
      continue;
    }
    if (!inHunk || file === null) continue;
    // '\ No newline at end of file' — служебная строка, не содержимое файла.
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('-')) {
      const rawText = raw.slice(1);
      const scanned = stripBlockCommented(rawText, oldBlockComment);
      oldBlockComment = scanned.state;
      const text = scanned.text;
      // Допуск удаления тестов действует строго на файлы со статусом D:
      // в изменённых/переименованных тестовых файлах удаление кейсов и
      // проверок отслеживается независимо от allowTestDeletion.
      if (!(allowTestDeletion && isDeletedFile) && isTestDef(text)) {
        testDefTally(file).removed.push({ line: oldLine, text });
      }
      // При явном допуске удаления тестов удаляемый файл целиком уходит по
      // решению оператора: его проверки не «ослабляются», а перестают существовать.
      if (testHunk && isAssert(text) && !(allowTestDeletion && isDeletedFile)) {
        const tally = tallyFor(asserts, file);
        tally.removed.push(oldLine);
        if (STRONG_ASSERT.test(text)) tally.strongRemoved++;
        const tallyB = boundTally();
        tallyB.removed.push(...[...text.matchAll(CMP_BOUND)]
          .map((m) => ({ expr: operandKey(text, m.index),
            op: m[1], num: Number(m[2]) })));
        tallyB.removedAnds += (text.match(/&&|\|\|/g) ?? []).length;
      }
      oldLine++;
    } else if (raw.startsWith('+')) {
      const rawText = raw.slice(1);
      const scanned = stripBlockCommented(rawText, newBlockComment);
      newBlockComment = scanned.state;
      const text = scanned.text;
      if (!(allowTestDeletion && isDeletedFile) && isTestDef(text)) {
        testDefTally(file).added.push({ line: newLine, text });
      }
      // Skip/only-маркеры осмысленны только в тестовых hunks: в обычном коде
      // '{ skip: true }' — конфиг, а '.fit()' — метод, а не маркер теста.
      // Строка-комментарий не является действующим маркером (как и проверкой).
      if (testHunk && SKIP_MARK.test(text) && !COMMENT_MARK.test(text)) {
        push('test_skipped', newLine, 'added test skip/only marker');
      }
      if (testHunk) {
        const blockOpen = rawText.indexOf('/*');
        if (blockOpen >= 0 && rawText.indexOf('*/', blockOpen + 2) < 0) {
          push('assertion_weakened', newLine, 'unclosed block comment added in test');
        }
        if (COMMENT_MARK.test(rawText) && (TEST_DEF.test(rawText) || ASSERT_MARK.test(rawText))) {
          push('assertion_weakened', newLine, 'test or assertion commented out');
        }
        if (/\breturn\s*(?:;|$)/.test(text) ||
            /\breturn\s+(?:0|true|null|undefined)\s*(?:;|$)/.test(text)) {
          push('assertion_weakened', newLine, 'early return added in test');
        }
        // process.exit(0) в тесте обрывает раннер до остальных проверок.
        if (/\bprocess\s*\.\s*exit\s*\(\s*0\s*\)/.test(text)) {
          push('assertion_weakened', newLine, 'process.exit(0) added in test');
        }
        // Мёртвая ветка прячет проверки за невыполнимым условием.
        if (/\bif\s*\(\s*(?:false|0)\s*\)/.test(text)) {
          push('assertion_weakened', newLine, 'dead branch wrapper added in test');
        }
      }
      if (testHunk && TRIVIAL_ASSERT.test(text)) {
        push('assertion_weakened', newLine, 'trivial assertion added');
      }
      if (testHunk && isAssert(text) && ASSERT_TAUTOLOGY.test(text)) {
        push('assertion_weakened', newLine, 'tautological assertion added');
      }
      if (testHunk && isIdenticalLiteralAssert(text)) {
        push('assertion_weakened', newLine, 'identical-literal tautology assertion added');
      }
      for (const [rule, label] of SECRET_RULES) {
        if (rule.test(rawText)) push('secret_leak', newLine, label);
      }
      if (RUNNER_FILE.test(file) && EXIT_OK.test(rawText)) {
        push('gate_bypass', newLine, 'added forced success in check runner');
      }
      if (testHunk && isAssert(text)) {
        const tally = tallyFor(asserts, file);
        tally.added.push(newLine);
        if (STRONG_ASSERT.test(text)) tally.strongAdded++;
        const tallyB = boundTally();
        tallyB.added.push(...[...text.matchAll(CMP_BOUND)]
          .map((m) => ({ expr: operandKey(text, m.index),
            op: m[1], num: Number(m[2]) })));
        tallyB.addedAnds += (text.match(/&&|\|\|/g) ?? []).length;
      }
      newLine++;
    } else {
      const text = raw.startsWith(' ') ? raw.slice(1) : raw;
      oldBlockComment = stripBlockCommented(text, oldBlockComment).state;
      newBlockComment = stripBlockCommented(text, newBlockComment).state;
      oldLine++;
      newLine++;
    }
  }

  for (const [name, tally] of testDefs) {
    if (tally.removed.length > tally.added.length) {
      for (const removed of tally.removed) {
        violations.push({
          kind: 'test_deleted',
          file: name,
          line: removed.line,
          detail: 'removed test case',
        });
      }
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
    // Сопоставляются только проверки одного выражения: ужесточение другого
    // assert'а в том же файле ложным ослаблением не считается.
    const weakened = tally.removed.some((r) => {
      const added = tally.added.filter((a) => a.expr === r.expr);
      return added.some((a) =>
        (isLower(r.op) && isLower(a.op) && a.num < r.num) ||
        (isUpper(r.op) && isUpper(a.op) && a.num > r.num) ||
        (isEq(r.op) && !isEq(a.op) && a.op !== '!=' && a.op !== '!=='));
    });
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

const TEST_RUNNER_EXECUTABLES = new Set(['jest', 'mocha', 'vitest', 'pytest', 'tap', 'ava']);

function stripJsComments(text) {
  return String(text).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function splitShellWords(command) {
  const tokens = [];
  let cur = '';
  let inWord = false;
  const pushWord = () => {
    if (inWord) tokens.push(cur);
    cur = '';
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (/\s/.test(c)) { pushWord(); continue; }
    if (c === ';' || c === '&' || c === '|') {
      pushWord();
      if ((c === '&' || c === '|') && command[i + 1] === c) {
        tokens.push(c + c);
        i++;
      } else {
        tokens.push(c);
      }
      continue;
    }
    if (c === "'" || c === '"') {
      inWord = true;
      for (i++; i < command.length && command[i] !== c; i++) {
        if (c === '"' && command[i] === '\\' && i + 1 < command.length) {
          cur += command[++i];
        } else {
          cur += command[i];
        }
      }
      continue;
    }
    if (c === '\\') {
      cur += command[++i] ?? '';
      inWord = true;
      continue;
    }
    cur += c;
    inWord = true;
  }
  pushWord();
  return tokens.filter((token) => token !== '');
}

function shellSegments(command) {
  const segments = [];
  let current = [];
  for (const token of splitShellWords(command)) {
    if (token === ';' || token === '&' || token === '|' || token === '&&' || token === '||') {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function cleanScriptArgv(words) {
  const argv = [];
  for (let i = 0; i < words.length; i++) {
    const redir = /^(?:\d*(<<<|<<|>>|<|>)|(&>>?))(.*)$/.exec(words[i]);
    if (redir) {
      if (!redir[3]) i++;
      continue;
    }
    argv.push(words[i]);
  }
  while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv.shift();
  return argv;
}

const executableName = (word) => String(word ?? '').split(/[\/\\]/).pop()
  .replace(/\.exe$/i, '').replace(/\.js$/i, '');

function runnerSignatures(command) {
  const signatures = new Set();
  for (const segment of shellSegments(command)) {
    const argv = cleanScriptArgv(segment);
    if (!argv.length) continue;
    const exe = executableName(argv[0]);
    const rest = argv.slice(1);
    if (TEST_RUNNER_EXECUTABLES.has(exe)) signatures.add(exe);
    if (!TEST_RUNNER_EXECUTABLES.has(exe) &&
        !['node', 'nodejs', 'npx', 'bunx', 'npm', 'pnpm', 'yarn', 'bun'].includes(exe) &&
        !/^python(?:[\d.]*)$/.test(exe) && RUNS_TESTS.test(exe)) {
      signatures.add(`exec:${argv[0]}`);
    }
    const hasNodeTest = (exe === 'node' || exe === 'nodejs') &&
      rest.some((word) => word === '--test' || word.startsWith('--test='));
    if (hasNodeTest) signatures.add('test');
    if (exe === 'node' || exe === 'nodejs') {
      const positional = [];
      for (let i = 0; i < rest.length; i++) {
        const word = rest[i];
        if (['-e', '--eval', '-r', '--require', '--loader', '--experimental-loader'].includes(word)) {
          i++;
          continue;
        }
        if (word.startsWith('-')) continue;
        positional.push(word);
      }
      const scriptToken = positional[0];
      const script = executableName(scriptToken);
      if (TEST_RUNNER_EXECUTABLES.has(script)) signatures.add(script);
      else if (scriptToken && !hasNodeTest) signatures.add(`node:${scriptToken}`);
    }
    if (/^python(?:[\d.]*)$/.test(exe)) {
      const moduleIndex = rest.findIndex((word) => word === '-m');
      const moduleName = moduleIndex >= 0 ? rest[moduleIndex + 1] : rest.find((word) => !word.startsWith('-'));
      if (TEST_RUNNER_EXECUTABLES.has(executableName(moduleName))) signatures.add(executableName(moduleName));
    }
    if (exe === 'npx' || exe === 'bunx') {
      const nested = executableName(rest.find((word) => !word.startsWith('-')));
      if (TEST_RUNNER_EXECUTABLES.has(nested)) signatures.add(nested);
    }
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(exe)) {
      const words = rest.filter((word) => !word.startsWith('-'));
      if (words[0] === 'test' || (words[0] === 'run' && words[1] === 'test')) {
        signatures.add(`${exe}:test`);
      }
      const execIndex = words[0] === 'exec' ? 1 : -1;
      const nested = executableName(execIndex >= 0 ? words[execIndex] : null);
      if (TEST_RUNNER_EXECUTABLES.has(nested)) signatures.add(nested);
    }
  }
  return signatures;
}

function commentOnlyNodeEval(command) {
  const segments = shellSegments(command).filter((segment) => segment.length);
  if (segments.length !== 1) return false;
  const argv = cleanScriptArgv(segments[0]);
  const exe = executableName(argv[0]);
  if (exe !== 'node' && exe !== 'nodejs') return false;
  let payload = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-e' || argv[i] === '--eval') {
      payload = argv[i + 1] ?? '';
      break;
    }
    if (argv[i].startsWith('--eval=')) {
      payload = argv[i].slice('--eval='.length);
      break;
    }
  }
  if (payload === null) return false;
  const compact = stripJsComments(payload).trim().replace(/;+\s*$/, '');
  return compact === '' || ['true', '0', 'null', 'undefined'].includes(compact);
}

// Флаги фильтрации тестов в scripts.test*: добавленный фильтр прогоняет
// лишь часть suite — скрытое ослабление гейта даже при неизменном раннере.
const TEST_FILTER_LONG = new Set(['test-name-pattern', 'grep', 'skip']);

function testFilterFlags(command) {
  const found = new Set();
  for (const segment of shellSegments(String(command))) {
    for (const word of cleanScriptArgv(segment)) {
      if (word.startsWith('--')) {
        const name = word.slice(2).split('=', 1)[0];
        if (TEST_FILTER_LONG.has(name)) found.add(`--${name}`);
      } else if (/^-[kt]$/.test(word)) {
        found.add(word);
      }
    }
  }
  return found;
}

function testFilterViolations(basePkg, candPkg, path) {
  const violations = [];
  const candScripts = candPkg?.scripts;
  if (candScripts === null || typeof candScripts !== 'object') return violations;
  for (const [key, value] of Object.entries(candScripts)) {
    if (!key.startsWith('test') || typeof value !== 'string') continue;
    const baseValue = basePkg?.scripts?.[key];
    const candFlags = testFilterFlags(value);
    const baseFlags = typeof baseValue === 'string' ? testFilterFlags(baseValue) : new Set();
    const added = [...candFlags].filter((flag) => !baseFlags.has(flag)).sort();
    if (added.length > 0) {
      violations.push({ kind: 'gate_bypass', file: path, line: 0,
        detail: `test filter flag(s) added in scripts.${key}: ${added.join(',')}` });
    }
  }
  return violations;
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
  const filterViolations = testFilterViolations(basePkg, candPkg, path);
  const baseTest = basePkg?.scripts?.test;
  const candTest0 = candPkg?.scripts?.test;
  // Скрипт не изменился: соседние ключи (metadata.test и т.п.) — не ослабление.
  if (candTest0 === baseTest) return filterViolations;
  if (typeof baseTest !== 'string' || !baseTest.trim()) return filterViolations;
  const push = (detail) => [...filterViolations,
    { kind: 'gate_bypass', file: path, line: 0, detail }];
  const candTest = candPkg?.scripts?.test;
  if (typeof candTest !== 'string' || !candTest.trim()) {
    return push('scripts.test removed');
  }
  const visibleCandTest = stripJsComments(candTest);
  if (NOOP_SCRIPT.test(visibleCandTest) || commentOnlyNodeEval(candTest) ||
      !RUNS_TESTS.test(visibleCandTest)) {
    return push('scripts.test no longer runs tests');
  }
  const baseRunners = runnerSignatures(baseTest);
  const candRunners = runnerSignatures(candTest);
  const lost = [...baseRunners].filter((w) => !candRunners.has(w));
  if (lost.length > 0) {
    return push(`test runner weakened: dropped ${lost.join(',')}`);
  }
  return filterViolations;
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
      ['diff', '--text', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=0',
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
