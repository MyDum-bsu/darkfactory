// Тонкий операторский CLI постановки одной задачи на Board через
// `vb tasks create`. Только безопасная постановка: без обхода очереди,
// без claim/spawn — исполнение идёт строго через принятый контроллер
// (board_pipeline/run-isolated.mjs / daemon.mjs, см. ops/factory-run.mjs).
// Все проверки — до любого эффекта; --dry-run печатает план без вызова vb.
//
//   node ops/factory-enqueue.mjs \
//     --board-url URL --channel CH (--title T | --text BODY) \
//     --repo-id R --profile P --finish verified|deployed \
//     (--spec-digest HEX64 | --brief FILE) \
//     (--policy-digest HEX64 | --policy FILE) \
//     [--label k=v ...] [--ticket ID] [--worktree DIR] [--memory-dir DIR] \
//     [--ledger-path FILE] [--vb PATH] [--dry-run] [--json]
//
// --policy FILE: дайджест считается так же, как контроллер закрепляет
// входы при приёмке — sha256 JSON-массива sha256-хэшей файлов маршрута
// [policyFile, brief, reviewPrompt, reviewGate, routes.json, ...skillPaths]
// (board_pipeline/run-isolated.mjs readOperatorInputs); иначе метка
// policy_digest не сойдётся с отпечатком и seal вернёт policy_digest_drift.
import { isUtf8 } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { operatorReviewSetup } from '../board_pipeline/review-setup.mjs';
import { resolveL1Profile } from '../board_pipeline/l1-profiles.mjs';
import { assertNoBranchDrift } from '../board_pipeline/branch-drift.mjs';

const execFileAsync = promisify(execFile);
const HEX64 = /^[0-9a-f]{64}$/;
const REPO_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const FINISH = new Set(['verified', 'deployed']);
// Метка allowed_paths — scope fence воркера: список относительных путей
// через запятую, не длиннее 256 символов. Невалидное значение (абсолютный
// путь, '~', сегмент '..', пустой сегмент, обратный слэш, управляющие
// символы) доезжало бы до Board и отклонялось бы поздно на verify/seal —
// отказ здесь, до вызова vb.
const ALLOWED_PATHS_LIMIT = 256;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
function validateAllowedPathsLabel(value) {
  if (typeof value !== 'string' || value.length === 0) fail('allowed_paths_invalid');
  if (value.length > ALLOWED_PATHS_LIMIT) fail('allowed_paths_too_long');
  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '' || trimmed.startsWith('/') || trimmed.startsWith('~') ||
        trimmed.includes('\\') || CONTROL_CHARS.test(trimmed) ||
        trimmed.split('/').some(segment => segment === '..')) {
      fail('allowed_paths_invalid');
    }
  }
}
// Контрактные метки и ключи проверенных CLI-путей: произвольный --label их
// не переопределяет (иначе в Board уйдёт путь без проверки).
const RESERVED_LABELS = new Set(
  ['spec_digest', 'policy_digest', 'repo_id', 'profile_id', 'finish',
    'memory_dir', 'ledger_path', 'worktree', 'ticket', 'l1_profile']);

function fail(code) { throw new Error(code); }

// Инвариант каноничности операторских путей (как у контроллера): вход
// обязан быть строго каноническим абсолютным путём — без симлинк-компонентов
// и без '..'/'.' (realpath совпадает со строкой пути). Любая цепочка
// симлинков (D/alias/wt/out/..., alias1 -> alias2 -> wt/link, op/link/../x)
// отклоняется до хэширования и до вызова vb — ручной обход хопов не нужен.
// Семантика inside() контроллера (relative, а не префикс): корректна и
// для корня ФС — '/' содержит любой абсолютный путь.
const within = (root, p) => {
  const rel = relative(root, p);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

async function executableInput(path, { worktrees = [], outside = [] } = {}) {
  if (typeof path !== 'string' || !path) fail('path_required');
  if (!isAbsolute(path)) fail('path_not_absolute');
  if (normalize(path) !== path) fail('non_canonical_or_symlink_path');
  const real = await realpath(path).catch(() => fail('path_missing'));
  const st = await lstat(real);
  if (!st.isFile()) fail('path_not_file');
  const parts = path.split('/').filter(part => part !== '');
  const prefixes = [];
  for (let length = 1; length <= parts.length; length++) {
    prefixes.push(`/${parts.slice(0, length).join('/')}`);
  }
  const witnesses = new Set([path, real]);
  for (const prefix of prefixes) {
    witnesses.add(await realpath(prefix).catch(() => fail('path_missing')));
  }
  for (const candidate of witnesses) {
    if (worktrees.some(w => within(w, candidate)) ||
        outside.some(d => within(d, candidate))) {
      fail('path_inside_worktree');
    }
  }
  return real;
}

async function canonicalInput(path,
    { worktrees = [], mustBe, storage = false, outside = [] } = {}) {
  if (typeof path !== 'string' || !path) fail('path_required');
  if (!isAbsolute(path)) fail('path_not_absolute');
  const real = await realpath(path).catch(() => fail('path_missing'));
  if (real !== path) fail('non_canonical_or_symlink_path');
  const st = await lstat(real);
  if (st.isSymbolicLink()) fail('non_canonical_or_symlink_path');
  if (mustBe === 'file' && !st.isFile()) fail('path_not_file');
  if (mustBe === 'dir' && !st.isDirectory()) fail('path_not_dir');
  // Пути хранилищ (--memory-dir, --ledger-path) — та же двусторонняя
  // граница, что у factory-run/контроллера (canonicalOutside): хранилище
  // (для файла журнала — его родительский каталог) не содержит worktree
  // и не содержится в нём, иначе в Board ушла бы карточка с путями,
  // которые контроллер отклонит при запуске. outside — те же операторские
  // каталоги вне рабочего каталога сдачи (handoffDir): хранилище внутри
  // inbox сдачи или содержащее его контроллер отклонил бы так же.
  // Общий родитель учитывается только для файла журнала (как в
  // factory-run): соседние каталоги памяти/квитанций и сдачи — допустимая
  // непересекающаяся раскладка, общий родитель их не блокирует.
  if (worktrees.some(w => within(w, real) ||
      (storage && (within(real, w) || within(dirname(real), w)))) ||
      outside.some(d => within(d, real) || within(real, d) ||
      (storage && mustBe === 'file' && within(dirname(real), d)))) {
    fail('path_inside_worktree');
  }
  return real;
}

const sha256File = async path =>
  createHash('sha256').update(await readFile(path)).digest('hex');

// Путь хранилища из политики (та же форма, что у контроллера:
// resolveLedgerPath принимает строку или { path }, resolveMemoryStoreDir —
// строку или { storeDir|dir|path }). Явный null/''/нестроковое значение —
// заданный, но непригодный вход: отказ до вызова vb, а не молчаливый
// пропуск (factory-run с такой политикой тоже отказал бы).
const policyStoragePath = (cfg, keys) => {
  if (cfg === undefined) return undefined;
  if (cfg === null) fail('path_not_absolute');
  if (typeof cfg === 'string') return cfg;
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

// Тот же отпечаток, что контроллер запишет в route.policyDigest и приёмка
// сверит с меткой карточки на seal (readOperatorInputs, run-isolated.mjs).
// Каждый вложенный вход проходит ту же проверку, что и --brief/--policy:
// не симлинк и строго вне worktree — контроллер отклонил бы такую политику
// ('Operator files must be outside worker paths'), карточка не создаётся.
async function pinnedPolicyDigest(file, policy, { worktrees = [], separate = [] } = {}) {
  const reviewSetup = await operatorReviewSetup(policy);
  const check = async p => {
    const real = await canonicalInput(p, { worktrees, mustBe: 'file' });
    // Вложенный операторский вход внутри handoffDir (inbox сдачи —
    // рабочего пути воркера) контроллер отклонил бы при запуске.
    if (separate.some(d => within(d, real))) fail('path_inside_worktree');
    return real;
  };
  const gate = await check(policy.reviewGate);
  // Исходные пути навыков проверяются до realpath, который заранее делает
  // operatorReviewSetup: иначе wt/link/skill.md проходит через симлинк
  // воркера. Resolved путь обязан совпасть с привязкой допуска.
  const skillFiles = await Promise.all(reviewSetup.skills.map(async (skill, i) => {
    const real = await check(policy.reviewSkillFiles?.[skill]);
    if (real !== reviewSetup.skillPaths[i]) fail('review_skill_path_mismatch');
    return real;
  }));
  // Все привязки reviewSkillFiles — операторские файлы контроллера
  // (factory-run проверяет каждое значение, не только выбранные критиком
  // reviewSetup.skills): невыбранная привязка внутри worktree/handoffDir
  // — отказ до создания карточки, но в состав дайджеста она не входит.
  for (const p of Object.values(policy.reviewSkillFiles ?? {})) {
    if (p !== undefined) await check(p);
  }
  const files = [file, await check(policy.brief), await check(policy.reviewPrompt),
    gate, await check(join(dirname(gate), 'routes.json')), ...skillFiles];
  const hashes = await Promise.all(files.map(sha256File));
  const computed = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  // Семантика контроллера (p.policyDigest ?? route.policyDigest): null —
  // вычисленный отпечаток; ненулевое закреплённое значение обязано быть
  // строкой из 64 hex (массив/число проходили бы test за счёт приведения).
  // Границы входов выше проверены всё равно — закрепление дайджеста
  // проверку путей не отменяет.
  if (policy?.policyDigest != null) {
    if (typeof policy.policyDigest !== 'string' || !HEX64.test(policy.policyDigest)) {
      fail('policy_digest_invalid');
    }
    return policy.policyDigest;
  }
  return computed;
}

// Механический Branch Drift Preflight (V2-3): до постановки проверяем, что
// в репозитории worktree нет невлитых веток, пересекающихся с --touch
// путями задачи, и грязных bb/thr_* worktree. Проверка активируется, когда
// worktrees[0] — git-репозиторий, либо явным --check-drift (на не-git
// входе — fail-closed drift_check_unavailable). Дрейф без --allow-drift
// блокирует постановку до вызова vb.
async function branchDriftPreflight({ worktrees, values, deps }) {
  const repoDir = worktrees[0];
  const explicit = values['check-drift'] === true;
  if (repoDir === undefined && !explicit) return null;
  const execGit = deps.execGit ?? (async (args, cwd) =>
    (await execFileAsync('git', args, { cwd, timeout: 20_000 })).stdout);
  const isGit = repoDir !== undefined &&
    await Promise.resolve(execGit(['rev-parse', '--is-inside-work-tree'], repoDir))
      .then(out => out.trim() === 'true').catch(() => false);
  if (!isGit && !(deps.checkBranchDrift && repoDir !== undefined)) {
    if (explicit) fail('drift_check_unavailable');
    return null;
  }
  const check = deps.checkBranchDrift ?? assertNoBranchDrift;
  const report = await check({
    repoDir,
    baseRef: values['drift-base'] ?? 'HEAD',
    touchPaths: values.touch ?? [],
    allowDrift: values['allow-drift'] === true,
    execGit,
  });
  return report;
}

// Собирает проверенный план вызова `vb tasks create`. Ничего не исполняет.
export async function buildEnqueuePlan(values, deps = {}) {
  const url = values['board-url'];
  try {
    const parsed = new URL(url ?? '');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('board_url_invalid');
  } catch (error) {
    if (error.code === 'ERR_INVALID_URL' || url === undefined) fail('board_url_invalid');
    throw error;
  }
  for (const [flag, v] of [['channel', values.channel], ['profile_id', values.profile]]) {
    if (typeof v !== 'string' || !v.trim()) fail(`${flag}_required`);
  }
  // Формат нативной очереди (native-board.mjs): вне формата карточка не
  // допускается к захвату — отказ до её создания.
  if (!REPO_LABEL.test(values['repo-id'] ?? '')) fail('repo_id_invalid');
  if (!FINISH.has(values.finish)) fail('finish_invalid');

  const worktrees = values.worktree === undefined ? []
    : [await canonicalInput(values.worktree, { mustBe: 'dir' })];
  // Граница policy.route.worktree — то же дерево, которое контроллер
  // объявит рабочим: она действует на ВСЕ входы (сам файл --policy,
  // --brief, --memory-dir, --ledger-path и вложенные файлы политики),
  // поэтому политика читается первой — до хэширования и до вызова vb.
  let policyJson;
  let policyFile;
  let handoff;
  if (values.policy !== undefined) {
    policyFile = await canonicalInput(values.policy, { worktrees, mustBe: 'file' });
    policyJson = JSON.parse(await readFile(policyFile, 'utf8'));
    // Любое явно заданное route.worktree (включая "", null и нестроковые
    // значения) — операторский вход: невалидный путь к каталогу
    // отклоняется до вызова vb, а не молча пропускается.
    if (policyJson?.route?.worktree !== undefined) {
      // route.worktree — операторский путь: строго канонический абсолютный
      // (realpath обязан совпасть с исходной строкой), иначе граница
      // проверялась бы не по тому пути, что задал оператор.
      if (typeof policyJson.route.worktree !== 'string' ||
          !isAbsolute(policyJson.route.worktree)) fail('path_not_absolute');
      const wtReal = await realpath(policyJson.route.worktree)
        .catch(() => fail('worktree_missing'));
      if (wtReal !== policyJson.route.worktree) fail('non_canonical_or_symlink_path');
      // Как и явный --worktree, route.worktree обязан быть каталогом:
      // обычный файл — непригодное рабочее дерево, отказ до вызова vb.
      if (!(await lstat(wtReal)).isDirectory()) fail('path_not_dir');
      worktrees.push(wtReal);
      // И сам файл политики обязан лежать вне дерева воркера.
      policyFile = await canonicalInput(values.policy, { worktrees, mustBe: 'file' });
    }
    // handoffDir — inbox сдачи контроллера: двусторонняя граница против
    // worktree ('Handoff inbox must be separate') и операторские файлы
    // (сам файл политики, brief, reviewPrompt, reviewGate, routes.json,
    // reviewSkillFiles) вне него ('Operator files must be outside worker
    // paths'); карточка с незапускаемой политикой не создаётся.
    if (policyJson.handoffDir !== undefined) {
      handoff = await canonicalInput(policyJson.handoffDir, { worktrees, mustBe: 'dir' });
      if (worktrees.some(w => within(handoff, w)) ||
          within(handoff, policyFile)) {
        fail('path_inside_worktree');
      }
    }
    // Пути хранилищ из политики — та же граница, что и у флагов
    // --ledger-path/--memory-dir: журнал и память внутри worktree или
    // handoffDir (или содержащие их) контроллер отклонил бы при запуске;
    // карточка с незапускаемой закреплённой политикой на Board не
    // создаётся.
    const outside = handoff === undefined ? [] : [handoff];
    const policyLedger = policyStoragePath(policyJson.decisionLedger, ['path']);
    const policyMemory = policyStoragePath(policyJson.projectMemory,
      ['storeDir', 'dir', 'path']);
    const policyReceipts = policyJson?.projectMemory?.trustedReceiptDir;
    // Заданные пути хранилищ без границы worktree не подтверждают
    // двустороннее разделение хранилища и рабочего дерева: контроллер
    // отклонил бы такой запуск — отказ до вызова vb. Объект настроек без
    // пути (decisionLedger.maxChars и т.п.) путём хранилища не является
    // и требования не вызывает.
    if (worktrees.length === 0 &&
        (policyLedger !== undefined || policyMemory !== undefined ||
         policyReceipts !== undefined)) {
      fail('worktree_required');
    }
    if (policyLedger !== undefined) {
      await canonicalInput(policyLedger,
        { worktrees, mustBe: 'file', storage: true, outside });
    }
    if (policyMemory !== undefined) {
      await canonicalInput(policyMemory,
        { worktrees, mustBe: 'dir', storage: true, outside });
    }
    // projectMemory.trustedReceiptDir — то же семейство хранилищ, что и
    // storeDir (проверка factory-run/контроллера): та же двусторонняя
    // storage-граница вне worktree и handoffDir.
    if (policyReceipts !== undefined) {
      await canonicalInput(policyReceipts,
        { worktrees, mustBe: 'dir', storage: true, outside });
    }
    // Заданные пути хранилищ без policy.handoffDir не подтверждают
    // границу с каталогом сдачи: factory-run отклоняет такую политику
    // с handoff_required — тот же отказ здесь, до вызова vb, иначе в
    // Board ушла бы карточка с незапускаемой политикой.
    if (handoff === undefined &&
        (policyLedger !== undefined || policyMemory !== undefined ||
         policyReceipts !== undefined)) {
      fail('handoff_required');
    }
  }
  // Branch Drift Preflight до любого эффекта: дрейф без --allow-drift
  // блокирует постановку (branch_drift_detected в error.drift — отчёт).
  const drift = await branchDriftPreflight({ worktrees, values, deps });
  const driftAllowed = drift?.driftDetected === true;

  let specDigest = values['spec-digest'];
  let briefText;
  if (values.brief !== undefined) {
    const briefReal = await canonicalInput(values.brief, { worktrees, mustBe: 'file' });
    // --brief — тоже операторский файл: внутри handoffDir (inbox сдачи —
    // рабочего каталога воркера) контроллер отклонил бы запуск, поэтому
    // дайджест спеки из него в Board не уходит.
    if (handoff !== undefined && within(handoff, briefReal)) {
      fail('path_inside_worktree');
    }
    const briefBytes = await readFile(briefReal);
    if (!isUtf8(briefBytes)) fail('brief_not_utf8');
    briefText = briefBytes.toString('utf8');
    const briefDigest = createHash('sha256').update(briefBytes).digest('hex');
    // Явный --spec-digest обязан совпадать с хэшем файла спеки — иначе
    // в Board ушла бы метка, не сходящаяся с приёмкой. Недопустимый или
    // несовпадающий дайджест отклоняется до вызова vb, а не
    // перезаписывается вычисленным значением.
    if (specDigest !== undefined) {
      if (!HEX64.test(specDigest)) fail('spec_digest_invalid');
      if (specDigest !== briefDigest) fail('spec_digest_mismatch');
    }
    specDigest = briefDigest;
  }
  const title = values.text ?? (values.brief !== undefined ? briefText : values.title);
  if (typeof title !== 'string' || !title.trim()) fail('title_or_text_required');

  let policyDigest = values['policy-digest'];
  if (values.policy !== undefined) {
    const pinned = await pinnedPolicyDigest(policyFile, policyJson,
      { worktrees, separate: handoff === undefined ? [] : [handoff] });
    // Явный --policy-digest обязан совпадать с вычисленным/закреплённым
    // значением — иначе в Board ушла бы метка, не сходящаяся с приёмкой.
    if (policyDigest !== undefined && policyDigest !== pinned) fail('policy_digest_mismatch');
    policyDigest = pinned;
  }
  if (!HEX64.test(specDigest ?? '')) fail('spec_digest_invalid');
  if (!HEX64.test(policyDigest ?? '')) fail('policy_digest_invalid');

  const extra = {};
  for (const [flag, key] of [['memory-dir', 'memory_dir'], ['ledger-path', 'ledger_path']]) {
    if (values[flag] !== undefined) {
      // Без --policy значение handoffDir неизвестно: по одному
      // --policy-digest двустороннюю границу хранилища против inbox сдачи
      // подтвердить нельзя — в Board не уходит метка с непроверенным
      // путём, отказ до вызова vb.
      if (values.policy === undefined) fail('policy_required');
      // Без границы worktree (--worktree или policy.route.worktree)
      // двустороннюю границу хранилища против рабочего дерева подтвердить
      // нельзя — контроллер отклонил бы запуск, отказ до вызова vb.
      if (worktrees.length === 0) fail('worktree_required');
      // Та же двусторонняя storage-граница действует и против handoffDir:
      // журнал/память — операторские пути вне рабочего каталога сдачи.
      extra[key] = await canonicalInput(values[flag],
        { worktrees, mustBe: flag === 'memory-dir' ? 'dir' : 'file',
          storage: true,
          outside: handoff === undefined ? [] : [handoff] });
      // Политика без handoffDir — та же неподтверждённая граница
      // (factory-run отклоняет её с handoff_required): отказ после
      // проверки каноничности и worktree-границы, до вызова vb.
      if (handoff === undefined) fail('handoff_required');
    }
  }
  if (values.ticket !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(values.ticket)) fail('ticket_invalid');
    extra.ticket = values.ticket;
  }
  if (worktrees.length) extra.worktree = worktrees[0];

  // L1-профиль проверок: явный --l1-profile и закреплённый
  // profiles.<profile>.l1Profile политики — оба строго из реестра; при
  // расхождении — отказ до вызова vb. Без явного выбора действует
  // дефолт репозитория (python-node для optimization/autoresearcher).
  const policyProfileL1 = policyJson?.profiles?.[values.profile]?.l1Profile;
  if (policyProfileL1 !== undefined) resolveL1Profile({ l1Profile: policyProfileL1 });
  if (values['l1-profile'] !== undefined) {
    resolveL1Profile({ l1Profile: values['l1-profile'] });
  }
  if (values['l1-profile'] !== undefined && policyProfileL1 !== undefined &&
      values['l1-profile'] !== policyProfileL1) {
    fail('l1_profile_mismatch');
  }
  const l1Profile = resolveL1Profile({
    l1Profile: values['l1-profile'] ?? policyProfileL1,
    repoId: values['repo-id'] }).id;
  // Явный l1Profile рецептов проверок выбранного профиля — тот же
  // контрактный источник, что в buildRunPlan: неизвестное имя и
  // расхождение с --l1-profile или закреплённым l1Profile профиля
  // отклоняются до вызова vb, а не при приёмке.
  const selProfile = policyJson?.profiles?.[values.profile];
  for (const recipe of [...(selProfile?.checks ?? []),
    ...(selProfile?.check === undefined ? [] : [selProfile.check]),
    ...(selProfile?.visual === undefined ? [] : [selProfile.visual])]) {
    if (recipe?.l1Profile !== undefined) {
      resolveL1Profile({ l1Profile: recipe.l1Profile });
      if ((values['l1-profile'] !== undefined &&
            values['l1-profile'] !== recipe.l1Profile) ||
          (policyProfileL1 !== undefined &&
            policyProfileL1 !== recipe.l1Profile)) {
        fail('l1_profile_mismatch');
      }
    }
  }

  const labels = { spec_digest: specDigest, policy_digest: policyDigest,
    repo_id: values['repo-id'], profile_id: values.profile, finish: values.finish, ...extra };
  // Метка ставится только при ЯВНОМ выборе (CLI --l1-profile или
  // profiles.<profile>.l1Profile политики): она — контрактный явный
  // источник для контроллера. Авто-дефолт репозитория на карточку не
  // пишется — контроллер выводит его по repo_id сам, а записанный
  // дефолт стал бы явным выбором и ложно конфликтовал бы с явным
  // l1Profile рецепта политики приёмки.
  if (values['l1-profile'] !== undefined || policyProfileL1 !== undefined) {
    labels.l1_profile = l1Profile;
  }
  for (const item of values.label ?? []) {
    const i = item.indexOf('=');
    // Метка обязана быть в синтаксисе k=v: без разделителя значение не
    // выводится из ключа — отказ до вызова vb, а не --label k=k.
    if (i < 0) fail('label_invalid');
    const key = item.slice(0, i);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || RESERVED_LABELS.has(key)) fail('label_invalid');
    const value = item.slice(i + 1);
    // fixtures_digest — контрактная метка приёмки: как в
    // contractLabelsValid нативной очереди значение обязано быть
    // 64-hex дайджестом, иначе карточка отклоняется до вызова vb.
    if (key === 'fixtures_digest' && !HEX64.test(value)) fail('label_invalid');
    // has_ui — булева метка контракта: contractOf читает строго 'true'/
    // 'false' в нижнем регистре, любое другое значение ('TRUE', '1')
    // молча меняло бы смысл карточки — отказ до вызова vb.
    if (key === 'has_ui' && value !== 'true' && value !== 'false') fail('has_ui_invalid');
    // allowed_paths — scope fence воркера: malformed-пути отклоняются
    // здесь, а не поздно на verify/seal.
    if (key === 'allowed_paths') validateAllowedPathsLabel(value);
    labels[key] = value;
  }

  // Реальный синтаксис vb: `vb --url URL tasks create CHANNEL TITLE --label k=v --json`.
  const argv = ['--url', url, 'tasks', 'create', values.channel, title];
  for (const [key, value] of Object.entries(labels)) argv.push('--label', `${key}=${value}`);
  argv.push('--json');
  // --vb без флага — команда по умолчанию 'vb'; явный исполняемый файл
  // разрешается до realpath, а все префиксные и конечные witness-пути
  // остаются вне worktree и handoffDir: проверка до вызова vb.
  let tool = 'vb';
  if (values.vb !== undefined) {
    tool = await executableInput(values.vb,
      { worktrees, outside: handoff === undefined ? [] : [handoff] });
  }
  return { tool, argv, labels,
    meta: { boardUrl: url, channel: values.channel, finish: values.finish, l1Profile,
      ...(driftAllowed ? { branchDrift: { ...drift, allowedByFlag: true } }
        : drift ? { branchDrift: { driftDetected: false, summary: drift.summary } }
        : {}) } };
}

export async function runEnqueue(argv, deps = {}) {
  const { values } = parseArgs({ args: argv, options: {
    'board-url': { type: 'string' }, channel: { type: 'string' },
    title: { type: 'string' }, text: { type: 'string' },
    'repo-id': { type: 'string' }, profile: { type: 'string' }, finish: { type: 'string' },
    'spec-digest': { type: 'string' }, brief: { type: 'string' },
    'policy-digest': { type: 'string' }, policy: { type: 'string' },
    label: { type: 'string', multiple: true }, ticket: { type: 'string' },
    worktree: { type: 'string' }, 'memory-dir': { type: 'string' },
    'ledger-path': { type: 'string' }, vb: { type: 'string' },
    'l1-profile': { type: 'string' },
    touch: { type: 'string', multiple: true }, 'drift-base': { type: 'string' },
    'allow-drift': { type: 'boolean' }, 'check-drift': { type: 'boolean' },
    'dry-run': { type: 'boolean' }, json: { type: 'boolean' } } });
  const plan = await buildEnqueuePlan(values, deps);
  if (values['dry-run']) {
    return { dryRun: true, plan };
  }
  const exec = deps.exec ?? (async (cmd, args) =>
    (await execFileAsync(cmd, args, { timeout: 60_000 })).stdout);
  const stdout = await exec(plan.tool, plan.argv);
  return { dryRun: false, plan, stdout };
}

// Текст результата постановки для stdout: в --dry-run — собранный план;
// после реального вызова vb — его вывод (в --json-режиме vb это JSON
// созданной карточки с идентификатором, который обязан дойти до
// оператора, а не подменяться планом).
export function enqueueOutput(result, { json = false } = {}) {
  if (result.dryRun) return `${JSON.stringify(result.plan ?? result, null, 2)}\n`;
  const stdout = result.stdout ?? '';
  if (json && stdout !== '' && !stdout.endsWith('\n')) return `${stdout}\n`;
  return stdout;
}

async function cli(argv) {
  try {
    const result = await runEnqueue(argv);
    const { values } = parseArgs({ args: argv, options: {
      json: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, strict: false });
    const out = enqueueOutput(result, { json: values.json });
    if (out !== '') process.stdout.write(out);
  } catch (error) {
    process.stderr.write(`factory-enqueue: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await cli(process.argv.slice(2));
}
