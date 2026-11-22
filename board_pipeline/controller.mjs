import { createHash, randomBytes, randomUUID } from 'node:crypto';

const TERMINAL = new Set(['done', 'hold', 'uncertain', 'lease_lost']);
const IN_FLIGHT = new Set(['claiming', 'launching', 'checking', 'returning', 'blocking']);
const shaRE = /^[a-f0-9]{40}$/;

function checkRoute(r) {
  if (!r || !/^[1-9][0-9]{0,14}$/.test(r.taskId ?? '') || !shaRE.test(r.base ?? '') ||
      !r.worktree?.startsWith('/') || !r.policyVersion || !r.checkProfile ||
      !['verified', 'deployed'].includes(r.finish)) throw new Error('A trusted, enrolled route is required');
}

function attemptOf(record, route) {
  return { task_id: route.taskId, attempt_id: record.attemptId, epoch: record.epoch,
    bb_thread_id: record.threadId, worktree: route.worktree, base_sha: route.base,
    check_profile: route.checkProfile, finish: route.finish };
}

// One serialized tick. Board keeps the work queue; state records only effects of this attempt.
// Unconfirmed external effects never become another spawn, tell or settle on restart.
export async function advance({ route, state, board, bb, submissions, verify, authorize }) {
  checkRoute(route);
  if (typeof authorize !== 'function') throw new Error('Route admission is required');
  const binding = createHash('sha256').update(JSON.stringify(route)).digest('hex');
  let record = await state.load();
  if (record && record.binding !== binding) throw new Error('The enrolled route changed');
  const save = async patch => {
    record = { ...record, ...patch };
    await state.save(record);
  };
  const visible = () => ({ phase: record.phase, attemptId: record.attemptId,
    epoch: record.epoch, threadId: record.threadId, reason: record.reason, sha: record.sha });

  if (!record) {
    if ((await board.lookup(route.taskId)).state !== 'ready') return { phase: 'idle' };
    if (!await authorize('ready')) return { phase: 'hold', reason: 'route_not_authorized' };
    await save({ binding, phase: 'claiming', attemptId: randomUUID(),
      token: randomBytes(32).toString('base64url'), seenShas: [] });
    try {
      const claim = await board.claim(route.taskId, { token: record.token });
      if (!Number.isSafeInteger(claim.epoch) || claim.epoch < 1) throw new Error('No native claim epoch');
      await save({ phase: 'launching', epoch: claim.epoch, until: claim.until });
      if (!await authorize('claimed')) {
        await save({ phase: 'hold', reason: 'route_changed_before_spawn' });
        return visible();
      }
      const proof = await board.verifyHeld(route.taskId, claim.epoch).catch(() => null);
      if (proof?.epoch !== claim.epoch) {
        await save({ phase: 'lease_lost', reason: 'lease_lost_before_spawn' });
        return visible();
      }
      const launched = await bb.spawn({ ...attemptOf(record, route), bb_thread_id: undefined });
      if (!/^thr_[a-z0-9]+$/.test(launched?.threadId ?? '')) throw new Error('No confirmed BB thread');
      await save({ phase: 'working', threadId: launched.threadId });
    } catch {
      await save({ phase: 'uncertain', reason: 'claim_or_spawn_unconfirmed' });
    }
    return visible();
  }
  if (TERMINAL.has(record.phase)) return visible();
  if (IN_FLIGHT.has(record.phase)) {
    await save({ phase: 'uncertain', reason: `interrupted_${record.phase}` });
    return visible();
  }
  if (record.phase !== 'working') throw new Error('Unknown attempt state');

  // After process restart the adapter can recover the same held capability. It cannot re-claim.
  try {
    await board.adopt(route.taskId, { epoch: record.epoch, token: record.token });
    const proof = await board.verifyHeld(route.taskId, record.epoch);
    if (proof.epoch !== record.epoch) throw new Error('Wrong native claim epoch');
  } catch {
    await save({ phase: 'lease_lost', reason: 'no_verified_claim_keep_worktree_reserved' });
    return visible();
  }

  const attempt = attemptOf(record, route);
  const after = record.turnSeq ?? 0;
  const observation = await submissions.read(attempt, after);
  if (!observation || !Number.isSafeInteger(observation.turnSeq) || observation.turnSeq <= after) return visible();
  const { submission, turnSeq } = observation;
  if (!submission || record.seenShas.includes(submission.candidate_sha)) {
    const reason = after ? 'worker_turn_finished_without_new_handoff' : 'worker_turn_finished_without_handoff';
    await save({ phase: 'blocking', turnSeq });
    try {
      await board.block(attempt.task_id, attempt.epoch, `${reason}: ${attempt.bb_thread_id}, BB event ${turnSeq}. Проверьте ход; повтор не отправлен.`);
      await save({ phase: 'hold', reason });
    } catch {
      await save({ phase: 'uncertain', reason: 'missing_handoff_block_unconfirmed' });
    }
    return visible();
  }
  if (submission.task_id !== attempt.task_id || submission.epoch !== attempt.epoch ||
      submission.attempt_id !== attempt.attempt_id || submission.worker_thread_id !== attempt.bb_thread_id ||
      !shaRE.test(submission.candidate_sha ?? '')) {
    await save({ phase: 'hold', reason: 'invalid_or_stale_submission' });
    return visible();
  }

  await save({ phase: 'checking', sha: submission.candidate_sha, turnSeq,
    seenShas: [...record.seenShas, submission.candidate_sha] });
  const result = await verify(attempt, submission);
  if (result.outcome === 'rework') {
    const proof = await board.verifyHeld(attempt.task_id, attempt.epoch).catch(() => null);
    if (proof?.epoch !== attempt.epoch) {
      await save({ phase: 'lease_lost', reason: 'lease_lost_before_feedback' });
      return visible();
    }
    const feedbackId = `${attempt.attempt_id}:${submission.candidate_sha}`;
    await save({ phase: 'returning', feedbackId });
    const sent = await bb.feedback({ attempt, feedbackId, sha: submission.candidate_sha,
      reason: result.reason, evidence: result.feedback });
    if (!sent?.confirmed) {
      await save({ phase: 'uncertain', reason: 'feedback_delivery_unconfirmed' });
      return visible();
    }
    await save({ phase: 'working' });
  } else if (result.outcome === 'verified' && result.receipt?.settle === 'completed' && route.finish === 'verified') {
    const settled = await board.lookup(attempt.task_id);
    if (settled.state !== 'completed' || settled.result?.sha !== submission.candidate_sha) {
      await save({ phase: 'uncertain', reason: 'completed_sha_not_confirmed' });
    } else {
      await save({ phase: 'done' });
    }
  } else if (result.outcome === 'verified' && result.receipt?.settle === 'deferred' && route.finish === 'deployed') {
    await save({ phase: 'blocking' });
    await board.block(attempt.task_id, attempt.epoch, `Выпуск не разрешён этим контуром. Проверен SHA ${record.sha}`);
    await save({ phase: 'hold', reason: 'release_not_authorized' });
  } else {
    await save({ phase: result.outcome === 'uncertain' ? 'uncertain' : 'hold', reason: result.reason ?? 'unverified' });
  }
  return visible();
}
