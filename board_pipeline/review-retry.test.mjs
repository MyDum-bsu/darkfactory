import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  assertRetrySubjectUnchanged, classifySandboxExit, isolatedPiReviewRunner,
  l2CriticRunners, l2CriticSpec, l2FreshLeaseCheck, l2LaunchBoundary,
  l2ReviewRetryGuard, l2ReviewWithTransientRetry,
  reviewRunnerExitFailure, ReviewDenied, ReviewRunnerTimeout,
  runInReadOnlySandbox,
} from './review-runner.mjs';
import { nativeBoardPort } from './native-board.mjs';
import { isNeonReview, isSolArbiter } from './review-policy.mjs';
import { operatorReviewSetup } from './review-setup.mjs';

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
// Адаптерные тесты запускают подставной `docker` из tmpdir — в средах с
// noexec-tmp (проверочный контейнер) исполняемый стаб невозможен, пропуск.
const canExecStub = await (async () => {
  try {
    const dir = await mkdtemp(join(tmpdir(), 'retry-exec-'));
    try {
      const stub = join(dir, 'stub');
      await writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await exec(stub, [], { timeout: 10_000 });
      await exec('sh', ['-c', 'command -v sleep grep cat'], { timeout: 10_000 });
      return true;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
})();
const shTest = canExecStub ? test
  : (name, fn) => test(name, { skip: 'no executable stub env' }, fn);
// Сквозные docker-stub сценарии требуют и git (fixture-репо), и исполняемый
// стаб — обе проверки доступности обязаны учитываться, иначе в среде с
// noexec-tmp тест упадёт по ограничению фикстуры, а не по сути.
const dockerTest = hasGit && canExecStub ? test
  : (name, fn) => test(name, { skip: 'needs git + executable stub' }, fn);

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
      // 137 остаётся SIGKILL-нетранзиентом даже при timedOut-флаге:
      // числовой выход доминирует над host-доказательством.
      { code: 137, timedOut: true },
      { code: null }, { code: null, stderr: 'killed 143' },
      { code: null, timedOut: false }, { code: '143' }]) {
    const e = reviewRunnerExitFailure(run);
    assert.ok(e instanceof ReviewDenied, JSON.stringify(run));
    assert.ok(!(e instanceof ReviewRunnerTimeout), JSON.stringify(run));
  }
});

test('classification: host exec evidence — killed + SIGTERM или числовой выход', () => {
  // Реальная классификация хостового сбоя execFile в адаптере: timeout хоста
  // шлёт kill-сигнал (killed=true); child может погибнуть SIGTERM'ом либо
  // обработать его и выйти числом — оба случая доказанный таймаут.
  assert.deepEqual(classifySandboxExit({ killed: true, signal: 'SIGTERM' }),
    { code: null, timedOut: true });
  assert.deepEqual(classifySandboxExit({ killed: true, signal: 'SIGTERM', code: null }),
    { code: null, timedOut: true });
  // Deadline сработал, но дочерний процесс обработал SIGTERM и вышел числом:
  // killed + signal null при любом коде — тоже доказанный host-timeout.
  assert.deepEqual(classifySandboxExit({ killed: true, signal: null, code: 1 }),
    { code: 1, timedOut: true });
  for (const error of [
      { code: 143 }, { code: 1 }, { code: 'ENOENT' }, { code: 'EACCES' },
      { killed: true, signal: 'SIGKILL' }, { killed: true, signal: 'SIGINT' },
      { killed: false, signal: 'SIGTERM' }, { signal: 'SIGTERM' }, {}]) {
    const { timedOut } = classifySandboxExit(error);
    assert.equal(timedOut, false, JSON.stringify(error));
  }
  // Числовой код пробрасывается как есть, вне зависимости от killed.
  assert.deepEqual(classifySandboxExit({ code: 143, killed: false }),
    { code: 143, timedOut: false });
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

// Продукционный гейт l2ReviewRetryGuard: свежий verifyHeld (не кэш флага),
// допуск карточки (owner/label), живые контрактные метки, guardTask,
// daemon/pilot kill-switch, закреплённые входы и beforeEffect.
const CONTRACT = { repo_id: 'df-ops-1', spec_digest: 's'.repeat(64),
  policy_digest: 'p'.repeat(64), profile_id: 'code', finish: 'verified',
  fixtures_digest: null, has_ui: undefined };
function guardFixture(over = {}) {
  const seen = [];
  const port = {
    verifyHeld: async (taskId, epoch) => { seen.push('verifyHeld'); return { epoch }; },
    matches: async () => { seen.push('matches'); return true; },
    labels: async () => { seen.push('labels'); return { ...CONTRACT }; },
    guardTask: async () => { seen.push('guardTask'); },
    ...over.port,
  };
  const args = { port, taskId: '1', epoch: 1, owner: 'local:user:t',
    label: { key: 'queue', value: 'x' }, contract: CONTRACT,
    assertPinned: async () => { seen.push('assertPinned'); },
    beforeEffect: async () => { seen.push('beforeEffect'); },
    daemonOpen: async () => { seen.push('daemonOpen'); },
    ...over };
  return { guard: l2ReviewRetryGuard(args), seen };
}

test('guard: production retry guard — subject сначала, живые гейты перед dispatch', async () => {
  const { review, calls } = scriptedReview([
    timeout('review_runner_exit:143'), { verdict: 'REVIEW_OK' }]);
  const { guard, seen } = guardFixture();
  const receipt = await l2ReviewWithTransientRetry({ review, binding: BINDING,
    profile: { review: CRITIC }, beforeRetry: guard,
    verifySubject: async () => { seen.push('subject'); } });
  assert.equal(calls(), 2);
  assert.equal(receipt.verdict, 'REVIEW_OK');
  // Порядок: subject → lease → допуск → контракт → guardTask → daemon switch
  // → пины/switch → beforeEffect → повторный subject непосредственно перед
  // dispatch — дрейф worktree во время живых гейтов не пропускает запуск.
  assert.deepEqual(seen, ['subject', 'verifyHeld', 'matches', 'labels',
    'guardTask', 'daemonOpen', 'assertPinned', 'beforeEffect', 'subject']);
});

test('guard: дрейф контрактных меток до повтора — ноль доп. вызовов', async () => {
  for (const live of [
      { ...CONTRACT, policy_digest: 'e'.repeat(64) },
      { ...CONTRACT, spec_digest: 'e'.repeat(64) },
      { ...CONTRACT, repo_id: 'other' },
      { ...CONTRACT, has_ui: 'true' }]) {
    const { review, calls } = scriptedReview([
      timeout('review_runner_exit:143'), { verdict: 'REVIEW_OK' }]);
    const { guard } = guardFixture({ port: {
      verifyHeld: async (t, e) => ({ epoch: e }), matches: async () => true,
      labels: async () => live, guardTask: async () => {} } });
    await assert.rejects(
      l2ReviewWithTransientRetry({ review, binding: BINDING,
        profile: { review: CRITIC }, beforeRetry: guard,
        verifySubject: async () => {} }),
      (e) => e.message.startsWith('contract_drift:'));
    assert.equal(calls(), 1, JSON.stringify(live));
  }
  // Нет порта меток — отказ до повтора, а не тихий пропуск.
  const { review, calls } = scriptedReview([
    timeout('review_runner_exit:143'), { verdict: 'REVIEW_OK' }]);
  const { guard } = guardFixture({ port: {
    verifyHeld: async (t, e) => ({ epoch: e }), matches: async () => true,
    guardTask: async () => {} } });
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding: BINDING,
      profile: { review: CRITIC }, beforeRetry: guard,
      verifySubject: async () => {} }),
    (e) => e.message === 'contract_labels_unavailable');
  assert.equal(calls(), 1);
});

test('guard: снятие required-метки маршрута до повтора — ноль доп. вызовов', async () => {
  // Тот же допуск, что claimReady/admits на первичном захвате: метка из
  // route.required обязана быть НЕПУСТОЙ строкой — и снятая, и опустошённая
  // закрывают карточку для повтора.
  for (const live of [{ ...CONTRACT }, { ...CONTRACT, ui_e2e: '' }]) {
    const { review, calls } = scriptedReview([
      timeout('review_runner_exit:143'), { verdict: 'REVIEW_OK' }]);
    const { guard } = guardFixture({ required: ['ui_e2e'],
      port: {
        verifyHeld: async (t, e) => ({ epoch: e }), matches: async () => true,
        labels: async () => live, guardTask: async () => {} } });
    await assert.rejects(
      l2ReviewWithTransientRetry({ review, binding: BINDING,
        profile: { review: CRITIC }, beforeRetry: guard,
        verifySubject: async () => {} }),
      (e) => e.message === 'required_label_missing:ui_e2e');
    assert.equal(calls(), 1, JSON.stringify(live));
  }
  // Метка на месте — повтор допускается.
  const { review: review2, calls: calls2 } = scriptedReview([
    timeout('review_runner_exit:143'), { verdict: 'REVIEW_OK' }]);
  const { guard: guard2 } = guardFixture({ required: ['ui_e2e'],
    port: {
      verifyHeld: async (t, e) => ({ epoch: e }), matches: async () => true,
      labels: async () => ({ ...CONTRACT, ui_e2e: '1' }), guardTask: async () => {} } });
  const receipt = await l2ReviewWithTransientRetry({ review: review2, binding: BINDING,
    profile: { review: CRITIC }, beforeRetry: guard2, verifySubject: async () => {} });
  assert.equal(calls2(), 2);
  assert.equal(receipt.verdict, 'REVIEW_OK');
});

test('guard: daemon kill-switch закрыт до повтора — ноль доп. вызовов', async () => {
  const { review, calls } = scriptedReview([
    timeout('review_runner_exit:143'), { verdict: 'REVIEW_OK' }]);
  const { guard } = guardFixture({
    daemonOpen: async () => { throw new Error('kill_switch'); } });
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding: BINDING,
      profile: { review: CRITIC }, beforeRetry: guard,
      verifySubject: async () => {} }),
    (e) => e.message === 'kill_switch');
  assert.equal(calls(), 1);
});

test('guard: дрейф lease/epoch до повтора — ноль доп. вызовов', async () => {
  for (const port of [
      { verifyHeld: async () => { const e = new Error('claim_lost'); e.code = 'claim_lost'; throw e; } },
      { verifyHeld: async () => ({ epoch: 2 }) }]) {
    const { review, calls } = scriptedReview([
      timeout('review_runner_exit:143'), { verdict: 'REVIEW_OK' }]);
    const { guard } = guardFixture({ port: { matches: async () => true, guardTask: async () => {}, ...port } });
    await assert.rejects(
      l2ReviewWithTransientRetry({ review, binding: BINDING,
        profile: { review: CRITIC }, beforeRetry: guard,
        verifySubject: async () => {} }),
      (e) => e.code === 'claim_lost' || e.message === 'Lease lost');
    assert.equal(calls(), 1);
  }
});

test('guard: смена владельца/метки, отказ guardTask и пинов — ноль доп. вызовов', async () => {
  const cases = [
    { port: { verifyHeld: async (t, e) => ({ epoch: e }), matches: async () => false, guardTask: async () => {} },
      check: (e) => e.message === 'Task no longer authorized' },
    { port: { verifyHeld: async (t, e) => ({ epoch: e }), matches: async () => true,
        labels: async () => ({ ...CONTRACT }),
        guardTask: async () => { throw new Error('task_denied'); } },
      check: (e) => e.message === 'task_denied' },
    { port: { verifyHeld: async (t, e) => ({ epoch: e }), matches: async () => true,
        labels: async () => ({ ...CONTRACT }), guardTask: async () => {} },
      assertPinned: async () => { throw new Error('Operator inputs changed'); },
      check: (e) => e.message === 'Operator inputs changed' },
  ];
  for (const { check, ...over } of cases) {
    const { review, calls } = scriptedReview([
      timeout('review_runner_exit:143'), { verdict: 'REVIEW_OK' }]);
    const { guard } = guardFixture(over);
    await assert.rejects(
      l2ReviewWithTransientRetry({ review, binding: BINDING,
        profile: { review: CRITIC }, beforeRetry: guard,
        verifySubject: async () => {} }),
      check);
    assert.equal(calls(), 1);
  }
});

test('boundary: продукционный l2LaunchBoundary — daemon-стоп читается последним', async () => {
  // Порядок продукционного хука: живые гейты → субъект → пины/переключатели
  // → lease → daemon-стоп-файл ПОСЛЕДНИМ, непосредственно перед запуском.
  const seen = [];
  await l2LaunchBoundary({
    retryGuard: async () => seen.push('guard'),
    verifySubject: async () => seen.push('subject'),
    assertOpen: async () => seen.push('pins'),
    checkLease: async () => seen.push('lease'),
    daemonOpen: async () => seen.push('switch'),
  })();
  assert.deepEqual(seen, ['guard', 'subject', 'pins', 'lease', 'switch']);
  // Daemon-стоп закрывается в окне асинхронной проверки пинов: финальное
  // чтение стоп-файла обязано его увидеть — запуск отменяется.
  let closed = false;
  const boundary = l2LaunchBoundary({
    retryGuard: async () => {},
    verifySubject: async () => {},
    assertOpen: async () => { await Promise.resolve(); closed = true; },
    checkLease: async () => {},
    daemonOpen: async () => { if (closed) throw new Error('kill_switch'); },
  });
  await assert.rejects(boundary(), /kill_switch/);
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

test('retry: Neon-профиль допускается реальным operatorReviewSetup', async (t) => {
  // Полный операторский путь без модели: документированный Neon medium со
  // скиллами на subject-bound очереди и Sol-арбитре — реальный
  // operatorReviewSetup проверяет профиль, скилл-файлы и триаду.
  const dir = await mkdtemp(join(tmpdir(), 'retry-skills-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const skillFile = join(dir, 'logika.md');
  await writeFile(skillFile, 'review skill\n');
  const policy = {
    bb: { provider: 'acp-devin', model: 'swe-2-high' },
    profiles: { code: { review: { provider: 'google', model: 'gemini-4-neon',
      reasoningLevel: 'medium', skills: ['logika'] } } },
    arbiter: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' },
    route: { checkProfile: 'code' },
    reviewSkillFiles: { logika: skillFile },
  };
  const setup = await operatorReviewSetup(policy);
  assert.equal(setup.neon, true);
  assert.ok(isNeonReview(l2CriticSpec(setup.critic)));
  assert.ok(isSolArbiter(setup.arbiter));
  assert.deepEqual(setup.skillPaths, [skillFile]);
  // Повтор runner-агностик: любой read-only раннер с typed timeout.
  const { review, calls } = scriptedReview([
    timeout('review_runner_exit:143'), { status: 'PASS' }]);
  const receipt = await l2ReviewWithTransientRetry({ review, binding: BINDING,
    profile: { review: l2CriticSpec(setup.critic) }, beforeRetry: async () => {},
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
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next;
  };
  const review = isolatedPiReviewRunner({ journal, piRoot, sandbox });
  const binding = {
    task_id: '1', candidate_sha: sha, base_sha: base, worktree: dir,
    executor: 'acp-devin/swe-2-high', subject_digest: DIGEST,
  };
  return { review, binding, profile: { review: CRITIC }, calls: () => calls,
    git, dir, journal, piRoot };
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

gitTest('runner: валидный PASS при коде 143 — hold без повтора и без приёмки', async (t) => {
  // Завершённый ответ — не обрыв: повтора нет, но и квитанции приёмки по
  // ненулевому выходу тоже нет — обычный hold сохраняется.
  const { review, binding, profile, calls } = await fixture(t, [
    { code: 143, stdout: PASS, stderr: 'killed at teardown' },
    { code: 0, stdout: PASS, stderr: '' }]);
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding, profile,
      beforeRetry: async () => { throw new Error('no retry expected'); } }),
    (e) => e instanceof ReviewDenied && !(e instanceof ReviewRunnerTimeout) &&
      e.reason === 'review_runner_exit:143');
  assert.equal(calls(), 1);
});

// Реальный адаптер через подставной `docker` на PATH: первый `docker run`
// спит и добивается host-timeout (killed+SIGTERM → timedOut), `docker rm -f`
// фиксирует cleanup; второй запуск отдаёт готовый транскрипт. Файл событий
// доказывает порядок run→rm→run: второй вызов только после cleanup.
async function dockerStub(t, { rmExit = 0 } = {}) {
  const bin = await mkdtemp(join(tmpdir(), 'retry-docker-'));
  const log = join(bin, 'calls.log');
  const passFile = join(bin, 'pass.ndjson');
  await writeFile(passFile, PASS);
  const script = ['#!/bin/sh',
    'echo "$1" >> "$DOCKER_STUB_LOG"',
    'case "$1" in',
    'info) printf \'["name=rootless"]\\n\' ;;',
    'run) if [ "$(grep -c "^run$" "$DOCKER_STUB_LOG")" -ge 2 ]; then cat "$DOCKER_STUB_PASS"; exit 0; fi; sleep 5 ;;',
    `rm) echo cleanup >&2; exit ${rmExit} ;;`,
    'esac', 'exit 0', ''].join('\n');
  await writeFile(join(bin, 'docker'), script, { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  process.env.DOCKER_STUB_LOG = log;
  process.env.DOCKER_STUB_PASS = passFile;
  t.after(async () => {
    process.env.PATH = prevPath;
    delete process.env.DOCKER_STUB_LOG;
    delete process.env.DOCKER_STUB_PASS;
    await rm(bin, { recursive: true, force: true });
  });
  const calls = async () => (await readFile(log, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean);
  return { calls };
}

shTest('adapter: host-timeout через реальный sandbox, cleanup до второго вызова', async (t) => {
  const { calls } = await dockerStub(t);
  // Прямой вызов адаптера: docker run спит, хостовый timeout (300 мс) добивает
  // его SIGTERM — числового кода нет, есть доказанный timedOut.
  const run = await runInReadOnlySandbox({ snapshot: tmpdir(), argv: ['true'],
    timeoutMs: 300 });
  assert.equal(run.code, null);
  assert.equal(run.timedOut, true);
  // Cleanup (`docker rm -f`) выполнен до возврата результата.
  assert.deepEqual(await calls(), ['info', 'run', 'rm']);
});

shTest('adapter: сбой cleanup — ReviewDenied, не transient', async (t) => {
  await dockerStub(t, { rmExit: 1 });
  await assert.rejects(
    runInReadOnlySandbox({ snapshot: tmpdir(), argv: ['true'], timeoutMs: 300 }),
    (e) => e instanceof ReviewDenied && !(e instanceof ReviewRunnerTimeout) &&
      e.reason === 'sandbox_cleanup_failed');
});

dockerTest('runner: host-timeout через адаптер → повтор только после cleanup', async (t) => {
  const { calls } = await dockerStub(t);
  const { binding, profile, journal, piRoot } = await fixture(t, []);
  const runner = isolatedPiReviewRunner({ journal, piRoot,
    sandbox: runInReadOnlySandbox, timeoutMs: 300 });
  const receipt = await l2ReviewWithTransientRetry({ review: runner,
    binding, profile, beforeRetry: async () => {} });
  assert.equal(receipt.verdict, 'REVIEW_OK');
  // Порядок вызовов docker: второй `run` начался только после `rm` первого
  // (info — preflight каждого вызова адаптера).
  assert.deepEqual(await calls(), ['info', 'run', 'rm', 'info', 'run', 'rm']);
});

dockerTest('runner: сбой cleanup первого читателя — повтора нет', async (t) => {
  const { calls } = await dockerStub(t, { rmExit: 1 });
  const { binding, profile, journal, piRoot } = await fixture(t, []);
  const runner = isolatedPiReviewRunner({ journal, piRoot,
    sandbox: runInReadOnlySandbox, timeoutMs: 300 });
  await assert.rejects(
    l2ReviewWithTransientRetry({ review: runner, binding, profile,
      beforeRetry: async () => { throw new Error('no retry expected'); } }),
    (e) => e.reason === 'sandbox_cleanup_failed');
  assert.deepEqual(await calls(), ['info', 'run', 'rm']);
});

dockerTest('runner: живые гейты на границе запуска — второго reader нет', async (t) => {
  // Между успешным beforeRetry и docker run второго читателя меняется ЖИВОЕ
  // состояние (lease отпущен / renewal-флаг / switch закрыт В ОКНЕ сверки
  // субъекта): beforeEffect раннера обязан заново доказать гейт на границе
  // эффекта, а дешёвый switch/lost — последним, после асинхронной проверки.
  for (const mode of ['flag', 'live', 'closing']) {
    const { calls } = await dockerStub(t);
    const { binding, profile, journal, piRoot } = await fixture(t, []);
    let held = true;
    let second = false;
    const runner = isolatedPiReviewRunner({ journal, piRoot,
      sandbox: runInReadOnlySandbox, timeoutMs: 300,
      beforeEffect: mode === 'closing' ? async () => {
        // Продукционный порядок: живой гейт → асинхронная сверка субъекта,
        // в её окне switch закрывается → финальная дешёвая проверка ловит.
        if (!second) return;
        await Promise.resolve();         // живой гейт проходит
        held = false;                    // switch/lease закрываются в окне
        await Promise.resolve();         // окно async subject-check
        if (!held) throw new Error('kill_switch');
      } : async () => {
        if (second && !held) throw new Error(mode === 'flag' ? 'Lease lost' : 'claim_lost');
      } });
    await assert.rejects(
      l2ReviewWithTransientRetry({ review: runner, binding, profile,
        beforeRetry: async () => { second = true; if (mode !== 'closing') held = false; } }),
      (e) => /Lease lost|claim_lost|kill_switch/.test(e.message), mode);
    // Второй docker info — host-side preflight перед beforeEffect; `run` нет.
    assert.deepEqual(await calls(), ['info', 'run', 'rm', 'info'], mode);
  }
});

gitTest('runner: завершённый REWORK при коде 143 — hold, как и любой грязный выход', async (t) => {
  // Ненулевой выход не даёт квитанции вообще: завершённый поток проходит
  // обычную валидацию, но вердикт по грязному выходу уходит в hold —
  // иначе failed execution мог бы подать обычный rework/escalate.
  const rework = stream(JSON.stringify({ verdict: 'REWORK', summary: 'bad',
    subject_digest: DIGEST,
    findings: [{ file: 'b.txt', line: 1, expected: 'x', actual: 'y' }] }));
  for (const code of [1, 137, 143]) {
    const { review, binding, profile, calls } = await fixture(t, [
      { code, stdout: rework, stderr: '' },
      { code: 0, stdout: PASS, stderr: '' }]);
    await assert.rejects(
      l2ReviewWithTransientRetry({ review, binding, profile,
        beforeRetry: async () => { throw new Error('no retry expected'); } }),
      (e) => e instanceof ReviewDenied && !(e instanceof ReviewRunnerTimeout) &&
        e.reason === `review_runner_exit:${code}`);
    assert.equal(calls(), 1, `exit ${code}`);
  }
  // Host-timeout с завершённым REWORK — тот же hold, повторный вызов не
  // «сохраняет» вердикт failed execution.
  const { review, binding, profile, calls } = await fixture(t, [
    { code: null, timedOut: true, stdout: rework, stderr: '' },
    { code: 0, stdout: PASS, stderr: '' }]);
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding, profile,
      beforeRetry: async () => { throw new Error('no retry expected'); } }),
    (e) => e.reason === 'review_runner_exit:timeout');
  assert.equal(calls(), 1);
});

gitTest('runner: завершённый, но misattested ответ при 143 — отказ без повтора', async (t) => {
  for (const bad of [
      // message.model отличается от закреплённого критика.
      stream('REVIEW_OK', { model: 'gpt-6.2-astra' }),
      // model совпадает, но responseModel сообщает другую модель —
      // review_model_mismatch внутри парсера тоже не transient.
      stream('REVIEW_OK', { responseModel: 'gpt-6.2-astra' })]) {
    const { review, binding, profile, calls } = await fixture(t, [
      { code: 143, stdout: bad, stderr: '' },
      { code: 0, stdout: PASS, stderr: '' }]);
    await assert.rejects(
      l2ReviewWithTransientRetry({ review, binding, profile,
        beforeRetry: async () => { throw new Error('no retry expected'); } }),
      (e) => e instanceof ReviewDenied && !(e instanceof ReviewRunnerTimeout));
    assert.equal(calls(), 1);
  }
});

gitTest('runner: незавершённый, но дисквалифицирующий поток при 143 — без повтора', async (t) => {
  for (const { stdout, reason } of [
    // Явный error-event провайдера: отказ зафиксирован, не обрыв.
    { stdout: [JSON.stringify({ type: 'error', message: 'refused' }), msg()].join('\n'),
      reason: 'review_runner_reported_error' },
    // Только error-event без assistant-хода: парсер отвечает empty, но
    // скан по сырому потоку всё равно обязан увидеть зафиксированный отказ.
    { stdout: JSON.stringify({ type: 'error', message: 'refused' }),
      reason: 'review_runner_reported_error' },
    // Битая NDJSON-строка не должна скрывать error-event в остальных строках.
    { stdout: ['{"type":"error"', JSON.stringify({ type: 'error', message: 'refused' })].join('\n'),
      reason: 'review_runner_reported_error' },
    // Assistant-сообщение чужой модели без settled: mismatch, не transient.
    { stdout: msg({ model: 'gpt-6.2-astra' }), reason: 'review_model_mismatch' },
    // Целое message_end с subject-bound REWORK, но до agent_settled:
    // вердикт уже издан — потеря settlement-события не открывает повтор.
    { stdout: msg({ content: [{ type: 'text', text: JSON.stringify({
        verdict: 'REWORK', summary: 'bad', subject_digest: DIGEST,
        findings: [{ file: 'b.txt', line: 1, expected: 'x', actual: 'y' }] }) }] }),
      reason: 'review_verdict_emitted' },
    // Маркер legacy-вердикта в тексте хода без settled — тот же исход.
    { stdout: msg({ content: [{ type: 'text', text: 'REVIEW_BLOCKED\nreasons' }] }),
      reason: 'review_verdict_emitted' },
    // Malformed-вердикт {"verdict":42} в целом assistant-сообщении без
    // settled: вердиктоподобный объект уже издан — hold, не повтор.
    { stdout: msg({ content: [{ type: 'text', text: '{"verdict":42}' }] }),
      reason: 'review_verdict_emitted' },
    // Синтаксически битый вердикт-объект (JSON.parse не проходит) — исход
    // уже издан, hold; review_verdict_missing здесь недопустим как transient.
    { stdout: msg({ content: [{ type: 'text', text: '{"verdict":"REWORK",}' }] }),
      reason: 'review_verdict_emitted' },
    // session_info с запрещённым tool без assistant-хода: нарушение политики
    // инструментов зафиксировано потоком — потеря settlement его не стирает.
    { stdout: JSON.stringify({ type: 'session_info',
        data: { toolsAdded: ['read', 'bash'] } }),
      reason: 'review_forbidden_tool:bash' },
    // Отказ провайдера в самом assistant-сообщении (stopReason error +
    // errorMessage), без верхнеуровневого error-события и вердикта — hold.
    { stdout: msg({ stopReason: 'error', errorMessage: 'provider refused',
        content: [{ type: 'text', text: 'cannot comply' }] }),
      reason: 'review_runner_reported_error' },
    // Завершённый штатно ход (stop/completed + agent_settled), но ПУСТОЙ
    // текст: ответ завершён и невалиден — не обрыв, повтора нет.
    { stdout: [msg({ stopReason: 'stop', rawStopReason: 'completed',
        content: [] }), settled].join('\n'),
      reason: 'review_verdict_missing' },
    // Битый НЕквотированный {verdict: ...} в завершённом assistant-ответе
    // без settled: намерение недоказуемо — консервативный hold, пропажа
    // settlement не превращает закрытый ответ в обрыв.
    { stdout: msg({ stopReason: 'stop', rawStopReason: 'completed',
        content: [{ type: 'text', text: '{verdict: REWORK, findings: []}' }] }),
      reason: 'review_verdict_missing' }]) {
    const { review, binding, profile, calls } = await fixture(t, [
      { code: 143, stdout, stderr: '' },
      { code: 0, stdout: PASS, stderr: '' }]);
    await assert.rejects(
      l2ReviewWithTransientRetry({ review, binding, profile,
        beforeRetry: async () => { throw new Error('no retry expected'); } }),
      (e) => e instanceof ReviewDenied && !(e instanceof ReviewRunnerTimeout) &&
        e.reason === reason);
    assert.equal(calls(), 1, reason);
  }
  // А действительно оборванный поток (ни одного хода, обрыв mid-message) —
  // transient, повтор допустим.
  for (const truncated of ['', msg().slice(0, 40)]) {
    const { review, binding, profile, calls } = await fixture(t, [
      { code: 143, stdout: truncated, stderr: '' },
      { code: 0, stdout: PASS, stderr: '' }]);
    const receipt = await l2ReviewWithTransientRetry({ review, binding, profile,
      beforeRetry: async () => {} });
    assert.equal(calls(), 2, JSON.stringify(truncated));
    assert.equal(receipt.verdict, 'REVIEW_OK');
  }
});

gitTest('runner: REWORK при нетранзиентном выходе — hold, как раньше', async (t) => {
  const rework = stream(JSON.stringify({ verdict: 'REWORK', summary: 'bad',
    subject_digest: DIGEST,
    findings: [{ file: 'b.txt', line: 1, expected: 'x', actual: 'y' }] }));
  for (const code of [1, 137]) {
    const { review, binding, profile, calls } = await fixture(t, [
      { code, stdout: rework, stderr: '' },
      { code: 0, stdout: PASS, stderr: '' }]);
    await assert.rejects(
      l2ReviewWithTransientRetry({ review, binding, profile,
        beforeRetry: async () => { throw new Error('no retry expected'); } }),
      (e) => e.reason === `review_runner_exit:${code}`);
    assert.equal(calls(), 1, `exit ${code}`);
  }
});

gitTest('runner: sandbox cleanup failure — typed ReviewDenied, без повтора', async (t) => {
  const { review, binding, profile, calls } = await fixture(t, [
    new ReviewDenied('sandbox_cleanup_failed'),
    { code: 0, stdout: PASS, stderr: '' }]);
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding, profile,
      beforeRetry: async () => { throw new Error('no retry expected'); } }),
    (e) => e instanceof ReviewDenied && !(e instanceof ReviewRunnerTimeout) &&
      e.reason === 'sandbox_cleanup_failed');
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

gitTest('runner: мутация снимка первого читателя — hold, не transient', async (t) => {
  // Read-only граница сломана: выход 143 нельзя сделать повторяемым —
  // целостность снимка первого читателя проверяется ДО transient-
  // классификации, иначе повтор стирает следы инцидента.
  const { dir, base, sha } = await repo();
  const journal = await mkdtemp(join(tmpdir(), 'retry-journal-'));
  const piRoot = await mkdtemp(join(tmpdir(), 'retry-pi-'));
  await writeFile(join(piRoot, 'auth.json'), '{"openai":{"k":"v"}}');
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(journal, { recursive: true, force: true });
    await rm(piRoot, { recursive: true, force: true });
  });
  let count = 0;
  const calls = () => count;
  const sandbox = async ({ snapshot }) => {
    count++;
    if (count === 1) {
      await writeFile(join(snapshot, 'planted.txt'), 'tampered\n');
      return { code: 143, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: PASS, stderr: '' };
  };
  const review = isolatedPiReviewRunner({ journal, piRoot, sandbox });
  const binding = { task_id: '1', candidate_sha: sha, base_sha: base,
    worktree: dir, executor: 'acp-devin/swe-2-high', subject_digest: DIGEST };
  await assert.rejects(
    l2ReviewWithTransientRetry({ review, binding, profile: { review: CRITIC },
      beforeRetry: async () => { throw new Error('no retry expected'); } }),
    (e) => e instanceof ReviewDenied && !(e instanceof ReviewRunnerTimeout) &&
      e.reason === 'snapshot_mutated');
  assert.equal(calls(), 1);
});

gitTest('subject: worktree, ветка, SHA и чистое дерево на candidate', async (t) => {
  const { dir, git, base, sha } = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binding = { worktree: dir, candidate_sha: sha, base_sha: base, branch: 'pilot' };
  await assertRetrySubjectUnchanged(binding);
  // Без заданной ветки — HEAD обязан быть attached (зачисленная ветка есть).
  await assertRetrySubjectUnchanged({ ...binding, branch: undefined });
  await assert.rejects(assertRetrySubjectUnchanged({ ...binding, worktree: '/no' }));
  await assert.rejects(assertRetrySubjectUnchanged({ ...binding, candidate_sha: 'x' }),
    (e) => e.reason === 'review_retry_subject_unverified');
  // Другая ветка на том же коммите — не тот субъект.
  await assert.rejects(assertRetrySubjectUnchanged({ ...binding, branch: 'other' }),
    (e) => e.reason === 'review_retry_subject_changed');
  await git('checkout', '-qb', 'other');
  await assert.rejects(assertRetrySubjectUnchanged(binding),
    (e) => e.reason === 'review_retry_subject_changed');
  // Detached HEAD на том же SHA — отказ.
  await git('checkout', '-q', '--detach', 'HEAD');
  await assert.rejects(assertRetrySubjectUnchanged({ ...binding, branch: undefined }),
    (e) => e.reason === 'review_retry_subject_changed');
  await git('checkout', '-q', 'pilot');
  // Путь, заменённый симлинком на другой чистый checkout с тем же SHA, — не
  // тот зачисленный worktree: канонический путь записи не восстанавливается.
  const { symlink } = await import('node:fs/promises');
  const link = join(tmpdir(), `retry-link-${Date.now()}`);
  await symlink(dir, link);
  try {
    await assert.rejects(
      assertRetrySubjectUnchanged({ ...binding, worktree: link }),
      (e) => e.reason === 'review_retry_subject_changed');
  } finally {
    await rm(link, { force: true });
  }
  // Грязное дерево и смена HEAD — отказ.
  await writeFile(join(dir, 'd.txt'), 'd\n');
  await assert.rejects(assertRetrySubjectUnchanged(binding),
    (e) => e.reason === 'review_retry_subject_changed');
  await git('add', 'd.txt');
  await git('commit', '-qm', 'd');
  await assert.rejects(assertRetrySubjectUnchanged(binding),
    (e) => e.reason === 'review_retry_subject_changed');
});

gitTest('runners: пара l2CriticRunners — первый запуск без retry-гейтов', async (t) => {
  // Продукционная проводка пары читателей: первый экземпляр получает
  // beforeEffect как есть — повтор на первом запуске не должен нести ни
  // retry-хука границы, ни контроллерских гейтов. Проверяется фактическими
  // вызовами на границе dispatch, а не формой кода.
  const { binding, profile, journal, piRoot } = await fixture(t, []);
  const seen = [];
  const sandbox = async ({ beforeEffect } = {}) => {
    await beforeEffect?.();
    seen.push('dispatch');
    return { code: 0, stdout: PASS, stderr: '' };
  };
  const { review, retry } = l2CriticRunners({
    makeRunner: opts => {
      seen.push('construct');
      return isolatedPiReviewRunner({ journal, piRoot, sandbox, ...opts });
    },
    options: {},
    beforeEffect: async () => { seen.push('beforeEffect'); },
    retryBeforeEffect: async () => { seen.push('retryBoundary'); },
  });
  // Проверки review-порта идут до конструирования читателя: вызов пары
  // здесь ещё не построил ни одного раннера.
  assert.deepEqual(seen, []);
  const receipt = await l2ReviewWithTransientRetry({ review, retry, binding, profile,
    beforeRetry: async () => { seen.push('beforeRetry'); } });
  assert.equal(receipt.verdict, 'REVIEW_OK');
  // Раннер построен лениво при первом вызове; retry-экземпляр без повтора
  // не конструируется и не запускается вообще.
  assert.deepEqual(seen, ['construct', 'beforeEffect', 'dispatch']);
});

gitTest('runners: retry-only хук — только на втором запуске того же раннера', async (t) => {
  const { binding, profile, journal, piRoot } = await fixture(t, []);
  const seen = [];
  let n = 0;
  const sandbox = async ({ beforeEffect } = {}) => {
    await beforeEffect?.();
    seen.push('dispatch');
    n++;
    return n === 1 ? { code: 143, stdout: '', stderr: '' }
                   : { code: 0, stdout: PASS, stderr: '' };
  };
  const { review, retry } = l2CriticRunners({
    makeRunner: opts => {
      seen.push('construct');
      return isolatedPiReviewRunner({ journal, piRoot, sandbox, ...opts });
    },
    options: {},
    beforeEffect: async () => { seen.push('beforeEffect'); },
    retryBeforeEffect: async () => { seen.push('retryBoundary'); },
  });
  const receipt = await l2ReviewWithTransientRetry({ review, retry, binding, profile,
    beforeRetry: async () => { seen.push('beforeRetry'); } });
  assert.equal(receipt.verdict, 'REVIEW_OK');
  // Второй вызов идёт отдельным экземпляром, построенным только на повторе:
  // граница запуска — на нём, после beforeRetry, перед dispatch.
  assert.deepEqual(seen, ['construct', 'beforeEffect', 'dispatch', 'beforeRetry',
    'construct', 'retryBoundary', 'dispatch']);
});

dockerTest('boundary: свежий verifyHeld на границе второго запуска', async (t) => {
  // Продукционная композиция повтора с НАСТОЯЩИМ nativeBoardPort над
  // подставным бэкендом карточки: lease теряется после ранних проверок
  // границы (guard и subject прошли), но до docker run второго читателя —
  // свежий native renew обязан упасть и не допустить запуск. Кэш флага
  // здесь не используется: вызов идёт в самой границе после async гейтов.
  for (const lose of ['renew', 'epoch']) {
    const { calls } = await dockerStub(t);
    const { binding, profile, journal, piRoot } = await fixture(t, []);
    const until = () => new Date(Date.now() + 600_000).toISOString();
    const root = { id: '1', channel: 'ch',
      labels: { ...CONTRACT, queue: 'x' },
      task: { state: 'ready', epoch: 1, owner: 'local:user:t' } };
    let renewable = true;
    let claim;
    const renewals = [];
    const handle = {
      thread: async () => ({ message: root }),
      tasks: { claim: async () => {
        root.task.state = 'claimed';
        root.task.claim = { until: until() };
        claim = { epoch: 1, until: root.task.claim.until,
          renew: async () => {
            renewals.push('renew');
            if (!renewable) {
              const e = new Error('claim_lost');
              e.code = 'claim_lost';
              throw e;
            }
            return { until: until() };
          } };
        return claim;
      } },
    };
    // Та же проводка, что в run-isolated: нативный порт, retryGuard,
    // launchBoundary с l2FreshLeaseCheck и пара читателей l2CriticRunners.
    const port = nativeBoardPort(handle, { channel: 'ch' });
    await port.claim('1', {});
    const seen = [];
    const retryGuard = l2ReviewRetryGuard({ port, taskId: '1', epoch: 1,
      owner: 'local:user:t', label: { key: 'queue', value: 'x' },
      contract: CONTRACT,
      assertPinned: async () => { seen.push('assertPinned'); },
      beforeEffect: async () => { seen.push('beforeEffect'); },
      daemonOpen: async () => { seen.push('guardSwitch'); } });
    const boundary = l2LaunchBoundary({
      retryGuard,
      verifySubject: async () => {
        seen.push('subject');
        // Потеря живого lease в окне границы, после ранних проверок.
        if (lose === 'renew') renewable = false; else claim.epoch = 2;
      },
      assertPinned: async () => { seen.push('pins'); },
      checkLease: l2FreshLeaseCheck({ port, taskId: '1', epoch: 1 }),
      daemonOpen: async () => { seen.push('switch'); },
    });
    const { review, retry } = l2CriticRunners({
      makeRunner: opts => isolatedPiReviewRunner({ journal, piRoot,
        sandbox: runInReadOnlySandbox, timeoutMs: 300, ...opts }),
      options: {},
      beforeEffect: async () => { seen.push('first'); },
      retryBeforeEffect: async () => { await boundary(); },
    });
    await assert.rejects(
      l2ReviewWithTransientRetry({ review, retry, binding, profile,
        beforeRetry: retryGuard }),
      (e) => e.code === 'claim_lost' || e.code === 'epoch_mismatch', lose);
    // Свежий native renew на границе увидел потерю: второй `docker run`
    // не начался; стоп-файл до проверки lease не дошёл и не требовался.
    assert.ok(renewals.length >= 2, `${lose}: renewals=${renewals.length}`);
    assert.deepEqual(await calls(), ['info', 'run', 'rm', 'info'], lose);
  }
});
