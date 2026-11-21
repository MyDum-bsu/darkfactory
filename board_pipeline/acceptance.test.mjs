import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { accept } from './acceptance.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_BASE = '0'.repeat(40);

const POLICY = {
  version: '1',
  profiles: {
    default: {
      commands: ['npm test'],
      review: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' },
    },
  },
};

function makeHandoff(over = {}) {
  return {
    task_id: '129',
    worker_thread_id: 'thr_1',
    base_sha: SHA_BASE,
    candidate_sha: SHA_A,
    worktree: '/tmp/wt',
    check_profile: 'default',
    ...over,
  };
}

function makePorts(over = {}) {
  const calls = { lookup: 0, claim: 0, complete: 0, block: 0, inspect: 0, local: 0, review: 0 };
  const ports = {
    inspect: async (handoff) => {
      calls.inspect++;
      return { head: handoff.candidate_sha, clean: true, baseAncestor: true };
    },
    local: async (handoff) => {
      calls.local++;
      return { sha: handoff.candidate_sha, ok: true, evidence: 'ev.json' };
    },
    review: async (handoff) => {
      calls.review++;
      return {
        task: handoff.task_id,
        sha: handoff.candidate_sha,
        actual: { provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' },
        verdict: 'REVIEW_OK',
        checkpoint: 'feed8cab',
      };
    },
    board: {
      lookup: async () => {
        calls.lookup++;
        return { state: 'ready', epoch: 1 };
      },
      claim: async () => {
        calls.claim++;
        return { epoch: 7 };
      },
      complete: async () => {
        calls.complete++;
      },
      block: async () => {
        calls.block++;
      },
    },
    ...over,
  };
  return { ports, calls };
}

const testRoot = await mkdtemp(path.join(tmpdir(), 'board-pipeline-tests-'));
after(() => rm(testRoot, { recursive: true, force: true }));
function tmpJournal() {
  return mkdtemp(path.join(testRoot, 'attempt-'));
}

async function readRunFile(journal) {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(journal);
  assert.equal(files.length, 1);
  return (await readFile(path.join(journal, files[0]), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

test('happy path: зелёная сдача завершает карточку', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'completed');
  assert.equal(res.epoch, 7);
  assert.equal(res.evidence, 'ev.json');
  assert.deepEqual(calls, { lookup: 1, claim: 1, complete: 1, block: 0, inspect: 2, local: 1, review: 1 });
  const entries = await readRunFile(journal);
  const intents = entries.filter((e) => e.kind === 'intent').map((e) => e.phase);
  assert.deepEqual(intents, ['claim', 'inspect', 'local', 'review', 'seal', 'complete']);
});

test('грязный снимок и дрейф SHA не запускают ревью', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  ports.inspect = async () => ({ head: SHA_B, clean: true, baseAncestor: true });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'blocked');
  assert.match(res.reason, /head_mismatch/);
  assert.equal(calls.local, 0);
  assert.equal(calls.review, 0);
  assert.equal(calls.complete, 0);
  assert.equal(calls.block, 1);
});

test('нечистый worktree блокируется', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  ports.inspect = async (h) => ({ head: h.candidate_sha, clean: false, baseAncestor: true });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'blocked');
  assert.equal(res.reason, 'dirty_worktree');
  assert.equal(calls.local, 0);
  assert.equal(calls.review, 0);
});

test('красные локальные проверки: ревью не запускается, карточка blocked', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  ports.local = async (h) => ({ sha: h.candidate_sha, ok: false, evidence: 'ev.json' });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'blocked');
  assert.equal(res.reason, 'local_checks_failed');
  assert.equal(calls.review, 0);
  assert.equal(calls.complete, 0);
  assert.equal(calls.block, 1);
});

test('ревью другой модели не принимается', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  ports.review = async (h) => ({
    task: h.task_id,
    sha: h.candidate_sha,
    actual: { provider: 'anthropic', model: 'other', reasoningLevel: 'medium' },
    verdict: 'REVIEW_OK',
    checkpoint: 'feed8cab',
  });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'blocked');
  assert.match(res.reason, /provider_mismatch/);
  assert.equal(calls.complete, 0);
});

test('отрицательный и неподтверждённый review — blocked', async () => {
  for (const mutate of [
    (r) => ({ ...r, verdict: 'REVIEW_BLOCKED' }),
    (r) => ({ ...r, checkpoint: null }),
    (r) => ({ ...r, sha: SHA_B }),
  ]) {
    const journal = await tmpJournal();
    const { ports, calls } = makePorts();
    const orig = ports.review;
    ports.review = async (h, p) => mutate(await orig(h, p));
    const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
    assert.equal(res.outcome, 'blocked');
    assert.equal(calls.complete, 0);
  }
});

test('потерянный claim на complete: uncertain, без повторного complete', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  let completed = 0;
  ports.board.complete = async () => {
    calls.complete++;
    completed++;
    throw new Error('stale epoch');
  };
  let lookups = 0;
  ports.board.lookup = async () => (lookups++ === 0 ? { state: 'ready', epoch: 1 } : { state: 'claimed', epoch: 9 });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'uncertain');
  assert.equal(completed, 1);
  // Повтор не подхватывает потерянный claim и не дёргает эффекты заново.
  const res2 = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res2.outcome, 'uncertain');
  assert.equal(res2.repeated, true);
  assert.equal(calls.complete, 1);
  assert.equal(calls.claim, 1);
});

test('повтор завершённого запуска возвращает тот же исход без эффектов', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  const r1 = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(r1.outcome, 'completed');
  const r2 = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(r2.outcome, 'completed');
  assert.equal(r2.repeated, true);
  assert.deepEqual(calls, { lookup: 1, claim: 1, complete: 1, block: 0, inspect: 2, local: 1, review: 1 });
});

test('авария после intent complete: повтор только сверяет, не retry', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  // Первый запуск «падает» — имитируем запись intent без outcome.
  const runFile = path.join(journal, `run-129-${SHA_A}-v1.jsonl`);
  await writeFile(runFile, JSON.stringify({ seq: 0, kind: 'run' }) + '\n');
  await appendFile(runFile, JSON.stringify({ seq: 1, kind: 'intent', phase: 'complete' }) + '\n');
  ports.board.lookup = async () => ({ state: 'claimed', epoch: 3 });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'uncertain');
  assert.equal(res.reason, 'interrupted_run');
  assert.equal(res.phase, 'complete');
  assert.equal(res.board_state, 'claimed');
  assert.equal(calls.claim, 0);
  assert.equal(calls.local, 0);
  assert.equal(calls.complete, 0);
});

test('строгий контракт: лишние поля и shell из сдачи отклоняются', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  const res = await accept({
    handoff: makeHandoff({ commands: 'rm -rf /', extra: 'x' }),
    policy: POLICY,
    journal,
    ports,
  });
  assert.equal(res.outcome, 'denied');
  assert.equal(calls.claim, 0);
  const res2 = await accept({
    handoff: makeHandoff({ candidate_sha: 'abc' }),
    policy: POLICY,
    journal,
    ports,
  });
  assert.equal(res2.outcome, 'denied');
  assert.equal(res2.reason, 'candidate_sha_not_full');
});

test('неизвестный профиль и чужое состояние карточки — denied', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  let r = await accept({ handoff: makeHandoff({ check_profile: 'nope' }), policy: POLICY, journal, ports });
  assert.equal(r.outcome, 'denied');
  assert.match(r.reason, /unknown_profile/);
  ports.board.lookup = async () => ({ state: 'completed', epoch: 2 });
  r = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(r.outcome, 'denied');
  assert.match(r.reason, /unexpected_state/);
  assert.equal(calls.claim, 0);
});

test('отсутствующий профиль reviewer не позволяет принять сдачу', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  const policy = { version: '1', profiles: { default: {} } };
  const res = await accept({ handoff: makeHandoff(), policy, journal, ports });
  assert.equal(res.outcome, 'denied');
  assert.equal(calls.claim + calls.complete, 0);
});

test('дрейф при ревью блокирует закрытие уже проверенной версии', async () => {
  const journal = await tmpJournal();
  const { ports, calls } = makePorts();
  const normal = ports.review;
  ports.review = async (...args) => {
    ports.inspect = async () => ({ head: SHA_B, clean: true, baseAncestor: true });
    return normal(...args);
  };
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'blocked');
  assert.equal(calls.complete, 0);
});

test('нет свидетельства от локального runner — blocked', async () => {
  const journal = await tmpJournal();
  const { ports } = makePorts();
  ports.local = async (h) => ({ sha: h.candidate_sha, ok: true, evidence: null });
  const res = await accept({ handoff: makeHandoff(), policy: POLICY, journal, ports });
  assert.equal(res.outcome, 'blocked');
  assert.equal(res.reason, 'missing_evidence');
});
