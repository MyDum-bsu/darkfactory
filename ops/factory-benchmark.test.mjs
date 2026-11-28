import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluateGoNoGo, loadBenchmarkCorpus, renderBenchmarkReport,
  pairedPlan, scorePairs, renderFusionComparison, runCli, runDryRun, runLive, runSecurityMutantSuite } from './factory-benchmark.mjs';

const cli = new URL('./factory-benchmark.mjs', import.meta.url).pathname;
const corpusRoot = new URL('./benchmarks/corpus', import.meta.url).pathname;

test('corpus validation loads exactly six deterministic English task specifications', async () => {
  const corpus = await loadBenchmarkCorpus(corpusRoot);
  assert.equal(corpus.cases.length, 6);
  assert.deepEqual(corpus.cases.map(entry => entry.id), [
    'code-policy', 'code-test-first', 'ui-holdout', 'docs-contract', 'security-guard', 'refactor-review',
  ]);
  assert.match(corpus.corpusDigest, /^[a-f0-9]{64}$/);
  assert.equal(new Set(corpus.cases.map(entry => entry.specDigest)).size, 6);
  for (const entry of corpus.cases) {
    const text = await readFile(entry.specPath, 'utf8');
    assert.match(text, /^# Task: /);
    assert.ok(text.includes('Required') || text.includes('Verification'));
  }
  const again = await loadBenchmarkCorpus(corpusRoot);
  assert.equal(again.corpusDigest, corpus.corpusDigest);
});

test('corpus validation fail-closes on a missing or mutated case spec', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-corpus-invalid-'));
  try {
    const target = join(dir, 'corpus');
    await cp(corpusRoot, target, { recursive: true });
    await writeFile(join(target, 'code-policy', 'SPEC.md'), '# Task: too short\n');
    await assert.rejects(loadBenchmarkCorpus(target), /benchmark corpus invalid/);
    const manifest = JSON.parse(await readFile(join(target, 'corpus.json'), 'utf8'));
    manifest.cases = manifest.cases.filter(entry => entry.id !== 'security-guard');
    await writeFile(join(target, 'corpus.json'), JSON.stringify(manifest));
    await assert.rejects(loadBenchmarkCorpus(target), /exactly 6 cases/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Devin Fusion: score identical tasks with pinned arms, complete accounting and an inclusive 15% gate', () => {
  const runners = { sha: 'a'.repeat(40), path: '/benchmark/runner' };
  const plan = { schema: 1, preset: 'devin-fusion-ab', runners: { baseline: runners, fusion: runners },
    tasks: Array.from({ length: 8 }, (_, i) => ({ id: `t-${i}`, domain: ['Code', 'UI', 'Math/Lean', 'DSP/Docs'][i % 4],
      baseSha: 'b'.repeat(40), maxTokens: 1000, maxCostUsd: 5 })) };
  const workers = { baseline: { provider: 'pi', model: 'openai/gpt-6.2-astra' },
    fusion: { provider: 'acp-devin', model: 'fusion-gpt-6-2-astra-high-sidekick-swe-2-1-medium' } };
  const schedule = pairedPlan(plan);
  assert.deepEqual(schedule.slice(0, 4).map(r => r.arm), ['baseline', 'fusion', 'fusion', 'baseline']);
  const rows = schedule.map(({ id, arm, baseSha }) => ({ id, arm, baseSha, runnerSha: runners.sha, worker: workers[arm],
    inputsDigest: 'e'.repeat(64), attemptId: `${id}-${arm}`, nativeClosed: true, firstRoundPass: id !== 't-0',
    reworkRounds: id === 't-0' ? 2 : 0, wallClockMs: 30, tokens: arm === 'baseline' ? 100 : 85,
    costUsd: arm === 'baseline' ? 2 : 1 }));
  const score = scorePairs(plan, rows);
  assert.equal(score.benchmarkVerdict, 'GO');
  assert.deepEqual(score.savingsPct, { tokens: 15, usd: 50 });
  assert.equal(score.comparison.baseline.reworkRate, 1 / 8);
  assert.equal(score.comparison.fusion.firstRoundPassRate, 7 / 8);
  assert.equal(score.comparison.fusion.wallClockMs, 240);
  assert.equal(score.comparison.fusion.tokens, 680);
  assert.match(renderFusionComparison(score), /Total tokens \| 800 \| 680/);
  assert.match(renderFusionComparison(score), /15% \/ 50%/);
  assert.throws(() => pairedPlan({ ...plan, runners: { ...plan.runners, fusion: { ...runners, sha: 'c'.repeat(40) } } }), /identical runner revisions/);
  const patch = (id, arm, fields) => rows.map(r => r.id === id && r.arm === arm ? { ...r, ...fields } : r);
  for (const fields of [{ tokens: 86 }, { firstRoundPass: false, reworkRounds: 1 }, { tokens: null }]) {
    assert.equal(scorePairs(plan, patch('t-1', 'fusion', fields)).benchmarkVerdict, 'NO-GO');
  }
  assert.equal(scorePairs(plan, rows.map(r => ({ ...r, tokens: 0 }))).benchmarkVerdict, 'NO-GO');
  assert.throws(() => scorePairs(plan, patch('t-1', 'fusion', { worker: workers.baseline })), /worker/);
  assert.throws(() => scorePairs(plan, patch('t-1', 'fusion', { inputsDigest: 'f'.repeat(64) })), /mismatched evidence/);
  assert.throws(() => scorePairs(plan, rows.slice(1)), /incomplete matrix/);
});

test('Devin Fusion CLI preset selects only its matching enrolled paired plan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-fusion-profile-'));
  try {
    await writeFile(join(dir, 'plan.json'), JSON.stringify({ schema: 1 }));
    await assert.rejects(runCli(['--preset', 'devin-fusion-ab', '--root', dir]), /plan preset mismatch/);
    await assert.rejects(runCli(['--preset', 'unknown']), /unknown preset/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const mutantSuitePromise = runSecurityMutantSuite();
const expectedMutants = [
  'tamper-test-deletion',
  'tamper-skip-only-weakening',
  'tamper-secret-leak',
  'cmd-rm-root-critical',
  'cmd-wrapper-evasion',
  'loop-32-word-repetition',
  'origin-dns-rebinding-rejection',
  'review-p2-nit-not-blocking',
  'holdout-path-and-source-leak',
  'stage-unattested-readonly',
];

test('security mutant suite is deterministic, offline, fast, and has 0/10 bypasses', async () => {
  const suite = await mutantSuitePromise;
  assert.equal(suite.total, 10);
  assert.equal(suite.passed, 10);
  assert.equal(suite.bypasses, 0);
  assert.ok(suite.elapsedMs < 5000, `suite too slow: ${suite.elapsedMs}ms`);
  assert.deepEqual(suite.mutants.map(mutant => mutant.id), expectedMutants);
});

for (const id of expectedMutants) {
  test(`security mutant held: ${id}`, async () => {
    const suite = await mutantSuitePromise;
    const mutant = suite.mutants.find(entry => entry.id === id);
    assert.ok(mutant, `missing mutant ${id}`);
    assert.equal(mutant.passed, true, mutant.evidence);
    assert.equal(mutant.bypassed, false);
  });
}

const boundary = {
  v15: { nativeCloseRate: 0.8, firstRoundPassRate: 0.4, avgRework: 2, wallClockMs: 1000 },
  v2: { nativeCloseRate: 0.85, firstRoundPassRate: 0.55, avgRework: 1.4, wallClockMs: 1350, stageWitnessCoverage: 1 },
  securityMutantBypasses: 0,
};

test('Go/No-Go evaluator returns GO at every exact inclusive boundary', () => {
  const result = evaluateGoNoGo(boundary);
  assert.equal(result.decision, 'GO');
  assert.equal(result.go, true);
  assert.deepEqual(result.failedGates, []);
  assert.equal(result.wallClockRatio, 1.35);
});

test('Go/No-Go evaluator accepts either quality improvement branch', () => {
  const firstOnly = evaluateGoNoGo({ ...boundary,
    v15: { ...boundary.v15, firstRoundPassRate: 0.2, avgRework: 2 },
    v2: { ...boundary.v2, firstRoundPassRate: 0.35, avgRework: 1.9 } });
  assert.equal(firstOnly.gates.qualityImprovement.pass, true);
  const reworkOnly = evaluateGoNoGo({ ...boundary,
    v15: { ...boundary.v15, firstRoundPassRate: 0.4, avgRework: 2 },
    v2: { ...boundary.v2, firstRoundPassRate: 0.45, avgRework: 1.4 } });
  assert.equal(reworkOnly.gates.qualityImprovement.pass, true);
});

const noGoCases = [
  ['native close below absolute floor', {
    v2: { ...boundary.v2, nativeCloseRate: 0.849999 },
  }, 'nativeCloseRate'],
  ['native close below v1.5 baseline', {
    v15: { ...boundary.v15, nativeCloseRate: 0.9 },
    v2: { ...boundary.v2, nativeCloseRate: 0.86 },
  }, 'nativeCloseRate'],
  ['neither quality branch improves enough', {
    v2: { ...boundary.v2, firstRoundPassRate: 0.549999, avgRework: 1.400001 },
  }, 'qualityImprovement'],
  ['stage witness coverage is incomplete', {
    v2: { ...boundary.v2, stageWitnessCoverage: 0.999999 },
  }, 'stageWitnessCoverage'],
  ['one security mutant bypasses the control', {
    securityMutantBypasses: 1,
  }, 'securityMutants'],
  ['wall clock ratio exceeds the ceiling', {
    v2: { ...boundary.v2, wallClockMs: 1350.001 },
  }, 'wallClock'],
];

for (const [name, patch, failedGate] of noGoCases) {
  test(`Go/No-Go NO-GO trigger: ${name}`, () => {
    const input = {
      v15: patch.v15 ?? boundary.v15,
      v2: patch.v2 ?? boundary.v2,
      securityMutantBypasses: patch.securityMutantBypasses ?? boundary.securityMutantBypasses,
    };
    const result = evaluateGoNoGo(input);
    assert.equal(result.decision, 'NO-GO');
    assert.equal(result.go, false);
    assert.ok(result.failedGates.includes(failedGate), JSON.stringify(result.failedGates));
  });
}

test('Markdown report contains decision, corpus, mutant, comparison, and gate sections', async () => {
  const dry = await runDryRun({ corpusDir: corpusRoot });
  const report = renderBenchmarkReport(dry);
  assert.match(report, /^# V2-6 Warp Factory Benchmark Report/m);
  assert.match(report, /## Corpus/);
  assert.match(report, /## Security and Tamper Mutant Suite/);
  assert.match(report, /## Paired Comparison/);
  assert.match(report, /## Go\/No-Go Gates/);
  assert.match(report, /Decision: \*\*GO\*\*/);
  assert.match(report, /tamper-test-deletion/);
  assert.match(report, /not release evidence/);
});

test('--mode dry-run CLI writes JSON and Markdown reports end to end', async () => {
  const out = await mkdtemp(join(tmpdir(), 'df-bench-out-'));
  try {
    const result = spawnSync(process.execPath, [cli, '--mode', 'dry-run', '--out', out, '--json'], {
      encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.evaluation.decision, 'GO');
    assert.equal(summary.security.bypasses, 0);
    assert.equal(summary.corpus.caseCount, 6);
    const markdown = await readFile(join(out, 'v2-benchmark-report.md'), 'utf8');
    const json = JSON.parse(await readFile(join(out, 'factory-benchmark-report.json'), 'utf8'));
    assert.match(markdown, /V2-6 Warp Factory Benchmark Report/);
    assert.equal(json.security.total, 10);
    assert.equal(json.comparison.v2.stageWitnessCoverage, 1);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('runLive orchestrates paired pilot cells, combines security evidence, and writes final reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'df-bench-live-'));
  try {
    const calls = [];
    const cells = [
      { case: 'policy', arm: 'linear', closed: true, first_round_pass: true, rework: 2, elapsed_ms: 1000, stage_witness_coverage: null },
      { case: 'docs', arm: 'linear', closed: true, first_round_pass: false, rework: 2, elapsed_ms: 1500, stage_witness_coverage: null },
      { case: 'policy', arm: 'foreman', closed: true, first_round_pass: true, rework: 1, elapsed_ms: 1200, stage_witness_coverage: 1 },
      { case: 'docs', arm: 'foreman', closed: true, first_round_pass: false, rework: 1, elapsed_ms: 1400, stage_witness_coverage: 1 },
    ];
    const execImpl = async (file, args) => {
      calls.push([file, args]);
      if (args.includes('--execute')) {
        return { stdout: JSON.stringify({ name: args[args.indexOf('--case') + 1], arm: args[args.indexOf('--arm') + 1], exit: 0 }) };
      }
      return { stdout: JSON.stringify({ cells }) };
    };
    const reportPath = join(root, 'final-report.md');
    const summary = await runLive({ root, cases: 'policy,docs', out: reportPath, execImpl });
    assert.equal(calls.filter(([, args]) => args.includes('--execute')).length, 4);
    assert.equal(calls.filter(([, args]) => !args.includes('--execute')).length, 1);
    assert.deepEqual(calls.slice(0, 4).map(([, args]) => [args[args.indexOf('--case') + 1], args[args.indexOf('--arm') + 1]]), [
      ['policy', 'linear'], ['policy', 'foreman'], ['docs', 'linear'], ['docs', 'foreman'],
    ]);
    assert.equal(summary.evaluation.decision, 'GO');
    assert.equal(summary.comparison.v2.stageWitnessCoverage, 1);
    assert.equal(summary.security.bypasses, 0);
    assert.match(await readFile(reportPath, 'utf8'), /Decision: \*\*GO\*\*/);
    assert.ok(JSON.parse(await readFile(join(root, 'final-report.json'), 'utf8')).evaluation.go);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
