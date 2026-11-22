import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { answerBytes, createQuestion, signedAnswerVerifier } from './question-gate.mjs';

const attempt = { task_id: '12', epoch: 1, attempt_id: 'attempt-1' };
const checkpoint = { sha: 'a'.repeat(40), turn_seq: 32 };
const known = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
const principal = 'owner:engineering';
const now = 1_000_000;
const question = createQuestion({ attempt, kind: 'product', principal, ttlMs: 1000, now, checkpoint,
  prompt: 'Which export format should we use?', evidence: 'Spec §2 offers CSV and JSON.' });
const reply = { decision: 'resolve', answer: 'Choose CSV.' };
const signed = (q, r, key = known.privateKey) => ({ ...r,
  signature: sign(null, answerBytes(q, r), key).toString('base64url') });
const verifier = signedAnswerVerifier({ principal, publicKey: known.publicKey.export({ type: 'spki', format: 'pem' }) });

test('only the pinned owner key can sign a timely answer to this exact question', () => {
  const received = signed(question, reply);
  assert.equal(verifier(question, received, now + 5).answer, reply.answer);
  assert.equal(verifier(question, signed(question, reply, stranger.privateKey), now + 5), null);
  assert.equal(verifier(question, { ...received, answer: 'Choose JSON.' }, now + 5), null);
  assert.equal(verifier(question, received, question.expires_at), null);
  assert.equal(verifier({ ...question, epoch: 2 }, received, now + 5), null);
  assert.equal(verifier({ ...question, prompt: 'Different scope?' }, received, now + 5), null);
  assert.equal(verifier(question, { ...received, principal }, now + 5), null);
});

test('release decision covers a verified subject, and cannot be replayed as a product answer', () => {
  const q = createQuestion({ attempt, kind: 'release', principal, ttlMs: 1000, now,
    checkpoint: { ...checkpoint, subject_digest: 'b'.repeat(64) },
    prompt: 'Continue to the release stage?', evidence: 'Green checks and review.' });
  const r = signed(q, { decision: 'approve', answer: '' });
  assert.equal(verifier(q, r, now + 10).decision, 'approve');
  assert.equal(verifier(question, r, now + 10), null);
  assert.equal(verifier({ ...q, checkpoint: { ...q.checkpoint, sha: 'c'.repeat(40) } }, r, now + 10), null);
});
