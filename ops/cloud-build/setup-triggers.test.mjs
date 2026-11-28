import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makePlan, applyPlan } from './setup-triggers.mjs';

const cli = fileURLToPath(new URL('./setup-triggers.mjs', import.meta.url));
const template = readFileSync(new URL('./cloudbuild-template.yaml', import.meta.url), 'utf8');

test('each portfolio trigger uses the reviewed inline build and only main-targeted PRs', () => {
  for (const repo of ['Optimization', 'darkfactory', 'music-restoration', 'autoresearcher']) {
    const { trigger, budget } = makePlan({ repo });
    assert.deepEqual(trigger.github, { owner: 'MyDum-bsu', name: repo,
      pullRequest: { branch: '^main$', commentControl: 'COMMENTS_ENABLED' } });
    assert.equal(trigger.approvalConfig.approvalRequired, true);
    assert.equal(trigger.filename, undefined);
    assert.deepEqual(trigger.build, JSON.parse(template));
    assert.equal(trigger.build.timeout, '600s');
    assert.equal(budget.worstCaseMinutes, 120);
  }
});

function checkSyntaxStep(id, filename, valid, invalid) {
  const cwd = mkdtempSync(join(tmpdir(), 'portfolio-source-'));
  try {
    const step = makePlan().trigger.build.steps.find(step => step.id === id);
    // Simulate Cloud Build literal-dollar expansion, then run the actual argv offline.
    const args = step.args.map(s => s.replaceAll('$$', () => '$'));
    for (const [source, expected] of [[valid, 0], [invalid, 1]]) {
      writeFileSync(join(cwd, filename), source);
      const result = spawnSync(step.entrypoint, args, { cwd, encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, expected, result.stderr);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test('JavaScript step parses without executing and propagates syntax failures', () => {
  checkSyntaxStep('javascript-syntax', 'a b.mjs', 'throw new Error();', 'const = 1;');
});

test('Python step sends regular .py files outside .git to the isolated compiler and propagates its exit', () => {
  const step = makePlan().trigger.build.steps.find(step => step.id === 'python-syntax');
  const cwd = mkdtempSync(join(tmpdir(), 'portfolio-python-contract-'));
  try {
    mkdirSync(join(cwd, '.git'));
    writeFileSync(join(cwd, '.git', 'ignored.py'), '');
    writeFileSync(join(cwd, 'a b.py'), 'raise RuntimeError()');
    symlinkSync('a b.py', join(cwd, 'link.py'));
    writeFileSync(join(cwd, 'other.txt'), '');

    // Intercept find's exec boundary, not the selection or argv construction.
    // The image provides the standard-library compiler; the verifier needs only Node.
    const args = [...step.args];
    const exec = args.indexOf('-exec');
    assert.notEqual(exec, -1);
    args.splice(exec + 1, 0, process.execPath, '-e',
      'console.log(JSON.stringify(process.argv.slice(1))); process.exitCode = Number(process.env.COMPILER_STATUS)');
    for (const status of [0, 1]) {
      const result = spawnSync(step.entrypoint, args, { cwd, encoding: 'utf8', env: { ...process.env, COMPILER_STATUS: String(status) } });
      assert.ifError(result.error);
      assert.equal(result.status, status, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ['python3', '-I', '-S', '-X',
        'pycache_prefix=/tmp/portfolio-pyc', '-m', 'py_compile', './a b.py']);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('admission planning rejects ambiguous numbers and excess shared minutes', () => {
  for (const runsPerDay of [null, 0, -1, 13, 1.5, Infinity, '', '1', NaN]) {
    assert.throws(() => makePlan({ runsPerDay }));
  }
  assert.equal(makePlan({ runsPerDay: 1 }).budget.worstCaseMinutes, 10);
});

test('unreviewed template bytes, unapproved sources and identity fields fail closed', () => {
  for (const input of ['', null, template + '# person@example.invalid', template.replace('600s', '601s'),
    template.replace('steps', 'availableSecrets')]) assert.throws(() => makePlan({}, input));
  for (const options of [{ repo: 'fork/Optimization' }, { repo: null }, { branch: '.*' },
    { project: 'person@example.invalid' }, { project: '/home/user' }, { project: 'ghp_fake' },
    { project: 'ci-555-010-1234' }, { project: 'ci-secret-fixture' }]) {
    assert.throws(() => makePlan(options));
  }
});

test('offline CLI dry-run is byte stable; neither it nor invalid invocations need credentials or write files', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cloud-build-plan-'));
  try {
    writeFileSync(join(cwd, 'gcloud'), '#!/bin/sh\n: > unexpected-gcloud-call\nexit 1\n', { mode: 0o700 });
    writeFileSync(join(cwd, 'offline.mjs'), `import { writeFileSync } from 'node:fs';
      globalThis.fetch = () => { writeFileSync('unexpected-fetch', ''); throw Error('offline'); };`);
    const run = (...args) => spawnSync(process.execPath, ['--import', './offline.mjs', cli, ...args], {
      cwd, encoding: 'utf8', env: { HOME: cwd, PATH: cwd },
    });
    const a = run('--dry-run');
    assert.equal(a.status, 0, a.stderr);
    assert.equal(a.stdout, run().stdout);
    assert.deepEqual(JSON.parse(a.stdout), makePlan());
    for (const args of [['--apply'], ['--dry-run', '--apply'], ['--apply', '--project'],
      ['--runs-per-day', '2e0'], ['--repo', 'a', '--repo', 'Optimization'], ['--secret', 'do-not-echo']]) {
      const r = run(...args);
      assert.notEqual(r.status, 0);
      assert.doesNotMatch(r.stderr, /do-not-echo/);
    }
    assert.deepEqual(readdirSync(cwd).sort(), ['gcloud', 'offline.mjs']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('apply posts precisely the validated trigger once; conflicts do not fall back to update', async () => {
  const plan = makePlan({ project: 'portfolio-ci-test' });
  const calls = [];
  const transport = async (url, request) => { calls.push({ url, request }); return { ok: false, status: 409 }; };
  await assert.rejects(applyPlan(plan, () => 'fixture', transport), /409/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://cloudbuild.googleapis.com/v1/projects/portfolio-ci-test/locations/global/triggers');
  assert.equal(calls[0].request.method, 'POST');
  assert.equal(calls[0].request.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].request.body), plan.trigger);
  plan.trigger.github.pullRequest.branch = '.*';
  await assert.rejects(applyPlan(plan, () => assert.fail('credentials before validation'), transport), /invalid plan/);
  assert.equal(calls.length, 1);
});
