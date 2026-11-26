import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  analyzeMoTrackerUiHtml,
  buildHoldoutDockerArgv,
  evaluateHoldoutScenarios,
  holdoutDigest,
  runHoldoutL3,
  sanitizeHoldoutFeedback,
  validateHoldoutDir,
} from './holdout-runner.mjs';
import { buildUiVisualL3Profile, evaluateSatisfactionReport } from './runtime.mjs';
import { assertPackagedCaptures, collectValidatedPngs, stageVisualCaptures, validatePngBytes, validatePngFile } from './visual-captures.mjs';
import { isolatedNeonReviewRunner } from './neon-review.mjs';
import { agyStreamFixture, commitFile, neonFixture } from './review-test-fixture.mjs';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const IMAGE = `sha256:${'a'.repeat(64)}`;
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }];

async function fixture(t, name = 'v24-holdout-') {
  const root = await realpath(await mkdtemp(join(tmpdir(), name)));
  const worktree = join(root, 'worktree');
  const outside = join(root, 'private-holdouts');
  await mkdir(worktree);
  await mkdir(outside);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, worktree, outside };
}

async function writeScenario(dir, body, name = 'scenario.json') {
  await writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
}

test('holdoutDir validation rejects worktree placement and symlink escapes', async t => {
  const { root, worktree, outside } = await fixture(t);
  const inside = join(worktree, 'holdouts');
  await mkdir(join(worktree, 'holdouts'), { recursive: true });
  await assert.rejects(validateHoldoutDir(inside, worktree), /holdout_inside_worktree/);
  await assert.rejects(validateHoldoutDir(worktree, worktree), /holdout_inside_worktree/);

  const link = join(root, 'holdout-link');
  await symlink(inside, link, 'dir');
  await assert.rejects(validateHoldoutDir(link, worktree), /holdout_dir_invalid/);

  const parentLink = join(root, 'parent-link');
  await symlink(worktree, parentLink, 'dir');
  await assert.rejects(validateHoldoutDir(join(parentLink, 'holdouts'), worktree), /holdout_dir_invalid/);

  await writeScenario(outside, { id: 'ok', assertions: { unstyledControls: 0 } });
  assert.equal(await validateHoldoutDir(outside, worktree), outside);
  await assert.rejects(validateHoldoutDir('/', worktree), /holdout_dir_invalid/);

  const escaping = join(root, 'escaping');
  await mkdir(escaping);
  await writeScenario(escaping, { id: 'ok', assertions: { unstyledControls: 0 } });
  await symlink(join(worktree, 'worker-readable.txt'), join(escaping, 'escape.json'));
  await assert.rejects(holdoutDigest(escaping), /holdout_unsafe_entry/);
});

test('holdout digest is deterministic across scan order and changes with bytes', async t => {
  const { outside } = await fixture(t);
  await writeScenario(join(outside), '{"z":2}\n', 'z.json');
  await mkdir(join(outside, 'nested'));
  await writeScenario(join(outside, 'nested'), '{"a":1}\n', 'a.json');
  const first = await holdoutDigest(outside);
  const second = await holdoutDigest(outside);
  assert.equal(first.holdout_digest, second.holdout_digest);
  assert.match(first.holdout_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.files.map(file => file.path), ['nested/a.json', 'z.json']);
  await writeFile(join(outside, 'z.json'), '{"z":3}\n');
  assert.notEqual((await holdoutDigest(outside)).holdout_digest, first.holdout_digest);
});

test('offline holdout docker argv is array-safe, read-only and digest-bound', async t => {
  const { worktree, outside } = await fixture(t);
  await writeScenario(outside, { id: 's', assertions: { unstyledControls: 0 } });
  const argv = buildHoldoutDockerArgv({ holdoutDir: outside, image: IMAGE,
    argv: ['node', 'ui-check.mjs'], cwd: '/candidate/tracker/web' });
  assert.ok(argv.includes('--network=none'));
  assert.ok(argv.includes('--read-only'));
  assert.ok(argv.includes('--memory=2g'));
  assert.ok(argv.includes('--pids-limit=256'));
  assert.ok(argv.includes('--cpus=2'));
  assert.ok(argv.includes(`type=bind,src=${outside},dst=/holdouts,readonly`));
  assert.equal(argv.at(-1), 'ui-check.mjs');
  const name = argv[argv.indexOf('--name') + 1];
  assert.match(name, /^df-holdout-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const second = buildHoldoutDockerArgv({ holdoutDir: outside, image: IMAGE, argv: ['node'] });
  assert.notEqual(second[second.indexOf('--name') + 1], name);
  const customName = 'df-holdout-00112233-4455-6677-8899-aabbccddeeff';
  const custom = buildHoldoutDockerArgv({ holdoutDir: outside, image: IMAGE, argv: ['node'],
    memory: '512m', pidsLimit: 64, cpus: 1.5, name: customName });
  assert.ok(custom.includes('--memory=512m'));
  assert.ok(custom.includes('--pids-limit=64'));
  assert.ok(custom.includes('--cpus=1.5'));
  assert.equal(custom[custom.indexOf('--name') + 1], customName);
  assert.throws(() => buildHoldoutDockerArgv({ holdoutDir: outside, image: IMAGE,
    argv: ['node'], cwd: '/candidate-evil' }), /holdout_recipe_invalid/);
  assert.throws(() => buildHoldoutDockerArgv({ holdoutDir: '/tmp/h,readonly=false', image: IMAGE,
    argv: ['node'] }), /holdout_dir_invalid/);
  for (const overrides of [
    { memory: '0g' }, { memory: '2g;echo-evil' }, { pidsLimit: 0 }, { pidsLimit: 1.5 },
    { cpus: 0 }, { cpus: Number.NaN }, { cpus: 65 }, { name: 'evil' },
  ]) {
    assert.throws(() => buildHoldoutDockerArgv({ holdoutDir: outside, image: IMAGE,
      argv: ['node'], ...overrides }), /holdout_recipe_invalid/, JSON.stringify(overrides));
  }

  const calls = [];
  const injected = async (file, args, options) => {
    calls.push([file, args, options]);
    return { stdout: 'ok', stderr: '' };
  };
  const result = await runHoldoutL3({ holdoutDir: outside, worktree, image: IMAGE,
    argv: ['node', 'ui-check.mjs'], execDocker: injected });
  assert.equal(result.ok, true);
  assert.match(result.holdout_digest, /^[a-f0-9]{64}$/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'docker');
  assert.deepEqual(calls[0][1], result.docker_argv);
  const runName = result.docker_argv[result.docker_argv.indexOf('--name') + 1];
  assert.deepEqual(calls[1], ['docker', ['rm', '-f', runName], { timeout: 30_000, maxBuffer: 1024 * 1024 }]);

  const failing = await runHoldoutL3({ holdoutDir: outside, worktree, image: IMAGE,
    argv: ['node', 'ui-check.mjs'], execDocker: async () => { throw Object.assign(new Error('exit'), {
      code: 2, stdout: 'raw output must not be trusted', stderr: '' }); } });
  assert.equal(failing.ok, false);
  assert.equal(failing.feedback.verdict, 'REWORK');
  assert.equal(JSON.stringify(failing.feedback).includes('raw output must not be trusted'), false);

  const structured = await runHoldoutL3({ holdoutDir: outside, worktree, image: IMAGE,
    argv: ['node', 'ui-check.mjs'], execDocker: async () => { throw Object.assign(new Error('exit'), {
      code: 2, stdout: JSON.stringify({ failures: [{ scenario_id: 'rows', failed_assertion_category: 'uncollapsed-long-list',
        viewport: '1024x768', selector: '.mo-row:nth-child(25)', coordinates: { x: 12, y: 420 } }] }), stderr: '' }); } });
  assert.equal(structured.feedback.failures[0].failed_assertion_category, 'uncollapsed-long-list');
  assert.deepEqual(structured.feedback.failures[0].coordinates, { x: 12, y: 420 });

  const exitZeroFailure = await runHoldoutL3({ holdoutDir: outside, worktree, image: IMAGE,
    argv: ['node', 'ui-check.mjs'], execDocker: async () => ({ stdout: JSON.stringify({ failures: [{
      scenario_id: 'rows', failed_assertion_category: 'uncollapsed-long-list' }] }), stderr: '' }) });
  assert.equal(exitZeroFailure.exit, 0);
  assert.equal(exitZeroFailure.feedback.verdict, 'REWORK');
  assert.equal(exitZeroFailure.ok, false, 'structured failure dominates a zero process exit');
});

test('holdout docker finally cleanup removes the unique named container on timeout and does not mask results', async t => {
  const { worktree, outside } = await fixture(t);
  await writeScenario(outside, { id: 's', assertions: { unstyledControls: 0 } });

  const calls = [];
  const timeoutError = Object.assign(new Error('timeout'), {
    code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' });
  const timedOut = await runHoldoutL3({ holdoutDir: outside, worktree, image: IMAGE,
    argv: ['node', 'ui-check.mjs'], execDocker: async (file, args, options) => {
      calls.push([file, args, options]);
      if (args[0] === 'run') throw timeoutError;
      return { stdout: '', stderr: '' };
    } });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.exit, null);
  assert.equal(timedOut.feedback.verdict, 'REWORK');
  assert.equal(timedOut.feedback.failures[0].failed_assertion_category, 'execution-failure');
  assert.equal(calls.length, 2);
  const runArgs = calls[0][1];
  const name = runArgs[runArgs.indexOf('--name') + 1];
  assert.match(name, /^df-holdout-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(calls[1], ['docker', ['rm', '-f', name], { timeout: 30_000, maxBuffer: 1024 * 1024 }]);

  const successful = await runHoldoutL3({ holdoutDir: outside, worktree, image: IMAGE,
    argv: ['node', 'ui-check.mjs'], execDocker: async (file, args) => {
      if (args[0] === 'rm') throw new Error('cleanup unavailable');
      return { stdout: 'ok', stderr: '' };
    } });
  assert.equal(successful.ok, true, 'best-effort cleanup failure must not mask the holdout result');
});

test('sanitizeHoldoutFeedback emits only structured symptoms with zero source, secret, ANSI or path leaks', () => {
  const secret = 'sk-live-secret-123';
  const scenarioText = 'click the hidden compliance row';
  const hostPath = '/holdouts/private/scenario.json';
  const feedback = sanitizeHoldoutFeedback({ failures: [
    { scenario_id: `\u001b[31m${hostPath}`, failed_assertion_category: `secret-${secret}`,
      viewport: '1440x900', selector: `xpath=/holdouts/private x`, coordinates: { x: 40, y: 50, width: 100, height: 20 },
      message: scenarioText, file: hostPath, secret },
    { scenario_id: 'mo-tracker-rows', failed_assertion_category: 'uncollapsed-long-list',
      viewport: { width: 1024, height: 768 }, selector: '.mo-row:nth-child(25)',
      coordinates: { x: 16, y: 420, width: 900, height: 28 } },
  ] });
  assert.equal(feedback.verdict, 'REWORK');
  assert.equal(feedback.failures.length, 2);
  const encoded = JSON.stringify(feedback);
  for (const forbidden of [secret, scenarioText, hostPath, '/holdouts', '\u001b']) {
    assert.equal(encoded.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(feedback.failures[0], { scenario_id: 'scenario-1', failed_assertion_category: 'unspecified',
    viewport: { width: 1440, height: 900 }, coordinates: { x: 40, y: 50, width: 100, height: 20 } });
  assert.deepEqual(feedback.failures[1], { scenario_id: 'mo-tracker-rows', failed_assertion_category: 'uncollapsed-long-list',
    viewport: { width: 1024, height: 768 }, selector: '.mo-row:nth-child(25)',
    coordinates: { x: 16, y: 420, width: 900, height: 28 } });
});

test('sanitizer neutralizes bidi controls and both OSC termination forms', () => {
  const bidi = `mo-\u202e\u2066rows`;
  const oscBel = `row-\x1b]0;secret-title\x07visible`;
  const oscSt = `row-\x1b]0;secret-title\x1b\\visible`;
  const feedback = sanitizeHoldoutFeedback({ failures: [
    { scenario_id: bidi, failed_assertion_category: 'unstyled-control' },
    { scenario_id: oscBel, failed_assertion_category: 'unstyled-control' },
    { scenario_id: oscSt, failed_assertion_category: 'unstyled-control' },
  ] });
  const encoded = JSON.stringify(feedback);
  for (const forbidden of ['\u202e', '\u2066', 'secret-title', '\x1b']) {
    assert.equal(encoded.includes(forbidden), false, forbidden);
  }
  assert.equal(feedback.failures[0].scenario_id, 'scenario-1');
});

test('sanitizer blocks token-shaped ids and free-text selector payloads', () => {
  const token = 'sk-live-' + 'a'.repeat(32);
  const phrase = 'hidden private holdout expectation';
  const feedback = sanitizeHoldoutFeedback({ failures: [{
    scenario_id: token,
    failed_assertion_category: 'unstyled-control',
    selector: phrase,
  }] });
  const serialized = JSON.stringify(feedback);
  assert.equal(feedback.failures.length, 1);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(phrase), false);
});

test('PNG validation is fail-closed for magic, truncation, symlink, traversal and byte limits', async t => {
  const { root } = await fixture(t, 'v24-png-');
  assert.equal(validatePngBytes(PNG_1X1).width, 1);
  assert.throws(() => validatePngBytes(Buffer.from('not a png at all')), /png_invalid/);
  assert.throws(() => validatePngBytes(PNG_1X1.subarray(0, 24)), /png_invalid/);
  assert.throws(() => validatePngBytes(Buffer.concat([PNG_1X1, Buffer.from('x')])), /png_invalid/);
  assert.throws(() => validatePngBytes(PNG_1X1, { maxBytes: 10 }), /byte_limit/);

  const captures = join(root, 'captures');
  await mkdir(captures);
  const file = join(captures, 'screen.png');
  await writeFile(file, PNG_1X1);
  assert.equal((await validatePngFile(file)).width, 1);
  const link = join(captures, 'linked.png');
  await symlink(file, link);
  await assert.rejects(collectValidatedPngs(captures), /png_capture_unsafe/);
  await rm(link);

  const huge = join(root, 'huge.png');
  await writeFile(huge, Buffer.concat([PNG_1X1, Buffer.alloc(2 * 1024 * 1024)]));
  await assert.rejects(validatePngFile(huge), /png_invalid/);

  const target = join(root, 'snapshot', 'captures');
  await mkdir(join(root, 'snapshot'));
  const staged = await stageVisualCaptures({ capturesDir: captures, targetDir: target });
  assert.equal(staged.count, 1);
  assert.equal(staged.files[0].file, 'captures/screen.png');
  assert.equal((await readFile(join(target, 'screen.png'))).equals(PNG_1X1), true);
  assert.deepEqual(await assertPackagedCaptures(join(root, 'snapshot')), { present: true, count: 1 });
  await writeFile(join(target, 'evil.txt'), 'not a capture');
  await assert.rejects(assertPackagedCaptures(join(root, 'snapshot')), /png_capture_unexpected_file/);
  await rm(join(target, 'evil.txt'));
  await rm(join(target, 'screen.png'));
  await assert.rejects(assertPackagedCaptures(join(root, 'snapshot')), /png_capture_missing/);
});

test('validated PNG captures are packaged into the Neon review snapshot and invalid bytes stop before transport', async t => {
  const { repo, journal, binding, profile } = await neonFixture(t);
  const candidate_sha = await commitFile(repo, 'export const sum = (a,b) => a+b;\n');
  const subject_digest = 'a'.repeat(64);
  const captureRoot = await realpath(await mkdtemp(join(tmpdir(), 'v24-neon-captures-')));
  t.after(() => rm(captureRoot, { recursive: true, force: true }));
  const capturesDir = join(captureRoot, 'captures');
  await mkdir(capturesDir);
  await writeFile(join(capturesDir, 'mo-tracker-ready-1440x900.png'), PNG_1X1);
  const sandbox = async () => ({ code: 0, stdout: '["candidate/sum.js"]' });
  const verdict = { verdict: 'PASS', subject_digest, summary: 'ok', findings: [], checked_invariants: ['ui'] };
  let transportCalls = 0;
  const runner = isolatedNeonReviewRunner({ journal, sandbox, capturesDir,
    transport: async ({ prompt, snapshot: cwd, publishSnapshot }) => {
      transportCalls++;
      assert.match(prompt, /validated PNG capture/);
      await publishSnapshot();
      const packaged = JSON.parse(await readFile(join(cwd, 'captures.json'), 'utf8'));
      assert.equal(packaged.length, 1);
      assert.equal((await readFile(join(cwd, 'captures', 'mo-tracker-ready-1440x900.png'))).equals(PNG_1X1), true);
      return { code: 0, cwd, stdout: agyStreamFixture(verdict, { cwd, reads: ['candidate/sum.js'] }) };
    } });
  const receipt = await runner({ ...binding, candidate_sha, subject_digest }, profile);
  assert.equal(receipt.verdict, 'REVIEW_OK');
  assert.equal(receipt.captures.count, 1);
  assert.match(receipt.captures.sha256, /^[a-f0-9]{64}$/);
  assert.equal(transportCalls, 1);

  await writeFile(join(capturesDir, 'mo-tracker-ready-1440x900.png'), 'fake png');
  await assert.rejects(runner({ ...binding, candidate_sha, subject_digest }, profile), /png_invalid/);
  assert.equal(transportCalls, 1, 'invalid capture never reaches the model transport');
});

function passReport() {
  return { viewports: ['1440x900', '1024x768'], consoleErrors: 0, a11yViolations: 0,
    unstyledControls: 0, uncollapsedLongLists: 0, missingStates: 0, holdoutFailures: 0,
    satisfactionScore: 85, violations: [] };
}

test('evaluateSatisfactionReport enforces zero counters, score >=85 and exact viewport coverage', () => {
  assert.equal(evaluateSatisfactionReport(passReport()).verdict, 'PASS');
  const detail = { scenario_id: 'mo', failed_assertion_category: 'unstyled-control',
    viewport: '1440x900', selector: '.raw-select', coordinates: { x: 20, y: 30, width: 200, height: 32 } };
  for (const key of ['unstyledControls', 'uncollapsedLongLists', 'consoleErrors', 'a11yViolations', 'holdoutFailures']) {
    const result = evaluateSatisfactionReport({ ...passReport(), [key]: 1, violations: [detail] });
    assert.equal(result.verdict, 'REWORK', key);
    assert.equal(result.defects.length, 1);
  }
  const unstyled = evaluateSatisfactionReport({ ...passReport(), unstyledControls: 1, violations: [detail] });
  assert.equal(unstyled.defects[0].category, 'unstyled-control');
  assert.deepEqual(unstyled.defects[0].coordinates, detail.coordinates);
  assert.equal(unstyled.defects[0].selector, detail.selector);
  assert.equal(evaluateSatisfactionReport({ ...passReport(), satisfactionScore: 84 }).defects[0].category,
    'low-satisfaction-score');
  assert.equal(evaluateSatisfactionReport({ ...passReport(), a11yCritical: 1 }).verdict, 'REWORK');
  assert.equal(evaluateSatisfactionReport({ ...passReport(), viewports: ['1440x900'] }).defects
    .some(defect => defect.category === 'viewport-coverage-missing'), true);
});

function qualityHtml(rows = 25) {
  return `<!doctype html><html><body>
<main data-state="ready" class="shell">
  <section data-state="loading" aria-busy="true" class="state state-loading">Loading</section>
  <section data-state="empty" class="state state-empty">No objects</section>
  <section data-state="error" class="state state-error">Could not load <button class="button-control">Retry</button></section>
  <label class="field-label">Status <select class="select-control" aria-label="Status"><option>Open</option></select></label>
  <input class="input-control" aria-label="Search" value="synthetic" />
  <ul class="object-list" data-collapsed="true">${Array.from({ length: rows }, (_, i) => `<li class="mo-row">Synthetic ${i}</li>`).join('')}</ul>
</main></body></html>`;
}

function mutantHtml(rows = 25) {
  return `<!doctype html><html><body>
<main data-state="ready" class="shell">
  <section data-state="loading" aria-busy="true">Loading</section>
  <section data-state="empty">No objects</section>
  <section data-state="error">Could not load</section>
  <select aria-label="Status"><option>Open</option></select>
  <ul>${Array.from({ length: rows }, (_, i) => `<li>Synthetic mutant ${i}</li>`).join('')}</ul>
</main></body></html>`;
}

function mergedReport(html) {
  const analyses = VIEWPORTS.map(viewport => analyzeMoTrackerUiHtml(html, viewport));
  const violations = analyses.flatMap(analysis => analysis.violations);
  const max = key => Math.max(...analyses.map(analysis => analysis[key]));
  return { viewports: VIEWPORTS.map(({ width, height }) => `${width}x${height}`),
    unstyledControls: max('unstyledControls'), uncollapsedLongLists: max('uncollapsedLongLists'),
    missingStates: max('missingStates'), consoleErrors: 0, a11yViolations: 0, a11yCritical: 0,
    holdoutFailures: 0, satisfactionScore: Math.min(...analyses.map(analysis => analysis.satisfactionScore)),
    violations };
}

async function moSandboxCase(t, html, { mutant }) {
  const { worktree, outside } = await fixture(t, mutant ? 'v24-mo-mutant-' : 'v24-mo-pass-');
  await mkdir(join(worktree, 'tracker', 'data'), { recursive: true });
  await writeFile(join(worktree, 'tracker', 'data', 'tracker.db'), 'live bytes must never be read');
  const secret = 'HOLDOUT_SOURCE_SECRET_NEVER_LEAK';
  await writeScenario(outside, {
    id: mutant ? 'mutant-detector' : 'quality-baseline', viewport: '1440x900', secret,
    assertions: { unstyledControls: 0, uncollapsedLongLists: 0, satisfactionScore: mutant ? 85 : 100 },
  });
  const report = mergedReport(html);
  const holdout = await evaluateHoldoutScenarios({ holdoutDir: outside, worktree, report });
  const evaluated = evaluateSatisfactionReport({ ...report, holdoutFailures: holdout.holdoutFailures,
    violations: [...report.violations, ...holdout.feedback.failures] });
  return { report, holdout, evaluated, secret, worktree };
}

test('sandbox reference: quality MO Tracker UI passes both viewports and holdout', async t => {
  const outcome = await moSandboxCase(t, qualityHtml(), { mutant: false });
  assert.equal(outcome.report.satisfactionScore, 100);
  assert.equal(outcome.holdout.holdoutFailures, 0);
  assert.equal(outcome.holdout.feedback.verdict, 'PASS');
  assert.equal(outcome.evaluated.verdict, 'PASS');
  assert.match(outcome.holdout.holdout_digest, /^[a-f0-9]{64}$/);
});

test('sandbox reference: raw select plus 25-row uncollapsed list gets deterministic REWORK without leaks or live DB access', async t => {
  const outcome = await moSandboxCase(t, mutantHtml(), { mutant: true });
  assert.equal(outcome.report.unstyledControls, 1);
  assert.equal(outcome.report.uncollapsedLongLists, 1);
  assert.equal(outcome.holdout.holdoutFailures, 3);
  assert.equal(outcome.evaluated.verdict, 'REWORK');
  const categories = outcome.evaluated.defects.map(defect => defect.category);
  assert.ok(categories.includes('unstyled-control'));
  assert.ok(categories.includes('uncollapsed-long-list'));
  assert.ok(categories.includes('low-satisfaction-score'));
  const coordinateDefects = outcome.evaluated.defects.filter(defect => defect.coordinates);
  assert.ok(coordinateDefects.length >= 2);
  for (const defect of coordinateDefects) {
    assert.ok(Number.isFinite(defect.coordinates.x));
    assert.ok(Number.isFinite(defect.coordinates.y));
    assert.ok(defect.viewport.width === 1440 || defect.viewport.width === 1024);
  }
  const encoded = JSON.stringify({ feedback: outcome.holdout.feedback, defects: outcome.evaluated.defects });
  assert.equal(encoded.includes(outcome.secret), false);
  assert.equal(encoded.includes('/holdouts'), false);
  assert.equal(encoded.includes('tracker/data/tracker.db'), false);
  assert.throws(() => buildUiVisualL3Profile({ image: IMAGE, argv: ['node', 'check.mjs'],
    trackerDb: join(outcome.worktree, 'tracker', 'data', 'tracker.db') }), /mo_tracker_live_db_forbidden/);
});
