// Тесты тонких CLI: ops/factory-enqueue.mjs и ops/factory-run.mjs.
// Без внешних зависимостей и host-путей: все эффекты через внедряемые
// runner'ы, временные каталоги удаляются в finally.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile }
  from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnqueuePlan, computeSpecDigest, enqueueOutput, runEnqueue } from './factory-enqueue.mjs';
import { buildRunPlan, ensureFilemodeGuard, forbiddenModelViolation,
  modelViolation, runFactory } from './factory-run.mjs';

const execFileAsync = promisify(execFile);
const HEX = 'a'.repeat(64);
const HEX2 = 'b'.repeat(64);
const sha256Text = text => createHash('sha256').update(text).digest('hex');
const sha256File = async path => createHash('sha256').update(await readFile(path)).digest('hex');

// Канонический каталог фикстур: TMPDIR может идти через симлинк-предка —
// позитивные сценарии обязаны передавать CLI канонические пути.
async function tempdir() {
  return realpath(await mkdtemp(join(tmpdir(), 'factory-cli-')));
}

const baseValues = () => ({
  'board-url': 'https://board.example', channel: 'ops', title: 'T',
  'repo-id': 'repo', profile: 'prof', finish: 'verified',
  'spec-digest': HEX, 'policy-digest': HEX2 });

test('enqueue: валидный план и dry-run', async () => {
  const plan = await buildEnqueuePlan(baseValues());
  assert.equal(plan.tool, 'vb');
  // Реальный синтаксис vb: vb --url URL tasks create CHANNEL TITLE --label k=v --json
  assert.deepEqual(plan.argv.slice(0, 5),
    ['--url', 'https://board.example', 'tasks', 'create', 'ops']);
  assert.equal(plan.argv[5], 'T');
  const labels = plan.argv.filter((a, i) => plan.argv[i - 1] === '--label');
  assert.ok(labels.includes(`spec_digest=${HEX}`));
  assert.ok(labels.includes(`policy_digest=${HEX2}`));
  assert.ok(labels.includes('finish=verified'));
  const result = await runEnqueue(
    ['--board-url', 'https://b', '--channel', 'c', '--title', 'T', '--repo-id', 'r',
      '--profile', 'p', '--finish', 'deployed', '--spec-digest', HEX,
      '--policy-digest', HEX2, '--dry-run']);
  assert.equal(result.dryRun, true);
});

test('enqueue: mocked runner получает собранные argv', async () => {
  const calls = [];
  const result = await runEnqueue(
    ['--board-url', 'https://b', '--channel', 'c', '--text', 'body', '--repo-id', 'r',
      '--profile', 'p', '--finish', 'verified', '--spec-digest', HEX,
      '--policy-digest', HEX2],
    { exec: async (cmd, argv) => { calls.push([cmd, argv]); return '{"id":1}'; } });
  assert.equal(result.dryRun, false);
  assert.equal(calls.length, 1);
  assert.ok(calls[0][1].includes('body'));
});

test('enqueue: --json без --dry-run выводит результат vb с id карточки', async () => {
  const plan = await buildEnqueuePlan(baseValues());
  const card = '{"id":7,"channel":"ops"}';
  // Успешная постановка: вывод vb (JSON созданной карточки) доходит до
  // оператора, а не подменяется планом — иначе идентификатор карточки
  // теряется и результат нельзя связать с записью в Board.
  assert.equal(enqueueOutput({ dryRun: false, plan, stdout: card }, { json: true }),
    `${card}\n`);
  assert.equal(enqueueOutput({ dryRun: false, plan, stdout: `${card}\n` }, { json: true }),
    `${card}\n`);
  // План печатается только в --dry-run.
  const dry = enqueueOutput({ dryRun: true, plan }, { json: true });
  assert.equal(dry, `${JSON.stringify(plan, null, 2)}\n`);
  assert.doesNotMatch(dry, /"id":7/);
  // Без --json — тот же stdout vb как есть.
  assert.equal(enqueueOutput({ dryRun: false, plan, stdout: 'created' }), 'created');
});

test('enqueue: отказы до эффекта', async () => {
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'board-url': 'ftp://x' }),
    /board_url_invalid/);
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'board-url': undefined }),
    /board_url_invalid/);
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), channel: '' }),
    /channel_required/);
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), title: undefined, text: undefined }),
    /title_or_text_required/);
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), finish: 'done' }),
    /finish_invalid/);
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'spec-digest': 'zz' }),
    /spec_digest_invalid/);
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'policy-digest': '0'.repeat(63) }),
    /policy_digest_invalid/);
  // repo_id — формат нативной очереди.
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'repo-id': 'repo name' }),
    /repo_id_invalid/);
  // Проверенные пути не переопределяются произвольной меткой.
  for (const key of ['ledger_path', 'memory_dir', 'worktree', 'ticket', 'spec_digest']) {
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      label: [`${key}=spoofed`] }), /label_invalid/);
  }
  // fixtures_digest — контрактная метка приёмки: не-HEX64 значение
  // отклоняется до вызова vb (как в contractLabelsValid нативной очереди).
  for (const bad of ['bad', 'zz' + '0'.repeat(62), '0'.repeat(63), '']) {
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      label: [`fixtures_digest=${bad}`] }), /label_invalid/);
  }
  const fdOk = await buildEnqueuePlan({ ...baseValues(),
    label: [`fixtures_digest=${'c'.repeat(64)}`] });
  assert.equal(fdOk.labels.fixtures_digest, 'c'.repeat(64));
  // has_ui — булева метка контракта: только строгие 'true'/'false',
  // иначе отказ до вызова vb.
  for (const bad of ['TRUE', '1', 'yes', '']) {
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      label: [`has_ui=${bad}`] }), /has_ui_invalid/);
  }
  for (const ok of ['true', 'false']) {
    const plan = await buildEnqueuePlan({ ...baseValues(), label: [`has_ui=${ok}`] });
    assert.equal(plan.labels.has_ui, ok);
  }
  // Метка без разделителя '=' — отказ до вызова vb: значение не
  // выводится из ключа (k=v, а не k=k).
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
    label: ['domain'] }), /label_invalid/);
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
    label: ['fixtures_digest'] }), /label_invalid/);
});

test('enqueue: brief/policy файлы, симлинк и путь внутри worktree отклоняются', async () => {
  const dir = await tempdir();
  try {
    const worktree = join(dir, 'wt');
    await mkdir(worktree);
    const brief = join(dir, 'brief.md');
    await writeFile(brief, 'spec');
    const plan = await buildEnqueuePlan({ ...baseValues(), 'spec-digest': undefined,
      brief, worktree });
    assert.match(plan.labels.spec_digest, /^[0-9a-f]{64}$/);
    // Файл внутри worktree — отказ.
    const inner = join(worktree, 'brief.md');
    await writeFile(inner, 'x');
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'spec-digest': undefined,
      brief: inner, worktree }), /path_inside_worktree/);
    // Симлинк внутри worktree на внешний каталог: путь не канонический —
    // отказ до чтения файла и создания карточки.
    const linkDir = join(worktree, 'link');
    await symlink(dir, linkDir);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'spec-digest': undefined,
      brief: join(linkDir, 'brief.md'), worktree }), /non_canonical_or_symlink_path/);
    // Симлинк на конечном пути — отказ.
    const link = join(dir, 'link.md');
    await symlink(brief, link);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'spec-digest': undefined,
      brief: link, worktree }), /non_canonical_or_symlink_path/);
    // Цепочка D/alias/wt/out/brief.md: alias -> repo, repo/wt/out -> ops —
    // realpath внешний, но путь не канонический: отказ до эффекта.
    const repo = join(dir, 'repo');
    await mkdir(join(repo, 'wt'), { recursive: true });
    const ops = join(dir, 'ops');
    await mkdir(ops);
    const outBrief = join(ops, 'brief.md');
    await writeFile(outBrief, 'x');
    await symlink(join(dir, 'ops'), join(repo, 'wt', 'out'));
    await symlink(repo, join(dir, 'alias'));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'spec-digest': undefined,
      brief: join(dir, 'alias', 'wt', 'out', 'brief.md'), worktree }),
      /non_canonical_or_symlink_path/);
    // Каноническая форма того же файла проходит.
    const ok = await buildEnqueuePlan({ ...baseValues(), 'spec-digest': undefined,
      brief: outBrief, worktree });
    assert.match(ok.labels.spec_digest, /^[0-9a-f]{64}$/);
    // Явный --spec-digest вместе с --brief: недопустимый дайджест
    // отклоняется до вызова vb, а не перезаписывается хэшем файла;
    // валидный, но несовпадающий — та же привязка к версии спеки.
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'spec-digest': 'zz',
      brief, worktree }), /spec_digest_invalid/);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'spec-digest': HEX2,
      brief, worktree }), /spec_digest_mismatch/);
    const pinned = await buildEnqueuePlan({ ...baseValues(),
      'spec-digest': await sha256File(brief), brief, worktree });
    assert.equal(pinned.labels.spec_digest, await sha256File(brief));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enqueue: --brief без --text даёт байт-в-байт текст карточки', async () => {
  const dir = await tempdir();
  try {
    const brief = join(dir, 'brief.md');
    const body = 'first line\nsecond line\n';
    await writeFile(brief, body);
    const plan = await buildEnqueuePlan({ ...baseValues(), title: undefined, text: undefined,
      'spec-digest': undefined, brief });
    assert.equal(plan.argv[5], body);
    assert.equal(plan.argv[5].endsWith('\n'), true);
    assert.equal(plan.labels.spec_digest, await sha256File(brief));
    // Явный --text первичен; --brief остаётся источником spec_digest.
    const explicit = await buildEnqueuePlan({ ...baseValues(), title: undefined,
      text: 'explicit text', 'spec-digest': undefined, brief });
    assert.equal(explicit.argv[5], 'explicit text');
    // Даже legacy --title не подменяет тело, когда --text не задан:
    // --brief — байтовый источник карточки, без потери финального newline.
    const titled = await buildEnqueuePlan({ ...baseValues(), 'spec-digest': undefined, brief });
    assert.equal(titled.argv[5], body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --policy FILE: метка policy_digest — тот же отпечаток закреплённых входов,
// что контроллер проверяет на seal (sha256 JSON-массива sha256 файлов).
test('enqueue: --policy вычисляет закреплённый policy_digest контроллера', async () => {
  const dir = await tempdir();
  try {
    const brief = join(dir, 'brief.md');
    const reviewPrompt = join(dir, 'review.md');
    const gate = join(dir, 'gate', 'board-review.mjs');
    const routes = join(dir, 'gate', 'routes.json');
    const policyFile = join(dir, 'policy.json');
    await mkdir(join(dir, 'gate'));
    await writeFile(brief, 'b');
    await writeFile(reviewPrompt, 'r');
    await writeFile(gate, 'g');
    await writeFile(routes, '{}');
    // Критик закреплён явно (legacy Pi/Sol): дайджест не зависит от
    // DF_AGY_KEYRING_ITEM окружения оператора (Neon-выбор требует keyring).
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate,
      route: { checkProfile: 'p' },
      profiles: { p: { review: { provider: 'openai', model: 'gpt-6.2-sol',
        reasoningLevel: 'medium' } } },
    }));
    const plan = await buildEnqueuePlan({ ...baseValues(), 'policy-digest': undefined,
      policy: policyFile });
    const expected = sha256Text(JSON.stringify(await Promise.all(
      [policyFile, brief, reviewPrompt, gate, routes].map(sha256File))));
    assert.equal(plan.labels.policy_digest, expected);

    // Вложенный вход политики внутри worktree — отказ до чтения и карточки.
    const wt = join(dir, 'wt');
    await mkdir(wt);
    const innerBrief = join(wt, 'brief.md');
    await writeFile(innerBrief, 'x');
    await writeFile(policyFile, JSON.stringify({
      brief: innerBrief, reviewPrompt, reviewGate: gate,
      route: { checkProfile: 'p' },
      profiles: { p: { review: { provider: 'openai', model: 'gpt-6.2-sol',
        reasoningLevel: 'medium' } } },
    }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile, worktree: wt }),
      /path_inside_worktree/);

    // Граница из policy.route.worktree действует и без флага --worktree.
    await writeFile(policyFile, JSON.stringify({
      brief: innerBrief, reviewPrompt, reviewGate: gate,
      route: { checkProfile: 'p', worktree: wt },
      profiles: { p: { review: { provider: 'openai', model: 'gpt-6.2-sol',
        reasoningLevel: 'medium' } } },
    }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }), /path_inside_worktree/);
    // Та же граница действует на --brief, --memory-dir и сам файл
    // политики — тоже без флага --worktree.
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate,
      route: { checkProfile: 'p', worktree: wt },
      profiles: { p: { review: { provider: 'openai', model: 'gpt-6.2-sol',
        reasoningLevel: 'medium' } } },
    }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, 'spec-digest': undefined,
      brief: innerBrief, policy: policyFile }), /path_inside_worktree/);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile, 'memory-dir': wt }),
      /path_inside_worktree/);
    // Обратное направление той же границы (canonicalOutside в factory-run):
    // каталог Project Memory, содержащий worktree, и родительский каталог
    // файла журнала, содержащий worktree, — отказ до вызова vb.
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile, 'memory-dir': dir }),
      /path_inside_worktree/);
    const ledger = join(dir, 'ledger.jsonl');
    await writeFile(ledger, '');
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile, 'ledger-path': ledger }),
      /path_inside_worktree/);
    // Хранилища в отдельном каталоге вне дерева проходят ту же проверку
    // (родительский каталог хранилища тоже не содержит worktree); флаги
    // хранилищ требуют политику с handoffDir — без него границу с
    // каталогом сдачи подтвердить нельзя (handoff_required).
    const store = join(dir, 'sub', 'store');
    await mkdir(store, { recursive: true });
    const storeLedger = join(store, 'ledger.jsonl');
    await writeFile(storeLedger, '');
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile,
      'memory-dir': store, 'ledger-path': storeLedger }), /handoff_required/);
    const cliInbox = join(dir, 'cli-inbox');
    await mkdir(cliInbox);
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate,
      route: { checkProfile: 'p', worktree: wt },
      profiles: { p: { review: { provider: 'openai', model: 'gpt-6.2-sol',
        reasoningLevel: 'medium' } } },
      handoffDir: cliInbox }));
    const storePlan = await buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile,
      'memory-dir': store, 'ledger-path': storeLedger });
    assert.equal(storePlan.labels.memory_dir, store);
    assert.equal(storePlan.labels.ledger_path, storeLedger);
    // Та же граница хранилищ действует на пути, закреплённые в самой
    // политике (decisionLedger/projectMemory): контроллер отклонил бы
    // запуск с path_inside_worktree — карточка с незапускаемой
    // политикой не создаётся и без CLI-флага.
    const wtLedger = join(wt, 'ledger.jsonl');
    await writeFile(wtLedger, '');
    const wtInbox = join(wt, 'inbox');
    await mkdir(wtInbox);
    // Критик закреплён явно (legacy Sol): выбор ревью-профиля не зависит
    // от DF_AGY_KEYRING_ITEM окружения оператора.
    const pinnedReview = { route: { checkProfile: 'p', worktree: wt },
      profiles: { p: { review: { provider: 'openai', model: 'gpt-6.2-sol',
        reasoningLevel: 'medium' } } } };
    for (const embedded of [
      { decisionLedger: wtLedger },
      { decisionLedger: { path: wtLedger } },
      { projectMemory: { storeDir: wt } },
      { projectMemory: { storeDir: dir } },
      // projectMemory.trustedReceiptDir — то же семейство хранилищ, что
      // и storeDir: внутри worktree отказ до вызова vb.
      { projectMemory: { trustedReceiptDir: wt } },
      { projectMemory: { trustedReceiptDir: dir } },
      { handoffDir: wtInbox },
      // handoffDir — двусторонняя граница: родительский каталог,
      // содержащий worktree (и операторские файлы политики), тоже отказ.
      { handoffDir: dir },
    ]) {
      await writeFile(policyFile, JSON.stringify({
        brief, reviewPrompt, reviewGate: gate, ...pinnedReview, ...embedded }));
      await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
        'policy-digest': undefined, policy: policyFile }),
        /path_inside_worktree/);
    }
    // Закреплённый путь хранилища при отсутствии policy.handoffDir —
    // неподтверждённая граница с каталогом сдачи (factory-run отклонил
    // бы ту же политику с handoff_required): отказ до вызова vb.
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate, ...pinnedReview,
      decisionLedger: storeLedger }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }), /handoff_required/);
    // Хранилища и handoffDir не пересекаются в обе стороны: журнал,
    // память и trustedReceiptDir внутри inbox сдачи (или inbox внутри
    // каталога хранилища / родителя файла журнала) контроллер отклонил
    // бы — карточка с такой политикой не создаётся.
    const hoInbox = join(dir, 'ho-inbox');
    await mkdir(hoInbox);
    const hoLedger = join(hoInbox, 'ledger.jsonl');
    await writeFile(hoLedger, '');
    const hoMemory = join(hoInbox, 'memory');
    await mkdir(hoMemory);
    const hoReceipts = join(hoInbox, 'receipts');
    await mkdir(hoReceipts);
    for (const embedded of [
      { decisionLedger: hoLedger },
      { decisionLedger: { path: hoLedger } },
      { projectMemory: { storeDir: hoMemory } },
      { projectMemory: { trustedReceiptDir: hoReceipts } },
      // Обратное направление: handoffDir внутри родительского каталога
      // файла журнала и внутри storeDir памяти — тоже отказ.
      { decisionLedger: join(dir, 'sub', 'ledger2.jsonl'),
        handoffDir: join(dir, 'sub') },
      { projectMemory: { storeDir: join(dir, 'sub') },
        handoffDir: store },
    ]) {
      await writeFile(join(dir, 'sub', 'ledger2.jsonl'), '');
      await writeFile(policyFile, JSON.stringify({
        brief, reviewPrompt, reviewGate: gate, ...pinnedReview,
        handoffDir: hoInbox, ...embedded }));
      await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
        'policy-digest': undefined, policy: policyFile }),
        /path_inside_worktree/);
    }
    // Та же граница действует на CLI-флаги --ledger-path/--memory-dir.
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate, ...pinnedReview,
      handoffDir: hoInbox }));
    // Без файла политики (только --policy-digest) значение handoffDir
    // неизвестно: границу хранилища против inbox сдачи подтвердить
    // нельзя — CLI отклоняет такой вход до вызова vb, в Board не уходит
    // метка с непроверенным путём.
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'ledger-path': storeLedger }), /policy_required/);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'memory-dir': store }), /policy_required/);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile,
      'ledger-path': hoLedger }), /path_inside_worktree/);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile,
      'memory-dir': hoMemory }), /path_inside_worktree/);
    // Пути хранилищ без границы worktree (нет ни --worktree, ни
    // policy.route.worktree) не подтверждают разделение хранилища и
    // рабочего дерева — контроллер отклонил бы такой запуск: отказ
    // worktree_required до вызова vb, и для CLI-флагов, и для путей,
    // закреплённых в политике.
    const noWtReview = { route: { checkProfile: 'p' },
      profiles: { p: { review: { provider: 'openai', model: 'gpt-6.2-sol',
        reasoningLevel: 'medium' } } } };
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate, ...noWtReview,
      handoffDir: hoInbox }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile,
      'memory-dir': store }), /worktree_required/);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile,
      'ledger-path': storeLedger }), /worktree_required/);
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate, ...noWtReview,
      decisionLedger: storeLedger, handoffDir: hoInbox }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }), /worktree_required/);
    // Настройки без пути (decisionLedger.maxChars, projectMemory без
    // storeDir/dir/path/trustedReceiptDir) путём хранилища не являются:
    // без границы worktree постановка всё равно строится.
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate, ...noWtReview,
      decisionLedger: { maxChars: 2000 },
      projectMemory: { maxItems: 50 } }));
    const noPathPlan = await buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile });
    assert.match(noPathPlan.labels.policy_digest, /^[0-9a-f]{64}$/);
    // Канонические хранилища вне дерева в политике проходят, когда
    // handoffDir — отдельный каталог, не пересекающийся с ними. Соседние
    // каталоги памяти/квитанций и сдачи под общим родителем — допустимая
    // раскладка (общий родитель учитывается только для файла журнала).
    const sibBase = join(dir, 'sib');
    const sibMemory = join(sibBase, 'memory');
    const sibReceipts = join(sibBase, 'receipts');
    const sibInbox = join(sibBase, 'inbox');
    await mkdir(sibMemory, { recursive: true });
    await mkdir(sibReceipts);
    await mkdir(sibInbox);
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate, ...pinnedReview,
      decisionLedger: storeLedger,
      projectMemory: { storeDir: sibMemory, trustedReceiptDir: sibReceipts },
      handoffDir: sibInbox }));
    const sibPlan = await buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile });
    assert.match(sibPlan.labels.policy_digest, /^[0-9a-f]{64}$/);
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate, ...pinnedReview,
      decisionLedger: storeLedger, projectMemory: { storeDir: store },
      handoffDir: hoInbox }));
    const embeddedPlan = await buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile });
    assert.match(embeddedPlan.labels.policy_digest, /^[0-9a-f]{64}$/);
    // --brief внутри отдельного handoffDir — отказ до хэширования и vb:
    // рабочий каталог сдачи не должен давать дайджест спеки.
    const handoff = join(dir, 'handoff');
    await mkdir(handoff);
    const hoBrief = join(handoff, 'brief.md');
    await writeFile(hoBrief, 'x');
    const hoSkill = join(handoff, 'logika.md');
    await writeFile(hoSkill, 'x');
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate, ...pinnedReview,
      handoffDir: handoff }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, 'spec-digest': undefined,
      brief: hoBrief, policy: policyFile }), /path_inside_worktree/);
    // Невыбранная критиком привязка reviewSkillFiles внутри handoffDir —
    // та же граница операторских файлов (Pi/Sol навыков не выбирает);
    // состав дайджеста при этом не меняется.
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate, ...pinnedReview,
      handoffDir: handoff, reviewSkillFiles: { logika: hoSkill } }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }),
      /path_inside_worktree/);
    // Явный --vb внутри handoffDir — тот же операторский вход: файл из
    // рабочего каталога сдачи не может исполняться вместо доверенного vb.
    const hoVb = join(handoff, 'vb');
    await writeFile(hoVb, 'x');
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate, ...pinnedReview,
      handoffDir: handoff }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile, vb: hoVb }),
      /path_inside_worktree/);
    const innerPolicy = join(wt, 'policy.json');
    await writeFile(innerPolicy, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate,
      route: { checkProfile: 'p', worktree: wt },
      profiles: { p: { review: { provider: 'openai', model: 'gpt-6.2-sol',
        reasoningLevel: 'medium' } } },
    }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: innerPolicy }), /path_inside_worktree/);
    // Внешний alias, нацеленный на исходящий симлинк внутри worktree
    // (alias -> wt/link -> наружу): путь не канонический — отказ.
    const outLink = join(wt, 'link');
    await symlink(dir, outLink);
    const extAlias = join(dir, 'ext-alias');
    await symlink(outLink, extAlias);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, 'spec-digest': undefined,
      brief: join(extAlias, 'brief.md'), policy: policyFile }),
      /non_canonical_or_symlink_path/);
    // Цепочка через дополнительный внешний симлинк:
    // chain -> ext-alias -> wt/link -> наружу — тоже не каноническая.
    const chain = join(dir, 'chain');
    await symlink(extAlias, chain);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, 'spec-digest': undefined,
      brief: join(chain, 'brief.md'), policy: policyFile }),
      /non_canonical_or_symlink_path/);
    // '..' после симлинка: op/link/../brief-via.md при op/link -> wt/deep —
    // не канонический путь (ни '..', ни симлинк-компоненты не допускаются).
    const op = join(dir, 'op');
    await mkdir(op);
    await mkdir(join(wt, 'deep'));
    await symlink(join(wt, 'deep'), join(op, 'link'));
    await symlink(brief, join(wt, 'brief-via.md'));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, 'spec-digest': undefined,
      brief: `${op}/link/../brief-via.md`, policy: policyFile }),
      /non_canonical_or_symlink_path/);
    // Исходный путь review skill через симлинк внутри worktree — отказ.
    const skill = join(wt, 'skill.md');
    await writeFile(join(dir, 'skill-real.md'), 's');
    await symlink(join(dir, 'skill-real.md'), skill);
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate, reviewSkillFiles: { logika: skill },
      route: { checkProfile: 'p', worktree: wt },
      profiles: { p: { review: { provider: 'openai', model: 'gpt-6.2-sol',
        reasoningLevel: 'medium', skills: ['logika'] } } },
    }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }),
      /path_inside_worktree|symlink|review_skill/);
    // route.worktree через симлинк — неканонический операторский путь:
    // отказ до границы, хэширования и вызова vb.
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate,
      route: { checkProfile: 'p', worktree: extAlias },
      profiles: { p: { review: { provider: 'openai', model: 'gpt-6.2-sol',
        reasoningLevel: 'medium' } } },
    }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }),
      /non_canonical_or_symlink_path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// policy.policyDigest — закреплённый дайджест первичен, как у контроллера
// (p.policyDigest ?? route.policyDigest); явный --policy-digest обязан
// совпадать с ним, иначе метка карточки не сойдётся с приёмкой.
test('enqueue: policy.policyDigest закреплён и сверяется с --policy-digest', async () => {
  const dir = await tempdir();
  try {
    const brief = join(dir, 'brief.md');
    const reviewPrompt = join(dir, 'review.md');
    const gate = join(dir, 'gate', 'board-review.mjs');
    const routes = join(dir, 'gate', 'routes.json');
    const policyFile = join(dir, 'policy.json');
    await mkdir(join(dir, 'gate'));
    await writeFile(brief, 'b');
    await writeFile(reviewPrompt, 'r');
    await writeFile(gate, 'g');
    await writeFile(routes, '{}');
    const write = digest => writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: gate, policyDigest: digest,
      route: { checkProfile: 'p' },
      profiles: { p: { review: { provider: 'openai', model: 'gpt-6.2-sol',
        reasoningLevel: 'medium' } } },
    }));
    await write(HEX);
    const plan = await buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile });
    assert.equal(plan.labels.policy_digest, HEX);
    const ok = await buildEnqueuePlan({ ...baseValues(),
      'policy-digest': HEX, policy: policyFile });
    assert.equal(ok.labels.policy_digest, HEX);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': HEX2, policy: policyFile }), /policy_digest_mismatch/);
    await write('zz');
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }), /policy_digest_invalid/);
    // null — вычисленный отпечаток (семантика ?? контроллера); не-строка
    // с coercible-значением — отказ, а не молчаливая подстановка.
    await write(null);
    const fallback = await buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile });
    assert.match(fallback.labels.policy_digest, /^[0-9a-f]{64}$/);
    await write([HEX]);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }), /policy_digest_invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Обязательные операторские входы политики (handoffDir, brief,
// reviewPrompt, reviewGate): общий канонический набор вне любого
// тестового worktree — политика без них отклоняется при построении
// плана, поэтому валидный минимум задаётся здесь.
let opsFixture = null;
function opsPaths() {
  if (opsFixture) return opsFixture;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-ops-')));
  const inbox = join(dir, 'inbox');
  mkdirSync(inbox);
  writeFileSync(join(dir, 'brief.md'), 'brief');
  writeFileSync(join(dir, 'review.md'), 'review');
  writeFileSync(join(dir, 'gate.json'), '{}');
  writeFileSync(join(dir, 'routes.json'), '{}');
  opsFixture = { handoffDir: inbox, brief: join(dir, 'brief.md'),
    reviewPrompt: join(dir, 'review.md'), reviewGate: join(dir, 'gate.json') };
  return opsFixture;
}

const policySpec = worktree => ({
  ...opsPaths(),
  version: 1,
  bb: { provider: 'acp-devin', model: 'swe-2-high', project: 'proj_x' },
  route: { worktree, checkProfile: 'default', finish: 'verified', repoId: 'r' },
  profiles: { default: { branch: 'b', review: { provider: 'google', model: 'gemini-4-neon' } } },
  arbiter: { provider: 'openai', model: 'gpt-6.2-sol' },
});

async function withPolicy(dir, policy) {
  const file = join(dir, `policy-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify(policy));
  return file;
}

const runValues = (policy, state, extra = {}) => ({
  provider: 'acp-devin', model: 'swe-2-high', policy, state, ...extra });

// Тесты не зависят от окружения хоста: DF_DECISION_LEDGER_PATH /
// DF_PROJECT_MEMORY_DIR задаются явно только в env-fallback сценарии.
const runPlan = (values, opts = {}) => buildRunPlan(values, { env: {}, ...opts });

test('run: матрица моделей — жёсткая блокировка', () => {
  for (const spec of [
    'openai/gpt-6.1-terra',
    { provider: 'pi', model: 'openai/gpt-6.1-terra' },
    { provider: 'openai', model: 'GPT-6.1-TERRA' },
  ]) {
    assert.equal(modelViolation(spec), 'model_gpt_6_1_terra_disallowed', JSON.stringify(spec));
  }
  // Owner Decision #18: zcode/acp-zcode-start/glm больше не hard-ban.
  for (const spec of [
    'zcode', 'pi/acp-zcode-start/m', 'acp-zcode-start',
    'glm', 'glm-5.3-flash',
    'builtin:zai-start-plan\\glm-5.3-flash',
    { provider: 'acp-zcode-start', model: 'builtin:zai-start-plan\\GLM-5.3-Flash' },
  ]) {
    assert.equal(modelViolation(spec), null, JSON.stringify(spec));
  }
  // Независимый запрет opencode-go на не-DeepSeek модели сохраняется.
  assert.equal(modelViolation('pi/opencode-go/glm-5'), 'opencode_go_non_deepseek_disallowed');
  assert.equal(forbiddenModelViolation({ provider: 'acp-devin', model: 'swe-2-high' }), null);
  assert.equal(modelViolation({ provider: 'openai', model: 'gpt-6.2-sol' }), null);
});

test('run: отказ без явных --provider/--model и при несовпадении с policy.bb', async () => {
  const dir = await tempdir();
  try {
    const policy = await withPolicy(dir, policySpec(join(dir, 'wt')));
    // Политика без bb и без route.worktree отклоняется до guard'а.
    const noBb = policySpec(join(dir, 'wt'));
    delete noBb.bb;
    const fNoBb = await withPolicy(dir, noBb);
    await assert.rejects(() => runPlan(runValues(fNoBb, 's')), /policy_bb_missing/);
    const noTree = policySpec(undefined);
    delete noTree.route.worktree;
    const fNoTree = await withPolicy(dir, noTree);
    await assert.rejects(() => runPlan(runValues(fNoTree, 's',
      { worktree: join(dir, 'wt') })), /worktree_required/);
    await assert.rejects(() => runPlan({ model: 'm', policy, state: 's' }),
      /provider_required/);
    await assert.rejects(() => runPlan({ provider: 'p', policy, state: 's' }),
      /model_required/);
    await assert.rejects(() => runPlan(
      runValues(policy, 's', { model: 'swe-2-low' })), /cli_spec_mismatch_policy_bb/);
    await assert.rejects(() => runPlan(
      runValues(policy, 's', { provider: 'pi' })), /cli_spec_mismatch_policy_bb/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run: запрещённая модель в CLI, критике, арбитре и allowlist отклоняется', async () => {
  const dir = await tempdir();
  try {
    const wt = join(dir, 'wt');
    await mkdir(wt);
    const policy = await withPolicy(dir, policySpec(wt));
    await assert.rejects(() => runPlan(
      runValues(policy, 's', { model: 'gpt-6.1-terra' })), /cli_spec_mismatch_policy_bb|disallowed/);
    const badCritic = policySpec(wt);
    badCritic.profiles.default.review = { provider: 'openai', model: 'gpt-6.1-terra' };
    const f1 = await withPolicy(dir, badCritic);
    await assert.rejects(() => runPlan(runValues(f1, 's')), /disallowed:profiles\.default/);
    // Запрещённый спек в невыбранном профиле — тот же запрет матрицы.
    const otherProfile = policySpec(wt);
    otherProfile.profiles.other = { branch: 'b2',
      review: { provider: 'openai', model: 'gpt-6.1-terra' } };
    const f4 = await withPolicy(dir, otherProfile);
    await assert.rejects(() => runPlan(runValues(f4, 's')),
      /disallowed:profiles\.other/);
    // route.critic — то же поле модели маршрута, тот же запрет.
    const badRoute = { ...policySpec(wt),
      route: { ...policySpec(wt).route,
        critic: { provider: 'openai', model: 'gpt-6.1-terra' } } };
    const f5 = await withPolicy(dir, badRoute);
    await assert.rejects(() => runPlan(runValues(f5, 's')),
      /disallowed:route\.critic/);
    // route.arbiter распознаётся контроллером — тот же запрет матрицы.
    const badRouteArb = { ...policySpec(wt),
      route: { ...policySpec(wt).route,
        arbiter: { provider: 'openai', model: 'gpt-6.1-terra' } } };
    const f6 = await withPolicy(dir, badRouteArb);
    await assert.rejects(() => runPlan(runValues(f6, 's')),
      /disallowed:route\.arbiter/);
    const state = join(dir, 'state');
    await mkdir(state);
    await chmod(state, 0o700);
    const allowedArbiter = { ...policySpec(wt), arbiter: { provider: 'acp-zcode-start',
      model: 'builtin:zai-start-plan\\GLM-5.3-Flash' } };
    const f2 = await withPolicy(dir, allowedArbiter);
    const zcodePlan = await runPlan(runValues(f2, state));
    assert.equal(zcodePlan.policy, f2);
    // Кандидат в routing.allowlist.critic с активным роутингом — тот же запрет.
    const routed = { ...policySpec(wt),
      routing: { mode: 'active', allowlist: {
        critic: [{ provider: 'openai', model: 'gpt-6.2-sol' },
          { provider: 'openai', model: 'gpt-6.1-terra' }] } } };
    const f3 = await withPolicy(dir, routed);
    await assert.rejects(() => runPlan(runValues(f3, 's')),
      /disallowed:routing\.allowlist\.critic/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run: --worktree обязан совпадать с policy.route.worktree', async () => {
  const dir = await tempdir();
  try {
    const wt = join(dir, 'wt');
    const other = join(dir, 'other');
    const state = join(dir, 'state');
    await mkdir(wt);
    await mkdir(other);
    await mkdir(state);
    // Каталог --state — приватный (та же проверка контроллера).
    await chmod(state, 0o700);
    const policy = await withPolicy(dir, policySpec(wt));
    const plan = await runPlan(runValues(policy, state, { worktree: wt }));
    assert.equal(plan.worktree, wt);
    await assert.rejects(() => runPlan(runValues(policy, 's', { worktree: other })),
      /worktree_mismatch/);
    // route.worktree и --worktree через симлинк на то же дерево —
    // неканонические операторские пути, отказ (равенство realpath
    // недостаточно).
    const wtLink = join(dir, 'wt-link');
    await symlink(wt, wtLink);
    const linkPolicy = await withPolicy(dir, policySpec(wtLink));
    await assert.rejects(() => runPlan(runValues(linkPolicy, state)),
      /non_canonical_or_symlink_path/);
    await assert.rejects(() => runPlan(runValues(policy, state,
      { worktree: wtLink })), /non_canonical_or_symlink_path/);
    // mounts[].from проверок и visual-гейта выбранного профиля —
    // операторский путь зависимости: неканонический (через симлинк)
    // отклоняется при построении плана, до записи Git-конфига — как его
    // отклонил бы sandboxExtras рантайма при обязательной локальной
    // проверке. Канонический каталог с разрешённой парой (from, to)
    // проходит.
    const deps = join(dir, 'site-packages');
    await mkdir(deps);
    const depsLink = join(dir, 'deps-link');
    await symlink(deps, depsLink);
    const mountRecipe = { image: 'sha256:' + 'a'.repeat(64),
      argv: ['pytest'], cwd: '.', timeoutMs: 60_000,
      mounts: [{ from: depsLink, to: '/deps' }] };
    const withChecks = checks => ({ ...policySpec(wt),
      profiles: { default: { branch: 'b',
        review: { provider: 'google', model: 'gemini-4-neon' },
        checks } } });
    const mountPolicy = await withPolicy(dir, withChecks([mountRecipe]));
    await assert.rejects(() => runPlan(runValues(mountPolicy, state)),
      /non_canonical_or_symlink_path/);
    // Та же каноничность действует и на visual.mounts — offlineVisualRunner
    // передаёт рецепт в тот же sandboxExtras.
    const visualPolicy = await withPolicy(dir, { ...policySpec(wt),
      profiles: { default: { branch: 'b',
        review: { provider: 'google', model: 'gemini-4-neon' },
        checks: [], visual: mountRecipe } } });
    await assert.rejects(() => runPlan(runValues(visualPolicy, state)),
      /non_canonical_or_symlink_path/);
    // Allowlist пар (from, to) sandboxExtras: для '/deps' разрешён
    // только источник с именем 'site-packages' — канонический каталог
    // 'deps' отклоняется до Git-конфига.
    const namedDeps = join(dir, 'deps');
    await mkdir(namedDeps);
    const badPairPolicy = await withPolicy(dir, withChecks([
      { ...mountRecipe, mounts: [{ from: namedDeps, to: '/deps' }] }]));
    await assert.rejects(() => runPlan(runValues(badPairPolicy, state)),
      /mount_outside_allowlist/);
    const okMountPolicy = await withPolicy(dir, withChecks([
      { ...mountRecipe, mounts: [{ from: deps, to: '/deps' }] }]));
    const mountPlan = await runPlan(runValues(okMountPolicy, state));
    assert.equal(mountPlan.worktree, wt);
    // Граница worktree/handoffDir для mounts[].from: источник маунта —
    // операторский путь зависимости, он не может лежать внутри дерева
    // воркера (и не пересекается с handoffDir) — отказ до Git-конфига.
    const innerDeps = join(wt, 'site-packages');
    await mkdir(innerDeps);
    const innerMountPolicy = await withPolicy(dir, withChecks([
      { ...mountRecipe, mounts: [{ from: innerDeps, to: '/deps' }] }]));
    await assert.rejects(() => runPlan(runValues(innerMountPolicy, state)),
      /path_inside_worktree/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run: валидный dry-run печатает план без вызова контроллера', async () => {
  const dir = await tempdir();
  try {
    const wt = join(dir, 'wt');
    await mkdir(wt);
    const state = join(dir, 'state');
    await mkdir(state);
    // Каталог --state — приватный (та же проверка контроллера).
    await chmod(state, 0o700);
    // Каталог стоп-файла демона — приватный (privateDirectory контроллера);
    // сам стоп-файл в daemon-режиме может ещё не существовать.
    const ops = join(dir, 'ops');
    await mkdir(ops);
    await chmod(ops, 0o700);
    const stop = join(ops, 'stop');
    const policy = await withPolicy(dir, policySpec(wt));
    const args = ['--provider', 'acp-devin', '--model', 'swe-2-high',
      '--policy', policy, '--state', state, '--daemon', '--interval-ms', '50',
      '--switch', stop];
    // --daemon без --switch и pilot.killSwitch: контроллер отклонил бы
    // запуск уже после записи Git-конфига («Daemon mode requires
    // --switch or pilot.killSwitch») — отказ при построении плана,
    // и в dry-run конфигурация не подтверждается.
    const gitCalls0 = [];
    const git0 = async a => { gitCalls0.push(a); return wt; };
    await assert.rejects(() => runFactory(
      ['--provider', 'acp-devin', '--model', 'swe-2-high',
        '--policy', policy, '--state', state, '--daemon', '--dry-run'],
      { git: git0, env: {} }), /daemon_switch_required/);
    // Действующий pilot-допуск без pilot.killSwitch: --switch — только
    // стоп-файл демона и обязательный путь не заменяет; контроллер
    // отклонил бы pilot_switch_invalid после записи Git-конфига —
    // отказ при построении плана, и в dry-run тоже.
    const noKill = await withPolicy(dir,
      { ...policySpec(wt), scope: 'pilot', pilot: { enabled: true } });
    await assert.rejects(() => runFactory(
      ['--provider', 'acp-devin', '--model', 'swe-2-high',
        '--policy', noKill, '--state', state, '--daemon', '--switch', stop,
        '--dry-run'],
      { git: git0, env: {} }), /pilot_switch_invalid/);
    // git-вызов dry-run — только read-only rev-parse; мокаем.
    const gitCalls = [];
    const git = async a => { gitCalls.push(a); return a.includes('--show-toplevel') ? wt : 'true'; };
    const dry = await runFactory([...args, '--dry-run'], { git, env: {} });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.plan.argv.slice(1),
      ['--execute', '--policy', policy, '--state', state, '--daemon',
        '--switch', stop, '--interval-ms', '50']);
    assert.deepEqual(gitCalls, [['-C', wt, 'rev-parse', '--show-toplevel']]);
    // Не-git worktree в dry-run — отказ.
    const notGit = async () => 'false';
    await assert.rejects(() => runFactory([...args, '--dry-run'], { git: notGit, env: {} }),
      /worktree_not_git/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function initGitRepo(dir) {
  // Без GIT_*-перенаправлений окружения (наследуются, например, из
  // Git-хука): init/config и проверочные вызовы действуют строго на
  // временный репозиторий -C dir, а не на внешний GIT_DIR.
  // Пользовательская и системная Git-конфигурация отключается полностью
  // (commit.gpgSign, fsck-параметры и т.п. из ~/.gitconfig не должны
  // ломать фикстуру); коммит тестам не нужен — проверяются корень
  // worktree и core.fileMode, rev-parse работает и в пустом репозитории.
  const env = { ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull };
  const git = args => execFileAsync('git', ['-C', dir, ...args], { env });
  await git(['init']);
  await writeFile(join(dir, 'f.txt'), 'x');
  await git(['add', 'f.txt']);
  // Возвращаемая обёртка — то же очищенное окружение: ни одна
  // Git-команда теста не затрагивает внешний репозиторий при запуске
  // из Git-хука (унаследованные GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/
  // GIT_COMMON_DIR/GIT_CONFIG_*).
  return args => execFileAsync('git', ['-C', dir, ...args], { env });
}

let gitAvailable;
async function probeGit() {
  if (gitAvailable === undefined) {
    gitAvailable = await execFileAsync('git', ['--version']).then(() => true, () => false);
  }
  return gitAvailable;
}

test('run: NTFS core.fileMode=false guard и mocked runner', async t => {
  if (!(await probeGit())) return t.skip('git binary unavailable');
  const dir = await tempdir();
  try {
    const wt = join(dir, 'wt');
    await mkdir(wt);
    const git = await initGitRepo(wt);
    const state = join(dir, 'state');
    await mkdir(state);
    // Каталог --state — приватный (та же проверка контроллера).
    await chmod(state, 0o700);
    const policy = await withPolicy(dir, policySpec(wt));
    const args = ['--provider', 'acp-devin', '--model', 'swe-2-high',
      '--policy', policy, '--state', state];
    const calls = [];
    // Окружение с GIT_*-перенаправлением конфига: контроллеру оно не
    // наследуется — его git-команды работали бы с чужим effective-значением.
    const result = await runFactory(args, { env: {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fileMode',
      GIT_CONFIG_VALUE_0: 'true' }, run: async (cmd, argv, env) => {
      calls.push({ argv, env }); return { code: 0 };
    } });
    assert.equal(result.dryRun, false);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].argv[0].endsWith('run-isolated.mjs'));
    assert.ok(!Object.keys(calls[0].env).some(k => k.startsWith('GIT_')));
    assert.equal((await git(['config', '--local', 'core.fileMode'])).stdout.trim(), 'false');
    // Подкаталог внутри git-репозитория — не точный корень worktree:
    // отказ до записи core.fileMode и запуска контроллера.
    const sub = join(wt, 'sub');
    await mkdir(sub);
    const subPolicy = await withPolicy(dir, policySpec(sub));
    await assert.rejects(() => runFactory(['--provider', 'acp-devin', '--model', 'swe-2-high',
      '--policy', subPolicy, '--state', state], { env: {}, run: async () => ({ code: 0 }) }),
      /worktree_not_git/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run: NTFS guard не наследует GIT_DIR/GIT_WORK_TREE окружения', async t => {
  if (!(await probeGit())) return t.skip('git binary unavailable');
  const dir = await tempdir();
  const savedGitDir = process.env.GIT_DIR;
  const savedGitTree = process.env.GIT_WORK_TREE;
  try {
    const wt = join(dir, 'wt');
    const other = join(dir, 'other');
    await mkdir(wt);
    await mkdir(other);
    const gitA = await initGitRepo(wt);
    const gitB = await initGitRepo(other);
    // Исходное значение в другом репозитории фиксируется явно: на ФС без
    // надёжного executable-бита init мог бы выставить core.fileMode=false.
    await gitB(['config', '--local', 'core.fileMode', 'true']);
    // Унаследованное перенаправление: --show-toplevel читался бы из
    // GIT_WORK_TREE (= wt, проверка проходит), а config --local писал бы
    // в конфиг GIT_DIR (= other). Guard снимает GIT_*: rev-parse и запись
    // действуют строго на репозиторий -C worktree.
    process.env.GIT_DIR = join(other, '.git');
    process.env.GIT_WORK_TREE = wt;
    await ensureFilemodeGuard(wt);
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    assert.equal((await gitA(['config', '--local', '--get', 'core.fileMode']))
      .stdout.trim(), 'false');
    // Конфиг другого репозитория не тронут: перезапись через
    // перенаправленный GIT_DIR не произошла, исходное значение сохранено.
    assert.equal((await gitB(['config', '--local', '--get', 'core.fileMode']))
      .stdout.trim(), 'true');
  } finally {
    if (savedGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = savedGitDir;
    if (savedGitTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = savedGitTree;
    await rm(dir, { recursive: true, force: true });
  }
});

test('run: memory/ledger вне worktree, симлинк и mismatch отклоняются', async () => {
  const dir = await tempdir();
  try {
    const wt = join(dir, 'wt');
    await mkdir(wt);
    // Хранилища кладём в отдельный каталог: <tmp>/ledger.jsonl при
    // <tmp>/wt — обратная вложенность (dirname содержит worktree), которую
    // контроллер отклоняет так же, как и путь внутри дерева.
    const ops = join(dir, 'ops');
    await mkdir(ops);
    // Каталог стоп-файлов — приватный (privateDirectory контроллера).
    await chmod(ops, 0o700);
    const ledger = join(ops, 'ledger.jsonl');
    await writeFile(ledger, '');
    const memory = join(ops, 'memory');
    await mkdir(memory);
    const insideLedger = join(wt, 'ledger.jsonl');
    await writeFile(insideLedger, '');
    const link = join(ops, 'link');
    await symlink(ledger, link);
    const state = join(dir, 'st');
    await mkdir(state);
    // Каталог --state — приватный (та же проверка контроллера).
    await chmod(state, 0o700);

    // Путь политики внутрь worktree — отказ даже при внешнем CLI-флаге.
    const badPolicy = { ...policySpec(wt), decisionLedger: insideLedger };
    const f1 = await withPolicy(dir, badPolicy);
    await assert.rejects(() => runPlan(runValues(f1, state)),
      /path_inside_worktree/);
    // CLI-флаг против закреплённого в политике пути — mismatch, не молчаливый override.
    await assert.rejects(() => runPlan(runValues(f1, state, { 'ledger-path': ledger })),
      /decision_ledger_mismatch|path_inside_worktree/);
    // Симлинк — отказ (не канонический путь).
    const ok = await withPolicy(dir, policySpec(wt));
    await assert.rejects(() => runPlan(runValues(ok, state, { 'ledger-path': link })),
      /non_canonical_or_symlink_path/);
    // storeDir projectMemory внутри worktree — отказ.
    const badMem = { ...policySpec(wt), projectMemory: { storeDir: join(wt, 'mem') } };
    const f2 = await withPolicy(dir, badMem);
    await assert.rejects(() => runPlan(runValues(f2, state)), /path_missing|inside/);
    // Обратная вложенность: родительский каталог файла ledger содержит
    // worktree (<tmp>/ledger.jsonl при <tmp>/wt) — отказ, как и каталог
    // projectMemory, содержащий дерево (<tmp>/memory нельзя — внутри wt;
    // проверяем сам <tmp>).
    const siblingLedger = join(dir, 'ledger.jsonl');
    await writeFile(siblingLedger, '');
    const sibPolicy = { ...policySpec(wt), decisionLedger: siblingLedger };
    const fSib = await withPolicy(dir, sibPolicy);
    await assert.rejects(() => runPlan(runValues(fSib, state)),
      /path_inside_worktree/);
    // Соседний <tmp>/memory рядом с <tmp>/wt: dirname хранилища содержит
    // worktree — контроллер отклонил бы на assertStoreOutside.
    const siblingMemory = join(dir, 'memory');
    await mkdir(siblingMemory);
    const memParent = { ...policySpec(wt), projectMemory: { storeDir: siblingMemory } };
    const fMem = await withPolicy(dir, memParent);
    await assert.rejects(() => runPlan(runValues(fMem, state)),
      /path_inside_worktree/);
    // '..' и симлинк-компоненты в пути — не канонический путь, отказ до
    // записи Git-конфига и запуска.
    const operator = join(dir, 'operator');
    await mkdir(operator);
    await writeFile(join(operator, 'ledger.jsonl'), '');
    await mkdir(join(wt, 'deep'));
    await symlink(join(wt, 'deep'), join(operator, 'link'));
    await writeFile(join(wt, 'ledger.jsonl'), '');
    const dotdot = { ...policySpec(wt),
      decisionLedger: `${operator}/link/../ledger.jsonl` };
    const fDot = await withPolicy(dir, dotdot);
    await assert.rejects(() => runPlan(runValues(fDot, state)),
      /non_canonical_or_symlink_path/);
    // Тот же '..' со снова-внешней конечной целью — тоже не канонический.
    await writeFile(join(operator, 'ledger2.jsonl'), '');
    await symlink(join(operator, 'ledger2.jsonl'), join(wt, 'ledger2.jsonl'));
    const dotdot2 = { ...policySpec(wt),
      decisionLedger: `${operator}/link/../ledger2.jsonl` };
    const fDot2 = await withPolicy(dir, dotdot2);
    await assert.rejects(() => runPlan(runValues(fDot2, state)),
      /non_canonical_or_symlink_path/);
    // Alias общего корня (root-alias -> <root>, wt в <root>/worktrees/wt):
    // путь через симлинк-алиас не канонический — отказ; каноническая форма
    // того же файла проходит (ни путь, ни родитель не пересекаются с деревом).
    const root2 = join(dir, 'root');
    await mkdir(join(root2, 'worktrees'), { recursive: true });
    const wt2 = join(root2, 'worktrees', 'wt');
    await mkdir(wt2);
    await mkdir(join(root2, 'ops'));
    const rootAlias = join(dir, 'root-alias');
    await symlink(root2, rootAlias);
    const aliasLedger = join(rootAlias, 'ops', 'ledger.jsonl');
    const canonLedger = join(root2, 'ops', 'ledger.jsonl');
    await writeFile(canonLedger, '');
    const aliasOk = { ...policySpec(wt2), decisionLedger: aliasLedger };
    const fAlias = await withPolicy(dir, aliasOk);
    await assert.rejects(() => runPlan(runValues(fAlias, state)),
      /non_canonical_or_symlink_path/);
    const canonOk = { ...policySpec(wt2), decisionLedger: canonLedger };
    const fCanon = await withPolicy(dir, canonOk);
    const aliasPlan = await runPlan(runValues(fCanon, state));
    assert.equal(aliasPlan.ledger, canonLedger);
    // Полный канон: строковый ledger, объектный memory — проходят; env-fallback тоже.
    const okPolicy = { ...policySpec(wt), decisionLedger: ledger,
      projectMemory: { storeDir: memory } };
    const f3 = await withPolicy(dir, okPolicy);
    const plan = await runPlan(runValues(f3, state));
    assert.equal(plan.ledger, ledger);
    assert.equal(plan.memory, memory);
    assert.equal(plan.env.DF_DECISION_LEDGER_PATH, undefined);
    // CLI-флаг при отсутствии пути в политике → передаётся контроллеру через env.
    const plan2 = await runPlan(runValues(ok, state, { 'ledger-path': ledger }));
    assert.equal(plan2.env.DF_DECISION_LEDGER_PATH, ledger);
    // env-fallback контроллера учитывается при проверке.
    const envLedger = join(wt, 'env-ledger.jsonl');
    await writeFile(envLedger, '');
    await assert.rejects(() => runPlan(runValues(ok, state),
      { env: { DF_DECISION_LEDGER_PATH: envLedger } }), /path_inside_worktree/);
    // Относительный путь — отказ (resolveLedgerPath контроллера требует absolute).
    const relPolicy = { ...policySpec(wt), decisionLedger: 'rel-ledger.jsonl' };
    const f4 = await withPolicy(dir, relPolicy);
    await assert.rejects(() => runPlan(runValues(f4, state)), /path_not_absolute/);
    // Симлинк-предок внутри worktree — не канонический путь, отказ.
    const linkDir = join(wt, 'ld');
    await symlink(dir, linkDir);
    await assert.rejects(() => runPlan(runValues(ok, state,
      { 'ledger-path': join(linkDir, 'ledger.jsonl') })),
      /non_canonical_or_symlink_path/);
    // Алиас worktree: путь через симлинк, разрешающийся внутрь дерева, —
    // не канонический, отказ.
    const alias = join(dir, 'alias');
    await symlink(wt, alias);
    const linkInWt = join(wt, 'via');
    await symlink(dir, linkInWt);
    const aliasPolicy = { ...policySpec(alias), decisionLedger: ledger };
    const f5 = await withPolicy(dir, aliasPolicy);
    await assert.rejects(() => runPlan(runValues(f5, state,
      { 'memory-dir': join(alias, 'via', 'memory') })),
      /non_canonical_or_symlink_path/);
    // Цепочка D/alias/wt/out/ledger.jsonl: D/alias -> D/repo,
    // D/repo/wt/out -> D/ops — realpath внешний, но путь не канонический:
    // отказ до Git-конфига и запуска контроллера.
    const repo = join(dir, 'repo');
    await mkdir(join(repo, 'wt'), { recursive: true });
    const extOps = join(dir, 'ext-ops');
    await mkdir(extOps);
    const outLedger = join(extOps, 'ledger.jsonl');
    await writeFile(outLedger, '');
    await symlink(extOps, join(repo, 'wt', 'out'));
    await symlink(repo, join(dir, 'alias2'));
    const chainPolicy = { ...policySpec(wt),
      decisionLedger: join(dir, 'alias2', 'wt', 'out', 'ledger.jsonl') };
    const fChain = await withPolicy(dir, chainPolicy);
    await assert.rejects(() => runPlan(runValues(fChain, state)),
      /non_canonical_or_symlink_path/);
    // Вложенный policy.brief через ту же цепочку симлинков (конечная цель
    // вне worktree) — неканонический операторский вход: отказ до
    // Git-конфига и запуска.
    await writeFile(join(extOps, 'brief.md'), 'x');
    const briefChain = { ...policySpec(wt),
      brief: join(dir, 'alias2', 'wt', 'out', 'brief.md') };
    const fBriefChain = await withPolicy(dir, briefChain);
    await assert.rejects(() => runPlan(runValues(fBriefChain, state)),
      /non_canonical_or_symlink_path/);
    // Явный brief: null — не «отсутствует»: контроллер вызвал бы
    // realpath(null) после записи Git-конфига; отказ ещё в плане.
    const fBriefNull = await withPolicy(dir, { ...policySpec(wt), brief: null });
    await assert.rejects(() => runPlan(runValues(fBriefNull, state)),
      /path_not_absolute/);
    // То же для reviewGate: null отклоняется до проверки routes.json.
    const fGateNull = await withPolicy(dir, { ...policySpec(wt), reviewGate: null });
    await assert.rejects(() => runPlan(runValues(fGateNull, state)),
      /path_not_absolute/);
    // --policy внутри собственного route.worktree — операторский файл в
    // дереве воркера: отказ до Git-конфига и запуска (dry-run тоже).
    await mkdir(join(wt, 'policies'));
    const innerPolicy = join(wt, 'policies', 'policy.json');
    await writeFile(innerPolicy, JSON.stringify(policySpec(wt)));
    await assert.rejects(() => runPlan(runValues(innerPolicy, state)),
      /path_inside_worktree/);
    // --state: относительный путь, симлинк-предок и каталог внутри
    // worktree — отказ до эффекта; канонический каталог вне дерева проходит.
    await assert.rejects(() => runPlan(runValues(ok, 'relative-state')),
      /path_not_absolute/);
    const stateLink = join(dir, 'state-link');
    await symlink(state, stateLink);
    await assert.rejects(() => runPlan(runValues(ok, stateLink)),
      /non_canonical_or_symlink_path/);
    const innerState = join(wt, 'state');
    await mkdir(innerState);
    await chmod(innerState, 0o700);
    await assert.rejects(() => runPlan(runValues(ok, innerState)),
      /path_inside_worktree/);
    // --state обязан быть приватным каталогом владельца (та же проверка,
    // что у контроллера): каталог с правами для группы/остальных —
    // отказ до Git-конфига и в dry-run.
    const pubState = join(dir, 'pub-state');
    await mkdir(pubState);
    await chmod(pubState, 0o755);
    await assert.rejects(() => runPlan(runValues(ok, pubState)),
      /state_not_private/);
    // --policy, указывающий не на файл (каталог): отказ до readFile —
    // path_not_file, а не EISDIR/зависание на FIFO.
    const policyDir = join(dir, 'policy-dir');
    await mkdir(policyDir);
    await assert.rejects(() => runPlan(runValues(policyDir, state)),
      /path_not_file/);
    // routes.json — закрепляемый вход рядом с каноническим reviewGate:
    // симлинк (даже на внешнюю цель) отклоняется до Git-конфига.
    const gateDir = join(ops, 'gate');
    await mkdir(gateDir);
    await writeFile(join(gateDir, 'board-review.mjs'), 'g');
    await writeFile(join(ops, 'routes-real.json'), '{}');
    await symlink(join(ops, 'routes-real.json'), join(gateDir, 'routes.json'));
    const gatePolicy = { ...policySpec(wt), reviewGate: join(gateDir, 'board-review.mjs') };
    const fGate = await withPolicy(dir, gatePolicy);
    await assert.rejects(() => runPlan(runValues(fGate, state)),
      /non_canonical_or_symlink_path/);
    // --switch: относительный путь и симлинк-родитель — отказ в плане;
    // канонический путь (ещё несуществующий стоп-файл) проходит.
    await assert.rejects(() => runPlan(runValues(ok, state, { switch: './stop' })),
      /path_not_absolute/);
    const swLink = join(dir, 'sw-link');
    await symlink(ops, swLink);
    await assert.rejects(() => runPlan(runValues(ok, state,
      { switch: join(swLink, 'stop') })), /non_canonical_or_symlink_path/);
    const swPlan = await runPlan(runValues(ok, state,
      { switch: join(ops, 'stop') }));
    assert.ok(swPlan.argv.includes('--switch'));
    // handoffDir: симлинк — отказ; канонический каталог вне worktree и
    // вне state проходит; каталог внутри worktree — отказ.
    const handoffLink = join(dir, 'handoff-link');
    await symlink(ops, handoffLink);
    const hbLink = { ...policySpec(wt), handoffDir: join(handoffLink, 'inbox') };
    const fHbLink = await withPolicy(dir, hbLink);
    await assert.rejects(() => runPlan(runValues(fHbLink, state)),
      /non_canonical_or_symlink_path|path_missing/);
    const inbox = join(ops, 'inbox');
    await mkdir(inbox);
    const hbOk = { ...policySpec(wt), handoffDir: inbox };
    const fHbOk = await withPolicy(dir, hbOk);
    const hbPlan = await runPlan(runValues(fHbOk, state));
    assert.equal(hbPlan.handoff, inbox);
    // Пути хранилищ не пересекаются с handoffDir в обе стороны:
    // ledger/memory/trustedReceiptDir внутри inbox сдачи или inbox
    // внутри каталога хранилища (родителя файла журнала) — отказ до
    // Git-конфига и запуска контроллера.
    const inboxLedger = join(inbox, 'ledger.jsonl');
    await writeFile(inboxLedger, '');
    const inboxMemory = join(inbox, 'memory');
    await mkdir(inboxMemory);
    const inboxReceipts = join(inbox, 'receipts');
    await mkdir(inboxReceipts);
    for (const badStorage of [
      { decisionLedger: inboxLedger },
      { decisionLedger: { path: inboxLedger } },
      { projectMemory: { storeDir: inboxMemory } },
      { projectMemory: { trustedReceiptDir: inboxReceipts } },
      // Обратное направление: родительский каталог журнала содержит inbox.
      { decisionLedger: ledger },
      // и storeDir памяти содержит inbox.
      { projectMemory: { storeDir: ops } },
    ]) {
      const fBadStorage = await withPolicy(dir,
        { ...policySpec(wt), handoffDir: inbox, ...badStorage });
      await assert.rejects(() => runPlan(runValues(fBadStorage, state)),
        /path_inside_worktree/);
    }
    // Та же граница действует на CLI-флаги --ledger-path/--memory-dir.
    await assert.rejects(() => runPlan(runValues(fHbOk, state,
      { 'ledger-path': inboxLedger })), /path_inside_worktree/);
    await assert.rejects(() => runPlan(runValues(fHbOk, state,
      { 'memory-dir': inboxMemory })), /path_inside_worktree/);
    const hbInner = { ...policySpec(wt), handoffDir: join(wt, 'inbox') };
    const fHbInner = await withPolicy(dir, hbInner);
    await assert.rejects(() => runPlan(runValues(fHbInner, state)),
      /path_inside_worktree|path_missing/);
    // Операторский файл внутри inbox сдачи — рабочий путь воркера у
    // контроллера: отклоняется при построении плана (до Git-конфига),
    // как и в dry-run.
    const briefInInbox = join(inbox, 'brief.md');
    await writeFile(briefInInbox, 'brief');
    const hbBrief = { ...policySpec(wt), handoffDir: inbox, brief: briefInInbox };
    const fHbBrief = await withPolicy(dir, hbBrief);
    await assert.rejects(() => runPlan(runValues(fHbBrief, state)),
      /path_inside_worktree/);
    // Пересечения опциональных каталогов (ownerAnswerSource/releaseSetup
    // контроллера): questionGate.inbox = handoffDir и
    // release.directory = state отклоняются при построении плана.
    const qgSame = { ...policySpec(wt), handoffDir: inbox,
      questionGate: { inbox } };
    const fQgSame = await withPolicy(dir, qgSame);
    await assert.rejects(() => runPlan(runValues(fQgSame, state)),
      /path_inside_worktree/);
    const relSame = { ...policySpec(wt), release: { directory: state } };
    const fRelSame = await withPolicy(dir, relSame);
    await assert.rejects(() => runPlan(runValues(fRelSame, state)),
      /path_inside_worktree/);
    const relDir = join(inbox, 'rel');
    await mkdir(relDir);
    const relInbox = { ...policySpec(wt), handoffDir: inbox,
      release: { directory: relDir } };
    const fRelInbox = await withPolicy(dir, relInbox);
    await assert.rejects(() => runPlan(runValues(fRelInbox, state)),
      /path_inside_worktree/);
    // Путь контроллера не переопределяется флагами.
    await assert.rejects(() => runFactory(['--provider', 'acp-devin', '--model', 'swe-2-high',
      '--policy', ok, '--state', state, '--run-isolated', join(dir, 'evil.mjs')], {}),
      /Unknown option|run-isolated/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run: --switch неканоническая строка и lstat-ошибки отклоняются', async () => {
  const dir = await tempdir();
  try {
    const wt = join(dir, 'wt');
    const ops = join(dir, 'ops');
    const state = join(dir, 'state');
    await mkdir(wt);
    await mkdir(ops);
    await mkdir(state);
    // Каталог --state — приватный (та же проверка контроллера).
    await chmod(state, 0o700);
    // Каталоги стоп-файлов — приватные (privateDirectory контроллера).
    await chmod(ops, 0o700);
    const policy = await withPolicy(dir, policySpec(wt));
    // Завершающий '/' — неканоническая строка: отказ до lstat и запуска.
    await assert.rejects(() => runPlan(runValues(policy, state,
      { switch: `${ops}/` })), /non_canonical_or_symlink_path/);
    // '.', '..' и повторные '//' — та же неканоничность.
    await assert.rejects(() => runPlan(runValues(policy, state,
      { switch: `${ops}/./stop` })), /non_canonical_or_symlink_path/);
    await assert.rejects(() => runPlan(runValues(policy, state,
      { switch: `${ops}/sub/../stop` })), /non_canonical_or_symlink_path/);
    await assert.rejects(() => runPlan(runValues(policy, state,
      { switch: `${ops}//stop` })), /non_canonical_or_symlink_path/);
    // Родительский компонент — обычный файл: lstat даёт ENOTDIR, а не
    // ENOENT — отказ (ещё несозданный стоп-файл в каноническом
    // каталоге по-прежнему проходит).
    const notDir = join(ops, 'file');
    await writeFile(notDir, 'x');
    await assert.rejects(() => runPlan(runValues(policy, state,
      { switch: join(notDir, 'stop') })),
      /non_canonical_or_symlink_path|path_missing|switch_dir_not_private/);
    // Родительский каталог стоп-файла обязан быть приватным
    // (privateDirectory createPilotSwitch): режим 0755 — отказ до
    // Git-конфига, для всех источников стоп-пути.
    const pubDir = join(dir, 'pub');
    await mkdir(pubDir);
    // Режим фикстуры — явный, а не от umask: под umask 077 mkdir дал бы
    // приватный каталог и проверка отказа была бы ложной.
    await chmod(pubDir, 0o755);
    await assert.rejects(() => runPlan(runValues(policy, state,
      { switch: join(pubDir, 'stop') })), /switch_dir_not_private/);
    const abPub = { ...policySpec(wt), abPilot: { switch: join(pubDir, 'ab-stop') } };
    const fAbPub = await withPolicy(dir, abPub);
    await assert.rejects(() => runPlan(runValues(fAbPub, state)),
      /switch_dir_not_private/);
    const ok = await runPlan(runValues(policy, state,
      { switch: join(ops, 'stop') }));
    assert.ok(ok.argv.includes('--switch'));
    // Явный --switch не маскирует pilot.killSwitch: контроллер использует
    // activation.killSwitch для допуска пилота — завершающий '/' в нём
    // отклоняется до Git-конфига и запуска.
    const pilotStop = join(ops, 'pilot-stop');
    const pilotBad = { ...policySpec(wt), scope: 'pilot',
      pilot: { killSwitch: `${pilotStop}/` } };
    const fPilotBad = await withPolicy(dir, pilotBad);
    await assert.rejects(() => runPlan(runValues(fPilotBad, state,
      { switch: join(ops, 'daemon-stop') })), /non_canonical_or_symlink_path/);
    const pilotOk = { ...policySpec(wt), scope: 'pilot',
      pilot: { killSwitch: pilotStop } };
    const fPilotOk = await withPolicy(dir, pilotOk);
    const pilotPlan = await runPlan(runValues(fPilotOk, state,
      { switch: join(ops, 'daemon-stop') }));
    assert.ok(pilotPlan.argv.includes('--switch'));
    // Каталог стоп-файла не пересекает worktree ни в одну сторону
    // (permitDirectory контроллера): --daemon --switch <dir>/stop при
    // route.worktree=<dir>/wt — отказ до Git-конфига и запуска.
    await assert.rejects(() => runPlan(runValues(policy, state,
      { daemon: true, switch: join(dir, 'stop') })), /path_inside_worktree/);
    // Обратное направление: стоп-файл внутри worktree — тоже отказ.
    await assert.rejects(() => runPlan(runValues(policy, state,
      { switch: join(wt, 'stop') })), /path_inside_worktree/);
    // Каталог стоп-файла не пересекается и со state.
    await assert.rejects(() => runPlan(runValues(policy, state,
      { switch: join(state, 'stop') })), /path_inside_worktree/);
    // abPilot.switch — тот же стоп-файл контроллера (createPilotSwitch):
    // путь внутри worktree отклоняется до Git-конфига, как и явный
    // --switch рядом с ним его не маскирует.
    const abInTree = { ...policySpec(wt),
      abPilot: { switch: join(wt, 'ab-stop') } };
    const fAbInTree = await withPolicy(dir, abInTree);
    await assert.rejects(() => runPlan(runValues(fAbInTree, state)),
      /path_inside_worktree/);
    // abPilot.switch — действующий стоп-файл контроллера (assertOpen в
    // enrollAbPilot безусловен): отсутствующий файл (ENOENT) отклоняется
    // до Git-конфига, как и файл с содержимым не 'run\n'.
    const abMissing = { ...policySpec(wt),
      abPilot: { switch: join(ops, 'ab-missing') } };
    const fAbMissing = await withPolicy(dir, abMissing);
    await assert.rejects(() => runPlan(runValues(fAbMissing, state)),
      /pilot_stopped|pilot_switch_invalid/);
    const abStop = join(ops, 'ab-stop');
    await writeFile(abStop, 'halt\n', { mode: 0o600 });
    const abHalt = { ...policySpec(wt), abPilot: { switch: abStop } };
    const fAbHalt = await withPolicy(dir, abHalt);
    await assert.rejects(() => runPlan(runValues(fAbHalt, state)),
      /pilot_stopped/);
    // Канонический путь вне worktree/state/handoff с валидным открытым
    // стоп-файлом ('run\n', 0600, nlink === 1) проходит.
    await writeFile(abStop, 'run\n', { mode: 0o600 });
    const abOk = { ...policySpec(wt), abPilot: { switch: abStop } };
    const fAbOk = await withPolicy(dir, abOk);
    await runPlan(runValues(fAbOk, state));
    // abPilot без switch: контроллер безусловно передаёт config.switch в
    // createPilotSwitch — обязательное поле отклоняется до Git-конфига.
    const abNoSwitch = { ...policySpec(wt), abPilot: { arm: 'linear' } };
    const fAbNoSwitch = await withPolicy(dir, abNoSwitch);
    await assert.rejects(() => runPlan(runValues(fAbNoSwitch, state)),
      /path_not_absolute/);
    // Существующий каталог вместо стоп-файла: контроллер отклоняет
    // не-файл (isFile() === false) — отказ до Git-конфига для всех
    // источников стоп-пути.
    // abPilot.observerWorkspace — только пустой каталог у контроллера:
    // оставшийся файл отклоняется при построении плана, до Git-конфига.
    const abWs = join(ops, 'observer');
    await mkdir(abWs);
    await writeFile(join(abWs, 'leftover'), 'x');
    const abWsFull = { ...policySpec(wt),
      abPilot: { switch: join(ops, 'ab-stop'), observerWorkspace: abWs } };
    const fAbWsFull = await withPolicy(dir, abWsFull);
    await assert.rejects(() => runPlan(runValues(fAbWsFull, state)),
      /path_not_empty/);
    const swDir = join(ops, 'swdir');
    await mkdir(swDir);
    const abDirStop = { ...policySpec(wt), abPilot: { switch: swDir } };
    const fAbDirStop = await withPolicy(dir, abDirStop);
    await assert.rejects(() => runPlan(runValues(fAbDirStop, state)),
      /path_not_file/);
    await assert.rejects(() => runPlan(runValues(policy, state,
      { switch: swDir })), /path_not_file/);
    // Явный pilot.killSwitch: null и нестроковое значение — не
    // «отсутствует»: отказ до Git-конфига, а не молчаливый пропуск.
    const pilotNull = { ...policySpec(wt), pilot: { killSwitch: null } };
    const fPilotNull = await withPolicy(dir, pilotNull);
    await assert.rejects(() => runPlan(runValues(fPilotNull, state)),
      /path_not_absolute/);
    const pilotNum = { ...policySpec(wt), pilot: { killSwitch: 42 } };
    const fPilotNum = await withPolicy(dir, pilotNum);
    await assert.rejects(() => runPlan(runValues(fPilotNum, state)),
      /path_not_absolute/);
    // Явный handoffDir: null — тот же отказ до Git-конфига.
    const hbNull = { ...policySpec(wt), handoffDir: null };
    const fHbNull = await withPolicy(dir, hbNull);
    await assert.rejects(() => runPlan(runValues(fHbNull, state)),
      /path_not_absolute/);
    // handoffDir — обязательный операторский путь (realpath контроллера
    // безусловен): отсутствие — отказ при построении плана.
    const hbMissing = { ...policySpec(wt), handoffDir: undefined };
    const fHbMissing = await withPolicy(dir, hbMissing);
    await assert.rejects(() => runPlan(runValues(fHbMissing, state)),
      /handoff_required/);
    // brief/reviewPrompt/reviewGate — тоже обязательные входы
    // контроллера: без них план не строится.
    for (const key of ['brief', 'reviewPrompt', 'reviewGate']) {
      const missing = { ...policySpec(wt), [key]: undefined };
      const fMissing = await withPolicy(dir, missing);
      await assert.rejects(() => runPlan(runValues(fMissing, state)),
        /operator_files_required/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enqueue: явный --vb symlink разрешается до realpath', async () => {
  const dir = await tempdir();
  try {
    const realVb = join(dir, 'vb-real');
    await writeFile(realVb, '#!/bin/sh\n');
    const linkVb = join(dir, 'vb-link');
    await symlink(realVb, linkVb);
    // Штатная установка vb использует symlink в ~/.local/bin: explicit
    // executable разрешается до канонической цели до boundary-проверок.
    const linked = await buildEnqueuePlan({ ...baseValues(), vb: linkVb });
    assert.equal(linked.tool, realVb);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enqueue: явный --vb через симлинк отклоняется, default vb — нет', async () => {
  const dir = await tempdir();
  try {
    const realVb = join(dir, 'vb-real');
    await writeFile(realVb, '#!/bin/sh\n');
    // Без --vb — команда по умолчанию 'vb', проверка пути не применяется.
    const plan = await buildEnqueuePlan({ ...baseValues() });
    assert.equal(plan.tool, 'vb');
    // Symlink внутри worktree наружу и symlink снаружи внутрь worktree
    // отклоняются по обоим концам разрешения.
    const wt = join(dir, 'wt');
    await mkdir(wt);
    const inward = join(wt, 'vb-link');
    await symlink(realVb, inward);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), vb: inward, worktree: wt }),
      /path_inside_worktree/);
    const innerReal = join(wt, 'vb-real');
    await writeFile(innerReal, '#!/bin/sh\n');
    const outward = join(dir, 'vb-outward');
    await symlink(innerReal, outward);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), vb: outward, worktree: wt }),
      /path_inside_worktree/);
    // Канонический явный --vb вне worktree проходит.
    const ok = await buildEnqueuePlan({ ...baseValues(), vb: realVb });
    assert.equal(ok.tool, realVb);
    // Относительный --vb — отказ.
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), vb: 'vb-real' }),
      /path_not_absolute/);
    // route.worktree из политики обязан быть каталогом, как и явный
    // --worktree: обычный файл — отказ до вызова vb.
    const brief = join(dir, 'brief.md');
    const reviewPrompt = join(dir, 'review.md');
    const gateDir = join(dir, 'gate');
    await mkdir(gateDir);
    await writeFile(brief, 'b');
    await writeFile(reviewPrompt, 'r');
    await writeFile(join(gateDir, 'board-review.mjs'), 'g');
    await writeFile(join(gateDir, 'routes.json'), '{}');
    const wtFile = join(dir, 'wt-file');
    await writeFile(wtFile, 'x');
    const policyFile = join(dir, 'policy.json');
    await writeFile(policyFile, JSON.stringify({
      brief, reviewPrompt, reviewGate: join(gateDir, 'board-review.mjs'),
      route: { checkProfile: 'p', worktree: wtFile },
      profiles: { p: { review: { provider: 'openai', model: 'gpt-6.2-sol',
        reasoningLevel: 'medium' } } },
    }));
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, policy: policyFile }), /path_not_dir/);
    // Явно заданное route.worktree любого вида — операторский путь:
    // "", null и не-строка отклоняются до вызова vb, а не пропускаются
    // (ранее молча игнорировались без --worktree).
    for (const badTree of ['', null, 42]) {
      await writeFile(policyFile, JSON.stringify({
        route: { checkProfile: 'p', worktree: badTree } }));
      await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
        'policy-digest': undefined, policy: policyFile }), /path_not_absolute/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run: policy operator dirs — trustedReceiptDir/questionGate.inbox/release.directory', async () => {
  const dir = await tempdir();
  try {
    const wt = join(dir, 'wt');
    const ops = join(dir, 'ops');
    const state = join(dir, 'state');
    await mkdir(wt);
    await mkdir(ops);
    await mkdir(state);
    // Каталог --state — приватный (та же проверка контроллера).
    await chmod(state, 0o700);
    const receipts = join(ops, 'receipts');
    await mkdir(receipts);
    const inbox = join(ops, 'qg-inbox');
    await mkdir(inbox);
    const releaseDir = join(ops, 'release');
    await mkdir(releaseDir);
    const base = policySpec(wt);
    const okPolicy = { ...base,
      projectMemory: { trustedReceiptDir: receipts },
      questionGate: { inbox }, release: { directory: releaseDir } };
    const fOk = await withPolicy(dir, okPolicy);
    await runPlan(runValues(fOk, state));
    // Соседние каталоги рядом с worktree (общий родитель <dir> содержит
    // wt): parent-граница на них не действует — контроллер допускает
    // такую раскладку для questionGate.inbox и release.directory.
    const sibInbox = join(dir, 'answers');
    const sibRelease = join(dir, 'release-out');
    await mkdir(sibInbox);
    await mkdir(sibRelease);
    const fSib = await withPolicy(dir, { ...base,
      questionGate: { inbox: sibInbox }, release: { directory: sibRelease } });
    await runPlan(runValues(fSib, state));
    // trustedReceiptDir через симлинк-предка — неканонический операторский
    // каталог: отказ до Git-конфига и запуска.
    const linkOps = join(dir, 'ops-link');
    await symlink(ops, linkOps);
    const bad = { ...base,
      projectMemory: { trustedReceiptDir: join(linkOps, 'receipts') } };
    const fBad = await withPolicy(dir, bad);
    await assert.rejects(() => runPlan(runValues(fBad, state)),
      /non_canonical_or_symlink_path/);
    // questionGate.inbox / release.directory внутри worktree — отказ.
    const wtInbox = join(wt, 'inbox');
    await mkdir(wtInbox);
    const fInbox = await withPolicy(dir, { ...base, questionGate: { inbox: wtInbox } });
    await assert.rejects(() => runPlan(runValues(fInbox, state)),
      /path_inside_worktree/);
    const fRel = await withPolicy(dir, { ...base, release: { directory: join(linkOps, 'release') } });
    await assert.rejects(() => runPlan(runValues(fRel, state)),
      /non_canonical_or_symlink_path/);
    // Явный null — заданное значение, не отсутствие: контроллер требует
    // абсолютный путь, поэтому обёртка отклоняет до Git-конфига и dry-run.
    const fNullMem = await withPolicy(dir, { ...base,
      projectMemory: { storeDir: receipts, trustedReceiptDir: null } });
    await assert.rejects(() => runPlan(runValues(fNullMem, state)), /path_not_absolute/);
    const fNullInbox = await withPolicy(dir, { ...base, questionGate: { inbox: null } });
    await assert.rejects(() => runPlan(runValues(fNullInbox, state)), /path_not_absolute/);
    const fNullRel = await withPolicy(dir, { ...base, release: { directory: null } });
    await assert.rejects(() => runPlan(runValues(fNullRel, state)), /path_not_absolute/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run: нестроковое значение приоритетного поля пути отклоняется', async () => {
  const dir = await tempdir();
  try {
    const wt = join(dir, 'wt');
    const ops = join(dir, 'ops');
    const state = join(dir, 'state');
    await mkdir(wt);
    await mkdir(ops);
    await mkdir(state);
    // Каталог --state — приватный (та же проверка контроллера).
    await chmod(state, 0o700);
    // Контроллер берёт первое non-nullish значение ?? -цепочки:
    // {storeDir: false, dir: <каноничный>} резолвится в false и
    // отклоняется до записи Git-конфига, а не проскакивает к dir.
    const extMem = join(ops, 'mem');
    await mkdir(extMem);
    const fMem = await withPolicy(dir, { ...policySpec(wt),
      projectMemory: { storeDir: false, dir: extMem } });
    await assert.rejects(() => runPlan(runValues(fMem, state)), /path_not_absolute/);
    const fLedger = await withPolicy(dir, { ...policySpec(wt),
      decisionLedger: { path: false } });
    await assert.rejects(() => runPlan(runValues(fLedger, state)), /path_not_absolute/);
    // Число — тоже нестроковый приоритетный путь: отказ до эффекта.
    const fNum = await withPolicy(dir, { ...policySpec(wt),
      decisionLedger: { path: 42 } });
    await assert.rejects(() => runPlan(runValues(fNum, state)), /path_not_absolute/);
    // Скалярное значение или массив на месте конфигурации пути — не
    // «отсутствует»: контроллер отклонил бы её в
    // ledgerPolicyConfig/memoryPolicyConfig после записи Git-конфига;
    // отказ здесь, при построении плана.
    for (const bad of [
      { decisionLedger: 42 },
      { projectMemory: false },
      { decisionLedger: [join(ops, 'ledger.jsonl')] },
    ]) {
      const fBad = await withPolicy(dir, { ...policySpec(wt), ...bad });
      await assert.rejects(() => runPlan(runValues(fBad, state)), /policy_invalid/);
    }
    // Явный null в поле пути — не «отсутствует»: контроллер подставил бы
    // следующий ключ или env; отказ при построении плана, до Git-конфига.
    for (const bad of [
      { decisionLedger: { path: null } },
      { projectMemory: { storeDir: null } },
      { projectMemory: { storeDir: null, dir: extMem } },
    ]) {
      const fBad = await withPolicy(dir, { ...policySpec(wt), ...bad });
      await assert.rejects(() => runPlan(runValues(fBad, state)), /path_not_absolute/);
    }
    // Явный null на месте всей конфигурации пути — не «отсутствует»:
    // контроллер подставил бы env или значение по умолчанию; отказ при
    // построении плана, до Git-конфига.
    for (const bad of [
      { decisionLedger: null },
      { projectMemory: null },
    ]) {
      const fBad = await withPolicy(dir, { ...policySpec(wt), ...bad });
      await assert.rejects(() => runPlan(runValues(fBad, state)), /path_not_absolute/);
    }
    // Явная пустая строка — тоже заданное значение, а не «не задано»:
    // отклоняется, не превращаясь молча в отсутствие пути.
    const fEmpty = await withPolicy(dir, { ...policySpec(wt),
      decisionLedger: '' });
    await assert.rejects(() => runPlan(runValues(fEmpty, state)), /path_not_absolute/);
    // Явный null в CLI-override — не «отсутствует»: ?? подставил бы
    // policy/env, а в env-переопределение плана попал бы null. Отказ
    // при построении плана.
    const fOk = await withPolicy(dir, policySpec(wt));
    await assert.rejects(() => runPlan(runValues(fOk, state,
      { 'ledger-path': null })), /path_not_absolute/);
    await assert.rejects(() => runPlan(runValues(fOk, state,
      { 'memory-dir': null })), /path_not_absolute/);
    // Явный null или '' в нижестоящем поле пути отклоняется и при
    // валидном поле более высокого приоритета — инвариант валидации
    // действует на всю форму, а не только на резолвленное значение.
    for (const bad of [
      { projectMemory: { storeDir: extMem, dir: null } },
      { projectMemory: { storeDir: extMem, path: '' } },
    ]) {
      const fBad = await withPolicy(dir, { ...policySpec(wt), ...bad });
      await assert.rejects(() => runPlan(runValues(fBad, state)), /path_not_absolute/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run-isolated: заголовок DF #, без Пилот #', async () => {
  const source = await readFile(
    new URL('../board_pipeline/run-transport.mjs', import.meta.url), 'utf8');
  assert.match(source, /'--title', `DF #\$\{attempt\.task_id\}`,/);
  assert.doesNotMatch(source, /route\?\.ticket/);
  assert.doesNotMatch(source, /Пилот #\$\{attempt\.task_id\}/);
});

test('run: --runtime validates fail-closed and forwards to run-isolated', async () => {
  const dir = await tempdir();
  try {
    const wt = join(dir, 'wt');
    const state = join(dir, 'state');
    await mkdir(wt);
    await mkdir(state);
    await chmod(state, 0o700);
    const policy = await withPolicy(dir, policySpec(wt));
    const args = ['--provider', 'acp-devin', '--model', 'swe-2-high',
      '--policy', policy, '--state', state];
    const gitCalls = [];
    const git = async argv => { gitCalls.push(argv); return wt; };
    const dry = await runFactory([...args, '--runtime', 'hc', '--dry-run'], { git, env: {} });
    assert.equal(dry.dryRun, true);
    const runtimeIndex = dry.plan.argv.indexOf('--runtime');
    assert.notEqual(runtimeIndex, -1);
    assert.equal(dry.plan.argv[runtimeIndex + 1], 'hc');
    const direct = await runPlan(runValues(policy, state, { runtime: 'subproc' }));
    assert.equal(direct.argv[direct.argv.indexOf('--runtime') + 1], 'subproc');
    const beforeGit = gitCalls.length;
    for (const bad of ['pty', '', 'HC']) {
      await assert.rejects(() => runFactory([...args, '--runtime', bad, '--dry-run'],
        { git, env: {} }), /worker_runtime_kind_invalid/);
    }
    assert.equal(gitCalls.length, beforeGit);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run: node_modules mount allowlist — multi-repo цели внутри /candidate', async () => {
  const dir = await tempdir();
  try {
    const wt = join(dir, 'wt');
    await mkdir(wt);
    const state = join(dir, 'state');
    await mkdir(state);
    await chmod(state, 0o700);
    // Канонический источник маунта с basename 'node_modules' вне worktree.
    const nodeModules = join(dir, 'node_modules');
    await mkdir(nodeModules);
    const recipe = to => ({ image: 'sha256:' + 'a'.repeat(64),
      argv: ['npm', 'test'], cwd: '.', timeoutMs: 60_000,
      mounts: [{ from: nodeModules, to }] });
    const withMounts = mounts => ({ ...policySpec(wt),
      profiles: { default: { branch: 'b',
        review: { provider: 'google', model: 'gemini-4-neon' },
        checks: mounts.map(recipe) } } });
    // Multi-repo раскладка допускается: корень кандидата, вложенный пакет
    // и прежняя tracker/web цель — все канонические node_modules внутри
    // /candidate.
    for (const to of ['/candidate/node_modules', '/candidate/app/node_modules',
      '/candidate/web/node_modules', '/candidate/tracker/web/node_modules',
      '/candidate/a/b/c/node_modules']) {
      const file = await withPolicy(dir, withMounts([to]));
      const plan = await runPlan(runValues(file, state));
      assert.equal(plan.worktree, wt, to);
    }
    // Цели вне /candidate, неканонические сегменты и не-node_modules
    // финальный сегмент отклоняются до Git-конфига.
    for (const to of ['/outside/node_modules', '/etc/node_modules',
      '/candidate/node_modules/../etc', '/candidate/../candidate/node_modules',
      '/candidate/./node_modules', '/candidate//node_modules',
      '/candidate/node_modules/', '/candidate', '/candidatex/node_modules',
      '/candidate/node_modulesx', '/candidate/node_modules/x']) {
      const file = await withPolicy(dir, withMounts([to]));
      await assert.rejects(() => runPlan(runValues(file, state)),
        /mount_outside_allowlist/, to);
    }
    // Каноническая цель с источником не-node_modules — тот же отказ:
    // инвариант basename(from) сохраняется.
    const deps = join(dir, 'deps');
    await mkdir(deps);
    const badFrom = { ...policySpec(wt),
      profiles: { default: { branch: 'b',
        review: { provider: 'google', model: 'gemini-4-neon' },
        checks: [{ image: 'sha256:' + 'a'.repeat(64), argv: ['npm', 'test'],
          cwd: '.', timeoutMs: 60_000,
          mounts: [{ from: deps, to: '/candidate/node_modules' }] }] } } };
    const badFromFile = await withPolicy(dir, badFrom);
    await assert.rejects(() => runPlan(runValues(badFromFile, state)),
      /mount_outside_allowlist/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run: --event-socket канонический путь вне worktree пробрасывается контроллеру', async () => {
  const dir = await tempdir();
  try {
    const wt = join(dir, 'wt');
    await mkdir(wt);
    const state = join(dir, 'state');
    await mkdir(state);
    await chmod(state, 0o700);
    const ops = join(dir, 'ops');
    await mkdir(ops);
    const policy = await withPolicy(dir, policySpec(wt));
    // Сокет может ещё не существовать: родительский каталог каноничен и
    // вне worktree — план строится, значение передаётся контроллеру.
    const socket = join(ops, 'control-room.sock');
    const plan = await runPlan(runValues(policy, state, { 'event-socket': socket }));
    const index = plan.argv.indexOf('--event-socket');
    assert.notEqual(index, -1);
    assert.equal(plan.argv[index + 1], socket);
    // Относительный и нестроковый путь — отказ до Git-конфига.
    await assert.rejects(() => runPlan(runValues(policy, state,
      { 'event-socket': 'ops/control-room.sock' })), /path_not_absolute/);
    await assert.rejects(() => runPlan(runValues(policy, state,
      { 'event-socket': null })), /path_not_absolute/);
    // Неканоническая строка: '..', повторные '/', завершающий '/'.
    for (const bad of [`${ops}/../ops/control-room.sock`, `${ops}//control-room.sock`,
      `${socket}/`]) {
      await assert.rejects(() => runPlan(runValues(policy, state,
        { 'event-socket': bad })), /non_canonical_or_symlink_path/, bad);
    }
    // Родительский каталог не существует — path_missing до эффектов.
    await assert.rejects(() => runPlan(runValues(policy, state,
      { 'event-socket': join(dir, 'missing', 'x.sock') })), /path_missing/);
    // Родительский каталог через симлинк — не канонический операторский путь.
    const opsLink = join(dir, 'ops-link');
    await symlink(ops, opsLink);
    await assert.rejects(() => runPlan(runValues(policy, state,
      { 'event-socket': join(opsLink, 'control-room.sock') })),
      /non_canonical_or_symlink_path/);
    // Каталог сокета внутри worktree и содержащий worktree — обе стороны
    // границы отклоняются.
    const innerOps = join(wt, 'ops');
    await mkdir(innerOps);
    await assert.rejects(() => runPlan(runValues(policy, state,
      { 'event-socket': join(innerOps, 'control-room.sock') })),
      /path_inside_worktree/);
    await assert.rejects(() => runPlan(runValues(policy, state,
      { 'event-socket': join(dir, 'control-room.sock') })),
      /path_inside_worktree/);
    // Существующий симлинк на месте сокета — отказ.
    const target = join(ops, 'real.sock');
    await writeFile(target, '');
    const sockLink = join(ops, 'link.sock');
    await symlink(target, sockLink);
    await assert.rejects(() => runPlan(runValues(policy, state,
      { 'event-socket': sockLink })), /non_canonical_or_symlink_path/);
    // CLI-проброс через runFactory в dry-run: флаг доезжает до argv
    // контроллера после проверенных путей.
    const git = async argv => wt;
    const args = ['--provider', 'acp-devin', '--model', 'swe-2-high',
      '--policy', policy, '--state', state, '--event-socket', socket, '--dry-run'];
    const dry = await runFactory(args, { git, env: {} });
    assert.equal(dry.dryRun, true);
    const dryIndex = dry.plan.argv.indexOf('--event-socket');
    assert.notEqual(dryIndex, -1);
    assert.equal(dry.plan.argv[dryIndex + 1], socket);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enqueue: метка allowed_paths валидируется до вызова vb', async () => {
  // Валидный список: относительные пути через запятую, пробелы по краям
  // записей допустимы, граница 256 символов включительно — проходит.
  const valid = await buildEnqueuePlan({ ...baseValues(),
    label: ['allowed_paths=src,ops/x, board_pipeline/model-registry.mjs'] });
  assert.equal(valid.labels.allowed_paths, 'src,ops/x, board_pipeline/model-registry.mjs');
  const directoryPrefix = await buildEnqueuePlan({ ...baseValues(),
    label: ['allowed_paths=src/,ops/x'] });
  assert.equal(directoryPrefix.labels.allowed_paths, 'src/,ops/x');
  const edge = `a/${'x'.repeat(254)}`;
  assert.equal(edge.length, 256);
  const edgePlan = await buildEnqueuePlan({ ...baseValues(),
    label: [`allowed_paths=${edge}`] });
  assert.equal(edgePlan.labels.allowed_paths, edge);
  // Отказы: traversal, абсолютный путь, home, пустой сегмент, пустое
  // значение, обратный слэш, внутренние управляющие символы — до вызова vb.
  for (const bad of ['../x', 'a/../b', 'src/../../etc', '/etc/passwd', '~/secret',
    'src,,ops', 'src,', ',src', '', 'a\\b', 'a\nb', 'x\0y', 'a\tb',
    'a//b', './src', '.', 'C:/windows']) {
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      label: [`allowed_paths=${bad}`] }), /allowed_paths_invalid/, JSON.stringify(bad));
  }
  // Длиннее 256 символов — отдельный код отказа, даже для валидных путей.
  const tooLong = `a/${'x'.repeat(255)}`;
  assert.equal(tooLong.length, 257);
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
    label: [`allowed_paths=${tooLong}`] }), /allowed_paths_too_long/);
  // Другие метки валидируются независимо: произвольная метка без
  // allowed_paths проходит без изменений.
  const other = await buildEnqueuePlan({ ...baseValues(), label: ['domain=billing'] });
  assert.equal(other.labels.domain, 'billing');
});

test('enqueue: --text без --brief и --spec-digest закрепляет sha256 текста автоматически', async () => {
  // Оператор не обязан вручную хэшировать текст: без явного --spec-digest
  // и без --brief дайджест вычисляется из фактического текста карточки,
  // иначе run-isolated молча опустил бы спеку из промпта воркера.
  const text = 'multi-line spec\nsecond line\n';
  const plan = await buildEnqueuePlan({ ...baseValues(), title: undefined,
    text, 'spec-digest': undefined });
  assert.equal(plan.labels.spec_digest, sha256Text(text));
  assert.equal(plan.argv[5], text);
  // Пустой/пробельный текст — по-прежнему отказ title_or_text_required.
  await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), title: undefined,
    text: '   ', 'spec-digest': undefined }), /title_or_text_required/);
  // computeSpecDigest — тот же sha256 utf8, что сверяет контроллер.
  assert.equal(computeSpecDigest(text), sha256Text(text));
  assert.equal(computeSpecDigest(''), sha256Text(''));
  assert.throws(() => computeSpecDigest(undefined), /spec_digest_invalid/);
});

test('enqueue: --text первичен над --brief для spec_digest без явного дайджеста', async () => {
  const dir = await tempdir();
  try {
    const brief = join(dir, 'brief.md');
    await writeFile(brief, 'brief body\n');
    // Регрессия #WAVE2-1: текст карточки — это --text, поэтому и дайджест
    // обязан закреплять --text; хэш brief молча отрывал спеку от воркера.
    const plan = await buildEnqueuePlan({ ...baseValues(), title: undefined,
      text: 'explicit text', 'spec-digest': undefined, brief });
    assert.equal(plan.argv[5], 'explicit text');
    assert.equal(plan.labels.spec_digest, sha256Text('explicit text'));
    // Явный --spec-digest — осознанное закрепление оператора: валидный
    // дайджест принимается как раньше, невалидный отклоняется до вызова vb.
    const pinned = await buildEnqueuePlan({ ...baseValues(), title: undefined,
      text: 'explicit text', 'spec-digest': HEX, brief: undefined });
    assert.equal(pinned.labels.spec_digest, HEX);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), title: undefined,
      text: 'explicit text', 'spec-digest': 'zz', brief: undefined }), /spec_digest_invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
