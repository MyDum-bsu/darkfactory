#!/usr/bin/env node
// V2-6 Warp Factory benchmark harness. The security mutant suite is fully
// deterministic and local; live A/B evidence is delegated to the sealed pilot
// runner and then evaluated with the explicit Go/No-Go contract.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { analyzeDiff } from '../board_pipeline/tamper-gate.mjs';
import { checkCommand } from '../board_pipeline/cmd-guard.mjs';
import { createStreamLoopGuard } from '../board_pipeline/loop-detector.mjs';
import { isAllowedHost, isAllowedOrigin } from './control-room/origin-guard.mjs';
import { assertCrossFamily } from '../board_pipeline/review-runner.mjs';
import { applySeverityGating } from '../board_pipeline/review-policy.mjs';
import { sanitizeHoldoutFeedback, validateHoldoutDir } from '../board_pipeline/holdout-runner.mjs';
import { assertStageReadOnly, createStageSandboxTransport } from '../board_pipeline/stage-sandbox-transport.mjs';

const execFileAsync = promisify(execFile);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..');
const DEFAULT_CORPUS_DIR = join(MODULE_DIR, 'benchmarks', 'corpus');
const CASE_IDS = Object.freeze([
  'code-policy', 'code-test-first', 'ui-holdout', 'docs-contract', 'security-guard', 'refactor-review',
]);
const KINDS = new Set(CASE_IDS);
const PILOT_CASES = new Map([
  ['policy', 'policy'], ['code-policy', 'policy'],
  ['docs', 'docs'], ['docs-contract', 'docs'],
]);
const EPSILON = 1e-12;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const round3 = value => value == null ? null : Math.round(value * 1000) / 1000;

function failValidation(message) {
  throw Object.assign(new Error(`benchmark corpus invalid: ${message}`), { code: 'benchmark_corpus_invalid' });
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value) ||
      value.includes('\0') || value.split(/[\\/]+/).includes('..')) {
    failValidation(`${label} must be a confined relative path`);
  }
  return value;
}

export async function loadBenchmarkCorpus(corpusDir = DEFAULT_CORPUS_DIR) {
  const root = resolve(corpusDir);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, 'corpus.json'), 'utf8'));
  } catch (error) {
    failValidation(`corpus.json is unreadable or malformed (${error.message})`);
  }
  if (manifest?.schema !== 1 || manifest.benchmark !== 'V2-6 Warp Factory Benchmarks' ||
      typeof manifest.seed !== 'string' || !manifest.seed) {
    failValidation('manifest schema, benchmark name, or deterministic seed is invalid');
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length !== CASE_IDS.length) {
    failValidation(`exactly ${CASE_IDS.length} cases are required`);
  }
  const seen = new Set();
  const cases = [];
  for (const entry of manifest.cases) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) failValidation('case entry must be an object');
    if (!KINDS.has(entry.id) || seen.has(entry.id)) failValidation(`case id ${entry.id ?? '<missing>'} is missing, unknown, or duplicated`);
    seen.add(entry.id);
    if (entry.kind !== entry.id) failValidation(`${entry.id}: kind must match id`);
    if (typeof entry.title !== 'string' || !entry.title.trim()) failValidation(`${entry.id}: title is required`);
    if (!['backend', 'ui', 'security', 'docs', 'research'].includes(entry.domain)) failValidation(`${entry.id}: unknown domain`);
    if (!['S', 'M', 'L'].includes(entry.size)) failValidation(`${entry.id}: unknown size`);
    const specRel = safeRelativePath(entry.spec, `${entry.id}: spec`);
    const specPath = resolve(root, specRel);
    if (!inside(root, specPath)) failValidation(`${entry.id}: spec escapes corpus`);
    const specText = await readFile(specPath, 'utf8').catch(() => failValidation(`${entry.id}: spec file is missing`));
    if (!specText.includes('# Task:') || specText.length < 300) failValidation(`${entry.id}: spec is not a substantive English task specification`);
    if (!Array.isArray(entry.expectedArtifacts) || !entry.expectedArtifacts.length) failValidation(`${entry.id}: expectedArtifacts are required`);
    for (const artifact of entry.expectedArtifacts) safeRelativePath(artifact, `${entry.id}: artifact`);
    if (typeof entry.verifier !== 'string' || !entry.verifier) failValidation(`${entry.id}: verifier is required`);
    cases.push(Object.freeze({ ...entry, specPath, specDigest: sha256(specText) }));
  }
  if (CASE_IDS.some(id => !seen.has(id))) failValidation('one or more required case ids are absent');

  const ui = cases.find(entry => entry.id === 'ui-holdout');
  if (typeof ui.holdout !== 'string' || isAbsolute(ui.holdout) || ui.holdout.includes('\0') ||
      !/^\.\.\/holdouts\/[A-Za-z0-9._-]+\.json$/.test(ui.holdout)) {
    failValidation('ui-holdout holdout must be the external benchmark holdout JSON');
  }
  const holdoutPath = resolve(root, ui.holdout);
  if (!inside(resolve(root, '..'), holdoutPath)) failValidation('ui-holdout assertions escape benchmark root');
  let holdout;
  try {
    holdout = JSON.parse(await readFile(holdoutPath, 'utf8'));
  } catch (error) {
    failValidation(`ui-holdout external assertions are missing or malformed (${error.message})`);
  }
  const minimumItems = holdout.assertions?.find(item => item.id === 'minimum-items')?.minimum ?? 0;
  const states = new Set((holdout.assertions ?? []).filter(item => item.kind === 'state-present').map(item => item.state));
  if (holdout.hidden !== true || !Array.isArray(holdout.assertions) || minimumItems <= 10 ||
      !['queued', 'running', 'blocked', 'complete'].every(state => states.has(state)) ||
      !holdout.assertions.some(item => item.id === 'no-native-select')) {
    failValidation('ui-holdout external assertions do not enforce the hidden UI contract');
  }

  const canonical = JSON.stringify(manifest);
  return Object.freeze({
    root,
    manifest: Object.freeze(manifest),
    cases: Object.freeze(cases),
    uiHoldoutPath: holdoutPath,
    corpusDigest: sha256(canonical),
  });
}

function unifiedDiff(path, removed, added) {
  const oldLines = removed.split('\n').filter(Boolean).length;
  const newLines = added.split('\n').filter(Boolean).length;
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines} +1,${newLines} @@`,
    ...removed.split('\n').filter(Boolean).map(line => `-${line}`),
    ...added.split('\n').filter(Boolean).map(line => `+${line}`),
  ].join('\n');
}

function mutantResult(id, target, passed, evidence) {
  return Object.freeze({ id, target, passed: passed === true, bypassed: passed !== true, evidence });
}

async function stageUnattestedMutant() {
  const root = await mkdtemp(join(tmpdir(), 'df-bench-stage-'));
  try {
    const worktree = join(root, 'worktree');
    const journal = join(root, 'journal');
    await mkdir(worktree, { recursive: true, mode: 0o700 });
    await mkdir(journal, { recursive: true, mode: 0o700 });
    let childLaunches = 0;
    const transport = createStageSandboxTransport({
      worktree,
      journal,
      probeDocker: async () => false,
      probeLandlock: async () => false,
      dockerSandbox: async () => { childLaunches += 1; return { code: 0, stdout: '' }; },
      agyTransport: async () => { childLaunches += 1; return { code: 0, stdout: '' }; },
      unpack: async () => {},
    });
    const model = { provider: 'openai', model: 'gpt-6.2-sol' };
    const attested = await assertStageReadOnly(transport, model);
    let observeRejected = false;
    try {
      await transport.observe({
        binding: { task_id: 'benchmark', candidate_sha: 'a'.repeat(40) },
        model,
        prompt: 'Attestation probe',
        challenge: 'c'.repeat(64),
        artifactDigest: 'd'.repeat(64),
      });
    } catch (error) {
      observeRejected = /stage_read_only_transport_not_enrolled/.test(error.message);
    }
    return mutantResult('stage-unattested-readonly', 'stage-sandbox-transport.mjs',
      attested === false && observeRejected && childLaunches === 0,
      `attested=${attested}; observeRejected=${observeRejected}; childLaunches=${childLaunches}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function holdoutBoundaryMutant() {
  const root = await mkdtemp(join(tmpdir(), 'df-bench-holdout-'));
  try {
    const worktree = join(root, 'worktree');
    const nestedHoldout = join(worktree, 'holdouts');
    await mkdir(nestedHoldout, { recursive: true });
    let overlapRejected = false;
    try {
      await validateHoldoutDir(nestedHoldout, worktree);
    } catch (error) {
      overlapRejected = /holdout_(inside|overlaps)_worktree/.test(error.message);
    }
    const leaked = sanitizeHoldoutFeedback({ failures: [{
      scenario_id: '../../../holdouts/private-source',
      failed_assertion_category: 'visual-contract',
      selector: '/holdouts/private/secret-source.css',
    }] });
    const serialized = JSON.stringify(leaked);
    const leakRejected = !serialized.includes('/holdouts/private') && !serialized.includes('../');
    return mutantResult('holdout-path-and-source-leak', 'holdout-runner.mjs',
      overlapRejected && leakRejected,
      `overlapRejected=${overlapRejected}; leakRejected=${leakRejected}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runSecurityMutantSuite({ now = () => Date.now() } = {}) {
  const started = now();
  const tests = [];

  const deletion = analyzeDiff(unifiedDiff('src/app.test.js', "test('works', () => {});", ''));
  tests.push(mutantResult('tamper-test-deletion', 'tamper-gate.mjs',
    deletion.some(v => v.kind === 'test_deleted'), `violations=${deletion.map(v => v.kind).join(',')}`));

  const weakening = analyzeDiff(unifiedDiff('src/app.test.js', '', "test.skip('works', () => {});\nit.only('focused', () => {});"));
  tests.push(mutantResult('tamper-skip-only-weakening', 'tamper-gate.mjs',
    weakening.some(v => v.kind === 'test_skipped'), `violations=${weakening.map(v => v.kind).join(',')}`));

  const secret = analyzeDiff(unifiedDiff('src/app.js', '', 'const token = "ghp_abcdefghijklmnopqrstuvwx";'));
  tests.push(mutantResult('tamper-secret-leak', 'tamper-gate.mjs',
    secret.some(v => v.kind === 'secret_leak'), `violations=${secret.map(v => v.kind).join(',')}`));

  const rmRoot = checkCommand('rm -rf /');
  tests.push(mutantResult('cmd-rm-root-critical', 'cmd-guard.mjs',
    rmRoot.decision === 'block' && rmRoot.severity === 'critical', JSON.stringify(rmRoot)));

  const wrapperBash = checkCommand("bash -c 'rm -rf /'");
  const wrapperXargs = checkCommand('xargs rm -rf <<< /');
  tests.push(mutantResult('cmd-wrapper-evasion', 'cmd-guard.mjs',
    wrapperBash.decision === 'block' && wrapperBash.severity === 'critical' &&
    wrapperXargs.decision === 'block', `bash=${wrapperBash.decision}/${wrapperBash.severity}; xargs=${wrapperXargs.decision}/${wrapperXargs.severity}`));

  const phrase = Array.from({ length: 32 }, (_, index) => `cycle${index}`).join(' ');
  const loopGuard = createStreamLoopGuard({ mode: 'observe', n: 32, armWords: 32, minRepeat: 3 });
  loopGuard.push('content', Array.from({ length: 6 }, () => phrase).join(' '));
  const looped = loopGuard.finish().looped === true;
  tests.push(mutantResult('loop-32-word-repetition', 'loop-detector.mjs', looped, `looped=${looped}`));

  const foreignHost = isAllowedHost('evil.example.com:44110', 44110);
  const foreignOrigin = isAllowedOrigin('https://evil.example.com', 44110);
  tests.push(mutantResult('origin-dns-rebinding-rejection', 'origin-guard.mjs',
    foreignHost === false && foreignOrigin === false, `host=${foreignHost}; origin=${foreignOrigin}`));

  const gated = await applySeverityGating({
    status: 'REWORK',
    verdict: 'REVIEW_BLOCKED',
    findings: [
      { severity: 'P2', file: 'src/a.mjs', line: 1, expected: 'cleaner', actual: 'verbose' },
      { severity: 'nit', file: 'src/a.mjs', line: 2, expected: 'shorter', actual: 'longer' },
    ],
  });
  tests.push(mutantResult('review-p2-nit-not-blocking', 'review-policy.mjs',
    gated.status === 'PASS' && gated.verdict === 'REVIEW_OK', `status=${gated.status}; verdict=${gated.verdict}`));

  tests.push(await holdoutBoundaryMutant());
  tests.push(await stageUnattestedMutant());

  const bypasses = tests.filter(result => result.bypassed).length;
  return Object.freeze({
    total: tests.length,
    passed: tests.length - bypasses,
    bypasses,
    elapsedMs: Math.max(0, now() - started),
    mutants: Object.freeze(tests),
  });
}

function metricSet(raw = {}) {
  return {
    nativeCloseRate: finite(raw.nativeCloseRate ?? raw.native_close_rate),
    firstRoundPassRate: finite(raw.firstRoundPassRate ?? raw.first_round_pass_rate),
    avgRework: finite(raw.avgRework ?? raw.avgReworkRounds ?? raw.avg_rework_rounds),
    wallClockMs: finite(raw.wallClockMs ?? raw.medianWallClockMs ?? raw.median_wall_clock_ms),
    stageWitnessCoverage: finite(raw.stageWitnessCoverage ?? raw.stage_witness_coverage),
  };
}

function gateResult(pass, details) {
  return Object.freeze({ pass: pass === true, ...details });
}

export function evaluateGoNoGo(results = {}) {
  const v15 = metricSet(results.v15 ?? results.v1_5 ?? results.baseline);
  const v2 = metricSet(results.v2 ?? results.foreman);
  const securityBypasses = Number.isSafeInteger(results.securityMutantBypasses)
    ? results.securityMutantBypasses
    : Number.isSafeInteger(results.security?.mutantBypasses)
      ? results.security.mutantBypasses
      : Number.isSafeInteger(results.security?.bypasses)
        ? results.security.bypasses
        : null;
  const wallClockRatio = finite(results.wallClockRatio ?? results.wall_clock_ratio) ??
    (v15.wallClockMs && v2.wallClockMs ? v2.wallClockMs / v15.wallClockMs : null);

  const firstRoundImprovement = v15.firstRoundPassRate != null && v2.firstRoundPassRate != null &&
    v2.firstRoundPassRate + EPSILON >= v15.firstRoundPassRate + 0.15;
  const reworkImprovement = v15.avgRework != null && v2.avgRework != null &&
    v2.avgRework <= v15.avgRework * 0.7 + EPSILON;

  const gates = {
    nativeCloseRate: gateResult(
      v15.nativeCloseRate != null && v2.nativeCloseRate != null &&
      v2.nativeCloseRate + EPSILON >= 0.85 && v2.nativeCloseRate + EPSILON >= v15.nativeCloseRate,
      { actual: v2.nativeCloseRate, baseline: v15.nativeCloseRate, threshold: 0.85,
        rule: 'v2 >= 0.85 and v2 >= v1.5' }),
    qualityImprovement: gateResult(firstRoundImprovement || reworkImprovement,
      { firstRoundPassRate: v2.firstRoundPassRate, baselineFirstRoundPassRate: v15.firstRoundPassRate,
        avgRework: v2.avgRework, baselineAvgRework: v15.avgRework,
        rule: 'firstRoundPassRate >= v1.5 + 0.15 or avgRework <= 0.7 * v1.5' }),
    stageWitnessCoverage: gateResult(v2.stageWitnessCoverage === 1,
      { actual: v2.stageWitnessCoverage, threshold: 1, rule: 'stageWitnessCoverage === 1.0' }),
    securityMutants: gateResult(securityBypasses === 0,
      { bypasses: securityBypasses, threshold: 0, rule: 'securityMutantBypasses === 0' }),
    wallClock: gateResult(wallClockRatio != null && wallClockRatio <= 1.35 + EPSILON,
      { ratio: wallClockRatio, threshold: 1.35, rule: 'wallClockRatio <= 1.35' }),
  };
  const failed = Object.keys(gates).filter(key => !gates[key].pass);
  const go = failed.length === 0;
  return Object.freeze({
    decision: go ? 'GO' : 'NO-GO',
    go,
    failedGates: Object.freeze(failed),
    wallClockRatio,
    gates: Object.freeze(gates),
  });
}

const percent = value => value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const number = value => value == null ? 'n/a' : String(round3(value));
const yesno = value => value ? 'pass' : 'FAIL';
const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

export function renderBenchmarkReport(summary = {}) {
  const evaluation = summary.evaluation ?? {};
  const comparison = summary.comparison ?? {};
  const security = summary.security ?? {};
  const lines = [
    '# V2-6 Warp Factory Benchmark Report',
    '',
    `Mode: \`${summary.mode ?? 'unknown'}\``,
    `Generated: ${summary.generatedAt ?? 'unknown'}`,
    `Decision: **${evaluation.decision ?? 'NO-GO'}**`,
    '',
  ];
  if (summary.simulated) {
    lines.push('> Dry-run comparison rows are simulated harness inputs. They validate scoring and reporting only; they are not release evidence.', '');
  }
  lines.push('## Corpus', '',
    `Digest: \`${summary.corpus?.corpusDigest ?? 'n/a'}\``,
    `Cases: ${summary.corpus?.cases?.length ?? summary.corpus?.caseCount ?? 0}`, '',
    '| Case | Domain | Size | Verifier |', '| --- | --- | --- | --- |');
  for (const item of summary.corpus?.cases ?? []) {
    lines.push(`| ${cell(item.id)} | ${cell(item.domain)} | ${cell(item.size)} | ${cell(item.verifier)} |`);
  }
  lines.push('', '## Security and Tamper Mutant Suite', '',
    `Result: ${security.passed ?? 0}/${security.total ?? 0} controls held; bypasses: ${security.bypasses ?? 'n/a'}; elapsed: ${security.elapsedMs ?? 0}ms`, '',
    '| Mutant | Target | Result | Evidence |', '| --- | --- | --- | --- |');
  for (const mutant of security.mutants ?? []) {
    lines.push(`| ${cell(mutant.id)} | ${cell(mutant.target)} | ${yesno(mutant.passed)} | ${cell(mutant.evidence)} |`);
  }
  lines.push('', '## Paired Comparison', '',
    '| Metric | v1.5 linear | v2 foreman |', '| --- | ---: | ---: |',
    `| Native close rate | ${percent(comparison.v15?.nativeCloseRate)} | ${percent(comparison.v2?.nativeCloseRate)} |`,
    `| First-round pass rate | ${percent(comparison.v15?.firstRoundPassRate)} | ${percent(comparison.v2?.firstRoundPassRate)} |`,
    `| Average rework rounds | ${number(comparison.v15?.avgRework)} | ${number(comparison.v2?.avgRework)} |`,
    `| Wall clock (ms) | ${number(comparison.v15?.wallClockMs)} | ${number(comparison.v2?.wallClockMs)} |`,
    `| Stage witness coverage | n/a | ${percent(comparison.v2?.stageWitnessCoverage)} |`,
    '', '## Go/No-Go Gates', '',
    '| Gate | Result | Rule | Actual |', '| --- | --- | --- | --- |');
  for (const [name, gate] of Object.entries(evaluation.gates ?? {})) {
    const actual = name === 'securityMutants' ? `bypasses=${gate.bypasses}`
      : name === 'wallClock' ? `ratio=${number(gate.ratio)}`
      : name === 'nativeCloseRate' ? percent(gate.actual)
      : name === 'stageWitnessCoverage' ? percent(gate.actual)
      : `first=${percent(gate.firstRoundPassRate)}; rework=${number(gate.avgRework)}`;
    lines.push(`| ${cell(name)} | ${yesno(gate.pass)} | ${cell(gate.rule)} | ${cell(actual)} |`);
  }
  if (evaluation.failedGates?.length) {
    lines.push('', `Failed gates: ${evaluation.failedGates.map(name => `\`${name}\``).join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

function simulatedComparison(cases) {
  const rows = cases.map((entry, index) => Object.freeze({
    case: entry.id,
    v15: Object.freeze({ closed: index !== 5, firstRoundPass: index < 2, rework: 2, wallClockMs: 1000 + index * 100 }),
    v2: Object.freeze({ closed: true, firstRoundPass: index >= 1, rework: index < 3 ? 1 : 2, wallClockMs: 1200 + index * 80 }),
  }));
  return Object.freeze({
    rows,
    v15: Object.freeze({ nativeCloseRate: 5 / 6, firstRoundPassRate: 2 / 6, avgRework: 2, wallClockMs: 1250 }),
    v2: Object.freeze({ nativeCloseRate: 1, firstRoundPassRate: 5 / 6, avgRework: 1.5, wallClockMs: 1400, stageWitnessCoverage: 1 }),
  });
}

async function writeDryRunOutputs(outDir, summary, report) {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const jsonPath = join(outDir, 'factory-benchmark-report.json');
  const markdownPath = join(outDir, 'v2-benchmark-report.md');
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  await writeFile(markdownPath, report, { mode: 0o600 });
  return { jsonPath, markdownPath };
}

export async function runDryRun({ corpusDir = DEFAULT_CORPUS_DIR, outDir = null } = {}) {
  const corpus = await loadBenchmarkCorpus(corpusDir);
  const security = await runSecurityMutantSuite();
  const comparison = simulatedComparison(corpus.cases);
  const evaluation = evaluateGoNoGo({
    v15: comparison.v15,
    v2: comparison.v2,
    securityMutantBypasses: security.bypasses,
  });
  const summary = {
    schema: 1,
    mode: 'dry-run',
    generatedAt: new Date().toISOString(),
    simulated: true,
    corpus: {
      corpusDigest: corpus.corpusDigest,
      caseCount: corpus.cases.length,
      cases: corpus.cases.map(({ id, domain, size, verifier, spec, specDigest }) =>
        ({ id, domain, size, verifier, spec, specDigest })),
    },
    security,
    comparison,
    evaluation,
  };
  const report = renderBenchmarkReport(summary);
  const outputs = outDir ? await writeDryRunOutputs(outDir, summary, report) : null;
  return { ...summary, report, outputs };
}

function normalizeLiveCases(raw) {
  const names = (typeof raw === 'string' && raw.trim() ? raw : 'policy,docs')
    .split(',').map(name => name.trim()).filter(Boolean);
  const mapped = names.map(name => PILOT_CASES.get(name));
  if (!names.length || mapped.some(name => !name) || new Set(mapped).size !== mapped.length) {
    throw new Error('live cases must be a unique comma-separated subset of policy,docs');
  }
  return mapped;
}

function liveMetrics(cells, arm) {
  const rows = cells.filter(row => row.arm === arm);
  if (!rows.length) return metricSet();
  const avg = selector => rows.reduce((sum, row) => sum + selector(row), 0) / rows.length;
  return {
    nativeCloseRate: avg(row => row.closed ? 1 : 0),
    firstRoundPassRate: avg(row => row.first_round_pass ? 1 : 0),
    avgRework: avg(row => row.rework ?? 0),
    wallClockMs: avg(row => row.elapsed_ms ?? 0),
    stageWitnessCoverage: arm === 'foreman'
      ? avg(row => row.stage_witness_coverage ?? (row.stage_witness_covered ? 1 : 0))
      : null,
  };
}

export async function runLive({ root, cases = 'policy,docs', out = null, execImpl = execFileAsync } = {}) {
  if (!isAbsolute(root ?? '')) throw new Error('live mode requires an absolute --root evidence directory');
  const evidenceRoot = await realpath(root);
  if (evidenceRoot !== resolve(root)) throw new Error('live evidence root must be canonical');
  const selected = normalizeLiveCases(cases);
  if (selected.length !== 2 || !selected.includes('policy') || !selected.includes('docs')) {
    throw new Error('live Go/No-Go evidence currently requires both paired cases: policy,docs');
  }
  const corpus = await loadBenchmarkCorpus();

  const runner = join(REPO_ROOT, 'ops', 'ab-pilot-run.mjs');
  const compare = join(REPO_ROOT, 'ops', 'ab-pilot-compare.mjs');
  const runs = [];
  for (const pilotCase of selected) {
    for (const arm of ['linear', 'foreman']) {
      const started = Date.now();
      const result = await execImpl(process.execPath, [
        runner, '--execute', '--case', pilotCase, '--arm', arm, '--root', evidenceRoot,
      ], { timeout: 660_000, maxBuffer: 4 * 1024 * 1024 });
      runs.push({ case: pilotCase, arm, elapsedMs: Date.now() - started,
        outcome: JSON.parse(String(result.stdout).trim().split('\n').at(-1)) });
    }
  }
  const comparisonRaw = await execImpl(process.execPath, [compare, evidenceRoot],
    { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  const pilot = JSON.parse(comparisonRaw.stdout);
  const v15 = liveMetrics(pilot.cells, 'linear');
  const v2 = liveMetrics(pilot.cells, 'foreman');
  const security = await runSecurityMutantSuite();
  const evaluation = evaluateGoNoGo({ v15, v2, securityMutantBypasses: security.bypasses });
  const summary = {
    schema: 1,
    mode: 'live',
    generatedAt: new Date().toISOString(),
    simulated: false,
    corpus: {
      corpusDigest: corpus.corpusDigest,
      caseCount: corpus.cases.length,
      cases: corpus.cases.map(({ id, domain, size, verifier, specDigest }) =>
        ({ id, domain, size, verifier, specDigest })),
      pilotCases: selected,
    },
    security,
    comparison: { v15, v2, pilot },
    evaluation,
    runs,
  };
  const report = renderBenchmarkReport(summary);
  const reportPath = out ?? join(evidenceRoot, 'v2-benchmark-report.md');
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, report, { mode: 0o600 });
  const jsonPath = reportPath.endsWith('.md') ? `${reportPath.slice(0, -3)}.json` : `${reportPath}.json`;
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return { ...summary, report, outputs: { markdownPath: reportPath, jsonPath } };
}

// The historical six-case simulator and two-case foreman pilot above are not
// arms of this experiment. In particular, never rename a foreman receipt v1.2.
// --preset devin-fusion-ab uses the same evidence layout as --mode paired.
// Set plan.preset to that name and enroll runners and cells named baseline
// and fusion at the SAME factory revision. Only the worker pair may differ.
const FUSION_AB = 'devin-fusion-ab';
const FUSION_WORKERS = {
  baseline: { provider: 'pi', model: 'openai/gpt-6.2-astra' },
  fusion: { provider: 'acp-devin', model: 'fusion-gpt-6-2-astra-high-sidekick-swe-2-1-medium' },
};
function pairedArms(plan) {
  if (plan.preset === undefined) return ['v15', 'v12'];
  requirePair(plan.preset === FUSION_AB, 'unknown preset');
  return ['baseline', 'fusion'];
}
function checkFusionWorker(arm, worker) {
  const expected = FUSION_WORKERS[arm];
  requirePair(worker?.provider === expected.provider && worker?.model === expected.model, `${arm}: worker mismatch`);
}
const DOMAINS = ['Code', 'UI', 'Math/Lean', 'DSP/Docs'];

// Portable eight-task enrollment. These argv are recipes for the controller's
// pinned L1 container, never commands to run against a candidate on this host.
const nodeGate = body => ['node', '--input-type=module', '-e', `import assert from 'node:assert/strict';\n${body}`];
const browserGate = body => nodeGate(`import { chromium } from 'playwright'; import {pathToFileURL} from 'node:url';
const browser = await chromium.launch({headless:true});
try { const page = await browser.newPage(); await page.goto(pathToFileURL(process.cwd() + '/index.html').href);
${body}
} finally { await browser.close(); }`);
const leanGate = (name, type) => nodeGate(`import {execFileSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path';
const scratch=mkdtempSync(join(tmpdir(),'bench-lean-'));
execFileSync('lean',['-o',join(scratch,'Bench.olean'),'Bench.lean']);
const audit = execFileSync('lean',['--stdin'],{cwd:scratch,encoding:'utf8',env:{...process.env,LEAN_PATH:scratch},
  input:${JSON.stringify(`import Bench\nexample : ${type} := ${name}\n#print axioms ${name}\n`)}});
if (audit.trim() !== "'${name}' does not depend on any axioms") {
  const axioms=audit.trim().match(/^'${name}' depends on axioms:\\s*\\[([^\\]]*)\\]$/s); assert.ok(axioms,audit);
  assert.ok(axioms[1].split(',').every(x=>['propext','Quot.sound','Classical.choice'].includes(x.trim())));
}`);

export function pairedCorpus() {
  return [
    ['interval-union', 'Code', 'Export union(spans) from task.mjs. Return the sorted union of integer half-open intervals, merging adjacent spans, dropping empty spans and preserving the input.', nodeGate(`import {union} from './task.mjs';
const x=[[4,8],[1,3],[2,4],[9,9],[11,12]]; const orig=structuredClone(x);
assert.deepEqual(union(x),[[1,8],[11,12]]); assert.deepEqual(x,orig); assert.deepEqual(union([]),[]);`)],
    ['stable-toposort', 'Code', 'Export order(prereqs) from task.mjs. Keys name nodes, values list prerequisites. Return a topological order choosing the lexical minimum among ready nodes. Throw on cycles.', nodeGate(`import {order} from './task.mjs';
for(const g of [{d:['c','b'],b:['a'],c:['a'],a:[]},{c:['a'],a:[],b:['a'],d:['b','c']}]) assert.deepEqual(order(g),['a','b','c','d']);
assert.throws(()=>order({a:['b'],b:['a']})); assert.deepEqual(order({}),[]);`)],
    ['queue-filter', 'UI', 'Build offline index.html. Provide #filter (options all, ready, done, hold) and button rows #r0..#r11 (even ready, odd done). Clicking selects via aria-pressed. Filtering hides unmatched rows, preserves visible selection and shows #empty only when there are no matches.', browserGate(`await page.click('#r2'); await page.selectOption('#filter','ready');
assert.deepEqual(await page.locator('button[id^=r]:visible').evaluateAll(xs=>xs.map(x=>x.id)),['r0','r2','r4','r6','r8','r10']);
assert.equal(await page.getAttribute('#r2','aria-pressed'),'true'); assert.equal(await page.isVisible('#empty'),false);
await page.selectOption('#filter','hold'); assert.equal(await page.locator('button[id^=r]:visible').count(),0); assert.ok(await page.isVisible('#empty'));`)],
    ['dialog-focus', 'UI', 'Build offline index.html. #open opens a confirmation dialog and focuses #cancel. Cycle Tab/Shift-Tab between #cancel and #confirm. Escape dismisses and restores focus to #open.', browserGate(`await page.click('#open'); const focus=()=>page.evaluate(()=>document.activeElement.id);
assert.equal(await focus(),'cancel'); for(const [key,id] of [['Shift+Tab','confirm'],['Tab','cancel'],['Tab','confirm'],['Escape','open']]) {
await page.keyboard.press(key); assert.equal(await focus(),id); } assert.equal(await page.isVisible('#confirm'),false);`)],
    ['append-length', 'Math/Lean', 'In Bench.lean prove benchAppend : ∀ (xs ys : List Nat), (xs ++ ys).length = xs.length + ys.length. No sorry or new axioms.', leanGate('benchAppend','∀ (xs ys : List Nat), (xs ++ ys).length = xs.length + ys.length')],
    ['reverse-involution', 'Math/Lean', 'In Bench.lean prove benchReverse : ∀ (xs : List Nat), xs.reverse.reverse = xs. No sorry or new axioms.', leanGate('benchReverse','∀ (xs : List Nat), xs.reverse.reverse = xs')],
    ['fir-response', 'DSP/Docs', 'Export fir(samples) from task.mjs: causal FIR with taps [1,2,1], zero initial history, same length output. Calls are independent.', nodeGate(`import {fir} from './task.mjs';
for(const [x,y] of [[[1,0,0,0],[1,2,1,0]],[[1,2,-1],[1,4,4]],[[0,0],[0,0]],[[],[]]]) assert.deepEqual(fir(x),y);`)],
    ['signal-contract', 'DSP/Docs', 'Write gain.md: document dBFS relative to unit peak amplitude. Include one fenced JSON array of rows {amplitude,dBFS} at amplitudes 1, 0.5 and 0, with silence represented by null, not JSON infinity.', nodeGate(`import {readFileSync} from 'node:fs';
const doc=readFileSync('gain.md','utf8'); assert.match(doc,/unit peak/i); const rows=JSON.parse(doc.match(/\\x60{3}json\\s*([\\s\\S]*?)\\x60{3}/)[1]);
assert.deepEqual(rows.map(r=>r.amplitude),[1,0.5,0]); assert.equal(rows[0].dBFS,0); assert.ok(Number.isFinite(rows[1].dBFS)&&Math.abs(rows[1].dBFS+6.0206)<0.01); assert.equal(rows[2].dBFS,null);`)],
  ].map(([id, domain, brief, argv]) => ({ id, domain, brief, check: { cwd: '.', timeoutMs: 30_000, argv } }));
}
const text = x => typeof x === 'string' && x.trim().length > 0;
const integer = x => Number.isSafeInteger(x) && x >= 0;
const money = x => Number.isFinite(x) && x >= 0;
const gitSha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const jsonFile = async path => JSON.parse(await readFile(path, 'utf8'));
const fileHash = async path => sha256(await readFile(path));
const objectHash = x => sha256(JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
const pinnedCheck = check => /^sha256:[a-f0-9]{64}$/.test(check?.image) &&
  Array.isArray(check.argv) && check.argv.length > 0 && check.argv.every(text) &&
  (check.mounts === undefined || (Array.isArray(check.mounts) && !check.mounts.length));
function requirePair(ok, reason) {
  if (!ok) throw new Error(`paired benchmark: ${reason}`);
}

export function pairedPlan(plan) {
  requirePair(plan?.schema === 1 && Array.isArray(plan.tasks) && plan.tasks.length >= 8 &&
    plan.tasks.length <= 10, 'expected 8-10 tasks');
  const arms = pairedArms(plan);
  for (const arm of arms) {
    const runner = plan.runners?.[arm];
    requirePair(gitSha(runner?.sha) && isAbsolute(runner.path), `unbound ${arm} runner`);
  }
  if (plan.preset === FUSION_AB) {
    requirePair(plan.runners.baseline.sha === plan.runners.fusion.sha, 'Fusion A/B requires identical runner revisions');
  } else requirePair(plan.runners.v15.sha !== plan.runners.v12.sha, 'runner revisions must differ');
  const ids = new Set(), domains = new Set();
  const schedule = plan.tasks.flatMap((t, i) => {
    requirePair(typeof t?.id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(t.id) && !ids.has(t.id) &&
      DOMAINS.includes(t.domain) && gitSha(t.baseSha) && integer(t.maxTokens) && t.maxTokens > 0 &&
      money(t.maxCostUsd) && t.maxCostUsd > 0, `invalid or duplicate task at index ${i}`);
    ids.add(t.id); domains.add(t.domain);
    return (i % 2 ? [...arms].reverse() : arms).map(arm => ({ ...t, arm }));
  });
  requirePair(domains.size === 4, 'all four domains are required');
  return schedule;
}

export function scorePairs(plan, rows) {
  const schedule = pairedPlan(plan);
  const arms = pairedArms(plan), [baseline, candidate] = arms;
  const fusionAB = plan.preset === FUSION_AB;
  requirePair(Array.isArray(rows) && rows.length === schedule.length, 'incomplete matrix');
  const byCell = new Map(rows.map(r => [`${r.id}/${r.arm}`, r]));
  const attempts = new Set(), regressions = [], blockers = new Set();
  for (const task of schedule) {
    const { id, arm, baseSha } = task, r = byCell.get(`${id}/${arm}`);
    requirePair(r && r.baseSha === baseSha && r.runnerSha === plan.runners[arm].sha &&
      digest(r.inputsDigest) && r.inputsDigest === byCell.get(`${id}/${baseline}`)?.inputsDigest &&
      text(r.attemptId) && !attempts.has(r.attemptId), `${id}/${arm} missing, reused or mismatched evidence`);
    attempts.add(r.attemptId);
    if (fusionAB) checkFusionWorker(arm, r.worker);
    requirePair(typeof r.nativeClosed === 'boolean' && typeof r.firstRoundPass === 'boolean' &&
      integer(r.reworkRounds) && (!r.firstRoundPass || (r.nativeClosed && r.reworkRounds === 0)) &&
      integer(r.wallClockMs) && (r.tokens === null || integer(r.tokens)) &&
      (r.costUsd === null || money(r.costUsd)), `${id}/${arm} malformed metrics`);
    if (r.tokens === null || r.costUsd === null) blockers.add(`${id}/${arm}: missing complete accounting`);
    if (r.tokens > task.maxTokens || r.costUsd > task.maxCostUsd) blockers.add(`${id}/${arm}: exceeded budget`);
    if (arm === candidate && byCell.get(`${id}/${baseline}`).nativeClosed && !r.nativeClosed) regressions.push(id);
  }
  const comparison = Object.fromEntries(arms.map(arm => {
    const subset = schedule.filter(t => t.arm === arm).map(t => byCell.get(`${t.id}/${arm}`));
    const n = subset.length;
    const total = k => {
      if (subset.some(r => r[k] === null)) return null;
      const sum = subset.reduce((s, r) => s + Number(r[k]), 0);
      requirePair(k === 'costUsd' ? money(sum) : integer(sum), `unrepresentable ${k} total`);
      return sum;
    };
    return [arm, { tasks: n, nativeClosed: total('nativeClosed'), nativeCloseRate: total('nativeClosed') / n,
      firstRoundPassRate: total('firstRoundPass') / n, reworkRounds: total('reworkRounds'),
      avgReworkRounds: total('reworkRounds') / n, wallClockMs: total('wallClockMs'),
      tokens: total('tokens'), costUsd: total('costUsd'),
      ...(fusionAB ? { reworkRate: subset.filter(r => r.reworkRounds > 0).length / n } : {}) }];
  }));
  let savingsPct;
  if (fusionAB) {
    const { baseline: b, fusion: f } = comparison;
    // Whole-attempt token usage is the quota proxy (not a price estimate).
    // USD is reported separately from settlement; never divide by zero or
    // score a missing receipt as a free sidekick turn.
    const savings = k => b[k] > 0 && f[k] !== null ? finite((b[k] - f[k]) / b[k] * 100) : null;
    savingsPct = { tokens: savings('tokens'), usd: savings('costUsd') };
    if (f.reworkRate > b.reworkRate) blockers.add('Fusion rework rate regressed');
    if (savingsPct.tokens === null || 100n * BigInt(f.tokens) > 85n * BigInt(b.tokens)) {
      blockers.add('net token savings below 15% or unknown');
    }
  }
  if (comparison[candidate].nativeCloseRate < 0.85) blockers.add(`${fusionAB ? 'Fusion' : 'v1.2'} native close rate below 85%`);
  if (regressions.length) blockers.add('new native close failure');
  return { comparison, ...(fusionAB ? { savingsPct } : {}), regressions, blockers: [...blockers], benchmarkVerdict: blockers.size ? 'NO-GO' : 'GO',
    releaseVerdict: 'NO-GO', releaseReason: 'This pair cannot establish v2 foreman superiority over v1.5 linear.' };
}

// Only the accepted factory CLI in an explicitly enrolled, clean runner checkout
// may start a cell. Never accept an executable, shell command or score from a card.
const pairedEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !k.startsWith('GIT_') && !['DF_PROJECT_MEMORY_DIR','DF_DECISION_LEDGER_PATH'].includes(k)));
async function cleanCheckout(path, sha, runner = false) {
  requirePair(isAbsolute(path) && await realpath(path) === path, 'checkout path is not canonical');
  const git = async (...args) => (await execFileAsync('git', ['-C', path, ...args], { env: pairedEnv() })).stdout.trim();
  requirePair(await git('rev-parse', '--show-toplevel') === path && await git('rev-parse', 'HEAD') === sha &&
    !(await git('status', '--porcelain')), `checkout not clean at ${sha}`);
  if (runner) {
    const cli = 'ops/factory-run.mjs';
    requirePair(await git('ls-files', '--error-unmatch', '--', cli) === cli &&
      await realpath(join(path, cli)) === join(path, cli), 'missing tracked factory CLI');
  }
}

async function loadCell(root, t, preset) {
  const dir = join(root, t.id, t.arm), state = join(dir, 'state'), path = join(dir, 'policy.json');
  requirePair(await realpath(dir) === dir && await realpath(path) === path && await realpath(state) === state,
    `${t.id}/${t.arm}: noncanonical cell`);
  const bytes = await readFile(path), policy = JSON.parse(bytes);
  const { boardUrl, owner, label, route, bb, handoffDir, reviewSkillFiles = {}, brief, reviewGate,
    reviewPrompt, ...rules } = policy;
  const { taskId, worktree, ...routeRules } = route;
  const { project, ...worker } = bb;
  const profile = rules.profiles?.[route.checkProfile];
  requirePair(rules.scope === 'isolated' && rules.channel === 'pilot' && rules.release === undefined &&
    rules.projectMemory === undefined && rules.decisionLedger === undefined && rules.questionGate === undefined &&
    /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/api\/board$/.test(boardUrl) && new URL(boardUrl).port !== '44100' &&
    route.finish === 'verified' && typeof taskId === 'string' && /^[1-9]\d*$/.test(taskId) &&
    route.base === t.baseSha && !rules.dynamicBase && rules.foreman === undefined && rules.abPilot === undefined &&
    rules.routing?.mode !== 'active' && integer(rules.waitMs) && rules.waitMs > 0 &&
    [worker, profile?.review, rules.arbiter].every(m => text(m?.provider) && text(m?.model)) &&
    Array.isArray(profile?.checks) && profile.checks.length && profile.checks.every(pinnedCheck) &&
    [profile.check, profile.visual].every(c => c === undefined || pinnedCheck(c)),
    `${t.id}/${t.arm}: expected isolated, task-bound linear policy with fixed models, wait budget and pinned checks`);
  requirePair([worktree, handoffDir].every(p => typeof p === 'string' && isAbsolute(p)) &&
    await realpath(worktree) === worktree && await realpath(handoffDir) === handoffDir,
    `${t.id}/${t.arm}: noncanonical worker paths`);
  const briefBytes = await readFile(brief);
  requirePair(text(briefBytes.toString('utf8')), 'empty task brief');
  const specDigest = sha256(briefBytes);
  let commonWorker = worker;
  if (preset === FUSION_AB) {
    checkFusionWorker(t.arm, worker);
    assertCrossFamily(worker, profile.review);
    assertCrossFamily(worker, rules.arbiter);
    assertCrossFamily(profile.review, rules.arbiter);
    const { provider, model, ...settings } = worker;
    commonWorker = settings; // Only the two pinned treatment fields may differ.
  }
  const inputs = { routeRules, worker: commonWorker, rules, specDigest, reviewPrompt: await fileHash(reviewPrompt),
    reviewGate: await fileHash(reviewGate), routes: await fileHash(join(dirname(reviewGate), 'routes.json')),
    skills: Object.fromEntries(await Promise.all(Object.entries(reviewSkillFiles).map(async ([k, p]) => [k, await fileHash(p)]))),
    maxTokens: t.maxTokens, maxCostUsd: t.maxCostUsd };
  return { ...t, dir, state, path, policyDigest: sha256(bytes), taskId, boardUrl, worktree, handoffDir,
    inputsDigest: objectHash(inputs), specDigest, worker, critic: profile.review, arbiter: rules.arbiter };
}

async function freshSlot(cell) {
  await cleanCheckout(cell.worktree, cell.baseSha);
  const files = await readdir(cell.dir);
  requirePair(!['start.json', 'run.json', 'billing.json'].some(f => files.includes(f)) &&
    !(await readdir(cell.state)).length && !(await readdir(cell.handoffDir)).length, 'slot not fresh');
}

function factoryArgv(cell, runner) {
  return [join(runner.path, 'ops/factory-run.mjs'), '--runtime', 'hc', '--policy', cell.path,
    '--state', cell.state, '--provider', cell.worker.provider, '--model', cell.worker.model, '--stop-on-idle'];
}

async function executeCell(cell, runner, planDigest, checkPins) {
  await cleanCheckout(runner.path, runner.sha, true);
  await freshSlot(cell);
  await checkPins();
  // Exclusive marker: an interrupted run is not silently repeated or dropped.
  const pin = { planDigest, policyDigest: cell.policyDigest, inputsDigest: cell.inputsDigest, runnerSha: runner.sha };
  await writeFile(join(cell.dir, 'start.json'), JSON.stringify(pin), { flag: 'wx', mode: 0o600 });
  const start = performance.now();
  let exit = 0;
  try {
    await execFileAsync(process.execPath, factoryArgv(cell, runner),
      { cwd: runner.path, env: pairedEnv(), maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    exit = error.code; // Native hold is a measured failure, not a missing task.
  }
  const wallClockMs = Math.round(performance.now() - start);
  await checkPins();
  await cleanCheckout(runner.path, runner.sha, true);
  const evidence = { ...pin, exit, wallClockMs, walDigest: await fileHash(join(cell.state, 'attempt.json')),
    telemetryDigest: await fileHash(join(cell.state, 'telemetry.jsonl')) };
  await writeFile(join(cell.dir, 'run.json'), JSON.stringify(evidence), { flag: 'wx', mode: 0o600 });
}

async function readCellResult(c, runnerSha, planDigest) {
  const run = await jsonFile(join(c.dir, 'run.json'));
  const start = await jsonFile(join(c.dir, 'start.json'));
  requirePair(['planDigest','inputsDigest','policyDigest','runnerSha'].every(k => run[k] === start[k]), 'start pin mismatch');
  const walBytes = await readFile(join(c.state, 'attempt.json'));
  const log = await readFile(join(c.state, 'telemetry.jsonl'));
  requirePair(run.planDigest === planDigest && run.policyDigest === c.policyDigest && run.inputsDigest === c.inputsDigest &&
    run.runnerSha === runnerSha && integer(run.exit) && integer(run.wallClockMs) &&
    run.walDigest === sha256(walBytes) && run.telemetryDigest === sha256(log), `${c.id}/${c.arm}: evidence drift`);
  const wal = JSON.parse(walBytes), a = JSON.parse(log.toString('utf8').trim()); // exactly one attempt
  const rounds = a.rounds, nativeClosed = wal.phase === 'done';
  requirePair(a.kind === 'attempt_summary' && a.schema === 1 && a.task_id === c.taskId && wal.taskId === c.taskId &&
    text(a.attempt_id) && a.attempt_id === wal.attemptId && integer(a.epoch) && a.epoch > 0 && a.epoch === wal.epoch &&
    (wal.base_sha === undefined || wal.base_sha === c.baseSha) && a.open === false &&
    ['done','hold','lease_lost','uncertain'].includes(wal.phase) && a.outcome === wal.phase &&
    (!nativeClosed || (run.exit === 0 && gitSha(wal.sha))) &&
    [rounds?.total, rounds?.pass, rounds?.rework].every(integer) && rounds.pass + rounds.rework <= rounds.total &&
    (!nativeClosed || rounds.total > 0), `${c.id}/${c.arm}: unconfirmed native attempt`);
  for (const role of ['worker','critic','arbiter']) {
    const expected = role === 'worker' ? c.worker : c[role];
    const actual = [a.models?.[role], ...(wal.triad ? [wal.triad[role]] : [])];
    requirePair(actual.every(m => ['provider','model'].every(k => m?.[k] === expected[k])), `${c.id}/${c.arm}: ${role} model drift`);
  }
  // Telemetry can omit turns and costs. Only a complete operator/provider
  // settlement export is a whole-attempt total; no multiplying by list price.
  const billing = await jsonFile(join(c.dir, 'billing.json')).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (billing !== null) requirePair(billing.attemptId === a.attempt_id && billing.complete === true &&
    text(billing.source) && integer(billing.tokens) && money(billing.costUsd), `${c.id}/${c.arm}: invalid accounting receipt`);
  return { id: c.id, domain: c.domain, arm: c.arm, taskId: c.taskId, attemptId: a.attempt_id,
    baseSha: c.baseSha, runnerSha, inputsDigest: c.inputsDigest, specDigest: c.specDigest,
    policyDigest: run.policyDigest, walDigest: run.walDigest, telemetryDigest: run.telemetryDigest,
    exit: run.exit, wallClockMs: run.wallClockMs, phase: wal.phase, candidateSha: wal.sha ?? null, nativeClosed,
    firstRoundPass: nativeClosed && rounds.total === 1 && rounds.pass === 1 && rounds.rework === 0,
    reworkRounds: rounds.rework, reportedUsage: a.tokens, reportedCostUsd: a.cost_usd ?? null,
    tokens: billing?.tokens ?? null, costUsd: billing?.costUsd ?? null, accountingSource: billing?.source ?? null,
    accountingDigest: billing ? objectHash(billing) : null };
}

export async function runPaired({ root, execute = false, preset }) {
  requirePair(typeof root === 'string' && isAbsolute(root) && await realpath(root) === root, 'canonical --root required');
  const plan = await jsonFile(join(root, 'plan.json')), planDigest = objectHash(plan);
  requirePair(plan?.preset === preset, 'plan preset mismatch');
  const cells = await Promise.all(pairedPlan(plan).map(t => loadCell(root, t, preset)));
  const arms = pairedArms(plan);
  const specs = new Set(), locations = arms.map(arm => plan.runners[arm].path), cards = new Set();
  for (const c of cells) {
    const slot = `${c.boardUrl}#${c.taskId}`;
    requirePair(!cards.has(slot), 'reused Board card'); cards.add(slot);
    for (const path of [c.worktree, c.handoffDir, c.state]) {
      requirePair(locations.every(p => !inside(path, p) && !inside(p, path)), 'overlapping slots'); locations.push(path);
    }
    const baseline = cells.find(b => b.id === c.id && b.arm === arms[0]);
    requirePair(c.inputsDigest === baseline.inputsDigest, `${c.id}: unequal paired inputs`);
    if (c.arm === arms[0]) {
      requirePair(!specs.has(c.specDigest), 'duplicate task brief'); specs.add(c.specDigest);
    }
  }
  // Detect stale/incomplete enrollment across the entire matrix before spending on the first cell.
  if (execute) {
    for (const { path, sha } of arms.map(arm => plan.runners[arm])) await cleanCheckout(path, sha, true);
    for (const c of cells) {
      await freshSlot(c);
      if (preset === FUSION_AB) {
        // A registry entry is not startup authorization. Ask the pinned
        // controller to validate both arms before spending on either one.
        const runner = plan.runners[c.arm];
        await execFileAsync(process.execPath, [...factoryArgv(c, runner), '--dry-run'],
          { cwd: runner.path, env: pairedEnv(), timeout: 30_000 });
      }
    }
  }
  const rows = [];
  for (const c of cells) {
    const runner = plan.runners[c.arm];
    const checkPins = async () => {
      const now = await loadCell(root, c, preset);
      requirePair(now.inputsDigest === c.inputsDigest && now.policyDigest === c.policyDigest, 'policy changed during benchmark');
    };
    if (execute) await executeCell(c, runner, planDigest, checkPins);
    const row = await readCellResult(c, runner.sha, planDigest);
    if (preset === FUSION_AB) row.worker = c.worker; // readCellResult attested the actual model.
    rows.push(row);
  }
  return { schema: 2, mode: 'paired', ...(preset ? { preset, arms: structuredClone(FUSION_WORKERS) }
    : { arms: { v15: 'v1.5 linear', v12: 'v1.2' } }), planDigest,
    corpusDigest: objectHash(rows.filter(r => r.arm === arms[0]).map(({id, domain, inputsDigest}) => ({id, domain, inputsDigest}))),
    tasks: plan.tasks, rows, ...scorePairs(plan, rows) };
}

export function renderFusionComparison({ comparison: { baseline, fusion }, savingsPct, blockers }) {
  const pct = value => value == null ? 'n/a' : `${number(value)}%`;
  return ['Devin Fusion A/B | baseline | fusion',
    ...[['First-round L2 pass', 'firstRoundPassRate', percent], ['Rework rate', 'reworkRate', percent],
      ['Elapsed (ms)', 'wallClockMs', number], ['Total tokens', 'tokens', number], ['Settled USD', 'costUsd', number]]
      .map(([label, key, format]) => `${label} | ${format(baseline[key])} | ${format(fusion[key])}`),
    `Net savings (tokens as quota proxy / USD): ${pct(savingsPct.tokens)} / ${pct(savingsPct.usd)}`,
    ...blockers].join('\n');
}

export async function runCli(argv = process.argv.slice(2), io = process) {
  const { values } = parseArgs({ args: argv, options: {
    mode: { type: 'string' },
    preset: { type: 'string' },
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
    root: { type: 'string' },
    cases: { type: 'string' },
    execute: { type: 'boolean', default: false },
    corpus: { type: 'string' },
  }, strict: true });

  if (values.preset !== undefined) {
    requirePair(values.preset === FUSION_AB, 'unknown preset');
    requirePair(values.mode === undefined || values.mode === 'paired', 'preset requires paired mode');
  }
  const mode = values.mode ?? (values.preset ? 'paired' : 'dry-run');
  if (mode === 'paired-corpus') {
    requirePair(!values.execute, 'corpus export never executes tasks');
    io.stdout.write(`${JSON.stringify(pairedCorpus(), null, 2)}\n`);
    return 0;
  }
  if (mode === 'paired') {
    requirePair(values.cases === undefined && values.corpus === undefined, 'select tasks in the preregistered plan only');
    const result = await runPaired({ root: values.root, execute: values.execute, preset: values.preset });
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (values.out) await writeFile(values.out, json, { mode: 0o600, flag: 'wx' });
    if (!values.json && values.preset === FUSION_AB) {
      io.stdout.write(`${renderFusionComparison(result)}\n`);
    }
    io.stdout.write(values.json ? json : `pair ${result.benchmarkVerdict}; production ${result.releaseVerdict}\n`);
    return result.benchmarkVerdict === 'GO' ? 0 : 2;
  }
  if (values.execute) throw new Error('--execute is only valid with --mode paired');
  if (mode === 'dry-run') {
    const summary = await runDryRun({ corpusDir: values.corpus ?? DEFAULT_CORPUS_DIR, outDir: values.out ?? null });
    if (values.json) io.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else io.stdout.write(`dry-run ${summary.evaluation.decision}: security ${summary.security.passed}/${summary.security.total} controls held` +
      `${summary.outputs ? `; report=${summary.outputs.markdownPath}` : ''}\n`);
    return summary.evaluation.go ? 0 : 2;
  }
  if (mode === 'live') {
    const summary = await runLive({ root: values.root, cases: values.cases ?? 'policy,docs', out: values.out ?? null });
    if (values.json) io.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else io.stdout.write(`live ${summary.evaluation.decision}: report=${summary.outputs.markdownPath}\n`);
    return summary.evaluation.go ? 0 : 2;
  }
  throw new Error('mode must be dry-run, live, paired-corpus or paired');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    console.error(`factory-benchmark: ${error.message}`);
    process.exitCode = 2;
  }
}
