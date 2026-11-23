import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { acceptHeld } from './acceptance.mjs';
import { nativeBoardPort } from './native-board.mjs';
import { buildSubject, subjectDigest } from './subject.mjs';
import { loadSdk } from './sdk.mjs';
import { NEON_CRITIC, NEON_ISOLATION, SOL_ARBITER } from './review-policy.mjs';

const { board, local } = loadSdk();

const BASE = '0'.repeat(40);
const CAND = 'a'.repeat(40);
const CAND_B = 'b'.repeat(40);
const REVIEW_ROUTE = { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' };

const testRoot = await mkdtemp(path.join(tmpdir(), 'board-held-tests-'));
process.on('exit', () => rm(testRoot, { recursive: true, force: true }));
function tmpJournal() {
  return mkdtemp(path.join(testRoot, 'attempt-'));
}

// Изолированная доска: настоящий native claim/held, никакой заглушки статуса.
async function isolated(t) {
  const backend = local({ memory: true });
  t.after(() => backend.close());
  const handle = board({ backend });
  await handle.createChannel('pilot');
  const seen = { claim: 0, token: null };
  const ported = {
    ...handle,
    tasks: {
      ...handle.tasks,
      claim: async (...args) => {
        seen.claim++;
        const claimed = await handle.tasks.claim(...args);
        seen.token = claimed.token;
        return claimed;
      },
    },
  };
  return { handle, ported, seen };
}

async function task(handle, text = 'Synthetic held acceptance') {
  const { task } = await handle.tasks.create('pilot', { text, noSync: true });
  return task.id;
}

function policy(taskId, over = {}) {
  return {
    version: '2',
    profiles: {
      pilot: {
        task: taskId,
        worker: 'thr_fixture',
        worktree: '/tmp/wt',
        branch: 'pilot',
        base: BASE,
        review: REVIEW_ROUTE,
        ...over,
      },
    },
  };
}

function attempt(taskId, epoch, over = {}) {
  return {
    attempt_id: 'att-1',
    task_id: taskId,
    epoch,
    bb_thread_id: 'thr_fixture',
    worktree: '/tmp/wt',
    base_sha: BASE,
    check_profile: 'pilot',
    finish: 'verified',
    ...over,
  };
}

function submission(taskId, epoch, over = {}) {
  return {
    task_id: taskId,
    epoch,
    attempt_id: 'att-1',
    worker_thread_id: 'thr_fixture',
    candidate_sha: CAND,
    ...over,
  };
}

function stubs(over = {}) {
  const calls = { inspect: 0, local: 0, review: 0 };
  return {
    calls,
    ports: {
      inspect: async (binding) => {
        calls.inspect++;
        return { head: binding.candidate_sha, clean: true, baseAncestor: true };
      },
      local: async (binding) => {
        calls.local++;
        return { sha: binding.candidate_sha, ok: true, evidence: 'checks.json', exit: 0 };
      },
      tamper: async (binding) => ({
        ok: true, sha: binding.candidate_sha, base_sha: binding.base_sha,
        violations: [], digest: 't'.repeat(64),
      }),
      review: async (binding) => {
        calls.review++;
        return {
          task: binding.task_id,
          sha: binding.candidate_sha,
          actual: { ...REVIEW_ROUTE },
          verdict: 'REVIEW_OK',
          checkpoint: 'feed80ab',
        };
      },
      ...over,
    },
  };
}

async function settled(handle, id) {
  const { message } = await handle.thread(id);
  const { state, claim, blocked } = message.task;
  const raw = message.task.result;
  const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { state, result, claim, blocked };
}

async function journalText(dir) {
  const files = await readdir(dir);
  const texts = [];
  for (const file of files.filter((name) => name.endsWith('.jsonl'))) {
    texts.push(await readFile(path.join(dir, file), 'utf8'));
  }
  return texts.join('\n');
}

// Один порт на попытку: аренда живёт внутри него, как у контроллера.
async function held(handle, id, lease) {
  const port = nativeBoardPort(handle, { channel: 'pilot', lease });
  const { epoch } = await port.claim(id);
  return { epoch, port };
}

test('действующая эпоха: приёмка без второго claim, зелёный verdict', async (t) => {
  const { handle, ported, seen } = await isolated(t);
  const id = await task(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  assert.equal(seen.claim, 1);
  const journal = await tmpJournal();
  const { ports, calls } = stubs();

  const res = await acceptHeld({
    attempt: attempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });

  assert.equal(res.outcome, 'verified');
  assert.equal(res.receipt.candidate_sha, CAND);
  assert.equal(res.receipt.epoch, epoch);
  assert.equal(res.receipt.policy_version, '2');
  assert.equal(res.receipt.settle, 'completed');
  assert.deepEqual(calls, { inspect: 2, local: 1, review: 1 });
  // Никакого второго claim: аренда та же, что взял контроллер.
  assert.equal(seen.claim, 1);
  const after = await settled(handle, id);
  assert.equal(after.state, 'completed');
  assert.equal(after.result.sha, CAND);
  assert.equal(after.result.review.checkpoint, 'feed80ab');
  // Токен аренды не попадает ни в журнал, ни в квитанцию.
  assert.ok(seen.token);
  assert.ok(!JSON.stringify(res).includes(seen.token));
  assert.ok(!(await journalText(journal)).includes(seen.token));
});

test('finish=deployed: verified с квитанцией, но карточка не закрыта', async (t) => {
  const { handle, ported, seen } = await isolated(t);
  const id = await task(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs();

  const res = await acceptHeld({
    attempt: attempt(id, epoch, { finish: 'deployed' }),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });

  assert.equal(res.outcome, 'verified');
  assert.equal(res.receipt.settle, 'deferred');
  assert.deepEqual(calls, { inspect: 2, local: 1, review: 1 });
  const after = await settled(handle, id);
  assert.equal(after.state, 'claimed', 'финальный native complete до выпуска не делается');
  assert.equal(after.result, null);
  // Живая аренда сохранена и принадлежит той же эпохе.
  assert.deepEqual(await boardPort.verifyHeld(id, epoch).then((h) => h.epoch), epoch);
  assert.equal(seen.claim, 1);
});

test('потерянная эпоха: отказ до runner/review/settle', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1780000000000 });
  const { handle, ported, seen } = await isolated(t);
  const id = await task(handle);
  const backendPort = nativeBoardPort(ported, { channel: 'pilot', lease: 30 });
  const { epoch } = await backendPort.claim(id);
  // Аренда истекла и карточку забрал другой: нативная эпоха больше не наша.
  t.mock.timers.tick(31_000);
  const taken = await handle.tasks.claim(id, { lease: 60 });
  assert.ok(taken.epoch > epoch);

  const journal = await tmpJournal();
  const { ports, calls } = stubs();
  const res = await acceptHeld({
    attempt: attempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: backendPort },
  });

  assert.equal(res.outcome, 'denied');
  assert.match(res.reason, /claim_not_held/);
  assert.deepEqual(calls, { inspect: 0, local: 0, review: 0 });
  assert.equal(seen.claim, 1, 'второй claim не берётся ради старых данных');
  const after = await settled(handle, id);
  assert.equal(after.state, 'claimed');
  assert.equal(after.result, null);
  // Журнал не содержит ни одного эффекта приёмки после отказа.
  const text = await journalText(journal);
  assert.ok(!text.includes('"intent","phase":"local"'));
  assert.ok(!text.includes('"phase":"review"'));
  assert.ok(!text.includes('"phase":"complete"'));
});

test('истечение во время локального теста запрещает запуск ревью', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1780000000000 });
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port } = await held(ported, id, 30);
  const fixture = stubs();
  const local = fixture.ports.local;
  fixture.ports.local = async (...args) => {
    const result = await local(...args);
    t.mock.timers.tick(3_601_000);
    return result;
  };
  const result = await acceptHeld({ attempt: attempt(id, epoch), submission: submission(id, epoch),
    policy: policy(id), journal: await tmpJournal(), ports: { ...fixture.ports, board: port } });
  assert.equal(result.outcome, 'denied');
  assert.match(result.reason, /claim_lost_before_review/);
  assert.equal(fixture.calls.review, 0);
});

test('чужая/подменённая эпоха в сдаче: отказ без эффектов', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs();
  const res = await acceptHeld({
    attempt: attempt(id, epoch),
    submission: submission(id, epoch + 1),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(res.outcome, 'denied');
  assert.equal(res.reason, 'epoch_mismatch');
  assert.deepEqual(calls, { inspect: 0, local: 0, review: 0 });
  assert.equal((await settled(handle, id)).state, 'claimed');
});

test('чужой BB-тред и старая сдача: отказ до runner', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port: boardPort } = await held(ported, id);

  for (const [mutate, reason] of [
    [(s) => ({ ...s, worker_thread_id: 'thr_other' }), 'worker_thread_mismatch'],
    [(s) => ({ ...s, attempt_id: 'att-0' }), 'attempt_mismatch'],
    [(s) => ({ ...s, task_id: '9' }), 'task_mismatch'],
    [(s) => ({ ...s, candidate_sha: 'abc' }), 'candidate_sha_not_full'],
    [(s) => ({ ...s, shell: 'rm -rf /' }), 'unexpected_field:shell'],
  ]) {
    const journal = await tmpJournal();
    const { ports, calls } = stubs();
    const res = await acceptHeld({
      attempt: attempt(id, epoch),
      submission: mutate(submission(id, epoch)),
      policy: policy(id),
      journal,
      ports: { ...ports, board: boardPort },
    });
    assert.equal(res.outcome, 'denied', `сдача ${reason}`);
    assert.equal(res.reason, reason);
    assert.deepEqual(calls, { inspect: 0, local: 0, review: 0 });
  }
  assert.equal((await settled(handle, id)).state, 'claimed');
});

test('красный runner: rework, аренда сохранена, ревью не запускалось', async (t) => {
  const { handle, ported, seen } = await isolated(t);
  const id = await task(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs({
    local: async (binding) => {
      calls.local++;
      return { sha: binding.candidate_sha, ok: false, evidence: 'checks.json', exit: 3 };
    },
  });
  const res = await acceptHeld({
    attempt: attempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });

  assert.equal(res.outcome, 'rework');
  assert.equal(res.reason, 'local_checks_failed');
  assert.equal(res.feedback.exit, 3);
  assert.equal(res.feedback.evidence, 'checks.json');
  assert.deepEqual(calls, { inspect: 1, local: 1, review: 0 });
  const after = await settled(handle, id);
  assert.equal(after.state, 'claimed', 'rework не освобождает и не закрывает карточку');
  assert.equal(after.result, null);
  assert.equal((await boardPort.verifyHeld(id, epoch)).epoch, epoch, 'та же нативная аренда жива');
  assert.equal(seen.claim, 1);
});

test('REVIEW_BLOCKED: rework с цитатой checkpoint, без закрытия', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs({
    review: async (binding) => {
      calls.review++;
      return {
        task: binding.task_id,
        sha: binding.candidate_sha,
        actual: { ...REVIEW_ROUTE },
        verdict: 'REVIEW_BLOCKED',
        checkpoint: 'deadbeef', excerpt: 'Expected native refusal, got an effect',
      };
    },
  });
  const res = await acceptHeld({
    attempt: attempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(res.outcome, 'rework');
  assert.match(res.reason, /review_verdict:REVIEW_BLOCKED/);
  assert.equal(res.feedback.checkpoint, 'deadbeef');
  assert.match(res.feedback.excerpt, /Expected native refusal/);
  assert.equal(calls.review, 1);
  assert.equal((await settled(handle, id)).state, 'claimed');
});

test('REVIEW_BLOCKED без возражения останавливает, а не возвращает на исправление', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port } = await held(ported, id);
  const { ports } = stubs({ review: async binding => ({ task: binding.task_id, sha: binding.candidate_sha,
    actual: REVIEW_ROUTE, verdict: 'REVIEW_BLOCKED', checkpoint: 'deadbeef', excerpt: '' }) });
  const result = await acceptHeld({ attempt: attempt(id, epoch), submission: submission(id, epoch),
    policy: policy(id), journal: await tmpJournal(), ports: { ...ports, board: port } });
  assert.equal(result.outcome, 'hold');
  assert.equal(result.reason, 'review_objection_missing');
  assert.equal((await settled(handle, id)).state, 'blocked');
});

test('ошибка среды — hold с видимым стопом, не «исправь код»', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs({
    local: async () => {
      calls.local++;
      throw new Error('docker daemon unavailable');
    },
  });
  const res = await acceptHeld({
    attempt: attempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(res.outcome, 'hold');
  assert.match(res.reason, /local_error/);
  assert.equal(calls.review, 0);
  const after = await settled(handle, id);
  assert.equal(after.state, 'blocked');
  assert.match(after.blocked.reason, /local_error/);
});

test('дрейф SHA после ревью — hold без complete', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports } = stubs();
  let inspected = 0;
  ports.inspect = async (binding) => {
    inspected++;
    const head = inspected > 1 ? CAND_B : binding.candidate_sha;
    return { head, clean: true, baseAncestor: true };
  };
  const res = await acceptHeld({
    attempt: attempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(res.outcome, 'hold');
  assert.match(res.reason, /head_mismatch/);
  assert.equal((await settled(handle, id)).state, 'blocked');
});

test('повтор той же сдачи не повторяет эффектов', async (t) => {
  const { handle, ported, seen } = await isolated(t);
  const id = await task(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs();
  const input = {
    attempt: attempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  };
  const first = await acceptHeld(input);
  assert.equal(first.outcome, 'verified');
  const second = await acceptHeld(input);
  assert.equal(second.outcome, 'verified');
  assert.equal(second.repeated, true);
  assert.deepEqual(calls, { inspect: 2, local: 1, review: 1 });
  assert.equal(seen.claim, 1);
});

test('ручной submit v1 остаётся совместимым', async (t) => {
  const { handle } = await isolated(t);
  const id = await task(handle, 'Manual v1 path');
  const journal = await tmpJournal();
  const { ports, calls } = stubs();
  const { accept } = await import('./acceptance.mjs');
  const handoff = {
    task_id: id,
    worker_thread_id: 'thr_fixture',
    base_sha: BASE,
    candidate_sha: CAND,
    worktree: '/tmp/wt',
    check_profile: 'pilot',
  };
  const res = await accept({
    handoff,
    policy: policy(id),
    journal,
    ports: { ...ports, board: nativeBoardPort(handle, { channel: 'pilot' }) },
  });
  assert.equal(res.outcome, 'completed');
  assert.deepEqual(calls, { inspect: 2, local: 1, review: 1 });
  const after = await settled(handle, id);
  assert.equal(after.state, 'completed');
  assert.equal(after.result.sha, CAND);
});

// --- Связка CandidateSubject и дрейф контракта ---

const REPO = 'darkfactory-vs1-fixture';
const TREE = 'c'.repeat(40);
const SPEC = 'a'.repeat(64);
const POL = 'b'.repeat(64);
const OTHER_256 = 'f'.repeat(64);

function contractAttempt(taskId, epoch, over = {}) {
  return attempt(taskId, epoch, {
    repo_id: REPO,
    tree_sha: TREE,
    spec_digest: SPEC,
    policy_digest: POL,
    fixtures_digest: null,
    ...over,
  });
}

function contractTask(handle, text = 'Synthetic subject acceptance') {
  return handle.tasks.create('pilot', { text, noSync: true, labels: {
    spec_digest: SPEC, policy_digest: POL, repo_id: REPO, profile_id: 'pilot', finish: 'verified',
  } }).then(({ task }) => task.id);
}

function expectedDigest() {
  return subjectDigest(buildSubject({
    kind: 'git_tree', repoId: REPO, baseSha: BASE, candidateSha: CAND, treeSha: TREE,
    specDigest: SPEC, policyDigest: POL, fixturesDigest: null, releaseTarget: { finish: 'verified' },
  }));
}

test('контракт приёмки связывает subject_digest с квитанцией, журналом и карточкой', async (t) => {
  const { handle, ported, seen } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs();

  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });

  const digest = expectedDigest();
  assert.equal(res.outcome, 'verified');
  assert.equal(res.receipt.subject_digest, digest, 'квитанция привязана к манифесту приёмки');
  const text = await journalText(journal);
  assert.ok(text.includes(`"subject_digest":"${digest}"`), 'журнал несёт subject_digest');
  assert.ok(!text.includes(seen.token), 'токен аренды по-прежнему не покидает адаптер');
  const after = await settled(handle, id);
  assert.equal(after.state, 'completed');
  const evidence = typeof after.result === 'string' ? JSON.parse(after.result) : after.result;
  assert.equal(evidence.subject_digest, digest, 'компактная квитанция Board.complete несёт subject_digest');
  assert.equal(evidence.sha, CAND);
  assert.deepEqual(calls, { inspect: 2, local: 1, review: 1 });
  assert.equal(seen.claim, 1);
});

test('Neon policy requires approved skills, independent Sol and an attested bound verdict', async t => {
  const { handle, ported } = await isolated(t);
  const cases = [
    { skills: undefined, reason: 'review_profile_not_approved' },
    { skills: ['worktree/evil'], reason: 'review_profile_not_approved' },
    { skills: ['logika'], executor: 'pi/openai/gpt-6.2-sol', reason: 'arbiter_family_not_independent' },
    { skills: ['logika'], legacyReceipt: true, reason: 'review_isolation_missing' },
    { skills: ['humanizer'] },
  ];
  for (const { skills, executor = 'acp-devin/swe-2-high', legacyReceipt, reason } of cases) {
    const id = await contractTask(handle);
    const { epoch, port: boardPort } = await held(ported, id);
    const journal = await tmpJournal();
    const review = { ...NEON_CRITIC, skills };
    const transcript = 'private provider transcript';
    await writeFile(path.join(journal, 'neon.json'), transcript, { mode: 0o600 });
    let reviewed = 0;
    const { ports } = stubs({ review: async binding => {
      reviewed++;
      assert.equal(binding.subject_digest, expectedDigest());
      return { task: id, sha: CAND, actual: NEON_CRITIC, verdict: 'REVIEW_OK', checkpoint: 'feed80ab',
        ...(!legacyReceipt && { isolation: NEON_ISOLATION, subject_digest: binding.subject_digest,
          transcript_file: 'neon.json', transcript_sha256: createHash('sha256').update(transcript).digest('hex') }) };
    } });
    const result = await acceptHeld({ attempt: contractAttempt(id, epoch, { executor }),
      submission: submission(id, epoch), policy: policy(id, { review, arbiter: SOL_ARBITER }),
      journal, ports: { ...ports, board: boardPort } });
    assert.equal(result.reason, reason);
    assert.equal(reviewed, !reason || legacyReceipt ? 1 : 0);
    assert.equal((await settled(handle, id)).state === 'completed', reason === undefined);
  }
});

test('ручной v1 без контракта остаётся без манифеста: subject_digest равен null', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports } = stubs();
  const res = await acceptHeld({
    attempt: attempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(res.outcome, 'verified');
  assert.equal(res.receipt.subject_digest, null);
});

test('дрейф spec_digest на карточке до seal отвергает кандидата без complete', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs();
  // Спека изменилась после claim: метка карточки больше не совпадает с закреплённым контрактом.
  await handle.label(id, { set: { spec_digest: OTHER_256 } });

  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });

  assert.equal(res.outcome, 'hold');
  assert.equal(res.reason, 'spec_digest_drift');
  assert.equal(calls.review, 1, 'проверки шли до seal, ревью уже выполнено');
  const after = await settled(handle, id);
  assert.equal(after.state, 'blocked', 'карточка видимо остановлена, не закрыта');
  assert.equal(after.result, null);
});

test('дрейф policy_digest на карточке и в политике останавливает до complete', async (t) => {
  for (const [name, prepare] of [
    ['policy_digest_drift', async () => ({ policy: { ...policy('x'), digest: OTHER_256 } })],
    ['policy_digest_drift', async (handle, id) => {
      await handle.label(id, { set: { policy_digest: OTHER_256 } });
      return { policy: policy('x') };
    }],
  ]) {
    const { handle, ported } = await isolated(t);
    const id = await contractTask(handle);
    const { epoch, port: boardPort } = await held(ported, id);
    const { policy: prepared } = await prepare(handle, id);
    const journal = await tmpJournal();
    const { ports } = stubs();
    const res = await acceptHeld({
      attempt: contractAttempt(id, epoch),
      submission: submission(id, epoch),
      policy: { ...prepared, profiles: policy(id).profiles },
      journal,
      ports: { ...ports, board: boardPort },
    });
    assert.equal(res.outcome, 'hold', name);
    assert.equal(res.reason, name);
    assert.equal((await settled(handle, id)).state, 'blocked');
  }
});

test('неполный контракт попытки отклоняется до любых эффектов', async (t) => {
  const { handle, ported, seen } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs();

  for (const over of [{ policy_digest: undefined }, { repo_id: undefined },
    { repo_id: REPO, tree_sha: TREE, spec_digest: SPEC, policy_digest: POL, fixtures_digest: OTHER_256 }]) {
    const bad = contractAttempt(id, epoch, over);
    if (over.fixtures_digest === OTHER_256) delete bad.spec_digest;
    const res = await acceptHeld({
      attempt: bad,
      submission: submission(id, epoch),
      policy: policy(id),
      journal: await tmpJournal(),
      ports: { ...ports, board: boardPort },
    });
    assert.equal(res.outcome, 'denied', `контракт ${JSON.stringify(over)}`);
    assert.equal(res.reason, 'subject_contract_incomplete');
    assert.deepEqual(calls, { inspect: 0, local: 0, review: 0 });
  }
  assert.equal((await settled(handle, id)).state, 'claimed');
  assert.equal(seen.claim, 1);
});

test('tree_sha берётся из реального снимка: контракт без tree_sha проходит приёмку', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { worktreeInspector } = await import('./runtime.mjs');
  const { mkdtemp } = await import('node:fs/promises');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = await mkdtemp(path.join(testRoot, 'repo-'));
  git(repo, 'init', '--initial-branch=pilot');
  await writeFile(path.join(repo, 'check.mjs'), 'process.exit(0);\n');
  git(repo, 'add', 'check.mjs');
  git(repo, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'Base');
  const base = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'check.mjs'), 'console.log("candidate"); process.exit(0);\n');
  git(repo, 'add', 'check.mjs');
  git(repo, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'Candidate');
  const candidate = git(repo, 'rev-parse', 'HEAD');
  const realTree = git(repo, 'rev-parse', `${candidate}^{tree}`);

  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs();
  const policyObject = policy(id, { worktree: repo, branch: 'pilot', base });

  // Инспектор возвращает дерево именно кандидата.
  const ins = await worktreeInspector(policyObject)({
    task_id: id, worker_thread_id: 'thr_fixture', base_sha: base, candidate_sha: candidate,
    worktree: repo, check_profile: 'pilot' });
  assert.equal(ins.tree, realTree);

  // Контракт без tree_sha: манифест достраивается на снимке, дрейфа нет.
  let inspected = 0;
  const realInspect = worktreeInspector(policyObject);
  const res = await acceptHeld({
    attempt: { ...contractAttempt(id, epoch), base_sha: base, worktree: repo, tree_sha: undefined },
    submission: { ...submission(id, epoch), candidate_sha: candidate },
    policy: policyObject,
    journal,
    ports: { ...ports, board: boardPort, inspect: async binding => {
      inspected++;
      return realInspect(binding);
    } },
  });
  assert.equal(res.outcome, 'verified', res.reason ?? '');
  const expected = subjectDigest(buildSubject({
    kind: 'git_tree', repoId: REPO, baseSha: base, candidateSha: candidate, treeSha: realTree,
    specDigest: SPEC, policyDigest: POL, fixturesDigest: null, releaseTarget: { finish: 'verified' },
  }));
  assert.equal(res.receipt.subject_digest, expected, 'subject_digest собран из реального дерева');
  assert.equal((await settled(handle, id)).state, 'completed');
  assert.deepEqual(calls, { inspect: 0, local: 1, review: 1 });
  assert.equal(inspected, 2, 'настоящий инспектор вызван до проверок и на seal');
});

test('закреплённый tree_sha, расходящийся со снимком, останавливает кандидата', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports } = stubs();
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch, { tree_sha: 'd'.repeat(40) }),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort,
      inspect: async () => ({ head: CAND, tree: TREE, clean: true, baseAncestor: true }) },
  });
  assert.equal(res.outcome, 'hold');
  assert.equal(res.reason, 'tree_sha_drift');
  assert.equal((await settled(handle, id)).state, 'blocked');
});

test('снимок без дерева и без закреплённого tree_sha не строит манифест', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports } = stubs();
  const res = await acceptHeld({
    attempt: { ...contractAttempt(id, epoch), tree_sha: undefined },
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort }, // заглушки без поля tree
  });
  assert.equal(res.outcome, 'hold');
  assert.equal(res.reason, 'subject_contract_incomplete');
  assert.equal((await settled(handle, id)).state, 'blocked');
});

test('verifyPinned: смена операторских входов во время L2 останавливает до complete', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs();
  let pinnedCalls = 0;
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort, verifyPinned: async () => {
      pinnedCalls++;
      throw new Error('Operator inputs changed during L2');
    } },
  });
  assert.equal(pinnedCalls, 1, 'проверка операторских входов выполнена на seal');
  assert.equal(res.outcome, 'hold');
  assert.equal(res.reason, 'policy_digest_drift');
  assert.equal(calls.review, 1, 'L2 успел пройти, complete не делался');
  assert.equal((await settled(handle, id)).state, 'blocked');
  assert.equal((await journalText(journal)).includes('"token":'), false,
    'токен аренды не попадает в журнал даже при стопе');
});

test('новый манифест при том же SHA не переиспользует терминальный вердикт журнала', async (t) => {
  const { handle, ported, seen } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs({
    local: async (binding) => {
      calls.local++;
      return { sha: binding.candidate_sha, ok: false, evidence: 'checks.json', exit: 3 };
    },
  });
  const first = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(first.outcome, 'rework');
  assert.equal(calls.local, 1);
  // Тот же SHA и эпоха, но спека изменилась: новый ключ запуска, проверки идут заново.
  const second = await acceptHeld({
    attempt: contractAttempt(id, epoch, { spec_digest: OTHER_256 }),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(second.outcome, 'rework');
  assert.equal(second.repeated, undefined, 'старый вердикт не переиспользован');
  assert.notEqual(second.run, first.run);
  assert.equal(calls.local, 2, 'локальные проверки выполнены заново для нового манифеста');
  const { readdir: listDir } = await import('node:fs/promises');
  assert.equal((await listDir(journal)).filter((name) => name.endsWith('.jsonl')).length, 2);
  assert.equal(seen.claim, 1);
});

test('компактная квитанция укладывается в 1000 символов при любом числе проверок', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports } = stubs();
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort, local: async (binding) => ({
      sha: binding.candidate_sha, ok: true,
      evidence: Array.from({ length: 6 }, (_, i) => ({
        file: `checks-${i}-${'x'.repeat(200)}.log`, sha256: 'e'.repeat(64), exit: 0 })),
    }) },
  });
  assert.equal(res.outcome, 'verified', res.reason ?? '');
  const after = await settled(handle, id);
  assert.equal(after.state, 'completed');
  const receipt = typeof after.result === 'string' ? JSON.parse(after.result) : after.result;
  assert.equal(JSON.stringify(receipt).length <= 1000, true, 'лимит Board.complete соблюдён');
  assert.equal(receipt.sha, CAND);
  assert.equal(receipt.subject_digest, expectedDigest());
  assert.equal(receipt.review.verdict, 'REVIEW_OK');
  assert.equal(receipt.review.checkpoint, 'feed80ab');
  assert.equal(receipt.checks.n, 6);
  assert.equal(receipt.checks.ok, true);
  assert.equal(receipt.run, res.run, 'карточка ссылается на полную квитанцию в журнале');
});

test('sameContract отличает смену контракта и ручной v1', async (t) => {
  const { _internals: { sameContract } } = await import('./acceptance.mjs');
  const run = { contract: { repo_id: REPO, tree_sha: TREE, spec_digest: SPEC, policy_digest: POL,
    fixtures_digest: null, release_target: null } };
  assert.equal(sameContract(run, contractAttempt('1', 1)), true);
  assert.equal(sameContract(run, contractAttempt('1', 1, { spec_digest: OTHER_256 })), false);
  assert.equal(sameContract(run, contractAttempt('1', 1, { fixtures_digest: OTHER_256 })), false);
  assert.equal(sameContract({ contract: null }, contractAttempt('1', 1)), false, 'запись без контракта');
  assert.equal(sameContract(run, attempt('1', 1)), true, 'ручной v1 без контракта всегда совместим');
  assert.equal(sameContract(run, contractAttempt('1', 1, { release_target: { finish: 'deployed' } })), false);
  assert.equal(sameContract(run, contractAttempt('1', 1, { tree_sha: 'e'.repeat(40) })), false, 'другое дерево');
});

test('seal сверяет дрейф repo_id, profile_id, finish и fixtures_digest', async (t) => {
  for (const [label, value, reason] of [
    ['repo_id', 'other-repo', 'repo_id_drift'],
    ['profile_id', 'other-profile', 'profile_id_drift'],
    ['finish', 'deployed', 'finish_drift'],
  ]) {
    const { handle, ported } = await isolated(t);
    const id = await contractTask(handle);
    const { epoch, port: boardPort } = await held(ported, id);
    await handle.label(id, { set: { [label]: value } });
    const journal = await tmpJournal();
    const { ports } = stubs();
    const res = await acceptHeld({
      attempt: contractAttempt(id, epoch),
      submission: submission(id, epoch),
      policy: policy(id),
      journal,
      ports: { ...ports, board: boardPort },
    });
    assert.equal(res.outcome, 'hold', label);
    assert.equal(res.reason, reason);
    assert.equal((await settled(handle, id)).state, 'blocked');
  }
  // fixtures_digest: закреплён null, метка появилась со значением — дрейф.
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  await handle.label(id, { set: { fixtures_digest: OTHER_256 } });
  const journal = await tmpJournal();
  const { ports } = stubs();
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(res.outcome, 'hold');
  assert.equal(res.reason, 'fixtures_digest_drift');
  assert.equal((await settled(handle, id)).state, 'blocked');
});

test('повтор с другим закреплённым tree_sha не переиспользует вердикт журнала', async (t) => {
  const { handle, ported, seen } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs();
  const redLocal = async (binding) => {
    calls.local++;
    return { sha: binding.candidate_sha, ok: false, evidence: 'checks.json', exit: 3 };
  };
  const first = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort, local: redLocal },
  });
  assert.equal(first.outcome, 'rework', 'первый прогон красный: аренда остаётся живой');
  assert.equal(calls.local, 1);
  const second = await acceptHeld({
    attempt: contractAttempt(id, epoch, { tree_sha: 'e'.repeat(40) }),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort, local: redLocal },
  });
  assert.equal(second.outcome, 'rework');
  assert.equal(second.repeated, undefined, 'вердикт для другого дерева не переиспользован');
  assert.notEqual(second.run, first.run);
  assert.equal(calls.local, 2, 'проверки выполнены заново для нового закреплённого дерева');
  assert.equal(seen.claim, 1);
});

test('журнал без записи run не возвращает старый исход', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs();
  // Готовим файл запуска с тем же ключом, но без записи run — только intent complete.
  const probe = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(probe.outcome, 'verified');
  const { readFile, writeFile, readdir } = await import('node:fs/promises');
  const files = (await readdir(journal)).filter((name) => name.endsWith('.jsonl'));
  const runFile = path.join(journal, files[0]);
  const lines = (await readFile(runFile, 'utf8')).split('\n').filter(Boolean)
    .filter((line) => !line.includes('"kind":"run"'));
  await writeFile(runFile, lines.join('\n') + '\n');
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(res.outcome, 'uncertain');
  assert.equal(res.reason, 'journal_run_entry_missing');
  assert.equal(calls.claim ?? 0, 0);
});

test('компактная квитанция ужимается при 20 проверках с длинными именами логов', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports } = stubs();
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort, local: async (binding) => ({
      sha: binding.candidate_sha, ok: true,
      evidence: Array.from({ length: 20 }, (_, i) => ({
        file: `checks-${i}-${'y'.repeat(220)}.${i}.log`, sha256: 'e'.repeat(64), exit: 0 })),
    }) },
  });
  assert.equal(res.outcome, 'verified', res.reason ?? '');
  const after = await settled(handle, id);
  assert.equal(after.state, 'completed');
  const receipt = typeof after.result === 'string' ? JSON.parse(after.result) : after.result;
  const text = JSON.stringify(receipt);
  assert.equal(text.length <= 1000, true, `лимит Board.complete: ${text.length}`);
  assert.equal(receipt.sha, CAND);
  assert.equal(receipt.subject_digest, expectedDigest());
  assert.equal(receipt.checks.n, 20);
  assert.equal(receipt.checks.ok, true);
  assert.equal(receipt.review.verdict, 'REVIEW_OK');
  assert.equal(receipt.review.checkpoint, 'feed80ab');
  assert.equal(receipt.run, res.run);
});

test('появившаяся при L2 метка fixtures_digest останавливает контракт без фикстур', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports, calls } = stubs();
  // Контракт не закрепляет fixtures_digest (undefined): манифест фиксирует null.
  const attemptNoFixtures = contractAttempt(id, epoch);
  delete attemptNoFixtures.fixtures_digest;
  // Во время L2 на карточке появилась метка фикстур — seal обязан остановить кандидата.
  await handle.label(id, { set: { fixtures_digest: OTHER_256 } });
  const res = await acceptHeld({
    attempt: attemptNoFixtures,
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(res.outcome, 'hold');
  assert.equal(res.reason, 'fixtures_digest_drift');
  assert.equal(calls.review, 1, 'L2 прошёл, complete не делался');
  assert.equal((await settled(handle, id)).state, 'blocked');
});

test('JSON null и примитивы в журнале не роняют чтение и не переиспользуют вердикт', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports } = stubs();
  const first = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(first.outcome, 'verified');
  const { readFile, writeFile, readdir } = await import('node:fs/promises');
  const runFile = path.join(journal,
    (await readdir(journal)).find((name) => name.endsWith('.jsonl')));

  // (a) Запись run заменена на литерал null: исход не подтверждается.
  const lines = (await readFile(runFile, 'utf8')).split('\n').filter(Boolean);
  const withoutRun = lines.filter((line) => !line.includes('"kind":"run"'));
  await writeFile(runFile, ['null', '7', ...withoutRun].join('\n') + '\n');
  const noRun = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(noRun.outcome, 'uncertain');
  assert.equal(noRun.reason, 'journal_run_entry_missing');
  assert.equal(noRun.repeated, true);

  // (b) Запись run на месте, но между ней и исходом появилась порченая строка null:
  // старый терминальный исход не возвращается, журнал несогласован.
  await writeFile(runFile, [lines[0], 'null', ...lines.slice(1)].join('\n') + '\n');
  const corrupted = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(corrupted.outcome, 'uncertain');
  assert.equal(corrupted.reason, 'interrupted_run');
  assert.notEqual(corrupted.receipt?.settle, 'completed', 'вердикт старого запуска не возвращается');
});

// --- L1 tamper-gate и L3 визуальный UI-гейт ---

test('красный tamper-gate: rework с нарушениями, 0 вызовов L3 и L2, аренда жива', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  const gateCalls = { tamper: 0, visual: 0 };
  const res = await acceptHeld({
    attempt: attempt(id, epoch, { has_ui: true }),
    submission: submission(id, epoch),
    policy: policy(id, { has_ui: true }),
    journal: await tmpJournal(),
    ports: { ...ports, board: port,
      tamper: async (binding) => {
        gateCalls.tamper++;
        return { ok: false, sha: binding.candidate_sha, base_sha: BASE,
          violations: [{ kind: 'secret_leak', file: 'src/app.js', line: 3, detail: 'github_token' }],
          digest: 'd'.repeat(64) };
      },
      visual: async () => { gateCalls.visual++; throw new Error('unreachable'); } },
  });
  assert.equal(res.outcome, 'rework');
  assert.equal(res.reason, 'tamper_gate_failed');
  assert.equal(res.feedback.violations[0].kind, 'secret_leak');
  assert.equal(res.feedback.digest, 'd'.repeat(64));
  assert.deepEqual(gateCalls, { tamper: 1, visual: 0 });
  assert.equal(calls.review, 0);
  const after = await settled(handle, id);
  assert.equal(after.state, 'claimed');
  assert.equal(after.result, null);
  assert.equal((await port.verifyHeld(id, epoch)).epoch, epoch, 'та же аренда остаётся живой');
});

test('has_ui: красный L3 — rework с артефактом и дефектом, 0 вызовов L2', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  const artifact = { name: 'shot-broken.png', sha256: 'e'.repeat(64), bytes: 42 };
  const res = await acceptHeld({
    attempt: attempt(id, epoch, { has_ui: true }),
    submission: submission(id, epoch),
    policy: policy(id, { has_ui: true }),
    journal: await tmpJournal(),
    ports: { ...ports, board: port,
      visual: async (binding) => ({
        ok: false, status: 'fail', sha: binding.candidate_sha,
        artifacts: [artifact], evidence: { file: 'visual.log', sha256: 'f'.repeat(64), exit: 2 },
      }) },
  });
  assert.equal(res.outcome, 'rework');
  assert.equal(res.reason, 'visual_gate_failed');
  assert.equal(res.feedback.status, 'fail');
  assert.deepEqual(res.feedback.artifacts, [artifact]);
  assert.equal(calls.review, 0);
  const after = await settled(handle, id);
  assert.equal(after.state, 'claimed');
  assert.equal((await port.verifyHeld(id, epoch)).epoch, epoch);
});

test('has_ui: зелёный L3 — L2 вызывается, компактная квитанция несёт pass и хэш артефактов', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  const gateCalls = { tamper: 0, visual: 0 };
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch, { has_ui: true }),
    submission: submission(id, epoch),
    policy: policy(id, { has_ui: true }),
    journal: await tmpJournal(),
    ports: { ...ports, board: port,
      tamper: async (binding) => {
        gateCalls.tamper++;
        return { ok: true, sha: binding.candidate_sha, base_sha: BASE,
          violations: [], digest: 'c'.repeat(64) };
      },
      visual: async (binding) => {
        gateCalls.visual++;
        return { ok: true, status: 'pass', sha: binding.candidate_sha,
          artifacts: [{ name: 'shot.png', sha256: 'e'.repeat(64), bytes: 42 }],
          evidence: { file: 'visual.log', sha256: 'f'.repeat(64), exit: 0 } };
      } },
  });
  assert.equal(res.outcome, 'verified', res.reason ?? '');
  assert.deepEqual(gateCalls, { tamper: 1, visual: 1 });
  assert.equal(calls.review, 1);
  const after = await settled(handle, id);
  assert.equal(after.state, 'completed');
  const receipt = after.result;
  const text = JSON.stringify(receipt);
  assert.equal(text.length <= 1000, true, `лимит Board.complete: ${text.length}`);
  assert.equal(receipt.tamper, 'pass');
  assert.equal(receipt.visual.status, 'pass');
  assert.equal(receipt.visual.n, 1);
  assert.match(receipt.visual.sha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.subject_digest, expectedDigest());
});

test('has_ui: false/отсутствует — порт visual не вызывается, квитанция фиксирует na', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  let visual = 0;
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal: await tmpJournal(),
    ports: { ...ports, board: port,
      visual: async () => { visual++; throw new Error('unreachable'); } },
  });
  assert.equal(res.outcome, 'verified', res.reason ?? '');
  assert.equal(visual, 0);
  assert.equal(calls.review, 1);
  const after = await settled(handle, id);
  assert.equal(after.state, 'completed');
  assert.equal(after.result.visual.status, 'na');
  assert.equal(after.result.tamper, 'pass');
});

test('has_ui без подключённого порта visual — операционный hold, не слепой пропуск', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  const res = await acceptHeld({
    attempt: attempt(id, epoch, { has_ui: true }),
    submission: submission(id, epoch),
    policy: policy(id, { has_ui: true }),
    journal: await tmpJournal(),
    ports: { ...ports, board: port },
  });
  assert.equal(res.outcome, 'hold');
  assert.equal(res.reason, 'visual_port_missing');
  assert.equal(calls.review, 0);
  assert.equal((await settled(handle, id)).state, 'blocked');
});

test('отсутствующий порт tamper при включённом гейте — hold до L3 и L2', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  delete ports.tamper;
  let visual = 0;
  const res = await acceptHeld({
    attempt: attempt(id, epoch, { has_ui: true }),
    submission: submission(id, epoch),
    policy: policy(id, { has_ui: true }),
    journal: await tmpJournal(),
    ports: { ...ports, board: port, visual: async () => { visual++; return {}; } },
  });
  assert.equal(res.outcome, 'hold');
  assert.equal(res.reason, 'tamper_port_missing');
  assert.equal(visual, 0);
  assert.equal(calls.review, 0);
  assert.equal((await settled(handle, id)).state, 'blocked');
});

test('профиль может явно отключить tamper-gate: проверки идут без порта', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  delete ports.tamper;
  const res = await acceptHeld({
    attempt: attempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id, { tamper: false }),
    journal: await tmpJournal(),
    ports: { ...ports, board: port },
  });
  assert.equal(res.outcome, 'verified', res.reason ?? '');
  assert.equal(calls.review, 1);
  const after = await settled(handle, id);
  assert.equal(after.result.tamper, 'na');
});

test('явное attempt.has_ui: false отключает L3 даже при has_ui в профиле', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  let visual = 0;
  const res = await acceptHeld({
    attempt: attempt(id, epoch, { has_ui: false }),
    submission: submission(id, epoch),
    policy: policy(id, { has_ui: true }),
    journal: await tmpJournal(),
    ports: { ...ports, board: port, visual: async () => { visual++; throw new Error('unreachable'); } },
  });
  assert.equal(res.outcome, 'verified', res.reason ?? '');
  assert.equal(visual, 0);
  assert.equal(calls.review, 1);
  const after = await settled(handle, id);
  assert.equal(after.result.visual.status, 'na');
});

test('неаттестованный зелёный L3 — hold, а не pass: sha, статус, артефакты, evidence обязательны', async (t) => {
  for (const [name, receipt] of [
    ['без артефактов', { ok: true, status: 'pass', artifacts: [], evidence: { exit: 0, file: 'v.log', sha256: 'f'.repeat(64) } }],
    ['чужой sha', { ok: true, status: 'pass', sha: 'd'.repeat(40), artifacts: [{ name: 'a.png', sha256: 'e'.repeat(64), bytes: 1 }], evidence: {} }],
    ['без status', { ok: true, artifacts: [{ name: 'a.png', sha256: 'e'.repeat(64), bytes: 1 }], evidence: {} }],
  ]) {
    const { handle, ported } = await isolated(t);
    const id = await task(handle);
    const { epoch, port } = await held(ported, id);
    const { ports, calls } = stubs();
    const res = await acceptHeld({
      attempt: attempt(id, epoch, { has_ui: true }),
      submission: submission(id, epoch),
      policy: policy(id, { has_ui: true }),
      journal: await tmpJournal(),
      ports: { ...ports, board: port, visual: async (binding) => ({ sha: binding.candidate_sha, ...receipt }) },
    });
    assert.equal(res.outcome, 'hold', name);
    assert.equal(res.reason, 'visual_receipt_invalid', name);
    assert.equal(calls.review, 0, name);
    assert.equal((await settled(handle, id)).state, 'blocked', name);
  }
});

test('ошибка запуска L3-runner — hold среды, не rework воркеру', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  const res = await acceptHeld({
    attempt: attempt(id, epoch, { has_ui: true }),
    submission: submission(id, epoch),
    policy: policy(id, { has_ui: true }),
    journal: await tmpJournal(),
    ports: { ...ports, board: port,
      visual: async () => { throw new Error('visual_runner_not_executed:Unable to find image'); } },
  });
  assert.equal(res.outcome, 'hold');
  assert.match(res.reason, /visual_error:visual_runner_not_executed/);
  assert.equal(calls.review, 0);
  assert.equal((await settled(handle, id)).state, 'blocked');
});

test('полная квитанция L3 с sha256 артефактов привязана к subject_digest в журнале', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port } = await held(ported, id);
  const { ports } = stubs();
  const artifact = { name: 'shot.png', sha256: 'e'.repeat(64), bytes: 42 };
  const journal = await tmpJournal();
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch, { has_ui: true }),
    submission: submission(id, epoch),
    policy: policy(id, { has_ui: true }),
    journal,
    ports: { ...ports, board: port,
      visual: async (binding) => ({ ok: true, status: 'pass', sha: binding.candidate_sha,
        artifacts: [artifact], evidence: { file: 'v.log', sha256: 'f'.repeat(64), exit: 0 } }) },
  });
  assert.equal(res.outcome, 'verified');
  assert.deepEqual(res.receipt.visual.artifacts, [artifact], 'полный VisualReceipt в квитанции');
  assert.equal(res.receipt.visual.evidence.sha256, 'f'.repeat(64));
  assert.equal(res.receipt.tamper.digest, 't'.repeat(64), 'полный tamper-отчёт в квитанции');
  assert.equal(res.receipt.subject_digest, expectedDigest(), 'квитанция привязана к манифесту');
  const text = await journalText(journal);
  assert.ok(text.includes(artifact.sha256), 'журнал несёт sha256 артефакта L3');
});

test('смена has_ui при том же SHA не переиспользует терминальный вердикт', async (t) => {
  const { handle, ported, seen } = await isolated(t);
  const id = await contractTask(handle);
  await handle.label(id, { set: { finish: 'deployed' } });
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  const journal = await tmpJournal();
  let visual = 0;
  // finish=deployed: первая приёмка откладывает complete, аренда живёт для второй.
  const run = (hasUi) => acceptHeld({
    attempt: contractAttempt(id, epoch, { has_ui: hasUi, finish: 'deployed' }),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: port,
      visual: async (binding) => {
        visual++;
        return { ok: true, status: 'pass', sha: binding.candidate_sha,
          artifacts: [{ name: 'a.png', sha256: 'e'.repeat(64), bytes: 1 }], evidence: { exit: 0, file: 'v.log', sha256: 'f'.repeat(64) } };
      } },
  });
  const first = await run(false);
  assert.equal(first.outcome, 'verified');
  assert.equal(visual, 0);
  const second = await run(true);
  assert.equal(second.outcome, 'verified');
  assert.equal(second.repeated, undefined, 'вердикт без L3 не переиспользован для UI-попытки');
  assert.notEqual(second.run, first.run);
  assert.equal(visual, 1, 'L3 выполнен для нового требования');
  assert.equal(calls.review, 2, 'ревью повторено для нового манифеста');
  assert.equal(seen.claim, 1);
});

test('длинная policy.version отклоняется до любых эффектов', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  const res = await acceptHeld({
    attempt: attempt(id, epoch),
    submission: submission(id, epoch),
    policy: { ...policy(id), version: 'v'.repeat(2000) },
    journal: await tmpJournal(),
    ports: { ...ports, board: port },
  });
  assert.equal(res.outcome, 'denied');
  assert.equal(res.reason, 'policy_version_too_long');
  assert.deepEqual(calls, { inspect: 0, local: 0, review: 0 });
});

test('collectVisualArtifacts: лимиты по числу и объёму, symlink не считается файлом', async (t) => {
  const { collectVisualArtifacts } = await import('./runtime.mjs');
  const { symlink } = await import('node:fs/promises');
  const dropped = await mkdtemp(path.join(testRoot, 'dropped-'));
  const journal = await tmpJournal();
  const binding = { task_id: '1', candidate_sha: CAND };
  await writeFile(path.join(dropped, 'ok.txt'), 'artifact');
  await symlink('ok.txt', path.join(dropped, 'link.txt'));
  const artifacts = await collectVisualArtifacts(dropped, journal, binding);
  assert.equal(artifacts.length, 1, 'symlink пропущен');
  assert.equal(artifacts[0].sha256.length, 64);
  const stored = await readFile(path.join(journal, artifacts[0].name), 'utf8');
  assert.equal(stored, 'artifact', 'байты артефакта сохранены в приватный журнал');

  const overFile = await mkdtemp(path.join(testRoot, 'dropped-'));
  await writeFile(path.join(overFile, 'big.bin'), Buffer.alloc(9 * 1024 * 1024));
  await assert.rejects(() => collectVisualArtifacts(overFile, journal, binding), /limits/);

  const overCount = await mkdtemp(path.join(testRoot, 'dropped-'));
  for (let i = 0; i < 65; i++) await writeFile(path.join(overCount, `a${i}.txt`), 'x');
  await assert.rejects(() => collectVisualArtifacts(overCount, journal, binding), /limits/);
});

test('артефакт в 0 байт и пустое evidence не аттестуют зелёный L3', async (t) => {
  for (const [name, receipt] of [
    ['нулевой артефакт', { ok: true, status: 'pass',
      artifacts: [{ name: 'a.png', sha256: 'e'.repeat(64), bytes: 0 }], evidence: { exit: 0, file: 'v.log', sha256: 'f'.repeat(64) } }],
    ['пустое evidence', { ok: true, status: 'pass',
      artifacts: [{ name: 'a.png', sha256: 'e'.repeat(64), bytes: 1 }], evidence: {} }],
  ]) {
    const { handle, ported } = await isolated(t);
    const id = await task(handle);
    const { epoch, port } = await held(ported, id);
    const { ports, calls } = stubs();
    const res = await acceptHeld({
      attempt: attempt(id, epoch, { has_ui: true }),
      submission: submission(id, epoch),
      policy: policy(id, { has_ui: true }),
      journal: await tmpJournal(),
      ports: { ...ports, board: port,
        visual: async (binding) => ({ sha: binding.candidate_sha, ...receipt }) },
    });
    assert.equal(res.outcome, 'hold', name);
    assert.equal(res.reason, 'visual_receipt_invalid', name);
    assert.equal(calls.review, 0, name);
    assert.equal((await settled(handle, id)).state, 'blocked', name);
  }
});

test('has_ui: false затем отсутствие поля при has_ui в профиле — L3 выполняется заново', async (t) => {
  const { handle, ported, seen } = await isolated(t);
  const id = await contractTask(handle);
  await handle.label(id, { set: { finish: 'deployed' } });
  const { epoch, port } = await held(ported, id);
  const { ports } = stubs();
  const journal = await tmpJournal();
  let visual = 0;
  const extra = {
    visual: async (binding) => {
      visual++;
      return { ok: true, status: 'pass', sha: binding.candidate_sha,
        artifacts: [{ name: 'a.png', sha256: 'e'.repeat(64), bytes: 1 }], evidence: { exit: 0, file: 'v.log', sha256: 'f'.repeat(64) } };
    },
  };
  const first = await acceptHeld({
    attempt: contractAttempt(id, epoch, { has_ui: false, finish: 'deployed' }),
    submission: submission(id, epoch),
    policy: policy(id, { has_ui: true }),
    journal,
    ports: { ...ports, board: port, ...extra },
  });
  assert.equal(first.outcome, 'verified');
  assert.equal(visual, 0, 'явное has_ui:false отключает гейт');
  const attemptNoFlag = contractAttempt(id, epoch, { finish: 'deployed' });
  const second = await acceptHeld({
    attempt: attemptNoFlag,
    submission: submission(id, epoch),
    policy: policy(id, { has_ui: true }),
    journal,
    ports: { ...ports, board: port, ...extra },
  });
  assert.equal(second.outcome, 'verified');
  assert.equal(second.repeated, undefined, 'вердикт с na не переиспользован при смене требования L3');
  assert.notEqual(second.run, first.run);
  assert.equal(visual, 1, 'L3 выполнен для попытки без явного has_ui');
  assert.equal(seen.claim, 1);
});

test('длинный bb_thread_id отклоняется до любых проверок', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  const res = await acceptHeld({
    attempt: attempt(id, epoch, { bb_thread_id: `thr_${'x'.repeat(200)}` }),
    submission: submission(id, epoch, { worker_thread_id: `thr_${'x'.repeat(200)}` }),
    policy: policy(id, { worker: `thr_${'x'.repeat(200)}` }),
    journal: await tmpJournal(),
    ports: { ...ports, board: port },
  });
  assert.equal(res.outcome, 'denied');
  assert.equal(res.reason, 'invalid_worker_thread');
  assert.deepEqual(calls, { inspect: 0, local: 0, review: 0 });
});

test('максимально длинный составной ключ: журнал ограничен, квитанция <= 1000', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port } = await held(ported, id);
  const { ports, calls } = stubs();
  const journal = await tmpJournal();
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch, { attempt_id: `att-${'a'.repeat(60)}` }),
    submission: submission(id, epoch, { attempt_id: `att-${'a'.repeat(60)}` }),
    policy: { ...policy(id), version: 'v'.repeat(64) },
    journal,
    ports: { ...ports, board: port },
  });
  assert.equal(res.outcome, 'verified', res.reason ?? '');
  assert.equal(calls.review, 1);
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(journal)).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  assert.equal(files[0].length <= 255, true, `имя журнала ограничено ФС: ${files[0]}`);
  const after = await settled(handle, id);
  assert.equal(after.state, 'completed');
  assert.equal(JSON.stringify(after.result).length <= 1000, true);
});

test('зелёный L3 с evidence.exit!==0 или [null] — hold до L2', async (t) => {
  for (const [name, evidence] of [
    ['exit: 1', { exit: 1, file: 'v.log', sha256: 'f'.repeat(64) }],
    ['массив [null]', [null]],
  ]) {
    const { handle, ported } = await isolated(t);
    const id = await task(handle);
    const { epoch, port } = await held(ported, id);
    const { ports, calls } = stubs();
    const res = await acceptHeld({
      attempt: attempt(id, epoch, { has_ui: true }),
      submission: submission(id, epoch),
      policy: policy(id, { has_ui: true }),
      journal: await tmpJournal(),
      ports: { ...ports, board: port, visual: async (binding) => ({
        ok: true, status: 'pass', sha: binding.candidate_sha,
        artifacts: [{ name: 'a.png', sha256: 'e'.repeat(64), bytes: 4 }], evidence }) },
    });
    assert.equal(res.outcome, 'hold', name);
    assert.equal(res.reason, 'visual_receipt_invalid', name);
    assert.equal(calls.review, 0, name);
  }
});

test('без манифеста: (v1, has_ui:false) и (v1-u0, без has_ui) — разные запуски, L3 выполняется', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  await handle.label(id, { set: { finish: 'deployed' } });
  const { epoch, port } = await held(ported, id);
  const journal = await tmpJournal();
  const run = (version, hasUi, visual) => {
    const { ports } = stubs();
    return acceptHeld({
      attempt: attempt(id, epoch, { has_ui: hasUi, finish: 'deployed' }),
      submission: submission(id, epoch),
      policy: { ...policy(id, { has_ui: true }), version },
      journal,
      ports: { ...ports, board: port, ...(visual ? { visual } : {}) },
    });
  };
  // Старый ключ 'run-…-vv1-u0' совпадал бы с 'run-…-vv1-u0' версии 'v1-u0'.
  const first = await run('v1', false);
  assert.equal(first.outcome, 'verified');
  let visualCalls = 0;
  const second = await run('v1-u0', undefined, async (binding) => {
    visualCalls++;
    return { ok: true, status: 'pass', sha: binding.candidate_sha,
      artifacts: [{ name: 'a.png', sha256: 'e'.repeat(64), bytes: 3 }],
      evidence: { exit: 0, file: 'v.log', sha256: 'f'.repeat(64) } };
  });
  assert.equal(visualCalls, 1, 'L3 выполнен для нового эффективного требования');
  assert.equal(second.outcome, 'verified');
  assert.notEqual(second.run, first.run, 'коллизия ключа устранена хэшем кортежа');
});

test('L3 evidence: экземпляр класса и разреженный массив — hold до L2', async (t) => {
  class Evidence {}
  const forged = Object.assign(new Evidence(), {
    exit: 0, file: 'v.log', sha256: 'f'.repeat(64) });
  for (const [name, evidence] of [
    ['экземпляр класса', forged],
    ['sparse-массив', new Array(2)],
  ]) {
    const { handle, ported } = await isolated(t);
    const id = await task(handle);
    const { epoch, port } = await held(ported, id);
    const { ports, calls } = stubs();
    const res = await acceptHeld({
      attempt: attempt(id, epoch, { has_ui: true }),
      submission: submission(id, epoch),
      policy: policy(id, { has_ui: true }),
      journal: await tmpJournal(),
      ports: { ...ports, board: port, visual: async (binding) => ({
        ok: true, status: 'pass', sha: binding.candidate_sha,
        artifacts: [{ name: 'a.png', sha256: 'e'.repeat(64), bytes: 4 }], evidence }) },
    });
    assert.equal(res.outcome, 'hold', name);
    assert.equal(res.reason, 'visual_receipt_invalid', name);
    assert.equal(calls.review, 0, name);
  }
});

test('evidence-массив валидных записей принимается', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port } = await held(ported, id);
  const { ports } = stubs();
  const ev = () => ({ exit: 0, file: 'v.log', sha256: 'f'.repeat(64) });
  const res = await acceptHeld({
    attempt: attempt(id, epoch, { has_ui: true }),
    submission: submission(id, epoch),
    policy: policy(id, { has_ui: true }),
    journal: await tmpJournal(),
    ports: { ...ports, board: port, visual: async (binding) => ({
      ok: true, status: 'pass', sha: binding.candidate_sha,
      artifacts: [{ name: 'a.png', sha256: 'e'.repeat(64), bytes: 4 }],
      evidence: [ev(), ev()] }) },
  });
  assert.equal(res.outcome, 'verified', res.reason ?? '');
});

test('числовая и строковая policy.version — разные запуски без journal_subject_mismatch', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  await handle.label(id, { set: { finish: 'deployed' } });
  const { epoch, port } = await held(ported, id);
  const journal = await tmpJournal();
  const run = (version) => {
    const { ports } = stubs();
    return acceptHeld({
      attempt: attempt(id, epoch, { finish: 'deployed' }),
      submission: submission(id, epoch),
      policy: { ...policy(id), version },
      journal,
      ports: { ...ports, board: port },
    });
  };
  const first = await run(1);
  assert.equal(first.outcome, 'verified');
  const second = await run('1');
  assert.equal(second.outcome, 'verified');
  assert.notEqual(second.run, first.run);
});

// --- Арбитрованное принятие: sealAndComplete выдаётся только для L2-ревью
// при готовом манифесте и требует строго валидную квитанцию арбитра ---

// Аттестованный L2-возврат: как только квитанция несёт subject_digest/findings,
// требуется полный набор — изоляция docker-ro-v1 и реальный транскрипт в журнале.
const l2Blocked = (journal, over = {}) => async (binding) => {
  const transcript = JSON.stringify({ verdict: 'REVIEW_BLOCKED', sha: binding.candidate_sha });
  await writeFile(path.join(journal, 'l2-transcript.json'), transcript, { mode: 0o600 });
  return {
    task: binding.task_id,
    sha: binding.candidate_sha,
    actual: { ...REVIEW_ROUTE },
    verdict: 'REVIEW_BLOCKED',
    status: 'REWORK',
    checkpoint: 'deadbeef',
    subject_digest: expectedDigest(),
    isolation: 'docker-ro-v1',
    transcript_file: 'l2-transcript.json',
    transcript_sha256: createHash('sha256').update(transcript).digest('hex'),
    findings: [{ file: 'a.js', line: 3, expected: 'spec', actual: 'impl', freq: 1 }],
    ...over,
  };
};

const arbReceipt = (digest, over = {}) => ({
  kind: 'arbitration', decision: 'accept_with_notes', notes: 'minor note',
  subject_digest: digest, max_harm: 3, dod_violation: false,
  arbiter: { provider: 'google', model: 'gemini-4-neon' },
  ...over,
});

test('пункт 1: sealAndComplete только при review_verdict + манифест; валидная квитанция закрывает карточку', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports } = stubs({ review: l2Blocked(journal) });
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(res.outcome, 'rework');
  assert.equal(typeof res.sealAndComplete, 'function');
  assert.equal(res.tree_sha, TREE);
  const sealed = await res.sealAndComplete(arbReceipt(expectedDigest()));
  assert.equal(sealed.outcome, 'verified');
  assert.equal(sealed.receipt.settle, 'completed');
  const after = await settled(handle, id);
  assert.equal(after.state, 'completed');
  const evidence = typeof after.result === 'string' ? JSON.parse(after.result) : after.result;
  assert.equal(evidence.arbitration.decision, 'accept_with_notes');
});

test('пункт 1: sealAndComplete не выдаётся на детерминированных гейтах и без манифеста', async (t) => {
  // L1: local_checks_failed при контракте — rework без sealAndComplete.
  const a = await isolated(t);
  const idA = await contractTask(a.handle);
  const { epoch: eA, port: pA } = await held(a.ported, idA);
  const jA = await tmpJournal();
  const l1 = stubs({ local: async (binding) => {
    l1.calls.local++;
    return { sha: binding.candidate_sha, ok: false, evidence: 'checks.json', exit: 3 };
  } });
  const resA = await acceptHeld({
    attempt: contractAttempt(idA, eA), submission: submission(idA, eA),
    policy: policy(idA), journal: jA, ports: { ...l1.ports, board: pA },
  });
  assert.equal(resA.outcome, 'rework');
  assert.equal(resA.sealAndComplete, undefined, 'local_checks_failed не арбитрируется');
  // tamper_gate_failed — тоже без sealAndComplete.
  const b = await isolated(t);
  const idB = await contractTask(b.handle);
  const { epoch: eB, port: pB } = await held(b.ported, idB);
  const jB = await tmpJournal();
  const tp = stubs({ tamper: async (binding) => ({
    ok: false, sha: binding.candidate_sha, base_sha: binding.base_sha,
    violations: ['unexpected write'], digest: 't'.repeat(64) }) });
  const resB = await acceptHeld({
    attempt: contractAttempt(idB, eB), submission: submission(idB, eB),
    policy: policy(idB), journal: jB, ports: { ...tp.ports, board: pB },
  });
  assert.equal(resB.outcome, 'rework');
  assert.equal(resB.sealAndComplete, undefined, 'tamper_gate_failed не арбитрируется');
  // REVIEW_BLOCKED без манифеста (ручной v1) — callback не выдаётся.
  const c = await isolated(t);
  const idC = await task(c.handle);
  const { epoch: eC, port: pC } = await held(c.ported, idC);
  const jC = await tmpJournal();
  const rv = stubs({ review: l2Blocked(jC, { subject_digest: null }) });
  const resC = await acceptHeld({
    attempt: attempt(idC, eC), submission: submission(idC, eC),
    policy: policy(idC), journal: jC, ports: { ...rv.ports, board: pC },
  });
  assert.equal(resC.outcome, 'rework');
  assert.equal(resC.sealAndComplete, undefined, 'без манифеста арбитрованного принятия нет');
});

test('пункт 1: невалидная arbitration квитанция — hold без complete', async (t) => {
  const digest = expectedDigest();
  const cases = [
    ['без квитанции', undefined],
    ['не объект', 'text'],
    ['другое решение', arbReceipt(digest, { decision: 'directed_rework' })],
    ['пустые notes', arbReceipt(digest, { notes: ' ' })],
    ['harm>=10', arbReceipt(digest, { max_harm: 10 })],
    ['harm не число', arbReceipt(digest, { max_harm: 'high' })],
    ['dod_violation', arbReceipt(digest, { dod_violation: true })],
    ['чужой digest', arbReceipt('f'.repeat(64))],
    ['арбитр того же семейства', arbReceipt(digest, { arbiter: REVIEW_ROUTE })],
    ['неизвестный арбитр', arbReceipt(digest, { arbiter: { provider: 'x', model: 'y' } })],
    // Пункт 1 (ревью #3): экземпляр класса — не plain-объект.
    ['квитанция — экземпляр класса',
      Object.assign(new (class Receipt {})(), arbReceipt(digest))],
    // Пункт 1 (ревью #3): truthy небулево dod_violation отклоняется.
    ['dod_violation строкой', arbReceipt(digest, { dod_violation: 'yes' })],
    // Пункт 1 (ревью #3): arbiter обязан быть plain-объектом с provider+model.
    ['без арбитра', { ...arbReceipt(digest), arbiter: undefined }],
    ['арбитр null', arbReceipt(digest, { arbiter: null })],
    ['арбитр — экземпляр класса', arbReceipt(digest, {
      arbiter: Object.assign(new (class Arb {})(),
        { provider: 'google', model: 'gemini-4-neon' }) })],
    ['арбитр без model', arbReceipt(digest, { arbiter: { provider: 'google' } })],
  ];
  for (const [label, receipt] of cases) {
    const { handle, ported } = await isolated(t);
    const id = await contractTask(handle);
    const { epoch, port: boardPort } = await held(ported, id);
    const journal = await tmpJournal();
    const { ports } = stubs({ review: l2Blocked(journal) });
    const res = await acceptHeld({
      attempt: contractAttempt(id, epoch), submission: submission(id, epoch),
      policy: policy(id), journal, ports: { ...ports, board: boardPort },
    });
    const sealed = await res.sealAndComplete(receipt);
    assert.equal(sealed.outcome, 'hold', label);
    assert.equal(sealed.reason, 'invalid_arbitration_receipt', label);
    assert.equal((await settled(handle, id)).state, 'blocked', label);
  }
});

// Пункт 3: arbitration внутри compactEvidence — длинные notes ужимаются,
// итог гарантированно <= 1000 символов.
test('пункт 3: arbitration с notes 2000 символов укладывается в лимит квитанции', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports } = stubs({ review: l2Blocked(journal) });
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch), submission: submission(id, epoch),
    policy: policy(id), journal, ports: { ...ports, board: boardPort },
  });
  const sealed = await res.sealAndComplete(arbReceipt(expectedDigest(), {
    notes: 'n'.repeat(2000) }));
  assert.equal(sealed.outcome, 'verified');
  const after = await settled(handle, id);
  assert.equal(after.state, 'completed');
  const evidence = typeof after.result === 'string' ? JSON.parse(after.result) : after.result;
  assert.ok(JSON.stringify(evidence).length <= 1000, 'компактная квитанция <= 1000');
  assert.ok(evidence.arbitration.notes === undefined ||
    evidence.arbitration.notes.length < 2000, 'notes ужаты');
});

// Пункт 4: tree_sha из реальной инспекции на верхнем уровне и в квитанции —
// и с манифестом, и без него.
test('пункт 4: tree_sha из инспекции снимка в результате и квитанции', async (t) => {
  const INSPECTED = 'e'.repeat(40);
  const withTree = { head: CAND, clean: true, baseAncestor: true, tree_sha: INSPECTED, tree: INSPECTED };
  // С манифестом: закреплённое дерево совпадает со снимком.
  const a = await isolated(t);
  const idA = await contractTask(a.handle);
  const { epoch: eA, port: pA } = await held(a.ported, idA);
  const jA = await tmpJournal();
  const sA = stubs({ inspect: async () => withTree });
  const resA = await acceptHeld({
    attempt: contractAttempt(idA, eA, { tree_sha: INSPECTED }),
    submission: submission(idA, eA), policy: policy(idA), journal: jA,
    ports: { ...sA.ports, board: pA },
  });
  assert.equal(resA.outcome, 'verified');
  assert.equal(resA.tree_sha, INSPECTED);
  assert.equal(resA.receipt.tree_sha, INSPECTED);
  // Без манифеста (маршрут по taskId): tree_sha всё равно фиксируется.
  const b = await isolated(t);
  const idB = await task(b.handle);
  const { epoch: eB, port: pB } = await held(b.ported, idB);
  const jB = await tmpJournal();
  const sB = stubs({ inspect: async () => withTree });
  const resB = await acceptHeld({
    attempt: attempt(idB, eB), submission: submission(idB, eB),
    policy: policy(idB), journal: jB, ports: { ...sB.ports, board: pB },
  });
  assert.equal(resB.outcome, 'verified');
  assert.equal(resB.tree_sha, INSPECTED);
  assert.equal(resB.receipt.tree_sha, INSPECTED);
  assert.equal(resB.subject_digest, null);
});

// Пункт 9: исполнитель pi/opencode-go/deepseek-v4.1-flash проходит acceptHeld —
// единая таблица семейств, триада независима.
test('пункт 9: pi/deepseek-исполнитель проходит приёмку с независимой триадой', async (t) => {
  const { handle, ported } = await isolated(t);
  const id = await task(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const { ports } = stubs();
  const res = await acceptHeld({
    attempt: attempt(id, epoch, {
      executor: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' },
      arbiter: { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'high' },
    }),
    submission: submission(id, epoch),
    policy: policy(id),
    journal,
    ports: { ...ports, board: boardPort },
  });
  assert.equal(res.outcome, 'verified', res.reason ?? '');
});

// Пункт 4 (ревью #3): инспектор, возвращающий только { tree_sha } без { tree },
// тоже строит манифест и проходит seal; а при отказе inspectionProblem
// полученное дерево всё равно попадает в результат и квитанцию.
test('пункт 4: манифест из ins.tree_sha и дерево в результате даже при отказе инспекции', async (t) => {
  const TREE_SHA_ONLY = 'd'.repeat(40);
  const insOnly = { head: CAND, clean: true, baseAncestor: true, tree_sha: TREE_SHA_ONLY };
  // Контракт без закреплённого дерева: манифест достраивается из ins.tree_sha.
  const a = await isolated(t);
  const idA = await contractTask(a.handle);
  const { epoch: eA, port: pA } = await held(a.ported, idA);
  const jA = await tmpJournal();
  const sA = stubs({ inspect: async () => insOnly });
  const resA = await acceptHeld({
    attempt: contractAttempt(idA, eA, { tree_sha: undefined }),
    submission: submission(idA, eA), policy: policy(idA), journal: jA,
    ports: { ...sA.ports, board: pA },
  });
  assert.equal(resA.outcome, 'verified', resA.reason ?? '');
  assert.equal(resA.tree_sha, TREE_SHA_ONLY);
  assert.equal(resA.receipt.tree_sha, TREE_SHA_ONLY);
  const digestA = subjectDigest(buildSubject({
    kind: 'git_tree', repoId: REPO, baseSha: BASE, candidateSha: CAND,
    treeSha: TREE_SHA_ONLY, specDigest: SPEC, policyDigest: POL,
    fixturesDigest: null, releaseTarget: { finish: 'verified' } }));
  assert.equal(resA.subject_digest, digestA, 'манифест построен на ins.tree_sha');
  // Отказ инспекции (грязное дерево): hold, но полученный tree_sha — в записи.
  const b = await isolated(t);
  const idB = await task(b.handle);
  const { epoch: eB, port: pB } = await held(b.ported, idB);
  const jB = await tmpJournal();
  const sB = stubs({ inspect: async () => ({
    head: CAND, clean: false, baseAncestor: true, tree_sha: TREE_SHA_ONLY }) });
  const resB = await acceptHeld({
    attempt: attempt(idB, eB), submission: submission(idB, eB),
    policy: policy(idB), journal: jB,
    ports: { ...sB.ports, board: pB },
  });
  assert.equal(resB.outcome, 'hold');
  assert.equal(resB.tree_sha, TREE_SHA_ONLY, 'дерево снимка зафиксировано до отказа');
  assert.equal(resB.receipt.tree_sha, TREE_SHA_ONLY);
});

// --- VS-4.2 (#1263) r2: закреплённая routed триада в реальном acceptHeld ---

test('shadow: закреплённая триада Devin/Neon/Sol — acceptHeld принимает attempt.triad', async t => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const DEVIN = { provider: 'acp-devin', model: 'swe-2-high' };
  const transcript = 'private provider transcript';
  await writeFile(path.join(journal, 'neon.json'), transcript, { mode: 0o600 });
  const { ports, calls } = stubs();
  ports.review = async binding => {
    calls.review++;
    return { task: id, sha: CAND, actual: NEON_CRITIC, verdict: 'REVIEW_OK', checkpoint: 'feed80ab',
      isolation: NEON_ISOLATION, subject_digest: binding.subject_digest,
      transcript_file: 'neon.json',
      transcript_sha256: createHash('sha256').update(transcript).digest('hex') };
  };
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch, { executor: DEVIN,
      triad: { worker: DEVIN, critic: NEON_CRITIC, arbiter: SOL_ARBITER } }),
    submission: submission(id, epoch),
    policy: policy(id, { review: { ...NEON_CRITIC, skills: ['logika'] }, arbiter: SOL_ARBITER }),
    journal, ports: { ...ports, board: boardPort } });
  assert.equal(res.outcome, 'verified', res.reason);
  assert.deepEqual(calls, { inspect: 2, local: 1, review: 1 });
  // Неполная/битая триада — отказ до любых эффектов.
  const idB = await contractTask(handle);
  const { epoch: epochB, port: portB } = await held(ported, idB);
  const denied = await acceptHeld({
    attempt: contractAttempt(idB, epochB,
      { triad: { worker: DEVIN, critic: NEON_CRITIC } }),
    submission: submission(idB, epochB),
    policy: policy(idB, { review: { ...NEON_CRITIC, skills: ['logika'] }, arbiter: SOL_ARBITER }),
    journal: await tmpJournal(), ports: { ...stubs().ports, board: portB } });
  assert.equal(denied.outcome, 'denied');
  assert.equal(denied.reason, 'invalid_triad');
});

test('active: routed Devin/DeepSeek/Neon — закреплённый routed-критик проходит политику', async t => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const journal = await tmpJournal();
  const DEVIN = { provider: 'acp-devin', model: 'swe-2-high' };
  // Закреплённый критик — worker-формат pi-харнесса; ревью-профиль несёт
  // runner-форму {provider:'deepseek'}, как в verify run-isolated.
  const DS_CRITIC = { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' };
  const RUNNER_CRITIC = { provider: 'deepseek', model: 'deepseek-v4.1-flash',
    reasoningLevel: 'medium' };
  const NEON = { provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'medium' };
  const transcript = 'private provider transcript';
  await writeFile(path.join(journal, 'critic.json'), transcript, { mode: 0o600 });
  const { ports, calls } = stubs();
  ports.review = async binding => {
    calls.review++;
    assert.equal(binding.subject_digest, expectedDigest());
    return { task: id, sha: CAND, actual: RUNNER_CRITIC, verdict: 'REVIEW_OK',
      checkpoint: 'feed80ab', isolation: 'docker-ro-v1',
      subject_digest: binding.subject_digest, transcript_file: 'critic.json',
      transcript_sha256: createHash('sha256').update(transcript).digest('hex') };
  };
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch, { executor: DEVIN,
      triad: { worker: DEVIN, critic: DS_CRITIC, arbiter: NEON } }),
    submission: submission(id, epoch),
    policy: policy(id, { review: { ...RUNNER_CRITIC, requireAttestation: true },
      arbiter: NEON }),
    journal, ports: { ...ports, board: boardPort } });
  assert.equal(res.outcome, 'verified', res.reason);
  assert.deepEqual(calls, { inspect: 2, local: 1, review: 1 });

  // Триада из трёх Neon — отказ до порта Board.
  const idB = await contractTask(handle);
  const { epoch: eB, port: pB } = await held(ported, idB);
  const same = await acceptHeld({
    attempt: contractAttempt(idB, eB, { executor: NEON,
      triad: { worker: NEON, critic: NEON, arbiter: NEON } }),
    submission: submission(idB, eB),
    policy: policy(idB, { review: { ...NEON, skills: ['logika'] }, arbiter: NEON }),
    journal: await tmpJournal(), ports: { ...stubs().ports, board: pB } });
  assert.equal(same.outcome, 'denied');
  assert.match(same.reason, /^invalid_triad/);

  // Триада, не совпадающая с критиком профиля — triad_mismatch.
  const idC = await contractTask(handle);
  const { epoch: eC, port: pC } = await held(ported, idC);
  const mismatch = await acceptHeld({
    attempt: contractAttempt(idC, eC, { executor: DEVIN,
      triad: { worker: DEVIN, critic: NEON, arbiter: SOL_ARBITER } }),
    submission: submission(idC, eC),
    policy: policy(idC, { review: { ...RUNNER_CRITIC, requireAttestation: true },
      arbiter: NEON }),
    journal: await tmpJournal(), ports: { ...stubs().ports, board: pC } });
  assert.equal(mismatch.outcome, 'denied');
  assert.equal(mismatch.reason, 'triad_mismatch');
});

test('Neon с нестандартным reasoningLevel не обходит skills-гейт routed-веткой', async t => {
  const { handle, ported } = await isolated(t);
  const id = await contractTask(handle);
  const { epoch, port: boardPort } = await held(ported, id);
  const { ports } = stubs();
  // google-модель с другим reasoningLevel и без skills — ни neon-ветка,
  // ни routed-допуск её не пускают.
  const res = await acceptHeld({
    attempt: contractAttempt(id, epoch,
      { executor: { provider: 'acp-devin', model: 'swe-2-high' } }),
    submission: submission(id, epoch),
    policy: policy(id, { review: { provider: 'google', model: 'gemini-4-neon',
      reasoningLevel: 'high' }, arbiter: SOL_ARBITER }),
    journal: await tmpJournal(), ports: { ...ports, board: boardPort } });
  assert.equal(res.outcome, 'denied');
  assert.equal(res.reason, 'review_profile_not_approved');
});
