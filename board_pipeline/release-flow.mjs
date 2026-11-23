import { canonicalDigest } from './subject.mjs';
import { issueApproval, ReleaseDenied, sameVersion } from './release-contract.mjs';
import { promotingOperation, rollbackOperation } from './local-release.mjs';

export const RELEASE_PHASES = new Set(['release_ready', 'release_promoting', 'release_smoke',
  'release_rolling_back', 'release_blocking', 'release_completing']);
const INTENT = { release_promoting: 'promote', release_smoke: 'promote', release_rolling_back: 'rollback',
  release_blocking: 'release_block', release_completing: 'release_complete' };

export async function advanceRelease({ record, save, visible, board, release, gate, leaseAlive }) {
  const { releasePlan: plan, question, ownerAnswer: answer, taskId, epoch, attemptId } = record;
  const resumed = { task_id: taskId, epoch, attempt_id: attemptId };
  const blockReason = `Release smoke failed; restored and checked ${plan?.previous?.sha}.`;
  const promoted = { sha: plan?.sha, digest: plan?.digest, operation: plan && promotingOperation(plan) };
  const restored = { ...plan?.previous, operation: plan && rollbackOperation(plan) };
  const matches = (live, expected) => sameVersion(live, expected) && live.operation === expected.operation;
  const approvalAt = now => issueApproval({ plan, question, answer, resumed, gate, now });

  async function stop(reason, phase = 'uncertain') {
    await save({ phase, reason });
    return visible();
  }

  let approval;
  try {
    const seal = record.releaseVerification;
    if (!plan || seal?.settle !== 'deferred' || seal.task_id !== plan.task_id || seal.epoch !== plan.approval_epoch ||
        seal.attempt_id !== plan.approval_attempt_id || seal.evidence?.sha !== plan.sha ||
        seal.evidence?.subject_digest !== plan.subject_digest) {
      throw new ReleaseDenied('release_seal_mismatch');
    }
    const beginning = record.phase === 'release_ready';
    approval = approvalAt(beginning ? gate.now() : record.releaseApproval?.approved_at);
    if (!beginning && canonicalDigest(approval) !== canonicalDigest(record.releaseApproval)) {
      throw new ReleaseDenied('release_approval_scope_mismatch');
    }
    if (!beginning && (record.intent?.kind !== INTENT[record.phase] || record.intent.epoch !== epoch ||
        record.intent.attemptId !== attemptId ||
        (record.intent.kind === 'promote' && record.intent.operation !== promoted.operation) ||
        (record.intent.kind === 'rollback' && record.intent.operation !== restored.operation))) {
      throw new ReleaseDenied('release_intent_mismatch');
    }
  } catch (cause) {
    return stop(cause instanceof ReleaseDenied ? cause.code : 'release_approval_invalid',
      record.phase === 'release_ready' ? 'hold' : 'uncertain');
  }

  // Recheck mutable operator inputs/worktree and the native epoch, not only
  // the old signed answer. Expiry gates the promotion, not its cleanup.
  async function authorizeEffect(freshApproval = false) {
    if (!await gate.canResume({ stage: 'claimed', question, threadId: record.threadId, contract: record.contract })) {
      throw new ReleaseDenied('release_context_changed');
    }
    if (!await leaseAlive()) throw new ReleaseDenied('release_epoch_lost');
    if (freshApproval) approvalAt(gate.now());
  }

  async function readExpected(expected) {
    try { return matches(await release.readBack(plan), expected); } catch { return false; }
  }

  async function reconcilePromotion() {
    if (!await readExpected(promoted)) return stop('release_promotion_unconfirmed');
    await save({ phase: 'release_smoke', reason: null,
      receipt: { kind: 'promotion', observed: promoted } });
    return visible();
  }

  async function reconcileSettlement(blocked, evidence) {
    const live = await board.lookup(taskId).catch(() => null);
    if (live?.epoch !== epoch) return stop('release_board_settlement_unconfirmed');
    if (blocked && live.state === 'blocked' && live.blocked?.reason === blockReason) {
      return stop('release_rolled_back', 'hold');
    }
    if (!blocked && live.state === 'completed' && live.result != null &&
        canonicalDigest(live.result) === canonicalDigest(evidence)) {
      await save({ phase: 'done', reason: null, receipt: { kind: 'deployed', evidence } });
      return visible();
    }
    return stop('release_board_settlement_unconfirmed');
  }

  const deployedEvidence = { schema: 'darkfactory.release-receipt.v1', ...resumed,
    finish: 'deployed', sha: plan.sha, digest: plan.digest, target: plan.target, target_digest: plan.target_digest,
    subject_digest: plan.subject_digest, approval_digest: canonicalDigest(approval),
    promotion: promoted.operation, readback: plan.digest, smoke: 'pass' };

  async function complete(proof) {
    if (proof?.ok !== true || !sameVersion(proof, promoted)) throw new ReleaseDenied('release_smoke_proof_invalid');
    await save({ phase: 'release_completing', releaseResult: deployedEvidence,
      intent: { kind: 'release_complete', epoch, attemptId } });
    await authorizeEffect();
    try { await board.complete(taskId, epoch, deployedEvidence); }
    catch { /* Native read-back below distinguishes confirmation from uncertainty. */ }
    return reconcileSettlement(false, deployedEvidence);
  }

  async function reconcileRollback() {
    if (!await readExpected(restored)) return stop('release_rollback_unconfirmed');
    const probe = await release.verify(plan, restored, async proof => {
      await save({ phase: 'release_blocking',
        receipt: { kind: 'rolled_back', ...resumed, subject_digest: plan.subject_digest,
          approval_digest: canonicalDigest(approval), observed: restored, smoke: proof.ok },
        intent: { kind: 'release_block', epoch, attemptId, blockText: blockReason } });
      await authorizeEffect();
      try { await board.block(taskId, epoch, blockReason); }
      catch { /* Reconcile native hold without another block. */ }
    });
    if (!probe.ok) return stop('release_rollback_smoke_red');
    return reconcileSettlement(true);
  }

  try {
    switch (record.phase) {
      case 'release_ready':
        await authorizeEffect(true);
        await save({ phase: 'release_promoting', releaseApproval: approval,
          intent: { kind: 'promote', operation: promoted.operation, epoch, attemptId } });
        try { await release.promote(plan, () => authorizeEffect(true)); }
        catch { /* A lost response does not permit another promote. */ }
        return reconcilePromotion();
      case 'release_promoting':
        return reconcilePromotion();
      case 'release_smoke': {
        await authorizeEffect();
        // The lock is held across positive read-back/smoke and native complete.
        // If the check throws (as opposed to known red) never guess or roll back.
        const probe = await release.verify(plan, promoted, complete);
        if (probe.ok) return visible();
        await save({ phase: 'release_rolling_back', reason: 'release_smoke_red',
          intent: { kind: 'rollback', operation: restored.operation, epoch, attemptId } });
        try { await release.rollback(plan, authorizeEffect); }
        catch { /* Read-back is the only way to credit the rollback. */ }
        return await reconcileRollback();
      }
      case 'release_rolling_back':
        return await reconcileRollback();
      case 'release_blocking':
        return reconcileSettlement(true);
      case 'release_completing':
        if (canonicalDigest(record.releaseResult) !== canonicalDigest(deployedEvidence)) return stop('release_receipt_mismatch');
        return reconcileSettlement(false, deployedEvidence);
      default:
        throw new ReleaseDenied('release_phase_invalid');
    }
  } catch (cause) {
    return stop(cause instanceof ReleaseDenied ? cause.code : 'release_effect_unconfirmed');
  }
}
