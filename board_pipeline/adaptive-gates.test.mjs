import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAdaptiveGatesSummary, evaluateAdaptiveGate,
  evaluateRollbackCircuitBreaker } from './adaptive-gates.mjs';

const slowEnough = 120_000;

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('formal and irreversible checks always stay synchronous, even when slow', () => {
  const result = evaluateAdaptiveGate({
    checks: [
      { id: 'proof', kind: 'formal', reversible: true },
      { id: 'deploy-migration', kind: 'heavy' },
      { id: 'preview', kind: 'heavy', reversible: true },
    ],
    telemetryStats: {
      proof: { medianMs: slowEnough },
      'deploy-migration': { medianMs: slowEnough },
      preview: { medianMs: slowEnough },
    },
  });

  assert.equal(result.mode, 'optimistic_async');
  assert.deepEqual(result.syncFastChecks.map(check => check.id), ['proof', 'deploy-migration']);
  assert.deepEqual(result.asyncHeavyChecks.map(check => check.id), ['preview']);
  assert.equal(result.asyncHeavyChecks[0].autoRollbackOnFail, true);
  assert.equal(result.decisions.find(decision => decision.id === 'proof').reason, 'formal_override');
  assert.equal(result.decisions.find(decision => decision.id === 'deploy-migration').reason,
    'irreversible_override');
});

test('duration tiering uses exact boundaries and missing telemetry conservatively', () => {
  const checks = ['missing', 'fast', 'lower-band', 'upper-band', 'async-ready']
    .map(id => ({ id, kind: 'heavy', reversible: true }));
  const result = evaluateAdaptiveGate({
    checks,
    telemetryStats: {
      fast: 89_999,
      'lower-band': 90_000,
      'upper-band': 119_999,
      'async-ready': 120_000,
    },
  });

  assert.equal(result.mode, 'optimistic_async');
  assert.deepEqual(result.syncFastChecks.map(check => check.id),
    ['missing', 'fast', 'lower-band', 'upper-band']);
  assert.deepEqual(result.asyncHeavyChecks.map(check => check.id), ['async-ready']);
  assert.equal(result.decisions.find(decision => decision.id === 'missing').reason, 'missing_telemetry');
  assert.equal(result.decisions.find(decision => decision.id === 'lower-band').reason,
    'conservative_duration_band');
});

test('high-risk exact path, directory prefix, and glob force strict synchronous mode', () => {
  for (const [pattern, diffPath] of [
    ['auth', 'auth'],
    ['auth/', 'auth/login.ts'],
    ['migrations/', 'migrations/0001_init.sql'],
    ['board_pipeline/tamper/**/*.mjs', 'board_pipeline/tamper/deep/gate.mjs'],
  ]) {
    const result = evaluateAdaptiveGate({
      checks: [{ id: 'slow', reversible: true, high_risk_paths: [pattern] }],
      diffPaths: [diffPath],
      telemetryStats: { slow: { medianMs: slowEnough } },
    });
    assert.equal(result.mode, 'strict_sync', `${pattern} vs ${diffPath}`);
    assert.equal(result.reason, 'high_risk_path');
    assert.equal(result.asyncHeavyChecks.length, 0);
    assert.equal(result.syncFastChecks.length, 1);
    assert.deepEqual(result.highRiskMatches[0], { path: diffPath, pattern });
  }
});

test('high-risk escalation wins over rollback circuit breaker and keeps all checks synchronous', () => {
  const result = evaluateAdaptiveGate({
    checks: [
      { id: 'slow', reversible: true },
      { id: 'proof', kind: 'formal', reversible: true },
    ],
    diffPaths: ['billing/ledger.ts'],
    telemetryStats: { slow: { medianMs: slowEnough } },
    recentRollbacks: { totalRuns: 20, rollbacks: 3 },
    highRiskPaths: ['billing/'],
  });
  assert.equal(result.mode, 'strict_sync');
  assert.equal(result.reason, 'high_risk_path');
  assert.deepEqual(result.syncFastChecks.map(check => check.id), ['slow', 'proof']);
  assert.equal(result.asyncHeavyChecks.length, 0);
});

test('rollback circuit breaker requires the minimum sample and trips only above ten percent', () => {
  const insufficient = evaluateAdaptiveGate({
    checks: [{ id: 'slow', reversible: true }],
    telemetryStats: { slow: slowEnough },
    recentRollbacks: { totalRuns: 4, rollbacks: 4 },
  });
  assert.equal(insufficient.mode, 'optimistic_async');
  assert.equal(insufficient.circuitBreaker.state, 'insufficient_sample');

  const exactTripBoundary = evaluateAdaptiveGate({
    checks: [{ id: 'slow', reversible: true }],
    telemetryStats: { slow: slowEnough },
    recentRollbacks: { totalRuns: 20, rollbacks: 2 },
  });
  assert.equal(exactTripBoundary.mode, 'optimistic_async');
  assert.equal(exactTripBoundary.circuitBreaker.open, false);

  const tripped = evaluateAdaptiveGate({
    checks: [{ id: 'slow', reversible: true }],
    telemetryStats: { slow: slowEnough },
    recentRollbacks: { totalRuns: 20, rollbacks: 3 },
  });
  assert.equal(tripped.mode, 'strict_sync');
  assert.equal(tripped.reason, 'rollback_circuit_breaker');
  assert.equal(tripped.asyncHeavyChecks.length, 0);
  assert.equal(tripped.circuitBreaker.open, true);
});

test('rollback circuit breaker hysteresis remains open in the deadband and recovers at five percent', () => {
  const input = {
    checks: [{ id: 'slow', reversible: true }],
    telemetryStats: { slow: slowEnough },
  };
  const deadbandOpen = evaluateAdaptiveGate({
    ...input,
    recentRollbacks: { totalRuns: 40, rollbacks: 3, breakerOpen: true },
  });
  assert.equal(deadbandOpen.mode, 'strict_sync');
  assert.equal(deadbandOpen.reason, 'rollback_circuit_breaker');

  const recovered = evaluateAdaptiveGate({
    ...input,
    recentRollbacks: { totalRuns: 20, rollbacks: 1, breakerOpen: true },
  });
  assert.equal(recovered.mode, 'optimistic_async');
  assert.equal(recovered.circuitBreaker.open, false);
  assert.equal(recovered.circuitBreaker.recovered, true);
});

test('rollback history reconstructs hysteresis deterministically inside the rolling window', () => {
  const deadbandHistory = [true, true, ...Array.from({ length: 18 }, () => false)];
  const deadband = evaluateRollbackCircuitBreaker(deadbandHistory);
  assert.equal(deadband.rollbackRate, 0.1);
  assert.equal(deadband.open, true);

  const recoveredHistory = [...deadbandHistory, false];
  const recovered = evaluateRollbackCircuitBreaker(recoveredHistory);
  assert.equal(recovered.totalRuns, 20);
  assert.equal(recovered.rollbacks, 1);
  assert.equal(recovered.rollbackRate, 0.05);
  assert.equal(recovered.open, false);
});

test('telemetry stats accept mapping entries and arrays without changing the decision', () => {
  const base = { checks: [{ id: 'check-a', name: 'named', reversible: true }] };
  const objectForm = evaluateAdaptiveGate({
    ...base,
    telemetryStats: { checks: { 'check-a': { median_ms: slowEnough } } },
  });
  const arrayForm = evaluateAdaptiveGate({
    ...base,
    telemetryStats: { entries: [{ id: 'check-a', median: slowEnough }] },
  });
  assert.equal(objectForm.mode, 'optimistic_async');
  assert.equal(arrayForm.mode, 'optimistic_async');
  assert.deepEqual(arrayForm.decisions, objectForm.decisions);
});

test('empty, null, and malformed inputs fail conservatively without throwing', () => {
  for (const input of [undefined, null, {}, { checks: null, diffPaths: null },
    { checks: 'not-a-list', telemetryStats: 42, recentRollbacks: 'bad', thresholds: null }]) {
    const result = evaluateAdaptiveGate(input ?? undefined);
    assert.equal(result.mode, 'strict_sync');
    assert.equal(result.reason, null);
    assert.deepEqual(result.syncFastChecks, []);
    assert.deepEqual(result.asyncHeavyChecks, []);
  }
});

test('evaluation is pure, repeatable, and does not mutate frozen input', () => {
  const input = deepFreeze({
    checks: [{ id: 'slow', reversible: true, high_risk_paths: ['auth/'], nested: { x: 1 } }],
    diffPaths: ['src/index.ts'],
    telemetryStats: { slow: { medianMs: slowEnough } },
    recentRollbacks: { entries: [false, false, false, false, false] },
    thresholds: { fastMaxMs: 90_000, asyncMinMs: 120_000 },
  });
  const before = JSON.stringify(input);
  const first = evaluateAdaptiveGate(input);
  const second = evaluateAdaptiveGate(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(second, first);
  assert.notEqual(first.syncFastChecks[0], input.checks[0]);
  assert.equal(first.mode, 'optimistic_async');
});

test('adaptive summary computes per-repo rollback stats from telemetry attempts', () => {
  const summary = buildAdaptiveGatesSummary({ attempts: [
    { repo_id: 'repo-a', outcome: 'done' },
    { repo_id: 'repo-a', outcome: 'rolled_back' },
    { repo_id: 'repo-a', outcome: 'done' },
    { repo_id: 'repo-a', outcome: 'done' },
    { repo_id: 'repo-a', outcome: 'done' },
    { repoId: 'repo-b', outcome: 'release_rolled_back' },
    { repoId: 'repo-b', outcome: 'done', open: true },
  ]});
  assert.equal(summary.fastMaxMs, 90_000);
  assert.equal(summary.asyncMinMs, 120_000);
  assert.equal(summary.breakerTripRate, 0.1);
  assert.equal(summary.breakerRecoverRate, 0.05);
  assert.equal(summary.repos['repo-a'].totalRuns, 5);
  assert.equal(summary.repos['repo-a'].rollbacks, 1);
  assert.equal(summary.repos['repo-a'].rollbackRate, 0.2);
  assert.equal(summary.repos['repo-a'].circuitBreakerOpen, true);
  assert.equal(summary.repos['repo-b'].totalRuns, 1);
  assert.equal(summary.repos['repo-b'].sampleSufficient, false);
});
