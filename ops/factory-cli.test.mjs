// Тесты тонких CLI: ops/factory-enqueue.mjs и ops/factory-run.mjs.
// Без внешних зависимостей и host-путей: все эффекты через внедряемые
// runner'ы, временные каталоги удаляются в finally.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnqueuePlan, runEnqueue } from './factory-enqueue.mjs';
import { buildRunPlan, forbiddenModelViolation, modelViolation, runFactory }
  from './factory-run.mjs';

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

const policySpec = worktree => ({
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
    'zcode', 'pi/acp-zcode-start/m', 'acp-zcode-start',
    'glm', 'glm-5.3-flash', 'pi/opencode-go/glm-5',
    'builtin:zai-start-plan\\glm-5.3-flash',
    { provider: 'openai', model: 'GPT-6.1-TERRA' },
  ]) {
    assert.ok(modelViolation(spec), JSON.stringify(spec));
  }
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
    const badArbiter = { ...policySpec(wt), arbiter: { provider: 'pi', model: 'acp-zcode-start/x' } };
    const f2 = await withPolicy(dir, badArbiter);
    await assert.rejects(() => runPlan(runValues(f2, 's')), /zcode.*:arbiter/);
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
    const policy = await withPolicy(dir, policySpec(wt));
    const args = ['--provider', 'acp-devin', '--model', 'swe-2-high',
      '--policy', policy, '--state', state, '--daemon', '--interval-ms', '50'];
    // git-вызов dry-run — только read-only rev-parse; мокаем.
    const gitCalls = [];
    const git = async a => { gitCalls.push(a); return a.includes('--show-toplevel') ? wt : 'true'; };
    const dry = await runFactory([...args, '--dry-run'], { git, env: {} });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.plan.argv.slice(1),
      ['--execute', '--policy', policy, '--state', state, '--daemon', '--interval-ms', '50']);
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
  const git = args => execFileAsync('git', ['-C', dir, ...args]);
  await git(['init']);
  await git(['config', 'user.email', 't@t']);
  await git(['config', 'user.name', 't']);
  await writeFile(join(dir, 'f.txt'), 'x');
  await git(['add', 'f.txt']);
  await git(['commit', '-m', 'init']);
  return args => execFileAsync('git', ['-C', dir, ...args]);
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
    const policy = await withPolicy(dir, policySpec(wt));
    const args = ['--provider', 'acp-devin', '--model', 'swe-2-high',
      '--policy', policy, '--state', state];
    const calls = [];
    const result = await runFactory(args, { env: {}, run: async (cmd, argv, env) => {
      calls.push({ argv, env }); return { code: 0 };
    } });
    assert.equal(result.dryRun, false);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].argv[0].endsWith('run-isolated.mjs'));
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
    await assert.rejects(() => runPlan(runValues(ok, innerState)),
      /path_inside_worktree/);
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
    const hbInner = { ...policySpec(wt), handoffDir: join(wt, 'inbox') };
    const fHbInner = await withPolicy(dir, hbInner);
    await assert.rejects(() => runPlan(runValues(fHbInner, state)),
      /path_inside_worktree|path_missing/);
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
      /non_canonical_or_symlink_path|path_missing/);
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enqueue: явный --vb через симлинк отклоняется, default vb — нет', async () => {
  const dir = await tempdir();
  try {
    const realVb = join(dir, 'vb-real');
    await writeFile(realVb, '#!/bin/sh\n');
    const linkVb = join(dir, 'vb-link');
    await symlink(realVb, linkVb);
    // Без --vb — команда по умолчанию 'vb', проверка пути не применяется.
    const plan = await buildEnqueuePlan({ ...baseValues() });
    assert.equal(plan.tool, 'vb');
    // Явный --vb через симлинк — неканонический путь: отказ до вызова vb.
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), vb: linkVb }),
      /non_canonical_or_symlink_path/);
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run-isolated: заголовок DF #, без Пилот #', async () => {
  const source = await readFile(
    join(new URL('.', import.meta.url).pathname, '..', 'board_pipeline', 'run-isolated.mjs'),
    'utf8');
  assert.match(source, /'--title', `DF #\$\{attempt\.task_id\}`,/);
  assert.doesNotMatch(source, /route\?\.ticket/);
  assert.doesNotMatch(source, /Пилот #\$\{attempt\.task_id\}/);
});
