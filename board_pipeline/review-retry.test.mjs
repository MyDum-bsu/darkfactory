import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  isolatedPiReviewRunner, l2CriticSpec, l2ReviewWithTransientRetry,
  reviewRunnerExitFailure, ReviewDenied, ReviewRunnerTimeout,
} from './review-runner.mjs';
import { isNeonReview } from './review-policy.mjs';

const exec = promisify(execFile);

const CRITIC = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };
const DIGEST = 'f'.repeat(64);

const msg = (over = {}) => JSON.stringify({ type: 'message_end', message: {
  role: 'assistant', provider: 'openai', model: 'gpt-6.2-sol',
  thinkingLevel: 'medium', responseId: 'resp_abc123', stopReason: 'stop',
  content: [{ type: 'text', text: 'looks fine\nREVIEW_OK' }], ...over } });
const settled = JSON.stringify({ type: 'agent_settled', aborted: false });
const stream = (text, over = {}) => [
  msg({ content: [{ type: 'text', text }], ...over }), settled,
].join('\n');
const PASS = stream(`{"verdict":"PASS","summary":"ok","subject_digest":"${DIGEST}"}`);

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

test('retry: первый 143 затем успех — ровно два вызова раннера', async (t) => {
  const { review, binding, profile, calls } = await fixture(t, [
    { code: 143, stdout: '', stderr: 'term' }, { code: 0, stdout: PASS, stderr: '' }]);
  const notes = [];
  const receipt = await l2ReviewWithTransientRetry({ review, binding, profile,
    beforeRetry: async () => {}, log: note => notes.push(note) });
  assert.equal(calls(), 2);
  assert.equal(receipt.verdict, 'REVIEW_OK');
  assert.equal(receipt.sha, binding.candidate_sha);
  assert.deepEqual(notes, [{ kind: 'l2_review_retry', task: '1',
    sha: binding.candidate_sha, reason: 'review_runner_exit:143' }]);
});

test('retry: host-timeout (code null + timedOut) затем успех — два вызова', async (t) => {
  const { review, binding, profile, calls } = await fixture(t, [
    { code: null, timedOut: true, stdout: '', stderr: '' },
    { code: 0, stdout: PASS, stderr: '' }]);
  const receipt = await l2ReviewWithTransientRetry({ review, binding, profile,
    beforeRetry: async () => {} });
  assert.equal(calls(), 2);
  assert.equal(receipt.status, 'PASS');
});

test('retry: повторный transient — максимум два вызова, ошибка в hold', async (t) => {
  const { review, binding, profile, calls } = await fixture(t, [
    { code: 143, stdout: '', stderr: '' }, { code: 143, stdout: '', stderr: '' }]);
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding, profile, beforeRetry: async () => {} }),
    (e) => e instanceof ReviewRunnerTimeout && e.reason === 'review_runner_exit:143');
  assert.equal(calls(), 2);
});

test('retry: нетранзиентные коды и null без доказательства — один вызов', async (t) => {
  for (const failed of [{ code: 1 }, { code: 137 }, { code: 255 }, { code: null }]) {
    const { review, binding, profile, calls } = await fixture(t, [
      { ...failed, stdout: '', stderr: '' }, { code: 0, stdout: PASS, stderr: '' }]);
    await assert.rejects(
      l2ReviewWithTransientRetry({ review, binding, profile, beforeRetry: async () => {} }),
      (e) => e instanceof ReviewDenied && !(e instanceof ReviewRunnerTimeout));
    assert.equal(calls(), 1, JSON.stringify(failed));
  }
});

test('retry: security-отказ (запрещённый tool) — один вызов, без повтора', async (t) => {
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

test('retry: обычный REWORK — один вызов, вердикт проходит без повтора', async (t) => {
  const rework = stream(JSON.stringify({ verdict: 'REWORK', summary: 'bad',
    subject_digest: DIGEST,
    findings: [{ file: 'b.txt', line: 1, expected: 'x', actual: 'y' }] }));
  const { review, binding, profile, calls } = await fixture(t, [
    { code: 0, stdout: rework, stderr: '' }, { code: 0, stdout: PASS, stderr: '' }]);
  const receipt = await l2ReviewWithTransientRetry({ review, binding, profile,
    beforeRetry: async () => {} });
  assert.equal(calls(), 1);
  assert.equal(receipt.status, 'REWORK');
});

test('retry: отказ гейтов контроллера (lease/switch/пины) — ноль доп. вызовов', async (t) => {
  const { review, binding, profile, calls } = await fixture(t, [
    { code: 143, stdout: '', stderr: '' }, { code: 0, stdout: PASS, stderr: '' }]);
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding, profile,
      beforeRetry: async () => { throw new Error('Lease lost'); } }),
    (e) => e.message === 'Lease lost');
  assert.equal(calls(), 1);
});

test('retry: смена HEAD до повтора — отказ, повторного вызова нет', async (t) => {
  const { review, binding, profile, calls, git, dir } = await fixture(t, [
    async () => {
      // Субъект сменился, пока первый читатель падал: новый коммит в worktree.
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

test('retry: грязный worktree до повтора — отказ, повторного вызова нет', async (t) => {
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

test('retry: runner-агностик — Neon-профиль допускается той же политикой', async (t) => {
  // Существующий операторский путь: google/gemini-4-neon получает наследуемый
  // medium через l2CriticSpec и признаётся isNeonReview — нового парсера нет.
  const neonSpec = l2CriticSpec({ provider: 'google', model: 'gemini-4-neon',
    skills: ['logika'] });
  assert.ok(isNeonReview(neonSpec));
  // Повтор работает с любым read-only раннером, кидающим ReviewRunnerTimeout.
  const { binding, calls } = await fixture(t, []);
  let n = 0;
  const stubReview = async () => {
    n++;
    if (n === 1) throw new ReviewRunnerTimeout('review_runner_exit:143');
    return { status: 'PASS' };
  };
  const receipt = await l2ReviewWithTransientRetry({ review: stubReview,
    binding, profile: { review: neonSpec }, beforeRetry: async () => {} });
  assert.equal(n, 2);
  assert.equal(receipt.status, 'PASS');
  assert.equal(calls(), 0);
});
