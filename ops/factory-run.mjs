// Тонкий CLI-запуск принятого контроллера board_pipeline/run-isolated.mjs.
// Делает обязательные проверки ДО запуска и затем тонко делегирует:
//   node board_pipeline/run-isolated.mjs --execute --policy FILE --state DIR
// Матрица моделей обязательна и явна: без --provider/--model — отказ; при
// переданной политике они обязаны совпадать с policy.bb.provider/model.
// Запрещённые провайдеры/модели блокируются в любом сегменте пути
// (включая вложенные 'pi/...'): gpt-6.1-terra, zcode/acp-zcode-start,
// glm / glm-* — и в статических спеках, и в кандидатах routing.allowlist
// (активный роутинг мог бы закрепить их скоркардом). Дополнительно
// действуют opencodeGoPolicyViolation и retiredProviderViolation из
// board_pipeline/worker-selector.mjs.
//
//   node ops/factory-run.mjs --provider P --model M \
//     --policy FILE --state DIR [--worktree DIR] [--memory-dir DIR] \
//     [--ledger-path FILE] [--stop-on-idle] [--daemon] [--switch V] \
//     [--interval-ms N] [--allow-live-pilot] [--recheck-rejected-handoff] \
//     [--dry-run] [--json]
import { execFile, spawn } from 'node:child_process';
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

// Матрица применяется ко всем спекам, способным стать фактической моделью:
// CLI, policy.bb, критик профиля, арбитр и каждый кандидат
// policy.routing.allowlist.* (активный роутинг закрепляет кандидата
// скоркардом — запрет обязан действовать до запуска контроллера).
export function assertModelMatrix({ cli, policy }) {
  const specs = [
    ['cli', { provider: cli.provider, model: cli.model }],
    ['policy.bb', policy?.bb],
    ['critic', policy?.profiles?.[policy?.route?.checkProfile]?.review],
    ['arbiter', policy?.arbiter],
  ];
  for (const role of ['worker', 'critic', 'arbiter']) {
    for (const entry of policy?.routing?.allowlist?.[role] ?? []) {
      specs.push([`routing.allowlist.${role}`, entry]);
    }
  }
  for (const [where, spec] of specs) {
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
const LEDGER_PATH_ENV = 'DF_DECISION_LEDGER_PATH';
const MEMORY_DIR_ENV = 'DF_PROJECT_MEMORY_DIR';

// Путь из политики в форме контроллера: строка или объект ({path} для
// ledger; {storeDir|dir|path} для memory — resolveMemoryStoreDir).
const policyPath = (cfg, keys) =>
  typeof cfg === 'string' ? cfg : keys.map(k => cfg?.[k]).find(v => typeof v === 'string');

// Чистый старт: резолвит тот же путь, что реально использует контроллер
// (explicit > policy > env). Расхождение CLI-флага с закреплённым в
// политике путём — отказ: проверять одно, а исполнять другое нельзя.
function effectivePath({ explicit, policyValue, env, name }) {
  const policyRaw = policyValue ?? env;
  if (explicit !== undefined && policyValue !== undefined && explicit !== policyValue) {
    fail(`${name}_mismatch`);
  }
  const raw = explicit ?? policyRaw;
  return raw === undefined || raw === null || raw === '' ? null : raw;
}

// Собирает проверенный план запуска run-isolated. Эффекты в non-dry-run:
// только `git config --local core.fileMode false` в том же worktree, в
// котором будет работать контроллер.
export async function buildRunPlan(values, { env = process.env } = {}) {
  if (typeof values.provider !== 'string' || !values.provider.trim()) fail('provider_required');
  if (typeof values.model !== 'string' || !values.model.trim()) fail('model_required');
  if (!values.policy || !values.state) fail('policy_and_state_required');

  const policyPathReal = await realpath(values.policy);
  const policy = JSON.parse(await readFile(policyPathReal, 'utf8'));
  if (policy?.bb) {
    if (policy.bb.provider !== values.provider || policy.bb.model !== values.model) {
      fail('cli_spec_mismatch_policy_bb');
    }
  }
  assertModelMatrix({ cli: values, policy });

  // Guard привязан к worktree контроллера: --worktree может лишь подтвердить
  // путь из политики, несовпадающий override — отказ.
  const policyTree = policy?.route?.worktree;
  const worktreeReal = await realpath(values.worktree ?? policyTree)
    .catch(() => fail('worktree_missing'));
  if (values.worktree !== undefined && policyTree !== undefined) {
    if (await realpath(policyTree) !== worktreeReal) fail('worktree_mismatch');
  }

  const ledger = effectivePath({ explicit: values['ledger-path'],
    policyValue: policyPath(policy?.decisionLedger, ['path']),
    env: env[LEDGER_PATH_ENV], name: 'decision_ledger' });
  const memory = effectivePath({ explicit: values['memory-dir'],
    policyValue: policyPath(policy?.projectMemory, ['storeDir', 'dir', 'path']),
    env: env[MEMORY_DIR_ENV], name: 'project_memory' });
  if (ledger !== null) await canonicalOutside(ledger, worktreeReal, 'file');
  if (memory !== null) await canonicalOutside(memory, worktreeReal, 'dir');

  // CLI-override без конфликта с политикой передаётся контроллеру через
  // тот же env-канал (DF_DECISION_LEDGER_PATH / DF_PROJECT_MEMORY_DIR):
  // проверенный путь и есть используемый путь.
  const childEnv = { ...env };
  if (values['ledger-path'] !== undefined) childEnv[LEDGER_PATH_ENV] = values['ledger-path'];
  if (values['memory-dir'] !== undefined) childEnv[MEMORY_DIR_ENV] = values['memory-dir'];

  const runIsolated = values['run-isolated'] ?? join(HERE, '..', 'board_pipeline', 'run-isolated.mjs');
  const argv = [runIsolated, '--execute', '--policy', policyPathReal, '--state', values.state];
  for (const flag of PASSTHROUGH_BOOL) if (values[flag]) argv.push(`--${flag}`);
  for (const flag of PASSTHROUGH_VALUE) {
    if (values[flag] !== undefined) argv.push(`--${flag}`, values[flag]);
  }
  return { node: values.node ?? process.execPath, argv, env: childEnv,
    worktree: worktreeReal, spec: { provider: values.provider, model: values.model },
    policy: policyPathReal, state: values.state, ledger, memory };
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
    'ledger-path': { type: 'string' }, 'run-isolated': { type: 'string' },
    node: { type: 'string' },
    'stop-on-idle': { type: 'boolean' }, daemon: { type: 'boolean' },
    switch: { type: 'string' }, 'interval-ms': { type: 'string' },
    'allow-live-pilot': { type: 'boolean' },
    'recheck-rejected-handoff': { type: 'boolean' },
    'dry-run': { type: 'boolean' }, json: { type: 'boolean' } } });
  const plan = await buildRunPlan(values, { env: deps.env ?? process.env });
  if (values['dry-run']) {
    // Dry-run без эффектов: только read-only сверка, что цель — git worktree.
    const git = deps.git ?? defaultGit;
    const inside = await git(['-C', plan.worktree, 'rev-parse', '--is-inside-work-tree'])
      .catch(() => fail('worktree_not_git'));
    if (inside !== 'true') fail('worktree_not_git');
    return { dryRun: true, plan };
  }
  await ensureFilemodeGuard(plan.worktree, { git: deps.git ?? defaultGit });
  const run = deps.run ?? defaultRun;
  const result = await run(plan.node, plan.argv, plan.env);
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
