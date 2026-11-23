import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  assertRetrySubjectUnchanged, isolatedPiReviewRunner, l2CriticSpec,
  l2ReviewWithTransientRetry, reviewRunnerExitFailure, ReviewDenied,
  ReviewRunnerTimeout,
} from './review-runner.mjs';
import { isNeonReview } from './review-policy.mjs';

const exec = promisify(execFile);

const CRITIC = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };
const DIGEST = 'f'.repeat(64);
const SHA1 = 'a'.repeat(40);

const msg = (over = {}) => JSON.stringify({ type: 'message_end', message: {
  role: 'assistant', provider: 'openai', model: 'gpt-6.2-sol',
  thinkingLevel: 'medium', responseId: 'resp_abc123', stopReason: 'stop',
  content: [{ type: 'text', text: 'looks fine\nREVIEW_OK' }], ...over } });
const settled = JSON.stringify({ type: 'agent_settled', aborted: false });
const stream = (text, over = {}) => [
  msg({ content: [{ type: 'text', text }], ...over }), settled,
].join('\n');
const PASS = stream(`{"verdict":"PASS","summary":"ok","subject_digest":"${DIGEST}"}`);

const hasGit = await exec('git', ['--version'], { timeout: 10_000 })
  .then(() => true).catch(() => false);
const gitTest = hasGit ? test : (name, fn) => test(name, { skip: 'git not on PATH' }, fn);

// Счётчик вызовов review без git и без контейнера: сценарий ошибок/квитанций
// подаётся последовательно, повтор идёт тем же вызовом с теми же аргументами.
function scriptedReview(results) {
  let calls = 0;
  const queue = [...results];
  const review = async (binding, profile) => {
    calls++;
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { review, calls: () => calls };
}

const BINDING = { task_id: '1', candidate_sha: SHA1, base_sha: 'b'.repeat(40),
  worktree: '/nonexistent', executor: 'acp-devin/swe-2-high', subject_digest: DIGEST };
const timeout = reason => new ReviewRunnerTimeout(reason);

test('classification: только 143 и host-timeout — typed transient', () => {
  for (const run of [{ code: 143, stderr: '' }, { code: null, timedOut: true }]) {
    const e = reviewRunnerExitFailure(run);
    assert.ok(e instanceof ReviewRunnerTimeout, JSON.stringify(run));
    assert.equal(e.transient, true);
    assert.match(e.reason, /^review_runner_exit:(143|timeout)$/);
  }
  // SIGKILL, отказ запуска, произвольный null и «143» внутри stderr — не transient.
  for (const run of [{ code: 137 }, { code: 1 }, { code: 126 }, { code: 255 },
      { code: null }, { code: null, stderr: 'killed 143' },
      { code: null, timedOut: false }, { code: '143' }]) {
    const e = reviewRunnerExitFailure(run);
    assert.ok(e instanceof ReviewDenied, JSON.stringify(run));
    assert.ok(!(e instanceof ReviewRunnerTimeout), JSON.stringify(run));
  }
});

test('retry: первый 143 затем успех — ровно два вызова раннера', async () => {
  const { review, calls } = scriptedReview([
    timeout('review_runner_exit:143'), { verdict: 'REVIEW_OK', sha: SHA1 }]);
  const notes = [];
  let checked = null;
  const receipt = await l2ReviewWithTransientRetry({ review, binding: BINDING,
    profile: { review: CRITIC }, beforeRetry: async () => {},
    verifySubject: async binding => { checked = binding; },
    log: note => notes.push(note) });
  assert.equal(calls(), 2);
  assert.equal(receipt.verdict, 'REVIEW_OK');
  // Повтор проверяет тот же субъект и журналируется ограниченной записью.
  assert.equal(checked, BINDING);
  assert.deepEqual(notes, [{ kind: 'l2_review_retry', task: '1',
    sha: SHA1, reason: 'review_runner_exit:143' }]);
});

test('retry: host-timeout (code null + timedOut) затем успех — два вызова', async () => {
  const { review, calls } = scriptedReview([
    timeout('review_runner_exit:timeout'), { status: 'PASS' }]);
  const receipt = await l2ReviewWithTransientRetry({ review, binding: BINDING,
    profile: { review: CRITIC }, beforeRetry: async () => {},
    verifySubject: async () => {} });
  assert.equal(calls(), 2);
  assert.equal(receipt.status, 'PASS');
});

test('retry: повторный transient — максимум два вызова, ошибка в hold', async () => {
  const { review, calls } = scriptedReview([
    timeout('review_runner_exit:143'), timeout('review_runner_exit:143')]);
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding: BINDING,
      profile: { review: CRITIC }, beforeRetry: async () => {},
      verifySubject: async () => {} }),
    (e) => e instanceof ReviewRunnerTimeout && e.reason === 'review_runner_exit:143');
  assert.equal(calls(), 2);
});

test('retry: нетранзиентные и security-отказы — один вызов', async () => {
  for (const err of [
      new ReviewDenied('review_runner_exit:1'),
      new ReviewDenied('review_runner_exit:137'),
      new ReviewDenied('review_runner_exit:timeout'),
      new ReviewDenied('sandbox_cleanup_failed'),
      new ReviewDenied('review_forbidden_tool:bash'),
      new ReviewDenied('review_verdict_subject_mismatch'),
      new Error('EIO')]) {
    const { review, calls } = scriptedReview([err, { verdict: 'REVIEW_OK' }]);
    await assert.rejects(
      l2ReviewWithTransientRetry({ review, binding: BINDING,
        profile: { review: CRITIC }, beforeRetry: async () => {},
        verifySubject: async () => {} }),
      (e) => e === err);
    assert.equal(calls(), 1, String(err));
  }
});

test('retry: обычный REWORK — один вызов, вердикт проходит без повтора', async () => {
  const { review, calls } = scriptedReview([
    { status: 'REWORK', verdict: 'REVIEW_BLOCKED' }, { verdict: 'REVIEW_OK' }]);
  const receipt = await l2ReviewWithTransientRetry({ review, binding: BINDING,
    profile: { review: CRITIC }, beforeRetry: async () => {},
    verifySubject: async () => {} });
  assert.equal(calls(), 1);
  assert.equal(receipt.status, 'REWORK');
});

test('retry: отказ гейтов контроллера (lease/switch/пины) — ноль доп. вызовов', async () => {
  const { review, calls } = scriptedReview([
    timeout('review_runner_exit:143'), { verdict: 'REVIEW_OK' }]);
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding: BINDING,
      profile: { review: CRITIC },
      beforeRetry: async () => { throw new Error('Lease lost'); },
      verifySubject: async () => {} }),
    (e) => e.message === 'Lease lost');
  assert.equal(calls(), 1);
});

test('retry: отказ проверки субъекта до повтора — ноль доп. вызовов', async () => {
  const { review, calls } = scriptedReview([
    timeout('review_runner_exit:143'), { verdict: 'REVIEW_OK' }]);
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding: BINDING,
      profile: { review: CRITIC }, beforeRetry: async () => {},
      verifySubject: async () => { throw new ReviewDenied('review_retry_subject_changed'); } }),
    (e) => e.reason === 'review_retry_subject_changed');
  assert.equal(calls(), 1);
});

test('retry: Neon-профиль допускается существующей политикой', async () => {
  // Существующий операторский путь: google/gemini-4-neon получает наследуемый
  // medium через l2CriticSpec и признаётся isNeonReview — нового парсера нет.
  const neonSpec = l2CriticSpec({ provider: 'google', model: 'gemini-4-neon',
    skills: ['logika'] });
  assert.ok(isNeonReview(neonSpec));
  // Повтор runner-агностик: любой read-only раннер с typed timeout.
  const { review, calls } = scriptedReview([
    timeout('review_runner_exit:143'), { status: 'PASS' }]);
  const receipt = await l2ReviewWithTransientRetry({ review, binding: BINDING,
    profile: { review: neonSpec }, beforeRetry: async () => {},
    verifySubject: async () => {} });
  assert.equal(calls(), 2);
  assert.equal(receipt.status, 'PASS');
});

// Сквозные тесты реального Pi-раннера: ему нужен git (unpackExact,
// worktreeFingerprint, assertRetrySubjectUnchanged) — без git пропускаются.
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'retry-repo-'));
  const git = async (...args) =>
    (await exec('git', ['-C', dir, ...args], { timeout: 15_000 })).stdout.trim();
  await git('init', '-q', '-b', 'pilot');
  await git('config', 'user.email', 't@l');
  await git('config', 'user.name', 't');
  await writeFile(join(dir, 'a.txt'), 'x\n');
  await git('add', 'a.txt');
  await git('commit', '-qm', 'base');
  const base = await git('rev-parse', 'HEAD');
  await writeFile(join(dir, 'b.txt'), 'y\n');
  await git('add', 'b.txt');
  await git('commit', '-qm', 'cand');
  const sha = await git('rev-parse', 'HEAD');
  return { dir, git, base, sha };
}

async function fixture(t, results) {
  const { dir, git, base, sha } = await repo();
  const journal = await mkdtemp(join(tmpdir(), 'retry-journal-'));
  const piRoot = await mkdtemp(join(tmpdir(), 'retry-pi-'));
  await writeFile(join(piRoot, 'auth.json'), '{"openai":{"k":"v"}}');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
    await rm(piRoot, { recursive: true, force: true });
  });
  let calls = 0;
  const queue = [...results];
  const sandbox = async () => {
    calls++;
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next();
    return next;
  };
  const review = isolatedPiReviewRunner({ journal, piRoot, sandbox });
  const binding = {
    task_id: '1', candidate_sha: sha, base_sha: base, worktree: dir,
    executor: 'acp-devin/swe-2-high', subject_digest: DIGEST,
  };
  return { review, binding, profile: { review: CRITIC }, calls: () => calls, git, dir };
}

gitTest('runner: реальный адаптер типирует 143 и повторяет до квитанции', async (t) => {
  const { review, binding, profile, calls } = await fixture(t, [
    { code: 143, stdout: '', stderr: 'term' }, { code: 0, stdout: PASS, stderr: '' }]);
  const receipt = await l2ReviewWithTransientRetry({ review, binding, profile,
    beforeRetry: async () => {} });
  assert.equal(calls(), 2);
  assert.equal(receipt.verdict, 'REVIEW_OK');
  assert.equal(receipt.sha, binding.candidate_sha);
  assert.equal(receipt.subject_digest, DIGEST);
});

gitTest('runner: нетранзиентный код из адаптера — один вызов, plain ReviewDenied', async (t) => {
  const { review, binding, profile, calls } = await fixture(t, [
    { code: 1, stdout: '', stderr: '' }, { code: 0, stdout: PASS, stderr: '' }]);
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding, profile, beforeRetry: async () => {} }),
    (e) => e instanceof ReviewDenied && !(e instanceof ReviewRunnerTimeout));
  assert.equal(calls(), 1);
});

gitTest('runner: security-отказ (запрещённый tool) — один вызов, без повтора', async (t) => {
  const forbidden = [
    JSON.stringify({ type: 'session_info', toolsAdded: ['read', 'bash'] }),
    msg(), settled,
  ].join('\n');
  const { review, binding, profile, calls } = await fixture(t, [
    { code: 0, stdout: forbidden, stderr: '' },
    { code: 0, stdout: PASS, stderr: '' }]);
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding, profile, beforeRetry: async () => {} }),
    (e) => e instanceof ReviewDenied && e.reason.startsWith('review_forbidden_tool'));
  assert.equal(calls(), 1);
});

gitTest('runner: смена HEAD до повтора — отказ, повторного вызова нет', async (t) => {
  const { review, binding, profile, calls, git, dir } = await fixture(t, [
    async () => {
      await writeFile(join(dir, 'c.txt'), 'z\n');
      await git('add', 'c.txt');
      await git('commit', '-qm', 'drift');
      return { code: 143, stdout: '', stderr: '' };
    },
    { code: 0, stdout: PASS, stderr: '' }]);
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding, profile, beforeRetry: async () => {} }),
    (e) => e.reason === 'review_retry_subject_changed');
  assert.equal(calls(), 1);
});

gitTest('runner: грязный worktree до повтора — отказ, повторного вызова нет', async (t) => {
  const { review, binding, profile, calls, dir } = await fixture(t, [
    async () => {
      await writeFile(join(dir, 'dirty.txt'), 'd\n');
      return { code: 143, stdout: '', stderr: '' };
    },
    { code: 0, stdout: PASS, stderr: '' }]);
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding, profile, beforeRetry: async () => {} }),
    (e) => e.reason === 'review_retry_subject_changed');
  assert.equal(calls(), 1);
});

gitTest('subject: проверка требует worktree, SHA и чистое дерево на candidate', async (t) => {
  const { dir, git, base, sha } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binding = { worktree: dir, candidate_sha: sha, base_sha: base };
  await assertRetrySubjectUnchanged(binding);
  await assert.rejects(assertRetrySubjectUnchanged({ ...binding, worktree: '/no' }));
  await assert.rejects(assertRetrySubjectUnchanged({ ...binding, candidate_sha: 'x' }),
    (e) => e.reason === 'review_retry_subject_unverified');
  await writeFile(join(dir, 'd.txt'), 'd\n');
  await assert.rejects(assertRetrySubjectUnchanged(binding),
    (e) => e.reason === 'review_retry_subject_changed');
  await git('add', 'd.txt');
  await git('commit', '-qm', 'd');
  await assert.rejects(assertRetrySubjectUnchanged(binding),
    (e) => e.reason === 'review_retry_subject_changed');
});
