// Детерминированная fail-closed очередь слияния проверенных кандидатов
// (REVIEW_OK) в интеграционную ветку. Модуль не знает о git: все эффекты
// идут через внедряемые чистые порты, поэтому поведение воспроизводимо и
// проверяется без внешних зависимостей.
//
// Инварианты:
//  - защищённые ветки (main/master/production/release/*) никогда не
//    получают автоматический merge без явного допуска владельца; имя ветки
//    канонизируется до проверки, поэтому обход через refs/heads/main,
//    refs/remotes/origin/main, origin/main или другое написание (MAIN)
//    невозможен;
//  - допуск владельца доказывается криптографически: либо внедрённым портом
//    verifyOwnerApproval(candidate, ownerApproval), либо HMAC-SHA256 по
//    связке taskId|sha|canonicalBranch с timingSafeEqual-сравнением; без
//    верификатора и секрета защищённая цель отклоняется (fail closed);
//  - обновление ветки compare-and-swap: tryFastForward и updateBranch
//    получают expectedHead — голову, прочитанную в начале обработки;
//  - не-fast-forward слияние обязано пройти повторную L1 smoke-проверку
//    перебазированного SHA до обновления ветки;
//  - конфликт и падение smoke-проверки никогда не двигают targetBranch —
//    кандидат возвращается воркеру с диагностикой;
//  - транзиентный сбой порта — status 'error' с action 'retry', отличный
//    от 'invalid': вызывающий может повторить попытку.

import { createHmac, timingSafeEqual } from 'node:crypto';

const SHA_RE = /^[a-f0-9]{40}$/;
const CONTROL_CHARS_RE = /[\0-\x1f\x7f]/;

export const PROTECTED_BRANCH_PATTERNS = Object.freeze(['main', 'master', 'production', 'release/*']);

class MergeQueueInvalid extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function invalid(code) {
  return new MergeQueueInvalid(code);
}

// Канонизирует имя ветки для политических решений: trim, снятие префиксов
// refs/heads/, refs/remotes/<remote>/ и origin/ до неподвижной точки
// (refs/remotes/origin/main — remote-tracking ref, ветка main). Вход с
// управляющими символами, пробельными символами внутри, '..', пустой после
// trim или пустой после снятия префиксов отклоняется (null) — такое имя не
// может участвовать в слиянии и отсекается валидацией раньше.
export function canonicalizeBranchName(branch) {
  if (typeof branch !== 'string') return null;
  let value = branch.trim();
  let previous;
  do {
    previous = value;
    if (value.startsWith('refs/heads/')) {
      value = value.slice('refs/heads/'.length);
    } else if (value.startsWith('refs/remotes/')) {
      const rest = value.slice('refs/remotes/'.length);
      const slash = rest.indexOf('/');
      value = slash === -1 ? '' : rest.slice(slash + 1);
    } else if (value.startsWith('origin/')) {
      value = value.slice('origin/'.length);
    }
  } while (value !== previous);
  if (value === '' || CONTROL_CHARS_RE.test(value) || /\s/.test(value) ||
      value.includes('..')) {
    return null;
  }
  return value;
}

// Точное совпадение для простых имён и префиксное для шаблонов с '*'.
// Сравнение идёт по канонизированному имени в нижнем регистре, поэтому
// написание не влияет на решение. Неканонизируемый вход — не защищённая
// ветка здесь, но отклоняется валидацией кандидата до любого эффекта.
export function isProtectedBranch(branch) {
  const canonical = canonicalizeBranchName(branch);
  if (canonical === null) return false;
  const lower = canonical.toLowerCase();
  for (const pattern of PROTECTED_BRANCH_PATTERNS) {
    if (pattern.endsWith('*')) {
      if (lower.startsWith(pattern.slice(0, -1))) return true;
    } else if (lower === pattern) {
      return true;
    }
  }
  return false;
}

// Токен допуска владельца: HMAC-SHA256 по связке taskId|sha|canonicalBranch.
// Экспортируется, чтобы выписывающая сторона и тесты считали токен ровно
// тем же способом, что и верификатор.
export function computeOwnerApprovalToken(secret, taskId, sha, canonicalBranch) {
  return createHmac('sha256', secret).update(`${taskId}|${sha}|${canonicalBranch}`).digest('hex');
}

function tokenMatches(expectedHex, presented) {
  if (typeof presented !== 'string' || !/^[a-f0-9]{64}$/.test(presented)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const given = Buffer.from(presented, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Допуск владельца доказывается только криптографически: внедрённый порт
// verifyOwnerApproval(candidate, ownerApproval) — единоличный авторитет,
// когда он есть; иначе HMAC-сверка токена с timingSafeEqual. Ни флаг
// approved, ни длина токена сами по себе ничего не доказывают. Без
// верификатора и секрета — fail closed. Сбой верификатора трактуется как
// отсутствие допуска: секьюрити-гейт не может открыться из-за ошибки.
async function ownerApprovalVerified(candidate, canonicalBranch, ports, options) {
  const verifier = typeof ports?.verifyOwnerApproval === 'function'
    ? ports.verifyOwnerApproval
    : typeof options?.verifyOwnerApproval === 'function' ? options.verifyOwnerApproval : null;
  if (verifier !== null) {
    try {
      return await verifier(candidate, candidate.ownerApproval) === true;
    } catch {
      return false;
    }
  }
  const secret = options?.ownerApprovalSecret;
  if (typeof secret !== 'string' || secret === '') return false;
  const expected = computeOwnerApprovalToken(secret, candidate.taskId, candidate.sha, canonicalBranch);
  return tokenMatches(expected, candidate.ownerApproval?.token);
}

// Валидация кандидата до любого эффекта: неполный или недоказанный вход
// отклоняется кодированной ошибкой, а не частичным merge. Кандидат обязан
// нести проверенный SHA, идентификатор задачи и квитанцию приёмки
// (receipt.outcome === 'verified' или verdict === 'REVIEW_OK'), а имя ветки —
// канонизироваться. Допуск владельца здесь не проверяется: для него нужны
// верификатор или секрет, доступные только в processMergeCandidate.
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
  if (canonicalizeBranchName(candidate.targetBranch) === null) {
    throw invalid('merge_target_branch_invalid');
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

function transientError(reason) {
  return { status: 'error', reason, action: 'retry' };
}

// Обрабатывает одного кандидата: fast-forward, когда голова интеграционной
// ветки — предок кандидата; иначе rebase с обязательной smoke-проверкой
// перебазированного SHA. Конфликт и падение smoke возвращают кандидата
// воркеру, не трогая targetBranch. Ошибки валидации и отсутствие допуска
// владельца — отказ до эффекта. Транзиентные сбои портов (исключение порта,
// ok:false от tryFastForward/updateBranch — в том числе CAS-рассинхрон)
// возвращают status 'error' с action 'retry': вызывающий вправе повторить.
// Все обращения к ветке идут по канонизированному имени, а эффекты — с
// expectedHead прочитанной головы, чтобы ушедшая голова не приняла merge.
export async function processMergeCandidate(candidate, ports, options = {}) {
  validateMergeCandidate(candidate);
  checkPorts(ports);
  const branch = canonicalizeBranchName(candidate.targetBranch);
  if (isProtectedBranch(branch) &&
      !await ownerApprovalVerified(candidate, branch, ports, options)) {
    throw invalid('protected_branch_requires_owner_approval');
  }
  try {
    const head = await ports.getHead(branch);
    if (typeof head === 'string' && SHA_RE.test(head) && await ports.isAncestor(head, candidate.sha)) {
      const ff = await ports.tryFastForward(branch, candidate.sha, { expectedHead: head });
      if (portFailed(ff)) return transientError(ff.reason ?? 'fast_forward_failed');
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
    const updated = await ports.updateBranch(branch, rebase.rebasedSha, { expectedHead: head });
    if (portFailed(updated)) return transientError(updated.reason ?? 'update_branch_failed');
    return { status: 'merged', mode: 'rebased', sha: rebase.rebasedSha, retested: true };
  } catch (error) {
    // Кодированные ошибки контракта (невалидный результат rebase) остаются
    // постоянными отказами; всё остальное из зоны портов — транзиентный
    // сбой инфраструктуры, который вызывающий может повторить.
    if (error instanceof MergeQueueInvalid) throw error;
    return transientError(typeof error?.message === 'string' && error.message !== ''
      ? error.message : 'merge_port_failure');
  }
}

// FIFO-обработка очереди: результат каждого кандидата фиксируется по
// индексу, конфликт, транзиентный сбой или невалидный элемент не прерывает
// независимые кандидаты следом. Порядок результатов совпадает с порядком
// входа. 'invalid' — постоянный отказ, 'error' — повторяемый.
export async function drainMergeQueue(candidates, ports, options = {}) {
  if (!Array.isArray(candidates)) throw invalid('merge_queue_invalid');
  const results = [];
  for (const candidate of candidates) {
    try {
      results.push({ taskId: candidate?.taskId ?? null, ...await processMergeCandidate(candidate, ports, options) });
    } catch (error) {
      results.push({ taskId: candidate?.taskId ?? null, status: 'invalid',
        reason: error?.message ?? 'merge_candidate_invalid' });
    }
  }
  return results;
}
