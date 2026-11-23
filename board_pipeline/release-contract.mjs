import { canonicalDigest } from './subject.mjs';

export class ReleaseDenied extends Error {
  constructor(code, options) {
    super(code, options);
    this.code = code;
  }
}

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TARGET = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const TASK = /^[1-9][0-9]{0,14}$/;
const ATTEMPT = /^[a-z0-9-]{1,64}$/;
const ROLLBACK = 'restore_previous_on_red_smoke';

export const isReleaseTarget = value => typeof value === 'string' && TARGET.test(value);
export function isVersion(value) {
  return typeof value?.sha === 'string' && SHA.test(value.sha) && typeof value.digest === 'string' && DIGEST.test(value.digest);
}
export function sameVersion(a, b) {
  return isVersion(a) && isVersion(b) && a.sha === b.sha && a.digest === b.digest;
}

export function createReleasePackage({ source, candidate, previous, target, target_digest, subject_digest, smoke_digest }) {
  if (typeof source?.task_id !== 'string' || !TASK.test(source.task_id) ||
      !Number.isSafeInteger(source.epoch) || source.epoch < 1 ||
      typeof source.attempt_id !== 'string' || !ATTEMPT.test(source.attempt_id) ||
      !isVersion(candidate) || !isVersion(previous) || candidate.digest === previous.digest ||
      !isReleaseTarget(target) || typeof target_digest !== 'string' || !DIGEST.test(target_digest) ||
      typeof subject_digest !== 'string' || !DIGEST.test(subject_digest) ||
      typeof smoke_digest !== 'string' || !DIGEST.test(smoke_digest)) throw new ReleaseDenied('release_package_invalid');
  return { schema: 'darkfactory.release-package.v1', task_id: source.task_id,
    approval_epoch: source.epoch, approval_attempt_id: source.attempt_id,
    sha: candidate.sha, digest: candidate.digest, previous: { sha: previous.sha, digest: previous.digest },
    target, target_digest, subject_digest, smoke_digest, rollback: ROLLBACK, harm: 10 };
}

export function releaseQuestionDetails(plan) {
  return { target: plan.target, digest: plan.digest, previous: plan.previous, package_digest: canonicalDigest(plan) };
}

export function promoteKey(plan) {
  return canonicalDigest({ action: 'promote', target: plan.target, digest: plan.digest });
}

function validPlan(plan) {
  const normalized = createReleasePackage({ source: { task_id: plan?.task_id, epoch: plan?.approval_epoch,
    attempt_id: plan?.approval_attempt_id }, candidate: plan, previous: plan?.previous, target: plan?.target,
    target_digest: plan?.target_digest, subject_digest: plan?.subject_digest, smoke_digest: plan?.smoke_digest });
  return canonicalDigest(plan) === canonicalDigest(normalized);
}

export function issueApproval({ plan, question, answer, resumed, gate, now }) {
  if (!validPlan(plan) || question?.kind !== 'release' || question.task_id !== plan.task_id ||
      question.epoch !== plan.approval_epoch || question.attempt_id !== plan.approval_attempt_id ||
      question.checkpoint?.sha !== plan.sha || question.checkpoint?.subject_digest !== plan.subject_digest ||
      !question.checkpoint?.release ||
      canonicalDigest(question.checkpoint.release) !== canonicalDigest(releaseQuestionDetails(plan)) ||
      resumed?.task_id !== plan.task_id || resumed.epoch !== plan.approval_epoch + 1 ||
      typeof resumed.attempt_id !== 'string' || !ATTEMPT.test(resumed.attempt_id) ||
      resumed.attempt_id === plan.approval_attempt_id || !Number.isSafeInteger(now)) {
    throw new ReleaseDenied('release_approval_scope_mismatch');
  }
  const reply = { decision: answer?.decision, answer: answer?.answer, signature: answer?.signature };
  const proof = gate.verify(question, reply, now);
  if (proof?.decision !== 'approve') throw new ReleaseDenied('release_approval_denied');
  return { schema: 'darkfactory.approval-receipt.v1', harm: 10, task_id: plan.task_id,
    approval_epoch: question.epoch, approval_attempt_id: question.attempt_id,
    release_epoch: resumed.epoch, release_attempt_id: resumed.attempt_id,
    question_id: question.question_id, principal: proof.principal,
    package_digest: canonicalDigest(plan), subject_digest: plan.subject_digest,
    signature_digest: canonicalDigest(proof.signature), approved_at: now };
}
