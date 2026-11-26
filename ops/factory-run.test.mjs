import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunPlan, runFactory } from './factory-run.mjs';

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

const runtimeValue = plan => {
  const indexes = plan.argv.flatMap((arg, index) => arg === '--runtime' ? [index] : []);
  assert.equal(indexes.length, 1);
  return plan.argv[indexes[0] + 1];
};

test('default runtime is explicitly hc and explicit/policy/env resolution is fail-closed', async t => {
  const f = await fixture(t);
  const plan = await buildRunPlan(f.values(), { env: {} });
  assert.equal(runtimeValue(plan), 'hc');

  const envPlan = await buildRunPlan(f.values(), { env: { DF_WORKER_RUNTIME: 'bb' } });
  assert.equal(runtimeValue(envPlan), 'bb');

  await f.writePolicy({ workerRuntime: 'subproc' });
  const policyPlan = await buildRunPlan(f.values(), { env: { DF_WORKER_RUNTIME: 'bb' } });
  assert.equal(runtimeValue(policyPlan), 'subproc');

  const explicitPlan = await buildRunPlan(f.values({ runtime: 'hc' }), { env: { DF_WORKER_RUNTIME: 'bb' } });
  assert.equal(runtimeValue(explicitPlan), 'hc');

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
  const explicit = await runFactory([...args.slice(0, -1), '--runtime', 'subproc', '--dry-run'],
    { git, env: {} });
  assert.equal(runtimeValue(explicit.plan), 'subproc');
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
