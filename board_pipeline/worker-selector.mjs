// Политика выбора исполнителя, кросс-семейственная триада и содержательный
// арбитраж (Implementation Decisions §4 спеки). Никакого правила «два круга и
// закрыть»: нормальная сходящаяся починка не обрывается по счётчику кругов.
//
// Переключение на резерв допускается ТОЛЬКО при подтверждённом отказе
// (confirmed_refusal) первичного провайдера до любых правок worktree: после
// любого отказа (probe или spawn) обязательно доказаны ноль фоновых агентов,
// чистый worktree и HEAD === base_sha. Неизвестный исход — uncertain без
// второго писателя.

import { executorFamily, l2RunnableSpec, ReviewDenied } from './review-runner.mjs';
import { isWorkerThreadId } from './worker-runtime.mjs';
import { NEON_CRITIC, SOL_ARBITER, detectStalledReview, isSolArbiter } from './review-policy.mjs';
import {
  DEFAULT_MIN_OBSERVATIONS,
  modelKey,
  normalizeDomain,
  normalizeSize,
  rankCandidates,
} from './model-scorecard.mjs';

// Согласованная политика исполнителей (Routing Policy v2): первичный и два
// согласованных резерва независимых семейств. Резерв, нарушающий
// кросс-семейственную триаду конкретного маршрута, пропускается — маршрут
// продолжается по следующему кандидату.
export const PRIMARY_WORKER = Object.freeze({ provider: 'acp-devin', model: 'swe-2-1-medium' });
export const NARROW_RESERVE_PI = Object.freeze({
  provider: 'pi',
  model: 'opencode-go/deepseek-v4.1-flash',
});
export const FALLBACK_ANTIGRAVITY_NEON = Object.freeze({
  provider: 'acp-antigravity-acp',
  model: 'gemini-4-neon',
  reasoningLevel: 'high',
});

// Дефолтный критик и арбитр третьего независимого семейства.
export const DEFAULT_CRITIC = NEON_CRITIC;
export const DEFAULT_ARBITER = SOL_ARBITER;

const DETERMINISTIC_GATES = new Set(['l1', 'tamper', 'l3', 'scope_fence']);
const GATE_BY_REASON = new Map([
  ['local_checks_failed', 'l1'],
  ['tamper_gate_failed', 'tamper'],
  ['visual_gate_failed', 'l3'],
  ['scope_fence_violation', 'scope_fence'],
]);
const DIGEST64 = /^[0-9a-f]{64}$/;

// Семейство по строгой таблице review-runner. У harness-исполнителей
// (provider 'pi') семейство определяет модель вида 'provider/model' —
// иначе пара provider+model обязана быть из одного семейства.
export function workerFamily(worker) {
  return executorFamily(worker);
}

// Политика opencode-go: допускаются строго модели DeepSeek, аттестованные
// строгой таблицей MODEL_FAMILY (workerFamily(spec) === 'deepseek'). Любая
// другая модель opencode-go — явный отказ 'opencode_go_non_deepseek_disallowed';
// нестроковый model и похожие префиксы ('deepseek-fake') не проходят гейт.
// Для харнесса 'pi' правило применяется к вложенной модели 'opencode-go/...'.
export function opencodeGoPolicyViolation(spec) {
  // Строковый id 'provider/model' (включая вложенный 'pi/opencode-go/...'):
  // та же проверка по аттестованному семейству.
  if (typeof spec === 'string') {
    const i = spec.indexOf('/');
    const head = (i < 0 ? spec : spec.slice(0, i)).toLowerCase();
    const nested = i >= 0 ? spec.slice(i + 1).toLowerCase() : '';
    if (head !== 'opencode-go' &&
        !(head === 'pi' && nested.startsWith('opencode-go/'))) return null;
    return workerFamily(spec) === 'deepseek'
      ? null : 'opencode_go_non_deepseek_disallowed';
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const provider = typeof spec.provider === 'string' ? spec.provider.toLowerCase() : '';
  const viaHarness = provider === 'pi' && typeof spec.model === 'string' &&
    spec.model.includes('/') &&
    spec.model.slice(0, spec.model.indexOf('/')).toLowerCase() === 'opencode-go';
  if (provider !== 'opencode-go' && !viaHarness) return null;
  return typeof spec.model === 'string' && workerFamily(spec) === 'deepseek'
    ? null : 'opencode_go_non_deepseek_disallowed';
}

// Owner Decision #18: acp-zcode-start/zcode и glm допускаются при наличии
// квоты — выбывших провайдеров в действующей политике нет. Сигнатура
// сохраняется для обратной совместимости вызовов (stage-sandbox-transport
// и маршрутизатор): отсутствие нарушения обозначается null, как прежде.
export function retiredProviderViolation(spec) {
  return null;
}

// Упорядоченный план исполнителей маршрута: первичный acp-devin/swe-2-1-medium,
// затем согласованные резервы независимых семейств. Фактическая пригодность
// резерва решается попыткой: нарушитель триады пропускается, подтверждённый
// отказ допускает переход только при доказанной чистоте worktree.
export function selectWorker() {
  return [PRIMARY_WORKER, NARROW_RESERVE_PI, FALLBACK_ANTIGRAVITY_NEON];
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
// probe(worker) → 'available' | 'confirmed_refusal' | { status,
// activeBackgroundAgentCount }; spawn(attempt) → { threadId } либо конверт
// подтверждённого отказа { status: 'confirmed_refusal',
// activeBackgroundAgentCount: 0 }. inspectWorktree(attempt) →
// { clean, head } — обязателен для любого перехода на резерв.
export async function attemptSpawnWithFallback({
  route, attempt, probe, spawn, plan, inspectWorktree, onBeforeSpawn,
  critic = DEFAULT_CRITIC, arbiter = DEFAULT_ARBITER,
}) {
  const order = plan ?? selectWorker({ route });
  // Кросс-семейственная триада проверяется для каждого кандидата до запуска:
  // первичный, нарушивший независимость, отклоняет маршрут; резерв с
  // нарушением или запрещённой моделью пропускается с явным вердиктом —
  // инвариант трёх семейств сохраняется без остановки маршрута.
  const attemptedWorkers = [];
  const order2 = [];
  for (const [index, worker] of order.entries()) {
    const violation = retiredProviderViolation(worker) ?? opencodeGoPolicyViolation(worker);
    try {
      if (violation) throw new ReviewDenied(violation);
      assertTriadIndependent({ executor: worker, critic, arbiter });
      order2.push(worker);
    } catch (e) {
      if (index === 0) {
        return {
          outcome: 'rejected',
          reason: e.reason === violation
            ? violation
            : `route_triad_violation:${e.reason ?? e.message}`,
          attemptedWorkers: [],
        };
      }
      attemptedWorkers.push({
        ...(typeof worker === 'object' && worker !== null ? { ...worker } : { id: worker }),
        family: workerFamily(worker), verdict: 'skipped',
        reason: e.reason === violation ? violation : `triad_violation:${e.reason ?? e.message}` });
    }
  }
  let lastRefusal = null;
  for (const worker of order2) {
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
    let launched;
    try {
      // Кандидат фиксируется в состоянии попытки ДО внешнего spawn: при
      // потерянном ответе reconcileSpawn восстанавливает фактически
      // запущенного исполнителя, а не первичного из плана (#1263 r3).
      await onBeforeSpawn?.(worker);
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
    if (isWorkerThreadId(launched?.threadId)) {
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

// Жёсткий потолок L2-раундов попытки (Board #1666): на лимитном REWORK
// контроллер останавливается без следующего круга и эскалирует карточку
// владельцу ('l2_rework_limit_exceeded'). Считаются только раунды с
// gate === 'l2' — детерминированные гейты лимит не расходуют. Лимит
// настраивается маршрутом (route.maxL2ReworkRounds), по умолчанию 4;
// маршрут может потолок только ужесточить — значение выше потолка и
// невалидное одинаково откатываются к дефолту, четвёртый REWORK всегда
// лимитный.
export const DEFAULT_L2_REWORK_LIMIT = 4;
// Фактически применённый лимит: валидное значение маршрута, прижатое к
// потолку; невалидное и отсутствующее — дефолт. Причина остановки владецу
// сообщает именно это число, не сырое значение маршрута (#1666 r4).
export function effectiveL2ReworkLimit(limit = DEFAULT_L2_REWORK_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 1) return DEFAULT_L2_REWORK_LIMIT;
  return Math.min(limit, DEFAULT_L2_REWORK_LIMIT);
}
export function l2ReworkLimitExceeded({ roundsHistory = [], limit = DEFAULT_L2_REWORK_LIMIT } = {}) {
  return roundsHistory.filter(r => r?.gate === 'l2').length >= effectiveL2ReworkLimit(limit);
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
  // Ранняя стагнация L2 (V2-2): повтор SHA-сигнатуры блокирующих находок
  // любого предыдущего L2-раунда — даже не подряд (раунд 1 и 3) — запускает
  // арбитра на раундах 2–3, до исчерпания лимита.
  if (latest.gate === 'l2') {
    const stalled = detectStalledReview({ roundsHistory });
    if (stalled.stalled) {
      return { trigger: 'no_progress', kind: stalled.kind,
        deterministicGate: false, signatureSha: stalled.signatureSha, evidence: latest };
    }
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

// ── Policy-bounded Dynamic Role Routing (VS-3) ────────────────────────────
// Выбор лучшей модели для роли по скоркарду СТРОГО внутри allowlist политики
// (policy.routing.allowlist[role]) и с жёстким инвариантом кросс-семейственной
// триады (executor ≠ critic ≠ arbiter). Два режима: shadow (по умолчанию —
// считает и журналирует рекомендацию, не меняя выбор) и active (включается
// явно в политике после накопления статистики). Нарушение allowlist или
// триады — жёсткий отказ, не тихий пропуск.

export const ROUTING_MODES = Object.freeze(['shadow', 'active']);

// Нормализация policy.routing: режим не 'active' → shadow (fail-safe).
// Allowlist роли — только объекты {provider, model} с известным семейством;
// неизвестное семейство в политике — ошибка конфигурации, не молчаливый сброс.
export function normalizeRoutingPolicy(policy) {
  const routing = policy?.routing ?? {};
  const mode = routing.mode === 'active' ? 'active' : 'shadow';
  const minObservations = Number.isSafeInteger(routing.min_observations) &&
    routing.min_observations >= 1 ? routing.min_observations : DEFAULT_MIN_OBSERVATIONS;
  const allowlist = {};
  for (const role of ['worker', 'critic', 'arbiter']) {
    const list = routing.allowlist?.[role];
    if (!Array.isArray(list)) { allowlist[role] = []; continue; }
    allowlist[role] = list.map(entry => {
      const spec = { provider: entry?.provider, model: entry?.model,
        ...(entry?.effort !== undefined ? { effort: entry.effort } : {}),
        ...(entry?.reasoningLevel !== undefined ? { reasoningLevel: entry.reasoningLevel } : {}) };
      const violation = retiredProviderViolation(spec) ?? opencodeGoPolicyViolation(spec);
      if (violation) throw new ReviewDenied(violation);
      if (workerFamily(spec) === null) throw new ReviewDenied('route_allowlist_unknown_family');
      // Роли критика и арбитра исполняются L2-раннером: допускаются только
      // провайдеры с реальным egress (pi-харнесс с доказанным pi-провайдером,
      // acp-antigravity-acp, прямые pi-провайдеры) — 'acp-devin' и прочие без
      // адресов в политику не попадают.
      if ((role === 'critic' || role === 'arbiter') && !l2RunnableSpec(spec)) {
        throw new ReviewDenied(`route_${role}_not_runnable`);
      }
      return spec;
    });
  }
  return { mode, minObservations, allowlist };
}

const inAllowlist = (spec, list) =>
  list.some(entry => entry.provider === spec?.provider && entry.model === spec?.model);

// Доступность/квота модели: функция (spec) => status либо карта
// 'provider/model' => status. Незаданный availability — 'available' для всех;
// карта без ключа модели — 'unavailable' (явная карта авторитетна).
// Неизвестный статус трактуется как 'unavailable' (fail-closed).
function availabilityOf(spec, availability) {
  if (availability === undefined || availability === null) return 'available';
  const status = typeof availability === 'function'
    ? availability(spec)
    : availability[modelKey(spec)];
  return ['available', 'unavailable', 'quota_exhausted'].includes(status)
    ? status : 'unavailable';
}

// Один шаг динамического роутинга роли.
// role: 'worker' | 'critic' | 'arbiter'; size/domain — метки карточки
// (нормализуются к канону скоркарда); policy — policy.json (routing-секция);
// scorecard — aggregateScorecard; base — действующий выбор по умолчанию;
// others — зафиксированные роли триады ({executor, critic, arbiter} без
// текущей роли); availability — доступность/квота (карта или предикат,
// 'available' | 'unavailable' | 'quota_exhausted').
// Возврат: { outcome, mode, selected, recommended, ranked, skipped } —
// в shadow selected === base; в active — лучший доказанный и доступный
// кандидат allowlist.
export function routeRole({ role, size, domain, policy, scorecard,
  base, others = {}, availability = null, log = null } = {}) {
  // Триада оценивается против действующих ролей: незаданные — дефолтные.
  const fixed = { critic: DEFAULT_CRITIC, arbiter: DEFAULT_ARBITER, ...others };
  const routing = normalizeRoutingPolicy(policy);
  const list = routing.allowlist[role] ?? [];
  const normSize = normalizeSize(size);
  const normDomain = normalizeDomain(domain);
  const reject = reason => ({ outcome: 'rejected', reason, mode: routing.mode,
    selected: null, recommended: null, ranked: [], skipped: [] });
  // Действующий выбор обязан быть в allowlist — иначе политика противоречива.
  if (base !== undefined && base !== null && !inAllowlist(base, list)) {
    return reject('route_base_not_in_allowlist');
  }
  const skipped = [];
  // Полная совместимость с acceptHeld ДО запуска воркера: помимо трёх
  // семейств, критик Neon допустим только с арбитром Sol — иначе
  // acceptHeld отклонит триаду vs2_review_triad_not_approved уже после
  // spawn. Несовместимые комбинации отфильтровываются здесь.
  const triadOk = candidate => {
    const families = { ...fixed };
    families[role === 'worker' ? 'executor' : role] = candidate;
    const critic = families.critic ?? (role === 'critic' ? candidate : undefined);
    const arbiter = families.arbiter ?? (role === 'arbiter' ? candidate : undefined);
    // Neon может прийти в worker-форме 'acp-antigravity-acp/gemini-4-neon' —
    // acceptHeld видит runner-форму {provider:'google'}, поэтому и здесь
    // сверка идёт по нормализованному спеку.
    // Любой критик google-семейства (Neon в любой форме — 'google',
    // 'acp-antigravity-acp', 'pi/google/…', независимо от reasoningLevel)
    // требует арбитра Sol: acceptHeld отклонит Neon+не-Sol на приёмке
    // уже после spawn (#1263 r5).
    if (workerFamily(critic) === 'google' && !isSolArbiter(arbiter)) {
      return false;
    }
    try {
      assertTriadIndependent({
        executor: families.executor ?? (role === 'worker' ? candidate : undefined),
        critic, arbiter,
      });
      return true;
    } catch {
      return false;
    }
  };
  // Инвариант триады проверяется и для base: невалидный по семействам
  // действующий выбор — отказ в обоих режимах, не тихий selected.
  if (base !== undefined && base !== null && !triadOk(base)) {
    return reject('route_base_triad_violation');
  }
  const ranked = rankCandidates(scorecard, {
    role, domain: normDomain, size: normSize,
    minObservations: routing.minObservations, models: list,
  });
  let recommended = null;
  for (const candidate of ranked) {
    // Выбор — объект из allowlist со всеми полями (effort, reasoningLevel),
    // а не восстановленный из ключа скоркарда {provider, model}. Сверка по
    // каноническому ключу: runner-форма 'opencode-go/…' и allowlist-форма
    // 'pi/opencode-go/…' — один и тот же кандидат.
    const spec = list.find(entry => modelKey(entry) === modelKey(candidate.model));
    if (spec === undefined) continue; // страховка, rankCandidates уже фильтрует
    const status = availabilityOf(spec, availability);
    if (status !== 'available') {
      skipped.push({ model: spec, reason: status });
      continue;
    }
    if (!triadOk(spec)) {
      skipped.push({ model: spec, reason: 'triad_violation' });
      continue;
    }
    recommended = { ...candidate, model: spec };
    break;
  }
  const note = {
    kind: 'route_recommendation', role, domain: normDomain, size: normSize,
    mode: routing.mode, recommended: recommended?.model ?? null,
    score: recommended?.cell ?? null, skipped,
  };
  if (typeof log === 'function') {
    try { log(note); } catch { /* журналирование не ломает выбор */ }
  }
  if (routing.mode === 'shadow') {
    return { outcome: 'shadow', mode: 'shadow', selected: base ?? null,
      recommended: recommended?.model ?? null, ranked, skipped, note };
  }
  // active: база вытесняется только доказанным кандидатом из allowlist;
  // ни одного валидного — жёсткий отказ (не тихий возврат к базе).
  if (recommended === null) {
    // Доказанные кандидаты есть, но все ломают триаду — отдельная причина.
    const reason = ranked.length > 0 && skipped.length === ranked.length &&
      skipped.every(s => s.reason === 'triad_violation')
      ? 'route_triad_violation' : 'route_no_proven_candidate';
    return { outcome: 'rejected', reason,
      mode: 'active', selected: null, recommended: null, ranked, skipped, note };
  }
  return { outcome: 'routed', mode: 'active', selected: recommended.model,
    recommended: recommended.model, ranked, skipped, note };
}

// Роутинг всей триады последовательно: worker → critic → arbiter, каждая
// следующая роль видит уже выбранные семейства; на шаге worker триада
// оценивается против переданных base.critic/base.arbiter, а не только
// дефолтных. Первый жёсткий отказ останавливает маршрут — частичная
// триада не применяется.
export function routeTriad({ size, domain, policy, scorecard,
  base = { worker: PRIMARY_WORKER, critic: DEFAULT_CRITIC, arbiter: DEFAULT_ARBITER },
  availability = null, log = null } = {}) {
  const selected = {};
  const steps = {};
  for (const role of ['worker', 'critic', 'arbiter']) {
    const others = {};
    if (selected.worker !== undefined) others.executor = selected.worker;
    if (selected.critic !== undefined) others.critic = selected.critic;
    if (selected.arbiter !== undefined) others.arbiter = selected.arbiter;
    // Невыбранные роли триады — из переданного base, если заданы.
    if (others.critic === undefined && base.critic !== undefined &&
        role !== 'critic') others.critic = base.critic;
    if (others.arbiter === undefined && base.arbiter !== undefined &&
        role !== 'arbiter') others.arbiter = base.arbiter;
    const step = routeRole({ role, size, domain, policy, scorecard,
      base: base[role], others, availability, log });
    steps[role] = step;
    if (step.outcome === 'rejected') {
      return { outcome: 'rejected', reason: step.reason, role, steps };
    }
    selected[role] = step.selected;
  }
  return { outcome: steps.worker.mode === 'active' ? 'routed' : 'shadow',
    mode: steps.worker.mode, selected, steps };
}

// Допуск кандидата по политике #1247 с поправкой Owner Decision #18:
// zcode допустим при квоте, DeepSeek-only в opencode-go сохраняется, а при
// непустом allowlist роли выбор остаётся строго внутри него.
const admissible = (spec, list) =>
  retiredProviderViolation(spec) === null && opencodeGoPolicyViolation(spec) === null &&
  (list.length === 0 || inAllowlist(spec, list));

// Попарная независимость кандидата от закреплённых критика и арбитра.
const independent = (candidate, critic, arbiter) => {
  try {
    assertTriadIndependent({ executor: candidate, critic, arbiter });
    return true;
  } catch {
    return false;
  }
};

// Активация динамического routeTriad (Board #1263). Режим берётся из
// policy.routing.mode: 'shadow' (дефолт, безопасный) считает рекомендацию
// для лога, не меняя назначение; 'active' выбирает по скоркарду строго
// поверх политики #1247. Единая политика допуска для shadow, fallback и
// резервов: базовая триада и каждый резерв в plan проверяются по #1247,
// allowlist и попарной независимости семейств — невалидной базы нет,
// только явный 'rejected'. Любая деградация скоркарда (недоступен, битые
// строки corrupt>0, ошибка routeTriad) — детерминированный откат к
// проверенной базовой триаде с явной причиной; частичная динамическая
// триада не применяется.
// Возврат: { outcome, mode, selected: {worker, critic, arbiter}, plan,
// reason?, steps? } — plan готов для attemptSpawnWithFallback.
export function resolveTriad({ size, domain, policy, scorecard,
  base = { worker: PRIMARY_WORKER, critic: DEFAULT_CRITIC, arbiter: DEFAULT_ARBITER },
  availability = null, log = null } = {}) {
  const emit = note => {
    if (typeof log === 'function') {
      try { log(note); } catch { /* журналирование не ломает выбор */ }
    }
  };
  let routing;
  try {
    routing = normalizeRoutingPolicy(policy);
  } catch (e) {
    const reason = `routing_policy_invalid:${e?.reason ?? e?.message ?? 'invalid'}`;
    emit({ kind: 'route_fallback', reason });
    // Нечитаемая политика — fail-closed: ни база, ни резервы без
    // проверенного allowlist не доказаны, дефолт не подставляется.
    return { outcome: 'rejected', reason, mode: 'shadow',
      selected: null, plan: [] };
  }
  // Базовая триада валидируется в обоих режимах: запрещённые провайдеры,
  // независимость трёх семейств и — при непустом allowlist роли —
  // принадлежность ему. Безопасной базы нет → явный rejected.
  const baseViolation = (() => {
    for (const spec of [base.worker, base.critic, base.arbiter]) {
      const v = retiredProviderViolation(spec) ?? opencodeGoPolicyViolation(spec);
      if (v) return `route_base_invalid:${v}`;
    }
    // Критик и арбитр базы исполняются L2-раннером — без egress-адресов
    // база не доказана (та же политика допуска, что и у allowlist).
    if (!l2RunnableSpec(base.critic)) return 'route_base_critic_not_runnable';
    if (!l2RunnableSpec(base.arbiter)) return 'route_base_arbiter_not_runnable';
    try {
      assertTriadIndependent({ executor: base.worker, critic: base.critic, arbiter: base.arbiter });
    } catch (e) {
      return `route_base_triad_violation:${e?.reason ?? e?.message ?? 'failed'}`;
    }
    // Совместимость с acceptHeld: любой критик google-семейства требует
    // арбитра Sol — иначе триада отвалится на приёмке уже после spawn.
    if (workerFamily(base.critic) === 'google' && !isSolArbiter(base.arbiter)) {
      return 'route_base_acceptance_incompatible';
    }
    if ((routing.allowlist.worker.length && !inAllowlist(base.worker, routing.allowlist.worker)) ||
        (routing.allowlist.critic.length && !inAllowlist(base.critic, routing.allowlist.critic)) ||
        (routing.allowlist.arbiter.length && !inAllowlist(base.arbiter, routing.allowlist.arbiter))) {
      return 'route_base_not_in_allowlist';
    }
    return null;
  })();
  if (baseViolation) {
    emit({ kind: 'route_fallback', reason: baseViolation });
    return { outcome: 'rejected', reason: baseViolation, mode: routing.mode,
      selected: null, plan: [] };
  }
  // Резервы под конкретную триаду: только допустимые по #1247/allowlist и
  // независимые от критика и арбитра ЭТОЙ попытки — резерв вне allowlist
  // или семейства критика в план не попадает вообще.
  const safePlan = (worker, critic, arbiter) => {
    const plan = [worker];
    for (const reserve of [NARROW_RESERVE_PI, FALLBACK_ANTIGRAVITY_NEON]) {
      if (modelKey(reserve) === modelKey(worker)) continue;
      if (!admissible(reserve, routing.allowlist.worker)) continue;
      if (!independent(reserve, critic, arbiter)) continue;
      plan.push(reserve);
    }
    return plan;
  };
  const fallback = (reason, extra = {}) => {
    emit({ kind: 'route_fallback', reason });
    return { outcome: 'fallback', mode: 'shadow', reason, selected: base,
      plan: safePlan(base.worker, base.critic, base.arbiter), ...extra };
  };
  // Частично повреждённый скоркард (битые строки журнала) — не основа
  // для выбора: откат с явной причиной в обоих режимах.
  if (Number.isSafeInteger(scorecard?.corrupt) && scorecard.corrupt > 0) {
    return fallback('scorecard_corrupt');
  }
  // Рекомендация считается и в shadow (лог/телеметрия), и в active.
  let routed = null;
  const scorecardOk = scorecard !== null && typeof scorecard === 'object' &&
    scorecard.cells !== null && typeof scorecard.cells === 'object';
  if (scorecardOk) {
    try {
      routed = routeTriad({ size, domain, policy, scorecard, base, availability, log });
    } catch {
      routed = null;
    }
  }
  if (routing.mode !== 'active') {
    return { outcome: 'shadow', mode: 'shadow', selected: base,
      plan: safePlan(base.worker, base.critic, base.arbiter),
      recommended: routed?.steps?.worker?.recommended ?? null,
      steps: routed?.steps };
  }
  if (!scorecardOk) return fallback('scorecard_unavailable');
  if (routed === null) return fallback('route_triad_error');
  if (routed.outcome !== 'routed' || routed.selected === null ||
      routed.selected.worker === undefined) {
    return fallback(`route_active_rejected:${routed.reason ?? 'no_selection'}`,
      { steps: routed.steps });
  }
  // Инвариант трёх независимых семейств подтверждается ещё раз на
  // финальной триаде — сбой проверки не может выдать частичный выбор.
  try {
    assertTriadIndependent({ executor: routed.selected.worker,
      critic: routed.selected.critic, arbiter: routed.selected.arbiter });
  } catch (e) {
    return fallback(`route_triad_violation:${e?.reason ?? e?.message ?? 'failed'}`);
  }
  // Исполняемость критика и арбитра L2-раннером — финальная проверка:
  // недоказанный провайдер не выходит даже при согласованных семействах.
  if (!l2RunnableSpec(routed.selected.critic) ||
      !l2RunnableSpec(routed.selected.arbiter)) {
    return fallback('route_role_not_runnable');
  }
  // Полная совместимость с acceptHeld на финальной триаде: критик
  // google-семейства без Sol-арбитра не выходит — безопасный fallback на
  // проверенную базу.
  if (workerFamily(routed.selected.critic) === 'google' &&
      !isSolArbiter(routed.selected.arbiter)) {
    return fallback('route_acceptance_incompatible');
  }
  return { outcome: 'routed', mode: 'active', selected: routed.selected,
    plan: safePlan(routed.selected.worker, routed.selected.critic, routed.selected.arbiter),
    steps: routed.steps };
}

// ── Точечный escalation-слот Opus 5.5 (Routing Policy v2) ─────────────────
// «Хирургический» сторонний ревьюер для high-stakes ситуаций: активируется
// ТОЛЬКО при одновременном выполнении (а) явного high-stakes триггера,
// (б) подтверждённой квоты с жёстким cap и (в) инварианта трёх независимых
// семейств (anthropic ≠ worker ≠ primary critic). Иначе — детерминированный
// graceful fallback на Pi/Sol или Gemini 4 Neon high с явной причиной.

export const ESCALATION_REVIEWER_OPUS = Object.freeze({
  provider: 'agy', model: 'claude-opus-5.5', reasoningLevel: 'high',
});
export const ESCALATION_FALLBACK_PI_SOL = Object.freeze({
  provider: 'pi', model: 'openai/gpt-6.2-sol', reasoningLevel: 'high',
});
export const ESCALATION_FALLBACK_NEON_HIGH = Object.freeze({
  provider: 'acp-antigravity-acp', model: 'gemini-4-neon', reasoningLevel: 'high',
});
const ESCALATION_FALLBACKS = Object.freeze([
  ESCALATION_FALLBACK_PI_SOL, ESCALATION_FALLBACK_NEON_HIGH,
]);

const HIGH_STAKES_TRIGGERS = new Set(['security_gate', 'release_gate', 'critical_math_or_arch']);

// Явный high-stakes триггер: строка-код, либо объект с полем kind/name/
// trigger из фиксированного списка, либо dispute_rounds >= 2.
function escalationTriggerActive(trigger) {
  if (typeof trigger === 'string') return HIGH_STAKES_TRIGGERS.has(trigger);
  if (trigger === null || typeof trigger !== 'object' || Array.isArray(trigger)) return false;
  if (Number.isSafeInteger(trigger.dispute_rounds) && trigger.dispute_rounds >= 2) return true;
  return HIGH_STAKES_TRIGGERS.has(trigger.kind ?? trigger.name ?? trigger.trigger);
}

// Доступная квота Opus: status 'available', remaining — целое >= 1, а cap и
// used — обязательные целые: cap >= 1, used >= 0 и used строго меньше cap.
// Что-либо недоказано — недоступно.
function opusQuotaAvailable(quota) {
  if (quota === null || typeof quota !== 'object' || Array.isArray(quota)) return false;
  return quota.status === 'available' &&
    Number.isSafeInteger(quota.remaining) && quota.remaining > 0 &&
    Number.isSafeInteger(quota.cap) && quota.cap >= 1 &&
    Number.isSafeInteger(quota.used) && quota.used >= 0 && quota.used < quota.cap;
}

// Детерминированный выбор escalation-ревьюера.
// trigger — high-stakes триггер; quota — { status, remaining, used, cap };
// triad — { worker, critic } действующей пары (семейства обязаны быть
// аттестованы: неизвестное семейство не доказывает независимость).
// Возврат: { outcome: 'selected', reviewer, family } — слот Opus 5.5;
// { outcome: 'fallback', reason, reviewer, family } — Pi/Sol либо
// Gemini 4 Neon high с причиной ('no_escalation_trigger',
// 'opus_quota_exhausted', 'opus_triad_violation'); { outcome: 'rejected',
// reason: 'escalation_reviewer_unavailable' } — ни один вариант не
// сохраняет инвариант.
export function selectEscalationReviewer({ trigger, quota, triad } = {}) {
  const workerFam = workerFamily(triad?.worker ?? triad?.executor);
  const criticFam = workerFamily(triad?.critic);
  // Попарная проверка триады: оба семейства аттестованы и различны — до
  // выбора Opus 5.5 и до любого fallback. Совпавшая или неизвестная пара не
  // доказывает независимость — отказ.
  if (workerFam === null || criticFam === null || workerFam === criticFam) {
    return { outcome: 'rejected', reason: 'escalation_triad_invalid', reviewer: null };
  }
  const independent = spec => {
    const family = workerFamily(spec);
    return family !== null && family !== workerFam && family !== criticFam;
  };
  const fallback = reason => {
    for (const spec of ESCALATION_FALLBACKS) {
      if (independent(spec)) {
        return { outcome: 'fallback', reason, reviewer: spec, family: workerFamily(spec) };
      }
    }
    return { outcome: 'rejected', reason: 'escalation_reviewer_unavailable',
      fallbackReason: reason, reviewer: null };
  };
  if (!escalationTriggerActive(trigger)) return fallback('no_escalation_trigger');
  if (!opusQuotaAvailable(quota)) return fallback('opus_quota_exhausted');
  if (!independent(ESCALATION_REVIEWER_OPUS)) return fallback('opus_triad_violation');
  return { outcome: 'selected', reviewer: ESCALATION_REVIEWER_OPUS,
    family: workerFamily(ESCALATION_REVIEWER_OPUS) };
}
