import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, posix } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;

async function git(worktree, ...args) {
  return (await exec('git', ['-C', worktree, ...args], { timeout: 20_000 })).stdout.trimEnd();
}

export function worktreeInspector(policy) {
  return async handoff => {
    const profile = policy.profiles[handoff.check_profile];
    if (handoff.worker_thread_id !== profile.worker || handoff.task_id !== profile.task ||
        handoff.base_sha !== profile.base || !isAbsolute(profile.worktree ?? '') ||
        handoff.worktree !== profile.worktree) {
      throw new Error('Handoff does not match the enrolled task, worker, worktree and base');
    }
    const worktree = await realpath(profile.worktree);
    if (await git(worktree, 'rev-parse', '--show-toplevel') !== worktree) {
      throw new Error('Enrolled path is not the Git worktree root');
    }
    if (await git(worktree, 'branch', '--show-current') !== profile.branch) {
      throw new Error('Enrolled feature branch changed');
    }
    const head = await git(worktree, 'rev-parse', 'HEAD');
    // Дерево именно кандидата (не HEAD): источник tree_sha для манифеста приёмки.
    const tree = await git(worktree, 'rev-parse', `${handoff.candidate_sha}^{tree}`);
    const clean = !(await git(worktree, 'status', '--porcelain=v1', '--untracked-files=all'));
    const baseAncestor = await git(worktree, 'merge-base', handoff.base_sha, head) === handoff.base_sha;
    return { head, tree, clean, baseAncestor };
  };
}

function checkCommand(recipe) {
  if (!IMAGE.test(recipe.image ?? '') || !Array.isArray(recipe.argv) || !recipe.argv.length ||
      !recipe.argv.every(arg => typeof arg === 'string' && arg.length > 0) ||
      !Number.isSafeInteger(recipe.timeoutMs) || recipe.timeoutMs <= 0 ||
      typeof recipe.cwd !== 'string' || posix.isAbsolute(recipe.cwd) ||
      recipe.cwd.split('/').includes('..')) {
    throw new Error('The operator check profile must pin an image, argv, relative cwd and timeout');
  }
  return recipe;
}

const HOST_SYSTEM_DIRS = new Set(['/usr', '/etc/fonts', '/etc/texmf', '/var/lib/texmf', '/opt/google/chrome']);
const SANDBOX_ENV = new Set(['PYTHONPATH', 'PYTHONDONTWRITEBYTECODE', 'MO_TRACKER_DATA', 'MO_TRACKER_DB']);

async function sandboxExtras(recipe, source) {
  const args = [];
  for (const { from, to } of recipe.mounts ?? []) {
    if (!isAbsolute(from ?? '') || await realpath(from) !== from || !(await lstat(from)).isDirectory()) {
      throw new Error('An operator dependency mount must be a canonical directory');
    }
    if ((to === '/deps' && basename(from) === 'site-packages') || (HOST_SYSTEM_DIRS.has(to) && from === to)) {
      args.push('--mount', `type=bind,src=${from},dst=${to},readonly`);
    } else if (to === '/candidate/tracker/web/node_modules' && basename(from) === 'node_modules') {
      const inside = join(source, 'tracker', 'web');
      if (await realpath(inside) !== inside) throw new Error('Dependency mount target crosses a symlink');
      await mkdir(join(inside, 'node_modules'));
      args.push('--mount', `type=bind,src=${from},dst=${to},readonly`);
    } else {
      throw new Error('An operator dependency mount is outside the allowlist');
    }
  }
  for (const [key, value] of Object.entries(recipe.env ?? {})) {
    if (!SANDBOX_ENV.has(key) || typeof value !== 'string') throw new Error('Unsupported test environment key');
    args.push('-e', `${key}=${value}`);
  }
  return args;
}

async function unpackExact(worktree, sha, archive, source) {
  await git(worktree, 'archive', '--format=tar', '-o', archive, sha);
  const output = await git(worktree, 'ls-tree', '-rz', sha);
  const entries = output.split('\0').filter(Boolean).map(entry => {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([^\n]+)$/.exec(entry);
    if (!match) throw new Error('Unsupported candidate tree entry (e.g. submodule)');
    return { mode: match[1], blob: match[2], path: match[3] };
  });
  const members = (await exec('tar', ['--quoting-style=literal', '-tf', archive], { timeout: 30_000 })).stdout
    .split('\n').filter(name => name && !name.endsWith('/')).sort();
  if (JSON.stringify(members) !== JSON.stringify(entries.map(entry => entry.path).sort())) {
    throw new Error('Git archive omitted tracked files or used unsupported paths');
  }
  await exec('tar', ['--no-same-owner', '--same-permissions', '-xf', archive, '-C', source], { timeout: 30_000 });
  for (const { mode, blob, path } of entries) {
    const file = join(source, path);
    const info = await lstat(file);
    const data = mode === '120000' && info.isSymbolicLink() ? Buffer.from(await readlink(file))
      : info.isFile() && mode !== '120000' ? await readFile(file) : null;
    if (!data || createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') !== blob) {
      throw new Error('Archived file bytes differ from the Git tree');
    }
  }
}

async function cleanupContainer(name) {
  try {
    await exec('docker', ['rm', '-f', name], { timeout: 15_000 });
  } catch (error) {
    if (!String(error.stderr).includes('No such container')) throw error;
  }
}

export function offlineDockerRunner(journal) {
  return async (handoff, profile) => {
    const recipe = checkCommand(profile.check ?? {});
    const { image, argv, cwd, timeoutMs } = recipe;
    if (!SHA.test(handoff.candidate_sha)) throw new Error('Local runner requires a full SHA');
    const security = JSON.parse((await exec('docker', ['info', '--format', '{{json .SecurityOptions}}'], {
      timeout: 12_000,
    })).stdout);
    if (!security.includes('name=rootless')) throw new Error('The test runner requires rootless Docker');

    const scratch = await mkdtemp(join(tmpdir(), 'board-check-'));
    const name = `board-check-${randomUUID()}`;
    try {
      const archive = join(scratch, 'candidate.tar');
      const source = join(scratch, 'candidate');
      await mkdir(source);
      // The scratch parent stays private; only the mounted checkout is traversable to the mapped UID.
      await chmod(source, 0o755);
      await unpackExact(handoff.worktree, handoff.candidate_sha, archive, source);
      const extras = await sandboxExtras(recipe, source);
      const args = ['run', '--rm', '--name', name, '--pull=never', '--network=none', '--read-only',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
        '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777', '-e', 'HOME=/tmp',
        '--mount', `type=bind,src=${source},dst=/candidate,readonly`, ...extras,
        '--workdir', posix.join('/candidate', cwd), image, ...argv];
      let output;
      let exit = 0;
      try {
        const run = await exec('docker', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
        output = `${run.stdout}${run.stderr}`;
      } catch (error) {
        exit = typeof error.code === 'number' ? error.code : null;
        output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      } finally {
        await cleanupContainer(name);
      }
      const file = `checks-${handoff.task_id}-${handoff.candidate_sha}-${randomUUID()}.log`;
      await writeFile(join(journal, file), output, { flag: 'wx', mode: 0o600 });
      return {
        sha: handoff.candidate_sha, ok: exit === 0,
        evidence: { file, sha256: createHash('sha256').update(output).digest('hex'), exit },
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}

// Недоверенные артефакты L3 ограничены по числу и объёму: контейнер не может
// исчерпать память контроллера или диск журнала безразмерной выгрузкой.
const ARTIFACT_MAX_FILES = 64;
const ARTIFACT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const ARTIFACT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

// Сбор артефактов из rw-каталога контейнера в приватный журнал: только регулярные
// файлы, побайтово, с sha256 и лимитами. Перебор идёт потоково через opendir —
// список имён не загружается целиком и обрывается на первом превышении лимита.
export async function collectVisualArtifacts(dropped, journal, binding) {
  const { opendir } = await import('node:fs/promises');
  const entries = [];
  for await (const entry of await opendir(dropped)) {
    if (entries.length >= ARTIFACT_MAX_FILES) {
      throw new Error('Visual artifacts exceed the count or byte limits');
    }
    entries.push(entry.name);
  }
  const artifacts = [];
  let total = 0;
  for (const entry of entries.sort()) {
    const from = join(dropped, entry);
    const info = await lstat(from);
    if (!info.isFile()) continue;
    if (info.size > ARTIFACT_MAX_FILE_BYTES || total + info.size > ARTIFACT_MAX_TOTAL_BYTES) {
      throw new Error('Visual artifacts exceed the count or byte limits');
    }
    const data = await readFile(from);
    const safe = basename(entry).replace(/[^A-Za-z0-9_.-]/g, '_');
    const stored = `visual-artifact-${binding.task_id}-${binding.candidate_sha}-${randomUUID()}-${safe}`;
    await writeFile(join(journal, stored), data, { flag: 'wx', mode: 0o600 });
    total += data.length;
    artifacts.push({ name: stored, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length });
  }
  return artifacts;
}

// L3 визуальный гейт: та же изоляция rootless Docker, плюс каталог артефактов,
// смонтированный rw только для выгрузки скриншотов в приватный журнал контроллера.
export function offlineVisualRunner(journal) {
  return async (binding, profile) => {
    const recipe = checkCommand(profile.visual ?? {});
    const { image, argv, cwd, timeoutMs } = recipe;
    if (!SHA.test(binding.candidate_sha)) throw new Error('Visual runner requires a full SHA');
    const security = JSON.parse((await exec('docker', ['info', '--format', '{{json .SecurityOptions}}'], {
      timeout: 12_000,
    })).stdout);
    if (!security.includes('name=rootless')) throw new Error('The visual runner requires rootless Docker');

    const scratch = await mkdtemp(join(tmpdir(), 'board-visual-'));
    const name = `board-visual-${randomUUID()}`;
    try {
      const archive = join(scratch, 'candidate.tar');
      const source = join(scratch, 'candidate');
      const dropped = join(scratch, 'artifacts');
      await mkdir(source);
      await chmod(source, 0o755);
      // Единственная rw-точка контейнера вне tmpfs: выгрузка артефактов рендера.
      await mkdir(dropped, { mode: 0o777 });
      await chmod(dropped, 0o777);
      await unpackExact(binding.worktree, binding.candidate_sha, archive, source);
      const extras = await sandboxExtras(recipe, source);
      // Лимиты при записи, а не только при сборе: fsize капает размер одного
      // файла, tmpfs /tmp ограничен по объёму, а сторож суммарного объёма
      // /artifacts убивает контейнер при выходе за бюджет журнала.
      const args = ['run', '--rm', '--name', name, '--pull=never', '--network=none', '--read-only',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
        '--ulimit', `fsize=${ARTIFACT_MAX_FILE_BYTES}:${ARTIFACT_MAX_FILE_BYTES}`,
        '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777,size=64m', '-e', 'HOME=/tmp',
        '--mount', `type=bind,src=${source},dst=/candidate,readonly`,
        '--mount', `type=bind,src=${dropped},dst=/artifacts`, ...extras,
        '--workdir', posix.join('/candidate', cwd), image, ...argv];
      let output;
      let exit = 0;
      let oversized = false;
      const guard = setInterval(async () => {
        try {
          const usage = (await exec('du', ['-sb', dropped], { timeout: 5_000 })).stdout;
          if (Number.parseInt(usage, 10) > ARTIFACT_MAX_TOTAL_BYTES) {
            oversized = true;
            await exec('docker', ['kill', name], { timeout: 5_000 }).catch(() => {});
          }
        } catch { /* Пропуск тика сторожа не открывает гейт. */ }
      }, 250);
      try {
        const run = await exec('docker', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
        output = `${run.stdout}${run.stderr}`;
      } catch (error) {
        exit = typeof error.code === 'number' ? error.code : null;
        output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      } finally {
        clearInterval(guard);
        await cleanupContainer(name);
      }
      if (oversized) throw new Error('visual_artifacts_oversized');
      // Коды 125/126/127 (и невозможность получить код) — проверка не состоялась:
      // контейнер не запустился или команда не найдена. Это среда, не дефект кандидата.
      if (exit === null || exit === 125 || exit === 126 || exit === 127) {
        throw new Error(`visual_runner_not_executed:${String(output).slice(-200)}`);
      }
      const file = `visual-${binding.task_id}-${binding.candidate_sha}-${randomUUID()}.log`;
      await writeFile(join(journal, file), output, { flag: 'wx', mode: 0o600 });
      const artifacts = await collectVisualArtifacts(dropped, journal, binding);
      return {
        sha: binding.candidate_sha, ok: exit === 0, status: exit === 0 ? 'pass' : 'fail',
        artifacts,
        evidence: { file, sha256: createHash('sha256').update(output).digest('hex'), exit },
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}

export function offlineProfileRunner(journal) {
  const check = offlineDockerRunner(journal);
  return async (handoff, profile) => {
    if (!Array.isArray(profile.checks) || !profile.checks.length) throw new Error('An approved check list is required');
    const evidence = [];
    for (const recipe of profile.checks) {
      const result = await check(handoff, { check: recipe });
      evidence.push(result.evidence);
      if (!result.ok) return { sha: result.sha, ok: false, evidence };
    }
    return { sha: handoff.candidate_sha, ok: true, evidence };
  };
}

// Only the operator chooses this trusted verifier. The handoff cannot supply a receipt or command.
export function nativeReviewVerifier(gate, prompt, { permissionMode } = {}) {
  if (!isAbsolute(gate ?? '')) throw new Error('Configure the absolute board-review.mjs path');
  if (prompt !== undefined && !isAbsolute(prompt)) throw new Error('Review prompt must be an operator file');
  return async handoff => {
    const args = ['--task', handoff.task_id, '--sha', handoff.candidate_sha];
    if (prompt) {
      const modeArgs = [];
      if (permissionMode) {
        const { stdout } = await exec('bb', ['provider', 'list', '--json'], { timeout: 12_000 });
        const pi = JSON.parse(stdout).find(provider => provider.id === 'pi');
        if (!pi?.capabilities?.permissionModes?.includes(permissionMode)) {
          throw new Error(`review_permission_mode_unavailable:pi:${permissionMode}`);
        }
        modeArgs.push('--permission-mode', permissionMode);
      }
      const launch = await exec(process.execPath, [gate, 'launch', ...args,
        '--source', handoff.worker_thread_id, '--prompt-file', prompt, ...modeArgs], { timeout: 70_000 });
      const { threadId } = JSON.parse(launch.stdout);
      if (!/^thr_[a-z0-9]+$/.test(threadId ?? '')) throw new Error('No verified BB review launch');
      await exec('bb', ['thread', 'wait', threadId, '--status', 'idle', '--timeout', '8m', '--json'], {
        timeout: 490_000,
      });
    }
    const { stdout } = await exec(process.execPath, [gate, 'verify', ...args], { timeout: 70_000 });
    return JSON.parse(stdout);
  };
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
