// Механический Branch Drift Preflight (V2-3): до постановки карточки на
// Board проверяет, что в репозитории нет невлитых веток, пересекающихся с
// затрагиваемыми путями задачи, и грязных/бесхозных worktree — в первую
// очередь брошенных bb/thr_* сессий. Строго механическая инспекция git:
// никаких мутаций, fail-closed через assertNoBranchDrift.
//
// execGit — инъекция для тестов: (args, cwd) => Promise<stdout>.
// Дефолт — реальный `git` с таймаутом.
import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_HARDENING = Object.freeze([
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=',
]);
const hardenedGitArgs = args =>
  GIT_HARDENING.every((value, index) => args[index] === value) ? args : [...GIT_HARDENING, ...args];

const defaultExecGit = async (args, cwd) =>
  (await execFileAsync('git', hardenedGitArgs(args), { cwd, timeout: 20_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })).stdout;

const BB_THREAD_BRANCH = /^bb\/thr_[a-z0-9]+/;
const HC_WORKER_BRANCH = /^(?:feat\/)?df-[^/]+/;
const SUBPROC_WORKER_BRANCH = /^subproc-[^/]+/;

const portablePathKind = path => {
  const base = posix.basename(String(path ?? ''));
  if (/^df-[^/]+/.test(base)) return 'hc';
  if (/^subproc-[^/]+/.test(base)) return 'subproc';
  return null;
};

export function classifyWorkerSession({ branch, path } = {}) {
  if (BB_THREAD_BRANCH.test(branch ?? '') || /thr_/.test(path ?? '')) return 'bb';
  if (HC_WORKER_BRANCH.test(branch ?? '') || portablePathKind(path) === 'hc') return 'hc';
  if (SUBPROC_WORKER_BRANCH.test(branch ?? '') || portablePathKind(path) === 'subproc') return 'subproc';
  return null;
}

// git worktree list --porcelain → [{ path, head, branch, detached }]
export function parseWorktreeList(text) {
  const worktrees = [];
  let current = null;
  for (const line of `${text}\n`.split('\n')) {
    if (line === '') {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice(9), head: null, branch: null, detached: false };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (current && line === 'detached') {
      current.detached = true;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

const parsePorcelainStatus = text =>
  text.split('\n').filter(line => line.trim()).map(line => line.slice(3).trim());

// Канонизация touch-пути: убрать ведущий ./ и завершающий /, нормализовать
// posix-разделители — './ops', 'ops/' и 'ops' ведут себя идентично.
const normalizeTouchPath = tp => {
  let p = posix.normalize(String(tp));
  while (p.startsWith('./')) p = p.slice(2);
  if (p !== '/') p = p.replace(/\/+$/, '');
  return p;
};

// Пересечение изменённого файла с touchPaths (директория или файл).
const touches = (file, touchPaths) =>
  touchPaths.some(raw => {
    const tp = normalizeTouchPath(raw);
    return file === tp || file.startsWith(`${tp}/`) || tp === '.' || tp === '';
  });

export async function inspectWorktreesAndBranches({
  repoDir,
  baseRef = 'HEAD',
  touchPaths = [],
  execGit = defaultExecGit,
} = {}) {
  if (typeof repoDir !== 'string' || !repoDir) throw new Error('repo_dir_required');
  if (!Array.isArray(touchPaths)) throw new Error('touch_paths_invalid');
  // baseRef начинающийся с '-' — инъекция git-опции, fail-closed.
  if (String(baseRef).startsWith('-')) throw new Error('base_ref_invalid');

  const worktreeText = await execGit(['worktree', 'list', '--porcelain'], repoDir);
  const worktrees = parseWorktreeList(worktreeText);

  const dirtyWorktrees = [];
  const bbThreadWorktrees = [];
  const workerWorktrees = [];
  for (const wt of worktrees) {
    const statusText = await execGit(hardenedGitArgs(['status', '--porcelain']), wt.path)
      .catch(() => null);
    // Worktree недоступен/удалён из-под git — считаем грязным (fail-closed).
    const dirtyFiles = statusText === null ? ['<status_unavailable>']
      : parsePorcelainStatus(statusText);
    const workerKind = classifyWorkerSession(wt);
    const isBbThread = workerKind === 'bb';
    if (isBbThread) {
      bbThreadWorktrees.push({ path: wt.path, branch: wt.branch,
        dirty: dirtyFiles.length > 0, dirtyCount: dirtyFiles.length });
    }
    if (workerKind) {
      workerWorktrees.push({ path: wt.path, branch: wt.branch, workerKind,
        dirty: dirtyFiles.length > 0, dirtyCount: dirtyFiles.length });
    }
    if (dirtyFiles.length) {
      dirtyWorktrees.push({ path: wt.path, branch: wt.branch, head: wt.head,
        dirty: true, dirtyFiles, dirtyCount: dirtyFiles.length, isBbThread, workerKind });
    }
  }

  // Ошибка инспекции веток — fail-closed, не «нет дрейфа».
  const branchText = await execGit(['branch', '--no-merged', baseRef,
    '--format=%(refname:short)'], repoDir)
    .catch(error => { throw Object.assign(new Error('drift_check_unavailable'),
      { cause: error }); });
  const unmergedBranches = [];
  for (const branch of branchText.split('\n').map(b => b.trim()).filter(Boolean)) {
    // Текущая HEAD-ветка сама себе «влита»; git уже её отфильтровал.
    // '--' отделяет ревизии от путей — ветка не может притвориться опцией/путём.
    // -z: NUL-разделённые сырые пути без quoting — переименованные файлы и
    // имена с переводами строк/кавычками не могут уйти от детекции дрейфа;
    // --no-renames: rename не схлопывается в 'old => new', оба пути видимы.
    const diffText = await execGit(hardenedGitArgs(['diff', '--no-renames', '--name-only', '-z',
      `${baseRef}...${branch}`, '--']), repoDir).catch(() => null);
    const files = diffText === null ? ['<diff_unavailable>'] : diffText.split('\0').filter(Boolean);
    // diff недоступен → считаем пересечением (fail-closed), не тихий ok:true.
    const intersects = diffText === null || touchPaths.length === 0 ||
      files.some(f => touches(f, touchPaths));
    if (intersects) {
      const workerKind = classifyWorkerSession({ branch });
      unmergedBranches.push({ branch,
        files: touchPaths.length && diffText !== null
          ? files.filter(f => touches(f, touchPaths)) : files,
        fileCount: files.length, isBbThread: workerKind === 'bb', workerKind });
    }
  }

  const driftDetected = unmergedBranches.length > 0 || dirtyWorktrees.length > 0;
  const summary = [
    `${unmergedBranches.length} unmerged branch(es)`,
    `${dirtyWorktrees.length} dirty worktree(s)`,
    `${bbThreadWorktrees.length} bb/thr_* worktree(s)`,
    `${workerWorktrees.length} worker worktree(s)`,
    touchPaths.length ? `touchPaths: ${touchPaths.join(', ')}` : 'touchPaths: <all>',
  ].join('; ');
  return { ok: !driftDetected, driftDetected, baseRef, unmergedBranches,
    dirtyWorktrees, bbThreadWorktrees, workerWorktrees, summary };
}

// Fail-closed: drift && !allowDrift → Error('branch_drift_detected')
// с полем error.drift = полный отчёт инспекции.
export async function assertNoBranchDrift({ repoDir, baseRef, touchPaths,
  allowDrift = false, execGit } = {}) {
  const report = await inspectWorktreesAndBranches({ repoDir, baseRef,
    touchPaths, execGit });
  if (report.driftDetected && !allowDrift) {
    const error = new Error('branch_drift_detected');
    error.drift = report;
    throw error;
  }
  return report;
}
