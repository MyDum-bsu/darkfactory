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

// Нецелевое падение красного прогона: инфраструктурные коды выхода и ошибки
// синтаксиса/импорта/модуля — тест не дошёл до целевого утверждения.
const NON_TARGET = /SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|Cannot find module|ImportError|ModuleNotFoundError|IndentationError/;
export function isNonTargetFailure(output, exitCode) {
  return [125, 126, 127].includes(exitCode) || NON_TARGET.test(String(output ?? ''));
}

function defaultGit(worktree) {
  return (...args) => execFileSync('git', ['-C', worktree, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
}

function artifact({ redSha, testDiff, redExitCode, failureReasonDigest, touchesProdCode }) {
  const data = { type: 'test-first', redSha, testDiff, redExitCode, failureReasonDigest, touchesProdCode };
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
  const changedFiles = String(await run('diff', '--name-only', `${baseSha}..${redSha}`))
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
  if (!Number.isSafeInteger(red?.exitCode) || isNonTargetFailure(red.output, red.exitCode)) {
    return { verdict: 'REWORK', reason: 'test_first_non_target_failure', changedTestFiles: changedFiles,
      ...artifact({ redSha, testDiff, redExitCode: Number.isSafeInteger(red?.exitCode) ? red.exitCode : 127,
        failureReasonDigest, touchesProdCode: false }) };
  }
  const green = await runTest({ sha: candidateSha, changedTestFiles: changedFiles });
  if (green?.exitCode !== 0) {
    return { verdict: 'REWORK', reason: 'test_first_candidate_failed', changedTestFiles: changedFiles,
      ...artifact({ redSha, testDiff, redExitCode: red.exitCode, failureReasonDigest,
        touchesProdCode: false }) };
  }
  return { verdict: 'PASS', reason: null, changedTestFiles: changedFiles,
    ...artifact({ redSha, testDiff, redExitCode: red.exitCode, failureReasonDigest,
      touchesProdCode: false }) };
}
