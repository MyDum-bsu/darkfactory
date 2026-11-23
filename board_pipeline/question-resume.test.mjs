import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceQuestion } from './question-resume.mjs';

const question = {
  schema: 'darkfactory.question.v1', question_id: 'q-1', task_id: '1261', epoch: 1,
  attempt_id: 'att-1', kind: 'product', respondent: 'owner', created_at: 500,
  expires_at: 10_000, prompt: 'CSV или JSON?', evidence: '',
  decisions: ['resolve', 'decline'], recommend: 'decline',
  checkpoint: { sha: 'a'.repeat(40), turn_seq: 3 },
};

function harness({ states = ['blocked', 'ready'], ledger } = {}) {
  const record = { phase: 'awaiting_answer', question, threadId: 'thr_x', contract: null };
  const calls = { unblock: 0, ledger: 0 };
  const state = { save: async patch => { Object.assign(record, patch); return record; },
    visible: async () => record };
  let i = 0;
  const board = { questionState: async () => states[Math.min(i++, states.length - 1)],
    unblockQuestion: async () => { calls.unblock += 1; } };
  const gate = { now: () => 1_000,
    read: async () => ({ decision: 'resolve', answer: 'CSV', signature: 's' }),
    verify: () => ({ decision: 'resolve', answer: 'CSV', signature: 's', verified_at: 1_000 }),
    canResume: async () => true };
  const decisionLedger = ledger === undefined ? undefined : async args => {
    calls.ledger += 1;
    return ledger(args);
  };
  return { record, calls, run: () => advanceQuestion({ ...state, record, board, gate,
    feedback: async () => ({ confirmed: true }), reconcileFeedback: async () => record,
    decisionLedger }) };
}

test('verified owner answer is recorded into the ledger when the port is set', async () => {
  const h = harness({ ledger: async ({ answer, question: q }) => {
    assert.equal(answer, 'CSV');
    assert.equal(q.question_id, 'q-1');
    return { id: 'dec-1' };
  } });
  const result = await h.run();
  assert.equal(result.phase, 'resume_pending');
  assert.equal(h.record.decisionId, 'dec-1');
  assert.equal(h.calls.ledger, 1);
  assert.equal(h.calls.unblock, 1);
});

test('ledger write failure is fail-closed: uncertain, card stays blocked', async () => {
  const h = harness({ ledger: async () => { throw new Error('decision_ledger_tampered'); } });
  const result = await h.run();
  assert.equal(result.phase, 'uncertain');
  assert.equal(result.reason, 'decision_ledger_unconfirmed');
  assert.equal(h.calls.unblock, 0);
});

test('without the ledger port the resume flow is unchanged', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.phase, 'resume_pending');
  assert.equal(h.record.decisionId, undefined);
  assert.equal(h.calls.unblock, 1);
});

test('past awaiting_answer the ledger is not rewritten on rerun', async () => {
  const h = harness({ states: ['ready'], ledger: async () => ({ id: 'dec-1' }) });
  h.record.phase = 'unblocking';
  h.record.decisionId = 'dec-1';
  h.record.ownerAnswer = { decision: 'resolve', answer: 'CSV', signature: 's', verified_at: 1_000 };
  const result = await h.run();
  assert.equal(result.phase, 'resume_pending');
  assert.equal(h.calls.ledger, 0);
});
