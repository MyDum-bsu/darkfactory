// Детерминированный L1 tamper-gate: статический разбор `git diff base..candidate`.
// Код кандидата не выполняется: внешние diff-драйверы, textconv и пользовательский
// конфиг Git отключены и выключены из окружения. Гейт ловит до запуска L3/L2:
// удаление/переименование тестов без явного допуска профиля, skip/only-маркеры,
// смену типа файла, ослабление проверок, подмену test-runner'а и утечку секретов.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalDigest } from './subject.mjs';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;

// Файл считается тестовым по типичным каталогам и суффиксам JS/TS/Python.
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.py$/;
// Удалённое определение тестового кейса: JS/TS test(, it(, describe( и Python def test_.
// Граница слева не допускает '.': вызов RegExp.test() не является тест-кейсом.
const TEST_DEF = /(?:^|[^\w$.])(?:it|test|describe)\s*\(|(?:^|[^\w$])def\s+test_/;
// Маркеры отключения/фокусировки тестов на добавленной строке.
const SKIP_MARK = /\b(?:it|test|describe|context|xit|xtest)\s*\.\s*(?:skip|only)\s*\(|\.only\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)|@?unittest\.skip|@skip\b/;
// Проверки/утверждения: удаление без замены — ослабление гейта.
const ASSERT_MARK = /\bassert\b|\bexpect\s*\(|\.assert\w*\s*\(/;
// Строка- комментарий не является действующей проверкой.
const COMMENT_MARK = /^\s*(?:\/\/|#|\*|<!--)/;
// Содержательная проверка: сравнение, исключение или предикат expect(...).to*.
const STRONG_ASSERT = /\bassert[\w.]*\s*\([^)]*(?:==|!=|>=|<=|>|<|\b(?:not\s+)?in\b|\b(?:raise|throws?|error)\w*\b)|\bassert[\w.]*(?:equal|strict|throws?|raises?|match|regex|contain|instance|true|false|close)\w*\s*\(|\bexpect\s*\([^)]*\)\s*\.\s*to\w+/i;
// Тривиальное утверждение на месте содержательного — ослабление, а не проверка.
const TRIVIAL_ASSERT = /\bassert\s*\(\s*(?:true|1)\s*\)|\bassert\s+True\b|\bexpect\s*\(\s*true\s*\)|\.assertTrue\s*\(\s*True/;
// Файлы, из которых запускаются проверки.
const RUNNER_FILE = /(^|\/)(package\.json|Makefile|makefile|scripts?\/)|\.(?:ya?ml|sh|ps1|bat)$/;
// Подмена результата проверки: принудительный нулевой код или «… || true».
const EXIT_OK = /\bexit\s+0\b|\|\|\s*(?:true|:)\b/;
// Скрипт "test" в package.json перестал вызывать исполнитель тестов.
const TEST_SCRIPT = /"test"\s*:\s*"([^"]*)"/;
const RUNS_TESTS = /test|jest|mocha|vitest|pytest|tap\b|ava\b/;

const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private_key'],
  [/ghp_[A-Za-z0-9]{20,}/, 'github_token'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'github_token'],
  [/sk-[A-Za-z0-9]{20,}/, 'api_key'],
  [/AKIA[0-9A-Z]{16}/, 'aws_access_key'],
  [/BOARD_TOKEN\s*=\s*\S+/, 'board_token'],
];

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Разбор unified=0 diff: метаданные Git (rename/mode/deleted) и построчные нарушения.
// Возвращает стабильно отсортированный список { kind, file, line, detail }.
export function analyzeDiff(diff, { allowTestDeletion = false } = {}) {
  const violations = [];
  const asserts = new Map();
  // Состояние текущего блока diff: имена берутся из заголовков и метаданных Git,
  // а не из текста строк — строка содержимого не может быть принята за заголовок.
  let oldName = null;
  let file = null;
  let deleted = false;
  let oldMode = null;
  let newMode = null;
  let renameFrom = null;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  const testScripts = new Map();
  const push = (kind, line, detail, target = file) => violations.push({ kind, file: target, line, detail });
  const tallyFor = (map, name, entry) => {
    const tally = map.get(name) ?? { removed: [], added: [], strongRemoved: 0, strongAdded: 0 };
    map.set(name, tally);
    return tally;
  };
  const assertTally = (side, line) => {
    // Комментарии не считаются ни удалённой, ни добавленной проверкой.
    if (!ASSERT_MARK.test(side) || COMMENT_MARK.test(side)) return null;
    return tallyFor(asserts, file, line);
  };

  for (const raw of String(diff).split('\n')) {
    if (raw.startsWith('diff --git ')) {
      oldName = null;
      file = null;
      deleted = false;
      oldMode = null;
      newMode = null;
      renameFrom = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith('rename from ')) {
      renameFrom = raw.slice(12);
      continue;
    }
    if (!inHunk && raw.startsWith('rename to ')) {
      file = raw.slice(10);
      continue;
    }
    if (!inHunk && raw.startsWith('old mode ')) {
      oldMode = raw.slice(9).trim();
      continue;
    }
    if (!inHunk && raw.startsWith('new mode ')) {
      newMode = raw.slice(9).trim();
      continue;
    }
    if (!inHunk && raw.startsWith('deleted file mode ')) {
      deleted = true;
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
      if (newName === '/dev/null') deleted = true;
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
      const tally = assertTally(text, oldLine);
      if (tally) {
        tally.removed.push(oldLine);
        if (STRONG_ASSERT.test(text)) tally.strongRemoved++;
      }
      if (RUNNER_FILE.test(file) && TEST_SCRIPT.test(text)) {
        tallyFor(testScripts, file).removed.push(oldLine);
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
      if (RUNNER_FILE.test(file)) {
        if (EXIT_OK.test(text)) push('gate_bypass', newLine, 'added forced success in check runner');
        const script = TEST_SCRIPT.exec(text);
        if (script && !RUNS_TESTS.test(script[1])) {
          push('gate_bypass', newLine, 'test script no longer runs tests');
        }
        if (script) tallyFor(testScripts, file).added.push(newLine);
      }
      const tally = assertTally(text, newLine);
      if (tally) {
        tally.added.push(newLine);
        if (STRONG_ASSERT.test(text)) tally.strongAdded++;
      }
      newLine++;
    } else {
      oldLine++;
      newLine++;
    }
  }

  // Метаданные последнего блока и всех предыдущих: учёт ведём в момент нового
  // 'diff --git', поэтому сверки делаем итоговым проходом по накопленным записям.
  // (Ниже — повторный линейный проход только по заголовкам блоков.)
  let metaFile = null;
  let metaOld = null;
  let metaDeleted = false;
  let metaOldMode = null;
  let metaNewMode = null;
  let metaRenamedFrom = null;
  const flushMeta = () => {
    const subject = metaFile ?? metaOld;
    if (subject === null || subject === undefined) return;
    const isTest = TEST_FILE.test(subject) || (metaRenamedFrom !== null && TEST_FILE.test(metaRenamedFrom));
    if (!isTest) return;
    const renamedOut = metaRenamedFrom !== null && TEST_FILE.test(metaRenamedFrom) && !TEST_FILE.test(subject);
    if ((metaDeleted || renamedOut) && !allowTestDeletion) {
      push('test_file_deleted', 0,
        metaRenamedFrom !== null ? `test file ${metaRenamedFrom} renamed to ${subject}` : `deleted test file ${subject}`,
        metaRenamedFrom ?? subject);
    }
    // Нерегулярный новый режим (symlink 120000, gitlink 160000) на тестовом
    // файле — смена типа, вне зависимости от прежнего режима.
    if (metaNewMode !== null && metaNewMode !== '100644' && metaNewMode !== '100755' &&
        metaOldMode !== metaNewMode) {
      push('file_type_changed', 0, `test file ${subject} changed type ${metaOldMode} -> ${metaNewMode}`, subject);
    }
  };
  // Второй проход ведёт учёт hunk-состояния: удалённая строка, чей текст
  // совпадает с заголовком ('--- a/...', 'rename from ...'), не меняет метаданные.
  let metaInHunk = false;
  for (const raw of String(diff).split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flushMeta();
      // Имена файлов — из заголовка блока: у бинарных/пустых удалений может
      // вообще не быть '---'/'+++', а у переименований — свои rename-строки.
      const names = /^diff --git a\/(.+) b\/(.+)$/.exec(raw.replaceAll('"', ''));
      metaFile = null;
      metaOld = names ? names[1] : null;
      if (names) metaFile = names[2];
      metaDeleted = false;
      metaOldMode = null;
      metaNewMode = null;
      metaRenamedFrom = null;
      metaInHunk = false;
      continue;
    }
    if (metaInHunk) continue;
    if (raw.startsWith('@@')) { metaInHunk = true; continue; }
    if (raw.startsWith('rename from ')) { metaRenamedFrom = raw.slice(12); continue; }
    if (raw.startsWith('rename to ')) { metaFile = raw.slice(10); continue; }
    if (raw.startsWith('deleted file mode ')) { metaDeleted = true; continue; }
    if (raw.startsWith('new file mode ')) { metaNewMode = raw.slice(14).trim(); continue; }
    if (raw.startsWith('old mode ')) { metaOldMode = raw.slice(9).trim(); continue; }
    if (raw.startsWith('new mode ')) { metaNewMode = raw.slice(9).trim(); continue; }
    if (raw.startsWith('--- ')) { metaOld = raw.slice(4).trim().replace(/^a\//, ''); continue; }
    if (raw.startsWith('+++ ')) {
      const name = raw.slice(4).trim();
      if (name !== '/dev/null') metaFile = name.replace(/^b\//, '');
      continue;
    }
  }
  flushMeta();

  for (const [name, tally] of asserts) {
    if (tally.removed.length > tally.added.length) {
      violations.push({
        kind: 'assertion_weakened',
        file: name,
        line: tally.removed[tally.added.length],
        detail: `removed ${tally.removed.length} assertion(s), added ${tally.added.length}`,
      });
    } else if ((tally.strongRemoved ?? 0) > (tally.strongAdded ?? 0)) {
      violations.push({
        kind: 'assertion_weakened',
        file: name,
        line: tally.removed[0] ?? 0,
        detail: `strict assertions reduced ${tally.strongRemoved} -> ${tally.strongAdded ?? 0}`,
      });
    }
  }
  for (const [name, tally] of testScripts) {
    if (tally.removed.length > tally.added.length) {
      violations.push({
        kind: 'gate_bypass',
        file: name,
        line: tally.removed[0],
        detail: 'test script removed',
      });
    }
  }

  const order = { test_file_deleted: 0, test_deleted: 1, file_type_changed: 2, test_skipped: 3,
    assertion_weakened: 4, gate_bypass: 5, secret_leak: 6 };
  violations.sort((a, b) =>
    cmpStr(String(a.file), String(b.file)) ||
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
  // Детерминированный вызов: без внешних diff-драйверов, textconv и любого
  // пользовательского/репозиторного конфига; локаль и окружение зафиксированы.
  // Атрибуты читаются из пустого дерева: ни worktree/.gitattributes, ни
  // .git/info/attributes не могут скрыть текстовый diff (-diff) или включить
  // внешний драйвер кандидата.
  const { stdout } = await exec('git', ['-C', worktree,
    '-c', 'core.attributesFile=/dev/null',
    'diff', '--no-ext-diff', '--no-textconv', '--unified=0', `${base_sha}..${candidate_sha}`],
    {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_LOCAL: '/dev/null',
        GIT_CONFIG_COUNT: '0',
        GIT_ATTR_SOURCE: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      },
    });
  const violations = analyzeDiff(stdout, {
    allowTestDeletion: profile?.allowTestDeletion === true,
  });
  const report = { ok: violations.length === 0, sha: candidate_sha, base_sha, violations };
  return { ...report, digest: canonicalDigest(report) };
}
