// Тесты тонких CLI: ops/factory-enqueue.mjs и ops/factory-run.mjs.
// Без внешних зависимостей и host-путей: все эффекты через внедряемые
// runner'ы, временные каталоги удаляются в finally.
import { execFile } from 'node:child_process';
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
  assert.deepEqual(plan.argv.slice(0, 2), ['tasks', 'create']);
  assert.ok(plan.argv.includes('--board-url'));
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
  assert.ok(calls[0][1].includes('--text'));
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
    // Симлинк — отказ.
    const link = join(dir, 'link.md');
    await symlink(brief, link);
    await assert.rejects(() => buildEnqueuePlan({ ...baseValues(), 'spec-digest': undefined,
      brief: link, worktree }), /path_symlink_refused/);
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
  const file = join(dir, 'policy.json');
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

test('run: запрещённая модель в CLI, критике и арбитре отклоняется', async () => {
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
    await assert.rejects(() => buildRunPlan(runValues(f1, 's')), /disallowed:critic/);
    const badArbiter = { ...policySpec(wt), arbiter: { provider: 'pi', model: 'acp-zcode-start/x' } };
    const f2 = join(dir, 'p2.json');
    await writeFile(f2, JSON.stringify(badArbiter));
    await assert.rejects(() => buildRunPlan(runValues(f2, 's')), /zcode.*:arbiter/);
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
    const git = async a => { gitCalls.push(a); return 'true'; };
    const dry = await runFactory([...args, '--dry-run'], { git });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.plan.argv.slice(1),
      ['--execute', '--policy', policy, '--state', state, '--daemon', '--interval-ms', '50']);
    assert.deepEqual(gitCalls, [['-C', wt, 'rev-parse', '--is-inside-work-tree']]);
    // Не-git worktree в dry-run — отказ.
    gitCalls.length = 0;
    const notGit = async () => 'false\n';
    await assert.rejects(() => runFactory([...args, '--dry-run'], { git: notGit }),
      /worktree_not_git/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
    const result = await runFactory(args, { run: async (cmd, argv) => {
      calls.push(argv); return { status: 0 };
    } });
    assert.equal(result.dryRun, false);
    assert.equal(calls.length, 1);
    assert.ok(calls[0][0].endsWith('run-isolated.mjs'));
    assert.equal((await git(['config', '--local', 'core.fileMode'])).stdout.trim(), 'false');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run: memory/ledger вне worktree, симлинк отклоняется', async () => {
  const dir = await tempdir();
  try {
    const wt = join(dir, 'wt');
    await mkdir(wt);
    const ledger = join(dir, 'ledger.jsonl');
    await writeFile(ledger, '');
    const memory = join(dir, 'memory');
    await mkdir(memory);
    const insideLedger = join(wt, 'ledger.jsonl');
    await writeFile(insideLedger, '');
    const link = join(dir, 'link');
    await symlink(ledger, link);
    const badPolicy = { ...policySpec(wt), decisionLedger: insideLedger };
    const f1 = join(dir, 'p1.json');
    await writeFile(f1, JSON.stringify(badPolicy));
    const state = join(dir, 'st');
    await assert.rejects(() => buildRunPlan(runValues(f1, state)),
      /path_inside_worktree/);
    const ok = await withPolicy(dir, policySpec(wt));
    await assert.rejects(() => buildRunPlan(
      runValues(ok, state, { 'ledger-path': link })), /path_symlink_refused/);
    const okPolicy = { ...policySpec(wt), decisionLedger: ledger, projectMemory: memory };
    const f2 = join(dir, 'p2.json');
    await writeFile(f2, JSON.stringify(okPolicy));
    const plan = await buildRunPlan(runValues(f2, state));
    assert.ok(plan.argv.includes('--execute'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run-isolated: заголовок DF #, без Пилот #', async () => {
  const source = await readFile(
    join(new URL('.', import.meta.url).pathname, '..', 'board_pipeline', 'run-isolated.mjs'),
    'utf8');
  assert.match(source, /`DF #\$\{attempt\.task_id\}\$\{ticket\}`/);
  assert.doesNotMatch(source, /Пилот #\$\{attempt\.task_id\}/);
});
