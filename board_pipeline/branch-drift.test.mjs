import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectWorktreesAndBranches, assertNoBranchDrift,
  classifyWorkerSession, parseWorktreeList } from './branch-drift.mjs';
import { buildEnqueuePlan } from '../ops/factory-enqueue.mjs';

const HEX = 'a'.repeat(64);
const HEX2 = 'b'.repeat(64);

const WORKTREE_LIST = `worktree /repo/main
HEAD aaaa
branch refs/heads/main

worktree /repo/wt1
HEAD bbbb
branch refs/heads/bb/thr_abc123

worktree /repo/wt2
HEAD cccc
detached
`;

// execGit fixture: ответы по сигнатуре (cwd, args).
const fakeGit = map => async (args, cwd) => {
  const key = args.join(' ');
  for (const [pattern, value] of map) {
    if (pattern(args, cwd)) {
      if (value instanceof Error) throw value;
      return typeof value === 'function' ? value(args, cwd) : value;
    }
  }
  throw new Error(`unexpected git call: ${key} @ ${cwd}`);
};

test('parseWorktreeList parses porcelain blocks', () => {
  const wts = parseWorktreeList(WORKTREE_LIST);
  assert.equal(wts.length, 3);
  assert.equal(wts[0].path, '/repo/main');
  assert.equal(wts[1].branch, 'bb/thr_abc123');
  assert.equal(wts[2].detached, true);
});

const baseGit = ({ dirty = {}, unmerged = [], diffs = {} } = {}) => fakeGit([
  [(a) => a.join(' ') === 'worktree list --porcelain', () => WORKTREE_LIST],
  [(a, cwd) => a.join(' ') === 'status --porcelain', (a, cwd) => dirty[cwd] ?? ''],
  [(a) => a[0] === 'branch', () => unmerged.join('\n') + (unmerged.length ? '\n' : '')],
  [(a, cwd) => a[0] === 'diff', (a) => (diffs[a[a.indexOf('--') - 1]] ?? []).join('\n')],
]);

test('clean repo: no drift detected', async () => {
  const report = await inspectWorktreesAndBranches({
    repoDir: '/repo/main', baseRef: 'main', execGit: baseGit() });
  assert.equal(report.ok, true);
  assert.equal(report.driftDetected, false);
  assert.equal(report.unmergedBranches.length, 0);
  assert.equal(report.dirtyWorktrees.length, 0);
  assert.equal(report.bbThreadWorktrees.length, 1); // bb/thr_abc123 замечен, но чист
});

test('dirty worktree and unmerged branch trigger drift', async () => {
  const report = await inspectWorktreesAndBranches({
    repoDir: '/repo/main', baseRef: 'main',
    execGit: baseGit({
      dirty: { '/repo/wt1': ' M src/a.mjs\n' },
      unmerged: ['feat/other'],
      diffs: { 'main...feat/other': ['src/b.mjs'] },
    }) });
  assert.equal(report.driftDetected, true);
  assert.equal(report.dirtyWorktrees.length, 1);
  assert.equal(report.dirtyWorktrees[0].isBbThread, true);
  assert.equal(report.unmergedBranches.length, 1);
  assert.equal(report.unmergedBranches[0].branch, 'feat/other');
});

test('touchPaths filter: unrelated unmerged branch ignored', async () => {
  const report = await inspectWorktreesAndBranches({
    repoDir: '/repo/main', baseRef: 'main', touchPaths: ['src/specific'],
    execGit: baseGit({
      unmerged: ['feat/a', 'feat/b'],
      diffs: { 'main...feat/a': ['docs/x.md'], 'main...feat/b': ['src/specific/y.mjs'] },
    }) });
  assert.equal(report.unmergedBranches.length, 1);
  assert.equal(report.unmergedBranches[0].branch, 'feat/b');
  // Грязных worktree нет → пересечение только по feat/b.
  assert.equal(report.driftDetected, true);
});

test('empty touchPaths reports all unmerged branches', async () => {
  const report = await inspectWorktreesAndBranches({
    repoDir: '/repo/main', baseRef: 'main',
    execGit: baseGit({ unmerged: ['x', 'y'], diffs: { 'main...x': ['a'], 'main...y': ['b'] } }) });
  assert.equal(report.unmergedBranches.length, 2);
});

test('assertNoBranchDrift throws with drift report attached', async () => {
  await assert.rejects(() => assertNoBranchDrift({
    repoDir: '/repo/main', baseRef: 'main',
    execGit: baseGit({ dirty: { '/repo/wt2': ' M f\n' } }) }),
    error => {
      assert.equal(error.message, 'branch_drift_detected');
      assert.ok(error.drift.dirtyWorktrees.length > 0);
      return true;
    });
});

test('assertNoBranchDrift allows with allowDrift', async () => {
  const report = await assertNoBranchDrift({
    repoDir: '/repo/main', baseRef: 'main', allowDrift: true,
    execGit: baseGit({ dirty: { '/repo/wt2': ' M f\n' } }) });
  assert.equal(report.driftDetected, true);
});

test('unavailable worktree status treated as dirty (fail-closed)', async () => {
  const execGit = baseGit();
  const wrapped = async (args, cwd) => {
    if (args[0] === 'status' && cwd === '/repo/wt1') throw new Error('ENOENT');
    return execGit(args, cwd);
  };
  const report = await inspectWorktreesAndBranches({
    repoDir: '/repo/main', baseRef: 'main', execGit: wrapped });
  assert.equal(report.driftDetected, true);
  assert.equal(report.dirtyWorktrees[0].dirtyFiles[0], '<status_unavailable>');
});

test('P1: git branch --no-merged failure throws drift_check_unavailable', async () => {
  const execGit = baseGit();
  const wrapped = async (args, cwd) => {
    if (args[0] === 'branch') throw new Error('fatal: not a valid object');
    return execGit(args, cwd);
  };
  await assert.rejects(() => inspectWorktreesAndBranches({
    repoDir: '/repo/main', baseRef: 'main', execGit: wrapped }),
    /drift_check_unavailable/);
});

test('P1: git diff failure counts branch as overlapping (fail-closed)', async () => {
  const execGit = baseGit({ unmerged: ['feat/x'] });
  const wrapped = async (args, cwd) => {
    if (args[0] === 'diff') throw new Error('diff broke');
    return execGit(args, cwd);
  };
  const report = await inspectWorktreesAndBranches({
    repoDir: '/repo/main', baseRef: 'main', touchPaths: ['no/match/here'],
    execGit: wrapped });
  assert.equal(report.driftDetected, true);
  assert.equal(report.unmergedBranches.length, 1);
  assert.equal(report.unmergedBranches[0].files[0], '<diff_unavailable>');
});

test('P1: touches() normalizes ./, trailing / and dot segments identically', async () => {
  for (const tp of ['ops', 'ops/', './ops', './ops/', 'a/../ops']) {
    const report = await inspectWorktreesAndBranches({
      repoDir: '/repo/main', baseRef: 'main', touchPaths: [tp],
      execGit: baseGit({ unmerged: ['feat/a'],
        diffs: { 'main...feat/a': ['ops/control-room/x.mjs'] } }) });
    assert.equal(report.unmergedBranches.length, 1, `touch=${tp}`);
  }
  // А непересекающийся touch не считается.
  const report = await inspectWorktreesAndBranches({
    repoDir: '/repo/main', baseRef: 'main', touchPaths: ['opsx'],
    execGit: baseGit({ unmerged: ['feat/a'],
      diffs: { 'main...feat/a': ['ops/control-room/x.mjs'] } }) });
  assert.equal(report.unmergedBranches.length, 0);
});

test('P1: baseRef starting with - rejected (no git option injection)', async () => {
  await assert.rejects(() => inspectWorktreesAndBranches({
    repoDir: '/repo/main', baseRef: '--all', execGit: baseGit() }),
    /base_ref_invalid/);
});

test('portable worker classification covers df, feat/df and subproc conventions', () => {
  assert.equal(classifyWorkerSession({ branch: 'df-3840-d0d63638ee' }), 'hc');
  assert.equal(classifyWorkerSession({ branch: 'feat/df-slot-4' }), 'hc');
  assert.equal(classifyWorkerSession({ branch: 'subproc-d0d63638ee89' }), 'subproc');
  assert.equal(classifyWorkerSession({ branch: 'bb/thr_abc123' }), 'bb');
  assert.equal(classifyWorkerSession({ path: '/home/operator/df-slot-4' }), 'hc');
  assert.equal(classifyWorkerSession({ path: '/tmp/subproc-d0d63638ee89' }), 'subproc');
  assert.equal(classifyWorkerSession({ path: '/repo/wt-thr_abc123' }), 'bb');
  assert.equal(classifyWorkerSession({ branch: 'dfx', path: '/repo/plain' }), null);
  assert.equal(classifyWorkerSession({ branch: 'feature/subproc-d0d63638ee89' }), null);
});

test('portable worker branches and worktrees are classified alongside bb threads', async () => {
  const worktrees = `worktree /repo/main
HEAD aaaa
branch refs/heads/main

worktree /home/operator/df-slot-4
HEAD bbbb
branch refs/heads/feat/df-slot-4

worktree /tmp/subproc-d0d63638ee89
HEAD cccc
detached

worktree /repo/wt-bb
HEAD dddd
branch refs/heads/bb/thr_old1
`;
  const branches = ['feat/df-task', 'subproc-d0d63638ee89', 'bb/thr_old2', 'feat/other'];
  const execGit = fakeGit([
    [(a) => a.join(' ') === 'worktree list --porcelain', worktrees],
    [(a, cwd) => a.join(' ') === 'status --porcelain',
      (a, cwd) => cwd === '/home/operator/df-slot-4' ? ' M board_pipeline/x.mjs\n' : ''],
    [(a) => a[0] === 'branch', () => `${branches.join('\n')}\n`],
    [(a) => a[0] === 'diff', () => 'board_pipeline/x.mjs\n'],
  ]);
  const report = await inspectWorktreesAndBranches({ repoDir: '/repo/main', baseRef: 'main', execGit });
  assert.equal(report.bbThreadWorktrees.length, 1);
  assert.equal(report.bbThreadWorktrees[0].branch, 'bb/thr_old1');
  assert.deepEqual(Object.fromEntries(report.workerWorktrees.map(wt => [wt.path, wt.workerKind])), {
    '/home/operator/df-slot-4': 'hc',
    '/tmp/subproc-d0d63638ee89': 'subproc',
    '/repo/wt-bb': 'bb',
  });
  const dirtyDf = report.dirtyWorktrees.find(wt => wt.path === '/home/operator/df-slot-4');
  assert.equal(dirtyDf.isBbThread, false);
  assert.equal(dirtyDf.workerKind, 'hc');
  const byBranch = Object.fromEntries(report.unmergedBranches.map(item => [item.branch, item]));
  assert.equal(byBranch['feat/df-task'].workerKind, 'hc');
  assert.equal(byBranch['subproc-d0d63638ee89'].workerKind, 'subproc');
  assert.equal(byBranch['bb/thr_old2'].workerKind, 'bb');
  assert.equal(byBranch['bb/thr_old2'].isBbThread, true);
  assert.equal(byBranch['feat/other'].workerKind, null);
  assert.equal(byBranch['feat/other'].isBbThread, false);
  assert.match(report.summary, /3 worker worktree\(s\)/);
});

// --- интеграция в ops/factory-enqueue.mjs -----------------------------------

const tempdir = async () => realpath(await mkdtemp(join(tmpdir(), 'drift-test-')));

const enqueueValues = worktree => ({
  'board-url': 'https://board.example', channel: 'ops', title: 'T',
  'repo-id': 'repo', profile: 'prof', finish: 'verified',
  'spec-digest': HEX, 'policy-digest': HEX2,
  ...(worktree ? { worktree } : {}) });

const gitProbe = execGit => (args, cwd) =>
  args[0] === 'rev-parse' ? 'true\n' : execGit(args, cwd);

test('enqueue: drift blocks before vb when worktree is a git repo', async () => {
  const wt = await tempdir();
  let checked = null;
  await assert.rejects(() => buildEnqueuePlan(enqueueValues(wt), {
    execGit: gitProbe(baseGit({ dirty: { '/repo/wt1': ' M src/x\n' } })),
    checkBranchDrift: opts => { checked = opts; return assertNoBranchDrift(opts); },
  }), /branch_drift_detected/);
  assert.equal(checked.repoDir, wt);
  assert.equal(checked.allowDrift, false);
});

test('enqueue: --allow-drift passes and records plan.meta.branchDrift', async () => {
  const wt = await tempdir();
  const plan = await buildEnqueuePlan(
    { ...enqueueValues(wt), 'allow-drift': true, touch: ['src'] }, {
    execGit: gitProbe(baseGit({ dirty: { '/repo/wt1': ' M src/x\n' } })),
    checkBranchDrift: opts => assertNoBranchDrift(opts),
  });
  assert.equal(plan.meta.branchDrift.allowedByFlag, true);
  assert.equal(plan.meta.branchDrift.driftDetected, true);
});

test('enqueue: clean git repo records driftDetected false', async () => {
  const wt = await tempdir();
  const plan = await buildEnqueuePlan(enqueueValues(wt), {
    execGit: gitProbe(baseGit()),
    checkBranchDrift: opts => assertNoBranchDrift(opts),
  });
  assert.equal(plan.meta.branchDrift.driftDetected, false);
});

test('enqueue: non-git worktree without --check-drift skips drift check', async () => {
  const wt = await tempdir();
  const plan = await buildEnqueuePlan(enqueueValues(wt), {
    execGit: async () => { throw new Error('not a git repo'); },
  });
  assert.equal(plan.meta.branchDrift, undefined);
});

test('enqueue: explicit --check-drift on non-git dir fails closed', async () => {
  const wt = await tempdir();
  await assert.rejects(() => buildEnqueuePlan(
    { ...enqueueValues(wt), 'check-drift': true }, {
    execGit: async () => { throw new Error('not a git repo'); },
  }), /drift_check_unavailable/);
});

test('enqueue: --check-drift without worktree fails closed', async () => {
  await assert.rejects(() => buildEnqueuePlan(
    { ...enqueueValues(), 'check-drift': true },
    { execGit: async () => { throw new Error('nope'); } }),
    /drift_check_unavailable/);
});

test('enqueue: touch paths reach drift check', async () => {
  const wt = await tempdir();
  let checked = null;
  await buildEnqueuePlan({ ...enqueueValues(wt), touch: ['ops/', 'docs/a.md'] }, {
    execGit: gitProbe(baseGit()),
    checkBranchDrift: opts => { checked = opts; return assertNoBranchDrift(opts); },
  });
  assert.deepEqual(checked.touchPaths, ['ops/', 'docs/a.md']);
});
