import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertStageReadOnly, createStageSandboxTransport, observeStageInSandbox,
  probeStageSandboxCapability, settleWithAbort, stageDockerSandbox, stageTransportKind,
  stageVerdictLine } from './stage-sandbox-transport.mjs';
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

test('отменённый вызов не запускает модель; abort во время — остановка и cleanup до отказа', async t => {
  const { worktree, journal, piRoot, unpack } = await fixture(t);
  // Abort ДО observe: ни проб-модели, ни дочернего процесса — сразу причина.
  const pre = new AbortController();
  pre.abort(new Error('kill_switch'));
  let children = 0;
  const aborted = createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeDocker: async () => true, worktreeFingerprintImpl: fp, signal: pre.signal,
    dockerSandbox: async () => { children++; return { code: 0, stdout: 'T' }; } });
  await assert.rejects(aborted.observe(request(sol)), /kill_switch/);
  assert.equal(children, 0, 'отменённая стадия не запускает модель');

  // Abort во время исполнения: сигнал передаётся раннеру, активный процесс
  // останавливается, отказ возвращается только после cleanup раннера.
  const live = new AbortController();
  let seenSignal, cleaned = false;
  const transport = createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeDocker: async () => true, worktreeFingerprintImpl: fp, signal: live.signal,
    dockerSandbox: async opts => {
      seenSignal = opts.signal;
      try {
        await new Promise(resolve => setTimeout(resolve, 15_000));
        return { code: 0, stdout: 'T' };
      } finally { cleaned = true; }
    } });
  const pending = transport.observe(request(sol));
  await new Promise(resolve => setTimeout(resolve, 30));
  live.abort(new Error('lease_lost'));
  await assert.rejects(pending, /lease_lost/);
  assert.equal(seenSignal, live.signal, 'signal передаётся в sandbox-раннер');
  assert.equal(cleaned, true, 'cleanup раннера завершён до отказа');
});

test('закреплённый reasoning: docker исполняет и аттестует уровень, landlock отклоняет неподдерживаемый', async t => {
  const { worktree, journal, piRoot, unpack } = await fixture(t);
  // Docker: закреплённый 'high' уходит в --thinking и сверяется с actual.
  const sandboxes = [];
  const high = createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeDocker: async () => true, worktreeFingerprintImpl: fp,
    dockerSandbox: async opts => { sandboxes.push(opts); return { code: 0, stdout: 'T' }; },
    parsePi: () => ({ actual: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'high' },
      toolsAdded: [], finalText: `${challenge} PASS` }) });
  const { verdict } = await high.observe(request({ ...sol, reasoning: 'high' }));
  assert.equal(verdict, 'PASS');
  const argv = sandboxes[0].argv;
  assert.equal(argv[argv.indexOf('--thinking') + 1], 'high', 'закреплённый уровень исполняется');
  // Фактический уровень не совпал с закреплённым — fail-closed mismatch.
  const mismatch = createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeDocker: async () => true, worktreeFingerprintImpl: fp,
    dockerSandbox: async () => ({ code: 0, stdout: 'T' }),
    parsePi: () => ({ actual: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' },
      toolsAdded: [], finalText: `${challenge} PASS` }) });
  await assert.rejects(mismatch.observe(request({ ...sol, reasoning: 'high' })),
    /stage_reasoning_mismatch/);
  // Landlock: контур аттестует только 'medium' — закреплённый 'high'
  // отклоняется до запуска любого дочернего процесса.
  let agyCalls = 0;
  const landlock = createStageSandboxTransport({ worktree, journal, piRoot, unpack,
    probeLandlock: async () => true, worktreeFingerprintImpl: fp,
    agyTransport: async () => { agyCalls++; return { code: 0, stdout: '', cwd: '' }; } });
  await assert.rejects(landlock.observe(request({ ...neon, reasoning: 'high' })),
    /stage_reasoning_unsupported/);
  assert.equal(agyCalls, 0, 'неподдерживаемый спек не доходит до запуска');
});

test('stageDockerSandbox пробрасывает signal в runInReadOnlySandbox через саму обёртку', async () => {
  const controller = new AbortController();
  let seen;
  const result = await stageDockerSandbox({ allow: ['api.openai.com:443'], argv: ['--print'],
    snapshot: '/tmp/candidate', env: { NODE_OPTIONS: '--require /tmp/pi-guard.cjs', X: 'y' },
    mounts: [{ src: '/tmp/cfg', dst: '/pi-cfg' }], timeoutMs: 60_000,
    beforeEffect: async () => {}, signal: controller.signal }, {
    withProxy: async (opts, cb) => {
      assert.equal(opts.allow[0], 'api.openai.com:443');
      return cb('/tmp/upstream.sock');
    },
    run: async opts => { seen = opts; return { code: 0, stdout: '' }; },
  });
  assert.equal(seen.signal, controller.signal, 'signal обязан дойти до раннера — только он ставит обработчик остановки именованного контейнера');
  assert.equal(seen.argv[0], 'node');
  assert.equal(seen.env.X, 'y');
  assert.equal(seen.env.DF_CHILD_NODE_OPTIONS, '--require /tmp/pi-guard.cjs');
  assert.equal(seen.env.NODE_OPTIONS, undefined);
  assert.deepEqual(seen.mounts.map(m => m.dst), ['/pi-cfg', '/model-proxy/client.cjs', '/model-proxy/upstream.sock']);
  assert.deepEqual(result, { code: 0, stdout: '' });
});

test('settleWithAbort: отказ внутреннего промиса после abort ждёт завершения onAbort', async () => {
  const controller = new AbortController();
  let stopped = false;
  const inner = new Promise((_, reject) => setTimeout(() => reject(new Error('inner_failed')), 20));
  const pending = settleWithAbort(inner, controller.signal, async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
    stopped = true;
  });
  controller.abort();
  await assert.rejects(pending);
  assert.equal(stopped, true, 'отказ не должен обгонять конкурирующий cleanup onAbort');
});

test('abort во время docker run через stageDockerSandbox: отказ после удаления именно этого контейнера', async t => {
  const { enrolled } = await probeStageSandboxCapability('docker-ro-v1');
  if (!enrolled) return t.skip('rootless Docker недоступен на хосте');
  const image = await exec('docker', ['image', 'inspect', REVIEW_IMAGE], { timeout: 10_000 }).catch(() => null);
  if (!image) return t.skip('закреплённый образ ревью отсутствует локально');
  const empty = await mkdtemp(join(tmpdir(), 'df-stage-abort-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const fakeSock = join(empty, 'upstream.sock');
  await writeFile(fakeSock, '');
  // Уникальный маркер этого запуска в env контейнера: параллельное ревью
  // может держать свои board-review-* контейнеры — трогаем только те, у
  // которых docker inspect подтверждает DF_STAGE_TEST_ID этого теста.
  const marker = `DF_STAGE_TEST_ID=${randomUUID()}`;
  const ours = async () => {
    const ids = (await exec('docker',
      ['ps', '-aq', '--filter', 'name=board-review-'], { timeout: 10_000 }))
      .stdout.split('\n').map(line => line.trim()).filter(Boolean);
    const matched = [];
    for (const id of ids) {
      const info = await exec('docker', ['inspect', id], { timeout: 10_000 }).catch(() => null);
      if (info === null) continue;
      const env = JSON.parse(info.stdout)?.[0]?.Config?.Env ?? [];
      if (env.includes(marker)) matched.push(id);
    }
    return matched;
  };
  const rmOurs = async () => {
    for (const id of await ours()) {
      await exec('docker', ['rm', '-f', id], { timeout: 15_000 }).catch(() => {});
    }
  };
  t.after(rmOurs);
  const controller = new AbortController();
  // Запуск идёт именно через обёртку stageDockerSandbox с реальным
  // runInReadOnlySandbox: abort должен добить контейнер ЭТОГО запуска.
  const started = Date.now();
  // Конкурирующий путь продакшена: внутренний вызов обёрнут в
  // settleWithAbort с stopRun, удаляющим контейнер по id, — гонка с rm по
  // имени внутри раннера проверяется на настоящем Docker.
  const pending = settleWithAbort(
    stageDockerSandbox({ allow: ['api.openai.com:443'], snapshot: empty,
      argv: ['/bin/sh', '-c', 'sleep 60'], env: { DF_STAGE_TEST_ID: marker.split('=')[1] },
      timeoutMs: 60_000, signal: controller.signal }, {
      withProxy: async (opts, cb) => cb(fakeSock) }),
    controller.signal,
    rmOurs);
  // Подтверждённый старт: ждём появления контейнера с маркером именно этого
  // запуска — чужие board-review-* без нашего env не считаются.
  let oursId = null;
  for (let poll = 0; poll < 40 && oursId === null; poll++) {
    const matched = await ours();
    if (matched.length) oursId = matched[0];
    else await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(oursId, 'контейнер этого запуска обязан появиться до abort');
  controller.abort(new Error('kill_switch'));
  await assert.rejects(pending, /kill_switch/);
  assert.ok(Date.now() - started < 30_000,
    'отмена останавливает контейнер немедленно, не дожидаясь 60-секундного сна');
  // К моменту отказа именно этот контейнер уже удалён — cleanup завершён.
  const inspect = await exec('docker', ['inspect', oursId], { timeout: 10_000 }).catch(e => e);
  assert.ok(inspect instanceof Error && /No such (object|container)/i.test(String(inspect.stderr ?? inspect)),
    'осиротевшего контейнера этого запуска не остаётся');
});
