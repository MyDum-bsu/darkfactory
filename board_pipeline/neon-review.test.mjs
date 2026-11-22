import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { isolatedNeonReviewRunner } from './neon-review.mjs';

const exec = promisify(execFile);
const review = { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'medium' };
const subject_digest = 'a'.repeat(64);
const verdict = { verdict: 'PASS', subject_digest, summary: 'Matches the spec',
  findings: [], checked_invariants: ['arithmetic'] };
const providerReply = (result = verdict, meta = {}) => ({
  modelVersion: 'gemini-4-neon', responseId: 'live-turn',
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(result) }] } }],
  ...meta,
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'neon-review-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = join(root, 'journal');
  const worktree = join(root, 'repo');
  await mkdir(journal, { mode: 0o700 });
  await mkdir(worktree);
  const git = async (...args) => (await exec('git', ['-C', worktree, ...args])).stdout.trim();
  await git('init', '-q');
  await git('config', 'user.email', 'test@local');
  await git('config', 'user.name', 'test');
  await git('commit', '-qm', 'base', '--allow-empty');
  const base_sha = await git('rev-parse', 'HEAD');
  await writeFile(join(worktree, 'sum.js'), 'export const sum = (a,b) => a+b;\n');
  await git('add', 'sum.js');
  await git('commit', '-qm', 'candidate');
  const candidate_sha = await git('rev-parse', 'HEAD');
  return { journal, binding: { task_id: '9', candidate_sha, base_sha, subject_digest,
    worktree, executor: 'acp-devin/swe-2-high' }, profile: { review } };
}

const snapshot = async () => ({ code: 0, stdout: '[{"path":"sum.js","text":"code"}]' });

test('Neon ReviewPort separates offline snapshot and authenticated model request', async t => {
  const { journal, binding, profile } = await fixture(t);
  const runner = isolatedNeonReviewRunner({ journal, prompt: 'approved logika and specification',
    credential: async () => 'synthetic-key', sandbox: async req => {
      assert.notEqual(req.snapshot, binding.worktree);
      assert.equal(req.env, undefined);
      assert.equal(req.mounts, undefined);
      assert.match(await readFile(join(req.snapshot, 'sum.js'), 'utf8'), /a\+b/);
      return snapshot();
    }, request: async (url, options) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['x-goog-api-key'], 'synthetic-key');
      const body = JSON.parse(options.body);
      assert.equal(body.tools, undefined);
      assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM');
      assert.match(body.systemInstruction.parts[0].text, /approved logika/);
      assert.match(body.systemInstruction.parts[0].text, new RegExp(subject_digest));
      const { diff, files } = JSON.parse(body.contents[0].parts[0].text);
      assert.match(diff, /\+export const sum/);
      assert.deepEqual(files, [{ path: 'sum.js', text: 'code' }]);
      return Response.json(providerReply());
    } });
  const receipt = await runner(binding, profile);
  assert.equal(receipt.verdict, 'REVIEW_OK');
  assert.equal(receipt.subject_digest, subject_digest);
  assert.deepEqual(receipt.actual, review);
  assert.equal(receipt.isolation, 'docker-ro-v1');
  assert.match(receipt.transcript_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(await readFile(join(journal, receipt.transcript_file), 'utf8'), /synthetic-key/);
});

test('Neon refuses incomplete or mismatched evidence and never retries quota errors', async t => {
  const { journal, binding, profile } = await fixture(t);
  const scenarios = [
    [Response.json(providerReply(verdict, { modelVersion: 'gemini-4-other' })), 'review_model_mismatch'],
    [Response.json(providerReply({ ...verdict, subject_digest: 'b'.repeat(64) })), 'review_verdict_subject_mismatch'],
    [Response.json(providerReply(verdict, { candidates: [{ finishReason: 'MAX_TOKENS' }] })), 'review_incomplete_turn'],
    [Response.json({ error: 'not safe to expose' }, { status: 429 }), 'review_neon_http:429'],
  ];
  for (const [response, reason] of scenarios) {
    let calls = 0;
    const run = isolatedNeonReviewRunner({ journal, sandbox: snapshot, credential: async () => 'synthetic-key',
      request: async () => { calls++; return response; } });
    await assert.rejects(run(binding, profile), { reason });
    assert.equal(calls, 1);
  }
});

test('Neon rejects a same-family executor and worktree drift', async t => {
  const { journal, binding, profile } = await fixture(t);
  let calls = 0;
  const run = isolatedNeonReviewRunner({ journal, sandbox: snapshot, credential: async () => 'synthetic-key',
    request: async () => {
      calls++;
      await writeFile(join(binding.worktree, 'sum.js'), 'changed during review');
      return Response.json(providerReply());
    } });
  await assert.rejects(run({ ...binding, executor: 'google/gemini-4-neon' }, profile),
    { reason: 'review_same_family' });
  assert.equal(calls, 0);
  await assert.rejects(run(binding, profile), { reason: 'worktree_drift_during_review' });
});
