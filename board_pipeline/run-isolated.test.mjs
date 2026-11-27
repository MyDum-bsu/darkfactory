import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { adaptiveLocalPlanCore, allowedPathsFromAttempt, allowedPathsFromLabels, ancestorOrNull,
  baseWorkerFromPolicy, buildWorkerTransport, candidatePinRef, filterAdaptiveTelemetry,
  HARDENED_GIT_CONFIG, hardenedGitEnv, isApprovedWorker, planAdaptiveChecks,
  queueModeSpecInputs, readSubmissionEnvelope, resetQueueWorktree, resolveWorkerRuntimeKind,
  scopeFenceReworkResult, shouldStopWorkerOnShutdown } from './run-isolated.mjs';
import { deterministicRuntimeId } from './worker-runtime.mjs';
import { DEFAULT_ARBITER, DEFAULT_CRITIC, PRIMARY_WORKER, resolveTriad } from './worker-selector.mjs';
import { arbiterIntakePrompt, workerIntakePrompt } from './intake-prompt.mjs';

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

test('resolveWorkerRuntimeKind applies CLI, policy, env and hc default precedence fail-closed', () => {
  // Финальный дефолт — hc; bb остаётся только явным opt-in на любом уровне.
  assert.equal(resolveWorkerRuntimeKind({}), 'hc');
  assert.equal(resolveWorkerRuntimeKind({ env: {} }), 'hc');
  assert.equal(resolveWorkerRuntimeKind({ policy: {} }), 'hc');
  assert.equal(resolveWorkerRuntimeKind({ env: { DF_WORKER_RUNTIME: 'bb' } }), 'bb');
  assert.equal(resolveWorkerRuntimeKind({ policy: { workerRuntime: 'bb' } }), 'bb');
  assert.equal(resolveWorkerRuntimeKind({ cliRuntime: 'bb' }), 'bb');
  assert.equal(resolveWorkerRuntimeKind({ env: { DF_WORKER_RUNTIME: 'subproc' } }), 'subproc');
  assert.equal(resolveWorkerRuntimeKind({
    policy: { workerRuntime: 'hc' }, env: { DF_WORKER_RUNTIME: 'subproc' } }), 'hc');
  assert.equal(resolveWorkerRuntimeKind({
    cliRuntime: 'subproc', policy: { workerRuntime: 'hc' },
    env: { DF_WORKER_RUNTIME: 'bb' } }), 'subproc');
  assert.equal(resolveWorkerRuntimeKind({ cliRuntime: 'bb', policy: { workerRuntime: 'hc' } }), 'bb');
  assert.equal(resolveWorkerRuntimeKind({ cliRuntime: 'hc', policy: { workerRuntime: 'bb' } }), 'hc');
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

test('planAdaptiveChecks disabled default passes every check through synchronously unchanged', () => {
  const checks = [{ id: 'unit' }, { id: 'e2e' }];
  for (const profile of [
    { checks },
    { checks, adaptiveGates: { enabled: false } },
    { checks, adaptiveGates: {} },
    {},
    null,
    undefined,
  ]) {
    const plan = planAdaptiveChecks({ profile });
    assert.equal(plan.enabled, false);
    assert.equal(plan.mode, 'strict_sync');
    assert.equal(plan.reason, 'disabled');
    assert.equal(plan.syncChecks, Array.isArray(profile?.checks) ? profile.checks : plan.syncChecks);
    assert.deepEqual(plan.syncChecks, Array.isArray(profile?.checks) ? profile.checks : []);
    assert.deepEqual(plan.asyncChecks, []);
    assert.equal(plan.decision, null);
  }
  // Extraordinary inputs never throw and stay disabled pass-throughs.
  for (const input of [undefined, null, {}, { profile: 'bad' }, { profile: { checks: 'bad' } }]) {
    const plan = planAdaptiveChecks(input ?? undefined);
    assert.equal(plan.enabled, false);
    assert.equal(plan.mode, 'strict_sync');
    assert.equal(plan.reason, 'disabled');
    assert.deepEqual(plan.syncChecks, []);
    assert.deepEqual(plan.asyncChecks, []);
    assert.equal(plan.decision, null);
  }
});

test('planAdaptiveChecks enabled splits fast synchronous and heavy reversible asynchronous checks', () => {
  const checks = [
    { id: 'lint', kind: 'fast', reversible: true },
    { id: 'e2e-heavy', kind: 'heavy', reversible: true },
  ];
  for (const [profile, extra] of [
    [{ adaptiveGates: { enabled: true }, checks }, {}],
    [{ checks }, { thresholds: { enabled: true } }],
  ]) {
    const plan = planAdaptiveChecks({
      profile,
      telemetryStats: { lint: { medianMs: 5_000 }, 'e2e-heavy': { medianMs: 300_000 } },
      ...extra,
    });
    assert.equal(plan.enabled, true);
    assert.equal(plan.mode, 'optimistic_async');
    assert.equal(plan.reason, 'adaptive_duration');
    assert.deepEqual(plan.syncChecks.map(check => check.id), ['lint']);
    assert.deepEqual(plan.asyncChecks.map(check => check.id), ['e2e-heavy']);
    assert.equal(plan.asyncChecks[0].autoRollbackOnFail, true);
    assert.ok(plan.decision);
    assert.equal(plan.decision.mode, 'optimistic_async');
  }
});

test('planAdaptiveChecks keeps formal checks pinned synchronous even when slow and reversible', () => {
  const plan = planAdaptiveChecks({
    profile: { adaptiveGates: { enabled: true }, checks: [
      { id: 'proof', kind: 'formal', reversible: true },
      { id: 'heavy', kind: 'heavy', reversible: true },
    ] },
    telemetryStats: { proof: 300_000, heavy: 300_000 },
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.mode, 'optimistic_async');
  assert.deepEqual(plan.syncChecks.map(check => check.id), ['proof']);
  assert.deepEqual(plan.asyncChecks.map(check => check.id), ['heavy']);
  assert.equal(plan.decision.decisions.find(decision => decision.id === 'proof').reason, 'formal_override');
});

test('planAdaptiveChecks escalates high-risk diff paths to strict synchronous mode', () => {
  const plan = planAdaptiveChecks({
    profile: { adaptiveGates: { enabled: true }, checks: [
      { id: 'heavy', kind: 'heavy', reversible: true },
    ] },
    diffPaths: ['migrations/0001_init.sql'],
    telemetryStats: { heavy: 300_000 },
    thresholds: { highRiskPaths: ['migrations/'] },
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.mode, 'strict_sync');
  assert.equal(plan.reason, 'high_risk_path');
  assert.equal(plan.syncChecks.length, 1);
  assert.deepEqual(plan.asyncChecks, []);
});

test('planAdaptiveChecks forces strict sync when the rollback circuit breaker trips above ten percent', () => {
  const tripped = planAdaptiveChecks({
    profile: { adaptiveGates: { enabled: true }, checks: [
      { id: 'heavy', kind: 'heavy', reversible: true },
    ] },
    telemetryStats: { heavy: 300_000 },
    recentRollbacks: { totalRuns: 20, rollbacks: 3 },
  });
  assert.equal(tripped.enabled, true);
  assert.equal(tripped.mode, 'strict_sync');
  assert.equal(tripped.reason, 'rollback_circuit_breaker');
  assert.deepEqual(tripped.asyncChecks, []);
  assert.equal(tripped.decision.circuitBreaker.open, true);

  // Boundary: exactly ten percent is not a trip. A fast check stays
  // synchronous so the empty-sync fallback does not mask the split.
  const boundary = planAdaptiveChecks({
    profile: { adaptiveGates: { enabled: true }, checks: [
      { id: 'lint', kind: 'fast', reversible: true },
      { id: 'heavy', kind: 'heavy', reversible: true },
    ] },
    telemetryStats: { lint: 5_000, heavy: 300_000 },
    recentRollbacks: { totalRuns: 20, rollbacks: 2 },
  });
  assert.equal(boundary.mode, 'optimistic_async');
  assert.deepEqual(boundary.syncChecks.map(check => check.id), ['lint']);
  assert.equal(boundary.asyncChecks.length, 1);
});

test('planAdaptiveChecks fails closed to strict sync of every check when the sync set would be empty', () => {
  const checks = [
    { id: 'heavy-a', kind: 'heavy', reversible: true },
    { id: 'heavy-b', kind: 'heavy', reversible: true },
  ];
  const plan = planAdaptiveChecks({
    profile: { adaptiveGates: { enabled: true }, checks },
    telemetryStats: { 'heavy-a': 300_000, 'heavy-b': 300_000 },
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.mode, 'strict_sync');
  assert.equal(plan.reason, 'empty_sync_fallback');
  assert.equal(plan.syncChecks, checks);
  assert.deepEqual(plan.asyncChecks, []);
});

test('planAdaptiveChecks is deterministic across repeated invocation', () => {
  const input = {
    profile: { adaptiveGates: { enabled: true }, checks: [
      { id: 'lint', kind: 'fast', reversible: true },
      { id: 'heavy', kind: 'heavy', reversible: true },
    ] },
    diffPaths: ['src/index.ts'],
    telemetryStats: { lint: 5_000, heavy: 300_000 },
    recentRollbacks: [],
  };
  const first = planAdaptiveChecks(input);
  const second = planAdaptiveChecks(input);
  assert.deepEqual(second, first);
});

test('portable worker transport prefers herdrSpaceId over repoId and falls back when absent', async () => {
  for (const [route, expected] of [
    [{ repoId: 'repo-1', herdrSpaceId: 'sp-native-9' }, 'sp-native-9'],
    [{ repoId: 'repo-1' }, 'repo-1'],
    [{ herdrSpaceId: 'sp-native-7' }, 'sp-native-7'],
    [{}, undefined],
  ]) {
    const runtime = {
      probeAvailability: async () => ({ status: 'available' }),
      spawn: async input => ({ runtimeId: input.runtimeId, spaceLabel: input.spaceLabel }),
      feedback: async () => ({ delivered: true }),
      observe: async () => ({ state: 'working' }),
    };
    let spawnInput;
    const capturingRuntime = { ...runtime,
      async spawn(input) { spawnInput = input; return runtime.spawn(input); } };
    const transport = buildWorkerTransport({ kind: 'hc',
      policy: { bb: { provider: 'acp-devin', model: 'swe-2-1-medium' }, route },
      runtime: capturingRuntime, bbTransport: {},
      prepareSpawn: async () => '/tmp/prompt', prepareFeedback: async () => 'rework' });
    const attempt = { task_id: '4525', epoch: 2, attempt_id: 'attempt-space' };
    assert.deepEqual(await transport.spawn(attempt),
      { threadId: deterministicRuntimeId('hc', '4525', 'attempt-space') });
    assert.equal(spawnInput.spaceLabel, expected);
  }
});

test('baseWorkerFromPolicy honors an operator-configured Devin worker and reasoningLevel', () => {
  const policy = { bb: { provider: 'acp-devin', model: 'swe-2-1-max', reasoningLevel: 'high' } };
  assert.deepEqual(baseWorkerFromPolicy(policy),
    { provider: 'acp-devin', model: 'swe-2-1-max', reasoningLevel: 'high' });
});

test('baseWorkerFromPolicy honors an operator-configured pi opencode-go worker', () => {
  const policy = { bb: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' } };
  assert.deepEqual(baseWorkerFromPolicy(policy),
    { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' });
});

test('baseWorkerFromPolicy falls back to PRIMARY_WORKER for missing, incomplete or blank policy.bb', () => {
  for (const policy of [
    undefined,
    null,
    {},
    { bb: undefined },
    { bb: null },
    { bb: {} },
    { bb: { provider: 'acp-devin' } },
    { bb: { model: 'swe-2-1-max' } },
    { bb: { provider: '   ', model: 'swe-2-1-max' } },
    { bb: { provider: 'acp-devin', model: '' } },
    { bb: { provider: 7, model: 'swe-2-1-max' } },
    { bb: { provider: 'acp-devin', model: null } },
  ]) {
    assert.equal(baseWorkerFromPolicy(policy), PRIMARY_WORKER);
  }
});

test('baseWorkerFromPolicy omits empty reasoningLevel but preserves a non-empty value unchanged', () => {
  assert.deepEqual(baseWorkerFromPolicy({ bb: {
    provider: 'acp-devin', model: 'swe-2-1-max', reasoningLevel: '' } }),
    { provider: 'acp-devin', model: 'swe-2-1-max' });
  assert.deepEqual(baseWorkerFromPolicy({ bb: {
    provider: 'acp-devin', model: 'swe-2-1-max', reasoningLevel: 'xhigh' } }),
    { provider: 'acp-devin', model: 'swe-2-1-max', reasoningLevel: 'xhigh' });
});

test('resolveTriad uses baseWorkerFromPolicy as the first worker plan entry', () => {
  for (const bb of [
    { provider: 'acp-devin', model: 'swe-2-1-max' },
    { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
  ]) {
    const policy = { bb };
    const baseWorker = baseWorkerFromPolicy(policy);
    const routed = resolveTriad({ policy,
      base: { worker: baseWorker, critic: DEFAULT_CRITIC, arbiter: DEFAULT_ARBITER } });
    assert.equal(routed.outcome, 'shadow');
    assert.deepEqual(routed.plan[0], baseWorker);
    assert.deepEqual(routed.selected.worker, baseWorker);
  }
});

test('package.json test script executes all five formerly orphaned V2 suites', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const file of [
    'board_pipeline/ab-pilot.test.mjs',
    'board_pipeline/adaptive-gates.test.mjs',
    'board_pipeline/model-prompt-profiles.test.mjs',
    'board_pipeline/scope-fence.test.mjs',
    'board_pipeline/worker-runtime.test.mjs',
  ]) {
    assert.ok(pkg.scripts.test.split(' ').includes(file), `${file} missing from npm test`);
  }
});

// --- AUDIT-0b: fail-closed adaptive gates в adaptiveLocalPlanCore ---

const adaptiveTrusted = (over = {}) => ({
  adaptiveGates: { enabled: true,
    telemetryStats: { lint: 5_000, 'e2e-heavy': 300_000 }, ...over.gates },
  checks: [
    { id: 'lint', kind: 'fast', reversible: true },
    { id: 'e2e-heavy', kind: 'heavy', reversible: true },
  ],
  ...over.rest,
});

function adaptiveInputs(over = {}) {
  const notes = [];
  return { notes,
    options: {
      trusted: adaptiveTrusted(),
      readDiffPaths: async () => ['src/index.ts'],
      readTelemetryEntries: async () => [],
      repoId: 'repo-1',
      identity: { task_id: '5401', attempt_id: 'att-1', epoch: 1 },
      emit: note => notes.push(note),
      ...over,
    } };
}

test('adaptiveLocalPlanCore fails closed to strict_sync when async checks would be deferred', async () => {
  const { options, notes } = adaptiveInputs();
  const result = await adaptiveLocalPlanCore(options);
  assert.notEqual(result, null);
  // Планировщик хотел отложить e2e-heavy (optimistic_async), но async post-L1
  // раннера нет — весь профиль исполняется синхронно.
  assert.equal(result.plan.mode, 'strict_sync');
  assert.equal(result.plan.reason, 'async_runner_unavailable');
  assert.deepEqual(result.plan.syncChecks, adaptiveTrusted().checks);
  assert.deepEqual(result.plan.asyncChecks, []);
  assert.equal(result.metadata.failClosed, 'async_runner_unavailable');
  assert.equal(result.metadata.plannerMode, 'optimistic_async');
  assert.deepEqual(result.metadata.deferredAsyncChecks, ['e2e-heavy']);
  // Fail-closed решение журналируется событием adaptive_gate_decision.
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'adaptive_gate_decision');
  assert.equal(notes[0].mode, 'strict_sync');
  assert.equal(notes[0].reason, 'async_runner_unavailable');
  assert.equal(notes[0].detail.failClosed, 'async_runner_unavailable');
  assert.equal(notes[0].detail.plannerMode, 'optimistic_async');
  assert.equal(notes[0].task_id, '5401');
  // Повторный вызов детерминирован.
  const again = await adaptiveLocalPlanCore({ ...options, emit: null });
  assert.deepEqual(again.plan, result.plan);
});

test('adaptiveLocalPlanCore fails closed on diff read error and never plans on empty inputs', async () => {
  let telemetryRead = false;
  const { options } = adaptiveInputs({
    readDiffPaths: async () => { throw new Error('git diff exploded'); },
    readTelemetryEntries: async () => { telemetryRead = true; return []; },
  });
  const result = await adaptiveLocalPlanCore(options);
  assert.equal(result.plan.mode, 'strict_sync');
  assert.equal(result.plan.reason, 'adaptive_input_error');
  assert.deepEqual(result.plan.syncChecks, adaptiveTrusted().checks);
  assert.deepEqual(result.plan.asyncChecks, []);
  assert.equal(result.metadata.failClosed, 'adaptive_input_error');
  assert.equal(telemetryRead, false, 'после сбоя diff телеметрия не читается — план уже fail-closed');
});

test('adaptiveLocalPlanCore fails closed on telemetry read error', async () => {
  const { options, notes } = adaptiveInputs({
    readTelemetryEntries: async () => { throw new Error('telemetry unreadable'); },
  });
  const result = await adaptiveLocalPlanCore(options);
  assert.equal(result.plan.mode, 'strict_sync');
  assert.equal(result.plan.reason, 'adaptive_input_error');
  assert.deepEqual(result.plan.syncChecks, adaptiveTrusted().checks);
  assert.deepEqual(result.plan.asyncChecks, []);
  assert.equal(notes[0].reason, 'adaptive_input_error');
});

test('adaptiveLocalPlanCore forwards highRiskPaths even when gates.thresholds is set', async () => {
  for (const key of ['highRiskPaths', 'high_risk_paths']) {
    const trusted = {
      adaptiveGates: { enabled: true,
        thresholds: { fastMaxMs: 90_000 },
        [key]: ['migrations/'],
        telemetryStats: { heavy: 300_000 } },
      checks: [{ id: 'heavy', kind: 'heavy', reversible: true }],
    };
    const { options } = adaptiveInputs({
      trusted,
      readDiffPaths: async () => ['migrations/0001_init.sql'],
    });
    const result = await adaptiveLocalPlanCore(options);
    assert.equal(result.plan.mode, 'strict_sync', key);
    assert.equal(result.plan.reason, 'high_risk_path', key);
    assert.deepEqual(result.plan.syncChecks, trusted.checks);
    // Планировщик сам видит high-risk совпадение — не fail-closed откат async.
    assert.equal(result.metadata.failClosed, undefined, key);
  }
});

test('adaptiveLocalPlanCore filters open and other-repo telemetry rows before the circuit breaker', async () => {
  const rollbacks = count => Array.from({ length: count }, () => ({ rollback: true, open: false, repo_id: 'repo-1' }));
  // 6 закрытых rollback-записей того же repo_id — breaker trips: strict_sync по
  // rollback_circuit_breaker, а не по async_runner_unavailable.
  const tripped = await adaptiveLocalPlanCore(adaptiveInputs({
    readTelemetryEntries: async () => rollbacks(6) }).options);
  assert.equal(tripped.plan.mode, 'strict_sync');
  assert.equal(tripped.plan.reason, 'rollback_circuit_breaker');
  // Те же записи, но открытые или чужого repo_id, отфильтровываются: breaker
  // не срабатывает, планировщик доходит до optimistic-планирования (которое
  // fail-closed откатывается уже по async_runner_unavailable).
  const filtered = await adaptiveLocalPlanCore(adaptiveInputs({
    readTelemetryEntries: async () => [
      ...rollbacks(6).map(entry => ({ ...entry, open: true })),
      ...rollbacks(6).map(entry => ({ ...entry, repo_id: 'repo-2' })),
    ] }).options);
  assert.equal(filtered.plan.mode, 'strict_sync');
  assert.equal(filtered.plan.reason, 'async_runner_unavailable');
  assert.equal(filtered.metadata.plannerMode, 'optimistic_async');
});

test('filterAdaptiveTelemetry keeps closed entries of the same repo and unattributed rows', () => {
  const entries = [
    { open: true, rollback: true, repo_id: 'repo-1' },
    { open: false, rollback: true, repo_id: 'repo-1' },
    { rollback: true, repo_id: 'repo-2' },
    { rollback: true },
    { open: false, repo_id: 'repo-1' },
    null,
  ];
  const filtered = filterAdaptiveTelemetry(entries, 'repo-1');
  assert.deepEqual(filtered, [entries[1], entries[3], entries[4], entries[5]]);
  assert.deepEqual(filterAdaptiveTelemetry([], 'repo-1'), []);
  assert.deepEqual(filterAdaptiveTelemetry(null, 'repo-1'), []);
  assert.deepEqual(filterAdaptiveTelemetry(undefined, undefined), []);
});

test('adaptiveLocalPlanCore returns null when adaptive gates are not enabled', async () => {
  for (const trusted of [
    {},
    { checks: [] },
    { adaptiveGates: { enabled: false }, checks: [] },
    { adaptiveGates: {}, checks: [] },
  ]) {
    const result = await adaptiveLocalPlanCore(adaptiveInputs({ trusted }).options);
    assert.equal(result, null);
  }
});

test('planAdaptiveChecks forwards explicit highRiskPaths alongside thresholds', () => {
  const plan = planAdaptiveChecks({
    profile: { adaptiveGates: { enabled: true }, checks: [
      { id: 'heavy', kind: 'heavy', reversible: true },
    ] },
    diffPaths: ['migrations/0001_init.sql'],
    telemetryStats: { heavy: 300_000 },
    thresholds: { enabled: true },
    highRiskPaths: ['migrations/'],
  });
  assert.equal(plan.mode, 'strict_sync');
  assert.equal(plan.reason, 'high_risk_path');
  assert.deepEqual(plan.asyncChecks, []);
});

test('portable worker transport forwards permissionMode and exposes stop, resume and hc reconcileFeedback', async () => {
  const calls = [];
  const runtimeId = deterministicRuntimeId('hc', '6242', 'attempt-transport');
  let observed = { state: 'working', turn: 2, tail: 'worker output' };
  const runtime = {
    probeAvailability: async () => ({ status: 'available' }),
    spawn: async input => {
      calls.push(['spawn', input]);
      return { runtimeId: input.runtimeId };
    },
    resume: async input => {
      calls.push(['resume', input]);
      return { runtimeId: input.runtimeId };
    },
    stop: async input => {
      calls.push(['stop', input]);
      return { stopped: true };
    },
    feedback: async input => {
      calls.push(['feedback', input]);
      return { delivered: true };
    },
    observe: async () => observed,
  };
  const transport = buildWorkerTransport({ kind: 'hc', permissionMode: 'full',
    policy: { bb: { provider: 'acp-devin', model: 'swe-2-1-medium' }, route: { repoId: 'repo-1' } },
    runtime, bbTransport: {}, worktree: '/tmp/worktree',
    prepareSpawn: async () => '/private/worker-prompt.md', prepareFeedback: async () => 'rework' });
  const attempt = { task_id: '6242', epoch: 1, attempt_id: 'attempt-transport' };
  assert.deepEqual(await transport.spawn(attempt), { threadId: runtimeId });
  assert.equal(calls[0][1].permissionMode, 'full');
  const resume = await transport.resume({ attempt: { ...attempt, bb_thread_id: runtimeId },
    reason: 'worker_crashed' });
  assert.deepEqual(resume, { resumed: true, threadId: runtimeId });
  assert.equal(calls[1][1].permissionMode, 'full');
  assert.deepEqual(await transport.stop(runtimeId), { stopped: true });
  assert.deepEqual(calls[2], ['stop', { runtimeId }]);

  observed = { state: 'working', turn: 2, tail: 'Замечание фабрики fb-7. Исправь найденное.' };
  assert.deepEqual(await transport.reconcileFeedback({ attempt, feedbackId: 'fb-7', afterSeq: 1 }),
    { status: 'delivered', threadId: runtimeId, turn: 2 });
  observed = { state: 'working', turn: 2, tail: 'no factory marker here' };
  assert.deepEqual(await transport.reconcileFeedback({ attempt, feedbackId: 'fb-7', afterSeq: 2 }),
    { status: 'empty' });
});

test('portable observeTurn does not reuse stale idle after feedback without a new active turn', async () => {
  const sequence = [
    { state: 'idle' },
    { state: 'idle' },
    { state: 'working' },
    { state: 'idle' },
  ];
  const runtime = {
    probeAvailability: async () => ({ status: 'available' }),
    spawn: async input => ({ runtimeId: input.runtimeId }),
    feedback: async () => ({ delivered: true }),
    observe: async () => sequence.shift() ?? { state: 'idle' },
  };
  const transport = buildWorkerTransport({ kind: 'hc',
    policy: { bb: { provider: 'acp-devin', model: 'swe-2-1-medium' }, route: {} },
    runtime, bbTransport: {}, prepareSpawn: async () => '/tmp/prompt', prepareFeedback: async () => 'rework' });
  const attempt = { task_id: '6242', epoch: 1, attempt_id: 'attempt-race' };
  const runtimeId = deterministicRuntimeId('hc', attempt.task_id, attempt.attempt_id);
  await transport.spawn(attempt);
  assert.deepEqual(await transport.observeTurn({ runtimeId, after: 0 }),
    { turnSeq: 1, completed: true, state: 'idle' });
  await transport.feedback({ attempt: { ...attempt, bb_thread_id: runtimeId }, feedbackId: 'fb-race' });
  assert.equal(await transport.observeTurn({ runtimeId, after: 1 }), undefined);
  assert.equal(await transport.observeTurn({ runtimeId, after: 1 }), undefined);
  assert.deepEqual(await transport.observeTurn({ runtimeId, after: 1 }),
    { turnSeq: 2, completed: true, state: 'idle' });

  const restartedSequence = [{ state: 'working' }, { state: 'idle' }];
  const restartedRuntime = {
    probeAvailability: async () => ({ status: 'available' }),
    spawn: async input => ({ runtimeId: input.runtimeId }),
    feedback: async () => ({ delivered: true }),
    observe: async () => restartedSequence.shift() ?? { state: 'idle' },
  };
  const restarted = buildWorkerTransport({ kind: 'hc',
    policy: { bb: { provider: 'acp-devin', model: 'swe-2-1-medium' }, route: {} },
    runtime: restartedRuntime, bbTransport: {}, prepareSpawn: async () => '/tmp/prompt',
    prepareFeedback: async () => 'rework' });
  const restartId = deterministicRuntimeId('hc', '6242', 'attempt-restart');
  assert.equal(await restarted.observeTurn({ runtimeId: restartId, after: 1 }), undefined);
  assert.deepEqual(await restarted.observeTurn({ runtimeId: restartId, after: 1 }),
    { turnSeq: 2, completed: true, state: 'idle' });
});

test('readSubmissionEnvelope returns typed invalid handoffs for malformed, oversized and symlink files', async () => {
  const observed = { turnSeq: 4, completed: true, state: 'idle' };
  const source = '/private/inbox/attempt/submission.json';
  const fakeFd = ({ size = 32, file = true, content = JSON.stringify({ candidate_sha: 'c'.repeat(40) }),
    closeError } = {}) => {
    const closed = [];
    return { closed, calls: [],
      async stat() { return { isFile: () => file, size }; },
      async read(buffer, offset, length, position) {
        const payload = Buffer.from(content, 'utf8');
        const slice = payload.subarray(position, position + length);
        slice.copy(buffer, offset);
        return { bytesRead: slice.length };
      },
      async close() { closed.push(true); if (closeError) throw closeError; } };
  };
  const deps = (overrides = {}, fdOverrides = {}) => ({
    observed,
    source,
    realpathImpl: async () => source,
    openImpl: async () => fakeFd(fdOverrides),
    ...overrides,
  });
  const malformed = await readSubmissionEnvelope(deps({}, { content: '{bad json' }));
  assert.equal(malformed.turnSeq, 4);
  assert.equal(malformed.submission, null);
  const oversized = await readSubmissionEnvelope(deps({}, { size: 8193 }));
  assert.equal(oversized.submission, null);
  const notFile = await readSubmissionEnvelope(deps({}, { file: false }));
  assert.equal(notFile.submission, null);
  const symlink = await readSubmissionEnvelope(deps({
    realpathImpl: async () => '/outside/submission.json',
  }));
  assert.equal(symlink.submission, null);
  const missing = await readSubmissionEnvelope(deps({
    openImpl: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  }));
  assert.equal(Object.hasOwn(missing, 'submission'), false);
  const valid = await readSubmissionEnvelope(deps());
  assert.deepEqual(valid.submission, { candidate_sha: 'c'.repeat(40) });
});

test('readSubmissionEnvelope reads the handoff from one opened descriptor with a bounded read', async () => {
  const observed = { turnSeq: 2, completed: true, state: 'idle' };
  const source = '/private/inbox/attempt/submission.json';
  // Файл вырос между fstat и чтением: ограниченное чтение отсекает лишнее —
  // typed invalid, а не разбор подменённого содержимого.
  const grown = {
    async stat() { return { isFile: () => true, size: 32 }; },
    async read(buffer, offset, length) {
      const payload = Buffer.alloc(8193, 97);
      payload.copy(buffer, offset, 0, length);
      return { bytesRead: Math.min(length, payload.length) };
    },
    async close() {},
  };
  const raced = await readSubmissionEnvelope({ observed, source,
    realpathImpl: async () => source, openImpl: async () => grown });
  assert.equal(raced.submission, null);
  // Граница ровно 8192 байт содержимого читается и разбирается честно.
  const exactObject = { candidate_sha: 'c'.repeat(40),
    pad: 'x'.repeat(8192 - JSON.stringify({ candidate_sha: 'c'.repeat(40), pad: '' }).length) };
  const exactPayload = JSON.stringify(exactObject);
  assert.equal(Buffer.byteLength(exactPayload, 'utf8'), 8192);
  const exact = {
    async stat() { return { isFile: () => true, size: exactPayload.length }; },
    async read(buffer, offset, length, position) {
      const payload = Buffer.from(exactPayload, 'utf8');
      const slice = payload.subarray(position, position + length);
      slice.copy(buffer, offset);
      return { bytesRead: slice.length };
    },
    async close() {},
  };
  const atLimit = await readSubmissionEnvelope({ observed, source,
    realpathImpl: async () => source, openImpl: async () => exact });
  assert.equal(atLimit.submission.candidate_sha, 'c'.repeat(40));
  // O_NOFOLLOW отклоняет симлинк финального компонента: open падает с ELOOP.
  const eloop = await readSubmissionEnvelope({ observed, source,
    realpathImpl: async () => source,
    openImpl: async () => { const error = new Error('too many symlinks'); error.code = 'ELOOP'; throw error; } });
  assert.equal(eloop.submission, null);
  // Без завершённого хода конверт не читается вовсе.
  let opened = 0;
  const incomplete = await readSubmissionEnvelope({ observed: { turnSeq: 2, completed: false }, source,
    realpathImpl: async () => source, openImpl: async () => { opened++; return exact; } });
  assert.equal(opened, 0);
  assert.equal(Object.hasOwn(incomplete, 'submission'), false);
});

// Astra #11 (P1): hc-наблюдение без счётчика хода — повторное чтение того же
// подтверждённого хода (reread checkpoint вопроса владельца с after = turnSeq - 1)
// идемпотентно и не проваливается в owner_question_checkpoint_unconfirmed.
test('portable observeTurn rereads the same completed turn idempotently when hc omits the turn counter', async () => {
  const runtime = {
    probeAvailability: async () => ({ status: 'available' }),
    spawn: async input => ({ runtimeId: input.runtimeId }),
    feedback: async () => ({ delivered: true }),
    observe: async () => ({ state: 'idle' }), // счётчик хода опущен, как в hc без turn
  };
  const transport = buildWorkerTransport({ kind: 'hc',
    policy: { bb: { provider: 'acp-devin', model: 'swe-2-1-medium' }, route: {} },
    runtime, bbTransport: {}, prepareSpawn: async () => '/tmp/prompt', prepareFeedback: async () => 'rework' });
  const attempt = { task_id: '6242', epoch: 1, attempt_id: 'attempt-reread' };
  const runtimeId = deterministicRuntimeId('hc', attempt.task_id, attempt.attempt_id);
  await transport.spawn(attempt);
  // Ход 1 подтверждён с watermark after=0 (seenActive от spawn пропускает гейт).
  const first = await transport.observeTurn({ runtimeId, after: 0 });
  assert.deepEqual(first, { turnSeq: 1, completed: true, state: 'idle' });
  // Немедленный reread checkpoint с after = turnSeq - 1 = 0: тот же результат,
  // а не undefined — capture вопроса владельца подтверждается.
  assert.deepEqual(await transport.observeTurn({ runtimeId, after: 0 }), first);
  assert.deepEqual(await transport.observeTurn({ runtimeId, after: 0 }), first);
  // Чужой watermark не подтверждается memo: ход 2 без свежей активности не считается.
  assert.equal(await transport.observeTurn({ runtimeId, after: 1 }), undefined);
});

test('portable observeTurn rereads a post-feedback turn for the checkpoint after turn 1', async () => {
  let working = true;
  const runtime = {
    probeAvailability: async () => ({ status: 'available' }),
    spawn: async input => ({ runtimeId: input.runtimeId }),
    feedback: async () => ({ delivered: true, started: true }),
    observe: async () => working ? { state: 'working' } : { state: 'idle' },
  };
  const transport = buildWorkerTransport({ kind: 'hc',
    policy: { bb: { provider: 'acp-devin', model: 'swe-2-1-medium' }, route: {} },
    runtime, bbTransport: {}, prepareSpawn: async () => '/tmp/prompt', prepareFeedback: async () => 'rework' });
  const attempt = { task_id: '6242', epoch: 1, attempt_id: 'attempt-turn2-reread' };
  const runtimeId = deterministicRuntimeId('hc', attempt.task_id, attempt.attempt_id);
  await transport.spawn(attempt);
  // Ход 1 подтверждён; feedback переводит watermark на 1, воркер активен.
  working = false;
  assert.deepEqual(await transport.observeTurn({ runtimeId, after: 0 }),
    { turnSeq: 1, completed: true, state: 'idle' });
  await transport.feedback({ attempt: { ...attempt, bb_thread_id: runtimeId }, feedbackId: 'fb-1' });
  // Воркер отработал ход 2: активность была подтверждена (working + started).
  working = true;
  assert.equal(await transport.observeTurn({ runtimeId, after: 1 }), undefined);
  working = false;
  const second = await transport.observeTurn({ runtimeId, after: 1 });
  assert.deepEqual(second, { turnSeq: 2, completed: true, state: 'idle' });
  // Reread checkpoint вопроса владельца после хода 2 (after = turnSeq - 1 = 1):
  // seenActive уже сброшен первичным чтением, но memo делает reread идемпотентным.
  assert.deepEqual(await transport.observeTurn({ runtimeId, after: 1 }), second);
  // Ход 3 без новой активности по-прежнему не фабрикуется.
  assert.equal(await transport.observeTurn({ runtimeId, after: 2 }), undefined);
});

test('portable observeTurn never fabricates a new turn from an explicit stale watermark', async () => {
  const observations = [{ state: 'idle', turn: 1 }, { state: 'idle', turn: 0 }];
  const feedbackInputs = [];
  const runtime = {
    probeAvailability: async () => ({ status: 'available' }),
    spawn: async input => ({ runtimeId: input.runtimeId }),
    feedback: async input => {
      feedbackInputs.push(input);
      return { delivered: true, turn: 1, started: true };
    },
    observe: async () => observations.shift() ?? { state: 'idle', turn: 1 },
  };
  const transport = buildWorkerTransport({ kind: 'hc',
    policy: { bb: { provider: 'acp-devin', model: 'swe-2-1-medium' }, route: {} },
    runtime, bbTransport: {}, prepareSpawn: async () => '/tmp/prompt', prepareFeedback: async () => 'rework' });
  const attempt = { task_id: '6242', epoch: 1, attempt_id: 'attempt-stale-turn' };
  const runtimeId = deterministicRuntimeId('hc', attempt.task_id, attempt.attempt_id);
  await transport.feedback({ attempt: { ...attempt, bb_thread_id: runtimeId }, feedbackId: 'fb-stale' });
  assert.equal(await transport.observeTurn({ runtimeId, after: 1 }), undefined);
  assert.equal(await transport.observeTurn({ runtimeId, after: 0 }), undefined);
});

// --- P0/P1 cross-review regressions: runner hardening, ref pinning, shutdown gating ---

test('HARDENED_GIT_CONFIG disables fsmonitor, hooks and external diff as -c pairs', () => {
  const pairs = [];
  for (let i = 0; i < HARDENED_GIT_CONFIG.length; i += 2) {
    pairs.push([HARDENED_GIT_CONFIG[i], HARDENED_GIT_CONFIG[i + 1]]);
  }
  assert.deepEqual(pairs, [
    ['-c', 'core.fsmonitor=false'],
    ['-c', 'core.hooksPath=/dev/null'],
    ['-c', 'diff.external='],
  ]);
  assert.ok(Object.isFrozen(HARDENED_GIT_CONFIG));
});

test('hardenedGitEnv isolates git configuration and preserves the base environment', () => {
  const env = hardenedGitEnv({ PATH: '/usr/bin', GIT_CONFIG_GLOBAL: '/home/worker/.gitconfig',
    GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_COUNT: '3' });
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.PATH, '/usr/bin');
  // Edge cases: empty and null input never throw and stay deterministic.
  assert.deepEqual(hardenedGitEnv({}), { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const nulled = hardenedGitEnv(null);
  assert.equal(nulled.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(nulled.GIT_CONFIG_NOSYSTEM, '1');
  assert.deepEqual(hardenedGitEnv({ PATH: '/bin' }), hardenedGitEnv({ PATH: '/bin' }));
  const input = { PATH: '/bin' };
  hardenedGitEnv(input);
  assert.deepEqual(input, { PATH: '/bin' }, 'input object is never mutated');
});

test('ancestorOrNull returns the sha for an ancestor and null for a non-ancestor rejection', async () => {
  const sha = 'c'.repeat(40);
  const calls = [];
  const okGit = async (...args) => { calls.push(args); return ''; };
  assert.equal(await ancestorOrNull(okGit, 'base-sha', sha), sha);
  assert.deepEqual(calls[0], ['merge-base', '--is-ancestor', 'base-sha', sha]);
  const failGit = async () => { throw new Error('exit code 1'); };
  assert.equal(await ancestorOrNull(failGit, 'base-sha', sha), null);
  // Повторный вызов детерминирован и не бросает — цикл checkpoint не разгоняется.
  assert.equal(await ancestorOrNull(failGit, 'base-sha', sha), null);
  assert.equal(await ancestorOrNull(okGit, 'base-sha', sha), sha);
  const undefinedGit = async () => undefined;
  assert.equal(await ancestorOrNull(undefinedGit, 'base-sha', sha), sha);
});

test('shouldStopWorkerOnShutdown stops only terminal phases and prefers the durable record', () => {
  for (const phase of ['done', 'hold', 'uncertain', 'lease_lost']) {
    assert.equal(shouldStopWorkerOnShutdown({ recordPhase: phase }), true, phase);
  }
  for (const phase of ['claiming', 'working', 'checking', 'blocking', 'awaiting_answer', 'idle']) {
    assert.equal(shouldStopWorkerOnShutdown({ recordPhase: phase }), false, phase);
  }
  // Пустые и минимальные входы: активный/неизвестный воркер не убивается.
  assert.equal(shouldStopWorkerOnShutdown({}), false);
  assert.equal(shouldStopWorkerOnShutdown(), false);
  assert.equal(shouldStopWorkerOnShutdown({ recordPhase: undefined, resultPhase: undefined }), false);
  assert.equal(shouldStopWorkerOnShutdown({ recordPhase: null, resultPhase: 'done' }), true);
  assert.equal(shouldStopWorkerOnShutdown({ resultPhase: 'hold' }), true);
  assert.equal(shouldStopWorkerOnShutdown({ resultPhase: 'working' }), false);
  // Долговременная запись важнее последнего результата тика.
  assert.equal(shouldStopWorkerOnShutdown({ recordPhase: 'working', resultPhase: 'done' }), false);
  assert.equal(shouldStopWorkerOnShutdown({ recordPhase: 'done', resultPhase: 'working' }), true);
});

test('candidatePinRef maps done/hold records to durable verified/held refs fail-closed', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(candidatePinRef({ phase: 'done', record: { sha, taskId: '9912', attemptId: 'att-1' } }),
    { ref: 'refs/darkfactory/verified/9912/att-1', sha });
  assert.deepEqual(candidatePinRef({ phase: 'hold', record: { sha, taskId: '9912', attemptId: 'att-1' } }),
    { ref: 'refs/darkfactory/held/9912/att-1', sha });
  // Числовой task id приводится к строке детерминированно.
  assert.equal(candidatePinRef({ phase: 'done', record: { sha, taskId: 9912, attemptId: 'att-1' } }).ref,
    'refs/darkfactory/verified/9912/att-1');
  // Фазы без подтверждённого исхода ничего не закрепляют — uncertain не verified и не held.
  for (const phase of ['working', 'checking', 'uncertain', 'lease_lost', 'idle', undefined, null]) {
    assert.equal(candidatePinRef({ phase, record: { sha, taskId: '9912', attemptId: 'att-1' } }), null, String(phase));
  }
  // Неполный/невалидный sha никогда не попадает в ref.
  for (const bad of ['', 'abc', 'A'.repeat(40), 'g'.repeat(40), 42, null, undefined]) {
    assert.equal(candidatePinRef({ phase: 'done', record: { sha: bad, taskId: '1', attemptId: 'a' } }), null, String(bad));
  }
  // Компоненты ref строгие: traversal, вложенность, пробелы и краевые символы отклоняются.
  for (const badId of ['../x', 'a..b', 'a/b', 'a b', '-x', '.x', 'x?', 'x*', 'a'.repeat(200), '', null, undefined]) {
    assert.equal(candidatePinRef({ phase: 'done', record: { sha, taskId: badId, attemptId: 'att' } }), null, String(badId));
    assert.equal(candidatePinRef({ phase: 'done', record: { sha, taskId: '1', attemptId: badId } }), null, String(badId));
  }
  assert.equal(candidatePinRef({ phase: 'done', record: null }), null);
  assert.equal(candidatePinRef(), null);
  // UUID-attempt и длинный numeric task проходят; повторный вызов детерминирован.
  const uuidRecord = { sha, taskId: '9912', attemptId: 'aa85e3cc-0bf2-468b-a624-5d24cfcdd946' };
  assert.deepEqual(candidatePinRef({ phase: 'done', record: uuidRecord }),
    candidatePinRef({ phase: 'done', record: uuidRecord }));
  assert.equal(candidatePinRef({ phase: 'done', record: uuidRecord }).ref,
    'refs/darkfactory/verified/9912/aa85e3cc-0bf2-468b-a624-5d24cfcdd946');
});

// Детерминированный git-double для resetQueueWorktree: checkout — ожидаемая
// ветка слота на заданном HEAD, пока сценарий не переопределит ответы.
function queueGitDouble({ branch = 'feat/df-slot', head = 'c'.repeat(40), mutate } = {}) {
  const calls = [];
  const git = async (...args) => {
    calls.push(args);
    if (args[0] === 'branch') return branch;
    if (args[0] === 'rev-parse') return head;
    if (mutate) return mutate(args);
    return '';
  };
  return { calls, git };
}

test('resetQueueWorktree pins the durable ref strictly before resetting the queue worktree', async () => {
  const sha = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  for (const [phase, kind] of [['done', 'verified'], ['hold', 'held']]) {
    const { calls, git } = queueGitDouble();
    await resetQueueWorktree({ git, base, phase, record: { sha, taskId: '9912', attemptId: 'att-1' },
      branch: 'feat/df-slot', workerStopped: true, log: null });
    assert.deepEqual(calls, [
      ['update-ref', `refs/darkfactory/${kind}/9912/att-1`, sha],
      ['branch', '--show-current'],
      ['rev-parse', 'HEAD'],
      ['reset', '--hard', base],
      ['clean', '-fd'],
    ], phase);
  }
});

test('resetQueueWorktree never resets when pinning fails, keeping the verified commit checked out', async () => {
  const calls = [];
  const git = async (...args) => {
    calls.push(args);
    if (args[0] === 'update-ref') throw new Error('ref write failed');
    return '';
  };
  await assert.rejects(() => resetQueueWorktree({ git, base: 'b'.repeat(40), phase: 'done',
    record: { sha: 'a'.repeat(40), taskId: '9912', attemptId: 'att-1' },
    branch: 'feat/df-slot', workerStopped: true, log: null }), /ref write failed/);
  assert.deepEqual(calls.map(args => args[0]), ['update-ref']);
});

test('resetQueueWorktree resets without pinning when the record has nothing durable to pin', async () => {
  const base = 'b'.repeat(40);
  for (const record of [
    null,
    { sha: 'not-a-sha', taskId: '9912', attemptId: 'att-1' },
    { sha: 'a'.repeat(40) },
  ]) {
    const { calls, git } = queueGitDouble();
    await resetQueueWorktree({ git, base, phase: 'done', record,
      branch: 'feat/df-slot', workerStopped: true, log: null });
    assert.deepEqual(calls, [
      ['branch', '--show-current'],
      ['rev-parse', 'HEAD'],
      ['reset', '--hard', base],
      ['clean', '-fd'],
    ]);
  }
  // Нетерминальная фаза никогда не закрепляет — reset идёт сразу.
  const { calls, git } = queueGitDouble();
  await resetQueueWorktree({ git, base, phase: 'working',
    record: { sha: 'a'.repeat(40), taskId: '9912', attemptId: 'att-1' },
    branch: 'feat/df-slot', workerStopped: true, log: null });
  assert.deepEqual(calls, [
    ['branch', '--show-current'],
    ['rev-parse', 'HEAD'],
    ['reset', '--hard', base],
    ['clean', '-fd'],
  ]);
});

// Astra #1 (P0): чужая ветка или неподтверждённая остановка воркера —
// карантин без reset --hard/clean -fd, дерево сохраняется нетронутым.
test('resetQueueWorktree quarantines a foreign branch instead of destroying it', async () => {
  const base = 'b'.repeat(40);
  for (const [branch, head] of [
    ['main', 'c'.repeat(40)],
    ['feat/other-slot', 'c'.repeat(40)],
    ['', 'd'.repeat(40)], // отделённый HEAD не на base и не на candidate
  ]) {
    const { calls, git } = queueGitDouble({ branch, head });
    const notes = [];
    await assert.rejects(() => resetQueueWorktree({ git, base, phase: 'hold',
      record: { sha: 'a'.repeat(40), taskId: '9912', attemptId: 'att-1' },
      branch: 'feat/df-slot', workerStopped: true, log: note => notes.push(note) }),
      /branch_mismatch_quarantined/);
    assert.deepEqual(calls.map(args => args[0]), ['update-ref', 'branch', 'rev-parse'],
      `нет reset/clean на чужой ветке ${branch}@${head.slice(0, 4)}`);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].kind, 'branch_mismatch_quarantined');
    assert.equal(notes[0].branch, branch);
    assert.equal(notes[0].expectedBranch, 'feat/df-slot');
    assert.equal(notes[0].task_id, '9912');
    assert.equal(notes[0].workerStopped, true);
  }
});

test('resetQueueWorktree accepts a detached HEAD exactly at base or at the attempt candidate', async () => {
  const base = 'b'.repeat(40);
  const sha = 'a'.repeat(40);
  for (const head of [base, sha]) {
    const { calls, git } = queueGitDouble({ branch: '', head });
    await resetQueueWorktree({ git, base, phase: 'done',
      record: { sha, taskId: '9912', attemptId: 'att-1' },
      branch: 'feat/df-slot', workerStopped: true, log: null });
    assert.deepEqual(calls.map(args => args[0]), ['update-ref', 'branch', 'rev-parse', 'reset', 'clean']);
  }
});

test('resetQueueWorktree quarantines when the worker is not confirmed stopped', async () => {
  const base = 'b'.repeat(40);
  for (const workerStopped of [undefined, false]) {
    const { calls, git } = queueGitDouble();
    const notes = [];
    await assert.rejects(() => resetQueueWorktree({ git, base, phase: 'hold',
      record: { sha: 'a'.repeat(40), taskId: '9912', attemptId: 'att-1' },
      branch: 'feat/df-slot', workerStopped, log: note => notes.push(note) }),
      /worker_not_stopped_quarantined/);
    assert.deepEqual(calls.map(args => args[0]), ['update-ref', 'branch', 'rev-parse'],
      'нет reset/clean при живом воркере');
    assert.equal(notes[0].kind, 'worker_not_stopped_quarantined');
    assert.equal(notes[0].workerStopped, false);
  }
  // Отсутствующее/пустое имя ветки не даёт доказательства — тот же карантин.
  for (const branch of [undefined, '']) {
    const { calls, git } = queueGitDouble();
    await assert.rejects(() => resetQueueWorktree({ git, base, phase: 'done',
      record: { sha: 'a'.repeat(40), taskId: '9912', attemptId: 'att-1' },
      branch, workerStopped: true, log: null }), /branch_mismatch_quarantined/);
    assert.deepEqual(calls.map(args => args[0]), ['update-ref', 'branch', 'rev-parse']);
  }
});

test('resetQueueWorktree still pins the durable ref before the quarantine probe', async () => {
  // Закрепление verified/held ref недеструктивно и идёт до сверки ветки:
  // кандидат сохраняется даже когда checkout карантинится.
  const { calls, git } = queueGitDouble({ branch: 'main' });
  await assert.rejects(() => resetQueueWorktree({ git, base: 'b'.repeat(40), phase: 'done',
    record: { sha: 'a'.repeat(40), taskId: '9912', attemptId: 'att-1' },
    branch: 'feat/df-slot', workerStopped: true, log: null }), /branch_mismatch_quarantined/);
  assert.deepEqual(calls[0], ['update-ref', 'refs/darkfactory/verified/9912/att-1', 'a'.repeat(40)]);
});

test('arbiterIntakePrompt formats per model family only when the arbiter spec is passed', () => {
  const plain = arbiterIntakePrompt('Arbitration spec', 'extra context', undefined, undefined);
  for (const arbiter of [
    { provider: 'google', model: 'gemini-4-neon' },
    { provider: 'openai', model: 'gpt-6.2-sol' },
    { provider: 'anthropic', model: 'claude-opus-5' },
  ]) {
    const formatted = arbiterIntakePrompt('Arbitration spec', 'extra context', undefined, undefined, arbiter);
    assert.notEqual(formatted, plain, arbiter.provider);
    assert.match(formatted, /Arbitration spec/);
    // Повторный вызов детерминирован.
    assert.equal(arbiterIntakePrompt('Arbitration spec', 'extra context', undefined, undefined, arbiter), formatted);
  }
  const google = arbiterIntakePrompt('Arbitration spec', 'extra', undefined, undefined,
    { provider: 'google', model: 'gemini-4-neon' });
  const openai = arbiterIntakePrompt('Arbitration spec', 'extra', undefined, undefined,
    { provider: 'openai', model: 'gpt-6.2-sol' });
  assert.notEqual(google, openai);
});

test('run-isolated controller wiring pins recovery, memory key resolution, arbiter family and queue reset', () => {
  const source = readFileSync(new URL('./run-isolated.mjs', import.meta.url), 'utf8');
  assert.match(source, /recoverInterruptedChecking: true/);
  assert.match(source, /resolveMemoryHmacKey\(\{ hmacKey: memoryCfg\.hmacKey, keyFile: memoryCfg\.keyFile \}\)/);
  assert.match(source, /hmacKey: memoryHmacKey/);
  assert.match(source, /runnerReviewSpec\(req\?\.arbiter\) \?\? undefined/);
  assert.match(source, /resetQueueWorktree\(\{ git, base: route\.base, phase: result\.phase,\s*\n?\s*record: closedRecord, branch: p\.profiles\[route\.checkProfile\]\.branch,/);
  assert.match(source, /workerStopped: workerStoppedEvidence\(result\?\.threadId \?\? liveThreadId, terminalStop\)/);
  assert.match(source, /reserveWorktree\(join\(stateHome, 'darkfactory-lab', 'slots'\), tree, root,\s*\n?\s*\{ stateDir: root \}\)/);
  assert.match(source, /isDefinitiveClaimLoss\(error\)\) lost = true/);
  assert.match(source, /O_RDONLY \| fsConstants\.O_NOFOLLOW/);
  assert.match(source, /maxBuffer: 16 \* 1024 \* 1024/);
  assert.match(source, /shouldStopWorkerOnShutdown\(\{ recordPhase: shutdownRecord\?\.phase/);
  assert.match(source, /ancestorOrNull\(git, route\.base, sha\)/);
});
