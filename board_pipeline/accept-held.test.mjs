import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { acceptHeld } from './acceptance.mjs';
import { nativeBoardPort } from './native-board.mjs';
import { buildSubject, subjectDigest } from './subject.mjs';
import { loadSdk } from './sdk.mjs';

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
  const run = { contract: { repo_id: REPO, spec_digest: SPEC, policy_digest: POL,
    fixtures_digest: null, release_target: null } };
  assert.equal(sameContract(run, contractAttempt('1', 1)), true);
  assert.equal(sameContract(run, contractAttempt('1', 1, { spec_digest: OTHER_256 })), false);
  assert.equal(sameContract(run, contractAttempt('1', 1, { fixtures_digest: OTHER_256 })), false);
  assert.equal(sameContract({ contract: null }, contractAttempt('1', 1)), false, 'запись без контракта');
  assert.equal(sameContract(run, attempt('1', 1)), true, 'ручной v1 без контракта всегда совместим');
  assert.equal(sameContract(run, contractAttempt('1', 1, { release_target: { finish: 'deployed' } })), false);
});
