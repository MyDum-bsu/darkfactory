import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Host-адаптер контракта Test First: красный тест-коммит (redSha) только с
// тестовыми файлами падает целевым образом, кандидат (candidateSha) зелёный.
// Адаптер — доверенный наблюдатель: его артефакт проходит проверку
// artifactVerdict('test-first', ...) в stage-verifier.

const SHA = /^[a-f0-9]{40}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Тестовый файл: сегмент каталога test/tests/__tests__/__spec__ либо имя
// вида *.test.*, *.spec.*, test_*.py, *_test.* — всё остальное прод-код.
export function isTestFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('..') || filePath.startsWith('/')) {
    return false;
  }
  const segments = filePath.split('/');
  const base = segments.at(-1);
  return segments.slice(0, -1).some(s => ['test', 'tests', '__tests__', '__spec__', 'spec'].includes(s)) ||
    /(?:^test_|_test\.|\.test\.|\.spec\.|_spec\.)/.test(base);
}

// Нецелевое падение красного прогона: инфраструктурные коды выхода, ошибки
// синтаксиса/импорта/модуля и краши JS-runtime (TypeError и прочие) — тест
// не дошёл до целевого утверждения: TAP 'not ok' от setup-crash без доказанного
// провала ассерта целевым падением не считается.
const NON_TARGET = /SyntaxError|TypeError|ReferenceError|RangeError|EvalError|URIError|AggregateError|ERR_MODULE_NOT_FOUND|Cannot find module|ImportError|ModuleNotFoundError|IndentationError|uncaughtException|Unhandled/;
// Целевое падение теста — код выхода раннера на assertion-failure. Коды 125+
// — инфраструктурная зона (125-127 коды оболочки/раннера, 128+ сигналы,
// включая 139 SIGSEGV): авария не доказывает целевую проверку — non-target.
export function isNonTargetFailure(output, exitCode) {
  return !Number.isSafeInteger(exitCode) || exitCode >= 125 ||
    NON_TARGET.test(String(output ?? ''));
}

// Позитивное доказательство целевого падения: вывод красного прогона обязан
// нести маркер именно тестового failure. Голое слово failure/failed вне
// тестового контекста (setup failure, deploy failed) не считается: маркеры
// — assert/expect-строки, TAP not ok, счётчики вида "N failed/failing",
// заголовки Failures: и FAIL-строки раннеров (регистрозависимо).
const TARGET_FAILURE = /assert|expect|not ok\b|✗|✘|panic:|\d+\s+(?:tests?\s+)?(?:failed|failing|failures?)|tests?\s+failed|Failures?:/i;
const TAP_FAIL = /\bFAIL(?:ED|URES?)?\b/;
export function isTargetFailure(output, exitCode) {
  if (isNonTargetFailure(output, exitCode)) return false;
  const text = String(output ?? '');
  return TARGET_FAILURE.test(text) || TAP_FAIL.test(text);
}

function defaultGit(worktree) {
  return (...args) => execFileSync('git', ['-C', worktree, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
}

// candidateExitCode — обязательное поле свидетельства: null, когда прогон
// кандидата не выполнялся (ранние отказы до него). Верификатор PASS требует
// ровно 0 — артефакт красного кандидата никогда не верифицируется зелёным.
function artifact({ redSha, testDiff, redExitCode, failureReasonDigest, touchesProdCode,
  candidateExitCode = null }) {
  const data = { type: 'test-first', redSha, testDiff, redExitCode, failureReasonDigest,
    touchesProdCode, candidateExitCode };
  const artifactBytes = Buffer.from(JSON.stringify(data));
  return { artifact: data, artifactBytes, artifactDigest: sha256(artifactBytes) };
}

export async function verifyTestFirst({ worktree, baseSha, redSha, candidateSha, runTest, git } = {}) {
  if (typeof worktree !== 'string' || !worktree || typeof runTest !== 'function') {
    throw new Error('test_first_ancestry_invalid');
  }
  if (!SHA.test(baseSha ?? '') || !SHA.test(redSha ?? '') || !SHA.test(candidateSha ?? '') ||
      redSha === candidateSha) {
    throw new Error('test_first_ancestry_invalid');
  }
  const run = typeof git === 'function' ? git : defaultGit(worktree);
  const ancestor = async (parent, child) => {
    try { await run('merge-base', '--is-ancestor', parent, child); return true; }
    catch { return false; }
  };
  if (!await ancestor(baseSha, redSha) || !await ancestor(redSha, candidateSha)) {
    throw new Error('test_first_ancestry_invalid');
  }
  const diffText = await run('diff', `${baseSha}..${redSha}`);
  // --no-renames: прод-файл, «переименованный» в тестовый путь, обязан
  // видеться как удаление прод-пути — иначе tests-only проверка слепа к
  // источнику rename.
  const changedFiles = String(await run('diff', '--no-renames', '--name-only', `${baseSha}..${redSha}`))
    .split('\n').map(line => line.trim()).filter(Boolean);
  const testDiff = sha256(Buffer.from(String(diffText)));
  if (!changedFiles.length) {
    const red = { exitCode: 1, output: 'empty red diff' };
    return { verdict: 'REWORK', reason: 'test_first_empty_diff', changedTestFiles: [],
      ...artifact({ redSha, testDiff, redExitCode: red.exitCode,
        failureReasonDigest: sha256(Buffer.from(red.output)), touchesProdCode: false }) };
  }
  if (changedFiles.some(file => !isTestFilePath(file))) {
    return { verdict: 'REWORK', reason: 'test_first_touches_prod_code', changedTestFiles: [],
      ...artifact({ redSha, testDiff, redExitCode: 1,
        failureReasonDigest: sha256(Buffer.from('touches prod code')), touchesProdCode: true }) };
  }
  const red = await runTest({ sha: redSha, changedTestFiles: changedFiles });
  const failureReasonDigest = sha256(Buffer.from(String(red?.output ?? '')));
  if (red?.exitCode === 0) {
    return { verdict: 'REWORK', reason: 'test_first_red_passed', changedTestFiles: changedFiles,
      ...artifact({ redSha, testDiff, redExitCode: 0, failureReasonDigest, touchesProdCode: false }) };
  }
  if (!isTargetFailure(red?.output, red?.exitCode)) {
    return { verdict: 'REWORK', reason: 'test_first_non_target_failure', changedTestFiles: changedFiles,
      ...artifact({ redSha, testDiff, redExitCode: Number.isSafeInteger(red?.exitCode) ? red.exitCode : 127,
        failureReasonDigest, touchesProdCode: false }) };
  }
  const green = await runTest({ sha: candidateSha, changedTestFiles: changedFiles });
  const greenExitCode = Number.isSafeInteger(green?.exitCode) ? green.exitCode : null;
  if (green?.exitCode !== 0) {
    return { verdict: 'REWORK', reason: 'test_first_candidate_failed', changedTestFiles: changedFiles,
      ...artifact({ redSha, testDiff, redExitCode: red.exitCode, failureReasonDigest,
        touchesProdCode: false, candidateExitCode: greenExitCode ?? 1 }) };
  }
  return { verdict: 'PASS', reason: null, changedTestFiles: changedFiles,
    ...artifact({ redSha, testDiff, redExitCode: red.exitCode, failureReasonDigest,
      touchesProdCode: false, candidateExitCode: 0 }) };
}
