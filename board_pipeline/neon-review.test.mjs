import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { isolatedNeonReviewRunner, neonBody } from './neon-review.mjs';
import { formatReviewPrompt } from './model-prompt-profiles.mjs';
import { hostAgyTransport } from './agy-transport.mjs';
import { agyStreamFixture, commitFile, neonFixture } from './review-test-fixture.mjs';
import agyStream from './agy-stream.cjs';
import { NEON_ISOLATION } from './review-policy.mjs';
import { ReviewDenied } from './review-runner.mjs';
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

async function npmExecutable() {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'npm');
    if (await lstat(candidate).then(st => st.isFile() || st.isSymbolicLink(), () => false)) return candidate;
  }
  throw new Error('npm executable unavailable for the Agy test harness');
}

async function nodeHarness(dir, name, source) {
  const binary = join(dir, name);
  const hook = join(dir, `${name}-hook.cjs`);
  await symlink(await npmExecutable(), binary);
  await writeFile(hook, source, { mode: 0o600 });
  const prefix = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
  return { binary, env: { ...process.env, NODE_OPTIONS: `${prefix}--require ${hook}` } };
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

test('neonBody places the candidate file list before the prompt and keeps the Google terminal contract', () => {
  const binding = { task_id: '77', candidate_sha: 'a'.repeat(40), subject_digest, review_round: 1 };
  const googlePrompt = formatReviewPrompt({ family: 'google', spec: 'UNIQUE_SPEC_MARKER', diffContext: 'DIFF', rules: 'RULES' });
  assert.ok(googlePrompt.endsWith('</json_output_contract>'));

  const body = neonBody(binding, googlePrompt, ['candidate/sum.js'], null);
  const listAt = body.indexOf('Candidate file list:');
  const promptAt = body.indexOf('UNIQUE_SPEC_MARKER');
  assert.ok(listAt >= 0 && promptAt >= 0 && listAt < promptAt, 'file list must precede the prompt');
  assert.ok(body.endsWith('</json_output_contract>'), 'nothing may follow the closing JSON contract tag');
  assert.equal(body, neonBody(binding, googlePrompt, ['candidate/sum.js'], null));

  // Oversized inventories fall back to the files.json pointer, still before the prompt.
  const bigFiles = Array.from({ length: 2000 }, (_, i) => `candidate/file-${i}-padding-padding-padding.js`);
  const big = neonBody(binding, googlePrompt, bigFiles, null);
  assert.match(big, /Candidate file list: all 2000 paths are in files\.json \(not embedded\)\./);
  assert.ok(big.indexOf('Candidate file list:') < big.indexOf('UNIQUE_SPEC_MARKER'));
  assert.ok(big.endsWith('</json_output_contract>'));

  // Empty and minimal inventories stay inline and keep the prompt terminal.
  const empty = neonBody(binding, googlePrompt, [], null);
  assert.match(empty, /Candidate file list: \[\]/);
  assert.ok(empty.endsWith('</json_output_contract>'));

  // Non-Google prompts are equally terminal: the prompt is always the last block.
  const plain = neonBody(binding, 'PLAIN PROMPT TAIL', ['candidate/sum.js'], null);
  assert.ok(plain.indexOf('Candidate file list:') < plain.indexOf('PLAIN PROMPT TAIL'));
  assert.ok(plain.endsWith('PLAIN PROMPT TAIL'));
});

test('Neon Round 2+ diff failure throws ReviewDenied, not ReferenceError', async t => {
  const { journal, binding, profile } = await fixture(t);
  let transportCalls = 0;
  const run = isolatedNeonReviewRunner({ journal, sandbox: snapshot,
    transport: async () => {
      transportCalls++;
      throw new Error('transport must not be called');
    } });
  await assert.rejects(
    run({ ...binding, review_round: 2, prior_sha: 'e'.repeat(40) }, profile),
    (e) => e instanceof ReviewDenied && !(e instanceof ReferenceError) &&
      typeof e.reason === 'string' && e.reason.startsWith('review_round_diff_failed:'));
  assert.equal(transportCalls, 0);
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
  const fakeBin = join(journal, 'fake-bin');
  await mkdir(fakeBin);
  const proxyHarness = await nodeHarness(fakeBin, 'xdg-dbus-proxy', `
const fs = require('fs');
fs.writeSync(3, 'x');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`);
  const oldPath = process.env.PATH;
  const oldNodeOptions = process.env.NODE_OPTIONS;
  process.env.PATH = `${fakeBin}:${oldPath}`;
  process.env.NODE_OPTIONS = proxyHarness.env.NODE_OPTIONS;
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
  } finally {
    process.env.PATH = oldPath;
    if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = oldNodeOptions;
    await chmod(cwd, 0o700);
  }
});

test('Agy version attestation accepts >= 1.5.14 (no upper cap) and rejects older or malformed versions', async t => {
  const { journal } = await neonFixture(t);
  const base = { cwd: journal, env: process.env, prompt: 'synthetic candidate',
    timeoutMs: 3000, sealBootstrap: async () => {} };
  for (const version of ['1.5.14', '1.5.18', '1.6.0', '2.0.0']) {
    const lines = agyStreamFixture(verdict, { cwd: journal }).split('\n');
    const harness = await nodeHarness(journal, `fake-agy-${version}`, `
const fs = require('fs');
if (process.argv.includes('--version')) {
  fs.writeSync(1, ${JSON.stringify(`${version}\n`)});
  process.exit(0);
}
const lines = ${JSON.stringify(lines)};
fs.writeSync(1, lines[0] + '\\n');
fs.readFileSync(0, 'utf8');
fs.writeSync(1, lines.slice(1).map(line => line + '\\n').join(''));
process.exit(0);
`);
    const result = await agyStream.runAgy({ binary: harness.binary, ...base, env: harness.env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"status":"SUCCESS"/);
  }
  for (const version of ['1.5.13', '1.4.9', 'unknown', '']) {
    const harness = await nodeHarness(journal, `fake-agy-bad-${version || 'empty'}`, `
const fs = require('fs');
if (process.argv.includes('--version')) {
  fs.writeSync(1, ${JSON.stringify(`${version}\n`)});
  process.exit(0);
}
process.exit(1);
`);
    await assert.rejects(agyStream.runAgy({ binary: harness.binary, ...base, env: harness.env }),
      { reason: 'agy_version_unattested' });
  }
});

test('Agy pilot cut after init withholds the prompt from the already-started process', async t => {
  const { journal } = await fixture(t);
  const received = join(journal, 'received-prompt');
  const harness = await nodeHarness(journal, 'fake-agy-pilot', `
const fs = require('fs');
if (process.argv.includes('--version')) {
  fs.writeSync(1, '1.5.14\\n');
  process.exit(0);
}
fs.writeSync(1, JSON.stringify({ event:'init', conversation_id:'one',
  init:{model:'gemini-4-neon',cwd:process.cwd(),permission_mode:'request-review',tools:[]} }) + '\\n');
const input = fs.readFileSync(0, 'utf8');
if (input) fs.writeFileSync(${JSON.stringify(received)}, 'received');
process.exit(0);
`);
  let checks = 0;
  let revoked = false;
  const result = await agyStream.runAgy({ binary: harness.binary, cwd: journal, env: harness.env, prompt: 'synthetic candidate',
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
