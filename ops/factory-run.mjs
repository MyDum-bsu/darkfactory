// Тонкий CLI-запуск принятого контроллера board_pipeline/run-isolated.mjs.
// Делает обязательные проверки ДО запуска и затем тонко делегирует:
//   node board_pipeline/run-isolated.mjs --execute --policy FILE --state DIR
// Матрица моделей обязательна и явна: без --provider/--model — отказ; при
// переданной политике они обязаны совпадать с policy.bb.provider/model.
// Запрещённые провайдеры/модели блокируются в любом сегменте пути
// (включая вложенные 'pi/...'): gpt-6.1-terra — и в статических спеках,
// и в кандидатах routing.allowlist (активный роутинг мог бы закрепить
// их скоркардом). По Owner Decision #18 zcode/acp-zcode-start и glm
// допускаются при наличии квоты; текстового запрета для них здесь нет.
// Дополнительно действуют opencodeGoPolicyViolation и
// retiredProviderViolation из board_pipeline/worker-selector.mjs.
//
//   node ops/factory-run.mjs --provider P --model M \
//     --policy FILE --state DIR [--worktree DIR] [--memory-dir DIR] \
//     [--ledger-path FILE] [--stop-on-idle] [--daemon] [--switch V] \
//     [--interval-ms N] [--allow-live-pilot] [--recheck-rejected-handoff] \
//     [--runtime bb|hc|subproc] [--event-socket FILE] [--dry-run] [--json]
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { canonicalPolicyPath, runtimeKind, validatePolicyContract } from '../board_pipeline/config-compiler.mjs';
export { forbiddenModelViolation, modelViolation, assertPolicyModelMatrix as assertModelMatrix }
  from '../board_pipeline/model-registry.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

function fail(code) { throw new Error(code); }

const PASSTHROUGH_BOOL = ['stop-on-idle', 'daemon', 'allow-live-pilot',
  'recheck-rejected-handoff'];
const PASSTHROUGH_VALUE = ['switch', 'interval-ms', 'runtime', 'event-socket'];
// Собирает проверенный план запуска run-isolated. Эффекты в non-dry-run:
// только `git config --local core.fileMode false` в том же worktree, в
// котором будет работать контроллер.
export async function buildRunPlan(values, { env = process.env } = {}) {
  if (values.runtime !== undefined) runtimeKind(values.runtime);
  if (typeof values.provider !== 'string' || !values.provider.trim()) fail('provider_required');
  if (typeof values.model !== 'string' || !values.model.trim()) fail('model_required');
  if (!values.policy || !values.state) fail('policy_and_state_required');

  const policyPathReal = await canonicalPolicyPath(values.policy, 'file');
  const policy = JSON.parse(await readFile(policyPathReal, 'utf8'));
  const { worktree: worktreeReal, l1Profile, state, ledger, memory, handoff, runtime } =
    await validatePolicyContract(policy, { env, cli: values, policyFile: policyPathReal });
  const envOverrides = { DF_WORKER_RUNTIME: runtime };
  if (values['ledger-path'] !== undefined) envOverrides.DF_DECISION_LEDGER_PATH = ledger;
  if (values['memory-dir'] !== undefined) envOverrides.DF_PROJECT_MEMORY_DIR = memory;

  // Делегирование строго принятому контроллеру: ни путь, ни бинарник
  // не переопределяются флагами.
  const runIsolated = join(HERE, '..', 'board_pipeline', 'run-isolated.mjs');
  const argv = [runIsolated, '--execute', '--policy', policyPathReal, '--state', state];
  for (const flag of PASSTHROUGH_BOOL) if (values[flag]) argv.push(`--${flag}`);
  for (const flag of PASSTHROUGH_VALUE) {
    if (values[flag] !== undefined) argv.push(`--${flag}`, values[flag]);
  }
  // Только ЯВНЫЙ выбор оператора передаётся контроллеру как --l1-profile:
  // резолвленный здесь дефолт репозитория не пробрасывается — контроллер
  // считал бы его явным, и явный l1Profile рецепта конфликтовал бы с
  // неявным дефолтом (l1_profile_mismatch), хотя прямой запуск
  // контроллера такую политику принимает.
  if (values['l1-profile'] !== undefined) {
    argv.push('--l1-profile', l1Profile);
  }
  return { node: process.execPath, argv, env: envOverrides,
    worktree: worktreeReal, spec: { provider: values.provider, model: values.model },
    l1Profile, policy: policyPathReal, state, ledger, memory, handoff };
}

// Git не наследует перенаправления окружения: унаследованный GIT_DIR
// выбрал бы конфиг другого репозитория, а GIT_WORK_TREE — чужой toplevel,
// и guard писал бы core.fileMode не туда. Все переменные GIT_* снимаются:
// rev-parse и config действуют строго на репозиторий `-C worktree`.
const cleanGitEnv = env => Object.fromEntries(
  Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));

async function defaultGit(args) {
  return (await execFileAsync('git', args,
    { timeout: 30_000, env: cleanGitEnv(process.env) })).stdout.trim();
}

// NTFS guard: worktree обязан быть точным корнем git worktree — та же
// сверка, что authorize в run-isolated.mjs (`rev-parse --show-toplevel`
// === канонический worktree), иначе guard менял бы конфиг чужого
// репозитория по его подкаталогу. Затем локально выставляется
// core.fileMode=false (checkout на не-POSIX ФС не должен ломать учёт
// executable-бита и diff).
export async function ensureFilemodeGuard(worktree, { git = defaultGit } = {}) {
  const top = await git(['-C', worktree, 'rev-parse', '--show-toplevel'])
    .catch(() => fail('worktree_not_git'));
  if (top !== worktree) fail('worktree_not_git');
  // Идемпотентная запись: при уже действующем --local core.fileMode=false
  // повторная запись пропускается — одновременный запуск нескольких слотов
  // не должен сталкиваться на .git/config.lock без необходимости записи.
  const current = await git(['-C', worktree, 'config', '--local', '--get', 'core.fileMode'])
    .catch(() => '');
  if (current !== 'false') {
    await git(['-C', worktree, 'config', '--local', 'core.fileMode', 'false']);
  }
  // Эффективное значение важнее записанного: более приоритетный
  // worktree-конфиг (extensions.worktreeConfig) может перекрывать --local.
  // Запуск только при реально действующем core.fileMode=false.
  const effective = async () =>
    (await git(['-C', worktree, 'config', '--get', 'core.fileMode']).catch(() => '')) === 'false';
  if (!(await effective())) {
    await git(['-C', worktree, 'config', '--worktree', 'core.fileMode', 'false'])
      .catch(() => fail('filemode_guard_ineffective'));
    if (!(await effective())) fail('filemode_guard_ineffective');
  }
}

// Вывод контроллера идёт в консоль оператора по мере работы (spawn +
// stdio:'inherit'); execFile буферизовал бы лог и убивал демон по maxBuffer.
async function defaultRun(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? resolve({ code })
      : reject(new Error(`run_isolated_exit_${code ?? `signal_${signal}`}`)));
  });
}

export async function runFactory(argv, deps = {}) {
  const { values } = parseArgs({ args: argv, options: {
    provider: { type: 'string' }, model: { type: 'string' },
    policy: { type: 'string' }, state: { type: 'string' },
    worktree: { type: 'string' }, 'memory-dir': { type: 'string' },
    'ledger-path': { type: 'string' },
    'stop-on-idle': { type: 'boolean' }, daemon: { type: 'boolean' },
    switch: { type: 'string' }, 'interval-ms': { type: 'string' },
    'allow-live-pilot': { type: 'boolean' },
    'recheck-rejected-handoff': { type: 'boolean' },
    'l1-profile': { type: 'string' }, runtime: { type: 'string' },
    'event-socket': { type: 'string' },
    'dry-run': { type: 'boolean' }, json: { type: 'boolean' } } });
  const plan = await buildRunPlan(values, { env: deps.env ?? process.env });
  if (values['dry-run']) {
    // Dry-run без эффектов: только read-only сверка, что цель — точный
    // корень git worktree.
    const git = deps.git ?? defaultGit;
    const top = await git(['-C', plan.worktree, 'rev-parse', '--show-toplevel'])
      .catch(() => fail('worktree_not_git'));
    if (top !== plan.worktree) fail('worktree_not_git');
    return { dryRun: true, plan };
  }
  await ensureFilemodeGuard(plan.worktree, { git: deps.git ?? defaultGit });
  const run = deps.run ?? defaultRun;
  // Контроллер получает окружение без GIT_*-перенаправлений: иначе его
  // git-команды (как и у guard до очистки) работали бы с чужим конфигом —
  // унаследованный GIT_CONFIG_* переопределил бы подтверждённый guard.
  const result = await run(plan.node, plan.argv,
    { ...cleanGitEnv(deps.env ?? process.env), ...plan.env });
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
