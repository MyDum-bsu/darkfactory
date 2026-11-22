// Живой интеграционный тест isolatedPiReviewRunner: реальный pi --print --mode json
// в rootless Docker read-only контейнере на синтетическом git-репозитории.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isolatedPiReviewRunner } from './review-runner.mjs';

const exec = promisify(execFile);
const CRITIC = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };
const SPEC = 'Spec: sum.js must export sum(a,b) returning the exact arithmetic sum a+b. ' +
  'The function must not add or subtract a constant. Checked invariant: sum(2,2)===4.';

async function git(repo, ...args) {
  return (await exec('git', ['-C', repo, ...args], { timeout: 15_000 })).stdout.trim();
}

async function makeRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'review-it-repo-'));
  await git(repo, 'init', '-q', '-b', 'pilot');
  await git(repo, 'config', 'user.email', 'test@local');
  await git(repo, 'config', 'user.name', 'test');
  return repo;
}

async function commitFile(repo, body) {
  await writeFile(join(repo, 'sum.js'), body);
  await git(repo, 'add', 'sum.js');
  await git(repo, 'commit', '-qm', 'candidate');
  return git(repo, 'rev-parse', 'HEAD');
}

test('isolatedPiReviewRunner: живой Pi/Sol на read-only снимке', async (t) => {
  let rootless = false;
  try {
    rootless = JSON.parse((await exec('docker', ['info', '--format',
      '{{json .SecurityOptions}}'], { timeout: 12_000 })).stdout).includes('name=rootless');
  } catch { /* docker недоступен */ }
  const piRoot = join(homedir(), '.pi', 'agent');
  const piReady = (await lstat(join(piRoot, 'bin')).catch(() => null)) !== null &&
    (await lstat(join(piRoot, 'auth.json')).catch(() => null)) !== null;
  if (!rootless || !piReady) return t.skip('rootless Docker or Pi agent home unavailable');

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
