// Тонкий CLI-запуск принятого контроллера board_pipeline/run-isolated.mjs.
// Делает обязательные проверки ДО запуска и затем тонко делегирует:
//   node board_pipeline/run-isolated.mjs --execute --policy FILE --state DIR
// Матрица моделей обязательна и явна: без --provider/--model — отказ; при
// переданной политике они обязаны совпадать с policy.bb.provider/model.
// Запрещённые провайдеры/модели блокируются в любом сегменте пути
// (включая вложенные 'pi/...'): gpt-6.1-terra, zcode/acp-zcode-start,
// glm / glm-*. Дополнительно действуют opencodeGoPolicyViolation и
// retiredProviderViolation из board_pipeline/worker-selector.mjs.
//
//   node ops/factory-run.mjs --provider P --model M \
//     --policy FILE --state DIR [--worktree DIR] [--memory-dir DIR] \
//     [--ledger-path FILE] [--stop-on-idle] [--daemon] [--switch V] \
//     [--interval-ms N] [--allow-live-pilot] [--recheck-rejected-handoff] \
//     [--dry-run] [--json]
import { execFile } from 'node:child_process';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { opencodeGoPolicyViolation, retiredProviderViolation }
  from '../board_pipeline/worker-selector.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

function fail(code) { throw new Error(code); }

// Жёсткая блокировка запрещённых моделей/провайдеров по каждому сегменту
// 'provider/model' (регистронезависимо, включая вложенные 'pi/a/b/...').
export function forbiddenModelViolation(spec) {
  const ids = [];
  if (typeof spec === 'string') ids.push(spec);
  else if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    if (typeof spec.provider === 'string') ids.push(spec.provider);
    if (typeof spec.model === 'string') ids.push(spec.model);
  } else return null;
  for (const id of ids) {
    for (const seg of id.toLowerCase().split('/')) {
      if (seg === 'gpt-6.1-terra') return 'model_gpt_6_1_terra_disallowed';
      if (seg.includes('zcode')) return 'zcode_provider_disallowed';
      if (seg === 'glm' || seg.startsWith('glm-')) return 'model_glm_disallowed';
    }
  }
  return null;
}

// Полный прогон матрицы по спеку: локальные запреты + запреты селектора.
export function modelViolation(spec) {
  return forbiddenModelViolation(spec) ??
    retiredProviderViolation(spec) ??
    opencodeGoPolicyViolation(spec);
}

// Матрица применяется ко всем спекам: CLI, policy.bb, критик профиля, арбитр.
export function assertModelMatrix({ cli, policy }) {
  for (const [where, spec] of [
    ['cli', { provider: cli.provider, model: cli.model }],
    ['policy.bb', policy?.bb],
    ['critic', policy?.profiles?.[policy?.route?.checkProfile]?.review],
    ['arbiter', policy?.arbiter],
  ]) {
    if (spec === undefined || spec === null) continue;
    const violation = modelViolation(spec);
    if (violation) fail(`${violation}:${where}`);
  }
}

async function canonicalOutside(path, worktreeReal, mustBe) {
  const st = await lstat(path).catch(() => fail('path_missing'));
  if (st.isSymbolicLink()) fail('path_symlink_refused');
  if (mustBe === 'dir' && !st.isDirectory()) fail('path_not_dir');
  if (mustBe === 'file' && !st.isFile()) fail('path_not_file');
  const real = await realpath(path);
  if (worktreeReal && (real === worktreeReal || real.startsWith(`${worktreeReal}/`))) {
    fail('path_inside_worktree');
  }
  return real;
}

const PASSTHROUGH_BOOL = ['stop-on-idle', 'daemon', 'allow-live-pilot',
  'recheck-rejected-handoff'];
const PASSTHROUGH_VALUE = ['switch', 'interval-ms'];

// Собирает проверенный план запуска run-isolated. Эффекты: только чтение
// политики/путей и `git config --local core.fileMode false` в worktree
// (делается вызывающим в non-dry-run).
export async function buildRunPlan(values) {
  if (typeof values.provider !== 'string' || !values.provider.trim()) fail('provider_required');
  if (typeof values.model !== 'string' || !values.model.trim()) fail('model_required');
  if (!values.policy || !values.state) fail('policy_and_state_required');

  const policyPath = await realpath(values.policy);
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  if (policy?.bb) {
    if (policy.bb.provider !== values.provider || policy.bb.model !== values.model) {
      fail('cli_spec_mismatch_policy_bb');
    }
  }
  assertModelMatrix({ cli: values, policy });

  const worktreeReal = await realpath(values.worktree ?? policy?.route?.worktree)
    .catch(() => fail('worktree_missing'));

  // Чистый старт с Project Memory и Owner Decision Ledger: пути каноничны
  // (не симлинки) и строго вне worktree.
  const ledger = values['ledger-path'] ??
    (typeof policy?.decisionLedger === 'string' ? policy.decisionLedger : policy?.decisionLedger?.path);
  const memory = values['memory-dir'] ??
    (typeof policy?.projectMemory === 'string' ? policy.projectMemory : policy?.projectMemory?.path);
  if (ledger !== undefined && ledger !== null) {
    await canonicalOutside(ledger, worktreeReal, 'file');
  }
  if (memory !== undefined && memory !== null) {
    await canonicalOutside(memory, worktreeReal, 'dir');
  }

  const runIsolated = values['run-isolated'] ?? join(HERE, '..', 'board_pipeline', 'run-isolated.mjs');
  const argv = [runIsolated, '--execute', '--policy', policyPath, '--state', values.state];
  for (const flag of PASSTHROUGH_BOOL) if (values[flag]) argv.push(`--${flag}`);
  for (const flag of PASSTHROUGH_VALUE) {
    if (values[flag] !== undefined) argv.push(`--${flag}`, values[flag]);
  }
  return { node: values.node ?? process.execPath, argv, worktree: worktreeReal,
    spec: { provider: values.provider, model: values.model }, policy: policyPath,
    state: values.state };
}

async function defaultGit(args) {
  return (await execFileAsync('git', args, { timeout: 30_000 })).stdout.trim();
}

// NTFS guard: worktree обязан быть валидным git worktree; затем локально
// выставляется core.fileMode=false (checkout на не-POSIX ФС не должен
// ломать учёт executable-бита и diff).
export async function ensureFilemodeGuard(worktree, { git = defaultGit } = {}) {
  const inside = await git(['-C', worktree, 'rev-parse', '--is-inside-work-tree'])
    .catch(() => fail('worktree_not_git'));
  if (inside !== 'true') fail('worktree_not_git');
  await git(['-C', worktree, 'config', '--local', 'core.fileMode', 'false']);
}

export async function runFactory(argv, deps = {}) {
  const { values } = parseArgs({ args: argv, options: {
    provider: { type: 'string' }, model: { type: 'string' },
    policy: { type: 'string' }, state: { type: 'string' },
    worktree: { type: 'string' }, 'memory-dir': { type: 'string' },
    'ledger-path': { type: 'string' }, 'run-isolated': { type: 'string' },
    node: { type: 'string' },
    'stop-on-idle': { type: 'boolean' }, daemon: { type: 'boolean' },
    switch: { type: 'string' }, 'interval-ms': { type: 'string' },
    'allow-live-pilot': { type: 'boolean' },
    'recheck-rejected-handoff': { type: 'boolean' },
    'dry-run': { type: 'boolean' }, json: { type: 'boolean' } } });
  const plan = await buildRunPlan(values);
  if (values['dry-run']) {
    // Dry-run без эффектов: только read-only сверка, что цель — git worktree.
    const git = deps.git ?? defaultGit;
    const inside = await git(['-C', plan.worktree, 'rev-parse', '--is-inside-work-tree'])
      .catch(() => fail('worktree_not_git'));
    if (inside !== 'true') fail('worktree_not_git');
    return { dryRun: true, plan };
  }
  await ensureFilemodeGuard(plan.worktree, { git: deps.git ?? defaultGit });
  const run = deps.run ?? (async (cmd, args) =>
    execFileAsync(cmd, args, { stdio: 'inherit', timeout: 0 }));
  const result = await run(plan.node, plan.argv);
  return { dryRun: false, plan, result };
}

async function cli(argv) {
  try {
    const result = await runFactory(argv);
    if (result.dryRun) {
      process.stdout.write(`${JSON.stringify(result.plan, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`factory-run: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await cli(process.argv.slice(2));
}
