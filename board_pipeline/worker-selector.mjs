// Политика выбора исполнителя, кросс-семейственная триада и содержательный
// арбитраж (Implementation Decisions §4 спеки). Никакого правила «два круга и
// закрыть»: нормальная сходящаяся починка не обрывается по счётчику кругов.
//
// Переключение на резерв допускается ТОЛЬКО при подтверждённом отказе
// (confirmed_refusal) первичного провайдера до любых правок worktree: после
// любого отказа (probe или spawn) обязательно доказаны ноль фоновых агентов,
// чистый worktree и HEAD === base_sha. Неизвестный исход — uncertain без
// второго писателя.

import { executorFamily, ReviewDenied } from './review-runner.mjs';
import { NEON_CRITIC, SOL_ARBITER } from './review-policy.mjs';

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
export const DEFAULT_CRITIC = NEON_CRITIC;
export const DEFAULT_ARBITER = SOL_ARBITER;

const DETERMINISTIC_GATES = new Set(['l1', 'tamper', 'l3']);
const GATE_BY_REASON = new Map([
  ['local_checks_failed', 'l1'],
  ['tamper_gate_failed', 'tamper'],
  ['visual_gate_failed', 'l3'],
]);
const DIGEST64 = /^[0-9a-f]{64}$/;

// Семейство по строгой таблице review-runner. У harness-исполнителей
// (provider 'pi') семейство определяет модель вида 'provider/model' —
// иначе пара provider+model обязана быть из одного семейства.
export function workerFamily(worker) {
  return executorFamily(worker);
}

// Упорядоченный план исполнителей маршрута. Резерв ZCode входит в план
// ТОЛЬКО при явном opts.zcodeQuota === 'available'; узкий резерв — только
// при явном допуске в маршруте, не как общий автозаменитель.
export function selectWorker({ route, zcodeQuota } = {}) {
  const plan = [PRIMARY_WORKER];
  if (zcodeQuota === 'available') plan.push(FALLBACK_ZCODE);
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

// После ЛЮБОГО подтверждённого отказа (probe или spawn) переход к резерву
// допустим только при доказанном отсутствии правок: ноль фоновых агентов у
// отказавшего источника и inspectWorktree подтвердил clean && head === base_sha.
// Что-либо недоказано — false → uncertain без второго писателя.
async function cleanAfterRefusal(source, attempt, inspectWorktree) {
  if (source?.activeBackgroundAgentCount !== 0) return false;
  if (typeof inspectWorktree !== 'function') return false;
  let ins = null;
  try {
    ins = await inspectWorktree(attempt);
  } catch {
    ins = null;
  }
  return ins !== null && typeof ins === 'object' &&
    ins.clean === true && ins.head === attempt?.base_sha;
}

// Последовательный запуск по плану с честным различением исходов.
// probe(worker) → 'available' | 'confirmed_refusal' | { status, zcodeQuota,
// activeBackgroundAgentCount }; spawn(attempt) → { threadId } либо конверт
// подтверждённого отказа { status: 'confirmed_refusal',
// activeBackgroundAgentCount: 0 }. inspectWorktree(attempt) →
// { clean, head } — обязателен для любого перехода на резерв.
export async function attemptSpawnWithFallback({
  route, attempt, probe, spawn, plan, zcodeQuota, inspectWorktree,
  critic = DEFAULT_CRITIC, arbiter = DEFAULT_ARBITER,
}) {
  const order = plan ?? selectWorker({ route, zcodeQuota });
  // Кросс-семейственная триада проверяется для ВСЕХ кандидатов цепочки:
  // нарушивший независимость резерв отклоняет маршрут, а не пропускается тихо.
  for (const worker of order) {
    try {
      assertTriadIndependent({ executor: worker, critic, arbiter });
    } catch (e) {
      return {
        outcome: 'rejected',
        reason: `route_triad_violation:${e.reason ?? e.message}`,
        attemptedWorkers: [],
      };
    }
  }
  const attemptedWorkers = [];
  let lastRefusal = null;
  for (const worker of order) {
    let probed = { status: 'available', activeBackgroundAgentCount: 0 };
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
      if (!await cleanAfterRefusal(probed, attempt, inspectWorktree)) {
        return {
          outcome: 'uncertain',
          reason: 'worker_launch_outcome_unknown',
          attemptedWorkers: [...attemptedWorkers,
            { ...worker, family: workerFamily(worker), verdict: 'unknown_outcome' }],
        };
      }
      const reason = `confirmed_refusal:${worker.provider}`;
      attemptedWorkers.push({ ...worker, family: workerFamily(worker), verdict: 'confirmed_refusal', reason });
      lastRefusal = reason;
      continue;
    }
    // Согласованный резерв ZCode — только при подтверждённой доступности/квоте.
    if (worker === FALLBACK_ZCODE && probed?.zcodeQuota !== 'available') {
      if (!await cleanAfterRefusal(probed, attempt, inspectWorktree)) {
        return {
          outcome: 'uncertain',
          reason: 'worker_launch_outcome_unknown',
          attemptedWorkers: [...attemptedWorkers,
            { ...worker, family: workerFamily(worker), verdict: 'unknown_outcome' }],
        };
      }
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
    if (launched?.status === 'confirmed_refusal') {
      if (!await cleanAfterRefusal(launched, attempt, inspectWorktree)) {
        return {
          outcome: 'uncertain',
          reason: 'worker_launch_outcome_unknown',
          attemptedWorkers: [...attemptedWorkers,
            { ...worker, family: workerFamily(worker), verdict: 'unknown_outcome' }],
        };
      }
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

// Ключ finding через JSON.stringify: склейка строк не допускает коллизий
// вида expected='A|B',actual='C' против expected='A',actual='B|C'.
export const findingKey = f =>
  JSON.stringify([f?.file ?? '', f?.line ?? null, f?.expected ?? '', f?.actual ?? '']);

// Сигнатура детерминированного отказа из ФАКТИЧЕСКИХ данных провалившейся
// проверки: упавший тест A (лог sha256_A) и починенный A + упавший B
// (sha256_B) — разные сигнатуры, починка сходится.
function deterministicDetail(feedback) {
  if (feedback === null || typeof feedback !== 'object') return '';
  const evidence = feedback.evidence;
  if (Array.isArray(evidence) && evidence.length) {
    const failing = evidence.filter(e => e !== null && typeof e === 'object' &&
      (e.exit !== 0 && e.exit !== undefined || e.ok === false));
    const list = failing.length ? failing : evidence;
    // file в сигнатуру не входит: имя лога содержит candidate_sha и случайный
    // UUID — два побайтово одинаковых падения обязаны давать одну сигнатуру.
    return list.map(e => JSON.stringify({
      exit: e?.exit ?? null,
      sha256: e?.sha256 ?? null,
      summary: e?.summary ?? null,
      status: e?.status ?? null,
      violations: e?.violations ?? null,
    })).join(';;');
  }
  if (Array.isArray(feedback.violations) && feedback.violations.length) {
    return `violations:${JSON.stringify(feedback.violations)}`;
  }
  if (Array.isArray(feedback.artifacts) && feedback.artifacts.length) {
    return `artifacts:${feedback.artifacts.map(a => a?.sha256 ?? a?.name ?? '').join(',')}`;
  }
  for (const key of ['summary', 'excerpt', 'status', 'evidence']) {
    if (typeof feedback[key] === 'string' && feedback[key]) return `${key}:${feedback[key]}`;
  }
  return '';
}

// Сигнатура отказа раунда: для детерминированных гейтов — причина и фактическая
// сигнатура провалившейся проверки; для L2 — канонические ключи findings.
export function roundSignature(result) {
  const reason = result?.reason ?? '';
  const feedback = result?.feedback ?? {};
  const explicit = result?.signature ?? feedback.signature;
  if (typeof explicit === 'string' && explicit) return `${reason}|${explicit}`;
  const findings = feedback.findings;
  if (Array.isArray(findings) && findings.length) {
    return `${reason}|${findings.map(findingKey).join(';;')}`;
  }
  const detail = deterministicDetail(feedback);
  return detail ? `${reason}|${detail}` : reason;
}

// Структурированный спор воркера: ссылка на замечание, аргументация и опора
// на спеку — всё непустые строки.
export function validDispute(dispute) {
  return dispute !== null && typeof dispute === 'object' && !Array.isArray(dispute) &&
    ['finding_ref', 'justification', 'spec_evidence'].every(
      k => typeof dispute[k] === 'string' && dispute[k].trim().length > 0);
}

// Допустимые ссылки на замечания прошлого L2-раунда: file, file:line, id
// находки и checkpoint ревью. Спор по несуществующей ссылке не признаётся.
// Спор допустим только по реальным findings прошлого L2-раунда: id, file или
// file:line конкретного замечания. Checkpoint и пустой массив findings —
// не основание для арбитража.
function findingRefsOf(round) {
  const refs = new Set();
  for (const f of round?.findings ?? []) {
    if (typeof f?.file === 'string' && f.file) {
      refs.add(f.file);
      if (f.line !== undefined && f.line !== null) refs.add(`${f.file}:${f.line}`);
    }
    if (typeof f?.id === 'string' && f.id) refs.add(f.id);
  }
  return refs;
}

// Два L2-раунда противоречат друг другу по одному месту, если на одном
// file+line ожидание одного стало фактом другого (и наоборот).
function contradicting(prev, latest) {
  for (const pf of prev?.findings ?? []) {
    for (const cf of latest?.findings ?? []) {
      if (typeof pf?.file !== 'string' || !pf.file || pf.file !== cf?.file) continue;
      if ((pf.line ?? null) !== (cf.line ?? null)) continue;
      const pe = pf.expected, pa = pf.actual, ce = cf.expected, ca = cf.actual;
      // Взаимоисключающие требования: оба направления развернуты одновременно
      // и требование реально отличается от факта (иначе это уточнение, не спор).
      if (typeof pe === 'string' && pe && typeof pa === 'string' && pa &&
          pe === ca && pa === ce && pe !== pa) return true;
    }
  }
  return false;
}

// Детектор отсутствия прогресса и содержательного спора. roundsHistory —
// включая последний раунд (поля: gate, signature, blocking, findings, excerpt,
// checkpoint, tree_sha, dispute, contradictory). Сходящаяся починка любой
// длины триггеров не даёт.
export function evaluateReworkProgress({ roundsHistory = [] } = {}) {
  const latest = roundsHistory.at(-1);
  if (!latest) return { trigger: null };
  const prev = roundsHistory.at(-2);
  // Содержательный спор: валидный dispute в L2-раунде И finding_ref совпадает
  // с реальным замечанием ПРОШЛОГО L2 (file, file:line, id или checkpoint).
  // Спор по несуществующей ссылке арбитраж не запускает.
  if (latest.gate === 'l2' && validDispute(latest.dispute) && prev?.gate === 'l2' &&
      Array.isArray(prev.findings) && prev.findings.length > 0 &&
      findingRefsOf(prev).has(latest.dispute.finding_ref)) {
    return { trigger: 'substantive_dispute', kind: 'worker_dispute', evidence: latest.dispute };
  }
  // Противоречащие друг другу требования L2 по одному и тому же месту.
  if (latest.gate === 'l2' && prev?.gate === 'l2' &&
      (latest.contradictory === true || contradicting(prev, latest))) {
    return { trigger: 'substantive_dispute', kind: 'contradictory_l2_findings',
      evidence: latest };
  }
  // Повторный tree_sha уже встречался в этой попытке — прогресса нет.
  if (typeof latest.tree_sha === 'string' && latest.tree_sha &&
      roundsHistory.slice(0, -1).some(r => r.tree_sha === latest.tree_sha)) {
    return { trigger: 'no_progress', kind: 'duplicate_tree_sha',
      deterministicGate: DETERMINISTIC_GATES.has(latest.gate), evidence: latest };
  }
  if (!prev) return { trigger: null };
  // Два раза подряд красный детерминированный гейт с той же сигнатурой отказа.
  if (DETERMINISTIC_GATES.has(latest.gate) && prev.gate === latest.gate &&
      latest.signature && prev.signature === latest.signature) {
    return { trigger: 'no_progress', kind: 'repeated_deterministic_failure',
      deterministicGate: true, evidence: latest };
  }
  // Два раза подряд L2 REWORK: повторился ТОТ ЖЕ finding (file+line+expected+
  // actual), та же сигнатура, либо совпал excerpt при пустых findings.
  if (latest.gate === 'l2' && prev.gate === 'l2') {
    const prevKeys = new Set((prev.findings ?? []).map(findingKey));
    const latestKeys = new Set((latest.findings ?? []).map(findingKey));
    const shared = [...latestKeys].some(k => prevKeys.has(k));
    const sameExcerpt = prevKeys.size === 0 && latestKeys.size === 0 &&
      typeof prev.excerpt === 'string' && prev.excerpt && prev.excerpt === latest.excerpt;
    const stuckWithoutFindings = prevKeys.size === 0 && latestKeys.size === 0 &&
      Number.isSafeInteger(latest.blocking) && Number.isSafeInteger(prev.blocking) &&
      latest.blocking >= prev.blocking;
    if (shared || sameExcerpt || stuckWithoutFindings ||
        (latest.signature && prev.signature === latest.signature)) {
      return { trigger: 'no_progress', kind: 'repeated_l2_finding',
        deterministicGate: false, evidence: latest };
    }
  }
  return { trigger: null };
}

// Нарушение DoD в findings — дисквалифицирующий признак для арбитража.
export function hasDodViolation(findings) {
  return Array.isArray(findings) && findings.some(
    f => f?.dod_violation === true || f?.violates_dod === true);
}

// Максимальный harm среди findings — fail-closed: заданный, но невалидный
// или >=10 harm (10.5, 'high', NaN, Infinity) и любой флаг DoD дают 10 —
// только владелец.
export function maxHarmOf(findings) {
  if (!Array.isArray(findings)) return 0;
  let max = 0;
  for (const f of findings) {
    if (f?.dod_violation === true || f?.violates_dod === true) return 10;
    // Заданный (даже null/undefined) harm обязан быть конечным числом
    // 0 <= harm < 10; иначе fail-closed 10.
    if (f !== null && typeof f === 'object' && Object.hasOwn(f, 'harm')) {
      const h = f.harm;
      if (typeof h !== 'number' || !Number.isFinite(h) || h < 0 || h >= 10) return 10;
      if (h > max) max = h;
    }
  }
  return max;
}

// Содержательный арбитраж. Арбитр никогда не обходит красный L1/tamper/L3,
// не ослабляет спеку/DoD и не принимает harm=10. Не более одного вызова на
// попытку. Решения directed_rework и accept_with_notes обязаны нести валидный
// subject_digest; accept_with_notes дополнительно обязан совпасть с digest
// текущего манифеста и не нарушать DoD.
// arbitrate({ arbiter, task_id, epoch, attempt_id, subject_digest, trigger,
// evidence }) — порт к модели арбитра; ответ — строго типизированное решение.
export async function resolveArbitration({
  attempt, trigger, arbitrationUsed = 0, arbiter = DEFAULT_ARBITER, critic = DEFAULT_CRITIC,
  maxHarm = 0, subjectDigest = null, dodViolation = false, verifyHeld, arbitrate,
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
  let ruling;
  try {
    ruling = await arbitrate({
      arbiter,
      task_id: attempt.task_id,
      epoch: attempt.epoch,
      attempt_id: attempt.attempt_id,
      subject_digest: subjectDigest,
      trigger: { trigger: trigger?.trigger, kind: trigger?.kind },
      evidence,
    });
  } catch {
    return { decision: 'hold', reason: 'arbiter_unavailable', evidence };
  }
  // Строгая привязка решения к манифесту приёмки для ВСЕХ решений арбитра:
  // subjectDigest манифеста обязан быть валидным 64-hex, а digest решения —
  // строго совпадать. Отсутствие манифеста или расхождение — hold.
  const digestOk = typeof subjectDigest === 'string' &&
    typeof ruling?.subject_digest === 'string' && DIGEST64.test(subjectDigest) &&
    ruling.subject_digest === subjectDigest;
  const needsDigest = ['directed_rework', 'accept_with_notes', 'escalate_owner']
    .includes(ruling?.decision);
  if (needsDigest && !digestOk) {
    return { decision: 'hold', reason: 'arbiter_subject_mismatch', evidence };
  }
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
    case 'accept_with_notes': {
      const dodBreach = dodViolation === true ||
        hasDodViolation(trigger?.evidence?.findings) ||
        ruling.dod_satisfied === false || ruling.violates_dod === true;
      if (dodBreach || maxHarm >= 10) {
        return { decision: 'hold', reason: 'dod_or_harm10_violation', evidence };
      }
      if (typeof ruling.notes !== 'string' || !ruling.notes.trim()) {
        return { decision: 'hold', reason: 'arbiter_response_invalid', evidence };
      }
      return { decision: 'accept_with_notes', notes: ruling.notes, arbitrationUsed: 1,
        receipt: {
          kind: 'arbitration', task_id: attempt.task_id, epoch: attempt.epoch,
          attempt_id: attempt.attempt_id, subject_digest: subjectDigest,
          arbiter: { provider: arbiter.provider, model: arbiter.model },
          decision: 'accept_with_notes', notes: ruling.notes,
          max_harm: maxHarm, dod_violation: false,
        },
        evidence };
    }
    case 'escalate_owner':
      if (typeof ruling.question !== 'string' || !ruling.question.trim()) {
        return { decision: 'hold', reason: 'arbiter_response_invalid', evidence };
      }
      return { decision: 'escalate_owner', question: ruling.question, evidence };
    default:
      return { decision: 'hold', reason: 'arbiter_response_invalid', evidence };
  }
}
