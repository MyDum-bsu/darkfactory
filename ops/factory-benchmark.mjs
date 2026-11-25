#!/usr/bin/env node
// V2-6 Warp Factory benchmark harness. The security mutant suite is fully
// deterministic and local; live A/B evidence is delegated to the sealed pilot
// runner and then evaluated with the explicit Go/No-Go contract.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { analyzeDiff } from '../board_pipeline/tamper-gate.mjs';
import { checkCommand } from '../board_pipeline/cmd-guard.mjs';
import { createStreamLoopGuard } from '../board_pipeline/loop-detector.mjs';
import { isAllowedHost, isAllowedOrigin } from './control-room/origin-guard.mjs';
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
      ], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
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

export async function runCli(argv = process.argv.slice(2), io = process) {
  const { values } = parseArgs({ args: argv, options: {
    mode: { type: 'string', default: 'dry-run' },
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
    root: { type: 'string' },
    cases: { type: 'string' },
    corpus: { type: 'string' },
  }, strict: true });

  if (values.mode === 'dry-run') {
    const summary = await runDryRun({ corpusDir: values.corpus ?? DEFAULT_CORPUS_DIR, outDir: values.out ?? null });
    if (values.json) io.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else io.stdout.write(`dry-run ${summary.evaluation.decision}: security ${summary.security.passed}/${summary.security.total} controls held` +
      `${summary.outputs ? `; report=${summary.outputs.markdownPath}` : ''}\n`);
    return summary.evaluation.go ? 0 : 2;
  }
  if (values.mode === 'live') {
    const summary = await runLive({ root: values.root, cases: values.cases ?? 'policy,docs', out: values.out ?? null });
    if (values.json) io.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else io.stdout.write(`live ${summary.evaluation.decision}: report=${summary.outputs.markdownPath}\n`);
    return summary.evaluation.go ? 0 : 2;
  }
  throw new Error('mode must be dry-run or live');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    console.error(`factory-benchmark: ${error.message}`);
    process.exitCode = 2;
  }
}
