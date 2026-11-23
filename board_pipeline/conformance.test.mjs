// Conformance / fault-injection VS-1.5: реальный controller.mjs + acceptHeld +
// native-board + slot.mjs поверх настоящего loopback `vb serve --port 0`
// (никогда :44100), реальной ФС и flock. Внешний порт BB и наблюдение ходов —
// детерминированные cut points со счётчиком эффектов на стороне порта, а не по
// журналу контроллера. Пять трасс повторяют пять TLA+ инвариантов; шестой блок
// проверяет, что снятие каждого гварда ломает соответствующий инвариант.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFile, execFileSync, spawn as spawnProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { acceptHeld } from './acceptance.mjs';
import { advanceWithProjection } from './controller.mjs';
import { boardActivation, createPilotSwitch, guardedEffect } from './pilot-gate.mjs';
import { localReleasePort } from './local-release.mjs';
import { digestBytes, enrollLocalTarget, makeReleaseRecord, readTargetRecord, serveLocalTarget } from './release-target.mjs';
import { buildSubject, subjectDigest } from './subject.mjs';
import { nativeBoardPort } from './native-board.mjs';
import { reserveWorktree, saveState } from './slot.mjs';
import { answerBytes, signedAnswerVerifier } from './question-gate.mjs';
import { loadSdk } from './sdk.mjs';
import { worktreeInspector } from './runtime.mjs';
import { tamperGate } from './tamper-gate.mjs';
import { createTelemetryRecorder } from './telemetry.mjs';
import { loadRoleRegistry } from './role-registry.mjs';
import { runPlaybook } from './playbook-router.mjs';
import { PLAYBOOK_TRIAD, stageObservation } from './playbook-test-fixture.mjs';
import * as ws from './worker-selector.mjs';

const exec = promisify(execFile);
const REVIEW = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };
const SPEC = 'a'.repeat(64);
const POLICY_DIGEST = 'b'.repeat(64);
const REPO = 'darkfactory-vs1-fixture';
const LABELS = { spec_digest: SPEC, policy_digest: POLICY_DIGEST, repo_id: REPO,
  profile_id: 'pilot', finish: 'verified', queue: 'vs1' };
const BAD1 = 'b' + '1'.repeat(39);
const BAD2 = 'b' + '2'.repeat(39);
const FINDING = { file: 'a.js', expected: 'spec behaviour', actual: 'other behaviour' };
const L2_REWORK = (findings) => ({
  outcome: 'rework', reason: 'review_verdict:REVIEW_BLOCKED',
  subject_digest: 'd'.repeat(64),
  feedback: { reason: 'review_verdict:REVIEW_BLOCKED', findings },
});
const L1_REWORK = {
  outcome: 'rework', reason: 'local_checks_failed',
  feedback: { reason: 'local_checks_failed', evidence: [
    { file: 'checks-a.log', exit: 1, sha256: 'e'.repeat(64) }] },
};

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(cwd, title) {
  git(cwd, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture',
    '-c', 'commit.gpgsign=false', 'commit', '-m', title);
}
function boardCli() {
  const cli = join(homedir(), '.local/share/vercel-board/node_modules/@vercel/board/dist/cli.mjs');
  readFileSync(cli);
  return cli;
}
async function startBoard(cli, t) {
  const dir = await mkdtemp(join(tmpdir(), 'vs1-conformance-board-'));
  const child = spawnProcess(process.execPath, [cli, 'serve', '--port', '0',
    '--dir', join(dir, '.board'), '--no-inspect', '--no-open'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); return rm(dir, { recursive: true, force: true }); });
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`vb serve did not report a URL: ${buffer}`)), 20_000);
    child.stdout.on('data', data => {
      buffer += String(data);
      const match = /serving a local board at (http:\/\/127\.0\.0\.1:\d+\/api\/board)/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('exit', code => reject(new Error(`vb serve exited early: ${code}`)));
  });
  return { url, dir };
}

async function enrollPilotFixture({ root, handle, url, channel, owner, pilotScope, finish, effects }) {
  const projections = [];
  let afterRead;
  const settings = join(root, 'operator');
  await mkdir(settings, { mode: 0o700 });
  const switchFile = join(settings, 'switch');
  await writeFile(switchFile, 'run\n', { mode: 0o600 });
  const activation = boardActivation({ scope: 'pilot', boardUrl: url, channel,
    owner: pilotScope.owner ?? owner, label: { key: 'queue', value: 'vs1' },
    route: { repoId: pilotScope.repoId ?? REPO, checkProfile: pilotScope.profileId ?? 'pilot', finish },
    pilot: { enabled: true, killSwitch: switchFile } }, { pilotChannel: 'fixture-pilot' });
  const admission = { scope: activation.scope, assertOpen: await createPilotSwitch(switchFile) };
  effects.nativeClaims = 0;
  const portHandle = { ...handle,
    tasks: { ...handle.tasks, claim: async (...args) => { effects.nativeClaims++; return handle.tasks.claim(...args); } },
    async thread(...args) { const snapshot = await handle.thread(...args); await afterRead?.(snapshot.message); return snapshot; },
    async label(id, change) {
      const applied = await handle.label(id, change);
      projections.push((await handle.thread(id, { limit: 1 })).message.labels);
      return applied;
    },
  };
  return { admission, portHandle, controls: { projections,
    setSwitch: value => writeFile(switchFile, value), afterRead: hook => { afterRead = hook; } } };
}

// Полный лабораторный стенд: живая Board, git worktree, слот-бронь, порты со
// счётчиками и хранилище записи попытки — всё как в run-isolated, но под тестом.
async function lab(t, { finish = 'verified', lease = 900, mutants, questions = false,
  pilot = false, pilotScope = {}, hasUi = false } = {}) {
  const { url, dir } = await startBoard(boardCli(), t);
  const channel = pilot ? 'fixture-pilot' : 'pilot';
  process.env.BOARD_URL = url;
  const { board } = loadSdk();
  const handle = board();
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { await handle.createChannel(channel); break; }
    catch (error) {
      if (attempt === 5) throw error;
      await delay(300);
    }
  }
  const root = await mkdtemp(join(tmpdir(), 'vs1-conformance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = join(root, 'worktree');
  const stateDir = join(root, 'state');
  const registry = join(root, 'slots');
  await mkdir(tree, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  git(tree, 'init', '--initial-branch=pilot');
  await writeFile(join(tree, 'check.mjs'), 'process.exit(0);\n');
  git(tree, 'add', 'check.mjs');
  commit(tree, 'Synthetic base');
  const base = git(tree, 'rev-parse', 'HEAD');
  await writeFile(join(tree, 'check.mjs'), 'console.log("candidate"); process.exit(0);\n');
  git(tree, 'add', 'check.mjs');
  commit(tree, 'Synthetic candidate');
  const candidate = git(tree, 'rev-parse', 'HEAD');

  const { task } = await handle.tasks.create(channel, { text: 'Synthetic conformance',
    noSync: true, labels: { ...LABELS, finish, ...(hasUi ? { has_ui: 'true' } : {}) } });
  const owner = (await handle.thread(task.id, { limit: 1 })).message.task.owner;
  const card = async () => (await handle.thread(task.id, { limit: 1 })).message.task;

  // Счётчики эффектов на стороне портов — внешний факт, не журнал контроллера.
  const effects = { spawnCalls: 0, feedbackCalls: 0, completeCalls: 0, blockCalls: 0,
    verifyCalls: 0, localCalls: 0, reviewCalls: 0, arbiterCalls: 0, delivered: [] };
  const { admission, portHandle = handle, controls } = pilot
    ? await enrollPilotFixture({ root, handle, url, channel, owner, pilotScope, finish, effects }) : {};
  const port = nativeBoardPort(portHandle, { channel, lease, isolatedQuestionOwner: questions, pilot: admission });
  const realComplete = port.complete.bind(port);
  const realBlock = port.block.bind(port);
  port.complete = async (...args) => { effects.completeCalls++; return realComplete(...args); };
  port.block = async (...args) => { effects.blockCalls++; return realBlock(...args); };

  // Порт BB — cut point с настраиваемым «проводом»: spawn может создать тред и
  // оборваться до ответа; сверка честно отвечает пустым/одним/несколькими.
  const bb = {
    spawnOutcome: 'ok',          // 'ok' | 'lost_ack'
    spawnRegistry: [],           // треды, реально созданные «на проводе»
    spawn(threadId) { this.spawnOutcome = 'ok'; this.fixedThread = threadId; },
    reconcileSpawnResult: { status: 'empty' },
    reconcileFeedbackResult: { status: 'empty' },
    async spawn(envelope) {
      await port.guardTask?.(envelope.task_id, envelope.epoch);
      effects.spawnCalls++;
      const threadId = bb.fixedThread ?? `thr_wire${effects.spawnCalls}`;
      bb.spawnRegistry.push(threadId);
      if (bb.spawnOutcome === 'lost_ack') throw new Error('lost transport response');
      return { threadId };
    },
    async feedback(packet) {
      await port.guardTask?.(packet.attempt.task_id, packet.attempt.epoch);
      effects.feedbackCalls++;
      bb.delivered.push(packet.feedbackId);
      if (bb.feedbackOutcome === 'lost_ack') throw new Error('lost transport response');
      return { confirmed: true };
    },
    feedbackOutcome: 'ok',
    delivered: [],
    async reconcileSpawn() { return bb.reconcileSpawnResult; },
    async reconcileFeedback() { return bb.reconcileFeedbackResult; },
  };

  // Очередь ходов BB: каждый элемент — turnSeq и опциональная сдача SHA.
  // Флаг replay моделирует повторную выдачу старого события из журнала BB —
  // защита от зачёта такого хода обязана быть на стороне контроллера.
  let turns = [];
  const submissions = { async read(attempt, after) {
    const next = turns.find(entry => entry.seq > after || entry.replay === true);
    if (!next) return;
    return { turnSeq: next.seq, submission: (next.sha || next.question) && {
      task_id: attempt.task_id, epoch: attempt.epoch, attempt_id: attempt.attempt_id,
      worker_thread_id: attempt.bb_thread_id,
      ...(next.question ? { question: next.question } : { candidate_sha: next.sha }),
      ...(next.dispute ? { dispute: next.dispute } : {}) } };
  } };

  const policyFor = (attempt) => ({ version: 'vs1-5', digest: POLICY_DIGEST,
    profiles: { pilot: { task: attempt.task_id, worker: attempt.bb_thread_id,
      worktree: tree, branch: 'pilot', base: attempt.base_sha,
      finish: attempt.finish, review: REVIEW } } });

  // Верификатор по умолчанию — настоящий acceptHeld с зелёным L1/критиком.
  // Сценарий sha->result подменяет исход, но порт Board остаётся реальным.
  let scripted = {};
  let unsafePorts = {};
  let beforeReview;
  const verify = async (attempt, submission) => {
    effects.verifyCalls++;
    const hit = scripted[submission.candidate_sha];
    if (hit) return typeof hit === 'function' ? hit(attempt, submission) : hit;
    const policy = policyFor(attempt);
    const journal = await mkdtemp(join(root, 'journal-'));
    return acceptHeld({ attempt, submission, policy, journal, ports: {
      board: port,
      inspect: worktreeInspector(policy),
      local: async binding => { await port.guardTask?.(attempt.task_id, attempt.epoch); effects.localCalls++;
        return { sha: binding.candidate_sha, ok: true,
          evidence: [{ file: 'checks-vs1.log', sha256: 'f'.repeat(64), exit: 0 }] }; },
      tamper: tamperGate,
      review: async binding => {
        await port.guardTask?.(attempt.task_id, attempt.epoch);
        await beforeReview?.(binding, attempt);
        effects.reviewCalls++;
        return { task: binding.task_id, sha: binding.candidate_sha,
          actual: REVIEW, verdict: 'REVIEW_OK', checkpoint: 'feed80ab' }; },
      ...(typeof unsafePorts === 'function' ? unsafePorts(journal) : unsafePorts),
    } });
  };

  let stored;
  const state = {
    load: async () => structuredClone(stored),
    save: async value => { stored = structuredClone(value); },
  };
  const cfg = {
    route: { allowlist: { owner: admission?.scope.owner ?? owner, label: { key: 'queue', value: 'vs1' },
      ...(admission ? { repoId: admission.scope.repoId } : {}) }, base,
      policyVersion: 'vs1-5', checkProfile: admission?.scope.profileId ?? 'pilot', worktree: tree, finish },
    authorize: async () => true,
    state, board: port, bb, submissions, verify,
    ...(mutants ? { mutants } : {}),
  };
  const releaseSlot = await reserveWorktree(registry, tree, stateDir);
  t.after(() => releaseSlot());
  const tick = guardedEffect(admission?.assertOpen, advanceWithProjection);
  return {
    handle, port, bb, effects, cfg, card, tree, root, registry, stateDir, dir, url, channel, ...controls,
    taskId: task.id, base, candidate, stored: () => stored,
    submit: (sha, seq, extra = {}) => { turns.push({ seq, sha, ...extra }); },
    pushTurn: entry => { turns.push(entry); },
    setScript: map => { scripted = map; },
    setUnsafePorts: p => { unsafePorts = p; },
    setBeforeReview: fn => { beforeReview = fn; },
    releaseSlot,
    tick: () => tick(cfg),
    workerSelector: over => { cfg.workerSelector = { ...ws, critic: REVIEW,
      // This conformance fixture intentionally uses the legacy Pi/Sol critic.
      arbiter: { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'high' },
      arbitrate: async req => { effects.arbiterCalls++;
        return { decision: 'escalate_owner', question: 'owner?', subject_digest: 'd'.repeat(64) }; },
      ...over }; },
  };
}

async function enrollBetaPlaybook(x, registry, playbook, observeStage = stageObservation) {
  const stopDir = join(x.root, 'beta-switch');
  await mkdir(stopDir, { mode: 0o700 });
  const stop = join(stopDir, 'switch');
  await writeFile(stop, 'run\n', { mode: 0o600 });
  const assertOpen = await createPilotSwitch(stop);
  x.setBeforeReview(async (handoff, attempt) => {
    const policy = { profiles: { pilot: { task: x.taskId, worker: handoff.worker_thread_id,
      worktree: x.tree, branch: 'pilot', base: x.base } } };
    const inspect = worktreeInspector(policy);
    const subject = { ...handoff, attempt_id: attempt.attempt_id, epoch: attempt.epoch,
      playbook, registry_digest: registry.digest };
    const result = await runPlaybook({ registry, playbook, attempt: subject, triad: PLAYBOOK_TRIAD }, {
      async assertKernel(binding) {
        await assertOpen();
        const live = await x.port.verifyHeld(binding.task_id, binding.epoch);
        const tree = await inspect(handoff);
        await assertOpen();
        return { ...binding, held: live.epoch === binding.epoch && Date.parse(live.until) > Date.now(),
          switchOpen: true, clean: tree.clean && tree.head === binding.candidate_sha, baseAncestor: tree.baseAncestor };
      },
      observeStage,
    });
    if (result.status !== 'ready_for_native_acceptance') throw new Error('beta_role_playbook_hold');
  });
  return stop;
}

test('VS-5 beta: four role DAGs on native Board and exact Git subject before independent acceptance', { timeout: 60_000 }, async t => {
  const registry = await loadRoleRegistry(fileURLToPath(new URL('..', import.meta.url)));
  const packs = {
    ui: ['materials-reader', 'ui-builder', 'visual-verifier'],
    'math-lean': ['materials-reader', 'conjecturer', 'falsify-first-oracle', 'lean-prover', 'literature-radar'],
    'dsp-audio': ['materials-reader', 'dsp-experimenter', 'pipeline-freezer', 'blind-panel'],
    'writer-course': ['materials-reader', 'course-designer', 'technical-writer', 'sparring-critic'],
  };
  for (const [pack, expected] of Object.entries(packs)) {
    const x = await lab(t, { hasUi: pack === 'ui' });
    if (pack === 'ui') {
      x.setUnsafePorts({
        visual: async binding => ({ ok: true, status: 'pass', sha: binding.candidate_sha,
          artifacts: [{ name: 'page.png', sha256: 'a'.repeat(64), bytes: 5 }],
          evidence: { file: 'visual.log', sha256: 'e'.repeat(64), exit: 0 } }),
      });
    }
    const roles = [];
    const subjects = new Set();
    let previousArtifact = null;
    await enrollBetaPlaybook(x, registry, pack, request => {
      assert.equal(request.binding.task_id, x.taskId);
      assert.equal(request.binding.candidate_sha, x.candidate);
      assert.equal(request.binding.worktree, x.tree);
      assert.equal(x.effects.completeCalls, 0);
      assert.equal(x.effects.reviewCalls, 0, 'beta may not substitute for the independent gate');
      assert.ok(request.skills.every(skill => skill.text.trim() && /^[a-f0-9]{64}$/.test(skill.digest)));
      roles.push(request.role);
      subjects.add(request.binding.subject_digest);
      assert.equal(request.inputArtifactDigest, previousArtifact);
      const receipt = stageObservation(request);
      previousArtifact = receipt.artifactDigest;
      return receipt;
    });
    assert.equal((await x.tick()).phase, 'working');
    x.submit(x.candidate, 10);
    const final = await x.tick();
    assert.equal(final.phase, 'done', `${pack}: ${final.reason}`);
    const { state, result } = await x.port.lookup(x.taskId);
    assert.equal(state, 'completed');
    assert.equal(result.sha, x.candidate);
    assert.deepEqual([...subjects], [result.subject_digest]);
    assert.deepEqual(roles, expected);
    assert.equal(x.effects.spawnCalls, 1);
    assert.equal(x.effects.reviewCalls, 1);
    assert.equal(x.effects.completeCalls, 1);
  }
});

test('VS-5 beta: losing the switch during an observation prevents L2 and native completion', { timeout: 30_000 }, async t => {
  const registry = await loadRoleRegistry(fileURLToPath(new URL('..', import.meta.url)));
  const x = await lab(t);
  let stageCalls = 0;
  const stop = await enrollBetaPlaybook(x, registry, 'math-lean', async request => {
    stageCalls++;
    await writeFile(stop, 'stop\n');
    return stageObservation(request);
  });
  assert.equal((await x.tick()).phase, 'working');
  x.submit(x.candidate, 10);
  assert.equal((await x.tick()).phase, 'hold');
  assert.notEqual((await x.card()).state, 'completed');
  assert.equal(x.effects.reviewCalls, 0);
  assert.equal(x.effects.completeCalls, 0);
  assert.equal(stageCalls, 1);
});

// ---------------------------------------------------------------------------
// Трасса 1A: потерянный ack после реального эффекта spawn — однозначное
// совпадение при живой аренде: adopt без второго spawn.
test('trace1a: lost spawn ack, reconcile finds exactly one thread — adopt, 0 re-spawn', async t => {
  const x = await lab(t);
  x.bb.spawnOutcome = 'lost_ack';
  x.bb.fixedThread = 'thr_lost1';
  x.bb.reconcileSpawnResult = { status: 'matched', threadId: 'thr_lost1' };
  const first = await x.tick();
  assert.equal(first.phase, 'working');
  assert.equal(first.threadId, 'thr_lost1');
  assert.equal(x.effects.spawnCalls, 1, 'ни одного повторного bb.spawn');
  const record = x.stored();
  assert.equal(record.receipt.kind, 'spawn');
  assert.equal(record.receipt.confirmed, 'reconciled');
  x.submit(x.candidate, 10);
  assert.equal((await x.tick()).phase, 'done');
  assert.equal(x.effects.spawnCalls, 1);
  assert.equal(x.effects.completeCalls, 1);
});

// Трасса 1A-restart: запись IN_FLIGHT(launching) пережила процессный крах —
// reconcile при старте тика подхватывает тот же тред.
test('trace1a-restart: crash after WAL intent, restart reconcile adopts the wire thread', async t => {
  const x = await lab(t);
  assert.equal((await x.tick()).phase, 'working'); // claim+spawn ok
  const crashed = { ...x.stored(), phase: 'launching', threadId: undefined,
    receipt: undefined,
    intent: { kind: 'spawn', attemptId: x.stored().attemptId, epoch: x.stored().epoch,
      marker: x.stored().attemptId } };
  await x.cfg.state.save(crashed);
  x.bb.reconcileSpawnResult = { status: 'matched', threadId: 'thr_lost1' };
  const res = await x.tick();
  assert.equal(res.phase, 'working');
  assert.equal(res.threadId, 'thr_lost1');
  assert.equal(x.effects.spawnCalls, 1, 'reconcile не вызывает spawn');
});

// Трасса 1A-selector: workerSelector включён, bb.spawn оборвался внутри
// attemptSpawnWithFallback → outcome 'uncertain' НЕ финален: контроллер
// сверяет wire через reconcileSpawn, подхватывает тред и доводит до done.
test('trace1a-selector: lost spawn ack under workerSelector — reconcile adopts, 0 re-spawn', async t => {
  const x = await lab(t);
  x.workerSelector();
  x.bb.spawnOutcome = 'lost_ack';
  x.bb.fixedThread = 'thr_lost1';
  x.bb.reconcileSpawnResult = { status: 'matched', threadId: 'thr_lost1' };
  const first = await x.tick();
  assert.equal(first.phase, 'working');
  assert.equal(first.threadId, 'thr_lost1');
  assert.equal(x.effects.spawnCalls, 1, 'ни одного повторного bb.spawn');
  const record = x.stored();
  assert.equal(record.receipt.kind, 'spawn');
  assert.equal(record.receipt.confirmed, 'reconciled');
  x.submit(x.candidate, 10);
  assert.equal((await x.tick()).phase, 'done');
  assert.equal(x.effects.spawnCalls, 1);
  assert.equal(x.effects.completeCalls, 1);
});

// Регрессия: рестарт в фазе blocking с записью блокировки, причина которой НЕ
// совпадает с фактической на карточке — не подтверждённый чужой эффект, а
// uncertain без повторного board.block.
test('blocking reconcile: чужая причина на карточке — blocking_reason_mismatch, 0 повторных block', async t => {
  const x = await lab(t);
  assert.equal((await x.tick()).phase, 'working');
  // Реальный board.block другим текстом через удерживаемую аренду.
  await x.port.block(x.taskId, x.stored().epoch, 'external hold: чужая причина');
  assert.equal(x.effects.blockCalls, 1);
  const crashed = { ...x.stored(), phase: 'blocking',
    intent: { kind: 'block', attemptId: x.stored().attemptId, epoch: x.stored().epoch,
      turnSeq: 10, reason: 'worker_turn_finished_without_new_handoff',
      blockText: 'worker_turn_finished_without_new_handoff: thr_wire1, BB event 10.' } };
  await x.cfg.state.save(crashed);
  const res = await x.tick();
  assert.equal(res.phase, 'uncertain');
  assert.equal(res.reason, 'blocking_reason_mismatch');
  assert.equal(x.effects.blockCalls, 1, 'повторный board.block не отправлен');
});

// Регрессия: тот же префикс причины, но другой номер хода — строгое равенство
// blockText не выполняется, эффект чужой → uncertain без повторного block.
test('blocking reconcile: тот же префикс, другой BB event — blocking_reason_mismatch', async t => {
  const x = await lab(t);
  assert.equal((await x.tick()).phase, 'working');
  await x.port.block(x.taskId, x.stored().epoch,
    'worker_turn_finished_without_new_handoff: thr_wire1, BB event 11. Проверьте ход; повтор не отправлен.');
  const crashed = { ...x.stored(), phase: 'blocking',
    intent: { kind: 'block', attemptId: x.stored().attemptId, epoch: x.stored().epoch,
      turnSeq: 10, reason: 'worker_turn_finished_without_new_handoff',
      blockText: 'worker_turn_finished_without_new_handoff: thr_wire1, BB event 10. Проверьте ход; повтор не отправлен.' } };
  await x.cfg.state.save(crashed);
  const res = await x.tick();
  assert.equal(res.phase, 'uncertain');
  assert.equal(res.reason, 'blocking_reason_mismatch');
  assert.equal(x.effects.blockCalls, 1, 'повторный board.block не отправлен');
});

// Регрессия: рестарт в фазе blocking с НАШЕЙ причиной — adopt наблюденного
// эффекта в hold без повторного board.block.
test('blocking reconcile: наша причина на карточке — observed block в hold, 0 повторных block', async t => {
  const x = await lab(t);
  assert.equal((await x.tick()).phase, 'working');
  const blockText = 'worker_turn_finished_without_new_handoff: thr_wire1, BB event 10. Проверьте ход; повтор не отправлен.';
  await x.port.block(x.taskId, x.stored().epoch, blockText);
  assert.equal(x.effects.blockCalls, 1);
  const crashed = { ...x.stored(), phase: 'blocking',
    intent: { kind: 'block', attemptId: x.stored().attemptId, epoch: x.stored().epoch,
      turnSeq: 10, reason: 'worker_turn_finished_without_new_handoff', blockText } };
  await x.cfg.state.save(crashed);
  const res = await x.tick();
  assert.equal(res.phase, 'hold');
  assert.equal(res.reason, 'worker_turn_finished_without_new_handoff');
  assert.equal(x.effects.blockCalls, 1, 'повторный board.block не отправлен');
});

// Трасса 1B: эффект «на проводе», но выдача списка BB пустая — карантин,
// ноль повторных spawn, worktree остаётся в брони.
test('trace1b: empty BB listing after lost ack — quarantine, no re-spawn, slot kept', async t => {
  const x = await lab(t);
  x.bb.spawnOutcome = 'lost_ack';
  x.bb.reconcileSpawnResult = { status: 'empty' };
  const first = await x.tick();
  assert.equal(first.phase, 'uncertain');
  assert.equal(first.reason, 'spawn_outcome_unconfirmed_quarantine');
  for (let i = 0; i < 2; i++) {
    assert.equal((await x.tick()).phase, 'uncertain');
  }
  assert.equal(x.effects.spawnCalls, 1, 'пустая выдача BB не порождает второго писателя');
  assert.equal(x.effects.completeCalls, 0);
  // Долговечная бронь держит карантин: другой писатель в тот же worktree не пускается.
  await x.releaseSlot(); // flock снят, reservation-файл сохранён
  const otherState = join(x.root, 'state-other');
  await mkdir(otherState, { mode: 0o700 });
  await assert.rejects(reserveWorktree(x.registry, x.tree, otherState),
    /Prior writer is still reserved/);
});

// ---------------------------------------------------------------------------
// Трасса 2: истёкшая аренда + живой зомби-писатель — новый epoch не получает
// worktree, запоздалая сдача старой эпохи отсекается серверным fence до проверок.
test('trace2: stale epoch + live zombie writer — slot denies, stale handoff fenced', async t => {
  // Минимальная аренда vb — 30s; ждём реальное истечение на живом сервере.
  const x = await lab(t, { lease: 30 });
  assert.equal((await x.tick()).phase, 'working');
  const attemptRecord = x.stored();
  await delay(31_500);

  // Контроллер #2: новый порт, новый epoch на том же сервере.
  const port2 = nativeBoardPort(x.handle, { channel: 'pilot', lease: 900 });
  const second = await port2.claim(x.taskId);
  assert.ok(second.epoch > attemptRecord.epoch, 'новая серверная эпоха');

  // Слот отклоняет второго писателя: бронь state dir первого контроллера жива.
  await x.releaseSlot();
  const state2 = join(x.root, 'state-epoch2');
  await mkdir(state2, { mode: 0o700 });
  await assert.rejects(reserveWorktree(x.registry, x.tree, state2),
    /Prior writer is still reserved/);

  // Запоздалая сдача эпохи 1 отклоняется ДО проверок: verifyHeld->renew даёт
  // claim_lost на живом сервере. Локальных проверок и complete — ноль.
  const staleAttempt = { task_id: x.taskId, attempt_id: attemptRecord.attemptId,
    epoch: attemptRecord.epoch, bb_thread_id: 'thr_stale', worktree: x.tree,
    base_sha: x.base, check_profile: 'pilot', finish: 'verified',
    repo_id: REPO, spec_digest: SPEC, policy_digest: POLICY_DIGEST,
    fixtures_digest: null };
  const submission = { task_id: x.taskId, epoch: attemptRecord.epoch,
    attempt_id: attemptRecord.attemptId, worker_thread_id: 'thr_stale',
    candidate_sha: x.candidate };
  const policy = { version: 'vs1-5', digest: POLICY_DIGEST, profiles: { pilot: {
    task: x.taskId, worker: 'thr_stale', worktree: x.tree, branch: 'pilot',
    base: x.base, finish: 'verified', review: REVIEW } } };
  const journal = await mkdtemp(join(x.root, 'journal-stale-'));
  const outcome = await acceptHeld({ attempt: staleAttempt, submission, policy,
    journal, ports: { board: x.port, inspect: worktreeInspector(policy),
      local: async b => { x.effects.localCalls++; return { sha: b.candidate_sha, ok: true,
        evidence: [] }; },
      tamper: tamperGate,
      review: async b => ({ task: b.task_id, sha: b.candidate_sha, actual: REVIEW,
        verdict: 'REVIEW_OK', checkpoint: 'feed80ab' }) } });
  assert.equal(outcome.outcome, 'denied');
  assert.match(outcome.reason, /claim_not_held/);
  assert.equal(x.effects.localCalls, 0, 'проверки не запускались');
  assert.equal(x.effects.completeCalls, 0, 'complete не вызывался из приёмки');
  // Прямой complete под старой эпохой отвергается серверным fence (claim_lost).
  await assert.rejects(x.port.complete(x.taskId, attemptRecord.epoch,
    { sha: x.candidate }));
});

// ---------------------------------------------------------------------------
// Трасса 3: TOCTOU-дрейф — spec_digest карточки меняется между L2 и seal.
test('trace3: contract drift before seal — hold + blocked, zero completes', async t => {
  const x = await lab(t);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(x.candidate, 10);
  // Порт ревью — честный, но ДО seal на живой Board меняется метка спеки.
  x.setUnsafePorts({ review: async binding => {
    x.effects.reviewCalls++;
    await x.handle.label(x.taskId, { set: { spec_digest: 'f'.repeat(64) } });
    return { task: binding.task_id, sha: binding.candidate_sha, actual: REVIEW,
      verdict: 'REVIEW_OK', checkpoint: 'feed80ab' };
  } });
  const res = await x.tick();
  assert.equal(res.phase, 'hold');
  assert.match(res.reason ?? '', /drift|seal|hold/i);
  assert.equal((await x.card()).state, 'blocked');
  assert.equal(x.effects.completeCalls, 0, 'Board.complete не вызван ни разу');
});

// ---------------------------------------------------------------------------
// Трасса 4: lost feedback ack — reconcile подтверждает доставку без дубля;
// старый ход по watermark не засчитывается; новый ход завершает карточку.
test('trace4: lost feedback ack reconciles delivered; stale turn waits, new turn completes', async t => {
  const x = await lab(t);
  assert.equal((await x.tick()).phase, 'working');
  x.setScript({ [BAD1]: L1_REWORK });
  x.submit(BAD1, 10);
  // feedback доставлен «на проводе», ack потерян до сохранения working.
  x.bb.feedbackOutcome = 'lost_ack';
  x.bb.reconcileFeedbackResult = { status: 'delivered' };
  const after = await x.tick();
  assert.equal(after.phase, 'working');
  assert.equal(x.effects.feedbackCalls, 1, 'feedback не продублирован');
  assert.equal(x.bb.delivered.length, 1);
  const record = x.stored();
  assert.equal(record.turnSeq, 10);
  assert.equal(record.receipt.kind, 'feedback');
  assert.equal(record.receipt.confirmed, 'reconciled');

  // В BB всё ещё только старый ход turnSeq=10: контроллер ждёт, не блокируя.
  x.pushTurn({ seq: 10 });
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(x.effects.verifyCalls, 1, 'старый ход не засчитан повторно');
  assert.equal(x.effects.blockCalls, 0);

  // Новый ход с новым SHA завершает карточку; повторные тики — ноль эффектов.
  x.submit(x.candidate, 20);
  assert.equal((await x.tick()).phase, 'done');
  assert.equal(x.effects.completeCalls, 1);
  assert.equal((await x.tick()).phase, 'done');
  assert.equal(x.effects.verifyCalls, 2);
  assert.equal(x.effects.feedbackCalls, 1);
});

// ---------------------------------------------------------------------------
// Трасса 5: повторный дефект без прогресса — содержательный арбитраж/эскалация,
// никакого «два круга и закрыть». harm=10 — прямо к владельцу.
test('trace5: repeated defect arbitrates, never auto-closes; harm10 goes to owner', async t => {
  const x = await lab(t);
  x.workerSelector();
  assert.equal((await x.tick()).phase, 'working');
  x.setScript({ [BAD1]: L2_REWORK([FINDING]), [BAD2]: L2_REWORK([FINDING]) });
  x.submit(BAD1, 10);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(BAD2, 20);
  const out = await x.tick();
  assert.equal(out.phase, 'hold');
  assert.equal(out.reason, 'arbiter_escalated_to_owner');
  assert.equal(x.effects.arbiterCalls, 1, 'арбитр вызван по содержательному триггеру');
  assert.equal(x.effects.completeCalls, 0, 'карточка не закрыта по счётчику кругов');
  assert.equal((await x.card()).state, 'blocked');

  const y = await lab(t);
  y.workerSelector({ arbitrate: async () => { y.effects.arbiterCalls++;
    return { decision: 'accept_with_notes', notes: 'n', subject_digest: 'd'.repeat(64) }; } });
  assert.equal((await y.tick()).phase, 'working');
  y.setScript({ [BAD1]: L2_REWORK([FINDING]), [BAD2]: L2_REWORK([{ ...FINDING, harm: 10 }]) });
  y.submit(BAD1, 10);
  assert.equal((await y.tick()).phase, 'working');
  y.submit(BAD2, 20);
  const res = await y.tick();
  assert.equal(res.phase, 'hold');
  assert.equal(res.reason, 'harm10_requires_owner');
  assert.equal(y.effects.arbiterCalls, 0, 'harm=10 не принимается арбитром');
  assert.equal(y.effects.completeCalls, 0);
  assert.equal((await y.card()).state, 'blocked');
});

// ---------------------------------------------------------------------------
// Гвард-мутанты: снятие каждого из пяти гвардов гарантированно ломает
// соответствующий conformance-инвариант на той же реальной границе.
test('guard-mutant M1 SingleLiveWriter: takeover frees the slot under a live writer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vs1-mut-slot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, 'slots');
  const tree = join(root, 'tree');
  const s1 = join(root, 's1');
  const s2 = join(root, 's2');
  await mkdir(tree);
  await mkdir(s1, { mode: 0o700 });
  await mkdir(s2, { mode: 0o700 });
  const rel = await reserveWorktree(registry, tree, s1);
  await rel();
  await assert.rejects(reserveWorktree(registry, tree, s2),
    /Prior writer is still reserved/, 'база: бронь держит второго писателя');
  const mutant = await reserveWorktree(registry, tree, s2,
    { allowTakeoverWithLiveWriter: true });
  await mutant();
  // Инвариант сломан: два писателя последовательно получили один worktree.
});

test('guard-mutant M2 NoDuplicateSpawn: retry on empty observation spawns twice', async t => {
  const x = await lab(t, { mutants: { retrySpawnOnEmpty: true } });
  x.bb.spawnOutcome = 'lost_ack';
  x.bb.reconcileSpawnResult = { status: 'empty' };
  const res = await x.tick();
  assert.equal(x.effects.spawnCalls, 2, 'мутант повторил spawn на пустой выдаче');
  assert.ok(res.phase !== 'done');
});

test('guard-mutant M3 NoStaleCommit: skipped seal check completes under drift', async t => {
  const x = await lab(t);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(x.candidate, 10);
  x.setUnsafePorts({ __unsafeSkipSealCheck: true,
    review: async binding => {
      await x.handle.label(x.taskId, { set: { spec_digest: 'f'.repeat(64) } });
      return { task: binding.task_id, sha: binding.candidate_sha, actual: REVIEW,
        verdict: 'REVIEW_OK', checkpoint: 'feed80ab' };
    } });
  const res = await x.tick();
  assert.equal(res.phase, 'done', 'мутант закрыл карточку под дрейфом контракта');
  assert.equal(x.effects.completeCalls, 1);
});

test('guard-mutant M4 NoWatermarkRegression: stale turn accepted after feedback', async t => {
  const x = await lab(t, { mutants: { staleTurnWatermark: true } });
  assert.equal((await x.tick()).phase, 'working');
  x.setScript({ [BAD1]: L1_REWORK });
  x.submit(BAD1, 10);
  assert.equal((await x.tick()).phase, 'working'); // feedback sent
  // Старый ход seq=10 при мутанте засчитывается новым: та же SHA уже в seenShas —
  // карточка ошибочно уходит в blocked вместо ожидания нового хода.
  x.pushTurn({ seq: 10, replay: true });
  const res = await x.tick();
  assert.equal(res.phase, 'hold');
  assert.equal(res.reason, 'worker_turn_finished_without_new_handoff');
  assert.equal((await x.card()).state, 'blocked');
});

test('guard-mutant M5 NoBlindRoundClose: rework verdict auto-completes', async t => {
  const x = await lab(t);
  assert.equal((await x.tick()).phase, 'working');
  x.submit(x.candidate, 10);
  x.setUnsafePorts(journal => ({ __unsafeAutoCloseRework: true,
    review: async binding => {
      const name = 'review-transcript-m5.json';
      await writeFile(join(journal, name), 'synthetic m5 transcript', { mode: 0o600 });
      return { task: binding.task_id, sha: binding.candidate_sha,
        actual: REVIEW, verdict: 'REVIEW_BLOCKED', checkpoint: 'feed80ab',
        isolation: 'docker-ro-v1',
        transcript_sha256: createHash('sha256').update('synthetic m5 transcript').digest('hex'),
        transcript_file: name,
        subject_digest: binding.subject_digest,
        findings: [{ file: 'a.js', expected: 'spec behaviour', actual: 'other' }] };
    } }));
  const res = await x.tick();
  assert.equal(res.phase, 'done', 'мутант закрыл карточку на красном вердикте');
  assert.equal((await x.card()).state, 'completed');
});

// Парный формальный контур: базовая модель зелёная, все 5 мутантов красные
// с точным именем инварианта — проверяется самим specs/tla/check.mjs.
test('specs/tla/check.mjs: green base and 5/5 mutants by exact invariant name', async () => {
  const { stdout } = await exec(process.execPath,
    [join(new URL('..', import.meta.url).pathname, 'specs', 'tla', 'check.mjs')],
    { timeout: 60_000 });
  assert.match(stdout, /5\/5 mutants caught/);
});

function ownerAnswers(x) {
  const owner = generateKeyPairSync('ed25519');
  const foreign = generateKeyPairSync('ed25519');
  const principal = x.cfg.route.allowlist.owner;
  const stateFile = join(x.stateDir, 'attempt.json');
  const load = () => {
    try { return JSON.parse(readFileSync(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  };
  x.cfg.state = { load, save: record => saveState(stateFile, record) };
  let now = Date.now();
  let response = null;
  x.cfg.questionGate = { principal, ttlMs: 10_000, now: () => now,
    capture: async () => x.candidate,
    canResume: async ({ stage, question }) => (await x.card()).state === stage && question.checkpoint.sha === x.candidate,
    read: async () => response,
    verify: signedAnswerVerifier({ principal, publicKey: owner.publicKey.export({ type: 'spki', format: 'pem' }) }),
  };
  return { load, expire: () => { now += 10_001; },
    submit(question, decision, answer, foreignActor = false) {
      const reply = { decision, answer };
      response = { ...reply, signature: sign(null, answerBytes(question, reply),
        (foreignActor ? foreign : owner).privateKey).toString('base64url') };
    },
  };
}

const productTurn = { seq: 10, question: { prompt: 'CSV or JSON?', evidence: 'Both formats satisfy the current spec.' } };

test('VS-2 owner question: native hold, verified signature, restarts/lost acks, same worker under next epoch', async t => {
  const x = await lab(t, { questions: true });
  const owner = ownerAnswers(x);
  const started = await x.tick();
  const nativeBlock = x.port.block;
  x.port.block = async (...args) => { await nativeBlock(...args); throw new Error('lost native block ack'); };
  x.pushTurn(productTurn);
  const waiting = await x.tick();
  assert.equal(waiting.phase, 'awaiting_answer');
  assert.equal((await x.card()).state, 'blocked');
  const old = owner.load();
  const question = JSON.parse((await x.card()).blocked.reason);
  assert.equal(waiting.question_id, question.question_id);
  assert.equal((await x.tick()).question_id, waiting.question_id);
  owner.submit(question, 'resolve', 'Use CSV.', true);
  assert.equal((await x.tick()).phase, 'awaiting_answer');
  owner.submit({ ...question, attempt_id: 'unrelated' }, 'resolve', 'Use CSV.');
  assert.equal((await x.tick()).phase, 'awaiting_answer');
  assert.equal(x.effects.blockCalls, 1);

  const nativeUnblock = x.port.unblockQuestion;
  let unblocks = 0;
  x.port.unblockQuestion = async (...args) => {
    unblocks++;
    await nativeUnblock(...args);
    throw new Error('lost native unblock ack');
  };
  const store = x.cfg.state.save;
  x.cfg.state.save = async record => {
    if (record.phase === 'resume_pending') throw new Error('power lost before WAL receipt');
    await store(record);
  };
  owner.submit(question, 'resolve', 'Use CSV.');
  await assert.rejects(x.tick(), /power lost/);
  assert.equal(owner.load().phase, 'unblocking');
  assert.equal((await x.card()).state, 'ready');
  assert.equal(unblocks, 1);
  x.cfg.state.save = store;
  x.cfg.board = nativeBoardPort(x.handle, { channel: 'pilot', isolatedQuestionOwner: true });
  x.cfg.board.unblockQuestion = x.port.unblockQuestion;
  assert.equal((await x.tick()).phase, 'resume_pending');
  const claim = x.cfg.board.claimForQuestion;
  let claims = 0;
  x.cfg.board.claimForQuestion = async (...args) => {
    claims++;
    await claim(...args);
    throw new Error('lost next claim ack');
  };
  let delivered;
  const send = x.bb.feedback.bind(x.bb);
  x.bb.feedback = packet => { delivered = packet; return send(packet); };
  const resumed = await x.tick();
  assert.equal(resumed.phase, 'working');
  assert.equal(resumed.epoch, started.epoch + 1);
  assert.notEqual(resumed.attemptId, old.attemptId);
  assert.equal(resumed.threadId, started.threadId);
  assert.equal(delivered.attempt.epoch, resumed.epoch);
  assert.equal(delivered.attempt.attempt_id, resumed.attemptId);
  assert.equal(delivered.evidence.ownerAnswer, 'Use CSV.');
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(x.effects.spawnCalls, 1);
  assert.equal(x.effects.feedbackCalls, 1);
  assert.equal(claims, 1);
  assert.equal(unblocks, 1);
});

test('VS-2 release approval resumes at release_ready without starting or waking a coder', async t => {
  const x = await lab(t, { questions: true, finish: 'deployed' });
  const owner = ownerAnswers(x);
  const started = await x.tick();
  x.submit(x.candidate, 10);
  assert.equal((await x.tick()).phase, 'awaiting_answer');
  const question = JSON.parse((await x.card()).blocked.reason);
  assert.equal(question.kind, 'release');
  assert.equal(question.checkpoint.sha, x.candidate);
  assert.match(question.checkpoint.subject_digest, /^[a-f0-9]{64}$/);
  owner.submit(question, 'approve', '');
  assert.equal((await x.tick()).phase, 'resume_pending');
  const resumed = await x.tick();
  assert.equal(resumed.phase, 'release_ready');
  assert.equal(resumed.epoch, started.epoch + 1);
  assert.equal((await x.tick()).phase, 'release_ready');
  assert.equal(x.effects.spawnCalls, 1);
  assert.equal(x.effects.feedbackCalls, 0);
  assert.equal(x.effects.verifyCalls, 1);
  assert.equal(x.effects.completeCalls, 0);
  assert.equal((await x.card()).state, 'claimed');
  assert.equal(owner.load().releaseVerification.evidence.sha, x.candidate);
});

test('VS-2 replacement hold, expiry and ambiguous unblock never unlock another question', async t => {
  for (const scenario of ['replaced', 'expired', 'unknown']) {
    const x = await lab(t, { questions: true });
    const owner = ownerAnswers(x);
    await x.tick();
    x.pushTurn(productTurn);
    assert.equal((await x.tick()).phase, 'awaiting_answer');
    const question = owner.load().question;
    owner.submit(question, 'resolve', 'Use CSV.');
    let writes = 0;
    const unblock = x.port.unblockQuestion;
    x.port.unblockQuestion = (...args) => {
      writes++;
      if (scenario === 'unknown') throw new Error('no observable effect');
      return unblock(...args);
    };
    if (scenario === 'expired') owner.expire();
    if (scenario === 'replaced') {
      await x.handle.tasks.unblock(question.task_id);
      await x.handle.tasks.block(question.task_id, 'different question');
    }
    const stopped = await x.tick();
    assert.equal(stopped.phase, scenario === 'expired' ? 'hold' : 'uncertain');
    assert.equal((await x.tick()).phase, stopped.phase);
    assert.equal((await x.card()).state, 'blocked');
    assert.equal(writes, scenario === 'unknown' ? 1 : 0);
    assert.equal(x.effects.spawnCalls, 1);
    assert.equal(x.effects.feedbackCalls, 0);
  }
});

test('VS-2 pilot projects claimed, L1/L3/L2, a real REWORK/PASS and completion on the card', async t => {
  const x = await lab(t, { pilot: true, hasUi: true });
  x.setUnsafePorts(journal => ({
    visual: async binding => ({ ok: true, status: 'pass', sha: binding.candidate_sha,
      artifacts: [{ name: 'page.png', sha256: 'd'.repeat(64), bytes: 5 }],
      evidence: { file: 'visual.log', sha256: 'e'.repeat(64), exit: 0 } }),
    review: async binding => {
      const transcript = 'synthetic transcript';
      const name = 'pilot-review.json';
      await writeFile(join(journal, name), transcript, { mode: 0o600 });
      const rework = binding.candidate_sha === x.candidate;
      return { task: binding.task_id, sha: binding.candidate_sha, actual: REVIEW,
        verdict: rework ? 'REVIEW_BLOCKED' : 'REVIEW_OK', checkpoint: 'feed80ab',
        isolation: 'docker-ro-v1', transcript_file: name, subject_digest: binding.subject_digest,
        transcript_sha256: createHash('sha256').update(transcript).digest('hex'),
        ...(rework ? { findings: [{ file: 'check.mjs', expected: 'correct', actual: 'SYNTHETIC_STDERR_NEVER_PUBLIC' }] } : {}) };
    },
  }));
  const started = await x.tick();
  assert.equal(started.phase, 'working');
  x.submit(x.candidate, 10);
  assert.equal((await x.tick()).phase, 'working');
  assert.equal(x.effects.feedbackCalls, 1);
  await writeFile(join(x.tree, 'check.mjs'), 'console.log("second candidate"); process.exit(0);\n');
  git(x.tree, 'add', 'check.mjs');
  commit(x.tree, 'Fix synthetic rework');
  const fixed = git(x.tree, 'rev-parse', 'HEAD');
  x.submit(fixed, 20);
  assert.equal((await x.tick()).phase, 'done');
  assert.equal((await x.card()).state, 'completed');
  assert.deepEqual(x.projections.map(labels => labels['factory.phase']),
    ['claimed', 'L1', 'L3', 'L2', 'L2_REWORK', 'L1', 'L3', 'L2', 'L2_PASS', 'completed']);
  assert.equal(x.projections[4]['factory.next'], 'revise_candidate');
  assert.equal(x.projections[4]['factory.sha'], x.candidate);
  assert.equal(x.projections.at(-1)['factory.sha'], fixed);
  assert.equal(x.projections.at(-1)['factory.epoch'], String(started.epoch));
  assert.equal(x.projections.some(labels => JSON.stringify(labels).includes('SYNTHETIC_STDERR_NEVER_PUBLIC')), false);
  await x.tick();
  assert.equal(x.projections.length, 10, 'replayed terminal tick is a label no-op');
});

test('VS-2 pilot projects native blocked without making private diagnostics public', async t => {
  const x = await lab(t, { pilot: true });
  x.setUnsafePorts({ review: async () => { throw new Error('SYNTHETIC_STDERR_NEVER_PUBLIC'); } });
  await x.tick();
  x.submit(x.candidate, 10);
  assert.equal((await x.tick()).phase, 'hold');
  const task = await x.card();
  assert.equal(task.state, 'blocked');
  assert.equal(task.blocked.reason.includes('SYNTHETIC_STDERR_NEVER_PUBLIC'), false);
  assert.equal(x.projections.at(-1)['factory.phase'], 'blocked');
  assert.equal(x.projections.at(-1)['factory.next'], 'operator_review');
  assert.equal(x.projections.some(labels => JSON.stringify(labels).includes('SYNTHETIC_STDERR_NEVER_PUBLIC')), false);
});

test('VS-2 pilot has no native claims on foreign tuple, idle switch or switch closure after read', async t => {
  for (const tuple of [{ owner: 'local:user:foreign' }, { repoId: 'wrong-repo' }, { profileId: 'wrong-profile' }]) {
    const x = await lab(t, { pilot: true, pilotScope: tuple });
    assert.equal((await x.tick()).phase, 'idle');
    assert.equal((await x.card()).epoch, 0);
    assert.equal(x.effects.nativeClaims, 0);
    assert.equal(x.effects.spawnCalls + x.effects.reviewCalls, 0);
  }
  const x = await lab(t, { pilot: true });
  await x.setSwitch('stop\n');
  await assert.rejects(x.tick(), { code: 'pilot_stopped' });
  assert.equal(x.effects.nativeClaims, 0);
  await x.setSwitch('run\n');
  x.afterRead(async root => {
    if (root?.id === x.taskId && root.task?.state === 'ready') await x.setSwitch('stop\n');
  });
  const stopped = await x.tick();
  assert.equal(stopped.phase, 'uncertain');
  assert.equal((await x.card()).state, 'ready');
  assert.equal(x.effects.nativeClaims, 0);
  assert.equal(x.effects.spawnCalls + x.effects.reviewCalls, 0);
  assert.deepEqual(x.projections, []);
});

test('VS-2 pilot kill switch rejects writes and renewal after a verification cut', async t => {
  const x = await lab(t, { pilot: true });
  const { epoch } = await x.tick();
  const complete = x.port.complete;
  x.port.complete = async (...args) => {
    await x.setSwitch('stop\n');
    return complete(...args);
  };
  x.submit(x.candidate, 10);
  assert.equal((await x.tick()).phase, 'uncertain');
  assert.equal((await x.card()).state, 'claimed');
  assert.equal((await x.card()).result, null);
  assert.equal(x.projections.at(-1)['factory.phase'], 'L2_PASS');
  await assert.rejects(x.port.verifyHeld(x.taskId, epoch), { code: 'pilot_stopped' });
  await assert.rejects(x.port.project(x.taskId, epoch, 'L2_REWORK', x.candidate), { code: 'pilot_stopped' });
  assert.equal(x.effects.spawnCalls, 1);
  await assert.rejects(x.tick(), { code: 'pilot_stopped' });
  assert.equal(x.effects.feedbackCalls, 0);
});

test('VS-2 pilot refuses review when enrolled repo label changes after native claim', async t => {
  const x = await lab(t, { pilot: true });
  await x.tick();
  await x.handle.label(x.taskId, { set: { repo_id: 'foreign-after-claim' } });
  x.submit(x.candidate, 10);
  assert.equal((await x.tick()).phase, 'lease_lost');
  assert.equal(x.effects.localCalls + x.effects.reviewCalls + x.effects.feedbackCalls, 0);
  assert.deepEqual(x.projections.map(labels => labels['factory.phase']), ['claimed']);
  assert.equal((await x.card()).state, 'claimed');
});

test('VS-2 pilot leaves other channels, deployed and waiting tasks untouched', async t => {
  const x = await lab(t, { pilot: true });
  await x.handle.createChannel('manual-bb');
  const { task: foreignChannel } = await x.handle.tasks.create('manual-bb', { text: 'synthetic foreign channel', labels: LABELS });
  const { task: deployed } = await x.handle.tasks.create(x.channel, { text: 'synthetic deployment', labels: { ...LABELS, finish: 'deployed' } });
  const { task: blocker } = await x.handle.tasks.create(x.channel, { text: 'synthetic unenrolled dependency' });
  await x.handle.tasks.needs(x.taskId, [blocker.id]);
  assert.equal((await x.tick()).phase, 'idle');
  assert.equal(x.effects.nativeClaims + x.effects.spawnCalls + x.effects.verifyCalls, 0);
  assert.equal((await x.card()).state, 'waiting');
  for (const task of [foreignChannel, deployed, blocker]) {
    const native = (await x.handle.thread(task.id)).message.task;
    assert.equal(native.state, 'ready');
    assert.equal(native.epoch, 0);
  }
  assert.deepEqual(x.projections, []);
});

test('VS-2 pilot stops a queued BB spawn and a model start at their effect boundaries', async t => {
  const spawn = await lab(t, { pilot: true });
  const publish = spawn.port.project;
  spawn.port.project = async (...args) => {
    await publish(...args);
    if (args[2] === 'claimed') await spawn.setSwitch('stop\n');
  };
  assert.equal((await spawn.tick()).phase, 'lease_lost');
  assert.equal(spawn.effects.nativeClaims, 1);
  assert.equal((await spawn.card()).state, 'claimed');
  assert.equal(spawn.effects.spawnCalls, 0);

  const model = await lab(t, { pilot: true });
  await model.tick();
  model.afterRead(async root => {
    if (root?.id === model.taskId && root.labels['factory.phase'] === 'L2') await model.setSwitch('stop\n');
  });
  model.submit(model.candidate, 10);
  assert.equal((await model.tick()).phase, 'uncertain');
  assert.equal(model.effects.localCalls, 1);
  assert.equal(model.effects.reviewCalls + model.effects.feedbackCalls, 0);
  assert.equal((await model.card()).state, 'claimed');
  assert.equal((await model.card()).result, null);
});

test('VS-2 pilot native label compare-and-set cannot overwrite a fresher projection', async t => {
  const x = await lab(t, { pilot: true });
  const { epoch } = await x.tick();
  let introduced = false;
  x.afterRead(async root => {
    if (!introduced && root?.id === x.taskId) {
      introduced = true;
      await x.handle.label(x.taskId, { set: { 'factory.epoch': String(epoch + 1) } });
    }
  });
  await assert.rejects(x.port.project(x.taskId, epoch, 'L2', x.candidate), { code: 'label_conflict' });
  const { message } = await x.handle.thread(x.taskId);
  assert.equal(message.labels['factory.epoch'], String(epoch + 1));
  assert.equal(message.labels['factory.phase'], 'claimed');
  assert.equal(message.task.epoch, epoch);
});

test('VS-2 pilot leaves native settlement authoritative if final phase publication fails', async t => {
  const x = await lab(t, { pilot: true });
  const publish = x.port.project;
  x.port.project = (...args) => {
    if (args[2] === 'completed') throw new Error('synthetic display failure');
    return publish(...args);
  };
  await x.tick();
  x.submit(x.candidate, 10);
  await assert.rejects(x.tick(), /synthetic display failure/);
  assert.equal(x.stored().phase, 'done');
  assert.equal((await x.card()).state, 'completed');
  x.port.project = publish;
  assert.equal((await x.tick()).phase, 'done');
  assert.equal(x.effects.completeCalls, 1);
  assert.equal(x.projections.at(-1)['factory.phase'], 'completed');
});

test('VS-2 pilot drops model prose from the native completion receipt', async t => {
  const x = await lab(t, { pilot: true });
  const { epoch } = await x.tick();
  await x.port.complete(x.taskId, epoch, { sha: x.candidate,
    arbitration: { decision: 'accept_with_notes', notes: 'SYNTHETIC_STDERR_NEVER_PUBLIC' } });
  assert.deepEqual((await x.port.lookup(x.taskId)).result,
    { sha: x.candidate, arbitration: { decision: 'accept_with_notes' } });
});

const LIVE_TARGET = 'isolated-t4';
const INITIAL_TEXT = 'READY\nprevious isolated artifact\n';
async function releaseLab(t, text = 'READY\nnew isolated artifact\n') {
  const x = await lab(t, { questions: true, finish: 'deployed' });
  await writeFile(join(x.tree, 'release.txt'), text, { mode: 0o644 });
  git(x.tree, 'add', 'release.txt');
  commit(x.tree, 'Add isolated release artifact');
  x.candidate = git(x.tree, 'rev-parse', 'HEAD');
  const directory = join(x.root, 'release-target');
  await mkdir(directory, { mode: 0o700 });
  await enrollLocalTarget(directory, { target: LIVE_TARGET, repo: REPO, initialSha: x.base,
    initialBytes: Buffer.from(INITIAL_TEXT) });
  const site = await serveLocalTarget({ root: directory, target: LIVE_TARGET, repo: REPO });
  t.after(() => site.close());
  const openPort = () => localReleasePort({ root: directory, target: LIVE_TARGET, repo: REPO, url: site.url,
    worktree: x.tree, artifact: 'release.txt', smokePrefix: 'READY\n' });
  const release = await openPort();
  let promotions = 0;
  let rollbacks = 0;
  const measured = port => ({ ...port,
    async promote(...args) { promotions++; return port.promote(...args); },
    async rollback(...args) { rollbacks++; return port.rollback(...args); },
  });
  x.cfg.release = measured(release);
  const owner = ownerAnswers(x);
  const started = await x.tick();
  assert.equal(started.phase, 'working');
  x.submit(x.candidate, 10);
  const waiting = await x.tick();
  assert.equal(waiting.phase, 'awaiting_answer', waiting.reason);
  const question = JSON.parse((await x.card()).blocked.reason);
  return { x, owner, question, started, release, site, directory, text,
    counts: () => ({ promotions, rollbacks }), reopen: async () => { x.cfg.release = measured(await openPort()); },
    async approve() {
      owner.submit(question, 'approve', '');
      assert.equal((await x.tick()).phase, 'resume_pending');
      const resumed = await x.tick();
      assert.equal(resumed.phase, 'release_ready');
      assert.equal(resumed.epoch, started.epoch + 1);
    },
  };
}

async function readPublicArtifact(site) {
  const response = await fetch(`${site.url}/artifact`, { redirect: 'error' });
  assert.equal(response.status, 200);
  return response.text();
}

test('VS-2 release: exact signed package and native deployed receipt with VS-3 telemetry enabled', async t => {
  const f = await releaseLab(t);
  const { x, owner, question } = f;
  const rec = createTelemetryRecorder({ journal: x.stateDir });
  const complete = x.port.complete;
  x.port.complete = (id, epoch, evidence) => complete(id, epoch, rec.embed(evidence));
  rec.roundStart();
  rec.recordRound({ outcome: 'verified' });
  assert.equal(question.checkpoint.release.target, LIVE_TARGET);
  assert.equal(question.checkpoint.release.digest, digestBytes(Buffer.from(f.text)));
  assert.equal(question.checkpoint.release.previous.digest, digestBytes(Buffer.from(INITIAL_TEXT)));
  assert.match(question.consequence, /restore/);
  const expectedSubject = subjectDigest(buildSubject({ kind: 'git_tree', repoId: REPO,
    baseSha: x.base, candidateSha: x.candidate, treeSha: git(x.tree, 'rev-parse', 'HEAD^{tree}'),
    specDigest: SPEC, policyDigest: POLICY_DIGEST, releaseTarget: { finish: 'deployed', targetId: LIVE_TARGET,
      releaseChannel: 'isolated-static', previousLiveDigest: question.checkpoint.release.previous.digest } }));
  assert.equal(question.checkpoint.subject_digest, expectedSubject);
  assert.equal((await x.tick()).phase, 'awaiting_answer');
  owner.submit(question, 'approve', '', true);
  assert.equal((await x.tick()).phase, 'awaiting_answer');
  assert.deepEqual(f.counts(), { promotions: 0, rollbacks: 0 });
  assert.equal(await readPublicArtifact(f.site), INITIAL_TEXT);
  assert.deepEqual((await readdir(f.directory)).filter(name => name.startsWith('promotion-')), []);
  await f.approve();
  assert.equal((await x.tick()).phase, 'release_smoke');
  assert.equal(await readPublicArtifact(f.site), f.text);
  assert.equal((await x.tick()).phase, 'done');
  const { result } = await x.port.lookup(x.taskId);
  assert.equal(result.schema, 'darkfactory.release-receipt.v1');
  assert.equal(result.task_id, x.taskId);
  assert.equal(result.epoch, f.started.epoch + 1);
  assert.equal(result.attempt_id, owner.load().attemptId);
  assert.equal(result.finish, 'deployed');
  assert.equal(result.sha, x.candidate);
  assert.equal(result.subject_digest, expectedSubject);
  assert.equal(result.readback, result.digest);
  assert.equal(result.smoke, 'pass');
  assert.equal(result.telemetry, undefined, 'release settlement hashes the exact typed receipt');
  await rec.finish({ outcome: 'done' });
  assert.match(await readFile(join(x.stateDir, 'telemetry.jsonl'), 'utf8'), /attempt_summary/);
  assert.equal(owner.load().releaseApproval.harm, 10);
  assert.equal((await x.tick()).phase, 'done');
  assert.deepEqual(f.counts(), { promotions: 1, rollbacks: 0 });
  assert.equal(x.effects.spawnCalls, 1);
  assert.equal(x.effects.feedbackCalls, 0);
  assert.equal(x.effects.completeCalls, 1);
});

async function watchLoopback(t, listener) {
  const server = createServer(listener);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function watchFixture(t, site) {
  const calls = [];
  let mode = 'healthy';
  const url = await watchLoopback(t, async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.method !== 'GET' || !['/version', '/artifact'].includes(req.url)) {
      res.writeHead(405).end();
      return;
    }
    if (req.url === '/artifact' && mode === 'down') {
      res.writeHead(503).end('unverified response');
      return;
    }
    try {
      const reply = await fetch(site.url + req.url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      const headers = Object.fromEntries(reply.headers);
      const bytes = Buffer.from(await reply.arrayBuffer());
      if (req.url === '/artifact' && mode !== 'healthy') headers['content-type'] = 'application/octet-stream';
      if (req.url === '/artifact' && mode === 'wrong-bytes') bytes[0] ^= 1;
      res.writeHead(reply.status, headers).end(bytes);
    } catch {
      res.writeHead(502).end();
    }
  });
  return { url, calls, setMode(value) { mode = value; } };
}

async function watchBoardWire(t, boardUrl) {
  const upstream = new URL(boardUrl);
  const calls = [];
  let dropPostAck = false;
  const url = await watchLoopback(t, (req, res) => {
    calls.push({ method: req.method, path: req.url, can: req.headers['x-board-can'] });
    const forward = httpRequest(new URL(req.url, upstream), { method: req.method,
      headers: { ...req.headers, host: upstream.host }, signal: AbortSignal.timeout(5000) }, reply => {
      if (dropPostAck && req.method === 'POST' && req.url === '/api/board/messages' &&
          reply.statusCode >= 200 && reply.statusCode < 300) {
        dropPostAck = false;
        reply.resume();
        reply.once('end', () => res.destroy());
      } else {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      }
    });
    forward.once('error', () => res.destroy());
    req.pipe(forward);
  });
  return { url: url + upstream.pathname, calls, losePostAck() { dropPostAck = true; } };
}

test('P2.2: verified post-release smoke updates only one native Board incident', { timeout: 30_000 }, async t => {
  const f = await releaseLab(t);
  const { x } = f;
  const source = await watchFixture(t, f.site);
  const boardWire = await watchBoardWire(t, x.url);
  const { instance } = await (await fetch(`${f.site.url}/version`)).json();
  await x.handle.createChannel('intake');
  const { message: root } = await x.handle.thread(x.taskId);
  const policy = { url: source.url, boardUrl: boardWire.url, releaseTask: x.taskId, owner: root.task.owner,
    target: LIVE_TARGET, repo: REPO, instance };
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const name = createHash('sha256').update(x.url).digest('hex').slice(0, 32);
  const { token } = JSON.parse(await readFile(join(config, 'board', 'local', `${name}.json`), 'utf8'));
  const file = join(x.root, 'watch.json');
  await writeFile(file, JSON.stringify(policy), { mode: 0o600 });
  const cli = fileURLToPath(new URL('./run-release-watch.mjs', import.meta.url));
  const tick = async () => {
    const { stdout } = await exec(process.execPath, [cli, '--policy', file],
      { env: { DF_WATCH_BOARD_TOKEN: token, PATH: '' }, timeout: 8000 });
    return JSON.parse(stdout);
  };
  const incidents = async () => (await x.handle.threads({ channel: 'intake' })).threads.map(item => item.message);

  await assert.rejects(tick(), /watch_release_unconfirmed/);
  assert.deepEqual(source.calls, []);
  assert.deepEqual(await incidents(), []);
  await f.approve();
  assert.equal((await x.tick()).phase, 'release_smoke');
  assert.equal((await x.tick()).phase, 'done');
  const effects = { ...x.effects };
  boardWire.calls.length = 0;
  assert.deepEqual(await tick(), { status: 'healthy', sha: x.candidate });
  assert.deepEqual(source.calls, ['GET /version', 'GET /artifact']);
  assert.deepEqual(boardWire.calls, [{ method: 'GET', path: `/api/board/messages/${x.taskId}?limit=1`,
    can: 'pilot=read;intake=read,post' }]);
  assert.deepEqual(await incidents(), []);

  source.setMode('down');
  await assert.rejects(tick(), /release_target_readback_failed/);
  assert.deepEqual(await incidents(), []);
  source.setMode('wrong-bytes');
  await assert.rejects(tick(), /release_smoke_version_changed/);
  assert.deepEqual(await incidents(), []);

  source.setMode('red');
  boardWire.losePostAck();
  await assert.rejects(tick(), /watch_board_unavailable/);
  const [created] = await incidents();
  assert.ok(created, 'Board committed the root before the acknowledgement was lost');
  assert.match(created.text, new RegExp(x.candidate));
  assert.ok(created.text.includes(`/messages/${x.taskId}`));
  assert.ok(created.text.includes(`GET ${source.url}/artifact`));
  assert.ok(!created.text.includes(f.text.trim()));
  assert.equal(created.task ?? null, null);
  assert.deepEqual(created.labels, {});
  assert.equal(created.noSync, true);
  const b = await tick();
  assert.equal(b.status, 'updated');
  assert.equal(b.id, created.id);
  assert.ok(created.text.includes(b.fingerprint));
  const [updated] = await incidents();
  assert.ok(updated.revision > created.revision);
  assert.equal((await incidents()).length, 1);

  source.setMode('down');
  await assert.rejects(tick(), /release_target_readback_failed/);
  assert.equal((await incidents())[0].revision, updated.revision);
  const leadEdit = 'Лид уточняет воспроизведение.';
  await x.handle.edit(created.id, leadEdit);
  source.setMode('red');
  await assert.rejects(tick(), /watch_incident_conflict/);
  assert.equal((await incidents())[0].text, leadEdit);
  assert.equal((await incidents()).length, 1);
  assert.deepEqual(boardWire.calls.filter(call => call.method !== 'GET').map(call => call.path),
    ['/api/board/messages', `/api/board/messages/${created.id}/edit`]);
  assert.ok(boardWire.calls.every(call => call.can === 'pilot=read;intake=read,post'));
  assert.deepEqual(x.effects, effects);
  assert.deepEqual(f.counts(), { promotions: 1, rollbacks: 0 });
});

test('VS-2 release: red smoke restores actual previous artifact and never closes as deployed', async t => {
  const f = await releaseLab(t, 'BROKEN\nnew isolated artifact\n');
  const { x, owner } = f;
  await f.approve();
  assert.equal((await x.tick()).phase, 'release_smoke');
  assert.equal(await readPublicArtifact(f.site), f.text);
  const rollback = x.cfg.release.rollback;
  x.cfg.release.rollback = async (...args) => { await rollback(...args); throw new Error('lost rollback response'); };
  assert.equal((await x.tick()).reason, 'release_rolled_back');
  assert.equal(await readPublicArtifact(f.site), INITIAL_TEXT);
  assert.equal((await x.card()).state, 'blocked');
  assert.equal((await x.card()).result, null);
  assert.equal(owner.load().receipt.kind, 'rolled_back');
  await x.tick();
  assert.deepEqual(f.counts(), { promotions: 1, rollbacks: 1 });
  assert.equal(x.effects.completeCalls, 0);
  assert.equal(x.effects.spawnCalls, 1);
  // Even an accidental second port call cannot use the same effect key.
  await assert.rejects(f.release.promote(owner.load().releasePlan, async () => {}), { code: 'EEXIST' });
  assert.equal(await readPublicArtifact(f.site), INITIAL_TEXT);
});

test('VS-2 release reconciles a lost publication response and restart by exact operation, without rerunning', async t => {
  const f = await releaseLab(t);
  const { x, owner } = f;
  await f.approve();
  const store = x.cfg.state.save;
  x.cfg.state.save = async state => {
    if (state.phase === 'release_smoke') throw new Error('power lost after publication before receipt');
    return store(state);
  };
  const promote = x.cfg.release.promote;
  x.cfg.release.promote = async (...args) => { await promote(...args); throw new Error('lost publish response'); };
  await assert.rejects(x.tick(), /power lost/);
  assert.equal(owner.load().phase, 'release_promoting');
  assert.equal(await readPublicArtifact(f.site), f.text);
  x.cfg.state.save = store;
  await f.reopen();
  assert.equal((await x.tick()).phase, 'release_smoke');
  const nativeComplete = x.port.complete;
  x.port.complete = async (...args) => { await nativeComplete(...args); throw new Error('lost native complete response'); };
  assert.equal((await x.tick()).phase, 'done');
  assert.equal((await x.card()).state, 'completed');
  assert.equal((await x.tick()).phase, 'done');
  assert.deepEqual(f.counts(), { promotions: 1, rollbacks: 0 });
  assert.equal(x.effects.completeCalls, 1);
});

test('VS-2 release rejects expired consent, target drift and stale epoch without touching live bytes', async t => {
  for (const scenario of ['expired', 'late_expiry', 'missing_seal', 'target_drift', 'stale_epoch']) {
    const f = await releaseLab(t);
    const { x, owner } = f;
    await f.approve();
    let expected = INITIAL_TEXT;
    if (scenario === 'expired') owner.expire();
    if (scenario === 'missing_seal') await x.cfg.state.save({ ...owner.load(), releaseVerification: null });
    if (scenario === 'late_expiry') {
      const promote = x.cfg.release.promote;
      x.cfg.release.promote = (plan, authorize) => promote(plan, async () => {
        owner.expire();
        await authorize();
      });
    }
    if (scenario === 'target_drift') {
      expected = 'READY\nindependent fixture operator drift\n';
      await saveState(join(f.directory, 'live.json'), makeReleaseRecord(LIVE_TARGET, x.base, Buffer.from(expected)));
    }
    if (scenario === 'stale_epoch') {
      const held = owner.load();
      await x.handle.tasks.held(x.taskId, { epoch: held.epoch, token: held.token }).release();
      await x.handle.tasks.claim(x.taskId);
    }
    const out = await x.tick();
    assert.ok(['hold', 'uncertain'].includes(out.phase));
    assert.equal(await readPublicArtifact(f.site), expected);
    assert.equal((await x.card()).result, null);
    assert.equal(x.effects.completeCalls, 0);
    assert.equal(x.effects.spawnCalls, 1);
    assert.equal(x.effects.feedbackCalls, 0);
    assert.deepEqual((await readdir(f.directory)).filter(name => name.startsWith('promotion-')), []);
    const attempts = f.counts().promotions;
    await x.tick();
    assert.equal(f.counts().promotions, attempts);
    if (!['target_drift', 'late_expiry'].includes(scenario)) assert.equal(attempts, 0);
  }
});

test('VS-2 release quarantines an unconfirmed publication, with no second dispatch', async t => {
  const f = await releaseLab(t);
  await f.approve();
  const promote = f.x.cfg.release.promote;
  let unknownCalls = 0;
  f.x.cfg.release.promote = async () => { unknownCalls++; throw new Error('publication outcome unavailable'); };
  assert.equal((await f.x.tick()).reason, 'release_promotion_unconfirmed');
  f.x.cfg.release.promote = promote;
  assert.equal((await f.x.tick()).phase, 'uncertain');
  assert.equal(unknownCalls, 1);
  assert.deepEqual(f.counts(), { promotions: 0, rollbacks: 0 });
  assert.equal(await readPublicArtifact(f.site), INITIAL_TEXT);
  assert.equal(f.x.effects.completeCalls, 0);
});

test('VS-2 release never treats a missing HTTP smoke as a red proof or a deployed result', async t => {
  const f = await releaseLab(t);
  await f.approve();
  assert.equal((await f.x.tick()).phase, 'release_smoke');
  await f.site.close();
  assert.equal((await f.x.tick()).phase, 'uncertain');
  const retained = await readTargetRecord(join(f.directory, 'live.json'));
  assert.equal(retained.sha, f.x.candidate);
  assert.deepEqual(f.counts(), { promotions: 1, rollbacks: 0 });
  assert.equal((await f.x.card()).result, null);
  assert.equal(f.x.effects.completeCalls, 0);
});

test('VS-2 release never rolls back over an independently changed current version', async t => {
  const f = await releaseLab(t, 'BROKEN\nnew isolated artifact\n');
  await f.approve();
  assert.equal((await f.x.tick()).phase, 'release_smoke');
  const intruder = 'READY\nindependent fixture operator version\n';
  const rollback = f.x.cfg.release.rollback;
  f.x.cfg.release.rollback = async (...args) => {
    await saveState(join(f.directory, 'live.json'), makeReleaseRecord(LIVE_TARGET, f.x.base, Buffer.from(intruder)));
    await rollback(...args);
  };
  assert.equal((await f.x.tick()).reason, 'release_rollback_unconfirmed');
  assert.equal(await readPublicArtifact(f.site), intruder);
  assert.equal(f.x.effects.completeCalls, 0);
  assert.equal((await f.x.card()).result, null);
});
