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
    // Метка has_ui карточки — строка 'true'/'false'; отсутствие — undefined,
    // решение о L3 отдаётся профилю оператора (binding.has_ui ?? profile.has_ui).
    has_ui: labels?.has_ui === 'true' ? true : labels?.has_ui === 'false' ? false : undefined,
  };
}

function attemptOf(record, route) {
  const attempt = { task_id: record.taskId ?? route.taskId, attempt_id: record.attemptId, epoch: record.epoch,
    bb_thread_id: record.threadId, worktree: route.worktree, base_sha: route.base,
    check_profile: route.checkProfile, finish: route.finish };
  if (record.executor !== undefined) attempt.executor = record.executor;
  if (record.contract) {
    attempt.repo_id = record.contract.repo_id;
    attempt.spec_digest = record.contract.spec_digest;
    attempt.policy_digest = record.contract.policy_digest;
    attempt.fixtures_digest = record.contract.fixtures_digest ?? null;
    if (record.contract.has_ui !== undefined) attempt.has_ui = record.contract.has_ui;
  }
  return attempt;
}

// One serialized tick. Board keeps the work queue; state records only effects of this attempt.
// Unconfirmed external effects never become another spawn, tell or settle on restart.
// workerSelector (опционально, обратная совместимость) реализует политику выбора
// исполнителя, кросс-семейственную триаду и содержательный арбитраж (спека §4).
export async function advance({ route, state, board, bb, submissions, verify, authorize, recheckRejectedHandoff, workerSelector, mutants }) {
  checkRoute(route);
  if (typeof authorize !== 'function') throw new Error('Route admission is required');
  const hazards = mutants ?? {};
  const binding = createHash('sha256').update(JSON.stringify(route)).digest('hex');
  let record = await state.load();
  if (record && record.binding !== binding) throw new Error('The enrolled route changed');
  const save = async patch => {
    record = patch === null ? null : { ...record, ...patch };
    await state.save(record);
  };
  const visible = () => ({ phase: record.phase, attemptId: record.attemptId,
    epoch: record.epoch, threadId: record.threadId, reason: record.reason, sha: record.sha });

  // Долговечный WAL: перед spawn/feedback/block пишется intent, после
  // подтверждения — receipt. Рестарт с IN_FLIGHT записью никогда не повторяет
  // эффект вслепую: сначала детерминированная сверка с внешним миром.
  const leaseAlive = async () => {
    try {
      await board.adopt(record.taskId ?? route.taskId, { epoch: record.epoch, token: record.token });
      const proof = await board.verifyHeld(record.taskId ?? route.taskId, record.epoch);
      return proof.epoch === record.epoch;
    } catch {
      return false;
    }
  };
  const lostLease = async () => {
    await save({ phase: 'lease_lost', reason: 'no_verified_claim_keep_worktree_reserved' });
    return visible();
  };
  const reconcileInFlight = async quarantineReason => {
    const taskId = record.taskId ?? route.taskId;
    const intent = record.intent;
    const uncertain = async reason => {
      await save({ phase: 'uncertain', reason, receipt: { status: 'unconfirmed' } });
      return visible();
    };
    if (record.phase === 'blocking' && intent?.kind === 'block') {
      // block уже мог достичь Board до обрыва: факт сверяется с карточкой,
      // повторный board.block не отправляется никогда. Совпадения только
      // state==='blocked' мало — причина на карточке обязана быть нашей:
      // либо точный текст эффекта, либо префикс `${intent.reason}:`.
      const looked = await board.lookup(taskId).catch(() => null);
      const cardReason = looked?.blocked?.reason ?? looked?.reason;
      // Только строгое равенство записанного текста эффекта: совпадение
      // префикса при другом содержимом (например, чужой `BB event N`) — не
      // наша блокировка.
      const reasonMatches = typeof intent.blockText === 'string' && intent.blockText.length > 0 &&
        cardReason === intent.blockText;
      if (looked?.state === 'blocked' &&
          (looked.epoch === undefined || looked.epoch === intent.epoch) && reasonMatches) {
        await save({ phase: 'hold', reason: intent.reason ?? 'blocked',
          receipt: { kind: 'block', confirmed: 'observed' } });
        return visible();
      }
      if (looked?.state === 'blocked') return uncertain('blocking_reason_mismatch');
      return uncertain('block_outcome_unconfirmed');
    }
    if (record.phase === 'launching' && intent?.kind === 'spawn') {
      if (!await leaseAlive()) return lostLease();
      if (typeof bb.reconcileSpawn !== 'function') {
        return uncertain(quarantineReason ?? 'spawn_outcome_unconfirmed_quarantine');
      }
      const res = await bb.reconcileSpawn(attemptOf(record, route)).catch(() => null);
      // GUARD:NoDuplicateSpawn — только ровно одно точное совпадение маркера
      // при живой аренде подхватывает тред; empty/ambiguous/ошибка — карантин
      // с сохранением брони worktree и нулём повторных bb.spawn.
      const confirmed = res?.status === 'matched' && /^thr_[a-z0-9]+$/.test(res.threadId ?? '');
      if (hazards.retrySpawnOnEmpty && !confirmed) {
        try {
          const retried = await bb.spawn(attemptOf(record, route));
          if (/^thr_[a-z0-9]+$/.test(retried?.threadId ?? '')) {
            await save({ phase: 'working', threadId: retried.threadId,
              receipt: { kind: 'spawn', threadId: retried.threadId, confirmed: 'unsafe_retry' } });
            return visible();
          }
        } catch { /* fall through to quarantine */ }
      }
      if (!confirmed) return uncertain(quarantineReason ?? 'spawn_outcome_unconfirmed_quarantine');
      if (!await leaseAlive()) return lostLease();
      await save({ phase: 'working', threadId: res.threadId,
        receipt: { kind: 'spawn', threadId: res.threadId, confirmed: 'reconciled' } });
      return visible();
    }
    if (record.phase === 'returning' && intent?.kind === 'feedback') {
      if (!await leaseAlive()) return lostLease();
      if (typeof bb.reconcileFeedback !== 'function') {
        return uncertain('feedback_delivery_unconfirmed');
      }
      const res = await bb.reconcileFeedback({
        attempt: attemptOf(record, route),
        feedbackId: intent.feedbackId ?? record.feedbackId,
        threadId: record.threadId,
        afterSeq: intent.turnSeq,
      }).catch(() => null);
      if (res?.status !== 'delivered') return uncertain('feedback_delivery_unconfirmed');
      if (!await leaseAlive()) return lostLease();
      await save({ phase: 'working',
        receipt: { kind: 'feedback', feedbackId: intent.feedbackId, confirmed: 'reconciled' } });
      return visible();
    }
    // claiming/checking или отсутствующий intent: внешний эффект не доказан.
    return uncertain(`interrupted_${record.phase}`);
  };

  // Единый фактический критик/арбитр для триады: настроенный селектор важнее
  // маршрутного; расхождение route.critic с фактическим — отказ до claim.
  const selCritic = workerSelector
    ? (workerSelector.critic ?? route.critic ?? workerSelector.DEFAULT_CRITIC) : undefined;
  const selArbiter = workerSelector
    ? (workerSelector.arbiter ?? route.arbiter ?? workerSelector.DEFAULT_ARBITER) : undefined;
  const criticMismatch = Boolean(workerSelector && route.critic && workerSelector.critic &&
    (route.critic.provider !== workerSelector.critic.provider ||
     route.critic.model !== workerSelector.critic.model));

  // Recovery may only reinterpret a rejected first envelope, never create an attempt.
  const recheck = recheckRejectedHandoff && record?.phase === 'hold' &&
    record.reason === 'invalid_or_stale_submission' && !record.turnSeq && record.seenShas.length === 0;
  if (recheckRejectedHandoff && !recheck) return { phase: 'hold', reason: 'no_rejected_handoff_to_recheck' };
  if (!record) {
    // Кросс-семейственная триада отвергает маршрут до claim — для ВСЕХ
    // кандидатов цепочки: нарушивший независимость резерв блокирует маршрут.
    if (workerSelector) {
      if (criticMismatch) {
        await save({ binding, phase: 'hold', reason: 'review_profile_mismatch', seenShas: [] });
        return visible();
      }
      try {
        for (const candidate of workerSelector.selectWorker({ route, zcodeQuota: route.zcodeQuota })) {
          workerSelector.assertTriadIndependent({ executor: candidate, critic: selCritic, arbiter: selArbiter });
        }
      } catch (e) {
        await save({ binding, phase: 'hold',
          reason: `route_triad_violation:${e.reason ?? e.message}`, seenShas: [] });
        return visible();
      }
    }
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
        until: claim.until, ...(contract ? { contract } : {}),
        intent: { kind: 'spawn', attemptId: record.attemptId, epoch: claim.epoch,
          marker: record.attemptId } });
      if (!await authorize('claimed', record.taskId)) {
        await save({ phase: 'hold', reason: 'route_changed_before_spawn' });
        return visible();
      }
      const proof = await board.verifyHeld(record.taskId, claim.epoch).catch(() => null);
      if (proof?.epoch !== claim.epoch) {
        await save({ phase: 'lease_lost', reason: 'lease_lost_before_spawn' });
        return visible();
      }
      let launched;
      let workerTrail = null;
      if (workerSelector) {
        // Приоритет acp-devin/swe-2-high; резерв только при подтверждённом
        // отказе, неизвестный исход — карантин без второго писателя.
        const selection = await workerSelector.attemptSpawnWithFallback({
          route, attempt: attemptOf(record, route),
          zcodeQuota: route.zcodeQuota,
          critic: selCritic,
          arbiter: selArbiter,
          probe: typeof bb.probeAvailability === 'function' ? w => bb.probeAvailability(w) : undefined,
          spawn: envelope => bb.spawn(envelope),
          inspectWorktree: typeof bb.inspectWorktree === 'function'
            ? att => bb.inspectWorktree(att) : undefined,
        });
        if (selection.outcome === 'uncertain') {
          // Неизвестный исход запуска — тот же случай, что обрыв процесса с
          // незакрытым intent(spawn): сначала сверка, потом карантин.
          await save({ attemptedWorkers: selection.attemptedWorkers });
          return reconcileInFlight('worker_launch_outcome_unknown');
        }
        if (selection.outcome !== 'spawned') {
          await save({ phase: 'hold', reason: selection.reason ?? 'no_available_worker',
            attemptedWorkers: selection.attemptedWorkers });
          return visible();
        }
        launched = { threadId: selection.threadId };
        workerTrail = { executor: selection.worker, fallbackReason: selection.fallbackReason ?? null,
          attemptedWorkers: selection.attemptedWorkers };
      } else {
        launched = await bb.spawn({ ...attemptOf(record, route), bb_thread_id: undefined });
      }
      if (!/^thr_[a-z0-9]+$/.test(launched?.threadId ?? '')) throw new Error('No confirmed BB thread');
      await save({ phase: 'working', threadId: launched.threadId,
        receipt: { kind: 'spawn', threadId: launched.threadId }, ...(workerTrail ?? {}) });
    } catch {
      // Обрыв в любой точке claim/launch не повторяет эффект: та же сверка,
      // что и при рестарте процесса с записью IN_FLIGHT.
      return reconcileInFlight();
    }
    return visible();
  }
  if (TERMINAL.has(record.phase) && !recheck) return visible();
  if (IN_FLIGHT.has(record.phase)) return reconcileInFlight();
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
  // GUARD:NoWatermarkRegression — ход не новее watermark никогда не засчитывается
  // за ответ на уже отправленный feedback.
  if (!observation || !Number.isSafeInteger(observation.turnSeq) ||
      (!hazards.staleTurnWatermark && observation.turnSeq <= after)) return visible();
  const { submission, turnSeq } = observation;
  // A legacy record remembers its checked SHA, but not which BB turn produced it.
  if (!after && record.seenShas.length && (!submission || record.seenShas.includes(submission.candidate_sha))) {
    return visible();
  }
  const stopWith = async (reason, extraState = null, detail = '') => {
    const blockText = `${reason}: ${attempt.bb_thread_id}, BB event ${turnSeq}.${detail ? ` ${detail}` : ''} Проверьте ход; повтор не отправлен.`;
    await save({ phase: 'blocking', turnSeq,
      intent: { kind: 'block', attemptId: record.attemptId, epoch: attempt.epoch,
        turnSeq, reason, blockText: blockText.slice(0, 1000) },
      ...(extraState ?? {}) });
    try {
      await board.block(attempt.task_id, attempt.epoch, blockText);
      await save({ phase: 'hold', reason, receipt: { kind: 'block' } });
    } catch {
      return reconcileInFlight();
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
    let roundsHistory;
    let arbitrationUsed = record.arbitrationUsed ?? 0;
    let feedbackReason = result.reason;
    let feedbackEvidence = result.feedback;
    let feedbackSuffix = '';
    if (workerSelector) {
      // Раунд фиксируется в истории попытки; сходящаяся починка не ограничена
      // счётчиком кругов — триггеры только содержательные. tree_sha берётся из
      // реальной инспекции снимка (result.tree_sha), не из слов воркера.
      const roundFindings = Array.isArray(result.feedback?.findings)
        ? result.feedback.findings : [];
      const round = {
        sha: submission.candidate_sha,
        tree_sha: result.tree_sha ?? result.receipt?.tree_sha ?? null,
        gate: workerSelector.roundGate(result),
        signature: workerSelector.roundSignature(result),
        blocking: roundFindings.length ? roundFindings.length : null,
        findings: roundFindings,
        excerpt: result.feedback?.excerpt ?? null,
        checkpoint: result.feedback?.checkpoint ?? result.checkpoint ?? null,
        dispute: submission.dispute ?? null,
        contradictory: result.contradictory === true,
      };
      roundsHistory = [...(record.roundsHistory ?? []), round];
      const progress = workerSelector.evaluateReworkProgress({ roundsHistory });
      if (progress.trigger === 'no_progress' && progress.deterministicGate) {
        // Красный детерминированный гейт без прогресса не арбитрируется.
        return stopWith('no_progress_deterministic_gate', { roundsHistory },
          JSON.stringify(progress.evidence ?? {}));
      }
      if (progress.trigger) {
        const subjectDigest = result.subject_digest ?? result.receipt?.subject_digest ?? null;
        // Спор/принятие оценивается по объединённым замечаниям: текущий раунд
        // плюс все предыдущие L2-раунды — harm=10 или DoD из прошлого раунда
        // не исчезает при новой находке.
        const priorL2Findings = roundsHistory.slice(0, -1)
          .filter(r => r.gate === 'l2')
          .flatMap(r => Array.isArray(r.findings) ? r.findings : []);
        const allFindings = [...priorL2Findings, ...roundFindings];
        const ruling = await workerSelector.resolveArbitration({
          attempt, trigger: progress, arbitrationUsed,
          arbiter: selArbiter,
          critic: selCritic,
          maxHarm: workerSelector.maxHarmOf(allFindings),
          subjectDigest,
          dodViolation: workerSelector.hasDodViolation?.(allFindings) === true,
          verifyHeld: (id, ep) => board.verifyHeld(id, ep),
          arbitrate: workerSelector.arbitrate,
        });
        if (ruling.decision === 'lease_lost') {
          await save({ phase: 'lease_lost', reason: ruling.reason, roundsHistory });
          return visible();
        }
        if (ruling.decision === 'directed_rework') {
          arbitrationUsed = 1;
          feedbackReason = 'arbiter_directed_rework';
          feedbackEvidence = { directive: ruling.directive, findings: ruling.findings,
            trigger: progress.kind };
          feedbackSuffix = ':arb';
        } else if (ruling.decision === 'accept_with_notes') {
          // Принятие арбитра никогда не обходит печать: перед complete
          // выполняется полный seal (inspect, закреплённые входы, живые метки
          // карточки, verifyHeld) на стороне приёмки.
          if (typeof result.sealAndComplete !== 'function') {
            return stopWith('seal_port_missing', { roundsHistory });
          }
          await save({ phase: 'checking', roundsHistory, arbitrationUsed: 1,
            arbitration: ruling.receipt });
          const sealed = await result.sealAndComplete(ruling.receipt)
            .catch(e => ({ outcome: 'uncertain', reason: `seal_failed:${e?.message ?? e}` }));
          if (sealed.outcome === 'verified' && sealed.receipt?.settle === 'completed' &&
              route.finish === 'verified') {
            const settled = await board.lookup(attempt.task_id).catch(() => null);
            if (settled?.state !== 'completed' || settled.result?.sha !== submission.candidate_sha) {
              await save({ phase: 'uncertain', reason: 'completed_sha_not_confirmed' });
            } else {
              await save({ phase: 'done' });
            }
            return visible();
          }
          if (sealed.outcome === 'verified' && sealed.receipt?.settle === 'deferred') {
            const blockText = `Выпуск не разрешён этим контуром. Проверен SHA ${record.sha}`;
            await save({ phase: 'blocking',
              intent: { kind: 'block', attemptId: record.attemptId, epoch: attempt.epoch,
                reason: 'release_not_authorized', blockText: blockText.slice(0, 1000) } });
            try {
              await board.block(attempt.task_id, attempt.epoch, blockText);
              await save({ phase: 'hold', reason: 'release_not_authorized',
                receipt: { kind: 'block' } });
            } catch {
              return reconcileInFlight();
            }
            return visible();
          }
          if (sealed.outcome === 'denied' && /claim_not_held/.test(sealed.reason ?? '')) {
            await save({ phase: 'lease_lost', reason: sealed.reason });
            return visible();
          }
          if (sealed.outcome === 'uncertain') {
            await save({ phase: 'uncertain', reason: sealed.reason ?? 'arbitrated_seal_unconfirmed' });
            return visible();
          }
          // hold из приёмки: карточка уже заблокирована с причиной.
          await save({ phase: 'hold', reason: sealed.reason ?? 'arbitrated_seal_failed' });
          return visible();
        } else if (ruling.decision === 'escalate_owner') {
          return stopWith('arbiter_escalated_to_owner', { roundsHistory }, ruling.question);
        } else {
          return stopWith(ruling.reason ?? 'arbitration_hold', { roundsHistory },
            JSON.stringify(ruling.evidence ?? {}));
        }
      }
    }
    const proof = await board.verifyHeld(attempt.task_id, attempt.epoch).catch(() => null);
    if (proof?.epoch !== attempt.epoch) {
      await save({ phase: 'lease_lost', reason: 'lease_lost_before_feedback', ...(roundsHistory ? { roundsHistory } : {}) });
      return visible();
    }
    const feedbackId = `${attempt.attempt_id}:${submission.candidate_sha}${feedbackSuffix}`;
    await save({ phase: 'returning', feedbackId,
      intent: { kind: 'feedback', attemptId: record.attemptId, epoch: attempt.epoch,
        feedbackId, sha: submission.candidate_sha, turnSeq },
      ...(roundsHistory ? { roundsHistory } : {}), arbitrationUsed });
    const sent = await bb.feedback({ attempt, feedbackId, sha: submission.candidate_sha,
      reason: feedbackReason, evidence: feedbackEvidence })
      .catch(() => null);
    if (!sent?.confirmed) return reconcileInFlight();
    await save({ phase: 'working', receipt: { kind: 'feedback', feedbackId } });
  } else if (result.outcome === 'verified' && result.receipt?.settle === 'completed' && route.finish === 'verified') {
    const settled = await board.lookup(attempt.task_id);
    if (settled.state !== 'completed' || settled.result?.sha !== submission.candidate_sha) {
      await save({ phase: 'uncertain', reason: 'completed_sha_not_confirmed' });
    } else {
      await save({ phase: 'done' });
    }
  } else if (result.outcome === 'verified' && result.receipt?.settle === 'deferred' && route.finish === 'deployed') {
    const blockText = `Выпуск не разрешён этим контуром. Проверен SHA ${record.sha}`;
    await save({ phase: 'blocking',
      intent: { kind: 'block', attemptId: record.attemptId, epoch: attempt.epoch,
        reason: 'release_not_authorized', blockText: blockText.slice(0, 1000) } });
    try {
      await board.block(attempt.task_id, attempt.epoch, blockText);
      await save({ phase: 'hold', reason: 'release_not_authorized', receipt: { kind: 'block' } });
    } catch {
      return reconcileInFlight();
    }
  } else {
    await save({ phase: result.outcome === 'uncertain' ? 'uncertain' : 'hold', reason: result.reason ?? 'unverified' });
  }
  return visible();
}
