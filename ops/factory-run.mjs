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
import { lstat, readdir, realpath, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { createPilotSwitch } from '../board_pipeline/pilot-gate.mjs';
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
    for (const seg of id.toLowerCase().split(/[/\\]/)) {
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
    ['arbiter', policy?.arbiter],
    ['route.critic', policy?.route?.critic],
    ['route.arbiter', policy?.route?.arbiter],
  ];
  // Все profiles.*.review, а не только выбранный route.checkProfile:
  // инвариант матрицы действует на каждое поле модели политики.
  for (const [name, profile] of Object.entries(policy?.profiles ?? {})) {
    specs.push([`profiles.${name}`, profile?.review]);
  }
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

// Семантика inside() контроллера (relative, а не префикс): корректна и
// для корня ФС — '/' содержит любой абсолютный путь, префиксная сверка
// '//' это пропускала бы.
const inside = (root, p) => {
  const rel = relative(root, p);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

// Инвариант каноничности операторских путей (как у контроллера): путь
// обязан быть строго каноническим абсолютным — без симлинк-компонентов и
// без '..'/'.' (realpath совпадает со строкой пути). Любая цепочка
// симлинков (D/alias/wt/out/..., alias -> wt/link, op/link/../x)
// отклоняется до записи Git-конфига и запуска — ручной обход хопов не
// нужен. Затем двусторонняя граница против всех алиасов дерева; сверка
// родительского каталога (dirTarget/targetDir контроллера,
// assertLedgerOutside/assertStoreOutside) действует только для
// decisionLedger/projectMemory — sibling-каталог состояния рядом с
// worktree допустим.
async function canonicalOutside(path, treeAliases, mustBe, { parent = true } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('path_not_absolute');
  const real = await realpath(path).catch(() => fail('path_missing'));
  if (real !== path) fail('non_canonical_or_symlink_path');
  const st = await lstat(real);
  if (st.isSymbolicLink()) fail('non_canonical_or_symlink_path');
  if (mustBe === 'dir' && !st.isDirectory()) fail('path_not_dir');
  if (mustBe === 'file' && !st.isFile()) fail('path_not_file');
  if (treeAliases.some(t =>
    inside(t, real) || inside(real, t) || (parent && inside(dirname(real), t)))) {
    fail('path_inside_worktree');
  }
  return real;
}

// Вложенный операторский файл политики (brief, reviewPrompt, reviewGate,
// reviewSkillFiles — как в readOperatorInputs контроллера): строго
// канонический файл строго вне worktree. Без файла (undefined) — пропуск;
// явный null или нестроковое значение — не «отсутствует»: контроллер
// вызвал бы realpath(null) уже после записи Git-конфига, поэтому такой
// вход отклоняется здесь, при построении плана.
async function nestedPolicyFile(path, treeAliases) {
  if (path === undefined) return;
  if (typeof path !== 'string' || !isAbsolute(path)) fail('path_not_absolute');
  const real = await realpath(path).catch(() => fail('path_missing'));
  if (real !== path) fail('non_canonical_or_symlink_path');
  const st = await lstat(real);
  if (st.isSymbolicLink()) fail('non_canonical_or_symlink_path');
  if (!st.isFile()) fail('path_not_file');
  if (treeAliases.some(t => inside(t, real))) fail('path_inside_worktree');
  return real;
}

const PASSTHROUGH_BOOL = ['stop-on-idle', 'daemon', 'allow-live-pilot',
  'recheck-rejected-handoff'];
const PASSTHROUGH_VALUE = ['switch', 'interval-ms'];
const LEDGER_PATH_ENV = 'DF_DECISION_LEDGER_PATH';
const MEMORY_DIR_ENV = 'DF_PROJECT_MEMORY_DIR';

// Путь из политики в форме контроллера: строка или объект ({path} для
// ledger; {storeDir|dir|path} для memory — resolveMemoryStoreDir).
// Берётся первое заданное (не undefined) значение: явный null или
// пустая строка в любом поле — не «отсутствует» (контроллер подставил
// бы следующий ключ или env, а dry-run подтвердил бы нерабочую
// конфигурацию) и отклоняется даже при валидном поле выше, как и
// нестроковое значение приоритетного поля — отказ здесь, до Git-конфига.
const policyPath = (cfg, keys) => {
  if (cfg === undefined) return undefined;
  if (cfg === null) fail('path_not_absolute');
  if (typeof cfg === 'string') return cfg;
  // Скалярное значение или массив — не форма пути: контроллер отклонил
  // бы её в ledgerPolicyConfig/memoryPolicyConfig после записи
  // Git-конфига; L2 отклоняет такой вход при построении плана.
  if (typeof cfg !== 'object' || Array.isArray(cfg)) fail('policy_invalid');
  let found;
  for (const k of keys) {
    const v = cfg[k];
    if (v === undefined) continue;
    if (v === null || v === '') fail('path_not_absolute');
    if (found === undefined) found = v;
  }
  return found;
};

// Чистый старт: резолвит тот же путь, что реально использует контроллер
// (explicit > policy > env). Расхождение CLI-флага с закреплённым в
// политике путём — отказ: проверять одно, а исполнять другое нельзя.
function effectivePath({ explicit, policyValue, env, name }) {
  const policyRaw = policyValue ?? env;
  // Явная пустая строка в CLI или политике — не «не задано» (только
  // пустой/отсутствующий env означает отсутствие пути): отклоняется.
  if (explicit === '' || explicit === null ||
      policyValue === '' || policyValue === null) {
    fail('path_not_absolute');
  }
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

  if (!isAbsolute(values.policy)) fail('path_not_absolute');
  const policyPathReal = await realpath(values.policy).catch(() => fail('path_missing'));
  if (policyPathReal !== values.policy) fail('non_canonical_or_symlink_path');
  const policy = JSON.parse(await readFile(policyPathReal, 'utf8'));
  // CLI-спека обязана совпасть с закреплённой policy.bb: без bb проверять
  // нечего — политика недопустима, контроллер отклонил бы её позже.
  if (!policy?.bb || typeof policy.bb !== 'object') fail('policy_bb_missing');
  if (policy.bb.provider !== values.provider || policy.bb.model !== values.model) {
    fail('cli_spec_mismatch_policy_bb');
  }
  assertModelMatrix({ cli: values, policy });

  // Guard привязан к worktree контроллера: политика обязана закрепить
  // route.worktree, --worktree может лишь подтвердить тот же путь.
  const policyTree = policy?.route?.worktree;
  if (typeof policyTree !== 'string' || !policyTree) fail('worktree_required');
  // route.worktree и --worktree — тоже операторские пути: строго
  // канонические абсолютные (realpath обязан совпасть с исходной строкой),
  // а не просто resolve'имые в один каталог.
  if (!isAbsolute(policyTree)) fail('path_not_absolute');
  const worktreeReal = await realpath(policyTree).catch(() => fail('worktree_missing'));
  if (worktreeReal !== policyTree) fail('non_canonical_or_symlink_path');
  if (values.worktree !== undefined) {
    if (!isAbsolute(values.worktree)) fail('path_not_absolute');
    const cliTree = await realpath(values.worktree).catch(() => fail('worktree_missing'));
    if (cliTree !== values.worktree) fail('non_canonical_or_symlink_path');
    if (cliTree !== worktreeReal) fail('worktree_mismatch');
  }

  const ledger = effectivePath({ explicit: values['ledger-path'],
    policyValue: policyPath(policy?.decisionLedger, ['path']),
    env: env[LEDGER_PATH_ENV], name: 'decision_ledger' });
  const memory = effectivePath({ explicit: values['memory-dir'],
    policyValue: policyPath(policy?.projectMemory, ['storeDir', 'dir', 'path']),
    env: env[MEMORY_DIR_ENV], name: 'project_memory' });
  // Все алиасы дерева: канонический путь и буквальные формы из политики и
  // CLI — пересечение по любому из них отклоняется.
  const treeAliases = [...new Set([worktreeReal, resolve(policyTree),
    ...(values.worktree === undefined ? [] : [resolve(values.worktree)])])];
  // Сам файл политики — операторский вход: не может лежать внутри дерева
  // воркера (контроллер отклонил бы его позже — отказ до Git-конфига).
  if (treeAliases.some(t => inside(t, policyPathReal))) fail('path_inside_worktree');
  // Вложенные операторские входы политики — та же каноничность, что и у
  // --policy: исходная строка brief/reviewPrompt/reviewGate/skillFiles
  // обязана совпадать с realpath и лежать вне worktree.
  // brief/reviewPrompt/reviewGate — обязательные операторские входы:
  // контроллер делает их realpath безусловно, поэтому отсутствие —
  // отказ при построении плана, до Git-конфига.
  for (const p of [policy.brief, policy.reviewPrompt, policy.reviewGate]) {
    if (p === undefined) fail('operator_files_required');
  }
  const operatorFiles = [policyPathReal];
  for (const p of [policy.brief, policy.reviewPrompt, policy.reviewGate,
    ...Object.values(policy.reviewSkillFiles ?? {})]) {
    const real = await nestedPolicyFile(p, treeAliases);
    if (real !== undefined) operatorFiles.push(real);
  }
  // routes.json — закрепляемый вход ревью рядом с reviewGate (как в
  // factory-enqueue): симлинк на внешнюю цель контроллер разрешил бы
  // молча — отказ здесь.
  if (policy.reviewGate !== undefined && policy.reviewGate !== null) {
    operatorFiles.push(await nestedPolicyFile(
      join(dirname(policy.reviewGate), 'routes.json'), treeAliases));
  }
  // Эффективный kill-switch демона (--switch > pilot.killSwitch): как у
  // createPilotSwitch — абсолютный путь вне дерева воркера; родительский
  // каталог каноничен (сам стоп-файл может ещё не существовать, но
  // существующий не должен быть симлинком).
  // Каждый действующий путь проверяется независимо: контроллер использует
  // activation.killSwitch (pilot.killSwitch) для допуска пилота, а
  // --switch (или pilot.killSwitch при его отсутствии) — как daemon-стоп.
  // Поэтому явный --switch не маскирует pilot.killSwitch из проверки.
  // abPilot без switch — не «отсутствует»: enrollAbPilot контроллера
  // безусловно передаёт config.switch в createPilotSwitch и отклонил бы
  // конфигурацию уже после записи Git-конфига; отказ здесь.
  if (policy?.abPilot !== undefined && policy.abPilot?.switch === undefined) {
    fail('path_not_absolute');
  }
  // Демон без kill-switch не стартует: daemonSwitchPath контроллера
  // (--switch ?? pilot.killSwitch) обязан быть задан — контроллер
  // отклонил бы его отсутствие уже после записи Git-конфига; отказ при
  // построении плана, в том числе в dry-run.
  if (values.daemon && values.switch === undefined &&
      policy?.pilot?.killSwitch === undefined) {
    fail('daemon_switch_required');
  }
  const swDirs = [];
  for (const daemonSwitch of new Set(
    [values.switch, policy?.pilot?.killSwitch, policy?.abPilot?.switch])) {
    // Явный null (или нестроковое значение, отличное от undefined) — не
    // «отсутствует»: контроллер подставил бы его в daemonSwitchPath, а
    // L2 обязан отклонить такой вход до Git-конфига, а не пропустить.
    if (daemonSwitch === undefined) continue;
    if (typeof daemonSwitch !== 'string' || !isAbsolute(daemonSwitch)) {
      fail('path_not_absolute');
    }
    // Неканоническая строка (завершающий '/', '.', '..', повторные '//')
    // отклоняется до lstat: нормализация обязана быть тождественной.
    if (daemonSwitch !== posix.normalize(daemonSwitch) || daemonSwitch.endsWith('/')) {
      fail('non_canonical_or_symlink_path');
    }
    const swDir = dirname(daemonSwitch);
    const swDirReal = await realpath(swDir).catch(() => fail('path_missing'));
    if (swDirReal !== swDir) fail('non_canonical_or_symlink_path');
    // Граница permitDirectory контроллера — двусторонняя: каталог
    // стоп-файла не пересекается с worktree ни в одну сторону (случай
    // --switch <dir>/stop при route.worktree=<dir>/wt).
    if (treeAliases.some(t => inside(t, swDirReal) || inside(swDirReal, t))) {
      fail('path_inside_worktree');
    }
    // privateDirectory контроллера (createPilotSwitch): каталог стоп-файла
    // обязан быть приватным — каталог владельца без прав для группы и
    // остальных, иначе запуск отклоняется после Git-конфига.
    const swDirSt = await lstat(swDirReal);
    if (!swDirSt.isDirectory() || swDirSt.uid !== process.getuid() ||
        (swDirSt.mode & 0o077) !== 0) {
      fail('switch_dir_not_private');
    }
    swDirs.push(swDirReal);
    // Стоп-файл может ещё не существовать (ENOENT), но любая другая
    // ошибка — включая ENOTDIR (родительский компонент не каталог) —
    // отказ до Git-конфига и запуска контроллера.
    const swSt = await lstat(daemonSwitch).catch(err =>
      err?.code === 'ENOENT' ? null : fail('non_canonical_or_symlink_path'));
    if (swSt?.isSymbolicLink()) fail('non_canonical_or_symlink_path');
    // Существующий стоп-путь обязан быть обычным файлом: контроллер
    // отклоняет каталог/спецфайл при проверке стоп-файла (isFile()).
    if (swSt !== null && !swSt.isFile()) fail('path_not_file');
    if (treeAliases.some(t => inside(t, daemonSwitch))) fail('path_inside_worktree');
  }
  if (ledger !== null) await canonicalOutside(ledger, treeAliases, 'file');
  if (memory !== null) await canonicalOutside(memory, treeAliases, 'dir');
  // Опциональные операторские каталоги политики — та же строгая проверка
  // канонического каталога вне worktree. Parent-граница действует только
  // для trustedReceiptDir (семейство projectMemory, как storeDir);
  // questionGate.inbox и release.directory — соседние каталоги рядом с
  // worktree допустимы (контроллер их не ограничивает по родителю).
  // Явно заданное значение (включая null — контроллер не считает его
  // отсутствующим) обязано быть каноническим абсолютным путём к каталогу:
  // нестроковое/неканоническое отклоняется до Git-конфига и dry-run.
  if (policy?.projectMemory?.trustedReceiptDir !== undefined) {
    await canonicalOutside(policy.projectMemory.trustedReceiptDir, treeAliases, 'dir');
  }
  // Канонические пути сохраняются для перекрёстных границ ниже:
  // ownerAnswerSource отделяет questionGate.inbox от handoffDir, а
  // releaseSetup — release.directory от tree, inbox и --state.
  const qgInbox = policy?.questionGate?.inbox !== undefined
    ? await canonicalOutside(policy.questionGate.inbox, treeAliases, 'dir', { parent: false })
    : null;
  const relDir = policy?.release?.directory !== undefined
    ? await canonicalOutside(policy.release.directory, treeAliases, 'dir', { parent: false })
    : null;
  // --state — тоже операторский путь: контроллер делает лишь realpath без
  // сверки со строкой; каноничность и двусторонняя граница worktree
  // проверяются здесь (parent-граница относится к ledger/memory).
  const state = await canonicalOutside(values.state, treeAliases, 'dir', { parent: false });
  // handoffDir — обязательный inbox сдачи контроллера (realpath без
  // проверки на undefined): канонический каталог вне worktree и вне
  // state в обе стороны (inside(root,inbox)||inside(inbox,root)||
  // inside(tree,inbox) контроллера). Явный null — не «отсутствует»:
  // отклоняется в canonicalOutside до Git-конфига.
  if (policy.handoffDir === undefined) fail('handoff_required');
  const handoff = await canonicalOutside(policy.handoffDir, treeAliases, 'dir', { parent: false });
  if (inside(state, handoff) || inside(handoff, state)) fail('path_inside_worktree');
  // Inbox сдачи — рабочий путь воркера: операторский файл внутри него
  // контроллер отклонил бы («Operator files must be outside worker
  // paths») уже после записи Git-конфига; отказ здесь, до эффекта.
  if (operatorFiles.some(f => inside(handoff, f))) fail('path_inside_worktree');
  // Перекрёстные границы опциональных каталогов политики (как у
  // ownerAnswerSource/releaseSetup контроллера): questionGate.inbox
  // отделён от handoffDir, release.directory — от state и handoffDir,
  // в обе стороны. Отказ до Git-конфига и в dry-run.
  if (qgInbox !== null &&
      (inside(qgInbox, handoff) || inside(handoff, qgInbox))) {
    fail('path_inside_worktree');
  }
  if (relDir !== null &&
      (inside(relDir, state) || inside(state, relDir) ||
       inside(relDir, handoff) || inside(handoff, relDir))) {
    fail('path_inside_worktree');
  }
  // Каталоги стоп-файлов — та же двусторонняя permitDirectory-граница
  // против state и handoffDir (inbox сдачи контроллера).
  for (const swDir of swDirs) {
    if (inside(state, swDir) || inside(swDir, state) ||
        inside(handoff, swDir) || inside(swDir, handoff)) {
      fail('path_inside_worktree');
    }
  }
  // abPilot.catalog и abPilot.observerWorkspace — операторские пути
  // foreman-пилота: контроллер требует их realpath-каноничность и
  // separate() против [tree, root, inbox] (каталог наблюдателя — ещё и
  // против catalog). Та же двусторонняя граница здесь, до Git-конфига:
  // явно заданное значение (включая null) обязано быть каноническим
  // каталогом вне worktree, state и handoffDir.
  const abCatalog = policy?.abPilot?.catalog !== undefined
    ? await canonicalOutside(policy.abPilot.catalog, treeAliases, 'dir', { parent: false })
    : null;
  if (abCatalog !== null &&
      (inside(state, abCatalog) || inside(abCatalog, state) ||
       inside(handoff, abCatalog) || inside(abCatalog, handoff))) {
    fail('path_inside_worktree');
  }
  if (policy?.abPilot?.observerWorkspace !== undefined) {
    const abWorkspace = await canonicalOutside(
      policy.abPilot.observerWorkspace, treeAliases, 'dir', { parent: false });
    if (inside(state, abWorkspace) || inside(abWorkspace, state) ||
        inside(handoff, abWorkspace) || inside(abWorkspace, handoff) ||
        (abCatalog !== null &&
         (inside(abCatalog, abWorkspace) || inside(abWorkspace, abCatalog)))) {
      fail('path_inside_worktree');
    }
    // Контроллер принимает только пустой каталог наблюдателя
    // ((await readdir(...)).length === 0 в enrollAbPilot): непустой
    // отклоняется здесь, до Git-конфига, а не после него.
    if ((await readdir(abWorkspace)).length !== 0) fail('path_not_empty');
  }

  // Стоп-файлы пилотов — единый createPilotSwitch контроллера (та же
  // permitDirectory-граница [tree, inbox, root]): каталог стоп-файла
  // каноничен, приватен и не пересекается с worktree, state и handoffDir.
  const permitSwitchDir = dir => [worktreeReal, handoff, state]
    .every(p => !inside(p, dir) && !inside(dir, p));
  // abPilot.switch — как в enrollAbPilot: файл обязан уже существовать и
  // быть открытым стоп-файлом ('run\n', 0600, nlink === 1) до записи
  // Git-конфига — assertOpen() здесь безусловен.
  if (policy?.abPilot?.switch !== undefined) {
    const assertAbOpen = await createPilotSwitch(policy.abPilot.switch,
      { permitDirectory: permitSwitchDir });
    await assertAbOpen();
  }
  // pilot.killSwitch при действующем pilot-допуске (scope 'pilot' +
  // pilot.enabled): в не-daemon режиме контроллер вызывает switchOpen()
  // сразу (файл обязан быть открытым стоп-файлом); в daemon-режиме
  // eager-проверка пропускается — стоп ловит первый тик демона, а
  // симлинк/каталог уже отклонены проверкой пути выше.
  if (policy?.scope === 'pilot' && policy?.pilot?.enabled === true &&
      policy.pilot?.killSwitch !== undefined) {
    const assertPilotOpen = await createPilotSwitch(policy.pilot.killSwitch,
      { permitDirectory: permitSwitchDir });
    if (!values.daemon) await assertPilotOpen();
  }

  // CLI-override без конфликта с политикой передаётся контроллеру через
  // тот же env-канал (DF_DECISION_LEDGER_PATH / DF_PROJECT_MEMORY_DIR):
  // проверенный путь и есть используемый путь. В план попадают только
  // переопределения — унаследованное окружение (токены, ключи) не печатается.
  const envOverrides = {};
  if (values['ledger-path'] !== undefined) envOverrides[LEDGER_PATH_ENV] = values['ledger-path'];
  if (values['memory-dir'] !== undefined) envOverrides[MEMORY_DIR_ENV] = values['memory-dir'];

  // Делегирование строго принятому контроллеру: ни путь, ни бинарник
  // не переопределяются флагами.
  const runIsolated = join(HERE, '..', 'board_pipeline', 'run-isolated.mjs');
  const argv = [runIsolated, '--execute', '--policy', policyPathReal, '--state', state];
  for (const flag of PASSTHROUGH_BOOL) if (values[flag]) argv.push(`--${flag}`);
  for (const flag of PASSTHROUGH_VALUE) {
    if (values[flag] !== undefined) argv.push(`--${flag}`, values[flag]);
  }
  return { node: process.execPath, argv, env: envOverrides,
    worktree: worktreeReal, spec: { provider: values.provider, model: values.model },
    policy: policyPathReal, state, ledger, memory, handoff };
}

async function defaultGit(args) {
  return (await execFileAsync('git', args, { timeout: 30_000 })).stdout.trim();
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
  await git(['-C', worktree, 'config', '--local', 'core.fileMode', 'false']);
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
  const result = await run(plan.node, plan.argv,
    { ...(deps.env ?? process.env), ...plan.env });
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
