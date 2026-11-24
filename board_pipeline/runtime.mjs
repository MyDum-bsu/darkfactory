import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { resolveL1Profile } from './l1-profiles.mjs';
import { holdoutDigest, sanitizeHoldoutFeedback, validateHoldoutDir } from './holdout-runner.mjs';
import { validatePngFile } from './visual-captures.mjs';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
// OCI-метка, которой доверенный образ L1-профиля аттестует себя.
const L1_IMAGE_LABEL = 'df.l1.profile';

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
export const SANDBOX_ENV = new Set(['PYTHONPATH', 'PYTHONDONTWRITEBYTECODE',
  'RUFF_CACHE_DIR', 'PYTEST_ADDOPTS', 'MO_TRACKER_DATA', 'MO_TRACKER_DB']);


export const MO_TRACKER_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 1440, height: 900, label: 'desktop' }),
  Object.freeze({ width: 1024, height: 768, label: 'compact-laptop' }),
]);

const SATISFACTION_COUNTERS = Object.freeze([
  ['unstyledControls', 'unstyled-control'],
  ['uncollapsedLongLists', 'uncollapsed-long-list'],
  ['missingStates', 'missing-state'],
  ['consoleErrors', 'console-error'],
  ['a11yViolations', 'a11y-violation'],
  ['a11yCritical', 'a11y-critical'],
  ['holdoutFailures', 'holdout-failure'],
]);

function viewportOf(value) {
  if (typeof value === 'string') {
    const match = /^([1-9][0-9]{2,4})x([1-9][0-9]{2,4})$/.exec(value);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  }
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height)) {
    return { width: value.width, height: value.height };
  }
  return null;
}

function requiredViewportsCovered(report) {
  const seen = new Set();
  const add = value => {
    const viewport = viewportOf(value);
    if (viewport) seen.add(`${viewport.width}x${viewport.height}`);
  };
  if (Array.isArray(report?.viewports)) for (const viewport of report.viewports) add(viewport);
  if (Array.isArray(report?.viewportResults)) {
    for (const result of report.viewportResults) add(result?.viewport ?? result);
  }
  add(report?.viewport);
  // Legacy machine artifacts encode only a count. Two or more captures satisfy
  // the generic contract; exact labels are enforced whenever they are supplied.
  if (!seen.size && Number.isSafeInteger(report?.viewports)) return report.viewports >= 2;
  return MO_TRACKER_VIEWPORTS.every(required => seen.has(`${required.width}x${required.height}`));
}

function counterValue(report, key) {
  const value = report?.[key];
  if (value === undefined && key === 'a11yCritical') return 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function detailCategory(value) {
  if (typeof value !== 'string') return '';
  const hyphenated = value.replaceAll('_', '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return {
    'unstyled-controls': 'unstyled-control',
    'uncollapsed-long-lists': 'uncollapsed-long-list',
    'missing-states': 'missing-state',
    'console-errors': 'console-error',
    'a11y-violations': 'a11y-violation',
    'a11y-criticals': 'a11y-critical',
    'holdout-failures': 'holdout-failure',
  }[hyphenated] ?? hyphenated;
}

// Deterministic UX satisfaction gate. It never consults prose: counters decide,
// and worker-facing defects carry only structured viewport/selector/coordinates.
export function evaluateSatisfactionReport(report) {
  const defects = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return Object.freeze({ verdict: 'REWORK', status: 'REWORK', defects: Object.freeze([
      Object.freeze({ category: 'malformed-report' })]) });
  }
  const sanitizedDetails = sanitizeHoldoutFeedback({ violations: report.violations }).failures;
  const detailed = category => sanitizedDetails.filter(item =>
    detailCategory(item.failed_assertion_category) === category || detailCategory(item.category) === category);
  let malformed = false;
  for (const [key, category] of SATISFACTION_COUNTERS) {
    const value = counterValue(report, key);
    if (value === null) {
      malformed = true;
      continue;
    }
    if (!value) continue;
    const matches = detailed(category);
    for (let index = 0; index < value; index++) {
      const detail = matches[index] ?? matches[0];
      defects.push(Object.freeze({ category,
        ...(detail?.viewport ? { viewport: detail.viewport } : {}),
        ...(detail?.selector ? { selector: detail.selector } : {}),
        ...(detail?.coordinates ? { coordinates: detail.coordinates } : {}) }));
    }
  }
  const score = report.satisfactionScore;
  if (!Number.isSafeInteger(score) || score < 0 || score > 100) malformed = true;
  else if (score < 85) defects.push(Object.freeze({ category: 'low-satisfaction-score' }));
  if (!requiredViewportsCovered(report)) defects.push(Object.freeze({ category: 'viewport-coverage-missing' }));
  if (malformed) defects.push(Object.freeze({ category: 'malformed-report' }));
  const verdict = defects.length ? 'REWORK' : 'PASS';
  return Object.freeze({ verdict, status: verdict, defects: Object.freeze(defects) });
}

function forbiddenTrackerDb(value) {
  if (typeof value !== 'string') return true;
  const normalized = value.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/^\.\//, '');
  return normalized === 'tracker/data/tracker.db' || normalized.endsWith('/tracker/data/tracker.db') ||
    /\/(?:home|Users|media)\//.test(normalized) || /production|live|pii/i.test(normalized);
}

export function assertSyntheticMoTrackerDb(path) {
  if (forbiddenTrackerDb(path)) throw new Error('mo_tracker_live_db_forbidden');
  if (isAbsolute(path) && !path.startsWith('/tmp/')) throw new Error('mo_tracker_synthetic_db_invalid');
  return path;
}

function pushOnce(argv, ...args) {
  if (!args.every(arg => argv.includes(arg))) argv.push(...args);
}

// Operator-facing recipe constructor for the MO Tracker UI L3 gate. The only
// database contract it can emit is an in-container synthetic SQLite path; a
// real tracker/data/tracker.db spelling, host path, production-looking path or
// PII-marked input is rejected before Docker is even considered.
export function buildUiVisualL3Profile({ image, argv, cwd = 'tracker/web', timeoutMs = 120_000,
  syntheticDbPath, databasePath, trackerDb, dbPath, syntheticDataDir = '/tmp/mo-tracker-synthetic',
  holdoutDir, l1Profile } = {}) {
  const supplied = [syntheticDbPath, databasePath, trackerDb, dbPath].filter(value => value !== undefined);
  if (new Set(supplied).size > 1) throw new Error('mo_tracker_synthetic_db_conflict');
  const db = assertSyntheticMoTrackerDb(supplied[0] ?? '/tmp/mo-tracker-synthetic/tracker.db');
  if (!Array.isArray(argv) || !argv.length || !argv.every(arg => typeof arg === 'string' && arg.length > 0) ||
      argv.some(arg => forbiddenTrackerDb(arg))) {
    throw new Error('mo_tracker_visual_recipe_invalid');
  }
  if (typeof syntheticDataDir !== 'string' || forbiddenTrackerDb(syntheticDataDir) ||
      (isAbsolute(syntheticDataDir) && !syntheticDataDir.startsWith('/tmp/'))) {
    throw new Error('mo_tracker_synthetic_data_invalid');
  }
  const visualArgv = [...argv];
  for (const viewport of MO_TRACKER_VIEWPORTS) {
    pushOnce(visualArgv, '--viewport', `${viewport.width}x${viewport.height}`);
  }
  pushOnce(visualArgv, '--capture-dir', '/artifacts/captures');
  pushOnce(visualArgv, '--axe-core-dump', '/artifacts/axe-core.json');
  pushOnce(visualArgv, '--require-states', 'loading,empty,error,ready');
  const visual = checkCommand({ image, argv: visualArgv, cwd, timeoutMs,
    env: { MO_TRACKER_DATA: syntheticDataDir, MO_TRACKER_DB: db },
    ...(holdoutDir !== undefined ? { holdoutDir } : {}),
    ...(l1Profile !== undefined ? { l1Profile } : {}) });
  return Object.freeze({
    id: 'mo-tracker-ui', has_ui: true,
    viewports: MO_TRACKER_VIEWPORTS,
    database: Object.freeze({ kind: 'synthetic', pii: false, containerPath: db }),
    capturePolicy: Object.freeze({ directory: 'captures', format: 'png', maxFileBytes: 2 * 1024 * 1024 }),
    a11y: Object.freeze({ tool: 'axe-core', dump: '/artifacts/axe-core.json', criticalLimit: 0 }),
    visual: Object.freeze({ ...visual, argv: Object.freeze([...visual.argv]), env: Object.freeze({ ...visual.env }) }),
  });
}

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

export async function unpackExact(worktree, sha, archive, source) {
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

async function cleanupContainer(name, execDocker = exec) {
  try {
    await execDocker('docker', ['rm', '-f', name], { timeout: 15_000 });
  } catch (error) {
    if (!String(error.stderr).includes('No such container')) throw error;
  }
}

// Доверенный образ профиля аттестует себя OCI-меткой L1_IMAGE_LABEL,
// встроенной его Dockerfile: ЯВНЫЙ выбор среды (profile.l1Profile или
// recipe.l1Profile) обязан реально соответствовать закреплённому
// recipe.image, иначе Node-only образ молча выполнил бы проверки под
// python-node.
async function imageL1Label(recipe, execDocker) {
  let labels;
  try {
    labels = JSON.parse((await execDocker('docker',
      ['image', 'inspect', recipe.image, '--format', '{{json .Config.Labels}}'],
      { timeout: 12_000 })).stdout);
  } catch (error) {
    throw new Error(`l1_image_uninspectable:${String(error?.stderr ?? error?.message ?? error)}`);
  }
  return labels?.[L1_IMAGE_LABEL];
}

async function assertL1Image(recipe, l1, execDocker = exec) {
  if (l1?.dockerfile === undefined) return;
  if (await imageL1Label(recipe, execDocker) !== l1.id) {
    throw new Error(`l1_image_mismatch:${l1.id}`);
  }
}

// Эффективный L1 для исполнения рецепта: ЯВНЫЙ выбор аттестуется
// fail-closed (образ обязан носить метку профиля). Неявный l1Default
// только ПОДТВЕРЖДАЕТСЯ образом: метка совпадает — defaultEnv дефолта
// применяется; метки нет — legacy-маршрут, рецепт исполняется как есть
// без заявления python-среды (обратная совместимость со старыми
// pinned-образами); метка иная — образ аттестует другую среду, чем
// заявленный дефолт → fail-closed.
async function resolveRunnerL1(recipe, l1Explicit, l1Default, execDocker) {
  if (l1Explicit !== undefined) {
    await assertL1Image(recipe, l1Explicit, execDocker);
    return l1Explicit;
  }
  if (l1Default === undefined) return undefined;
  if (l1Default.dockerfile === undefined) return l1Default;
  // Inspect lỗi — fail-closed l1_image_uninspectable: chỉ inspect
  // THÀNH CÔNG xác nhận thiếu nhãn mới được phép vào legacy-маршрут,
  // kẻo docker hồi phục lúc run sẽ chạy trên image chưa kiểm chứng.
  const tagged = await imageL1Label(recipe, execDocker);
  if (tagged === l1Default.id) return l1Default;
  if (tagged !== undefined) throw new Error(`l1_image_mismatch:${l1Default.id}`);
  return undefined;
}

export function offlineDockerRunner(journal, { beforeEffect, execDocker } = {}) {
  return async (handoff, profile) => {
    const dockerExec = execDocker ?? exec;
    const recipe = checkCommand(profile.check ?? {});
    const { image, argv, cwd, timeoutMs } = recipe;
    // Явный l1Profile профиля и рецепта проверяется раздельно fail-closed
    // до любого вызова docker: ?? проглотил бы явный null и скрыл бы
    // недопустимый recipe.l1Profile за валидным profile.l1Profile. Оба
    // заданных и разных значения — отказ, а не выбор приоритетного.
    const l1Profile = profile.l1Profile === undefined ? undefined
      : resolveL1Profile({ l1Profile: profile.l1Profile });
    const l1Recipe = recipe.l1Profile === undefined ? undefined
      : resolveL1Profile({ l1Profile: recipe.l1Profile });
    if (l1Profile !== undefined && l1Recipe !== undefined && l1Profile.id !== l1Recipe.id) {
      throw new Error('l1_profile_mismatch');
    }
    // Неявный дефолт контроллера (repoId попытки) — не явный выбор: он
    // применяется только когда ни профиль, ни рецепт профиль не задали,
    // и не участвует в mismatch-сверке.
    const l1Default = profile.l1Default === undefined ? undefined
      : resolveL1Profile({ l1Profile: profile.l1Default });
    if (!SHA.test(handoff.candidate_sha)) throw new Error('Local runner requires a full SHA');
    const security = JSON.parse((await dockerExec('docker', ['info', '--format', '{{json .SecurityOptions}}'], {
      timeout: 12_000,
    })).stdout);
    if (!security.includes('name=rootless')) throw new Error('The test runner requires rootless Docker');
    const l1 = await resolveRunnerL1(recipe, l1Profile ?? l1Recipe, l1Default, dockerExec);
    // defaultEnv подмешивается только когда профиль действительно
    // применяется: legacy-образ без метки не получает env дефолта, иначе
    // план заявлял бы python-среду на Node-only образе.
    const effective = l1 === undefined ? recipe
      : { ...recipe, env: { ...l1.defaultEnv, ...recipe.env } };

    const scratch = await mkdtemp(join(tmpdir(), 'board-check-'));
    const name = `board-check-${randomUUID()}`;
    try {
      const archive = join(scratch, 'candidate.tar');
      const source = join(scratch, 'candidate');
      await mkdir(source);
      // The scratch parent stays private; only the mounted checkout is traversable to the mapped UID.
      await chmod(source, 0o755);
      await unpackExact(handoff.worktree, handoff.candidate_sha, archive, source);
      const extras = await sandboxExtras(effective, source);
      const args = ['run', '--rm', '--name', name, '--pull=never', '--network=none', '--read-only',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
        '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777', '-e', 'HOME=/tmp',
        '--mount', `type=bind,src=${source},dst=/candidate,readonly`, ...extras,
        '--workdir', posix.join('/candidate', cwd), image, ...argv];
      let output;
      let exit = 0;
      await beforeEffect?.();
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
// Каталог captures/ обходится рекурсивно, но symlink не является ни файлом, ни
// каталогом и поэтому не может увести сбор за пределы tmpfs-выгрузки.
export async function collectVisualArtifacts(dropped, journal, binding, observeCapture) {
  const { opendir } = await import('node:fs/promises');
  const entries = [];
  let seen = 0;
  async function walk(dir, prefix) {
    for await (const entry of await opendir(dir)) {
      if (seen >= ARTIFACT_MAX_FILES) {
        throw new Error('Visual artifacts exceed the count or byte limits');
      }
      seen++;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const from = join(dir, entry.name);
      const info = await lstat(from);
      if (info.isDirectory()) {
        await walk(from, rel);
      } else {
        entries.push({ rel, from, info });
      }
    }
  }
  await walk(dropped, '');
  const artifacts = [];
  let total = 0;
  for (const entry of entries.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)) {
    const { rel, from, info } = entry;
    if (!info.isFile()) continue;
    if (info.size < 1 || info.size > ARTIFACT_MAX_FILE_BYTES ||
        total + info.size > ARTIFACT_MAX_TOTAL_BYTES) {
      throw new Error('Visual artifacts exceed the count or byte limits');
    }
    const data = await readFile(from);
    const safe = rel.replace(/[^A-Za-z0-9_.-]/g, '_');
    const stored = `visual-artifact-${binding.task_id}-${binding.candidate_sha}-${randomUUID()}-${safe}`;
    await writeFile(join(journal, stored), data, { flag: 'wx', mode: 0o600 });
    total += data.length;
    const artifact = { name: stored, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
    artifacts.push(artifact);
    if (rel.startsWith('captures/')) await observeCapture?.({ rel, data, artifact });
  }
  return artifacts;
}

async function persistVisualCaptures(journal, binding, captures) {
  if (!captures.length) return null;
  if (captures.length > 16) throw new Error('visual_capture_count_limit');
  const canonicalJournal = await realpath(journal);
  const dir = join(canonicalJournal, `visual-captures-${binding.task_id}-${binding.candidate_sha}-${randomUUID()}`);
  await mkdir(dir, { mode: 0o700 });
  const names = new Set();
  for (const capture of captures) {
    const match = /^captures\/([A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.png)$/.exec(capture.rel);
    if (!match || names.has(match[1])) throw new Error('visual_capture_invalid');
    names.add(match[1]);
    const target = join(dir, match[1]);
    await writeFile(target, capture.data, { flag: 'wx', mode: 0o600 });
    await validatePngFile(target);
  }
  return { capture_dir: dir, capture_count: captures.length };
}

// L3 визуальный гейт: та же изоляция rootless Docker, плюс каталог артефактов,
// смонтированный rw только для выгрузки скриншотов в приватный журнал контроллера.
export function offlineVisualRunner(journal, { beforeEffect, execDocker } = {}) {
  return async (binding, profile) => {
    const dockerExec = execDocker ?? exec;
    const recipe = checkCommand(profile.visual ?? {});
    const { image, argv, cwd, timeoutMs } = recipe;
    // Тот же контракт l1Profile, что у проверочных рецептов и обеих
    // CLI-обёрток: явные значения профиля и рецепта — строго из реестра,
    // два различных явных — отказ до docker; неявный l1Default
    // контроллера валидируется fail-closed, но конфликтом не считается.
    const l1Profile = profile.l1Profile === undefined ? undefined
      : resolveL1Profile({ l1Profile: profile.l1Profile });
    const l1Recipe = recipe.l1Profile === undefined ? undefined
      : resolveL1Profile({ l1Profile: recipe.l1Profile });
    if (l1Profile !== undefined && l1Recipe !== undefined && l1Profile.id !== l1Recipe.id) {
      throw new Error('l1_profile_mismatch');
    }
    const l1Default = profile.l1Default === undefined ? undefined
      : resolveL1Profile({ l1Profile: profile.l1Default });
    if (!SHA.test(binding.candidate_sha)) throw new Error('Visual runner requires a full SHA');
    const holdoutInput = recipe.holdoutDir ?? recipe.holdout_dir ?? recipe.holdouts;
    let holdoutMount = [];
    let holdoutProvenance = null;
    if (holdoutInput !== undefined) {
      if (typeof holdoutInput !== 'string') throw new Error('holdout_dir_invalid');
      const canonicalHoldout = await validateHoldoutDir(holdoutInput, binding.worktree);
      const provenance = await holdoutDigest(canonicalHoldout);
      holdoutProvenance = { holdout_digest: provenance.holdout_digest, holdout_files: provenance.files.length };
      holdoutMount = ['--mount', `type=bind,src=${canonicalHoldout},dst=/holdouts,readonly`];
    }
    const security = JSON.parse((await dockerExec('docker', ['info', '--format', '{{json .SecurityOptions}}'], {
      timeout: 12_000,
    })).stdout);
    if (!security.includes('name=rootless')) throw new Error('The visual runner requires rootless Docker');
    // Тот же инвариант образа, что у проверочного раннера: visual-гейт под
    // ЯВНО выбранным профилем с доверенным Dockerfile обязан идти в
    // аттестованном образе. Неявный l1Default применяется только когда
    // образ сам подтверждает тот же профиль меткой; образ без метки —
    // legacy, метка иная — среда иная, чем заявленный дефолт → отказ.
    await resolveRunnerL1(recipe, l1Profile ?? l1Recipe, l1Default, dockerExec);

    const scratch = await mkdtemp(join(tmpdir(), 'board-visual-'));
    const name = `board-visual-${randomUUID()}`;
    try {
      const archive = join(scratch, 'candidate.tar');
      const source = join(scratch, 'candidate');
      const dropped = join(scratch, 'artifacts');
      await mkdir(source);
      await chmod(source, 0o755);
      await mkdir(dropped, { mode: 0o700 });
      await unpackExact(binding.worktree, binding.candidate_sha, archive, source);
      const extras = await sandboxExtras(recipe, source);
      // У контейнера нет ни одного writable-монтирования на диск хоста:
      // только tmpfs /tmp (64m) и tmpfs /artifacts (size=32m, nr_inodes=66) —
      // ядро ограничивает запись на лету, переполнить диск журнала нельзя.
      // Контейнер — изолированный sandbox со sleep; сама проверка выполняется
      // через `docker exec` напрямую: код возврата и stdout/stderr приходят
      // на хост от Docker, а не из файлов tmpfs, которые кандидат мог бы
      // подделать. docker cp tmpfs не видит — артефакты забираются через
      // `docker exec tar`, пока контейнер жив и tmpfs смонтирован.
      const args = ['run', '-d', '--name', name, '--pull=never', '--network=none', '--read-only',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
        '--ulimit', `fsize=${ARTIFACT_MAX_FILE_BYTES}:${ARTIFACT_MAX_FILE_BYTES}`,
        '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777,size=64m', '-e', 'HOME=/tmp',
        '--tmpfs=/artifacts:rw,nosuid,nodev,noexec,mode=1777,' +
          `size=${ARTIFACT_MAX_TOTAL_BYTES},nr_inodes=${ARTIFACT_MAX_FILES + 2}`,
        '--mount', `type=bind,src=${source},dst=/candidate,readonly`, ...extras, ...holdoutMount,
        '--workdir', posix.join('/candidate', cwd), image,
        '/bin/sh', '-c', 'sleep 3600'];
      let output;
      let exit;
      await beforeEffect?.();
      try {
        await dockerExec('docker', args, { timeout: 15_000 });
        await beforeEffect?.();
        try {
          const run = await dockerExec('docker',
            ['exec', '--workdir', posix.join('/candidate', cwd), name, ...argv],
            { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
          output = `${run.stdout}${run.stderr}`;
          exit = 0;
        } catch (error) {
          exit = typeof error.code === 'number' ? error.code : null;
          output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
        }
        // Коды 125/126/127 и недоступный код — проверка не состоялась: среда.
        if (exit === null || exit === 125 || exit === 126 || exit === 127) {
          throw new Error(`visual_runner_not_executed:${String(output).slice(-200)}`);
        }
        // Выгрузка из tmpfs живого контейнера; сбой tar — это ошибка, не тихий pass.
        const bundle = join(scratch, 'artifacts.tar');
        await beforeEffect?.();
        const packed = await dockerExec('docker',
          ['exec', name, 'tar', '-C', '/artifacts', '-cf', '-', '.'],
          { timeout: 30_000, maxBuffer: ARTIFACT_MAX_TOTAL_BYTES + 2 * 1024 * 1024,
            encoding: 'buffer' });
        await writeFile(bundle, packed.stdout);
        await exec('tar', ['-xf', bundle, '-C', dropped,
          '--no-same-owner', '--no-same-permissions'], { timeout: 30_000 });
      } finally {
        await cleanupContainer(name, dockerExec);
      }
      const file = `visual-${binding.task_id}-${binding.candidate_sha}-${randomUUID()}.log`;
      await writeFile(join(journal, file), output, { flag: 'wx', mode: 0o600 });
      const captured = [];
      const artifacts = await collectVisualArtifacts(dropped, journal, binding,
        capture => { captured.push(capture); });
      const captureReceipt = await persistVisualCaptures(journal, binding, captured);
      return {
        sha: binding.candidate_sha, ok: exit === 0, status: exit === 0 ? 'pass' : 'fail',
        ...(holdoutProvenance ?? {}),
        ...(captureReceipt ?? {}),
        artifacts,
        evidence: { file, sha256: createHash('sha256').update(output).digest('hex'), exit },
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}

export function offlineProfileRunner(journal, options) {
  const check = offlineDockerRunner(journal, options);
  return async (handoff, profile) => {
    if (!Array.isArray(profile.checks) || !profile.checks.length) throw new Error('An approved check list is required');
    // Все рецепты валидируются до первого вызова docker: недопустимое
    // или конфликтующее l1Profile за валидным рецептом не должно
    // допускать частичное исполнение (иначе дефект политики
    // маскировался бы под ошибку локальных проверок).
    const l1Pinned = profile.l1Profile === undefined ? undefined
      : resolveL1Profile({ l1Profile: profile.l1Profile });
    for (const recipe of profile.checks) {
      const l1Recipe = recipe?.l1Profile === undefined ? undefined
        : resolveL1Profile({ l1Profile: recipe.l1Profile });
      if (l1Pinned !== undefined && l1Recipe !== undefined && l1Pinned.id !== l1Recipe.id) {
        throw new Error('l1_profile_mismatch');
      }
    }
    const evidence = [];
    for (const recipe of profile.checks) {
      // l1Profile профиля и рецепта передаются раздельно: сверка и
      // fail-closed валидация каждого — в раннере, ?? здесь скрыл бы
      // недопустимый рецепт за валидным профилем.
      const result = await check(handoff,
        { check: recipe, l1Profile: profile.l1Profile, l1Default: profile.l1Default });
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
