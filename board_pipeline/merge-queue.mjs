// Детерминированная fail-closed очередь слияния проверенных кандидатов
// (REVIEW_OK) в интеграционную ветку. В ядре все эффекты
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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// Канонизирует имя ветки для политических решений: trim, отказ по управляющим
// символам, пробелам внутри и '..' ДО снятия префиксов — иначе отброшенный
// remote-сегмент отмывал бы запрещённые символы (refs/remotes/../dev),
// а затем снятие префиксов refs/heads/, refs/remotes/<remote>/ и origin/ до
// неподвижной точки (refs/remotes/origin/main — remote-tracking ref, ветка
// main). Снятие регистронезависимо: защищённое сравнение идёт в нижнем
// регистре, поэтому и префиксная обёртка не должна зависеть от написания —
// иначе ORIGIN/main обходил бы гейт, который origin/main не проходит. Пустой
// remote-сегмент (refs/remotes//dev) и отсутствие ветки после него
// отклоняются. Пустой остаток после снятия префиксов — тоже отказ (null).
export function canonicalizeBranchName(branch) {
  if (typeof branch !== 'string') return null;
  const trimmed = branch.trim();
  if (trimmed === '' || CONTROL_CHARS_RE.test(trimmed) || /\s/.test(trimmed) ||
      trimmed.includes('..')) {
    return null;
  }
  let value = trimmed;
  for (;;) {
    const lower = value.toLowerCase();
    if (lower.startsWith('refs/heads/')) {
      value = value.slice('refs/heads/'.length);
    } else if (lower.startsWith('refs/remotes/')) {
      const rest = value.slice('refs/remotes/'.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) return null; // нет ветки после remote или пустой remote-сегмент
      value = rest.slice(slash + 1);
    } else if (lower.startsWith('origin/')) {
      value = value.slice('origin/'.length);
    } else {
      break;
    }
    if (value === '') return null;
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

// Local-only Git ports. The target is a dedicated, non-checked-out local
// branch, never the worker branch or the operator's current checkout. A
// fresh claim fast-forwards only a clean, enrolled slot. No reset on drift.
export function localIntegrationQueue({ git: command, branch, slotBranch }) {
  if (!branch || canonicalizeBranchName(branch) !== branch || isProtectedBranch(branch) ||
      !slotBranch || isProtectedBranch(slotBranch) || branch === slotBranch || branch.startsWith('refs/') || branch.startsWith('-')) {
    throw new Error('integration_branch_invalid');
  }
  const ref = `refs/heads/${branch}`;
  const git = (...args) => command('--no-replace-objects', ...args);
  const head = () => git('rev-parse', '--verify', `${ref}^{commit}`);
  async function ok(...args) {
    try { await git(...args); return true; }
    catch (e) { if ((e.status ?? e.code) === 1) return false; throw e; }
  }
  async function checkTarget() {
    await git('check-ref-format', ref);
    if (await ok('symbolic-ref', '-q', ref) ||
        (await git('worktree', 'list', '--porcelain', '-z')).split('\0').includes(`branch ${ref}`)) {
      throw new Error('integration_branch_in_use');
    }
  }
  const ancestor = (a, b) => ok('merge-base', '--is-ancestor', a, b);
  async function initialize(seed) {
    if (typeof seed !== 'string' || !SHA_RE.test(seed)) throw new Error('integration_seed_invalid');
    await checkTarget();
    if (!await ok('show-ref', '--verify', '--quiet', ref)) {
      // A competing slot may initialize the same ref. Always check ancestry
      // below, including after losing the create-only compare-and-swap.
      try { await git('update-ref', '--no-deref', ref, seed, '0'.repeat(40)); }
      catch (error) { if (!await ok('show-ref', '--verify', '--quiet', ref)) throw error; }
    }
    const tip = await head();
    if (!await ancestor(seed, tip)) throw new Error('integration_seed_mismatch');
    return tip;
  }
  async function prepare(seed) {
    if (await git('branch', '--show-current') !== slotBranch ||
        await git('status', '--porcelain=v1', '--untracked-files=all')) throw new Error('integration_slot_not_clean');
    const current = await git('rev-parse', 'HEAD');
    const base = await initialize(seed ?? current);
    if (base !== current) {
      await git('merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', base);
      if (await git('rev-parse', 'HEAD') !== base) throw new Error('integration_slot_diverged');
    }
    return base;
  }
  async function integrateOnce({ taskId, base, sha, runL1, beforeUpdate }) {
    if (!SHA_RE.test(base) || !SHA_RE.test(sha) || !await ancestor(base, sha)) throw new Error('integration_base_invalid');
    let expected, scratch, tree, added = false;
    const update = async (_, next, { expectedHead }) => {
      await checkTarget();
      if (!await ancestor(expectedHead, next)) throw new Error('integration_not_fast_forward');
      await beforeUpdate?.();
      try { await git('update-ref', '--no-deref', ref, next, expectedHead); }
      catch (error) {
        if (await head() !== expectedHead) return { ok: false, reason: 'integration_head_changed' };
        throw error;
      }
    };
    try {
      return await processMergeCandidate({ taskId, sha, receipt: { outcome: 'verified' }, targetBranch: branch }, {
        getHead: async () => {
          expected = await head();
          if (!await ancestor(base, expected)) throw new Error('integration_base_diverged');
          return expected;
        }, isAncestor: ancestor, tryFastForward: update, updateBranch: update,
        async tryRebase() {
          if (await git('rev-list', '--merges', '--max-count=1', `${base}..${sha}`)) {
            throw new Error('integration_nonlinear_candidate'); // do not flatten verified merge resolutions
          }
          scratch = await mkdtemp(join(tmpdir(), 'df-integration-'));
          tree = join(scratch, 'rebase');
          await git('worktree', 'add', '--detach', tree, sha);
          added = true;
          // Rebase the verified range, never a branch name. Do not let local
          // rebase.updateRefs move any other worktree or integration ref.
          try {
            await git('-C', tree, '-c', 'user.name=Darkfactory', '-c', 'user.email=queue@localhost',
              '-c', 'rerere.enabled=false', 'rebase', '--no-update-refs', '--no-gpg-sign',
              '--no-autostash', '--no-autosquash', '--no-fork-point', '--onto', expected, base);
          } catch (error) {
            if (await git('-C', tree, 'ls-files', '--unmerged')) return { ok: false };
            throw error;
          }
          return { ok: true, rebasedSha: await git('-C', tree, 'rev-parse', 'HEAD') };
        },
        runSmokeCheck: async rebasedSha => {
          const result = await runL1(rebasedSha);
          return { ok: result?.ok === true && result.sha === rebasedSha };
        },
      });
    } finally {
      if (added) await git('worktree', 'remove', '--force', tree);
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }
  async function mergeVerified(subject) {
    for (let i = 0; i < 3; ++i) {
      const result = await integrateOnce(subject);
      if (result.status === 'merged') return result;
      // Only retry a proven ref race. Re-read head and re-run L1 for the
      // new SHA; never retry a conflict, failed recipe or lost authorization.
      if (result.reason !== 'integration_head_changed') {
        throw new Error(`integration_${result.status}:${result.reason ?? 'not_merged'}`);
      }
    }
    throw new Error('integration_head_unstable');
  }
  return { branch, initialize, prepare, head, mergeVerified };
}

// Native complete immediately exposes dependent cards to *all* dispatchers.
// Keep it last. Its evidence refers to the original L2 subject; the private
// integration receipt separately records the actual ref and rebased L1 SHA.
export function verifiedCompletionBoard(board, { queue, attempt, candidate, runL1, guard, record }) {
  if (!queue) return board;
  return { ...board, async complete(id, epoch, evidence) {
    if (id !== attempt.task_id || epoch !== attempt.epoch || evidence.sha !== candidate) {
      throw new Error('integration_subject_mismatch');
    }
    await guard();
    const merged = await queue.mergeVerified({ taskId: id, base: attempt.base_sha, sha: candidate,
      beforeUpdate: guard, runL1 });
    await record({ taskId: id, candidate, base: attempt.base_sha, targetBranch: queue.branch, ...merged });
    await guard();
    return board.complete(id, epoch, evidence);
  } };
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
