// Детерминированная fail-closed очередь слияния проверенных кандидатов
// (REVIEW_OK) в интеграционную ветку. Модуль не знает о git: все эффекты
// идут через внедряемые чистые порты, поэтому поведение воспроизводимо и
// проверяется без внешних зависимостей.
//
// Инварианты:
//  - защищённые ветки (main/master/production/release/*) никогда не
//    получают автоматический merge без явного допуска владельца;
//  - не-fast-forward слияние обязано пройти повторную L1 smoke-проверку
//    перебазированного SHA до обновления ветки;
//  - конфликт и падение smoke-проверки никогда не двигают targetBranch —
//    кандидат возвращается воркеру с диагностикой.

const SHA_RE = /^[a-f0-9]{40}$/;

export const PROTECTED_BRANCH_PATTERNS = Object.freeze(['main', 'master', 'production', 'release/*']);

// Точное совпадение для простых имён и префиксное для шаблонов с '*'.
// Нестроковый вход — не защищённая ветка (отклоняется валидацией раньше).
export function isProtectedBranch(branch) {
  if (typeof branch !== 'string' || branch === '') return false;
  for (const pattern of PROTECTED_BRANCH_PATTERNS) {
    if (pattern.endsWith('*')) {
      if (branch.startsWith(pattern.slice(0, -1))) return true;
    } else if (branch === pattern) {
      return true;
    }
  }
  return false;
}

function invalid(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function ownerApprovalValid(ownerApproval) {
  return ownerApproval !== null && typeof ownerApproval === 'object' &&
    ownerApproval.approved === true &&
    typeof ownerApproval.token === 'string' && ownerApproval.token.length >= 8;
}

// Валидация кандидата до любого эффекта: неполный или недоказанный вход
// отклоняется кодированной ошибкой, а не частичным merge. Кандидат обязан
// нести проверенный SHA, идентификатор задачи и квитанцию приёмки
// (receipt.outcome === 'verified' или verdict === 'REVIEW_OK').
export function validateMergeCandidate(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw invalid('merge_candidate_invalid');
  }
  if (typeof candidate.sha !== 'string' || !SHA_RE.test(candidate.sha)) {
    throw invalid('merge_candidate_sha_invalid');
  }
  const taskIdValid = typeof candidate.taskId === 'string'
    ? candidate.taskId !== ''
    : typeof candidate.taskId === 'number' && Number.isSafeInteger(candidate.taskId);
  if (!taskIdValid) throw invalid('merge_candidate_task_id_required');
  const verdict = candidate.verdict ?? candidate.receipt?.verdict;
  if (candidate.receipt?.outcome !== 'verified' && verdict !== 'REVIEW_OK') {
    throw invalid('merge_candidate_review_evidence_required');
  }
  if (typeof candidate.targetBranch !== 'string' || candidate.targetBranch === '') {
    throw invalid('merge_target_branch_required');
  }
  if (isProtectedBranch(candidate.targetBranch) && !ownerApprovalValid(candidate.ownerApproval)) {
    throw invalid('protected_branch_requires_owner_approval');
  }
  return true;
}

const REQUIRED_PORTS = ['isAncestor', 'getHead', 'tryFastForward', 'tryRebase',
  'runSmokeCheck', 'updateBranch'];

function checkPorts(ports) {
  if (ports === null || typeof ports !== 'object') throw invalid('merge_ports_required');
  for (const name of REQUIRED_PORTS) {
    if (typeof ports[name] !== 'function') throw invalid('merge_port_missing');
  }
}

function portFailed(result) {
  return result !== null && typeof result === 'object' && result.ok === false;
}

// Обрабатывает одного кандидата: fast-forward, когда голова интеграционной
// ветки — предок кандидата; иначе rebase с обязательной smoke-проверкой
// перебазированного SHA. Конфликт и падение smoke возвращают кандидата
// воркеру, не трогая targetBranch. Ошибки валидации — отказ до эффекта.
export async function processMergeCandidate(candidate, ports) {
  validateMergeCandidate(candidate);
  checkPorts(ports);
  const branch = candidate.targetBranch;
  const head = await ports.getHead(branch);
  if (typeof head === 'string' && SHA_RE.test(head) && await ports.isAncestor(head, candidate.sha)) {
    const ff = await ports.tryFastForward(branch, candidate.sha);
    if (portFailed(ff)) throw invalid(ff.reason ?? 'fast_forward_failed');
    return { status: 'merged', mode: 'fast_forward', sha: candidate.sha, retested: false };
  }
  const rebase = await ports.tryRebase(branch, candidate.sha);
  if (!rebase || rebase.ok !== true) {
    return { status: 'conflict',
      conflicts: Array.isArray(rebase?.conflicts) ? rebase.conflicts : [],
      action: 'return_to_worker' };
  }
  if (typeof rebase.rebasedSha !== 'string' || !SHA_RE.test(rebase.rebasedSha)) {
    throw invalid('rebase_result_invalid');
  }
  // Перебазированный SHA — новый коммит: L1 smoke повторяется всегда,
  // кандидат без перепроверки в интеграционную ветку не попадает.
  const smoke = await ports.runSmokeCheck(rebase.rebasedSha);
  if (!smoke || smoke.ok !== true) {
    return { status: 'smoke_failed', rebasedSha: rebase.rebasedSha,
      reason: smoke?.reason ?? 'smoke_check_failed', action: 'return_to_worker' };
  }
  const updated = await ports.updateBranch(branch, rebase.rebasedSha);
  if (portFailed(updated)) throw invalid(updated.reason ?? 'update_branch_failed');
  return { status: 'merged', mode: 'rebased', sha: rebase.rebasedSha, retested: true };
}

// FIFO-обработка очереди: результат каждого кандидата фиксируется по
// индексу, конфликт или невалидный элемент не прерывает независимые
// кандидаты следом. Порядок результатов совпадает с порядком входа.
export async function drainMergeQueue(candidates, ports) {
  if (!Array.isArray(candidates)) throw invalid('merge_queue_invalid');
  const results = [];
  for (const candidate of candidates) {
    try {
      results.push({ taskId: candidate?.taskId ?? null, ...await processMergeCandidate(candidate, ports) });
    } catch (error) {
      results.push({ taskId: candidate?.taskId ?? null, status: 'invalid',
        reason: error?.message ?? 'merge_candidate_invalid' });
    }
  }
  return results;
}
