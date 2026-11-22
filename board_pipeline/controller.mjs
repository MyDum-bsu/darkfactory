import { createHash, randomBytes, randomUUID } from 'node:crypto';

const TERMINAL = new Set(['done', 'hold', 'uncertain', 'lease_lost']);
const IN_FLIGHT = new Set(['claiming', 'launching', 'checking', 'returning', 'blocking']);
const shaRE = /^[a-f0-9]{40}$/;

// Контракт приёмки, который карточка обязана нести в метках для захвата из очереди:
// разрешённый профиль, identity репозитория и валидные хэши спеки/политики.
const CONTRACT_LABELS = ['profile_id', 'repo_id', 'spec_digest', 'policy_digest'];

function isAllowlist(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  if (typeof a.owner !== 'string' || !a.owner) return false;
  const { key, value } = a.label ?? {};
  if (typeof key !== 'string' || !key || typeof value !== 'string' || !value) return false;
  if (a.required !== undefined &&
      (!Array.isArray(a.required) || !a.required.every(item => typeof item === 'string' && item))) return false;
  return true;
}

// Задача маршрута либо захардкожена (совместимость с P0-пилотом и ручными маршрутами),
// либо берётся из очереди по allowlist оператора. Остальные поля закреплены в обоих режимах.
function checkRoute(r) {
  if (!r || !shaRE.test(r.base ?? '') || !r.worktree?.startsWith('/') || !r.policyVersion ||
      !r.checkProfile || !['verified', 'deployed'].includes(r.finish)) {
    throw new Error('A trusted, enrolled route is required');
  }
  if (!/^[1-9][0-9]{0,14}$/.test(r.taskId ?? '') && !isAllowlist(r.allowlist)) {
    throw new Error('A trusted, enrolled route is required');
  }
}

// Фильтр claimReady: канал закреплён адаптером, остальное — allowlist маршрута.
// Контрактные метки обязательны всегда, профиль карточки сверяется с профилем маршрута:
// неполный или чужой контракт даёт 0-эффектный захват (null).
function queueFilter(route) {
  return {
    owner: route.allowlist.owner,
    label: route.allowlist.label,
    finish: route.finish,
    profileId: route.checkProfile,
    required: [...new Set([...CONTRACT_LABELS, ...(route.allowlist.required ?? [])])],
  };
}

function contractOf(labels) {
  return {
    repo_id: labels?.repo_id,
    spec_digest: labels?.spec_digest,
    policy_digest: labels?.policy_digest,
    fixtures_digest: typeof labels?.fixtures_digest === 'string' ? labels.fixtures_digest : null,
  };
}

function attemptOf(record, route) {
  const attempt = { task_id: record.taskId ?? route.taskId, attempt_id: record.attemptId, epoch: record.epoch,
    bb_thread_id: record.threadId, worktree: route.worktree, base_sha: route.base,
    check_profile: route.checkProfile, finish: route.finish };
  if (record.contract) {
    attempt.repo_id = record.contract.repo_id;
    attempt.spec_digest = record.contract.spec_digest;
    attempt.policy_digest = record.contract.policy_digest;
    attempt.fixtures_digest = record.contract.fixtures_digest ?? null;
  }
  return attempt;
}

// One serialized tick. Board keeps the work queue; state records only effects of this attempt.
// Unconfirmed external effects never become another spawn, tell or settle on restart.
export async function advance({ route, state, board, bb, submissions, verify, authorize, recheckRejectedHandoff }) {
  checkRoute(route);
  if (typeof authorize !== 'function') throw new Error('Route admission is required');
  const binding = createHash('sha256').update(JSON.stringify(route)).digest('hex');
  let record = await state.load();
  if (record && record.binding !== binding) throw new Error('The enrolled route changed');
  const save = async patch => {
    record = patch === null ? null : { ...record, ...patch };
    await state.save(record);
  };
  const visible = () => ({ phase: record.phase, attemptId: record.attemptId,
    epoch: record.epoch, threadId: record.threadId, reason: record.reason, sha: record.sha });

  // Recovery may only reinterpret a rejected first envelope, never create an attempt.
  const recheck = recheckRejectedHandoff && record?.phase === 'hold' &&
    record.reason === 'invalid_or_stale_submission' && !record.turnSeq && record.seenShas.length === 0;
  if (recheckRejectedHandoff && !recheck) return { phase: 'hold', reason: 'no_rejected_handoff_to_recheck' };
  if (!record) {
    if (route.taskId) {
      if ((await board.lookup(route.taskId)).state !== 'ready') return { phase: 'idle' };
    }
    // В queue-режиме у authorize ещё нет карточки — allowlist допуска делает claimReady;
    // вторым аргументом контроллер всегда сообщает известный taskId (в legacy — маршрутный).
    if (!await authorize('ready', route.taskId)) {
      return { phase: 'hold', reason: 'route_not_authorized' };
    }
    await save({ binding, phase: 'claiming', attemptId: randomUUID(),
      token: randomBytes(32).toString('base64url'), seenShas: [] });
    try {
      let claim;
      let contract;
      if (route.taskId) {
        claim = await board.claim(route.taskId, { token: record.token });
      } else {
        const picked = await board.claimReady(queueFilter(route), { token: record.token });
        if (!picked) {
          await save(null);
          return { phase: 'idle' };
        }
        claim = picked;
        contract = contractOf(picked.labels);
      }
      if (!Number.isSafeInteger(claim.epoch) || claim.epoch < 1) throw new Error('No native claim epoch');
      await save({ phase: 'launching', taskId: claim.taskId ?? route.taskId, epoch: claim.epoch,
        until: claim.until, ...(contract ? { contract } : {}) });
      if (!await authorize('claimed', record.taskId)) {
        await save({ phase: 'hold', reason: 'route_changed_before_spawn' });
        return visible();
      }
      const proof = await board.verifyHeld(record.taskId, claim.epoch).catch(() => null);
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
  if (TERMINAL.has(record.phase) && !recheck) return visible();
  if (IN_FLIGHT.has(record.phase)) {
    await save({ phase: 'uncertain', reason: `interrupted_${record.phase}` });
    return visible();
  }
  if (record.phase !== 'working' && !recheck) throw new Error('Unknown attempt state');

  // After process restart the adapter can recover the same held capability. It cannot re-claim.
  try {
    await board.adopt(record.taskId ?? route.taskId, { epoch: record.epoch, token: record.token });
    const proof = await board.verifyHeld(record.taskId ?? route.taskId, record.epoch);
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
  // A legacy record remembers its checked SHA, but not which BB turn produced it.
  if (!after && record.seenShas.length && (!submission || record.seenShas.includes(submission.candidate_sha))) {
    return visible();
  }
  const stopWith = async reason => {
    await save({ phase: 'blocking', turnSeq });
    try {
      await board.block(attempt.task_id, attempt.epoch, `${reason}: ${attempt.bb_thread_id}, BB event ${turnSeq}. Проверьте ход; повтор не отправлен.`);
      await save({ phase: 'hold', reason });
    } catch {
      await save({ phase: 'uncertain', reason: 'handoff_block_unconfirmed' });
    }
    return visible();
  };
  if (!submission) return stopWith(after ? 'worker_turn_finished_without_new_handoff' : 'worker_turn_finished_without_handoff');
  const taskId = Number.isSafeInteger(submission.task_id) ? String(submission.task_id) : submission.task_id;
  if (taskId !== attempt.task_id || submission.epoch !== attempt.epoch ||
      submission.attempt_id !== attempt.attempt_id || submission.worker_thread_id !== attempt.bb_thread_id ||
      typeof submission.candidate_sha !== 'string' || !shaRE.test(submission.candidate_sha)) {
    return stopWith('invalid_or_stale_submission');
  }
  if (record.seenShas.includes(submission.candidate_sha)) return stopWith('worker_turn_finished_without_new_handoff');

  await save({ phase: 'checking', reason: undefined, sha: submission.candidate_sha, turnSeq,
    seenShas: [...record.seenShas, submission.candidate_sha] });
  const result = await verify(attempt, { ...submission, task_id: taskId });
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
