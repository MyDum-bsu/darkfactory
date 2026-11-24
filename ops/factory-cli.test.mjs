// Тесты тонких CLI: ops/factory-enqueue.mjs и ops/factory-run.mjs.
// Без внешних зависимостей и host-путей: все эффекты через внедряемые
// runner'ы, временные каталоги удаляются в finally.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

async function tempdir() {
  return mkdtemp(join(tmpdir(), 'factory-cli-'));
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
    // Симлинк внутри worktree на внешний каталог: буквальный путь отклоняется
    // до чтения файла и создания карточки.
    const linkDir = join(worktree, 'link');
    await symlink(dir, linkDir);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'spec-digest': undefined,
      brief: join(linkDir, 'brief.md'), worktree }), /path_inside_worktree/);
    // Симлинк на конечном пути — отказ.
    const link = join(dir, 'link.md');
    await symlink(brief, link);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'spec-digest': undefined,
      brief: link, worktree }), /path_symlink_refused/);
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
    // (alias -> wt/link -> наружу): конечный realpath внешний, но вход
    // проходит через дерево воркера — отказ по промежуточному хопу.
    const outLink = join(wt, 'link');
    await symlink(dir, outLink);
    const extAlias = join(dir, 'ext-alias');
    await symlink(outLink, extAlias);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(),
      'policy-digest': undefined, 'spec-digest': undefined,
      brief: join(extAlias, 'brief.md'), policy: policyFile }),
      /path_inside_worktree/);
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

test('run: матрица моделей — жёсткая блокировка', () => {
  for (const spec of [
    'openai/gpt-6.1-terra',
    { provider: 'pi', model: 'openai/gpt-6.1-terra' },
    'zcode', 'pi/acp-zcode-start/m', 'acp-zcode-start',
    'glm', 'glm-5.3-flash', 'pi/opencode-go/glm-5',
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
    await assert.rejects(() => buildRunPlan(runValues(fNoBb, 's')), /policy_bb_missing/);
    const noTree = policySpec(undefined);
    delete noTree.route.worktree;
    const fNoTree = await withPolicy(dir, noTree);
    await assert.rejects(() => buildRunPlan(runValues(fNoTree, 's',
      { worktree: join(dir, 'wt') })), /worktree_required/);
    await assert.rejects(() => buildRunPlan({ model: 'm', policy, state: 's' }),
      /provider_required/);
    await assert.rejects(() => buildRunPlan({ provider: 'p', policy, state: 's' }),
      /model_required/);
    await assert.rejects(() => buildRunPlan(
      runValues(policy, 's', { model: 'swe-2-low' })), /cli_spec_mismatch_policy_bb/);
    await assert.rejects(() => buildRunPlan(
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
    await assert.rejects(() => buildRunPlan(
      runValues(policy, 's', { model: 'gpt-6.1-terra' })), /cli_spec_mismatch_policy_bb|disallowed/);
    const badCritic = policySpec(wt);
    badCritic.profiles.default.review = { provider: 'openai', model: 'gpt-6.1-terra' };
    const f1 = await withPolicy(dir, badCritic);
    await assert.rejects(() => buildRunPlan(runValues(f1, 's')), /disallowed:profiles\.default/);
    // Запрещённый спек в невыбранном профиле — тот же запрет матрицы.
    const otherProfile = policySpec(wt);
    otherProfile.profiles.other = { branch: 'b2',
      review: { provider: 'openai', model: 'gpt-6.1-terra' } };
    const f4 = await withPolicy(dir, otherProfile);
    await assert.rejects(() => buildRunPlan(runValues(f4, 's')),
      /disallowed:profiles\.other/);
    const badArbiter = { ...policySpec(wt), arbiter: { provider: 'pi', model: 'acp-zcode-start/x' } };
    const f2 = await withPolicy(dir, badArbiter);
    await assert.rejects(() => buildRunPlan(runValues(f2, 's')), /zcode.*:arbiter/);
    // Кандидат в routing.allowlist.critic с активным роутингом — тот же запрет.
    const routed = { ...policySpec(wt),
      routing: { mode: 'active', allowlist: {
        critic: [{ provider: 'openai', model: 'gpt-6.2-sol' },
          { provider: 'openai', model: 'gpt-6.1-terra' }] } } };
    const f3 = await withPolicy(dir, routed);
    await assert.rejects(() => buildRunPlan(runValues(f3, 's')),
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
    await mkdir(wt);
    await mkdir(other);
    const policy = await withPolicy(dir, policySpec(wt));
    const plan = await buildRunPlan(runValues(policy, 's', { worktree: wt }));
    assert.equal(plan.worktree, wt);
    await assert.rejects(() => buildRunPlan(runValues(policy, 's', { worktree: other })),
      /worktree_mismatch/);
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
    const dry = await runFactory([...args, '--dry-run'], { git });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.plan.argv.slice(1),
      ['--execute', '--policy', policy, '--state', state, '--daemon', '--interval-ms', '50']);
    assert.deepEqual(gitCalls, [['-C', wt, 'rev-parse', '--show-toplevel']]);
    // Не-git worktree в dry-run — отказ.
    const notGit = async () => 'false';
    await assert.rejects(() => runFactory([...args, '--dry-run'], { git: notGit }),
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
    const result = await runFactory(args, { run: async (cmd, argv, env) => {
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
      '--policy', subPolicy, '--state', state], { run: async () => ({ code: 0 }) }),
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

    // Путь политики внутрь worktree — отказ даже при внешнем CLI-флаге.
    const badPolicy = { ...policySpec(wt), decisionLedger: insideLedger };
    const f1 = await withPolicy(dir, badPolicy);
    await assert.rejects(() => buildRunPlan(runValues(f1, state)),
      /path_inside_worktree/);
    // CLI-флаг против закреплённого в политике пути — mismatch, не молчаливый override.
    await assert.rejects(() => buildRunPlan(runValues(f1, state, { 'ledger-path': ledger })),
      /decision_ledger_mismatch|path_inside_worktree/);
    // Симлинк — отказ.
    const ok = await withPolicy(dir, policySpec(wt));
    await assert.rejects(() => buildRunPlan(runValues(ok, state, { 'ledger-path': link })),
      /path_symlink_refused/);
    // storeDir projectMemory внутри worktree — отказ.
    const badMem = { ...policySpec(wt), projectMemory: { storeDir: join(wt, 'mem') } };
    const f2 = await withPolicy(dir, badMem);
    await assert.rejects(() => buildRunPlan(runValues(f2, state)), /path_missing|inside/);
    // Обратная вложенность: родительский каталог файла ledger содержит
    // worktree (<tmp>/ledger.jsonl при <tmp>/wt) — отказ, как и каталог
    // projectMemory, содержащий дерево (<tmp>/memory нельзя — внутри wt;
    // проверяем сам <tmp>).
    const siblingLedger = join(dir, 'ledger.jsonl');
    await writeFile(siblingLedger, '');
    const sibPolicy = { ...policySpec(wt), decisionLedger: siblingLedger };
    const fSib = await withPolicy(dir, sibPolicy);
    await assert.rejects(() => buildRunPlan(runValues(fSib, state)),
      /path_inside_worktree/);
    // Соседний <tmp>/memory рядом с <tmp>/wt: dirname хранилища содержит
    // worktree — контроллер отклонил бы на assertStoreOutside.
    const siblingMemory = join(dir, 'memory');
    await mkdir(siblingMemory);
    const memParent = { ...policySpec(wt), projectMemory: { storeDir: siblingMemory } };
    const fMem = await withPolicy(dir, memParent);
    await assert.rejects(() => buildRunPlan(runValues(fMem, state)),
      /path_inside_worktree/);
    // Полный канон: строковый ledger, объектный memory — проходят; env-fallback тоже.
    const okPolicy = { ...policySpec(wt), decisionLedger: ledger,
      projectMemory: { storeDir: memory } };
    const f3 = await withPolicy(dir, okPolicy);
    const plan = await buildRunPlan(runValues(f3, state));
    assert.equal(plan.ledger, ledger);
    assert.equal(plan.memory, memory);
    assert.equal(plan.env.DF_DECISION_LEDGER_PATH, undefined);
    // CLI-флаг при отсутствии пути в политике → передаётся контроллеру через env.
    const plan2 = await buildRunPlan(runValues(ok, state, { 'ledger-path': ledger }));
    assert.equal(plan2.env.DF_DECISION_LEDGER_PATH, ledger);
    // env-fallback контроллера учитывается при проверке.
    const envLedger = join(wt, 'env-ledger.jsonl');
    await writeFile(envLedger, '');
    await assert.rejects(() => buildRunPlan(runValues(ok, state),
      { env: { DF_DECISION_LEDGER_PATH: envLedger } }), /path_inside_worktree/);
    // Относительный путь — отказ (resolveLedgerPath контроллера требует absolute).
    const relPolicy = { ...policySpec(wt), decisionLedger: 'rel-ledger.jsonl' };
    const f4 = await withPolicy(dir, relPolicy);
    await assert.rejects(() => buildRunPlan(runValues(f4, state)), /path_not_absolute/);
    // Симлинк-предок внутри worktree: буквальный путь отклоняется до realpath.
    const linkDir = join(wt, 'ld');
    await symlink(dir, linkDir);
    await assert.rejects(() => buildRunPlan(runValues(ok, state,
      { 'ledger-path': join(linkDir, 'ledger.jsonl') })), /path_inside_worktree/);
    // Алиас worktree: симлинк-предок, разрешающийся внутрь дерева, — отказ.
    const alias = join(dir, 'alias');
    await symlink(wt, alias);
    const linkInWt = join(wt, 'via');
    await symlink(dir, linkInWt);
    const aliasPolicy = { ...policySpec(alias), decisionLedger: ledger };
    const f5 = await withPolicy(dir, aliasPolicy);
    await assert.rejects(() => buildRunPlan(runValues(f5, state,
      { 'memory-dir': join(alias, 'via', 'memory') })), /path_inside_worktree/);
    // Путь контроллера не переопределяется флагами.
    await assert.rejects(() => runFactory(['--provider', 'acp-devin', '--model', 'swe-2-high',
      '--policy', ok, '--state', state, '--run-isolated', '/tmp/evil.mjs'], {}),
      /Unknown option|run-isolated/);
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
