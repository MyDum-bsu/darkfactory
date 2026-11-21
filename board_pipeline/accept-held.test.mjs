import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { acceptHeld } from './acceptance.mjs';
import { nativeBoardPort } from './native-board.mjs';
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
        checkpoint: 'deadbeef',
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
  assert.equal(calls.review, 1);
  assert.equal((await settled(handle, id)).state, 'claimed');
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
