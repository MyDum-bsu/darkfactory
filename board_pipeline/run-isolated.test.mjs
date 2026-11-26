import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { allowedPathsFromAttempt, allowedPathsFromLabels, buildWorkerTransport, isApprovedWorker,
  queueModeSpecInputs, resolveWorkerRuntimeKind, scopeFenceReworkResult } from './run-isolated.mjs';
import { deterministicRuntimeId } from './worker-runtime.mjs';
import { workerIntakePrompt } from './intake-prompt.mjs';

test('isApprovedWorker accepts SWE-2.1 implementation workers and legacy SWE-2 High', () => {
  for (const model of ['swe-2-1-medium', 'swe-2-1-high', 'swe-2-1-xhigh', 'swe-2-1-max']) {
    assert.equal(isApprovedWorker({ provider: 'acp-devin', model }), true);
  }
  assert.equal(isApprovedWorker({ provider: 'acp-devin', model: 'swe-2-high' }), true);
});

test('isApprovedWorker rejects unapproved SWE-2.1 variants and provider/model mismatches', () => {
  for (const spec of [
    { provider: 'acp-devin', model: 'swe-2-1-fake' },
    { provider: 'acp-devin', model: 'swe-2-1-low' },
    { provider: 'openai', model: 'swe-2-1-medium' },
    { provider: 'acp-devin' },
  ]) {
    assert.equal(isApprovedWorker(spec), false);
  }
});


const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

test('queue mode injects the verified card specification into worker and review specs', () => {
  const specText = 'Card-specific implementation specification\nwith a second line.';
  const digest = sha256(specText);
  const result = queueModeSpecInputs({ route: {}, attempt: { spec_digest: digest, specText },
    operatorBrief: 'Static operator brief', reviewSpec: 'Static review policy' });
  const block = `Task specification (verified spec_digest ${digest}):\n${specText}`;
  assert.equal(result.workerBrief, `Static operator brief\n\n${block}`);
  assert.equal(result.reviewSpec, `Static review policy\n\n${block}`);
  assert.equal(result.specText, specText);
});

test('queue mode fails closed when card text does not match spec_digest', () => {
  assert.throws(() => queueModeSpecInputs({ route: {},
      attempt: { spec_digest: sha256('trusted specification'), specText: 'tampered specification' },
      operatorBrief: 'Static operator brief', reviewSpec: 'Static review policy' }),
    /card_spec_digest_mismatch/);
});

test('single-card mode ignores card spec text and preserves static operator inputs', () => {
  const result = queueModeSpecInputs({ route: { taskId: '7' },
    attempt: { spec_digest: sha256('trusted specification'), specText: 'tampered specification' },
    operatorBrief: 'Static operator brief', reviewSpec: 'Static review policy' });
  assert.equal(result.workerBrief, 'Static operator brief');
  assert.equal(result.reviewSpec, 'Static review policy');
  assert.equal(result.specText, null);
});

test('legacy static-brief queue cards keep the existing unprefixed behavior', () => {
  const operatorBrief = 'Static operator brief';
  const result = queueModeSpecInputs({ route: {},
    attempt: { spec_digest: sha256(operatorBrief), specText: 'queue card text is not the pinned brief' },
    operatorBrief, reviewSpec: 'Static review policy' });
  assert.equal(result.workerBrief, operatorBrief);
  assert.equal(result.reviewSpec, 'Static review policy');
});

test('sealed pilot cards pinned to the review spec keep static inputs unchanged', () => {
  const operatorBrief = 'Static operator brief';
  const reviewSpec = 'Sealed A/B pilot review policy';
  const result = queueModeSpecInputs({ route: {},
    attempt: { spec_digest: sha256(reviewSpec), specText: 'Isolated #1448 policy' },
    operatorBrief, reviewSpec });
  assert.equal(result.workerBrief, operatorBrief);
  assert.equal(result.reviewSpec, reviewSpec);
  assert.equal(result.specText, null);
  assert.equal(result.block, null);

  assert.throws(() => queueModeSpecInputs({ route: {},
      attempt: { spec_digest: sha256('unrelated digest'), specText: 'Isolated #1448 policy' },
      operatorBrief, reviewSpec }),
    /card_spec_digest_mismatch/);
});

test('queue mode without card spec text preserves existing static behavior', () => {
  const result = queueModeSpecInputs({ route: {},
    attempt: { spec_digest: 'f'.repeat(64) },
    operatorBrief: 'Static operator brief', reviewSpec: 'Static review policy' });
  assert.equal(result.workerBrief, 'Static operator brief');
  assert.equal(result.reviewSpec, 'Static review policy');
});

test('allowedPathsFromLabels parses the card label and treats absence as unrestricted', () => {
  assert.equal(allowedPathsFromLabels({}), null);
  assert.equal(allowedPathsFromLabels(null), null);
  assert.deepEqual(allowedPathsFromLabels({ allowed_paths: 'board_pipeline/,ops/control-room/' }),
    ['board_pipeline/', 'ops/control-room/']);
  assert.throws(() => allowedPathsFromLabels({ allowed_paths: '../x' }), /scope_fence_path_invalid/);
  assert.throws(() => allowedPathsFromLabels({ allowed_paths: '' }), /scope_fence_path_invalid/);
  assert.throws(() => allowedPathsFromLabels({ allowed_paths: 42 }), /allowed_paths_invalid/);
});

test('allowedPathsFromAttempt prefers pinned attempt data over live labels', () => {
  assert.deepEqual(allowedPathsFromAttempt({ allowed_paths: 'a.mjs' }, { allowed_paths: 'b.mjs' }), ['a.mjs']);
  assert.deepEqual(allowedPathsFromAttempt({ labels: { allowed_paths: 'a.mjs,b/' } }, null), ['a.mjs', 'b/']);
  assert.deepEqual(allowedPathsFromAttempt({}, { allowed_paths: 'c.mjs' }), ['c.mjs']);
  assert.equal(allowedPathsFromAttempt({}, {}), null);
});

test('scopeFenceReworkResult is typed deterministic worker feedback', () => {
  const result = scopeFenceReworkResult(['outside.mjs'], ['board_pipeline/']);
  assert.equal(result.outcome, 'rework');
  assert.equal(result.reason, 'scope_fence_violation');
  assert.deepEqual(result.feedback.violations, ['outside.mjs']);
  assert.equal(result.feedback.findings[0].file, 'outside.mjs');
  assert.match(result.feedback.findings[0].expected, /board_pipeline\//);
  assert.deepEqual(result, scopeFenceReworkResult(['outside.mjs'], ['board_pipeline/']));
});

test('resolveWorkerRuntimeKind applies CLI, policy, env and default precedence fail-closed', () => {
  assert.equal(resolveWorkerRuntimeKind({}), 'bb');
  assert.equal(resolveWorkerRuntimeKind({ env: { DF_WORKER_RUNTIME: 'subproc' } }), 'subproc');
  assert.equal(resolveWorkerRuntimeKind({
    policy: { workerRuntime: 'hc' }, env: { DF_WORKER_RUNTIME: 'subproc' } }), 'hc');
  assert.equal(resolveWorkerRuntimeKind({
    cliRuntime: 'subproc', policy: { workerRuntime: 'hc' },
    env: { DF_WORKER_RUNTIME: 'bb' } }), 'subproc');
  assert.equal(resolveWorkerRuntimeKind({ cliRuntime: 'bb', policy: { workerRuntime: 'hc' } }), 'bb');
  for (const bad of ['pty', '', 'HC', 42, true, null]) {
    assert.throws(() => resolveWorkerRuntimeKind({ cliRuntime: bad }), /worker_runtime_kind_invalid/);
  }
  assert.throws(() => resolveWorkerRuntimeKind({ policy: { workerRuntime: 'pty' } }),
    /worker_runtime_kind_invalid/);
  assert.throws(() => resolveWorkerRuntimeKind({ env: { DF_WORKER_RUNTIME: 'pty' } }),
    /worker_runtime_kind_invalid/);
});

test('portable worker transport probes, spawns, sends feedback and reconciles without BB calls', async () => {
  for (const kind of ['hc', 'subproc']) {
    const runtimeCalls = [];
    const bbCalls = [];
    const runtimeId = deterministicRuntimeId(kind, '4051', 'attempt-1');
    const runtime = {
      async probeAvailability(spec) {
        runtimeCalls.push(['probe', spec]);
        return { status: 'available' };
      },
      async spawn(input) {
        runtimeCalls.push(['spawn', input]);
        return { runtimeId: input.runtimeId, transport: kind };
      },
      async feedback(input) {
        runtimeCalls.push(['feedback', input]);
        return { delivered: true };
      },
      async observe(input) {
        runtimeCalls.push(['observe', input]);
        return { state: kind === 'hc' ? 'exited' : 'working', exitCode: 0 };
      },
    };
    const bbTransport = {
      async spawn() { bbCalls.push('spawn'); },
      async feedback() { bbCalls.push('feedback'); },
      async reconcileSpawn() { bbCalls.push('reconcileSpawn'); },
      async reconcileFeedback() { bbCalls.push('reconcileFeedback'); },
      async inspectWorktree() { bbCalls.push('inspectWorktree'); return { clean: true, head: 'a'.repeat(40) }; },
    };
    const preparedPrompts = [];
    const preparedFeedback = [];
    const transport = buildWorkerTransport({ kind,
      policy: { bb: { provider: 'acp-devin', model: 'swe-2-1-medium' },
        route: { worktree: '/tmp/policy-worktree', repoId: 'repo-1' } },
      runtime, bbTransport, worktree: '/tmp/canonical-worktree',
      prepareSpawn: async ({ handoff }) => {
        preparedPrompts.push(workerIntakePrompt({ brief: 'brief', tree: '/tmp/canonical-worktree',
          handoffPath: '/private/state/submission.json', handoff }));
        return '/private/state/worker-prompt.md';
      },
      prepareFeedback: async packet => {
        preparedFeedback.push(packet.feedbackId);
        return { messageText: '- Fix line 10\n- Add test' };
      } });
    const fallbackSpec = { provider: 'acp-devin', model: 'swe-2-1-medium' };
    assert.deepEqual(await transport.probeAvailability(), { status: 'available' });
    assert.deepEqual(runtimeCalls[0], ['probe', fallbackSpec]);

    const attempt = { task_id: '4051', epoch: 1, attempt_id: 'attempt-1' };
    assert.deepEqual(await transport.spawn(attempt), { threadId: runtimeId });
    const spawnInput = runtimeCalls[1][1];
    assert.equal(spawnInput.runtimeId, runtimeId);
    assert.equal(spawnInput.taskId, '4051');
    assert.equal(spawnInput.attemptId, 'attempt-1');
    assert.equal(spawnInput.worktree, '/tmp/canonical-worktree');
    assert.equal(spawnInput.promptFile, '/private/state/worker-prompt.md');
    assert.deepEqual(spawnInput.executor, fallbackSpec);
    assert.equal(spawnInput.spaceLabel, 'repo-1');
    assert.equal(spawnInput.tabLabel, 'DF #4051');
    assert.equal(preparedPrompts.length, 1);
    assert.match(preparedPrompts[0], new RegExp(`"worker_thread_id":"${runtimeId}"`));

    const packet = { attempt: { ...attempt, bb_thread_id: runtimeId }, feedbackId: 'fb-1' };
    assert.deepEqual(await transport.feedback(packet), { confirmed: true });
    assert.deepEqual(runtimeCalls[2], ['feedback', { runtimeId, message: '- Fix line 10\n- Add test' }]);
    assert.deepEqual(preparedFeedback, ['fb-1']);

    assert.deepEqual(await transport.reconcileSpawn(attempt), { status: 'found', threadId: runtimeId });
    assert.deepEqual(await transport.reconcileFeedback({ attempt }), { status: 'empty' });
    assert.deepEqual(bbCalls, []);
  }
});

test('portable observeTurn uses the runtime turn watermark and fails closed while active', async () => {
  const observations = [
    { state: 'working', turn: 0 },
    { state: 'idle', turn: 1 },
    { state: 'idle', turn: 1 },
    { state: 'done', turn: 2 },
  ];
  const runtime = {
    probeAvailability: async () => ({ status: 'available' }),
    spawn: async input => ({ runtimeId: input.runtimeId }),
    feedback: async () => ({ delivered: true }),
    observe: async () => observations.shift() ?? { state: 'done', turn: 2 },
  };
  const transport = buildWorkerTransport({ kind: 'hc',
    policy: { bb: { provider: 'acp-devin', model: 'swe-2-1-medium' }, route: {} },
    runtime, bbTransport: {}, prepareSpawn: async () => '/tmp/prompt',
    prepareFeedback: async () => 'rework' });
  const runtimeId = deterministicRuntimeId('hc', '4051', 'attempt-observe');
  assert.equal(await transport.observeTurn({ runtimeId, after: 0 }), undefined);
  assert.deepEqual(await transport.observeTurn({ runtimeId, after: 0 }),
    { turnSeq: 1, completed: true, state: 'idle' });
  assert.equal(await transport.observeTurn({ runtimeId, after: 1 }), undefined);
  assert.deepEqual(await transport.observeTurn({ runtimeId, after: 1 }),
    { turnSeq: 2, completed: true, state: 'done' });
});

test('portable reconcileSpawn is empty for missing or exited subproc sessions', async () => {
  const runtime = {
    probeAvailability: async () => ({ status: 'available' }),
    spawn: async input => ({ runtimeId: input.runtimeId }),
    feedback: async () => ({ delivered: true }),
    observe: async () => ({ state: 'exited', exitCode: 1 }),
  };
  const transport = buildWorkerTransport({ kind: 'subproc',
    policy: { bb: { provider: 'acp-devin', model: 'swe-2-1-medium' }, route: {} },
    runtime, bbTransport: {}, prepareSpawn: async () => '/tmp/prompt',
    prepareFeedback: async () => 'rework' });
  assert.deepEqual(await transport.reconcileSpawn({ task_id: '1', attempt_id: 'a' }), { status: 'empty' });
});

test('bb kind preserves the legacy transport object', () => {
  const legacy = { marker: true };
  assert.equal(buildWorkerTransport({ kind: 'bb', bbTransport: legacy }), legacy);
});
