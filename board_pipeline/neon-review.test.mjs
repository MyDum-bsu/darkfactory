import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { isolatedNeonReviewRunner } from './neon-review.mjs';
import { hostAgyTransport } from './agy-transport.mjs';
import { agyStreamFixture, commitFile, neonFixture } from './review-test-fixture.mjs';
import agyStream from './agy-stream.cjs';
import { NEON_ISOLATION } from './review-policy.mjs';

const subject_digest = 'a'.repeat(64);
const verdict = { verdict: 'PASS', subject_digest, summary: 'Matches the spec',
  findings: [], checked_invariants: ['arithmetic'] };
const snapshot = async () => ({ code: 0, stdout: '[{"path":"sum.js","text":"code"}]' });
const wire = (result = verdict, options) => ({ code: 0, cwd: '/candidate', stdout: agyStreamFixture(result, options) });

async function fixture(t) {
  const { repo, journal, binding, profile } = await neonFixture(t);
  const candidate_sha = await commitFile(repo, 'export const sum = (a,b) => a+b;\n');
  return { journal, binding: { ...binding, candidate_sha, subject_digest }, profile };
}

test('Neon ReviewPort separates offline snapshot and Agy model-only request', async t => {
  const { journal, binding, profile } = await fixture(t);
  const runner = isolatedNeonReviewRunner({ journal, prompt: 'approved logika and specification',
    sandbox: async request => {
      assert.notEqual(request.snapshot, binding.worktree);
      assert.equal(request.env, undefined);
      assert.equal(request.mounts, undefined);
      assert.match(await readFile(join(request.snapshot, 'sum.js'), 'utf8'), /a\+b/);
      return snapshot();
    }, transport: async ({ prompt }) => {
      assert.match(prompt, /approved logika/);
      assert.match(prompt, new RegExp(subject_digest));
      const { diff, files } = JSON.parse(prompt.split('BEGIN CANDIDATE DATA\n')[1].split('\nEND CANDIDATE DATA')[0]);
      assert.match(diff, /\+export const sum/);
      assert.deepEqual(files, [{ path: 'sum.js', text: 'code' }]);
      return wire();
    } });
  const receipt = await runner(binding, profile);
  assert.equal(receipt.verdict, 'REVIEW_OK');
  assert.equal(receipt.subject_digest, subject_digest);
  assert.deepEqual(receipt.actual, profile.review);
  assert.equal(receipt.isolation, NEON_ISOLATION);
  assert.deepEqual(receipt.attestation, { model: 'agy_stream_init', effort: 'agy_cli_request' });
  assert.match(receipt.transcript_sha256, /^[a-f0-9]{64}$/);
});

test('Neon never retries unavailable, mismatched or tool-using attempts', async t => {
  const { journal, binding, profile } = await fixture(t);
  const outcomes = [
    [wire(verdict, { model: 'wrong-model' }), 'agy_init_unattested'],
    [wire({ ...verdict, subject_digest: 'b'.repeat(64) }), 'review_verdict_subject_mismatch'],
    [wire(verdict, { step: { step_type: 'tool', tool_info: { name: 'view_file' } } }), 'review_tool_use_forbidden'],
    [{ code: 1, stderr: 'agy_auth_unavailable\n' }, 'agy_auth_unavailable'],
  ];
  for (const [response, reason] of outcomes) {
    let calls = 0;
    const run = isolatedNeonReviewRunner({ journal, sandbox: snapshot,
      transport: async () => { calls++; return response; } });
    await assert.rejects(run(binding, profile), { reason });
    assert.equal(calls, 1);
  }
});

test('Neon rejects same-family and drifting worktree', async t => {
  const { journal, binding, profile } = await fixture(t);
  let calls = 0;
  const run = isolatedNeonReviewRunner({ journal, sandbox: snapshot, transport: async () => {
    calls++;
    await writeFile(join(binding.worktree, 'sum.js'), 'changed during review');
    return wire();
  } });
  await assert.rejects(run({ ...binding, executor: 'google/gemini-4-neon' }, profile),
    { reason: 'review_same_family' });
  assert.equal(calls, 0);
  await assert.rejects(run(binding, profile), { reason: 'worktree_drift_during_review' });
});

test('Agy transport launches with an empty 0500 directory and never inherits task authority', async t => {
  const { journal, binding } = await fixture(t);
  const binary = join(journal, 'synthetic-binary');
  const scope = join(journal, 'synthetic-scope');
  await writeFile(binary, '', { mode: 0o500 });
  await writeFile(scope, 'synthetic-provider-label', { mode: 0o600 });
  const env = { DF_AGY_BINARY: binary, DF_AGY_SCOPE_FILE: scope, DF_AGY_KEYRING_ITEM: '/org/freedesktop/secrets/collection/login/0',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-session-bus', HTTPS_PROXY: 'http://127.0.0.1:3189',
    BOARD_TOKEN: 'fake-lease', BOARD_URL: 'http://127.0.0.1:44100/api/board', BB_THREAD_ID: 'thr_fake',
    WORKTREE: binding.worktree, STATE: journal };
  await hostAgyTransport({ env, prompt: 'synthetic prompt', launch: async request => {
    assert.equal((await lstat(request.cwd)).mode & 0o777, 0o500);
    assert.deepEqual(await readdir(request.cwd), []);
    for (const key of ['BOARD_TOKEN', 'BOARD_URL', 'BB_THREAD_ID', 'WORKTREE', 'STATE']) {
      assert.equal(Object.hasOwn(request.env, key), false);
    }
    assert.notEqual(request.env.HOME, process.env.HOME);
    assert.equal(new URL(request.env.HTTPS_PROXY).hostname, '127.0.0.1');
    await request.sealBootstrap();
    return { code: 0, cwd: request.cwd };
  } });
});

test('Agy watchdog SIGKILLs on a tool step before accepting later output', { timeout: 3000 }, async () => {
  const attempted = agyStreamFixture(verdict, { step: { step_type: 'tool' } }).split('\n').slice(0, 3).join('\n');
  const fake = spawn(process.execPath, ['-e', `console.log(${JSON.stringify(attempted)}); setInterval(()=>{},1000)`],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  const exit = once(fake, 'close');
  let released = 0;
  try {
    await assert.rejects(agyStream.superviseAgy(fake, exit, { cwd: '/candidate',
      onInit: () => { released++; }, emit: () => {} }), { reason: 'review_tool_use_forbidden' });
    assert.equal(released, 1);
    assert.deepEqual(await exit, [null, 'SIGKILL']);
  } finally {
    fake.kill('SIGKILL');
    await exit;
  }
});
