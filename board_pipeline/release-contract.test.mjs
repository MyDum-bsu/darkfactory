import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { answerBytes, createQuestion, signedAnswerVerifier } from './question-gate.mjs';
import { createReleasePackage, issueApproval, releaseQuestionDetails, promoteKey } from './release-contract.mjs';
import { localReleasePort } from './local-release.mjs';

const now = 1000_000;
const source = { task_id: '31', epoch: 4, attempt_id: 'attempt-old' };
const resumed = { task_id: '31', epoch: 5, attempt_id: 'attempt-new' };
const owner = generateKeyPairSync('ed25519');
const foreign = generateKeyPairSync('ed25519');
const principal = 'local:user:operator';
const gate = { verify: signedAnswerVerifier({ principal, publicKey: owner.publicKey.export({ type: 'spki', format: 'pem' }) }) };
const previous = { sha: '1'.repeat(40), digest: '2'.repeat(64) };
const candidate = { sha: '3'.repeat(40), digest: '4'.repeat(64) };
const subject_digest = '5'.repeat(64);
const plan = createReleasePackage({ source, candidate, previous, target: 'local-release', subject_digest,
  target_digest: '7'.repeat(64), smoke_digest: '6'.repeat(64) });
const question = createQuestion({ attempt: source, kind: 'release', principal, ttlMs: 1000, now,
  checkpoint: { sha: candidate.sha, turn_seq: 25, subject_digest, release: releaseQuestionDetails(plan) },
  prompt: 'Approve the isolated release?', evidence: 'Sealed verification.' });
function signed(q, key = owner.privateKey) {
  const reply = { decision: 'approve', answer: '' };
  return { ...reply, signature: sign(null, answerBytes(q, reply), key).toString('base64url') };
}
const approval = (over = {}) => issueApproval({ plan, question, answer: signed(question), resumed, gate, now: now + 1, ...over });

test('ApprovalReceipt binds the exact package, rollback and new attempt to an authorized owner', () => {
  const proof = approval();
  assert.equal(proof.harm, 10);
  assert.equal(proof.principal, principal);
  assert.equal(proof.task_id, source.task_id);
  assert.equal(proof.approval_epoch, source.epoch);
  assert.equal(proof.release_epoch, resumed.epoch);
  assert.equal(proof.release_attempt_id, resumed.attempt_id);
  assert.equal(proof.question_id, question.question_id);
  assert.equal(proof.package_digest, question.checkpoint.release.package_digest);
  assert.match(promoteKey(plan), /^[a-f0-9]{64}$/);
  assert.equal(promoteKey({ ...plan, sha: 'a'.repeat(40) }), promoteKey(plan));
});

test('old, foreign or drifted approvals never authorize a release', () => {
  for (const changed of [{ target: 'other' }, { digest: 'f'.repeat(64) }, { subject_digest: 'f'.repeat(64) },
    { smoke_digest: 'f'.repeat(64) }, { target_digest: 'f'.repeat(64) }, { previous: { ...previous, digest: 'a'.repeat(64) } },
    { rollback: 'unchecked' }]) {
    assert.throws(() => approval({ plan: { ...plan, ...changed } }));
  }
  assert.throws(() => approval({ answer: signed(question, foreign.privateKey) }));
  assert.throws(() => approval({ now: now + 1000 }));
  assert.throws(() => approval({ resumed: { ...resumed, epoch: source.epoch } }));
  assert.throws(() => approval({ resumed: { ...resumed, task_id: '32' } }));
});

test('release transport rejects production, Board and URL aliases before access to a target', async () => {
  for (const url of ['https://example.invalid', 'http://localhost:44981', 'http://127.0.0.1:44100',
    'http://127.0.0.1:44981/unexpected', 'http://0.0.0.0:44981', 'http://127.0.0.1:70000']) {
    await assert.rejects(localReleasePort({ url }), { code: 'release_endpoint_invalid' });
  }
});
