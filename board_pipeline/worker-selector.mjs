// Политика выбора исполнителя, кросс-семейственная триада и содержательный
// арбитраж (Implementation Decisions §4 спеки). Никакого правила «два круга и
// закрыть»: нормальная сходящаяся починка не обрывается по счётчику кругов.
//
// Переключение на резерв допускается ТОЛЬКО при подтверждённом отказе
// (confirmed_refusal) первичного провайдера до любых правок worktree.
// Неизвестный исход (потерянный ответ, транспортный таймаут, пустая/неоднозначная
// выдача BB, фоновые агенты, грязный worktree) — uncertain без второго писателя.

import { executorFamily, ReviewDenied } from './review-runner.mjs';

// Согласованная политика исполнителей: первичный, согласованный резерв и
// узкий резерв (только при явном allowNarrowReserve в маршруте).
export const PRIMARY_WORKER = Object.freeze({ provider: 'acp-devin', model: 'swe-2-high' });
export const FALLBACK_ZCODE = Object.freeze({
  provider: 'acp-zcode-start',
  model: 'builtin:zai-start-plan\\GLM-5.3-Flash',
  effort: 'max',
});
export const NARROW_RESERVE_PI = Object.freeze({
  provider: 'pi',
  model: 'opencode-go/deepseek-v4.1-flash',
});

// Дефолтный критик и арбитр третьего независимого семейства.
export const DEFAULT_CRITIC = Object.freeze({
  provider: 'openai',
  model: 'gpt-6.2-sol',
  reasoningLevel: 'medium',
});
export const DEFAULT_ARBITER = Object.freeze({
  provider: 'google',
  model: 'gemini-4-neon',
  reasoningLevel: 'high',
});

const DETERMINISTIC_GATES = new Set(['l1', 'tamper', 'l3']);
const GATE_BY_REASON = new Map([
  ['local_checks_failed', 'l1'],
  ['tamper_gate_failed', 'tamper'],
  ['visual_gate_failed', 'l3'],
]);

// Семейство по строгой таблице review-runner. У harness-исполнителей
// (provider 'pi') семейство определяет модель вида 'provider/model' —
// иначе пара provider+model обязана быть из одного семейства.
export function workerFamily(worker) {
  const direct = executorFamily(worker);
  if (direct !== null) return direct;
  if (worker !== null && typeof worker === 'object' &&
      typeof worker.model === 'string' && worker.model.includes('/')) {
    return executorFamily(worker.model);
  }
  return null;
}

// Упорядоченный план исполнителей маршрута. Узкий резерв входит в план
// только при явном допуске в маршруте — не как общий автозаменитель.
export function selectWorker({ route } = {}) {
  const plan = [PRIMARY_WORKER, FALLBACK_ZCODE];
  if (route?.allowNarrowReserve === true) plan.push(NARROW_RESERVE_PI);
  return plan;
}

// Триада: family(critic) !== family(executor) и арбитр из третьего
// независимого семейства — как для первичного воркера, так и после
// любого переключения на резерв.
export function assertTriadIndependent({ executor, critic = DEFAULT_CRITIC, arbiter = DEFAULT_ARBITER }) {
  const ef = executor !== undefined ? workerFamily(executor) : null;
  const cf = executorFamily(critic);
  const af = arbiter !== undefined && arbiter !== null ? workerFamily(arbiter) : null;
  if (cf === null) throw new ReviewDenied('review_unknown_family');
  if (executor !== undefined) {
    if (ef === null) throw new ReviewDenied('review_unknown_family');
    if (ef === cf) throw new ReviewDenied('review_same_family');
  }
  if (arbiter !== undefined && arbiter !== null) {
    if (af === null) throw new ReviewDenied('arbiter_unknown_family');
    if (af === cf || (ef !== null && af === ef)) {
      throw new ReviewDenied('arbiter_family_not_independent');
    }
  }
  return { executor: ef, critic: cf, arbiter: af };
}

// Нормализация ответа probeAvailability: 'available', 'confirmed_refusal'
// или 'unknown_outcome'. Пустая/неоднозначная выдача — неизвестный исход.
function probeStatus(probeResult) {
  if (probeResult === undefined || probeResult === null) return 'unknown_outcome';
  if (typeof probeResult === 'string') return probeStatus({ status: probeResult });
  if (typeof probeResult !== 'object' || Array.isArray(probeResult)) return 'unknown_outcome';
  return ['available', 'confirmed_refusal'].includes(probeResult.status)
    ? probeResult.status : 'unknown_outcome';
}

// Явный подтверждённый отказ первого хода: провайдер отказал при нуле
// фоновых агентов и чистом неизменном worktree на base_sha.
function isConfirmedSpawnRefusal(launched) {
  return launched !== null && typeof launched === 'object' &&
    launched.status === 'confirmed_refusal' &&
    launched.activeBackgroundAgentCount === 0 && launched.worktreeClean === true;
}

// Последовательный запуск по плану с честным различением исходов.
// probe(worker) → 'available' | 'confirmed_refusal' | { status, zcodeQuota };
// spawn(attempt) → { threadId } либо конверт подтверждённого отказа.
export async function attemptSpawnWithFallback({ route, attempt, probe, spawn, plan }) {
  const order = plan ?? selectWorker({ route });
  const attemptedWorkers = [];
  let lastRefusal = null;
  for (const worker of order) {
    let probed = { status: 'available' };
    if (typeof probe === 'function') {
      try {
        probed = await probe(worker);
      } catch {
        probed = null;
      }
    }
    const status = probeStatus(probed);
    if (status === 'unknown_outcome') {
      // Неизвестный исход наблюдения: второго писателя и слепого переключения нет.
      return {
        outcome: 'uncertain',
        reason: 'worker_launch_outcome_unknown',
        attemptedWorkers: [...attemptedWorkers,
          { ...worker, family: workerFamily(worker), verdict: 'unknown_outcome' }],
      };
    }
    if (status === 'confirmed_refusal') {
      const reason = `confirmed_refusal:${worker.provider}`;
      attemptedWorkers.push({ ...worker, family: workerFamily(worker), verdict: 'confirmed_refusal', reason });
      lastRefusal = reason;
      continue;
    }
    // Согласованный резерв ZCode — только при подтверждённой доступности/квоте.
    if (worker === FALLBACK_ZCODE && probed?.zcodeQuota !== undefined &&
        probed.zcodeQuota !== 'available') {
      const reason = 'zcode_quota_unavailable';
      attemptedWorkers.push({ ...worker, family: workerFamily(worker), verdict: 'confirmed_refusal', reason });
      lastRefusal = reason;
      continue;
    }
    let launched;
    try {
      launched = await spawn({ ...attempt, executor: worker });
    } catch {
      return {
        outcome: 'uncertain',
        reason: 'worker_launch_outcome_unknown',
        attemptedWorkers,
      };
    }
    if (isConfirmedSpawnRefusal(launched)) {
      const reason = `confirmed_refusal:${worker.provider}`;
      attemptedWorkers.push({ ...worker, family: workerFamily(worker), verdict: 'confirmed_refusal', reason });
      lastRefusal = reason;
      continue;
    }
    if (/^thr_[a-z0-9]+$/.test(launched?.threadId ?? '')) {
      return {
        outcome: 'spawned',
        worker,
        threadId: launched.threadId,
        // Причина переключения обязательна в состоянии попытки и квитанции.
        fallbackReason: lastRefusal,
        attemptedWorkers: [...attemptedWorkers,
          { ...worker, family: workerFamily(worker), verdict: 'spawned' }],
      };
    }
    // Неоднозначный ответ spawn: возможен живой писатель — карантин.
    return {
      outcome: 'uncertain',
      reason: 'worker_launch_outcome_unknown',
      attemptedWorkers: [...attemptedWorkers,
        { ...worker, family: workerFamily(worker), verdict: 'unknown_outcome' }],
    };
  }
  return {
    outcome: 'unavailable',
    reason: 'all_workers_confirmed_refused',
    attemptedWorkers,
  };
}

// Гейт раунда по причине возврата: детерминированные L1/tamper/L3 отделены от L2.
export function roundGate(result) {
  const reason = result?.reason ?? '';
  if (GATE_BY_REASON.has(reason)) return GATE_BY_REASON.get(reason);
  if (reason.startsWith('review_verdict')) return 'l2';
  return 'l1';
}

// Сигнатура отказа раунда: для детерминированных гейтов — причина и явная
// сигнатура проверки; для L2 — канонические поля blocking-findings.
export function roundSignature(result) {
  const explicit = result?.signature ?? result?.feedback?.signature;
  if (typeof explicit === 'string' && explicit) return `${result?.reason ?? ''}|${explicit}`;
  const findings = result?.feedback?.findings;
  if (Array.isArray(findings) && findings.length) {
    return findings.map(f => `${f?.file ?? ''}|${f?.expected ?? ''}|${f?.actual ?? ''}`).join(';;');
  }
  return result?.reason ?? '';
}

// Структурированный спор воркера: ссылка на замечание, аргументация и опора
// на спеку — всё непустые строки.
export function validDispute(dispute) {
  return dispute !== null && typeof dispute === 'object' && !Array.isArray(dispute) &&
    ['finding_ref', 'justification', 'spec_evidence'].every(
      k => typeof dispute[k] === 'string' && dispute[k].trim().length > 0);
}

// Детектор отсутствия прогресса и содержательного спора. roundsHistory —
// включая последний раунд (поля: gate, signature, blocking, tree_sha, dispute,
// contradictory). Сходящаяся починка любой длины триггеров не даёт.
export function evaluateReworkProgress({ roundsHistory = [] } = {}) {
  const latest = roundsHistory.at(-1);
  if (!latest) return { trigger: null };
  // Содержательный спор допустим только против замечания L2: детерминированные
  // гейты при этом заведомо зелёные (до ревью кандидат не доходил бы).
  if (latest.gate === 'l2' && validDispute(latest.dispute)) {
    return { trigger: 'substantive_dispute', kind: 'worker_dispute', evidence: latest.dispute };
  }
  if (latest.gate === 'l2' && latest.contradictory === true) {
    return { trigger: 'substantive_dispute', kind: 'contradictory_l2_requirements',
      evidence: latest };
  }
  // Повторный tree_sha уже встречался в этой попытке — прогресса нет.
  if (typeof latest.tree_sha === 'string' && latest.tree_sha &&
      roundsHistory.slice(0, -1).some(r => r.tree_sha === latest.tree_sha)) {
    return { trigger: 'no_progress', kind: 'duplicate_tree_sha',
      deterministicGate: DETERMINISTIC_GATES.has(latest.gate), evidence: latest };
  }
  const prev = roundsHistory.at(-2);
  if (!prev) return { trigger: null };
  // Два раза подряд красный детерминированный гейт с той же сигнатурой отказа.
  if (DETERMINISTIC_GATES.has(latest.gate) && prev.gate === latest.gate &&
      latest.signature && prev.signature === latest.signature) {
    return { trigger: 'no_progress', kind: 'repeated_deterministic_failure',
      deterministicGate: true, evidence: latest };
  }
  // Два раза подряд L2 REWORK: тот же дефект или число блокирующих не сократилось.
  if (latest.gate === 'l2' && prev.gate === 'l2' &&
      ((latest.signature && prev.signature === latest.signature) ||
        (Number.isSafeInteger(latest.blocking) && Number.isSafeInteger(prev.blocking) &&
          latest.blocking >= prev.blocking))) {
    return { trigger: 'no_progress', kind: 'repeated_l2_finding',
      deterministicGate: false, evidence: latest };
  }
  return { trigger: null };
}

// Максимальный harm среди findings вердикта: 10 — деньги/данные/секреты/выкладка,
// только владелец.
export function maxHarmOf(findings) {
  if (!Array.isArray(findings)) return 0;
  return findings.reduce((m, f) => Math.max(m, Number.isSafeInteger(f?.harm) ? f.harm : 0), 0);
}

// Содержательный арбитраж. Арбитр никогда не обходит красный L1/tamper/L3,
// не ослабляет спеку и не принимает harm=10. Не более одного вызова на попытку.
// arbitrate({ arbiter, task_id, epoch, attempt_id, subject_digest, trigger, evidence })
// — порт к модели арбитра; ответ обязан быть строго типизированным решением.
export async function resolveArbitration({
  attempt, trigger, arbitrationUsed = 0, arbiter = DEFAULT_ARBITER, critic = DEFAULT_CRITIC,
  maxHarm = 0, subjectDigest = null, verifyHeld, arbitrate,
} = {}) {
  const evidence = trigger?.evidence ?? null;
  // Красный детерминированный гейт не арбитрируется: прямой hold владельцу.
  if (trigger?.kind === 'repeated_deterministic_failure' ||
      (trigger?.trigger === 'no_progress' && trigger?.deterministicGate === true)) {
    return { decision: 'hold', reason: 'no_progress_deterministic_gate', evidence };
  }
  if (maxHarm >= 10) {
    return { decision: 'hold', reason: 'harm10_requires_owner', evidence };
  }
  if (arbiter === undefined || arbiter === null) {
    return { decision: 'hold', reason: 'arbiter_unavailable', evidence };
  }
  try {
    assertTriadIndependent({ executor: attempt?.executor ?? PRIMARY_WORKER, critic, arbiter });
  } catch {
    return { decision: 'hold', reason: 'arbiter_unavailable', evidence };
  }
  if (arbitrationUsed >= 1) {
    return { decision: 'hold', reason: 'arbitration_exhausted', evidence };
  }
  // Аренда подтверждается до вызова арбитра.
  if (typeof verifyHeld === 'function') {
    try {
      const live = await verifyHeld(attempt.task_id, attempt.epoch);
      if (live?.epoch !== attempt.epoch) throw new Error('epoch_mismatch');
    } catch {
      return { decision: 'lease_lost', reason: 'lease_lost_before_arbitration', evidence };
    }
  }
  if (typeof arbitrate !== 'function') {
    return { decision: 'hold', reason: 'arbiter_unavailable', evidence };
  }
  const ruling = await arbitrate({
    arbiter,
    task_id: attempt.task_id,
    epoch: attempt.epoch,
    attempt_id: attempt.attempt_id,
    subject_digest: subjectDigest,
    trigger: { trigger: trigger?.trigger, kind: trigger?.kind },
    evidence,
  });
  const digestBound = ruling?.subject_digest === undefined || ruling?.subject_digest === null ||
    subjectDigest === null || ruling.subject_digest === subjectDigest;
  if (!digestBound) return { decision: 'hold', reason: 'arbiter_response_invalid', evidence };
  switch (ruling?.decision) {
    case 'directed_rework': {
      const hasDirective = typeof ruling.directive === 'string' && ruling.directive.trim().length > 0;
      const hasFindings = Array.isArray(ruling.findings) && ruling.findings.length > 0;
      if (!hasDirective && !hasFindings) {
        return { decision: 'hold', reason: 'arbiter_response_invalid', evidence };
      }
      return { decision: 'directed_rework', directive: ruling.directive ?? null,
        findings: ruling.findings ?? [], arbitrationUsed: 1, evidence };
    }
    case 'accept_with_notes':
      if (typeof ruling.notes !== 'string' || !ruling.notes.trim()) {
        return { decision: 'hold', reason: 'arbiter_response_invalid', evidence };
      }
      return { decision: 'accept_with_notes', notes: ruling.notes, arbitrationUsed: 1,
        receipt: {
          kind: 'arbitration', task_id: attempt.task_id, epoch: attempt.epoch,
          attempt_id: attempt.attempt_id, subject_digest: subjectDigest,
          arbiter: { provider: arbiter.provider, model: arbiter.model },
          decision: 'accept_with_notes', notes: ruling.notes,
        },
        evidence };
    case 'escalate_owner':
      if (typeof ruling.question !== 'string' || !ruling.question.trim()) {
        return { decision: 'hold', reason: 'arbiter_response_invalid', evidence };
      }
      return { decision: 'escalate_owner', question: ruling.question, evidence };
    default:
      return { decision: 'hold', reason: 'arbiter_response_invalid', evidence };
  }
}
