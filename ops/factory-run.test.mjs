import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePolicyContract } from '../board_pipeline/config-compiler.mjs';
import { buildRunPlan, ensureFilemodeGuard, runFactory } from './factory-run.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factory-run-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, 'wt');
  const state = join(root, 'state');
  const handoffDir = join(root, 'inbox');
  const ops = join(root, 'ops');
  await mkdir(worktree);
  await mkdir(state);
  await chmod(state, 0o700);
  await mkdir(handoffDir);
  await mkdir(ops);
  const brief = join(ops, 'brief.md');
  const reviewPrompt = join(ops, 'review.md');
  const reviewGate = join(ops, 'gate.json');
  await writeFile(brief, 'brief');
  await writeFile(reviewPrompt, 'review');
  await writeFile(reviewGate, '{}');
  await writeFile(join(ops, 'routes.json'), '{}');
  const profile = extra => ({ branch: 'b',
    review: { provider: 'google', model: 'gemini-4-neon' }, ...extra });
  const makePolicy = (overrides = {}) => ({
    version: 1,
    handoffDir,
    brief,
    reviewPrompt,
    reviewGate,
    bb: { provider: 'acp-devin', model: 'swe-2-high', project: 'proj_x' },
    route: { worktree, checkProfile: 'default', finish: 'verified', repoId: 'r' },
    profiles: { default: profile() },
    arbiter: { provider: 'openai', model: 'gpt-6.2-sol' },
    ...overrides,
  });
  const policy = join(root, 'policy.json');
  const writePolicy = async (overrides = {}) => {
    await writeFile(policy, JSON.stringify(makePolicy(overrides)));
    return policy;
  };
  await writePolicy();
  const values = (extra = {}) => ({
    provider: 'acp-devin', model: 'swe-2-high', policy, state, ...extra,
  });
  return { root, worktree, state, handoffDir, ops, policy, writePolicy, values, profile };
}

test('CLI and standalone validator reject the same invalid policy before effects', async t => {
  const f = await fixture(t);
  for (const [bad, reason] of [
    [{ profiles: {} }, 'profile_required'],
    [{ profiles: { default: f.profile({ checks: [] }) } }, 'profile_required'],
    [{ reviewPrompt: f.worktree }, 'path_not_file'],
    [{ arbiter: { provider: 'openai', model: 'unknown' } }, 'model_not_approved:arbiter'],
    [{ routing: { allowlist: { critic: ['pi/openai/gpt-6.1-terra'] } } }, 'model_gpt_6_1_terra_disallowed:routing.allowlist.critic'],
  ]) {
    await f.writePolicy(bad);
    const policy = JSON.parse(await readFile(f.policy, 'utf8'));
    await assert.rejects(validatePolicyContract(policy), { message: reason });
    await assert.rejects(buildRunPlan(f.values(), { env: {} }), { message: reason });
  }
});

const runtimeArgvIndexes = plan =>
  plan.argv.flatMap((arg, index) => arg === '--runtime' ? [index] : []);
const runtimeValue = plan => plan.env.DF_WORKER_RUNTIME;

test('default runtime is explicitly hc and explicit/policy/env resolution is fail-closed', async t => {
  const f = await fixture(t);
  const plan = await buildRunPlan(f.values(), { env: {} });
  assert.equal(runtimeValue(plan), 'hc');
  assert.deepEqual(runtimeArgvIndexes(plan), []);

  const envPlan = await buildRunPlan(f.values(), { env: { DF_WORKER_RUNTIME: 'bb' } });
  assert.equal(runtimeValue(envPlan), 'bb');
  assert.deepEqual(runtimeArgvIndexes(envPlan), []);

  await f.writePolicy({ workerRuntime: 'subproc' });
  const policyPlan = await buildRunPlan(f.values(), { env: { DF_WORKER_RUNTIME: 'bb' } });
  assert.equal(runtimeValue(policyPlan), 'subproc');
  assert.deepEqual(runtimeArgvIndexes(policyPlan), []);

  const explicitPlan = await buildRunPlan(f.values({ runtime: 'hc' }), { env: { DF_WORKER_RUNTIME: 'bb' } });
  assert.equal(runtimeValue(explicitPlan), 'hc');
  assert.equal(runtimeArgvIndexes(explicitPlan).length, 1);
  assert.equal(explicitPlan.argv[runtimeArgvIndexes(explicitPlan)[0] + 1], 'hc');

  await f.writePolicy({ workerRuntime: null });
  await assert.rejects(() => buildRunPlan(f.values(), { env: {} }), /worker_runtime_kind_invalid/);
  await assert.rejects(() => buildRunPlan(f.values({ runtime: null }), { env: {} }), /worker_runtime_kind_invalid/);
  await assert.rejects(() => buildRunPlan(f.values(), { env: { DF_WORKER_RUNTIME: '' } }), /worker_runtime_kind_invalid/);
});

test('runFactory dry-run forwards exactly one runtime selection to the controller', async t => {
  const f = await fixture(t);
  const git = async args => {
    assert.deepEqual(args, ['-C', f.worktree, 'rev-parse', '--show-toplevel']);
    return f.worktree;
  };
  const args = ['--provider', 'acp-devin', '--model', 'swe-2-high',
    '--policy', f.policy, '--state', f.state, '--dry-run'];
  const defaulted = await runFactory(args, { git, env: {} });
  assert.equal(runtimeValue(defaulted.plan), 'hc');
  assert.deepEqual(runtimeArgvIndexes(defaulted.plan), []);
  const explicit = await runFactory([...args.slice(0, -1), '--runtime', 'subproc', '--dry-run'],
    { git, env: {} });
  assert.equal(runtimeValue(explicit.plan), 'subproc');
  assert.equal(runtimeArgvIndexes(explicit.plan).length, 1);
  assert.equal(explicit.plan.argv[runtimeArgvIndexes(explicit.plan)[0] + 1], 'subproc');
});

test('node_modules mount targets stay strict: nested canonical targets pass, traversal and controls fail', async t => {
  const f = await fixture(t);
  const nodeModules = join(f.root, 'node_modules');
  await mkdir(nodeModules);
  const recipe = to => ({
    image: `sha256:${'a'.repeat(64)}`, argv: ['npm', 'test'], cwd: '.', timeoutMs: 60_000,
    mounts: [{ from: nodeModules, to }],
  });
  const writeMountPolicy = to => f.writePolicy({
    profiles: { default: f.profile({ checks: [recipe(to)] }) },
  });

  for (const to of ['/candidate/node_modules', '/candidate/app/node_modules', '/candidate/a/b/node_modules']) {
    await writeMountPolicy(to);
    const plan = await buildRunPlan(f.values(), { env: {} });
    assert.equal(plan.worktree, f.worktree, to);
  }

  for (const to of [
    '/candidate/../node_modules',
    '/candidate/x/../node_modules',
    '/candidate/./node_modules',
    '/candidate//node_modules',
    `/candidate/a\nb/node_modules`,
    `/candidate/a\0b/node_modules`,
    `/candidate/a\u007fb/node_modules`,
    `/candidate/a\u0085b/node_modules`,
  ]) {
    await writeMountPolicy(to);
    await assert.rejects(() => buildRunPlan(f.values(), { env: {} }), /mount_outside_allowlist/, JSON.stringify(to));
  }
});

// --- Astra #22 (P2): повторная запись core.fileMode пропускается без необходимости ---
// Git-double ensureFilemodeGuard: журналирует вызовы и отвечает по сценарию
// состояния конфига, без реального репозитория.
function filemodeGitDouble(worktree, { local = null, effective = null } = {}) {
  const calls = [];
  const state = { local, worktreeOverride: null, effective };
  const git = async args => {
    calls.push(args);
    const key = args.slice(2).join(' ');
    if (key === 'rev-parse --show-toplevel') return worktree;
    if (key === 'config --local --get core.fileMode') {
      if (state.local === null) throw new Error('exit 1');
      return state.local;
    }
    if (key === 'config --local core.fileMode false') {
      state.local = 'false';
      return '';
    }
    if (key === 'config --get core.fileMode') {
      const value = state.worktreeOverride ?? state.effective ?? state.local;
      if (value === null) throw new Error('exit 1');
      return value;
    }
    if (key === 'config --worktree core.fileMode false') {
      state.worktreeOverride = 'false';
      return '';
    }
    throw new Error(`unexpected git call: ${key}`);
  };
  return { calls, git, state };
}
const configWrites = calls => calls.filter(args =>
  args.slice(2).join(' ').startsWith('config') && args.includes('false'));

test('ensureFilemodeGuard skips the write entirely when --local core.fileMode is already false', async t => {
  const worktree = '/wt';
  const { calls, git } = filemodeGitDouble(worktree, { local: 'false' });
  await ensureFilemodeGuard(worktree, { git });
  assert.deepEqual(calls.map(args => args.slice(2).join(' ')), [
    'rev-parse --show-toplevel',
    'config --local --get core.fileMode',
    'config --get core.fileMode',
  ]);
  assert.equal(configWrites(calls).length, 0,
    'ни одной записи в конфиг — нет повода для .git/config.lock при параллельных слотах');
});

test('ensureFilemodeGuard writes exactly once when the value is unset or not false', async t => {
  const worktree = '/wt';
  for (const local of [null, 'true']) {
    const { calls, git } = filemodeGitDouble(worktree, { local });
    await ensureFilemodeGuard(worktree, { git });
    const writes = configWrites(calls);
    assert.equal(writes.length, 1, `local=${local}: ровно одна запись`);
    assert.deepEqual(writes[0].slice(2), ['config', '--local', 'core.fileMode', 'false']);
    // Идемпотентность: повторный прогон того же слота записей уже не делает.
    const second = await captureGuard(worktree, git, calls);
    assert.equal(second, 0, 'повторный запуск — чистый no-op');
  }
});

async function captureGuard(worktree, git, calls) {
  const before = calls.length;
  await ensureFilemodeGuard(worktree, { git });
  return configWrites(calls.slice(before)).length;
}

test('ensureFilemodeGuard does not rewrite --local when a worktree override shadows the effective value', async t => {
  const worktree = '/wt';
  // --local уже false, но extensions.worktreeConfig перекрывает эффективное
  // значение на true: guard чинит --worktree, не трогая --local повторно.
  const { calls, git, state } = filemodeGitDouble(worktree, { local: 'false', effective: 'true' });
  await ensureFilemodeGuard(worktree, { git });
  const writes = configWrites(calls).map(args => args.slice(2).join(' '));
  assert.deepEqual(writes, ['config --worktree core.fileMode false']);
  assert.equal(state.worktreeOverride, 'false');
});

test('ensureFilemodeGuard fails closed when neither write makes the effective value false', async t => {
  const worktree = '/wt';
  const { git } = filemodeGitDouble(worktree, { local: null, effective: 'true' });
  const rigged = async args => {
    const key = args.slice(2).join(' ');
    if (key === 'config --worktree core.fileMode false') throw new Error('config locked');
    return git(args);
  };
  await assert.rejects(() => ensureFilemodeGuard(worktree, { git: rigged }), /filemode_guard_ineffective/);
});
