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
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { operatorReviewSetup } from '../board_pipeline/review-setup.mjs';

const execFileAsync = promisify(execFile);
const HEX64 = /^[0-9a-f]{64}$/;
const REPO_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const FINISH = new Set(['verified', 'deployed']);
// Контрактные метки и ключи проверенных CLI-путей: произвольный --label их
// не переопределяет (иначе в Board уйдёт путь без проверки).
const RESERVED_LABELS = new Set(
  ['spec_digest', 'policy_digest', 'repo_id', 'profile_id', 'finish',
    'memory_dir', 'ledger_path', 'worktree', 'ticket']);

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

async function canonicalInput(path, { worktrees = [], mustBe, storage = false } = {}) {
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
  // которые контроллер отклонит при запуске.
  if (worktrees.some(w => within(w, real) ||
      (storage && (within(real, w) || within(dirname(real), w))))) {
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

// Собирает проверенный план вызова `vb tasks create`. Ничего не исполняет.
export async function buildEnqueuePlan(values) {
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
  const title = values.title ?? values.text;
  if (typeof title !== 'string' || !title.trim()) fail('title_or_text_required');
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
    // Пути хранилищ из политики — та же граница, что и у флагов
    // --ledger-path/--memory-dir: журнал и память внутри worktree (или
    // содержащие его) контроллер отклонил бы при запуске; карточка с
    // незапускаемой закреплённой политикой на Board не создаётся.
    const policyLedger = policyStoragePath(policyJson.decisionLedger, ['path']);
    if (policyLedger !== undefined) {
      await canonicalInput(policyLedger, { worktrees, mustBe: 'file', storage: true });
    }
    const policyMemory = policyStoragePath(policyJson.projectMemory,
      ['storeDir', 'dir', 'path']);
    if (policyMemory !== undefined) {
      await canonicalInput(policyMemory, { worktrees, mustBe: 'dir', storage: true });
    }
    // projectMemory.trustedReceiptDir — то же семейство хранилищ, что и
    // storeDir (проверка factory-run/контроллера): та же двусторонняя
    // storage-граница вне worktree.
    if (policyJson?.projectMemory?.trustedReceiptDir !== undefined) {
      await canonicalInput(policyJson.projectMemory.trustedReceiptDir,
        { worktrees, mustBe: 'dir', storage: true });
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
  }
  let specDigest = values['spec-digest'];
  if (values.brief !== undefined) {
    specDigest = await sha256File(
      await canonicalInput(values.brief, { worktrees, mustBe: 'file' }));
  }
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
      extra[key] = await canonicalInput(values[flag],
        { worktrees, mustBe: flag === 'memory-dir' ? 'dir' : 'file',
          storage: true });
    }
  }
  if (values.ticket !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(values.ticket)) fail('ticket_invalid');
    extra.ticket = values.ticket;
  }
  if (worktrees.length) extra.worktree = worktrees[0];

  const labels = { spec_digest: specDigest, policy_digest: policyDigest,
    repo_id: values['repo-id'], profile_id: values.profile, finish: values.finish, ...extra };
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
    labels[key] = value;
  }

  // Реальный синтаксис vb: `vb --url URL tasks create CHANNEL TITLE --label k=v --json`.
  const argv = ['--url', url, 'tasks', 'create', values.channel, title];
  for (const [key, value] of Object.entries(labels)) argv.push('--label', `${key}=${value}`);
  argv.push('--json');
  // --vb без флага — команда по умолчанию 'vb'; явный путь исполняемого
  // файла — тот же инвариант каноничности вне worktree, что и у прочих
  // операторских входов: проверка до вызова vb.
  const tool = values.vb === undefined ? 'vb'
    : await canonicalInput(values.vb, { worktrees, mustBe: 'file' });
  return { tool, argv, labels,
    meta: { boardUrl: url, channel: values.channel, finish: values.finish } };
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
    'dry-run': { type: 'boolean' }, json: { type: 'boolean' } } });
  const plan = await buildEnqueuePlan(values);
  if (values['dry-run']) {
    return { dryRun: true, plan };
  }
  const exec = deps.exec ?? (async (cmd, args) =>
    (await execFileAsync(cmd, args, { timeout: 60_000 })).stdout);
  const stdout = await exec(plan.tool, plan.argv);
  return { dryRun: false, plan, stdout };
}

async function cli(argv) {
  try {
    const result = await runEnqueue(argv);
    const { values } = parseArgs({ args: argv, options: {
      json: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, strict: false });
    if (result.dryRun || values.json) {
      process.stdout.write(`${JSON.stringify(result.plan ?? result, null, 2)}\n`);
    } else if (result.stdout) {
      process.stdout.write(result.stdout);
    }
  } catch (error) {
    process.stderr.write(`factory-enqueue: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await cli(process.argv.slice(2));
}
