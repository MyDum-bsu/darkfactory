// Networked acceptance checks. Run explicitly via npm run test:live:review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isolatedArbiterRunner, isolatedPiReviewRunner } from './review-runner.mjs';
import { isolatedNeonReviewRunner } from './neon-review.mjs';
import { NEON_CRITIC, NEON_ISOLATION, SOL_ARBITER } from './review-policy.mjs';
import { makeRepo, commitFile, neonFixture, SPEC } from './review-test-fixture.mjs';

const exec = promisify(execFile);
const CRITIC = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };

test('Pi critic live: isolatedPiReviewRunner на read-only снимке', async () => {
  let rootless = false;
  try {
    rootless = JSON.parse((await exec('docker', ['info', '--format',
      '{{json .SecurityOptions}}'], { timeout: 12_000 })).stdout).includes('name=rootless');
  } catch { /* docker недоступен */ }
  const piRoot = join(homedir(), '.pi', 'agent');
  const piReady = (await lstat(join(piRoot, 'bin')).catch(() => null)) !== null &&
    (await lstat(join(piRoot, 'auth.json')).catch(() => null)) !== null;
  assert.ok(rootless && piReady, 'rootless Docker and Pi agent home are required for live acceptance');

  const repo = await makeRepo();
  const journal = await mkdtemp(join(tmpdir(), 'review-it-journal-'));
  const runner = isolatedPiReviewRunner({ journal, piRoot, prompt: SPEC });
  const profile = { review: CRITIC, executor: 'acp-devin/swe-2-high' };
  try {
    // Кандидат с явным семантическим дефектом против спеки → аттестованный REWORK.
    const buggy = await commitFile(repo,
      'export function sum(a, b) {\n  return a + b + 1;\n}\n');
    const rework = await runner(
      { task_id: '9001', candidate_sha: buggy, worktree: repo }, profile);
    assert.equal(rework.sha, buggy);
    assert.equal(rework.verdict, 'REVIEW_BLOCKED');
    assert.equal(rework.status, 'REWORK');
    assert.ok(rework.findings.length > 0 || (rework.excerpt ?? '').trim(),
      'REWORK обязан нести содержательное возражение');
    assert.match(rework.transcript_sha256, /^[0-9a-f]{64}$/);
    assert.match(rework.checkpoint, /^[0-9a-f]{8,64}$/);
    assert.deepEqual(rework.actual, CRITIC);
    assert.equal(rework.isolation, 'docker-ro-v1');
    assert.equal((await lstat(join(journal, rework.transcript_file))).mode & 0o777, 0o600);

    // Исправленный коммит → PASS.
    const fixed = await commitFile(repo,
      'export function sum(a, b) {\n  return a + b;\n}\n');
    const pass = await runner(
      { task_id: '9001', candidate_sha: fixed, worktree: repo }, profile);
    assert.equal(pass.sha, fixed);
    assert.equal(pass.verdict, 'REVIEW_OK');
    assert.equal(pass.status, 'PASS');
    assert.deepEqual(pass.actual, CRITIC);

    // Отказ кросс-семейственного инварианта до запуска контейнера.
    await assert.rejects(
      runner({ task_id: '9001', candidate_sha: fixed, worktree: repo },
        { review: CRITIC, executor: 'openai/gpt-6.2-astra' }),
      (e) => e.reason === 'review_same_family');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
  }
});

test('Sol arbiter live: isolated actual model, medium effort and exact review subject', async t => {
  const journal = await mkdtemp(join(tmpdir(), 'sol-arbiter-it-'));
  t.after(() => rm(journal, { recursive: true, force: true }));
  const subject_digest = 'a'.repeat(64);
  const run = isolatedArbiterRunner({ journal, prompt: SPEC });
  const decision = await run({ task_id: '9003', attempt_id: 'test-arbitration', epoch: 1,
    subject_digest, arbiter: SOL_ARBITER, trigger: { trigger: 'dispute' }, evidence: {
      findings: [{ file: 'sum.js', input: 'sum(2,2)', expected: '4', actual: '5', harm: 2 }],
      dispute: { claim: 'Returning 5 for sum(2,2) satisfies this spec.' },
    } });
  assert.equal(decision.subject_digest, subject_digest);
  assert.equal(decision.decision, 'directed_rework');
});

test('Neon live: medium model reads the snapshot and returns bound REWORK then PASS', async t => {
  const { repo, journal, binding, profile } = await neonFixture(t, {
    'contract.txt': SPEC + '\n',
    'unrelated-archive.txt': 'fixture archive\n'.repeat(45_000),
  });
  const prompt = 'Judge sum.js against the rule in candidate/contract.txt. Use read_file yourself on both exact paths ' +
    'candidate/contract.txt and candidate/sum.js before returning the verdict. Do not delegate or read unrelated-archive.txt.';
  const run = isolatedNeonReviewRunner({ journal, prompt });
  for (const [expression, status, digit] of [['a + b + 1', 'REWORK', 'b'], ['a + b', 'PASS', 'c']]) {
    const candidate_sha = await commitFile(repo, `export function sum(a, b) { return ${expression}; }\n`);
    const subject_digest = digit.repeat(64);
    const receipt = await run({ ...binding, candidate_sha, subject_digest }, profile);
    assert.equal(receipt.status, status);
    assert.equal(receipt.subject_digest, subject_digest);
    assert.deepEqual(receipt.actual, NEON_CRITIC);
    assert.equal(receipt.isolation, NEON_ISOLATION);
    assert.deepEqual(receipt.attestation, { model: 'agy_stream_init', effort: 'agy_cli_request' });
    assert.ok(receipt.snapshot_reads >= 2);
    const trace = JSON.parse(await readFile(join(journal, receipt.transcript_file), 'utf8'));
    const paths = trace.reads.map(read => read.path);
    assert.ok(paths.includes('candidate/contract.txt'));
    assert.ok(paths.includes('candidate/sum.js'));
    assert.match(receipt.transcript_sha256, /^[a-f0-9]{64}$/);
  }
});
