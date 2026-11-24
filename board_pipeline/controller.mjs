import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createQuestion, questionBlockText } from './question-gate.mjs';
import { advanceQuestion, QUESTION_PHASES } from './question-resume.mjs';
import { createReleasePackage, releaseQuestionDetails, ReleaseDenied } from './release-contract.mjs';
import { advanceRelease, RELEASE_PHASES } from './release-flow.mjs';
import { roundGate, roundSignature, effectiveL2ReworkLimit, l2ReworkLimitExceeded } from './worker-selector.mjs';
import { partitionFindingsBySeverity } from './review-policy.mjs';

const TERMINAL = new Set(['done', 'hold', 'uncertain', 'lease_lost']);
const IN_FLIGHT = new Set(['claiming', 'launching', 'checking', 'returning', 'blocking']);
const shaRE = /^[a-f0-9]{40}$/;

// Контракт приёмки, который карточка обязана нести в метках для захвата из очереди:
// разрешённый профиль, identity репозитория и валидные хэши спеки/политики.
const CONTRACT_LABELS = ['profile_id', 'repo_id', 'spec_digest', 'policy_digest'];

// Проекция находки критика на whitelist validateAttempt (#1670): критик волен
// вернуть любые ключи/значения — в verification.prior_findings уходят только
// примитивные поля приёмки, violates_dod переносится в dod_violation, строки
// обрезаются до 2000 символов.
const PRIOR_FINDING_KEYS = ['file', 'line', 'input', 'expected', 'actual', 'freq',
  'frequency', 'harm', 'severity', 'dod_violation'];

function projectPriorFinding(f) {
  const out = {};
  if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
    for (const k of PRIOR_FINDING_KEYS) {
      const v = f[k];
      if (v === undefined) continue;
      if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'string') out[k] = v.slice(0, 2000);
    }
    if (out.dod_violation === undefined && typeof f.violates_dod === 'boolean') {
      out.dod_violation = f.violates_dod;
    }
  }
  return out;
}

function isAllowlist(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  if (typeof a.owner !== 'string' || !a.owner) return false;
  const { key, value } = a.label ?? {};
  if (typeof key !== 'string' || !key || typeof value !== 'string' || !value) return false;
  if (a.required !== undefined &&
      (!Array.isArray(a.required) || !a.required.every(item => typeof item === 'string' && item))) return false;
  if (a.repoId !== undefined && (typeof a.repoId !== 'string' || !a.repoId)) return false;
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
  if (r.maxL2ReworkRounds !== undefined &&
      (!Number.isSafeInteger(r.maxL2ReworkRounds) || r.maxL2ReworkRounds < 1)) {
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
    ...(route.allowlist.repoId !== undefined ? { repoId: route.allowlist.repoId } : {}),
  };
}

function contractOf(labels) {
  return {
    repo_id: labels?.repo_id,
    spec_digest: labels?.spec_digest,
    policy_digest: labels?.policy_digest,
    fixtures_digest: typeof labels?.fixtures_digest === 'string' ? labels.fixtures_digest : null,
    // Явный L1-выбор оператора при постановке — контрактная метка:
    // контроллер обязан применить именно её, а не свой дефолт repo_id.
    // Значение передаётся без приведения: заданное нестроковое значение
    // обязано быть отклонено fail-closed на приёмке, а не трактоваться
    // как отсутствие метки.
    l1_profile: labels?.l1_profile,
    // Метка has_ui карточки может только ВКЛЮЧИТЬ L3; 'false' не выключает
    // обязательный profile.has_ui — решение остаётся у оператора.
    has_ui: labels?.has_ui === 'true' ? true : undefined,
    // Категория рутинной работы для policy-driven auto-approve (#1745):
    // контрактная метка карточки, не слово воркера.
    category: typeof labels?.category === 'string' ? labels.category : undefined,
    // Декларируемые предикаты skillPicker из меток карточки: boolean-метки
    // нормализуются 'true'/'false' → boolean, domain — id-строкой.
    labels: Object.fromEntries([
      ...['requires_lean', 'requires_colab', 'touches_migrations', 'pr_ci_red', 'test_first']
        .map(key => [key, labels?.[key] === 'true' ? true : labels?.[key] === 'false' ? false : undefined]),
      ['has_ui', labels?.has_ui === 'true' ? true : labels?.has_ui === 'false' ? false : undefined],
      ['domain', typeof labels?.domain === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(labels.domain)
        ? labels.domain : undefined],
    ].filter(([, value]) => value !== undefined)),
  };
}

function attemptOf(record, route) {
  const attempt = { task_id: record.taskId ?? route.taskId, attempt_id: record.attemptId, epoch: record.epoch,
    bb_thread_id: record.threadId, worktree: route.worktree, base_sha: route.base,
    check_profile: route.checkProfile, finish: route.finish };
  // Фактический исполнитель — executor; при восстановлении после lost spawn
  // известна только закреплённая первичная модель триады.
  attempt.executor = record.executor ?? record.triad?.worker;
  // Закреплённая триада попытки (Board #1263): spawn, L2-критик, арбитраж
  // и seal работают на одной тройке на всех тиках и после рестарта.
  if (record.triad !== undefined) attempt.triad = record.triad;
  if (record.contract) {
    attempt.repo_id = record.contract.repo_id;
    attempt.spec_digest = record.contract.spec_digest;
    attempt.policy_digest = record.contract.policy_digest;
    attempt.fixtures_digest = record.contract.fixtures_digest ?? null;
    if (record.contract.l1_profile !== undefined) attempt.l1_profile = record.contract.l1_profile;
    if (record.contract.has_ui !== undefined) attempt.has_ui = record.contract.has_ui;
    if (record.contract.category !== undefined) attempt.category = record.contract.category;
    if (record.contract.labels !== undefined) attempt.labels = record.contract.labels;
  }
  return attempt;
}

// One serialized tick. Board keeps the work queue; state records only effects of this attempt.
// Unconfirmed external effects never become another spawn, tell or settle on restart.
// workerSelector (опционально, обратная совместимость) реализует политику выбора
// исполнителя, кросс-семейственную триаду и содержательный арбитраж (спека §4).
export async function advance({ route, state, board, bb, submissions, verify, authorize,
  recheckRejectedHandoff, workerSelector, mutants, questionGate, release, decisionLedger }) {
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
    epoch: record.epoch, threadId: record.threadId, reason: record.reason, sha: record.sha,
    ...(record.question ? { question_id: record.question.question_id } : {}) });

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
        await save({ phase: record.question?.question_id === intent.questionId && intent.questionId
          ? 'awaiting_answer' : 'hold', reason: intent.reason ?? 'blocked',
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

  // Единый фактический критик/арбитр для триады: закреплённая триада
  // попытки важнее всего (одна тройка для spawn/L2/арбитража/seal и
  // после рестарта), затем настроенный селектор и маршрут; расхождение
  // route.critic с фактическим — отказ до claim.
  const pinnedTriad = record?.triad;
  const selCritic = workerSelector
    ? (pinnedTriad?.critic ?? workerSelector.critic ?? route.critic ?? workerSelector.DEFAULT_CRITIC) : undefined;
  const selArbiter = workerSelector
    ? (pinnedTriad?.arbiter ?? workerSelector.arbiter ?? route.arbiter ?? workerSelector.DEFAULT_ARBITER) : undefined;
  const criticMismatch = Boolean(workerSelector && route.critic && workerSelector.critic &&
    (route.critic.provider !== workerSelector.critic.provider ||
     route.critic.model !== workerSelector.critic.model ||
     (route.critic.reasoningLevel !== undefined &&
      route.critic.reasoningLevel !== workerSelector.critic.reasoningLevel)));

  // Recovery may only reinterpret a rejected first envelope, never create an attempt.
  const recheck = recheckRejectedHandoff && record?.phase === 'hold' &&
    record.reason === 'invalid_or_stale_submission' && !record.turnSeq && record.seenShas.length === 0;
  if (recheckRejectedHandoff && !recheck) return { phase: 'hold', reason: 'no_rejected_handoff_to_recheck' };
  if (!record) {
    // Кросс-семейственная триада отвергает маршрут до claim, если её нарушает
    // первичный исполнитель; резерв-нарушитель пропускается попыткой.
    if (workerSelector) {
      if (criticMismatch) {
        await save({ binding, phase: 'hold', reason: 'review_profile_mismatch', seenShas: [] });
        return visible();
      }
      try {
        const [primary] = workerSelector.selectWorker({ route });
        workerSelector.assertTriadIndependent({ executor: primary, critic: selCritic, arbiter: selArbiter });
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
      await board.project?.(record.taskId, claim.epoch, 'claimed');
      let launched;
      let workerTrail = null;
      if (workerSelector) {
        // Board #1263: триада резолвится ОДИН раз на попытку (pinTriad —
        // динамический routeTriad либо проверенный откат) и закрепляется в
        // записи: те же worker/critic/arbiter обслуживают spawn, L2,
        // арбитраж и seal на всех тиках и после рестарта. Деградация пина —
        // дефолтная триада, не повторное сканирование скоркарда.
        let pinned = null;
        if (typeof workerSelector.pinTriad === 'function') {
          try {
            pinned = await workerSelector.pinTriad({ route, attempt: attemptOf(record, route) });
          } catch {
            // Исключение пина — fail-closed: дефолтный воркер не запускается
            // на недоказанной триаде (ревью #1263 r2).
            await save({ phase: 'hold', reason: 'route_pin_failed' });
            return visible();
          }
        }
        if (pinned?.outcome === 'rejected') {
          // Карточка уже захвачена (claim выполнен до пина): отказ триады без
          // блока оставил бы бесхозный claim до истечения аренды — штатно
          // блокируем с причиной для владельца (#1666 r3).
          const reason = pinned.reason ?? 'route_rejected';
          const blockText = board.blockText?.(record.epoch, reason) ?? reason;
          await save({ phase: 'blocking',
            intent: { kind: 'block', attemptId: record.attemptId, epoch: record.epoch,
              reason, blockText: blockText.slice(0, 1000) } });
          try {
            await board.block(record.taskId, record.epoch, blockText);
            await save({ phase: 'hold', reason, receipt: { kind: 'block' } });
          } catch {
            return reconcileInFlight();
          }
          return visible();
        }
        const attemptCritic = pinned?.critic ?? selCritic;
        const attemptArbiter = pinned?.arbiter ?? selArbiter;
        const attemptPlan = Array.isArray(pinned?.plan) && pinned.plan.length
          ? pinned.plan : workerSelector.selectWorker({ route });
        // Триада закрепляется в записи ДО внешнего spawn: при потерянном
        // ответе reconcileSpawn восстанавливает попытку уже с триадой —
        // worker пишется по факту после выбора исполнителя.
        await save({ triad: { worker: attemptPlan[0], critic: attemptCritic, arbiter: attemptArbiter } });
        // Приоритет acp-devin/swe-2-high; резерв только при подтверждённом
        // отказе, неизвестный исход — карантин без второго писателя.
        const selection = await workerSelector.attemptSpawnWithFallback({
          route, attempt: attemptOf(record, route),
          critic: attemptCritic,
          arbiter: attemptArbiter,
          plan: attemptPlan,
          probe: typeof bb.probeAvailability === 'function' ? w => bb.probeAvailability(w) : undefined,
          // Перед КАЖДЫМ spawn (включая резерв) запись несёт фактического
          // кандидата: worker триады и executor — это запускаемый, иначе
          // reconcileSpawn восстановил бы первичного из плана.
          onBeforeSpawn: worker => save({ executor: worker,
            triad: { worker, critic: attemptCritic, arbiter: attemptArbiter } }),
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
          attemptedWorkers: selection.attemptedWorkers,
          // Закреплённая триада: worker уточняется по факту (резерв мог
          // подменить первичного), критик и арбитр — из пина выше.
          triad: { worker: selection.worker, critic: attemptCritic, arbiter: attemptArbiter } };
      } else {
        launched = await bb.spawn({ ...attemptOf(record, route), bb_thread_id: undefined });
      }
      if (!/^thr_[a-z0-9]+$/.test(launched?.threadId ?? '')) throw new Error('No confirmed BB thread');
      await save({ phase: 'working', threadId: launched.threadId,
        receipt: { kind: 'spawn', threadId: launched.threadId }, ...(workerTrail ?? {}) });
    } catch (e) {
      // Обрыв в любой точке claim/launch не повторяет эффект: та же сверка,
      // что и при рестарте процесса с записью IN_FLIGHT.
      process.stderr.write(board.project ? 'pilot claim/launch stopped; see private state\n' : `claim/launch error: ${e?.stack ?? e}\n`);
      return reconcileInFlight();
    }
    return visible();
  }
  if (TERMINAL.has(record.phase) && !recheck) return visible();
  if (QUESTION_PHASES.has(record.phase)) {
    if (!questionGate) throw new Error('An enrolled owner answer gate is required to resume');
    return advanceQuestion({ record, save, visible, board, gate: questionGate,
      feedback: ({ feedbackId, answer, question }) => bb.feedback({
        attempt: attemptOf(record, route), feedbackId, sha: question.checkpoint.sha,
        question, contract: record.contract, reason: 'owner_answer_confirmed',
        evidence: { questionId: question.question_id, ownerAnswer: answer },
      }), reconcileFeedback: reconcileInFlight, decisionLedger });
  }
  if (release && RELEASE_PHASES.has(record.phase)) {
    if (!questionGate) throw new ReleaseDenied('release_approval_unavailable');
    return advanceRelease({ record, save, visible, board, release, gate: questionGate, leaseAlive });
  }
  if (record.phase === 'release_ready') {
    if (!questionGate) throw new Error('An enrolled owner answer gate is required for release');
    if (!await leaseAlive()) return lostLease();
    if (!await questionGate.canResume({ stage: 'claimed', question: record.question,
      threadId: record.threadId, contract: record.contract })) {
      await save({ phase: 'hold', reason: 'question_resume_checkpoint_drift' });
    }
    return visible();
  }
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
    const privateText = `${reason}: ${attempt.bb_thread_id}, BB event ${turnSeq}.${detail ? ` ${detail}` : ''} Проверьте ход; повтор не отправлен.`;
    const blockText = board.blockText?.(attempt.epoch, privateText) ?? privateText;
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
  const askOwner = async ({ kind, prompt, evidence, result, extraState, releasePlan }) => {
    const sha = await questionGate.capture({ attempt, turnSeq });
    const candidateSha = result?.receipt?.evidence?.sha;
    if (!sha || (kind === 'release' && (sha !== record.sha || sha !== candidateSha ||
        !/^[a-f0-9]{64}$/.test(result.subject_digest ?? '') ||
        result.receipt.evidence.subject_digest !== result.subject_digest))) {
      return stopWith('owner_question_checkpoint_unconfirmed', extraState);
    }
    let question;
    try {
      question = createQuestion({ attempt, kind, prompt, evidence,
        principal: questionGate.principal, ttlMs: questionGate.ttlMs, now: questionGate.now(),
        checkpoint: { sha, turn_seq: turnSeq, subject_digest: result?.subject_digest,
          ...(releasePlan ? { release: releaseQuestionDetails(releasePlan) } : {}) },
      });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return stopWith('owner_question_too_large', extraState);
    }
    const blockText = questionBlockText(question);
    await save({ phase: 'blocking', turnSeq, question, ownerAnswer: null, ...(extraState ?? {}),
      releaseVerification: kind === 'release' ? result.receipt : null,
      releasePlan: releasePlan ?? null,
      intent: { kind: 'block', reason: 'owner_answer_required', questionId: question.question_id,
        attemptId: attempt.attempt_id, epoch: attempt.epoch, blockText } });
    try { await board.block(attempt.task_id, attempt.epoch, blockText); }
    catch { return reconcileInFlight(); }
    await save({ phase: 'awaiting_answer', reason: 'owner_answer_required', receipt: { kind: 'block' } });
    return visible();
  };
  let prepared;
  const askRelease = result => askOwner({ kind: 'release', result,
    ...(prepared ? {
      releasePlan: createReleasePackage({ ...prepared, source: attempt, subject_digest: result.subject_digest }),
      prompt: 'Разрешить изолированный выпуск?',
      evidence: 'Проверки и seal пройдены.',
    } : { prompt: 'Передать проверенный кандидат в стадию допуска к выпуску?',
      evidence: 'Проверки и seal пройдены. Ответ не запускает выпуск.' }) });
  if (!submission) return stopWith(after ? 'worker_turn_finished_without_new_handoff' : 'worker_turn_finished_without_handoff');
  const taskId = Number.isSafeInteger(submission.task_id) ? String(submission.task_id) : submission.task_id;
  if (taskId !== attempt.task_id || submission.epoch !== attempt.epoch ||
      submission.attempt_id !== attempt.attempt_id || submission.worker_thread_id !== attempt.bb_thread_id) {
    return stopWith('invalid_or_stale_submission');
  }
  if (questionGate && submission.question !== undefined) {
    const { prompt, evidence } = submission.question ?? {};
    if (submission.candidate_sha !== undefined || typeof prompt !== 'string' || !prompt.trim() ||
        prompt.length > 220 || typeof evidence !== 'string' || evidence.length > 120) {
      return stopWith('invalid_product_question');
    }
    return askOwner({ kind: 'product', prompt, evidence });
  }
  if (typeof submission.candidate_sha !== 'string' || !shaRE.test(submission.candidate_sha)) {
    return stopWith('invalid_or_stale_submission');
  }
  if (record.seenShas.includes(submission.candidate_sha)) return stopWith('worker_turn_finished_without_new_handoff');

  await save({ phase: 'checking', reason: undefined, sha: submission.candidate_sha, turnSeq,
    seenShas: [...record.seenShas, submission.candidate_sha] });
  if (release && route.finish === 'deployed') {
    try { prepared = await release.prepare(submission.candidate_sha); }
    catch (cause) { return stopWith(cause instanceof ReleaseDenied ? cause.code : 'release_prepare_failed'); }
  }
  // Diff-Scoped Round 2+ (#1745): следующий критик получает номер L2-раунда и
  // блокирующие находки прошлого раунда из доверенной истории попытки —
  // верификация проверяет закрытие P0/P1 и отсутствие новых регрессий,
  // а не полный аудит заново.
  const priorL2 = (record.roundsHistory ?? []).filter(r => r?.gate === 'l2');
  const lastL2 = priorL2.at(-1);
  // Блокирующие находки прошлого раунда; excerpt-only возражение (валидный
  // REVIEW_BLOCKED без structured findings) не пропадает из скоупа — оно
  // синтезируется в находку для критика.
  const priorBlocking = partitionFindingsBySeverity(lastL2?.findings).blocking
    .slice(0, 256).map(projectPriorFinding);
  const excerptFinding = !priorBlocking.length && typeof lastL2?.excerpt === 'string' &&
    lastL2.excerpt.trim()
    ? [{ file: 'review.excerpt', expected: lastL2.excerpt.slice(0, 2000),
        actual: 'blocking objection without structured findings' }]
    : [];
  const verification = { ...attempt,
    review_round: priorL2.length + 1,
    prior_findings: priorBlocking.length ? priorBlocking : excerptFinding,
    // Предыдущий проверенный SHA: раннеры строят инкрементальный diff
    // prior→current, отделяя новые регрессии от уже проверенных изменений.
    ...(shaRE.test(lastL2?.sha ?? '') ? { prior_sha: lastL2.sha } : {}),
    ...(prepared ? { release_target: { finish: 'deployed', target_id: prepared.target,
      release_channel: 'isolated-static', previous_live_digest: prepared.previous.digest } } : {}) };
  const result = await verify(verification, { ...submission, task_id: taskId });
  if (result.outcome === 'rework') {
    let roundsHistory;
    let arbitrationUsed = record.arbitrationUsed ?? 0;
    let feedbackReason = result.reason;
    let feedbackEvidence = result.feedback;
    let feedbackSuffix = '';
    // Раунд фиксируется в истории попытки независимо от селектора (#1666 r5):
    // без workerSelector история и лимитный L2-ревью-стоп те же. Сходящаяся
    // починка не ограничена счётчиком кругов — триггеры только содержательные.
    // tree_sha берётся из реальной инспекции снимка (result.tree_sha), не из
    // слов воркера.
    const roundGateOf = workerSelector?.roundGate ?? roundGate;
    const roundSignatureOf = workerSelector?.roundSignature ?? roundSignature;
    const effectiveL2LimitOf = workerSelector?.effectiveL2ReworkLimit ?? effectiveL2ReworkLimit;
    const l2LimitExceededOf = workerSelector?.l2ReworkLimitExceeded ?? l2ReworkLimitExceeded;
    const roundFindings = Array.isArray(result.feedback?.findings)
      ? result.feedback.findings : [];
    const round = {
      sha: submission.candidate_sha,
      tree_sha: result.tree_sha ?? result.receipt?.tree_sha ?? null,
      gate: roundGateOf(result),
      signature: roundSignatureOf(result),
      blocking: roundFindings.length ? roundFindings.length : null,
      findings: roundFindings,
      excerpt: result.feedback?.excerpt ?? null,
      checkpoint: result.feedback?.checkpoint ?? result.checkpoint ?? null,
      dispute: submission.dispute ?? null,
      contradictory: result.contradictory === true,
    };
    roundsHistory = [...(record.roundsHistory ?? []), round];
    // Circuit breaker L2 (Board #1666): лимитный L2-раунд останавливает
    // попытку без следующего круга и до арбитража — directed_rework был бы
    // пятым раундом. Эскалация — hold карточки владельцу с причиной.
    const l2Limit = effectiveL2LimitOf(route.maxL2ReworkRounds);
    if (l2LimitExceededOf({ roundsHistory, limit: l2Limit })) {
      return stopWith('l2_rework_limit_exceeded', { roundsHistory },
        JSON.stringify({ limit: l2Limit }));
    }
    if (workerSelector) {
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
            if (questionGate) return askRelease(sealed);
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
          if (questionGate && ruling.question.length <= 220) {
            return askOwner({ kind: 'product', prompt: ruling.question, evidence: 'Содержательный спор L2.',
              extraState: { roundsHistory } });
          }
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
    if (questionGate) return askRelease(result);
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

export async function advanceWithProjection(options) {
  const result = await advance(options);
  const { board, state, route } = options;
  if (!board.project || !['done', 'hold'].includes(result.phase)) return result;
  const record = await state.load();
  const taskId = record?.taskId ?? route.taskId;
  if (!taskId || !record?.epoch) return result;
  // A display write belongs outside the native claim/effect try blocks. If
  // it fails, the durable and native settlement are not rolled back or retried.
  if (result.phase === 'done') await board.project(taskId, record.epoch, 'completed', record.sha);
  else if ((await board.lookup(taskId)).state === 'blocked') await board.project(taskId, record.epoch, 'blocked');
  return result;
}
