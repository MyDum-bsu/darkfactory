import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertStageReadOnly, createStageSandboxTransport, observeStageInSandbox,
  probeStageSandboxCapability, stageTransportKind, stageVerdictLine } from './stage-sandbox-transport.mjs';
import { REVIEW_IMAGE, runInReadOnlySandbox } from './review-runner.mjs';

const exec = promisify(execFile);
const hex = ch => ch.repeat(64);
const sha = 'a'.repeat(40);
const challenge = hex('c');
const artifactDigest = hex('d');
const sol = { provider: 'openai', model: 'gpt-6.2-sol' };
const neon = { provider: 'google', model: 'gemini-4-neon' };
const fp = () => ({ head: sha, tree: 't', status: 's', diff: 'd', files: 'f' });

async function fixture(t, { files = { 'a.txt': 'data' } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'df-stage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, 'worktree');
  const journal = join(root, 'journal');
  const piRoot = join(root, 'pi');
  await mkdir(worktree, { mode: 0o700 });
  await mkdir(journal, { mode: 0o700 });
  await mkdir(join(piRoot, 'agent'), { recursive: true, mode: 0o700 });
  await writeFile(join(piRoot, 'agent', 'auth.json'),
    JSON.stringify({ openai: { type: 'api_key', key: 'k' },
      'opencode-go': { type: 'api_key', key: 'k' } }), { mode: 0o600 });
  const unpack = async (wt, candidate, tar, source) => {
    for (const [name, body] of Object.entries(files)) await writeFile(join(source, name), body);
  };
  return { root, worktree, journal, piRoot: join(piRoot, 'agent'), unpack };
}

const request = model => ({ binding: { task_id: '3', candidate_sha: sha, worktree: 'wt' },
  model, prompt: 'Изолированный этап', challenge, artifactDigest });

test('маршрут модели: neon → landlock, sol/deepseek/pi-openai → docker, запрещённые — denied', () => {
  assert.equal(stageTransportKind(neon), 'landlock-ro-v1');
  assert.equal(stageTransportKind({ provider: 'acp-antigravity-acp', model: 'gemini-4-neon' }), 'landlock-ro-v1');
  assert.equal(stageTransportKind(sol), 'docker-ro-v1');
  assert.equal(stageTransportKind({ provider: 'pi', model: 'openai/gpt-6.2-sol' }), 'docker-ro-v1');
  assert.equal(stageTransportKind({ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' }), 'docker-ro-v1');
  for (const denied of [{ provider: 'acp-zcode-start', model: 'x' },
      { provider: 'pi', model: 'opencode-go/other-model' }, { provider: 'acp-devin', model: 'swe-2-high' }]) {
    assert.throws(() => stageTransportKind(denied), /stage_model_denied/);
  }
});

test('fail-closed: Landlock ABI < 4 и отсутствие rootless Docker отклоняются до дочернего процесса', async t => {
  const { worktree, journal, piRoot, unpack } = await fixture(t);
  for (const [model, probes] of [[neon, { probeLandlock: async () => false }],
      [sol, { probeDocker: async () => false }]]) {
    let children = 0;
    const transport = createStageSandboxTransport({ worktree, journal, piRoot, unpack, ...probes,
      agyTransport: async () => { children++; }, dockerSandbox: async () => { children++; },
      worktreeFingerprintImpl: fp });
    await assert.rejects(transport.observe(request(model)), /stage_read_only_transport_not_enrolled/);
    assert.equal(children, 0, 'ни одного дочернего процесса до аттестации');
  }
  // Живая проба возвращает структуру enrolment без побочных эффектов.
  assert.deepEqual(await probeStageSandboxCapability('docker-ro-v1', { probeDocker: async () => true }),
    { kind: 'docker-ro-v1', enrolled: true });
  assert.deepEqual(await probeStageSandboxCapability('landlock-ro-v1', { probeLandlock: async () => 4 }),
    { kind: 'landlock-ro-v1', enrolled: false });
});

test('mode !== read-only отклоняется fail-closed при создании и при вызове', async t => {
  const { worktree } = await fixture(t);
  assert.throws(() => createStageSandboxTransport({ worktree, mode: 'write' }), /stage_mode_not_read_only/);
  const transport = createStageSandboxTransport({ worktree, probeDocker: async () => true });
  await assert.rejects(transport.observe({ ...request(sol), mode: 'execute' }), /stage_mode_not_read_only/);
});

test('docker-ro-v1: аттестованный witness, конфигурация изоляции и запрет :44100', async t => {
  const { worktree, journal, piRoot, unpack } = await fixture(t);
  const sandboxes = [];
  const transport = createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeDocker: async () => true, worktreeFingerprintImpl: fp,
    dockerSandbox: async opts => { sandboxes.push(opts); return { code: 0, stdout: 'TRANSCRIPT' }; },
    parsePi: () => ({ actual: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' },
      toolsAdded: [], finalText: `${challenge} PASS` }) });
  assert.equal(await transport.assertReadOnly(sol), true);
  assert.equal(await assertStageReadOnly(transport, sol), true);
  const { verdict, witness } = await observeStageInSandbox(request(sol), transport);
  assert.equal(verdict, 'PASS');
  assert.equal(witness.mode, 'read-only');
  assert.equal(witness.transport, 'docker-ro-v1');
  assert.equal(witness.challenge, challenge);
  assert.equal(witness.artifactDigest, artifactDigest);
  assert.equal(witness.transcript_sha256, createHash('sha256').update('TRANSCRIPT').digest('hex'));
  assert.equal(witness.checkpoint, witness.transcript_sha256.slice(0, 32));
  assert.deepEqual(witness.actual, { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' });
  // Конфигурация изоляции: pi-guard прелоад, allowlist egress без :44100,
  // read-only tools; сетевой коннект закрыт --network=none в runInReadOnlySandbox.
  const [run] = sandboxes;
  assert.equal(run.env.NODE_OPTIONS, '--require /tmp/pi-guard.cjs');
  assert.equal(run.env.PI_OFFLINE, '1');
  assert.equal(run.env.PI_ALLOW_CONNECT, 'api.openai.com:443,chatgpt.com:443');
  assert.ok(!JSON.stringify(run).includes('44100'));
  assert.ok(run.argv.slice(0, 2).join(' ').includes('/bin/sh -c'));
  assert.ok(run.argv.includes('read,grep,find,ls'));
  assert.ok(run.mounts.some(m => m.dst === '/pi-guard/pi-guard.cjs'));
  const guard = await readFile(new URL('./pi-guard.cjs', import.meta.url), 'utf8');
  assert.match(guard, /44100/, 'pi-guard жёстко запрещает порт 44100');
});

test('landlock-ro-v1: publishSnapshot, stage_witness и агрегированный транскрипт', async t => {
  const { worktree, journal, piRoot, unpack } = await fixture(t);
  const transport = createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeLandlock: async () => true, worktreeFingerprintImpl: fp,
    agyTransport: async ({ snapshot, publishSnapshot }) => {
      await publishSnapshot();
      return { code: 0, stdout: 'stream-bytes', cwd: snapshot };
    },
    parseAgy: () => ({ text: `${challenge} PASS`, verifiedReads: [{ stepIdx: 1 }],
      evidence: { model: 'agy_stream_init' },
      actual: { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'medium' } }) });
  assert.equal(await transport.assertReadOnly(neon), true);
  const { verdict, witness } = await transport.observe(request(neon));
  assert.equal(verdict, 'PASS');
  assert.equal(witness.transport, 'landlock-ro-v1');
  assert.equal(witness.mode, 'read-only');
  assert.equal(witness.challenge, challenge);
  assert.match(witness.transcript_sha256, /^[a-f0-9]{64}$/);
  assert.equal(witness.checkpoint, witness.transcript_sha256.slice(0, 32));
});

test('мутация /candidate во время вызова → snapshot_mutated; дрейф worktree → worktree_drift_during_review', async t => {
  const { worktree, journal, piRoot, unpack } = await fixture(t);
  const driftFingerprint = () => { let calls = 0; return async () => ({ ...fp(), status: `s${calls++}` }); };
  const mutated = createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeDocker: async () => true, worktreeFingerprintImpl: fp,
    dockerSandbox: async opts => {
      await writeFile(join(opts.snapshot, 'injected.txt'), 'x');
      return { code: 0, stdout: 'T' };
    } });
  await assert.rejects(mutated.observe(request(sol)), /snapshot_mutated/);
  const drifted = createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeDocker: async () => true, worktreeFingerprintImpl: driftFingerprint(),
    dockerSandbox: async () => ({ code: 0, stdout: 'T' }),
    parsePi: () => ({ actual: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' },
      toolsAdded: [], finalText: `${challenge} PASS` }) });
  await assert.rejects(drifted.observe(request(sol)), /worktree_drift_during_review/);
  // Тот же инвариант на Landlock-пути: запись в опубликованный снимок.
  const agyMutated = createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeLandlock: async () => true, worktreeFingerprintImpl: fp,
    agyTransport: async ({ snapshot, publishSnapshot }) => {
      await publishSnapshot();
      await chmod(snapshot, 0o700);
      await writeFile(join(snapshot, 'candidate', 'injected.txt'), 'x');
      await chmod(snapshot, 0o500);
      return { code: 0, stdout: 's', cwd: snapshot };
    } });
  await assert.rejects(agyMutated.observe(request(neon)), /snapshot_mutated/);
});

test('AbortSignal и таймаут: гарантированный cleanup, 0 осиротевших процессов', async t => {
  const { worktree, journal, piRoot, unpack } = await fixture(t);
  const controller = new AbortController();
  let cleaned = false;
  const transport = createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeDocker: async () => true, worktreeFingerprintImpl: fp, signal: controller.signal,
    dockerSandbox: async () => {
      try { await new Promise(resolve => setTimeout(resolve, 60)); return { code: 0, stdout: 'T' }; }
      finally { cleaned = true; }
    } });
  const pending = transport.observe(request(sol));
  setTimeout(() => controller.abort(new Error('stage_aborted')), 10);
  await assert.rejects(pending, /stage_aborted/);
  assert.equal(cleaned, true, 'cleanup транспорта обязан завершиться до отказа');
  // Общий deadline fail-closed до запуска песочницы.
  const late = createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeDocker: async () => true, worktreeFingerprintImpl: fp, deadlineMs: Date.now() + 50,
    dockerSandbox: async () => { throw new Error('must not run'); } });
  await assert.rejects(late.observe(request(sol)), /stage_dispatch_deadline/);
});

test('недостоверный verdict и mismatch модели — fail-closed', async t => {
  const { worktree, journal, piRoot, unpack } = await fixture(t);
  const bad = text => createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeDocker: async () => true, worktreeFingerprintImpl: fp,
    dockerSandbox: async () => ({ code: 0, stdout: 'T' }),
    parsePi: () => ({ actual: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' },
      toolsAdded: [], finalText: text }) });
  await assert.rejects(bad(`${'e'.repeat(64)} PASS`).observe(request(sol)), /stage_verdict_unconfirmed/);
  await assert.rejects(bad('no verdict here').observe(request(sol)), /stage_verdict_unconfirmed/);
  assert.equal(stageVerdictLine(` ${challenge} REWORK`, challenge), 'REWORK');
});

test('реальная сетевая изоляция: connect к :44100 внутри rootless read-only контейнера', async t => {
  const { enrolled } = await probeStageSandboxCapability('docker-ro-v1');
  if (!enrolled) return t.skip('rootless Docker недоступен на хосте');
  const image = await exec('docker', ['image', 'inspect', REVIEW_IMAGE], { timeout: 10_000 }).catch(() => null);
  if (!image) return t.skip('закреплённый образ ревью отсутствует локально');
  const empty = await mkdtemp(join(tmpdir(), 'df-stage-net-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const run = await runInReadOnlySandbox({ snapshot: empty, timeoutMs: 20_000,
    argv: ['node', '-e', 'const s=require("net").connect(44100,"127.0.0.1");' +
      's.on("connect",()=>process.exit(3));s.on("error",()=>process.exit(0));'] });
  assert.equal(run.code, 0, '--network=none: коннект к :44100 обязан быть недостижим');
});
