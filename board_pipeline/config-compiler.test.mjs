import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileDarkfactoryConfig as compile, validatePolicyContract } from './config-compiler.mjs';
import { operatorReviewSetup } from './review-setup.mjs';

const sha = 'a'.repeat(40);
const check = { image: `sha256:${'b'.repeat(64)}`, argv: ['node', '--test'], cwd: '.', timeoutMs: 1 };
const coder = { provider: 'acp-devin', model: 'swe-2-high' };
const critic = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };
const arbiter = { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'high' };
const config = {
  project: { id: 'proj_x', repoId: 'sample', branch: 'feature' },
  topology: { worktree: 'wt', handoffDir: 'inbox', base: sha },
  board: { url: 'http://127.0.0.1:44200/api/board', owner: 'test', label: { key: 'queue', value: 'sample' } },
  runtime: { kind: 'hc', waitMs: 1000 }, models: { coder, critic, arbiter },
  roles: { worker: 'coder', critic: 'critic', arbiter: 'arbiter' },
  gates: { profile: 'unit', checks: [check], brief: 'ops/brief', reviewPrompt: 'ops/review', reviewGate: 'ops/gate' },
  self_heal: { memoryDir: 'ops/memory', ledgerPath: 'ops/ledger' },
};
const yaml = `# Isolated operator slot; flow collections use JSON syntax.
project:
  id: proj_x
  repoId: sample
  branch: feature
topology:
  worktree: wt
  handoffDir: inbox
  base: ${sha}
board:
  url: http://127.0.0.1:44200/api/board
  owner: 'test' # not a YAML tag
  label: {"key":"queue","value":"sample"}
runtime:
  kind: hc
  waitMs: 1000
models:
  coder: ${JSON.stringify(coder)}
  critic: ${JSON.stringify(critic)}
  arbiter: ${JSON.stringify(arbiter)}
roles:
  worker: coder
  critic: critic
  arbiter: arbiter
gates:
  profile: unit
  checks:
    - image: ${check.image}
      argv:
        - node
        - --test
      cwd: .
      timeoutMs: 1
  brief: ops/brief
  reviewPrompt: ops/review
  reviewGate: ops/gate
self_heal:
  memoryDir: ops/memory
  ledgerPath: ops/ledger
`;

test('golden: YAML, JSON and structured input compile to the same executable v1 policy', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'config-contract-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of ['wt', 'inbox', 'ops', 'ops/memory']) await mkdir(join(dir, path));
  for (const file of ['brief', 'review', 'gate', 'routes.json', 'ledger']) await writeFile(join(dir, 'ops', file), '');
  const result = compile({ yamlText: yaml, baseDir: dir });
  const expected = {
    version: 1, scope: 'isolated', channel: 'pilot', boardUrl: config.board.url, owner: 'test', label: { key: 'queue', value: 'sample' },
    workerRuntime: 'hc', waitMs: 1000, handoffDir: join(dir, 'inbox'), brief: join(dir, 'ops/brief'),
    reviewPrompt: join(dir, 'ops/review'), reviewGate: join(dir, 'ops/gate'),
    bb: { ...coder, project: 'proj_x' }, arbiter, route: { worktree: join(dir, 'wt'), base: sha,
      repoId: 'sample', policyVersion: 1, checkProfile: 'unit', finish: 'verified' },
    profiles: { unit: { branch: 'feature', review: critic, checks: [check] } },
    projectMemory: join(dir, 'ops/memory'), decisionLedger: join(dir, 'ops/ledger'),
  };
  assert.deepEqual(result.compiledPolicy, expected);
  for (const source of [{ configObject: config }, { yamlText: JSON.stringify(config) }]) {
    const again = compile({ ...source, baseDir: dir });
    assert.equal(JSON.stringify(again), JSON.stringify(result));
  }
  assert.deepEqual(result.displayOnlyKeys, []);
  assert.deepEqual(Object.keys(result.consumedBy).sort(), Object.keys(config).sort());
  assert.ok(Object.values(result.consumedBy).every(destinations => destinations.length));
  const policy = JSON.parse(JSON.stringify(result.compiledPolicy));
  assert.equal((await operatorReviewSetup(policy, { env: {} })).critic.model, critic.model);
  const plan = await validatePolicyContract(policy, { env: {} });
  assert.equal(plan.worktree, expected.route.worktree);
  assert.equal(plan.memory, expected.projectMemory);
  await assert.rejects(validatePolicyContract(policy, { worktreeAliases: [join(dir, 'ops')] }), /path_inside_worktree/);
  const neon = structuredClone(config);
  neon.roles = { worker: 'coder', critic: 'arbiter', arbiter: 'critic' };
  neon.models.arbiter.reasoningLevel = 'medium';
  neon.gates.reviewSkillFiles = { logika: 'ops/review' };
  const neonPolicy = compile({ configObject: neon, baseDir: dir }).compiledPolicy;
  assert.deepEqual((await operatorReviewSetup(neonPolicy, { env: {} })).skillPaths, [expected.reviewPrompt]);
  const alias = join(dir, 'linked-review');
  await symlink(policy.reviewPrompt, alias);
  await assert.rejects(validatePolicyContract({ ...policy, reviewPrompt: alias }), /non_canonical_or_symlink_path/);
});

test('display-only annotations cannot affect policy; empty optional sections and defaults are explicit', () => {
  const { runtime, self_heal, ...minimal } = config;
  const baseDir = '/slot';
  const { compiledPolicy } = compile({ configObject: minimal, baseDir });
  assert.equal(compiledPolicy.workerRuntime, 'hc');
  assert.ok(compiledPolicy.waitMs > 0);
  assert.equal(compiledPolicy.projectMemory, undefined);
  const decorated = compile({ baseDir, configObject: { ...minimal, self_heal: {}, notes: 'hello',
    caption: 'local test slot', 'x-display-future': { arbitrary: true } } });
  assert.deepEqual(decorated.compiledPolicy, compiledPolicy);
  assert.deepEqual(decorated.displayOnlyKeys, ['caption', 'notes', 'self_heal', 'x-display-future']);
  for (const key of decorated.displayOnlyKeys) assert.deepEqual(decorated.consumedBy[key], []);
});

test('closed operational schemas: no unknown gate, unsafe override, unpinned check, or weakened role', () => {
  const reject = (change, error) => {
    const input = structuredClone(config);
    change(input);
    assert.throws(() => compile({ configObject: input, baseDir: '/slot' }), error);
  };
  reject(c => { c.allowUnsafeSubproc = true; }, /unknown_directive/);
  reject(c => { c.security = { failOpen: true }; }, /unknown_directive/);
  reject(c => { c.gates.bypass = false; }, /gates.bypass/);
  reject(c => { c.gates.checks[0].optional = true; }, /gates.check.optional/);
  reject(c => { c.self_heal.autoApprove = true; }, /self_heal.autoApprove/);
  reject(c => { c.gates.checks = []; }, /gates.profile/);
  reject(c => { c.gates.checks[0].image = 'latest'; }, /gates.check/);
  reject(c => { c.roles.critic = 'missing'; }, /models.unused|roles.critic/);
  reject(c => { c.models.critic.model = 'gpt-6.1-terra'; }, /terra_disallowed/);
  reject(c => { c.models.critic = coder; }, /review_same_family/);
  reject(c => { c.gates.reviewGate = '/slot/link/../gate'; }, /gates.reviewGate/);
  reject(c => { c.board.url = 'http://127.0.0.1:44100/api/board'; }, /pilot_route_not_allowed/);
  for (const n of [0, -1, 1.5, null, Number.MAX_SAFE_INTEGER + 1]) reject(c => { c.runtime.waitMs = n; }, /runtime.waitMs/);
});

test('empty, ambiguous and unsupported inputs fail rather than producing defaults', () => {
  for (const input of [undefined, {}, { configObject: null }, { configObject: [] }, { configObject: {} },
    { yamlText: ' ' }, { yamlText: yaml, configObject: config }, { yamlText: yaml, baseDir: 'relative' },
    { yamlText: yaml }, { yamlText: 'project: &shared' }, { yamlText: 'project:\n   id: proj_x' }]) {
    assert.throws(() => compile(input), /config_invalid/);
  }
  for (const duplicate of ['project: x\nproject: y', '{"project":{},"pro\\u006aect":{}}']) {
    assert.throws(() => compile({ yamlText: duplicate }), /duplicate:project/);
  }
});
