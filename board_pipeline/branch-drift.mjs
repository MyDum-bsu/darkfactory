// Механический Branch Drift Preflight (V2-3): до постановки карточки на
// Board проверяет, что в репозитории нет невлитых веток, пересекающихся с
// затрагиваемыми путями задачи, и грязных/бесхозных worktree — в первую
// очередь брошенных bb/thr_* сессий. Строго механическая инспекция git:
// никаких мутаций, fail-closed через assertNoBranchDrift.
//
// execGit — инъекция для тестов: (args, cwd) => Promise<stdout>.
// Дефолт — реальный `git` с таймаутом.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const defaultExecGit = async (args, cwd) =>
  (await execFileAsync('git', args, { cwd, timeout: 20_000 })).stdout;

const BB_THREAD_BRANCH = /^bb\/thr_[a-z0-9]+/;

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

// Пересечение изменённого файла с touchPaths (директория или файл).
const touches = (file, touchPaths) =>
  touchPaths.some(tp => file === tp || file.startsWith(`${tp}/`) ||
    tp === '.' || tp === '');

export async function inspectWorktreesAndBranches({
  repoDir,
  baseRef = 'HEAD',
  touchPaths = [],
  execGit = defaultExecGit,
} = {}) {
  if (typeof repoDir !== 'string' || !repoDir) throw new Error('repo_dir_required');
  if (!Array.isArray(touchPaths)) throw new Error('touch_paths_invalid');

  const worktreeText = await execGit(['worktree', 'list', '--porcelain'], repoDir);
  const worktrees = parseWorktreeList(worktreeText);

  const dirtyWorktrees = [];
  const bbThreadWorktrees = [];
  for (const wt of worktrees) {
    const statusText = await execGit(['status', '--porcelain'], wt.path)
      .catch(() => null);
    // Worktree недоступен/удалён из-под git — считаем грязным (fail-closed).
    const dirtyFiles = statusText === null ? ['<status_unavailable>']
      : parsePorcelainStatus(statusText);
    const isBbThread = BB_THREAD_BRANCH.test(wt.branch ?? '') || /thr_/.test(wt.path);
    if (isBbThread) {
      bbThreadWorktrees.push({ path: wt.path, branch: wt.branch,
        dirty: dirtyFiles.length > 0, dirtyCount: dirtyFiles.length });
    }
    if (dirtyFiles.length) {
      dirtyWorktrees.push({ path: wt.path, branch: wt.branch, head: wt.head,
        dirty: true, dirtyFiles, dirtyCount: dirtyFiles.length, isBbThread });
    }
  }

  const branchText = await execGit(['branch', '--no-merged', baseRef,
    '--format=%(refname:short)'], repoDir).catch(() => '');
  const unmergedBranches = [];
  for (const branch of branchText.split('\n').map(b => b.trim()).filter(Boolean)) {
    // Текущая HEAD-ветка сама себе «влита»; git уже её отфильтровал.
    const diffText = await execGit(['diff', '--name-only', `${baseRef}...${branch}`], repoDir)
      .catch(() => null);
    const files = diffText === null ? ['<diff_unavailable>'] : diffText.split('\n').filter(Boolean);
    const intersects = touchPaths.length === 0 || files.some(f => touches(f, touchPaths));
    if (intersects) {
      unmergedBranches.push({ branch, files: touchPaths.length ? files.filter(f => touches(f, touchPaths)) : files,
        fileCount: files.length, isBbThread: BB_THREAD_BRANCH.test(branch) });
    }
  }

  const driftDetected = unmergedBranches.length > 0 || dirtyWorktrees.length > 0;
  const summary = [
    `${unmergedBranches.length} unmerged branch(es)`,
    `${dirtyWorktrees.length} dirty worktree(s)`,
    `${bbThreadWorktrees.length} bb/thr_* worktree(s)`,
    touchPaths.length ? `touchPaths: ${touchPaths.join(', ')}` : 'touchPaths: <all>',
  ].join('; ');
  return { ok: !driftDetected, driftDetected, baseRef, unmergedBranches,
    dirtyWorktrees, bbThreadWorktrees, summary };
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
