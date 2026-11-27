import { join } from 'node:path';
import { TERMINAL_PHASES } from './daemon.mjs';
import { extractPostReviewMemoryUpdates, writeTrustedReviewReceipt } from './project-memory.mjs';
import { parseTelemetryLines, readTelemetryLines } from './telemetry.mjs';
import { evaluateAdaptiveGate } from './adaptive-gates.mjs';
import { aggregateScorecard } from './model-scorecard.mjs';
import { appendLessons, DEFAULT_MIN_REWORK_ROUNDS, distillReworkLessons,
  loadLessons, validateDistilledLessons } from './rework-distiller.mjs';
import * as workerSelector from './worker-selector.mjs';
import { assertTriadStageCompatible } from './playbook-router.mjs';
import { loadRoleRegistry } from './role-registry.mjs';
import { pinAttemptTriad } from './review-setup.mjs';

// V2-9b Adaptive 2-Tier Verification Gates: чистый планировщик разбиения
// проверок доверенного профиля на синхронные (L1 Docker) и отложенные
// async. Без явного включения (profile.adaptiveGates.enabled или
// thresholds.enabled) — строгий pass-through: каждый существующий профиль
// ведёт себя в точности как раньше. Fail-closed инвариант: пустой
// синхронный набор при непустом списке проверок откатывает план на
// strict_sync всех проверок — L1 никогда не пропускает проверку полностью.
export function planAdaptiveChecks({ profile, diffPaths, telemetryStats, recentRollbacks, thresholds,
  highRiskPaths } = {}) {
  const checks = Array.isArray(profile?.checks) ? profile.checks : [];
  if (profile?.adaptiveGates?.enabled !== true && thresholds?.enabled !== true) {
    return { enabled: false, mode: 'strict_sync', reason: 'disabled',
      syncChecks: checks, asyncChecks: [], decision: null };
  }
  const decision = evaluateAdaptiveGate({ checks, diffPaths, telemetryStats, recentRollbacks, thresholds,
    highRiskPaths });
  if (decision.syncFastChecks.length === 0 && checks.length > 0) {
    return { enabled: true, mode: 'strict_sync', reason: 'empty_sync_fallback',
      syncChecks: checks, asyncChecks: [], decision };
  }
  return { enabled: true, mode: decision.mode, reason: decision.reason,
    syncChecks: decision.syncFastChecks, asyncChecks: decision.asyncHeavyChecks, decision };
}

// Телеметрия адаптивного гейта фильтруется до оценки circuit breaker:
// открытые (незавершённые) попытки и строки других repo_id не участвуют
// в rolling-окне. Записи без repo_id неприписываемы и сохраняются —
// отбрасываются только строки с явным чужим repo_id.
export function filterAdaptiveTelemetry(entries, repoId) {
  return (Array.isArray(entries) ? entries : []).filter(entry =>
    entry?.open !== true &&
    (entry?.repo_id === undefined || entry.repo_id === repoId));
}

// AUDIT-0b fail-closed планировщик адаптивных проверок с внедряемым IO:
// детерминированно тестируемая сердцевина adaptiveLocalPlan. До появления
// async post-L1 раннера с rollback-обработчиком любой optimistic_async план
// откатывается на strict_sync всех проверок профиля (async_runner_unavailable),
// а сбой чтения diff/телеметрии — fail-closed на тот же strict_sync
// (adaptive_input_error): пустые diffPaths/recentAttempts никогда не
// подменяют реальные входы планировщика.
export async function adaptiveLocalPlanCore({ trusted, readDiffPaths, readTelemetryEntries,
  repoId = null, emit = null, identity = {} } = {}) {
  if (trusted?.adaptiveGates?.enabled !== true) return null;
  const allChecks = Array.isArray(trusted.checks) ? trusted.checks : [];
  const gates = trusted.adaptiveGates;
  let inputError = null;
  let diffPaths = [];
  try {
    const paths = await readDiffPaths();
    diffPaths = Array.isArray(paths) ? paths : [];
  } catch (error) {
    inputError = error;
  }
  let telemetryEntries = [];
  if (inputError === null) {
    try {
      const entries = await readTelemetryEntries();
      telemetryEntries = Array.isArray(entries) ? entries : [];
    } catch (error) {
      inputError = error;
    }
  }
  let plan;
  let failClosed = null;
  let plannerMode = null;
  let plannerReason = null;
  if (inputError !== null) {
    plan = { enabled: true, mode: 'strict_sync', reason: 'adaptive_input_error',
      syncChecks: allChecks, asyncChecks: [], decision: null };
    failClosed = 'adaptive_input_error';
  } else {
    plan = planAdaptiveChecks({ profile: trusted, diffPaths,
      telemetryStats: gates.telemetryStats ?? null,
      recentRollbacks: filterAdaptiveTelemetry(telemetryEntries, repoId),
      thresholds: gates.thresholds ?? gates,
      highRiskPaths: gates.highRiskPaths ?? gates.high_risk_paths });
    plannerMode = plan.mode;
    plannerReason = plan.reason;
    if (plan.mode === 'optimistic_async' || plan.asyncChecks.length > 0) {
      plan = { ...plan, mode: 'strict_sync', reason: 'async_runner_unavailable',
        syncChecks: allChecks, asyncChecks: [] };
      failClosed = 'async_runner_unavailable';
    }
  }
  // deferredAsyncChecks — что планировщик хотел отложить (до fail-closed
  // отката): исполнение всегда синхронное, метаданные фиксируют намерение
  // планировщика для наблюдаемости.
  const deferredAsyncChecks = (plan.decision?.decisions ?? [])
    .filter(entry => entry.disposition === 'async').map(entry => entry.id);
  const metadata = { mode: plan.mode, reason: plan.reason,
    syncCount: plan.syncChecks.length, asyncCount: plan.asyncChecks.length,
    deferredAsyncChecks,
    ...(failClosed !== null ? { failClosed, plannerMode, plannerReason } : {}) };
  const note = { kind: 'adaptive_gate_decision', phase: 'l1_local',
    task_id: identity.task_id, attempt_id: identity.attempt_id, epoch: identity.epoch,
    mode: plan.mode, reason: plan.reason,
    detail: { syncCount: metadata.syncCount, asyncCount: metadata.asyncCount,
      ...(failClosed !== null ? { failClosed, plannerMode, plannerReason } : {}) } };
  if (typeof emit === 'function') emit(note);
  return { plan, metadata };
}

// V2-9b: адаптивное разбиение проверок активируется только явным
// adaptiveGates.enabled доверенного профиля. Входы планировщика —
// read-only: diff кандидата из git и журнальные попытки телеметрии
// того же root; сбой их чтения — fail-closed strict_sync всех проверок,
// а не план на пустых входах (AUDIT-0b). До появления async post-L1
// раннера optimistic_async откатывается на синхронное исполнение всех
// проверок. Решение фиксируется read-only событием
// adaptive_gate_decision; formal-проверки остаются синхронными по
// контракту гейта, Tamper Gate и Scope Fence не обходятся.
export async function adaptiveLocalPlan(binding, trusted, { rawGit, route, root, attempt, eventBus }) {
  if (trusted?.adaptiveGates?.enabled !== true) return null;
  return adaptiveLocalPlanCore({ trusted,
    readDiffPaths: async () => {
      const names = await rawGit('diff', '--no-renames', '-z', '--name-only',
        route.base, binding.candidate_sha, '--');
      return names.split('\0').filter(name => name.length > 0);
    },
    readTelemetryEntries: async () => {
      const lines = await readTelemetryLines(join(root, 'telemetry.jsonl'));
      return parseTelemetryLines(lines).entries;
    },
    repoId: attempt.repo_id ?? route.repoId ?? null,
    identity: { task_id: attempt.task_id, attempt_id: attempt.attempt_id, epoch: attempt.epoch },
    emit: note => {
      eventBus?.emit(note);
      console.log(JSON.stringify(note));
    } });
}

// Ужесточение git на worker-writable worktree: конфигурация репозитория и
// пользовательский/системный gitconfig никогда не исполняют код от имени
// доверенного контроллера — ни fsmonitor, ни hooks, ни external diff.
export const HARDENED_GIT_CONFIG = Object.freeze([
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=',
]);

export function hardenedGitEnv(base = process.env) {
  return { ...(base ?? {}), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

// merge-base --is-ancestor завершается ненулевым кодом для не-предка: это
// данные (нет стабильной точки), а не сбой — иначе выброс внутри capture
// зацикливает попытку на одном и том же вопросе владельца.
export async function ancestorOrNull(git, base, sha) {
  try {
    await git('merge-base', '--is-ancestor', base, sha);
  } catch {
    return null;
  }
  return sha;
}

// Активный in-flight воркер не убивается при graceful shutdown/SIGTERM и по
// истечении pilot wait: остановка допустима только в терминальной фазе.
export function shouldStopWorkerOnShutdown({ recordPhase, resultPhase } = {}) {
  return TERMINAL_PHASES.has(recordPhase ?? resultPhase);
}

const REF_COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const refComponent = value => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && REF_COMPONENT_RE.test(text) && !text.includes('..') ? text : null;
};

// Долговременный ref закрытой попытки: verified-кандидат закрепляется под
// refs/darkfactory/verified/<task_id>/<attempt_id>, held — под /held/. Без
// компонентов или полного sha закреплять нечего — null, а не частичный ref.
export function candidatePinRef({ phase, record } = {}) {
  const kind = phase === 'done' ? 'verified' : phase === 'hold' ? 'held' : null;
  if (kind === null) return null;
  const sha = record?.sha;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) return null;
  const taskId = refComponent(record?.taskId);
  const attemptId = refComponent(record?.attemptId);
  if (taskId === null || attemptId === null) return null;
  return { ref: `refs/darkfactory/${kind}/${taskId}/${attemptId}`, sha };
}

// Queue-режим: durable ref выписывается строго ДО reset --hard на base —
// проверенный/удержанный candidate_sha никогда не осиротеет при сбросе
// worktree. Сбой закрепления пробрасывается и останавливает сброс: потерять
// verified-коммит хуже, чем остановить демон с нетронутым деревом.
// Деструктивные reset --hard/clean -fd идут строго после доказательства,
// что checkout — ожидаемая ветка слота (или отделённый HEAD ровно на base
// либо candidate_sha попытки) и воркер остановлен: reset на чужой ветке
// передвинул бы ЕЁ указатель на base, а clean -fd стёр бы чужую работу.
// Расхождение — карантин: дерево не трогается, журналируется
// branch_mismatch_quarantined/worker_not_stopped_quarantined и демон
// останавливается с нетронутым checkout вместо разрушения чужой ветки.
export const QUEUE_CHECKOUT_QUARANTINE = Object.freeze({
  branch: 'branch_mismatch_quarantined',
  worker: 'worker_not_stopped_quarantined',
});
export async function resetQueueWorktree({ git, base, phase, record, branch,
  workerStopped = false, log = note => console.log(JSON.stringify(note)) } = {}) {
  const pin = candidatePinRef({ phase, record });
  if (pin !== null) await git('update-ref', pin.ref, pin.sha);
  const currentBranch = await git('branch', '--show-current');
  const head = await git('rev-parse', 'HEAD');
  const candidate = typeof record?.sha === 'string' && /^[a-f0-9]{40}$/.test(record.sha)
    ? record.sha : null;
  const branchOk = typeof branch === 'string' && branch !== '' && currentBranch === branch;
  const detachedOk = currentBranch === '' && (head === base || (candidate !== null && head === candidate));
  if ((!branchOk && !detachedOk) || workerStopped !== true) {
    const kind = !branchOk && !detachedOk
      ? QUEUE_CHECKOUT_QUARANTINE.branch : QUEUE_CHECKOUT_QUARANTINE.worker;
    const note = { kind, phase, branch: currentBranch, expectedBranch: branch ?? null,
      head, base, task_id: record?.taskId ?? null, attempt_id: record?.attemptId ?? null,
      workerStopped: workerStopped === true };
    if (typeof log === 'function') log(note);
    throw new Error(kind);
  }
  await git('reset', '--hard', base);
  await git('clean', '-fd');
}

const ACCEPTED_MEMORY_OUTCOMES = new Set(['done', 'accepted', 'verified']);

// Доверенный пост-шаг записи в Project Memory после подтверждённого REVIEW_OK:
// при rework/hold/отсутствии REVIEW_OK квитанция не выписывается и память не
// обновляется. При успехе выписывает HMAC-подписанную квитанцию в
// trustedReceiptDir и вызывает закреплённый writer.recordUpdate(...).
export async function recordPostReviewMemory({
  writer,
  trustedReceiptDir,
  hmacKey,
  projectId,
  worktree,
  result,
  outcome,
  reviewReceipt,
  attempt,
  submission,
  worker,
  reviewer,
  updates,
}) {
  if (!writer) return { recorded: false, reason: 'writer_not_configured' };
  const res = result ?? outcome;
  const finalStatus = res?.outcome ?? res?.status;
  const receipt = reviewReceipt ?? res?.review;
  if (!ACCEPTED_MEMORY_OUTCOMES.has(finalStatus) || receipt?.verdict !== 'REVIEW_OK') {
    return { recorded: false, reason: 'not_review_ok' };
  }
  const verifiedSha = submission?.candidate_sha ?? res?.sha ?? receipt?.sha;
  if (typeof verifiedSha !== 'string' || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(verifiedSha)) {
    return { recorded: false, reason: 'invalid_sha' };
  }
  if (receipt?.sha !== undefined && receipt.sha !== verifiedSha) {
    return { recorded: false, reason: 'sha_mismatch' };
  }
  const resolvedUpdates = Array.isArray(updates) && updates.length > 0
    ? updates
    : extractPostReviewMemoryUpdates({ result: res, attempt, reviewReceipt: receipt, verifiedSha });
  if (!Array.isArray(resolvedUpdates) || resolvedUpdates.length === 0) {
    return { recorded: false, reason: 'no_updates' };
  }
  const receiptPath = join(
    trustedReceiptDir,
    `review-${attempt.task_id}-${attempt.attempt_id}-${verifiedSha.slice(0, 12)}.receipt.json`,
  );
  try {
    await writeTrustedReviewReceipt({
      receiptPath,
      trustedReceiptDir,
      hmacKey,
      worktree,
      receipt: {
        role: 'controller',
        verdict: 'REVIEW_OK',
        sha: verifiedSha,
        worker,
        reviewer,
        sourceCard: String(attempt.task_id),
      },
    });
    const saved = await writer.recordUpdate({ projectId, receiptPath, updates: resolvedUpdates });
    return { recorded: true, receiptPath, result: saved };
  } catch (error) {
    return {
      recorded: false,
      reason: 'post_review_memory_write_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createAttemptLearning({ ab, root, tree, state, route }) {
  // VS-4.2 Self-Learning Review Loop (#1263): уроки REWORK живут в
  // приватном каталоге состояния, вне дерева воркера. При инъекции
  // хранилище проходит повторный fail-closed гейт — ослабляющий урок
  // в промпт не попадает никогда.
  const lessonsPath = join(root, 'lessons.jsonl');
  const currentLessons = async () => {
    if (ab) return [];
    // Границы хранилища: файл в приватном root, не симлинк, вне worktree.
    const existing = await loadLessons(lessonsPath, { allowedDir: root, outside: [tree] });
    if (!existing.length) return [];
    const { accepted } = validateDistilledLessons(existing);
    return accepted;
  };
  // Скоркард для динамического роутинга: журнал телеметрии того же root.
  // Любая деградация — null → resolveTriad откатывается к дефолтной триаде.
  const currentScorecard = async () => {
    if (ab) return null;
    try {
      const lines = await readTelemetryLines(join(root, 'telemetry.jsonl'));
      return aggregateScorecard(lines);
    } catch {
      return null;
    }
  };
  // Дистилляция после закрытия карточки с >=2 раундами REWORK. Fail-open:
    // урок не может сломать приёмку — ошибка только журналируется.
  const distillClosedAttempt = async () => {
    if (ab) return;
    try {
      const record = await state.load();
      const rounds = Array.isArray(record?.roundsHistory) ? record.roundsHistory : [];
      if (rounds.length < DEFAULT_MIN_REWORK_ROUNDS) return;
      const candidates = distillReworkLessons(rounds,
        { cardId: String(record.taskId ?? route.taskId ?? 'unknown') });
      if (!candidates.length) return;
      const existing = await loadLessons(lessonsPath, { allowedDir: root, outside: [tree] });
      const { accepted, pending, rejected } = validateDistilledLessons(candidates, { existing });
      if (accepted.length) {
        await appendLessons(lessonsPath, accepted,
          { existing, allowedDir: root, outside: [tree] });
      }
      if (pending.length || rejected.length) {
        console.log(JSON.stringify({ kind: 'lessons_gate',
          pending: pending.map(lesson => lesson.id), rejected }));
      }
    } catch (error) {
      console.error(`rework-distiller: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  };
  return { currentLessons, currentScorecard, distillClosedAttempt };
}

// Routing Policy v2: зависимость от acp-zcode-start снята. Допущены
// acp-devin/swe-2-1-* (плюс legacy swe-2-high) и
// acp-antigravity-acp/gemini-4-neon; харнесс pi — с аттестованными
// openai/gpt-6.2-astra и openai/gpt-6.2-sol либо моделями
// opencode-go/deepseek-* (см. opencodeGoPolicyViolation).
const approved = [
  { provider: 'acp-devin', model: 'swe-2-high' },
  { provider: 'acp-devin', model: 'swe-2-1-medium' },
  { provider: 'acp-devin', model: 'swe-2-1-high' },
  { provider: 'acp-devin', model: 'swe-2-1-xhigh' },
  { provider: 'acp-devin', model: 'swe-2-1-max' },
  { provider: 'acp-antigravity-acp', model: 'gemini-4-neon' },
  { provider: 'pi', model: 'openai/gpt-6.2-astra' },
  { provider: 'pi', model: 'openai/gpt-6.2-sol' },
];
export const isApprovedWorker = bb =>
  approved.some(e => e.provider === bb?.provider && e.model === bb?.model) ||
  (bb?.provider === 'pi' && typeof bb.model === 'string' &&
    /^opencode-go\//i.test(bb.model) &&
    workerSelector.workerFamily(bb) === 'deepseek');

export function baseWorkerFromPolicy(policy) {
  const bb = policy?.bb;
  if (typeof bb?.provider === 'string' && bb.provider.trim() !== '' &&
      typeof bb?.model === 'string' && bb.model.trim() !== '') {
    return { provider: bb.provider, model: bb.model,
      ...(typeof bb.reasoningLevel === 'string' && bb.reasoningLevel !== ''
        ? { reasoningLevel: bb.reasoningLevel } : {}) };
  }
  return workerSelector.PRIMARY_WORKER;
}

export function createTriadRouter({ currentScorecard, p, reviewSetup, ab, foreman, route }) {
  // VS-4.2 (#1263): триада резолвится один раз — при запуске попытки —
  // контроллером через pinTriad и закрепляется в записи (spawn, L2,
  // арбитраж, seal идут на одной тройке; скоркард не перечитывается на
  // каждом тике). Любая деградация — проверенный откат resolveTriad.
  return async ({ attempt } = {}) => {
    const routed = workerSelector.resolveTriad({
      ...(attempt?.labels?.size !== undefined ? { size: attempt.labels.size } : {}),
      ...(attempt?.labels?.domain !== undefined ? { domain: attempt.labels.domain } : {}),
      policy: p,
      scorecard: await currentScorecard(),
      base: { worker: baseWorkerFromPolicy(p),
        critic: reviewSetup.critic, arbiter: reviewSetup.arbiter },
      log: note => console.log(JSON.stringify(note)),
    });
    const pinned = pinAttemptTriad({ routed, reviewSetup });
    // Закреплённая триада сверяется с аттестованным RO-транспортом
    // стадий выбранного плейбука ДО запуска писателя: несовместимый слот
    // (например, Devin в executor-стадии или Neon high под Landlock)
    // отклоняется здесь, а не после работы писателя и L1.
    if (pinned?.outcome !== 'rejected' && (foreman !== null || ab?.arm === 'foreman')) {
      const seat = ab?.arm === 'foreman'
        ? { registry: ab.registry, playbook: ab.playbook }
        : null;
      const registry = seat?.registry ?? await loadRoleRegistry(foreman.catalog);
      const playbook = seat?.playbook ?? foreman.playbook;
      if (seat === null && (registry.digest !== foreman.registryDigest ||
          !Object.hasOwn(registry.playbooks, playbook))) {
        throw new Error('foreman_registry_unconfirmed');
      }
      // Каждый кандидат плана может стать фактическим исполнителем
      // (резерв подменяет первичного) — проверяются все.
      const workers = Array.isArray(pinned.plan) && pinned.plan.length
        ? pinned.plan : workerSelector.selectWorker({ route });
      for (const worker of workers) {
        try {
          assertTriadStageCompatible({ registry, playbook,
            triad: { worker, critic: pinned.critic, arbiter: pinned.arbiter } });
        } catch (cause) {
          return { outcome: 'rejected', reason: cause instanceof Error
            ? cause.message : 'foreman_triad_transport_incompatible' };
        }
      }
    }
    return pinned;
  };
}
