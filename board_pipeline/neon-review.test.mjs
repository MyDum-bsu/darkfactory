import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { isolatedNeonReviewRunner } from './neon-review.mjs';
import { hostAgyTransport } from './agy-transport.mjs';
import { agyStreamFixture, commitFile, neonFixture } from './review-test-fixture.mjs';
import agyStream from './agy-stream.cjs';
import { NEON_ISOLATION } from './review-policy.mjs';
import { PilotDenied } from './pilot-gate.mjs';

const subject_digest = 'a'.repeat(64);
const verdict = { verdict: 'PASS', subject_digest, summary: 'Matches the spec',
  findings: [], checked_invariants: ['arithmetic'] };
const snapshot = async () => ({ code: 0, stdout: '["candidate/sum.js"]' });
const wire = (cwd, result = verdict, options) => ({ code: 0, cwd,
  stdout: agyStreamFixture(result, { cwd, reads: ['candidate/sum.js'], ...options }) });

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
    }, transport: async ({ prompt, snapshot: cwd, publishSnapshot }) => {
      assert.deepEqual(await readdir(cwd), []);
      await publishSnapshot();
      assert.match(prompt, /approved logika/);
      assert.match(prompt, new RegExp(subject_digest));
      assert.match(prompt, /diff\.patch/);
      assert.match(prompt, /candidate\/sum\.js/);
      assert.doesNotMatch(prompt, /export const sum/);
      assert.match(await readFile(join(cwd, 'diff.patch'), 'utf8'), /\+export const sum/);
      assert.deepEqual(JSON.parse(await readFile(join(cwd, 'files.json'), 'utf8')), ['candidate/sum.js']);
      return wire(cwd);
    } });
  const receipt = await runner(binding, profile);
  assert.equal(receipt.verdict, 'REVIEW_OK');
  assert.equal(receipt.subject_digest, subject_digest);
  assert.deepEqual(receipt.actual, profile.review);
  assert.equal(receipt.isolation, NEON_ISOLATION);
  assert.equal(receipt.snapshot_reads, 1);
  assert.deepEqual(receipt.attestation, { model: 'agy_stream_init', effort: 'agy_cli_request' });
  assert.match(receipt.transcript_sha256, /^[a-f0-9]{64}$/);
});

test('Neon never retries unavailable, mismatched or tool-using attempts', async t => {
  const { journal, binding, profile } = await fixture(t);
  const outcomes = [
    [cwd => wire(cwd, verdict, { model: 'wrong-model' }), 'agy_init_unattested'],
    [cwd => wire(cwd, { ...verdict, subject_digest: 'b'.repeat(64) }), 'review_verdict_subject_mismatch'],
    [cwd => wire(cwd, verdict, { step: { step_type: 'tool', tool_info: { name: 'view_file' } } }), 'review_tool_use_forbidden'],
    [cwd => wire(cwd, verdict, { reads: ['../../outside.txt'] }), 'review_tool_use_forbidden'],
    [cwd => wire(cwd, verdict, { reads: [] }), 'agy_snapshot_unread'],
    [() => ({ code: 1, stderr: 'agy_auth_unavailable\n' }), 'agy_auth_unavailable'],
  ];
  for (const [response, reason] of outcomes) {
    let calls = 0;
    const run = isolatedNeonReviewRunner({ journal, sandbox: snapshot,
      transport: async ({ snapshot: cwd, publishSnapshot }) => {
        calls++;
        const result = response(cwd);
        if (result.code === 0) await publishSnapshot();
        return result;
      } });
    await assert.rejects(run(binding, profile), { reason });
    assert.equal(calls, 1);
  }
});

test('Neon rejects same-family and drifting worktree', async t => {
  const { journal, binding, profile } = await fixture(t);
  let calls = 0;
  const run = isolatedNeonReviewRunner({ journal, sandbox: snapshot, transport: async ({ snapshot: cwd, publishSnapshot }) => {
    calls++;
    await publishSnapshot();
    await writeFile(join(binding.worktree, 'sum.js'), 'changed during review');
    return wire(cwd);
  } });
  await assert.rejects(run({ ...binding, executor: 'google/gemini-4-neon' }, profile),
    { reason: 'review_same_family' });
  assert.equal(calls, 0);
  await assert.rejects(run(binding, profile), { reason: 'worktree_drift_during_review' });
});

test('a 640 KiB candidate patch remains complete on disk, not clipped or embedded in the Agy prompt', async t => {
  const { repo, journal, binding, profile } = await neonFixture(t);
  const body = 'a'.repeat(640 * 1024) + '\nLARGE_PATCH_TRAILER\n';
  const candidate_sha = await commitFile(repo, body);
  const run = isolatedNeonReviewRunner({ journal, sandbox: snapshot, transport: async ({ prompt, snapshot: cwd, publishSnapshot }) => {
    await publishSnapshot();
    assert.ok(Buffer.byteLength(prompt) < 4096);
    assert.doesNotMatch(prompt, /LARGE_PATCH_TRAILER/);
    const patch = await readFile(join(cwd, 'diff.patch'), 'utf8');
    assert.ok(patch.includes(`+${body.split('\n')[0]}\n+LARGE_PATCH_TRAILER\n`));
    return wire(cwd);
  } });
  const receipt = await run({ ...binding, candidate_sha, subject_digest }, profile);
  assert.equal(receipt.snapshot_reads, 1);
});

test('Agy transport launches in the read-only staged snapshot and never inherits task authority', async t => {
  const { journal, binding } = await fixture(t);
  const binary = join(journal, 'synthetic-binary');
  const scope = join(journal, 'synthetic-scope');
  await writeFile(binary, '', { mode: 0o500 });
  await writeFile(scope, 'synthetic-provider-label', { mode: 0o600 });
  const cwd = join(journal, 'review');
  await mkdir(cwd, { mode: 0o500 });
  const env = { DF_AGY_BINARY: binary, DF_AGY_SCOPE_FILE: scope, DF_AGY_KEYRING_ITEM: '/org/freedesktop/secrets/collection/login/0',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-session-bus', HTTPS_PROXY: 'http://127.0.0.1:3189',
    BOARD_TOKEN: 'fake-lease', BOARD_URL: 'http://127.0.0.1:44100/api/board', BB_THREAD_ID: 'thr_fake',
    WORKTREE: binding.worktree, STATE: journal };
  try {
    await hostAgyTransport({ env, snapshot: cwd, publishSnapshot: async () => {}, prompt: 'synthetic prompt', launch: async request => {
      assert.equal(request.cwd, cwd);
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
  } finally { await chmod(cwd, 0o700); }
});

test('Agy version attestation accepts >= 1.5.14 (no upper cap) and rejects older or malformed versions', async t => {
  const { journal } = await neonFixture(t);
  const base = { cwd: journal, env: process.env, prompt: 'synthetic candidate',
    timeoutMs: 3000, sealBootstrap: async () => {} };
  for (const version of ['1.5.14', '1.5.18', '1.6.0', '2.0.0']) {
    const binary = join(journal, `fake-agy-${version}`);
    const lines = agyStreamFixture(verdict, { cwd: journal }).split('\n');
    await writeFile(binary, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
const lines = ${JSON.stringify(lines)};
console.log(lines[0]);
process.stdin.once('data', () => { for (const line of lines.slice(1)) console.log(line); });
`, { mode: 0o700 });
    const result = await agyStream.runAgy({ binary, ...base });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"status":"SUCCESS"/);
  }
  for (const version of ['1.5.13', '1.4.9', 'unknown', '']) {
    const binary = join(journal, `fake-agy-bad-${version || 'empty'}`);
    await writeFile(binary, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
process.exit(1);
`, { mode: 0o700 });
    await assert.rejects(agyStream.runAgy({ binary, ...base }), { reason: 'agy_version_unattested' });
  }
});

test('Agy pilot cut after init withholds the prompt from the already-started process', async t => {
  const { journal } = await fixture(t);
  const binary = join(journal, 'fake-agy');
  const received = join(journal, 'received-prompt');
  await writeFile(binary, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('1.5.14'); process.exit(0); }\nconsole.log(JSON.stringify({ event:'init', conversation_id:'one', init:{model:'gemini-4-neon',cwd:process.cwd(),permission_mode:'request-review',tools:[]} }));\nprocess.stdin.on('data', () => require('fs').writeFileSync(${JSON.stringify(received)}, 'received'));\n`, { mode: 0o700 });
  await chmod(binary, 0o700);
  let checks = 0;
  let revoked = false;
  const result = await agyStream.runAgy({ binary, cwd: journal, env: process.env, prompt: 'synthetic candidate',
    timeoutMs: 3000, sealBootstrap: async () => { revoked = true; }, beforeEffect: async () => {
      if (++checks === 2) throw new PilotDenied('pilot_stopped');
    } });
  assert.equal(revoked, true);
  assert.equal(checks, 2);
  assert.equal(result.code, 1);
  await assert.rejects(lstat(received), { code: 'ENOENT' });
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
