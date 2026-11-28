import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileDarkfactoryConfig } from './config-compiler.mjs';
import { deduplicateFindings, isolatedReviewPanelRunner, planReviewPanel } from './review-panel.mjs';
import { isolatedNeonReviewRunner } from './neon-review.mjs';
import { NEON_CRITIC, NEON_ISOLATION, OPUS_ARBITER, SOL_ARBITER } from './review-policy.mjs';
import { executorFamily, l2CriticRunners } from './review-runner.mjs';
import { agyStreamFixture, commitFile, neonFixture } from './review-test-fixture.mjs';

const roles = { executor: 'acp-devin/swe-2-high', arbiter: SOL_ARBITER };
const small = { changedLines: 300, blastRadius: { changedPaths: ['src/helper.js'], riskLevel: 'low' } };
const subject_digest = 'd'.repeat(64);
const binding = { task_id: '123', candidate_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40),
  subject_digest, executor: roles.executor };
const panel = { reviewPanel: { mode: 'panel' } };
const bug = { severity: 'P1', file: 'sum.js', line: 3, expected: '4', actual: '5' };
const soft = { ...bug, severity: 'P2', file: 'doc.md' };
const vote = (review, status = 'PASS', findings = []) => ({ status, findings,
  verdict: { PASS: 'REVIEW_OK', REWORK: 'REVIEW_BLOCKED', ESCALATE: 'REVIEW_ESCALATE' }[status],
  actual: review, task: binding.task_id, sha: binding.candidate_sha, subject_digest, tree_sha: 'c'.repeat(40),
  isolation: review.model === NEON_CRITIC.model ? NEON_ISOLATION : 'docker-ro-v1', checkpoint: '1'.repeat(32),
  transcript_file: 'reader.ndjson', transcript_sha256: '1'.repeat(64) });

test('policy: single, panel widths, and dynamic over both exact diff size and blast radius', () => {
  const plan = (policy, risk) => planReviewPanel({ ...roles, policy, risk });
  assert.deepEqual(plan({ mode: 'single' }), [NEON_CRITIC]);
  for (const size of [2, 3]) {
    const seats = plan({ mode: 'panel', size });
    assert.equal(seats.length, size);
    assert.equal(new Set([...seats, roles.executor, roles.arbiter].map(executorFamily)).size, size + 2);
  }
  for (const changedLines of [0, 1, 300]) assert.deepEqual(plan({}, { ...small, changedLines }), [NEON_CRITIC]);
  assert.equal(plan({}, { ...small, changedLines: 301 }).length, 2);
  for (const path of ['board_pipeline/controller.mjs', 'board_pipeline/tamper-gate.mjs', 'pkg/security/filter.js',
    'db/001-rls.sql', 'auth/token.ts', 'src/audio/dsp/core.c']) {
    assert.equal(plan({}, { ...small, blastRadius: { ...small.blastRadius, changedPaths: [path] } }).length, 2, path);
  }
  assert.equal(plan({}, { ...small, blastRadius: { ...small.blastRadius, riskLevel: 'high' } }).length, 2);
  assert.throws(() => plan({}), /risk_missing/);
  for (const policy of [null, [], { mode: 'sometimes' }, { size: 4 }, { mode: null }]) {
    assert.throws(() => plan(policy, small), /policy_invalid/);
  }
});

test('Fusion panel excludes both executor families when selecting extra seats', () => {
  const model = 'fusion-gpt-6-2-sol-medium-sidekick-swe-2-medium';
  const cognition = { provider: 'cognition', model: 'swe-2-high' };
  for (const executor of [{ provider: 'acp-devin', model }, `acp-devin/${model}`]) {
    const plan = { executor, primary: NEON_CRITIC, arbiter: OPUS_ARBITER, policy: { mode: 'panel', size: 2 } };
    assert.deepEqual(planReviewPanel(plan).map(executorFamily), ['google', 'deepseek']);
    assert.throws(() => planReviewPanel({ ...plan, primary: cognition }), { reason: 'review_same_family' });
    assert.throws(() => planReviewPanel({ ...plan, arbiter: cognition }), { reason: 'arbiter_family_not_independent' });
  }
});

test('the deepseek secondary seat plans with high reasoning to match its enrolled thinking level', () => {
  const seats = planReviewPanel({ ...roles, policy: { mode: 'panel', size: 3 } });
  const deepseek = seats.find(seat => seat.provider === 'opencode-go' && seat.model === 'deepseek-v4.1-flash');
  assert.ok(deepseek, 'the size-3 panel must include the deepseek seat');
  assert.equal(deepseek.reasoningLevel, 'high');
});

test('compiler binds reviewPanel to the trusted profile and rejects unknown switches', () => {
  const compile = reviewPanel => compileDarkfactoryConfig({ baseDir: '/slot', configObject: {
    project: { id: 'proj_x', repoId: 'sample', branch: 'feature' }, topology: { worktree: 'wt', base: 'HEAD', handoffDir: 'in' },
    board: { url: 'http://127.0.0.1:44200/api/board', owner: 'test', label: { key: 'queue', value: 'sample' } },
    models: { worker: { provider: 'acp-devin', model: 'swe-2-high' }, critic: NEON_CRITIC, arbiter: SOL_ARBITER },
    roles: { worker: 'worker', critic: 'critic', arbiter: 'arbiter' },
    gates: { profile: 'unit', checks: [{ image: `sha256:${'b'.repeat(64)}`, argv: ['true'], cwd: '.', timeoutMs: 1 }],
      brief: 'brief', reviewPrompt: 'prompt', reviewGate: 'gate', reviewPanel },
  } }).compiledPolicy.profiles.unit.reviewPanel;
  assert.deepEqual(compile({ size: 3 }), { mode: 'dynamic', size: 3 });
  for (const p of [null, { mode: 'vote' }, { size: 4 }, { skipArbiter: true }]) assert.throws(() => compile(p), /reviewPanel/);
});

test('all roles must be known and independent before any reader is created', async () => {
  const noCall = () => assert.fail('must not dispatch');
  const run = isolatedReviewPanelRunner({ makePrimary: noCall, makePi: noCall });
  for (const [change, profile, error] of [
    [{ executor: undefined }, {}, /triad_missing/], [{ executor: NEON_CRITIC }, {}, /same_family/],
    [{ executor: 'x/y' }, {}, /unknown_family/], [{}, { arbiter: NEON_CRITIC }, /not_independent/],
    [{ executor: SOL_ARBITER }, {}, /not_independent/], [{}, { arbiter: null }, /triad_missing/],
    [{ candidate_sha: 'HEAD' }, {}, /full_sha/], [{ subject_digest: null }, {}, /subject_missing/],
  ]) await assert.rejects(run({ ...binding, ...change }, { ...panel, ...profile }), error);
  // The next candidate would be a duplicate; never silently shrink to two.
  assert.throws(() => planReviewPanel({ executor: 'opencode-go/deepseek-v4.1-flash',
    policy: { mode: 'panel', size: 3 } }), /insufficient_families/);
});

test('dedup is order-independent; distinct files, bucket boundaries and unlocated defects survive', () => {
  const first = { ...bug, line: 5 }, worse = { ...bug, severity: 'P0', line: '1' };
  const next = { ...bug, line: 6 }, other = { ...bug, file: 'other.js' };
  const missing = { ...bug, line: null }, another = { ...missing, actual: 'NaN' };
  const values = [first, worse, other, next, missing, another, missing];
  const result = deduplicateFindings(values);
  assert.deepEqual(new Set(result), new Set([worse, next, other, missing, another]));
  assert.deepEqual(result, deduplicateFindings(values.reverse()));
  assert.deepEqual(deduplicateFindings([]), []);
  const [merged] = deduplicateFindings([worse, { ...bug, file: '/candidate/sum.js', violates_dod: true }]);
  assert.equal(merged.severity, 'P0');
  assert.equal(merged.dod_violation, true);
});

test('panel dispatch is parallel, not serial; severity gating happens before counting votes', async () => {
  const arrived = [], barrier = Promise.withResolvers();
  const make = () => async (pinned, { review }) => {
    arrived.push([pinned, review]);
    if (arrived.length === 3) barrier.resolve();
    await barrier.promise;
    return vote(review, 'REWORK', [{ ...soft, line: arrived.findIndex(a => a[1] === review) + 1 }]);
  };
  const run = isolatedReviewPanelRunner({ makePrimary: make, makePi: make, makeArbiter: () => assert.fail() });
  const result = await run(binding, { reviewPanel: { mode: 'panel', size: 3 } });
  assert.equal(new Set(arrived.map(([b]) => b)).size, 1);
  assert.equal(arrived[0][0].candidate_sha, binding.candidate_sha);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.findings, []);
  assert.equal(result.sidecar_findings.length, 1);
});

test('proven P0 stops outstanding readers and never opens arbitration, even under PASS', async () => {
  const started = Promise.withResolvers();
  let aborted = false;
  const run = isolatedReviewPanelRunner({ makePrimary: () => async (_, { review }) => {
    await started.promise; return vote(review, 'PASS', [{ ...bug, severity: 'P0' }]);
  }, makePi: ({ signal }) => async () => {
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    aborted = true; throw signal.reason;
  }, makeArbiter: () => assert.fail() });
  const result = await run(binding, panel);
  assert.equal(aborted, true);
  assert.equal(result.verdict, 'REVIEW_BLOCKED');
  assert.equal(result.findings[0].severity, 'P0');
});

test('a secondary P0 cancels even a stuck primary without impersonating it', async () => {
  const run = isolatedReviewPanelRunner({ makePrimary: ({ signal }) => async () => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  }, makePi: () => async (_, { review }) => vote(review, 'REWORK', [{ ...bug, severity: 'P0' }]) });
  const r = await run(binding, panel);
  assert.equal(r.verdict, 'REVIEW_BLOCKED');
  assert.deepEqual(r.actual, OPUS_ARBITER);
  assert.equal(r.panel.reviews.length, 1);
});

test('one missing/mismatched reader never becomes PASS or an arbitrable disagreement', async () => {
  for (const overrides of [null, { sha: binding.base_sha }, { subject_digest: null }, { tree_sha: binding.base_sha },
    { actual: NEON_CRITIC }, { isolation: 'host' }, { status: 'FAILED' }]) {
    const run = isolatedReviewPanelRunner({ makePrimary: () => async (_, { review }) => vote(review),
      makePi: () => async (_, { review }) => {
        if (overrides === null) throw Error('timeout');
        return { ...vote(review), ...overrides };
      }, makeArbiter: () => assert.fail() });
    await assert.rejects(run(binding, panel), /review_panel_incomplete|review_panel_subject_mismatch/);
  }
});

test('arbiter decisions are subject-bound; no acceptance of harm 10, escalations or excerpt-only objections', async () => {
  for (const [status, findings, decision, expected, calls] of [
    ['REWORK', [bug], { decision: 'directed_rework', directive: 'repair sum.js' }, 'REWORK', 1],
    ['REWORK', [bug], { decision: 'accept_with_notes', notes: 'OK', subject_digest: 'e'.repeat(64) }, 'ESCALATE', 1],
    ['REWORK', [bug], { decision: 'unknown' }, 'ESCALATE', 1],
    ['REWORK', [{ ...bug, harm: 10 }], {}, 'ESCALATE', 0],
    ['ESCALATE', [], {}, 'ESCALATE', 0], ['REWORK', [], {}, 'REWORK', 0],
  ]) {
    let count = 0;
    const run = isolatedReviewPanelRunner({ makePrimary: () => async (_, { review }) => vote(review),
      makePi: () => async (_, { review }) => ({ ...vote(review, status, findings), excerpt: 'concrete objection' }),
      makeArbiter: () => async req => { count++; return { subject_digest: req.subject_digest, ...decision }; } });
    assert.equal((await run(binding, panel)).status, expected);
    assert.equal(count, calls);
  }
});

// Exercise the actual controller runner seam, Git snapshots, model/subject
// attestation, sidecar file and arbiter parser. Only sandbox/transport I/O is fake.
test('bound dynamic route: exact large diff launches Neon and Pi; Sol judges their P1 conflict', async t => {
  const { repo, journal, binding: base } = await neonFixture(t);
  const body = 'export const n = 1;\n' + '// more\n'.repeat(300);
  const candidate_sha = await commitFile(repo, body);
  const bound = { ...base, candidate_sha, subject_digest };
  const piRoot = join(journal, 'pi');
  await mkdir(piRoot);
  await writeFile(join(piRoot, 'auth.json'), JSON.stringify({ agy: { type: 'fixture' }, openai: { type: 'fixture' } }));
  const voteJson = { verdict: 'PASS', summary: 'reviewed', findings: [soft], checked_invariants: ['sum'], subject_digest };
  const sessions = [];
  const options = { journal, piRoot, sandbox: async ({ argv, snapshot }) => {
    if (argv[0] === 'node') {
      assert.equal(await readFile(join(snapshot, 'sum.js'), 'utf8'), body);
      return { code: 0, stdout: '["candidate/sum.js"]' };
    }
    const model = argv[argv.indexOf('--model') + 1];
    sessions.push(model);
    const judge = model === SOL_ARBITER.model;
    if (!judge) {
      assert.equal(model, OPUS_ARBITER.model);
      assert.notEqual(snapshot, repo);
      assert.equal(await readFile(join(snapshot, 'sum.js'), 'utf8'), body);
    } else {
      assert.match(argv.at(-1), /panel_p1_conflict/);
      assert.ok(argv.at(-1).includes(candidate_sha));
    }
    const response = judge ? { decision: 'accept_with_notes', notes: 'the cited case meets spec', subject_digest }
      : { ...voteJson, verdict: 'REWORK', findings: [bug, { ...soft, severity: 'nit' }] };
    return { code: 0, stdout: [JSON.stringify({ type: 'message_end', message: { role: 'assistant',
      model, provider: argv[argv.indexOf('--provider') + 1], thinkingLevel: 'medium', stopReason: 'stop',
      content: [{ type: 'text', text: JSON.stringify(response) }] } }), '{"type":"agent_settled","aborted":false}'].join('\n') };
  }, transport: async ({ snapshot, publishSnapshot }) => {
    await publishSnapshot();
    assert.equal(await readFile(join(snapshot, 'candidate/sum.js'), 'utf8'), body);
    return { code: 0, cwd: snapshot, stdout: agyStreamFixture(voteJson, { cwd: snapshot, reads: ['diff.patch'] }) };
  } };
  const { review } = l2CriticRunners({ makeRunner: isolatedNeonReviewRunner, options });
  const receipt = await review(bound, { review: NEON_CRITIC, arbiter: SOL_ARBITER });
  assert.deepEqual(sessions, [OPUS_ARBITER.model, SOL_ARBITER.model]);
  assert.equal(receipt.panel.arbitration.decision, 'accept_with_notes');
  assert.equal(receipt.status, 'PASS');
  assert.deepEqual(receipt.findings, []);
  assert.deepEqual(receipt.sidecar_findings, [soft]);
  const log = await readFile(join(journal, `review-sidecar-${bound.task_id}-${candidate_sha}.jsonl`), 'utf8');
  assert.deepEqual(JSON.parse(log).findings, [soft]); // exactly one JSON record
  for (const r of receipt.panel.reviews) {
    assert.equal(r.sha, candidate_sha);
    assert.equal(r.tree_sha, receipt.tree_sha);
    assert.equal(createHash('sha256').update(await readFile(join(journal, r.transcript_file))).digest('hex'), r.transcript_sha256);
  }
  sessions.length = 0;
  const single = await review(bound, { review: NEON_CRITIC, arbiter: SOL_ARBITER, reviewPanel: { mode: 'single' } });
  assert.equal(single.status, 'PASS');
  assert.equal(single.panel.reviews.length, 1);
  assert.deepEqual(sessions, []);
});
