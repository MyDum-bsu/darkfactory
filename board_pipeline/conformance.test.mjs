// Conformance / fault-injection VS-1.5: реальный controller.mjs + acceptHeld +
// native-board + slot.mjs поверх настоящего loopback `vb serve --port 0`
// (никогда :44100), реальной ФС и flock. Внешний порт BB и наблюдение ходов —
// детерминированные cut points со счётчиком эффектов на стороне порта, а не по
// журналу контроллера. Пять трасс повторяют пять TLA+ инвариантов; шестой блок
// проверяет, что снятие каждого гварда ломает соответствующий инвариант.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFile, execFileSync, spawn as spawnProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { acceptHeld } from './acceptance.mjs';
import { advance } from './controller.mjs';
import { nativeBoardPort } from './native-board.mjs';
import { reserveWorktree, saveState } from './slot.mjs';
import { answerBytes, signedAnswerVerifier } from './question-gate.mjs';
import { loadSdk } from './sdk.mjs';
import { worktreeInspector } from './runtime.mjs';
import { tamperGate } from './tamper-gate.mjs';
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

// Полный лабораторный стенд: живая Board, git worktree, слот-бронь, порты со
// счётчиками и хранилище записи попытки — всё как в run-isolated, но под тестом.
async function lab(t, { finish = 'verified', lease = 900, mutants, questions = false } = {}) {
  const { url, dir } = await startBoard(boardCli(), t);
  process.env.BOARD_URL = url;
  const { board } = loadSdk();
  const handle = board();
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { await handle.createChannel('pilot'); break; }
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

  const { task } = await handle.tasks.create('pilot', { text: 'Synthetic conformance',
    noSync: true, labels: { ...LABELS, finish } });
  const owner = (await handle.thread(task.id, { limit: 1 })).message.task.owner;
  const card = async () => (await handle.thread(task.id, { limit: 1 })).message.task;

  // Счётчики эффектов на стороне портов — внешний факт, не журнал контроллера.
  const effects = { spawnCalls: 0, feedbackCalls: 0, completeCalls: 0, blockCalls: 0,
    verifyCalls: 0, localCalls: 0, reviewCalls: 0, arbiterCalls: 0, delivered: [] };
  const port = nativeBoardPort(handle, { channel: 'pilot', lease, isolatedQuestionOwner: questions });
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
      effects.spawnCalls++;
      const threadId = bb.fixedThread ?? `thr_wire${effects.spawnCalls}`;
      bb.spawnRegistry.push(threadId);
      if (bb.spawnOutcome === 'lost_ack') throw new Error('lost transport response');
      return { threadId };
    },
    async feedback(packet) {
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
  const verify = async (attempt, submission) => {
    effects.verifyCalls++;
    const hit = scripted[submission.candidate_sha];
    if (hit) return typeof hit === 'function' ? hit(attempt, submission) : hit;
    const policy = policyFor(attempt);
    const journal = await mkdtemp(join(root, 'journal-'));
    return acceptHeld({ attempt, submission, policy, journal, ports: {
      board: port,
      inspect: worktreeInspector(policy),
      local: async binding => { effects.localCalls++;
        return { sha: binding.candidate_sha, ok: true,
          evidence: [{ file: 'checks-vs1.log', sha256: 'f'.repeat(64), exit: 0 }] }; },
      tamper: tamperGate,
      review: async binding => { effects.reviewCalls++;
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
    route: { allowlist: { owner, label: { key: 'queue', value: 'vs1' } }, base,
      policyVersion: 'vs1-5', checkProfile: 'pilot', worktree: tree, finish },
    authorize: async () => true,
    state, board: port, bb, submissions, verify,
    ...(mutants ? { mutants } : {}),
  };
  const releaseSlot = await reserveWorktree(registry, tree, stateDir);
  t.after(() => releaseSlot());
  return {
    handle, port, bb, effects, cfg, card, tree, root, registry, stateDir, dir,
    taskId: task.id, base, candidate, stored: () => stored,
    submit: (sha, seq, extra = {}) => { turns.push({ seq, sha, ...extra }); },
    pushTurn: entry => { turns.push(entry); },
    setScript: map => { scripted = map; },
    setUnsafePorts: p => { unsafePorts = p; },
    releaseSlot,
    tick: () => advance(cfg),
    workerSelector: over => { cfg.workerSelector = { ...ws, critic: REVIEW,
      // This conformance fixture intentionally uses the legacy Pi/Sol critic.
      arbiter: { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'high' },
      arbitrate: async req => { effects.arbiterCalls++;
        return { decision: 'escalate_owner', question: 'owner?', subject_digest: 'd'.repeat(64) }; },
      ...over }; },
  };
}

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
