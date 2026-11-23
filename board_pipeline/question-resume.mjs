import { randomBytes, randomUUID } from 'node:crypto';
import { questionBlockText } from './question-gate.mjs';

export const QUESTION_PHASES = new Set(['awaiting_answer', 'unblocking', 'resume_pending', 'resume_claiming']);

export async function advanceQuestion({ record, save, visible, board, gate, feedback, reconcileFeedback,
  decisionLedger }) {
  const { question } = record;
  const stateOf = () => board.questionState(question, questionBlockText(question));
  const uncertain = async reason => {
    await save({ phase: 'uncertain', reason });
    return visible();
  };
  const authorized = stage => gate.canResume({ stage, question, threadId: record.threadId, contract: record.contract });

  async function reconcileUnblock() {
    const state = await stateOf().catch(() => 'unknown');
    if (!['ready', 'waiting'].includes(state)) return uncertain('question_unblock_unconfirmed');
    await save({ phase: 'resume_pending', reason: null, receipt: { kind: 'unblock', confirmed: 'observed',
      questionId: question.question_id } });
    return visible();
  }

  async function finishClaim({ attemptId, epoch, token }) {
    let live;
    try {
      await board.adopt(question.task_id, { epoch, token });
      live = await board.verifyHeld(question.task_id, epoch);
      if (live.epoch !== epoch) {
        return uncertain('question_new_epoch_unconfirmed');
      }
    } catch {
      return uncertain('question_resume_claim_unconfirmed');
    }
    if (!await authorized('claimed')) return uncertain('question_resume_checkpoint_drift');
    if (question.kind === 'release') {
      await save({ phase: 'release_ready', epoch, token, attemptId, until: live.until, reason: null,
        receipt: { kind: 'release_resume', questionId: question.question_id, checkpoint: question.checkpoint } });
      return visible();
    }
    const feedbackId = `${attemptId}:answer:${question.question_id}`;
    // The existing returning/reconciliation path never reruns an unconfirmed tell.
    await save({ phase: 'returning', epoch, token, attemptId, until: live.until, reason: null, feedbackId,
      turnSeq: question.checkpoint.turn_seq, seenShas: [], roundsHistory: [], arbitrationUsed: 0,
      intent: { kind: 'feedback', feedbackId, epoch, attemptId, turnSeq: question.checkpoint.turn_seq } });
    const sent = await feedback({ feedbackId, answer: record.ownerAnswer.answer, question }).catch(() => null);
    if (!sent?.confirmed) return reconcileFeedback();
    await save({ phase: 'working', receipt: { kind: 'feedback', feedbackId } });
    return visible();
  }

  if (record.phase !== 'awaiting_answer') {
    const { decision, answer, signature, verified_at } = record.ownerAnswer ?? {};
    if (!Number.isSafeInteger(verified_at) || decision === 'decline' ||
        !gate.verify(question, { decision, answer, signature }, verified_at)) {
      return uncertain('owner_answer_intent_unverified');
    }
  }
  switch (record.phase) {
    case 'awaiting_answer': {
      if (await stateOf() !== 'blocked') return uncertain('question_hold_changed');
      if (gate.now() >= question.expires_at) {
        await save({ phase: 'hold', reason: 'owner_question_expired' });
        return visible();
      }
      const answer = await gate.read(question.question_id);
      if (answer === null) return visible();
      const ownerAnswer = gate.verify(question, answer, gate.now());
      if (ownerAnswer === null) return visible();
      if (ownerAnswer.decision === 'decline') {
        await save({ phase: 'hold', reason: 'owner_declined', ownerAnswer });
        return visible();
      }
      if (!await authorized('blocked')) return uncertain('question_resume_checkpoint_drift');
      if (gate.now() >= question.expires_at) return visible();
      // Опциональная запись подтверждённого ответа владельца в Decision Ledger
      // (Board #1261): только при явно переданном порту; повторный прогон той же
      // фазы идемпотентен за счёт дедупликации в recordDecision. Отказ записи —
      // uncertain, незаписанный ответ не считается запомненным.
      let decisionId;
      if (decisionLedger) {
        const entry = await decisionLedger({ answer: ownerAnswer.answer, question }).catch(() => null);
        if (entry === null) return uncertain('decision_ledger_unconfirmed');
        decisionId = entry.id;
      }
      await save({ phase: 'unblocking', ownerAnswer,
        ...(decisionId !== undefined ? { decisionId } : {}),
        intent: { kind: 'unblock', questionId: question.question_id, epoch: question.epoch } });
      try { await board.unblockQuestion(question, questionBlockText(question)); }
      catch { return reconcileUnblock(); }
      return reconcileUnblock();
    }
    case 'unblocking':
      return reconcileUnblock();
    case 'resume_pending': {
      const state = await stateOf();
      if (state === 'waiting') return visible();
      if (state !== 'ready') return uncertain('question_unblock_state_changed');
      if (!await authorized('ready')) return uncertain('question_resume_checkpoint_drift');
      const intent = { kind: 'resume_claim', questionId: question.question_id,
        attemptId: randomUUID(), epoch: question.epoch + 1, token: randomBytes(32).toString('base64url') };
      await save({ phase: 'resume_claiming', intent });
      try { await board.claimForQuestion(question, { token: intent.token }); }
      catch { return finishClaim(intent); }
      return finishClaim(intent);
    }
    case 'resume_claiming':
      if (record.intent?.kind !== 'resume_claim' || record.intent.questionId !== question.question_id ||
          record.intent.epoch !== question.epoch + 1) return uncertain('question_resume_claim_unconfirmed');
      return finishClaim(record.intent);
    default:
      throw new Error('Unknown owner answer phase');
  }
}
