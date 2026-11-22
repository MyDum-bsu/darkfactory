// Ядро приёмки F1: submit → local_checks → review → completed | blocked.
// Все внешние эффекты — только через порты. Журнал append-only: intent ДО эффекта.

import { open, readFile, appendFile, lstat, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildSubject, canonicalJson, subjectDigest } from './subject.mjs';
import { assertCrossFamily, hasValidFinding, ReviewDenied } from './review-runner.mjs';
import { isLegacyPiReview, isNeonReview, isReviewSkillList, isSolArbiter } from './review-policy.mjs';
import { assertTriadIndependent } from './worker-selector.mjs';

const HANDOFF_KEYS = [
  'task_id',
  'worker_thread_id',
  'base_sha',
  'candidate_sha',
  'worktree',
  'check_profile',
];

// Доверенная привязка попытки пишется только контроллером.
const ATTEMPT_KEYS = [
  'attempt_id',
  'task_id',
  'epoch',
  'bb_thread_id',
  'worktree',
  'base_sha',
  'check_profile',
  'finish',
];

// Контракт приёмки, закреплённый контроллером при claim (метки карточки): необязателен
// для ручного v1, но обязателен целиком, когда задан хоть один его обязательный член.
const ATTEMPT_OPTIONAL = [
  'repo_id',
  'tree_sha',
  'spec_digest',
  'policy_digest',
  'fixtures_digest',
  'release_target',
  'has_ui',
  'executor',
  'arbiter',
  'fallback_reason',
  'attempted_workers',
];
const CONTRACT_REQUIRED = ['repo_id', 'spec_digest', 'policy_digest'];
const RELEASE_TARGET_KEYS = ['finish', 'target_id', 'release_channel', 'previous_live_digest'];

// Сдача воркера: типизированный результат, без worktree/профиля/команд/токена.
const SUBMISSION_KEYS = ['task_id', 'epoch', 'attempt_id', 'worker_thread_id', 'candidate_sha'];
const SUBMISSION_OPTIONAL = ['dispute'];

const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const REVIEW_OK = 'REVIEW_OK';
const REVIEW_BLOCKED = 'REVIEW_BLOCKED';
const REVIEW_ESCALATE = 'REVIEW_ESCALATE';
const FINISH = new Set(['verified', 'deployed']);

class Denied extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function sanitize(s) {
  return String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function runId(taskId, sha, version) {
  return `run-${sanitize(taskId)}-${sanitize(sha)}-v${sanitize(version)}`;
}

// Имя журнала ограничено байтами ФС: длинный составной ключ детерминированно
// сворачивается в хэш — тот же запуск всегда получает тот же файл.
function journalId(id) {
  return id.length <= 200 ? id : `run-${createHash('sha256').update(id).digest('hex')}`;
}

function validateHandoff(handoff) {
  if (handoff === null || typeof handoff !== 'object' || Array.isArray(handoff)) {
    throw new Denied('handoff_not_object');
  }
  const keys = Object.keys(handoff);
  for (const k of keys) {
    if (!HANDOFF_KEYS.includes(k)) throw new Denied(`unexpected_field:${k}`);
  }
  for (const k of HANDOFF_KEYS) {
    if (typeof handoff[k] !== 'string' || handoff[k].length === 0) {
      throw new Denied(`missing_field:${k}`);
    }
  }
  if (!/^[1-9][0-9]{0,14}$/.test(handoff.task_id)) throw new Denied('invalid_task_id');
  if (!/^thr_[a-z0-9]{1,60}$/.test(handoff.worker_thread_id)) throw new Denied('invalid_worker_thread');
  if (!path.isAbsolute(handoff.worktree)) throw new Denied('worktree_not_absolute');
  if (!SHA_RE.test(handoff.candidate_sha)) throw new Denied('candidate_sha_not_full');
  if (!SHA_RE.test(handoff.base_sha)) throw new Denied('base_sha_not_full');
}

function validatePolicy(policy, checkProfile, { allowNeon = false } = {}) {
  if (policy === null || typeof policy !== 'object') throw new Denied('policy_not_object');
  if (typeof policy.version !== 'string' && typeof policy.version !== 'number') {
    throw new Denied('policy_version_missing');
  }
  if (String(policy.version).length > 64) throw new Denied('policy_version_too_long');
  const profiles = policy.profiles;
  if (profiles === null || typeof profiles !== 'object') throw new Denied('profiles_missing');
  const profile = Object.hasOwn(profiles, checkProfile) ? profiles[checkProfile] : null;
  if (profile === null || typeof profile !== 'object') {
    throw new Denied(`unknown_profile:${checkProfile}`);
  }
  const legacy = isLegacyPiReview(profile.review);
  const neon = allowNeon && isNeonReview(profile.review) && isReviewSkillList(profile.review.skills);
  if (!legacy && !neon) {
    throw new Denied('review_profile_not_approved');
  }
  return profile;
}

function strictKeys(record, allowed, optional = []) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Denied('record_not_object');
  }
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key) && !optional.includes(key)) throw new Denied(`unexpected_field:${key}`);
  }
  for (const key of allowed) {
    if (typeof record[key] === 'string' && record[key].length > 0) continue;
    if (key === 'epoch' && Number.isSafeInteger(record.epoch) && record.epoch > 0) continue;
    throw new Denied(`missing_field:${key}`);
  }
}

// Контракт либо отсутствует целиком (ручной v1 без манифеста), либо закреплён полностью.
// tree_sha в попытке необязателен: он берётся из реального Git-снимка при инспекции.
function validateContract(attempt) {
  const pinned = CONTRACT_REQUIRED.some(key => attempt[key] !== undefined);
  if (!pinned) {
    for (const key of ['tree_sha', 'fixtures_digest', 'release_target']) {
      if (attempt[key] !== undefined) throw new Denied('subject_contract_incomplete');
    }
    return;
  }
  for (const key of CONTRACT_REQUIRED) {
    if (attempt[key] === undefined) throw new Denied('subject_contract_incomplete');
  }
  if (typeof attempt.repo_id !== 'string' || !REPO_ID_RE.test(attempt.repo_id)) {
    throw new Denied('invalid_repo_id');
  }
  if (attempt.tree_sha !== undefined && !SHA_RE.test(attempt.tree_sha)) {
    throw new Denied('tree_sha_not_full');
  }
  for (const key of ['spec_digest', 'policy_digest']) {
    if (!SHA256_RE.test(attempt[key])) throw new Denied(`invalid_${key}`);
  }
  if (attempt.fixtures_digest !== undefined) {
    if (attempt.fixtures_digest !== null && !SHA256_RE.test(attempt.fixtures_digest)) {
      throw new Denied('invalid_fixtures_digest');
    }
  }
  const target = attempt.release_target;
  if (target !== undefined) {
    if (target === null || typeof target !== 'object' || Array.isArray(target)) {
      throw new Denied('invalid_release_target');
    }
    for (const key of Object.keys(target)) {
      if (!RELEASE_TARGET_KEYS.includes(key)) throw new Denied(`unexpected_field:${key}`);
    }
    if (!FINISH.has(target.finish)) throw new Denied('invalid_release_target');
    for (const key of ['target_id', 'release_channel', 'previous_live_digest']) {
      const value = target[key];
      if (value !== undefined && value !== null && (typeof value !== 'string' || !value)) {
        throw new Denied('invalid_release_target');
      }
    }
  }
}

function validateAttempt(attempt) {
  strictKeys(attempt, ATTEMPT_KEYS, ATTEMPT_OPTIONAL);
  if (!/^[1-9][0-9]{0,14}$/.test(attempt.task_id)) throw new Denied('invalid_task_id');
  if (!Number.isSafeInteger(attempt.epoch) || attempt.epoch <= 0) throw new Denied('invalid_epoch');
  if (!ID_RE.test(attempt.attempt_id)) throw new Denied('invalid_attempt_id');
  if (!/^thr_[a-z0-9]{1,60}$/.test(attempt.bb_thread_id)) throw new Denied('invalid_worker_thread');
  if (!path.isAbsolute(attempt.worktree)) throw new Denied('worktree_not_absolute');
  if (!SHA_RE.test(attempt.base_sha)) throw new Denied('base_sha_not_full');
  if (!FINISH.has(attempt.finish)) throw new Denied('invalid_finish');
  if (attempt.has_ui !== undefined && typeof attempt.has_ui !== 'boolean') {
    throw new Denied('invalid_has_ui');
  }
  if (attempt.executor !== undefined && !validWorkerSpec(attempt.executor)) {
    throw new Denied('invalid_executor');
  }
  if (attempt.arbiter !== undefined && !validWorkerSpec(attempt.arbiter)) {
    throw new Denied('invalid_arbiter');
  }
  if (attempt.fallback_reason !== undefined && attempt.fallback_reason !== null &&
      typeof attempt.fallback_reason !== 'string') {
    throw new Denied('invalid_fallback_reason');
  }
  if (attempt.attempted_workers !== undefined &&
      (!Array.isArray(attempt.attempted_workers) ||
        !attempt.attempted_workers.every(w => w !== null && typeof w === 'object' &&
          !Array.isArray(w) && typeof w.provider === 'string' && w.provider.length > 0))) {
    throw new Denied('invalid_attempted_workers');
  }
  validateContract(attempt);
}

// Манифест приёмки этой попытки; null для ручного v1 без закреплённого контракта.
// tree_sha приходит из реального Git-снимка (инспекция) или из закреплённой попытки.
function attemptSubject(attempt, submission, treeSha) {
  if (attempt.spec_digest === undefined) return null;
  const target = attempt.release_target;
  return buildSubject({
    kind: 'git_tree',
    repoId: attempt.repo_id,
    baseSha: attempt.base_sha,
    candidateSha: submission.candidate_sha,
    treeSha,
    specDigest: attempt.spec_digest,
    policyDigest: attempt.policy_digest,
    fixturesDigest: attempt.fixtures_digest ?? null,
    releaseTarget: target ? {
      finish: target.finish,
      targetId: target.target_id ?? null,
      releaseChannel: target.release_channel ?? null,
      previousLiveDigest: target.previous_live_digest ?? null,
    } : { finish: attempt.finish },
  });
}

// Ключ контракта для журнала: смена spec/policy/fixtures/release/tree при том же SHA
// создаёт новый запуск вместо переиспользования старого терминального вердикта.
// Закреплённый tree_sha входит в ключ; когда дерево берётся из снимка, в ключе null.
function contractKey(attempt) {
  if (attempt.spec_digest === undefined) return null;
  return createHash('sha256').update(canonicalJson({
    repo_id: attempt.repo_id,
    base_sha: attempt.base_sha,
    tree_sha: attempt.tree_sha ?? null,
    spec_digest: attempt.spec_digest,
    policy_digest: attempt.policy_digest,
    fixtures_digest: attempt.fixtures_digest ?? null,
    release_target: attempt.release_target ?? null,
    finish: attempt.finish,
    has_ui: attempt.has_ui ?? null,
  })).digest('hex');
}

// Сверка контракта записи журнала с текущей попыткой: ключ совпал, а контракт нет —
// журнал не может подтвердить вердикт для этого манифеста.
function sameContract(runEntry, attempt) {
  if (attempt.spec_digest === undefined) return true;
  const recorded = runEntry?.contract;
  if (recorded === null || typeof recorded !== 'object') return false;
  return recorded.repo_id === attempt.repo_id &&
    (recorded.tree_sha ?? null) === (attempt.tree_sha ?? null) &&
    recorded.spec_digest === attempt.spec_digest &&
    recorded.policy_digest === attempt.policy_digest &&
    (recorded.fixtures_digest ?? null) === (attempt.fixtures_digest ?? null) &&
    (JSON.stringify(recorded.release_target ?? null) ===
      JSON.stringify(attempt.release_target ?? null)) &&
    (recorded.has_ui ?? null) === (attempt.has_ui ?? null);
}

// Сверка сдачи с доверенной попыткой. Любое расхождение — отказ до эффекта.
function validWorkerSpec(spec) {
  return (typeof spec === 'string' && spec.length > 0 && spec.length <= 128) ||
    (spec !== null && typeof spec === 'object' && !Array.isArray(spec) &&
      typeof spec.provider === 'string' && spec.provider.length > 0);
}

function validateSubmission(submission, attempt) {
  strictKeys(submission, SUBMISSION_KEYS, SUBMISSION_OPTIONAL);
  if (!/^[1-9][0-9]{0,14}$/.test(submission.task_id)) throw new Denied('invalid_task_id');
  if (!Number.isSafeInteger(submission.epoch) || submission.epoch <= 0) throw new Denied('invalid_epoch');
  if (!ID_RE.test(submission.attempt_id)) throw new Denied('invalid_attempt_id');
  if (!/^thr_[a-z0-9]{1,60}$/.test(submission.worker_thread_id)) throw new Denied('invalid_worker_thread');
  if (!SHA_RE.test(submission.candidate_sha)) throw new Denied('candidate_sha_not_full');
  if (submission.task_id !== attempt.task_id) throw new Denied('task_mismatch');
  if (submission.epoch !== attempt.epoch) throw new Denied('epoch_mismatch');
  if (submission.attempt_id !== attempt.attempt_id) throw new Denied('attempt_mismatch');
  if (submission.worker_thread_id !== attempt.bb_thread_id) throw new Denied('worker_thread_mismatch');
  // Структурированный спор против замечания L2: ссылка на находку, аргументация
  // и опора на спеку — все три непустые строки, иначе это не спор.
  if (submission.dispute !== undefined) {
    const d = submission.dispute;
    const ok = d !== null && typeof d === 'object' && !Array.isArray(d) &&
      ['finding_ref', 'justification', 'spec_evidence'].every(
        k => typeof d[k] === 'string' && d[k].trim().length > 0);
    if (!ok) throw new Denied('invalid_dispute');
  }
}

// Политика профиля должна описывать именно эту попытку, а не сдачу.
function validateEnrolled(attempt, profile) {
  if (profile.task !== attempt.task_id) throw new Denied('profile_task_mismatch');
  if (profile.worker !== attempt.bb_thread_id) throw new Denied('profile_worker_mismatch');
  if (profile.worktree !== attempt.worktree) throw new Denied('profile_worktree_mismatch');
  if (profile.base !== attempt.base_sha) throw new Denied('profile_base_mismatch');
  if (profile.finish !== undefined && profile.finish !== attempt.finish) {
    throw new Denied('profile_finish_mismatch');
  }
}

function inspectionProblem(inspection, sha) {
  if (inspection?.head !== sha) return `head_mismatch:${inspection?.head}`;
  if (inspection.clean !== true) return 'dirty_worktree';
  if (inspection.baseAncestor !== true) return 'base_not_ancestor';
  return null;
}

async function readExistingRun(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      // JSON-литерал null и примитивы не являются записями журнала: это порча строки.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        entries.push({ kind: 'corrupt', raw: line });
      } else {
        entries.push(parsed);
      }
    } catch {
      entries.push({ kind: 'corrupt', raw: line });
    }
  }
  return entries;
}

function terminalOutcome(entries) {
  const last = [...entries].reverse().find((e) => e?.kind === 'outcome');
  if (!last || entries.some((entry) => entry?.kind === 'corrupt')) return null;
  const { kind, seq, ...record } = last;
  return record;
}

function messageOf(error) {
  return String(error?.message ?? error);
}

// Компактная квитанция для Board.complete: гарантированно <= 1000 символов и без потери
// sha, subject_digest, статуса проверок и вердикта ревью. Полная квитанция живёт в журнале,
// карточка ссылается на неё ключом запуска. Ужатие детерминированное: сначала ссылки на
// логи, затем сам список проверок; не влезло — честная ошибка, а не молчаливая усечка.
function compactChecks(checks) {
  const items = Array.isArray(checks) ? checks : checks === undefined || checks === null ? [] : [checks];
  const list = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item === 'string') {
      list.push({ i, ok: true, ref: item.slice(0, 48) });
      continue;
    }
    if (item === null || typeof item !== 'object') {
      list.push({ i, ok: false });
      continue;
    }
    list.push({ i, ok: item.exit === 0 || item.ok === true, ref: String(item.file ?? '').slice(0, 48) });
  }
  return { ok: list.length > 0 && list.every(entry => entry.ok), n: list.length, checks: list };
}

// Компактный статус L3: на карточку уходит verdict и сводный хэш артефактов,
// полный VisualReceipt с побайтовыми sha256 остаётся в локальном журнале.
function compactVisual(visual) {
  if (visual === null || typeof visual !== 'object' || visual.status === 'not_applicable') {
    return { status: 'na' };
  }
  const artifacts = Array.isArray(visual.artifacts) ? visual.artifacts : [];
  const hash = createHash('sha256');
  for (const artifact of artifacts) hash.update(String(artifact?.sha256 ?? ''));
  return { status: visual.status === 'pass' ? 'pass' : 'fail', n: artifacts.length, sha256: hash.digest('hex') };
}

function compactEvidence(evidence, run) {
  const review = evidence.review ?? {};
  // Квитанция арбитра входит в тот же компактный конверт: notes ужимается
  // ступенями вместе с остальными полями до гарантированного лимита 1000.
  const arbitration = evidence.arbitration !== null &&
    typeof evidence.arbitration === 'object'
    ? {
        decision: evidence.arbitration.decision,
        subject_digest: evidence.arbitration.subject_digest,
        arbiter: typeof evidence.arbitration.arbiter === 'object'
          ? { provider: evidence.arbitration.arbiter.provider,
              model: evidence.arbitration.arbiter.model }
          : undefined,
        notes: typeof evidence.arbitration.notes === 'string'
          ? evidence.arbitration.notes : undefined,
      }
    : undefined;
  const base = {
    v: 1,
    sha: evidence.sha,
    subject_digest: evidence.subject_digest,
    worker: evidence.worker,
    checks: compactChecks(evidence.checks),
    tamper: evidence.tamper === 'pass' ? 'pass' : 'na',
    visual: compactVisual(evidence.visual),
    review: {
      verdict: review.verdict,
      checkpoint: review.checkpoint,
      provider: review.actual?.provider,
      model: review.actual?.model,
      t: typeof review.transcript_sha256 === 'string' ? review.transcript_sha256.slice(0, 16) : undefined,
    },
    run,
  };
  const withArbitration = (notesBudget) => {
    if (arbitration === undefined) return base;
    const arb = { ...arbitration };
    if (notesBudget !== null && typeof arb.notes === 'string') {
      arb.notes = arb.notes.slice(0, notesBudget);
      arb.notes_sha256 = createHash('sha256')
        .update(arbitration.notes ?? '').digest('hex').slice(0, 16);
    }
    if (notesBudget === 0) delete arb.notes;
    return { ...base, arbitration: arb };
  };
  // Детерминированное ужатие: каждая следующая ступень вызывается и проверяется на лимит.
  const variants = [
    () => withArbitration(null),
    () => withArbitration(400),
    () => withArbitration(120),
    () => ({ ...withArbitration(120), checks: { ...base.checks,
      checks: base.checks.checks.map(({ i, ok }) => ({ i, ok })) } }),
    () => ({ ...withArbitration(120), checks: { ok: base.checks.ok, n: base.checks.n } }),
    () => ({ ...withArbitration(0), checks: { ok: base.checks.ok, n: base.checks.n } }),
  ];
  for (const variant of variants) {
    const candidate = variant();
    const text = JSON.stringify(candidate);
    if (typeof text === 'string' && text.length <= 1000) return candidate;
  }
  throw new Error('Compact Board receipt cannot fit the 1000 character limit');
}

// Один общий механизм Git-снимка, проверок и ревью для ручного v1 и для приёмки по аренде.
// Возвращает verified | rework (исправимый дефект) | hold (среда/неизвестный эффект).
async function runVerification({ binding, profile, ports, intent, step, beforeReview, onInspect, onSnapshot, subjectDigest, journal }) {
  await intent('inspect');
  let ins;
  try {
    ins = await ports.inspect(binding);
    await step('inspect', true, ins);
  } catch (e) {
    await step('inspect', false, messageOf(e));
    return { status: 'hold', reason: `inspect_failed:${messageOf(e)}` };
  }
  // Дерево снимка фиксируется сразу после успешной инспекции — до любого
  // отказа inspectionProblem, чтобы попасть в результат и квитанцию.
  if (typeof onInspect === 'function') await onInspect(ins);
  const problem = inspectionProblem(ins, binding.candidate_sha);
  if (problem) return { status: 'hold', reason: problem };
  if (onSnapshot) {
    const snapshotVerdict = await onSnapshot(ins);
    if (snapshotVerdict) return snapshotVerdict;
  }

  // Команды берутся из профиля, не из сдачи.
  await intent('local');
  let loc;
  try {
    loc = await ports.local(binding, profile);
    await step('local', true, loc);
  } catch (e) {
    await step('local', false, messageOf(e));
    return { status: 'hold', reason: `local_error:${messageOf(e)}` };
  }
  if (loc.sha !== binding.candidate_sha) {
    return { status: 'hold', reason: `local_sha_mismatch:${loc.sha}` };
  }
  if (loc.ok !== true) {
    return {
      status: 'rework',
      reason: 'local_checks_failed',
      feedback: { reason: 'local_checks_failed', evidence: loc.evidence, exit: loc.exit },
      loc,
    };
  }
  if (loc.evidence === undefined || loc.evidence === null || loc.evidence === '') {
    return { status: 'hold', reason: 'missing_evidence' };
  }

  // L1 tamper-gate: статический diff base..candidate до любых вызовов L3 и L2.
  // Гейт обязателен, пока доверенный профиль явно его не отключил; отсутствие
  // подключённого порта — операционный стоп, а не молчаливый пропуск.
  // Красный гейт — исправимый дефект воркера, аренда остаётся живой.
  let tamper = null;
  if (profile.tamper !== false) {
    if (typeof ports.tamper !== 'function') {
      return { status: 'hold', reason: 'tamper_port_missing' };
    }
    await intent('tamper');
    try {
      tamper = await ports.tamper(binding, profile);
      await step('tamper', true, { ok: tamper?.ok === true, digest: tamper?.digest ?? null });
    } catch (e) {
      await step('tamper', false, messageOf(e));
      return { status: 'hold', reason: `tamper_error:${messageOf(e)}` };
    }
    if (tamper?.sha !== undefined && tamper.sha !== binding.candidate_sha) {
      return { status: 'hold', reason: `tamper_sha_mismatch:${tamper.sha}` };
    }
    if (tamper?.ok !== true) {
      return {
        status: 'rework',
        reason: 'tamper_gate_failed',
        feedback: { reason: 'tamper_gate_failed', violations: tamper?.violations ?? [],
          digest: tamper?.digest ?? null },
        loc, tamper,
      };
    }
  }

  // L3 визуальный UI-гейт: на том же неизменяемом снимке, до вызова ревьюера.
  // Явное has_ui:false в доверенной попытке отключает гейт даже при has_ui в
  // профиле; иначе решает профиль оператора.
  const hasUi = binding.has_ui !== undefined && binding.has_ui !== null
    ? binding.has_ui === true
    : profile.has_ui === true;
  let visual = { status: 'not_applicable' };
  if (hasUi) {
    if (typeof ports.visual !== 'function') {
      return { status: 'hold', reason: 'visual_port_missing' };
    }
    await intent('visual');
    let vis;
    try {
      vis = await ports.visual(binding, profile);
      await step('visual', true, vis);
    } catch (e) {
      await step('visual', false, messageOf(e));
      return { status: 'hold', reason: `visual_error:${messageOf(e)}` };
    }
    if (vis?.ok !== true) {
      return {
        status: 'rework',
        reason: 'visual_gate_failed',
        feedback: { reason: 'visual_gate_failed', status: vis?.status ?? 'fail',
          artifacts: vis?.artifacts ?? [], evidence: vis?.evidence ?? null },
        loc, tamper, visual: vis,
      };
    }
    // Зелёный L3 должен быть аттестованной квитанцией: тот же SHA, статус pass,
    // наблюдаемые артефакты с sha256 и evidence. Неаттестованный «pass» — стоп.
    const attested = vis.status === 'pass' && vis.sha === binding.candidate_sha &&
      Array.isArray(vis.artifacts) && vis.artifacts.length > 0 &&
      vis.artifacts.every((a) => a !== null && typeof a === 'object' &&
        typeof a.name === 'string' && a.name.length > 0 &&
        /^[0-9a-f]{64}$/.test(a.sha256 ?? '') &&
        Number.isSafeInteger(a.bytes) && a.bytes >= 1) &&
      (() => {
        const ev = vis.evidence;
        const isPlain = (item) => item !== null && typeof item === 'object' &&
          (Object.getPrototypeOf(item) === Object.prototype ||
            Object.getPrototypeOf(item) === null);
        const isObserved = (item) => isPlain(item) && item.exit === 0 &&
          typeof item.file === 'string' && item.file.length > 0 &&
          /^[0-9a-f]{64}$/.test(item.sha256 ?? '');
        if (Array.isArray(ev)) {
          // Индексный обход: разреженные массивы без записей отклоняются.
          if (ev.length === 0) return false;
          for (let i = 0; i < ev.length; i++) {
            if (!Object.hasOwn(ev, i) || !isObserved(ev[i])) return false;
          }
          return true;
        }
        return isObserved(ev);
      })();
    if (!attested) {
      return { status: 'hold', reason: 'visual_receipt_invalid' };
    }
    visual = vis;
  }

  // Независимое ревью, квитанция на тот же SHA; не запускать после потери hold.
  if (beforeReview) {
    try { await beforeReview(); } catch (error) {
      return { status: 'lost', reason: `claim_lost_before_review:${messageOf(error)}` };
    }
  }
  await intent('review');
  let rev;
  try {
    // Рецензент получает subject_digest манифеста в запросе; квитанция обязана
    // вернуть тот же digest (проверка ниже).
    const digestForReview = typeof subjectDigest === 'function' ? subjectDigest() : null;
    rev = await ports.review({ ...binding, subject_digest: digestForReview }, profile);
    await step('review', true, rev);
  } catch (e) {
    await step('review', false, messageOf(e));
    return { status: 'hold', reason: `review_error:${messageOf(e)}` };
  }
  const actual = rev?.actual ?? {};
  if (rev?.task !== binding.task_id) return { status: 'hold', reason: `review_task_mismatch:${rev?.task}` };
  if (rev.sha !== binding.candidate_sha) return { status: 'hold', reason: `review_sha_mismatch:${rev.sha}` };
  for (const key of ['provider', 'model', 'reasoningLevel']) {
    const expected = profile.review[key];
    if (actual[key] !== expected) return { status: 'hold', reason: `review_${key}_mismatch` };
  }
  if (!/^[0-9a-f]{8,64}$/.test(rev.checkpoint ?? '')) return { status: 'hold', reason: 'review_unconfirmed' };
  // Аттестация ревью: расширенный ReviewReceipt обязан нести полный набор
  // доказательств — изоляцию docker-ro-v1, валидный sha256 транскрипта и
  // реальный файл транскрипта в журнале, чей байтовый хэш сверяется здесь.
  // Полный набор обязателен также, когда манифест закреплён и профиль включил
  // requireAttestation — подмена legacy-квитанцией не проходит.
  const hasAttestationFields = rev.isolation !== undefined ||
    rev.transcript_sha256 !== undefined || rev.transcript_file !== undefined ||
    rev.status !== undefined || rev.findings !== undefined ||
    rev.subject_digest !== undefined;
  const digestNow = typeof subjectDigest === 'function' ? subjectDigest() : null;
  // Полный набор обязателен при любом из признаков аттестации ИЛИ когда
  // профиль требует аттестацию — независимо от наличия манифеста.
  const attestationRequired = hasAttestationFields ||
    profile.review?.requireAttestation === true || isNeonReview(profile.review);
  if (attestationRequired) {
    if (rev.isolation !== 'docker-ro-v1') {
      return { status: 'hold', reason: 'review_isolation_missing' };
    }
    if (!SHA256_RE.test(rev.transcript_sha256 ?? '')) {
      return { status: 'hold', reason: 'review_transcript_missing' };
    }
    const transcriptName = rev.transcript_file;
    if (typeof transcriptName !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,200}$/.test(transcriptName) || journal === undefined) {
      return { status: 'hold', reason: 'review_transcript_missing' };
    }
    const transcriptPath = path.join(journal, transcriptName);
    let transcriptBytes;
    try {
      // Транскрипт обязан быть обычным файлом внутри журнала: симлинк или
      // уводящий за пределы realpath — подмена, не квитанция.
      const st = await lstat(transcriptPath);
      const expected = path.join(await realpath(journal), transcriptName);
      if (!st.isFile() || st.isSymbolicLink() ||
          await realpath(transcriptPath) !== expected) {
        return { status: 'hold', reason: 'review_transcript_mismatch' };
      }
      transcriptBytes = await readFile(transcriptPath);
    } catch {
      return { status: 'hold', reason: 'review_transcript_mismatch' };
    }
    if (createHash('sha256').update(transcriptBytes).digest('hex') !== rev.transcript_sha256) {
      return { status: 'hold', reason: 'review_transcript_mismatch' };
    }
    if (digestNow === null) {
      if (rev.subject_digest !== undefined && rev.subject_digest !== null &&
          !SHA256_RE.test(rev.subject_digest)) {
        return { status: 'hold', reason: 'review_subject_missing' };
      }
    } else if (rev.subject_digest !== digestNow) {
      return { status: 'hold', reason: 'review_subject_mismatch' };
    }
  }
  if (rev.verdict !== REVIEW_OK) {
    // REVIEW_BLOCKED/REWORK требует содержательного возражения: валидный finding
    // (file/expected/actual) или непустой excerpt; пустое — операционный hold.
    if (rev.verdict === REVIEW_BLOCKED &&
        !hasValidFinding(rev.findings) &&
        (typeof rev.excerpt !== 'string' || !rev.excerpt.trim())) {
      return { status: 'hold', reason: 'review_objection_missing' };
    }
    return {
      status: rev.verdict === REVIEW_BLOCKED ? 'rework' : 'hold',
      reason: `review_verdict:${rev.verdict}`,
      feedback: { reason: `review_verdict:${rev.verdict}`, verdict: rev.verdict, checkpoint: rev.checkpoint,
        threadId: rev.threadId, excerpt: rev.excerpt, findings: rev.findings,
        summary: rev.summary },
      loc, tamper, visual, review: rev, actual,
    };
  }

  return { status: 'verified', loc, review: rev, actual, tamper, visual };
}

export async function accept({ handoff, policy, journal, ports }) {
  const journalStat = await stat(journal).catch(() => null);
  if (!journalStat || !journalStat.isDirectory()) {
    throw new Denied('journal_not_directory');
  }

  // Валидация контракта до любого эффекта.
  let profile;
  try {
    validateHandoff(handoff);
    profile = validatePolicy(policy, handoff.check_profile);
    // Кросс-семейственный инвариант до любого эффекта, когда исполнитель известен.
    if (profile.executor !== undefined) {
      try {
        assertCrossFamily(profile.executor, profile.review);
      } catch (e) {
        throw new Denied(e instanceof ReviewDenied ? e.reason : 'review_same_family');
      }
    }
  } catch (e) {
    if (e instanceof Denied) {
      return { outcome: 'denied', reason: e.reason, task_id: handoff?.task_id ?? null };
    }
    throw e;
  }

  const id = journalId(runId(handoff.task_id, handoff.candidate_sha, policy.version));
  const file = path.join(journal, `${id}.jsonl`);

  // Атомарное создание запуска: блокировка параллельных/повторных запусков.
  let fh;
  try {
    fh = await open(file, 'wx', 0o600);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const entries = (await readExistingRun(file)) ?? [];
    // Журнал без записи run не подтверждает ни один исход.
    if (!entries.find((entry) => entry?.kind === 'run')) {
      return {
        outcome: 'uncertain',
        reason: 'journal_run_entry_missing',
        run: id,
        repeated: true,
        task_id: handoff.task_id,
        candidate_sha: handoff.candidate_sha,
      };
    }
    const done = terminalOutcome(entries);
    if (done !== null) {
      return { ...done, repeated: true, run: id };
    }
    // Аварийный запуск: неопределённый исход — сверка факта, не retry.
    let boardState = null;
    try {
      boardState = await ports.board.lookup(handoff.task_id);
    } catch {
      boardState = null;
    }
    return {
      outcome: 'uncertain',
      reason: 'interrupted_run',
      run: id,
      repeated: true,
      phase: entries.filter((e) => e?.kind === 'intent').map((e) => e.phase).at(-1) ?? null,
      board_state: boardState ? boardState.state : null,
      task_id: handoff.task_id,
      candidate_sha: handoff.candidate_sha,
    };
  }

  let seq = 0;
  const append = async (entry) => {
    await appendFile(file, JSON.stringify({ seq: seq++, ...entry }) + '\n', { flush: true });
  };
  await fh.close();

  await append({ kind: 'run', task_id: handoff.task_id, candidate_sha: handoff.candidate_sha, policy_version: policy.version });

  const intent = async (phase) => append({ kind: 'intent', phase });
  const step = async (phase, ok, detail) => append({ kind: 'result', phase, ok, detail });

  const finish = async (outcome, extra = {}) => {
    const record = { outcome, task_id: handoff.task_id, candidate_sha: handoff.candidate_sha, run: id, ...extra };
    await append({ kind: 'outcome', ...record });
    return record;
  };

  const block = async (reason, epoch) => {
    await intent('block');
    try {
      await ports.board.block(handoff.task_id, epoch, reason);
      await step('block', true, reason);
      return finish('blocked', { reason });
    } catch (e) {
      await step('block', false, String(e?.message ?? e));
      return finish('uncertain', { reason: `block_failed:${reason}` });
    }
  };

  // Фаза: lookup — только чтение.
  let looked;
  try {
    looked = await ports.board.lookup(handoff.task_id);
  } catch (e) {
    return finish('denied', { reason: `lookup_failed:${e?.message ?? e}` });
  }
  if (!looked || looked.state !== 'ready') {
    return finish('denied', { reason: `unexpected_state:${looked?.state ?? 'none'}` });
  }

  // Фаза: claim.
  let epoch;
  await intent('claim');
  try {
    const claimed = await ports.board.claim(handoff.task_id);
    epoch = claimed?.epoch;
    if (epoch === undefined || epoch === null) throw new Error('no_epoch');
    await step('claim', true, { epoch });
  } catch (e) {
    await step('claim', false, String(e?.message ?? e));
    return finish('denied', { reason: `claim_failed:${e?.message ?? e}` });
  }

  const verdict = await runVerification({ binding: handoff, profile, ports, intent, step,
    journal, subjectDigest: () => null });
  if (verdict.status !== 'verified') return block(verdict.reason, epoch);
  const { loc, review: rev, actual, tamper, visual } = verdict;

  await intent('seal');
  try {
    const changed = inspectionProblem(await ports.inspect(handoff), handoff.candidate_sha);
    await step('seal', !changed, changed);
    if (changed) return block(changed, epoch);
  } catch (e) {
    return block(`seal_failed:${e?.message ?? e}`, epoch);
  }

  // Фаза: завершение — единственный путь к completed.
  await intent('complete');
  try {
    await ports.board.complete(handoff.task_id, epoch, {
      sha: handoff.candidate_sha, worker: handoff.worker_thread_id,
      checks: loc.evidence, tamper: tamper ? 'pass' : 'na', visual: compactVisual(visual),
      review: { verdict: rev.verdict, checkpoint: rev.checkpoint, actual },
    });
    await step('complete', true, { epoch });
  } catch (e) {
    await step('complete', false, String(e?.message ?? e));
    // Неизвестный исход: сверка факта, не retry.
    let state = null;
    try {
      state = (await ports.board.lookup(handoff.task_id))?.state ?? null;
    } catch {
      state = null;
    }
    return finish('uncertain', { reason: `complete_failed:${e?.message ?? e}`, board_state: state });
  }

  return finish('completed', { evidence: loc.evidence, epoch });
}

// Приёмка по уже удерживаемому claim: второго claim нет, release→reclaim запрещён.
// Доверенная привязка — attempt (только контроллер), сдача — submission (воркер).
export async function acceptHeld({ attempt, submission, policy, journal, ports }) {
  const journalStat = await stat(journal).catch(() => null);
  if (!journalStat || !journalStat.isDirectory()) {
    throw new Denied('journal_not_directory');
  }

  let profile;
  // Манифест достраивается после первой инспекции: tree_sha берётся из реального снимка.
  let subject = null;
  let digest = null;
  try {
    validateAttempt(attempt);
    validateSubmission(submission, attempt);
    profile = validatePolicy(policy, attempt.check_profile, { allowNeon: true });
    validateEnrolled(attempt, profile);
    // Исполнитель из доверенной попытки (или профиля) и критик — разные семейства.
    // При настроенном арбитре проверяется вся триада: арбитр обязан быть из
    // третьего независимого семейства — как для первичного воркера, так и после
    // переключения на резерв.
    const executor = attempt.executor ?? profile.executor;
    const arbiter = attempt.arbiter ?? profile.arbiter;
    if (isNeonReview(profile.review)) {
      if (!isSolArbiter(arbiter) || executor === undefined) throw new Denied('vs2_review_triad_not_approved');
      if (attempt.policy_digest === undefined) throw new Denied('subject_contract_incomplete');
    }
    try {
      if (arbiter !== undefined) {
        assertTriadIndependent({ executor, critic: profile.review, arbiter });
      } else if (executor !== undefined) {
        assertCrossFamily(executor, profile.review);
      }
    } catch (e) {
      throw new Denied(e instanceof ReviewDenied ? e.reason : 'review_same_family');
    }
  } catch (e) {
    if (e instanceof Denied) {
      return {
        outcome: 'denied',
        reason: e.reason,
        task_id: attempt?.task_id ?? null,
        attempt_id: attempt?.attempt_id ?? null,
      };
    }
    throw e;
  }
  const key = contractKey(attempt);

  const binding = {
    task_id: attempt.task_id,
    worker_thread_id: attempt.bb_thread_id,
    worktree: attempt.worktree,
    base_sha: attempt.base_sha,
    check_profile: attempt.check_profile,
    candidate_sha: submission.candidate_sha,
    has_ui: attempt.has_ui,
    executor: attempt.executor ?? profile.executor,
  };
  // Ключ запуска включает контракт и требование L3: новый манифест или смена
  // has_ui при том же SHA не переиспользуют терминальный вердикт старого запуска.
  const id = journalId(runId(`${attempt.task_id}.${attempt.attempt_id}.${attempt.epoch}`,
    submission.candidate_sha, policy.version) + (key ? `-s${key}` : '') +
    '-h' + createHash('sha256').update(JSON.stringify([
      attempt.task_id, attempt.attempt_id, attempt.epoch, submission.candidate_sha,
      policy.version, attempt.has_ui ?? null, key ?? null,
    ])).digest('hex').slice(0, 16));
  const file = path.join(journal, `${id}.jsonl`);

  let fh;
  try {
    fh = await open(file, 'wx', 0o600);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const entries = (await readExistingRun(file)) ?? [];
    const runEntry = entries.find((entry) => entry?.kind === 'run');
    // Журнал без записи run несогласован: старый исход не подтверждается ничем.
    if (!runEntry) {
      return {
        outcome: 'uncertain',
        reason: 'journal_run_entry_missing',
        run: id,
        repeated: true,
        task_id: attempt.task_id,
        attempt_id: attempt.attempt_id,
        candidate_sha: submission.candidate_sha,
      };
    }
    if (runEntry.policy_version !== policy.version ||
        (runEntry.has_ui ?? null) !== (attempt.has_ui ?? null)) {
      return {
        outcome: 'denied',
        reason: 'journal_subject_mismatch',
        task_id: attempt.task_id,
        attempt_id: attempt.attempt_id,
        run: id,
      };
    }
    if (!sameContract(runEntry, attempt)) {
      return {
        outcome: 'denied',
        reason: 'journal_subject_mismatch',
        task_id: attempt.task_id,
        attempt_id: attempt.attempt_id,
        run: id,
      };
    }
    const done = terminalOutcome(entries);
    if (done !== null) return { ...done, repeated: true, run: id };
    let boardState = null;
    try {
      boardState = (await ports.board.lookup(attempt.task_id))?.state ?? null;
    } catch {
      boardState = null;
    }
    return {
      outcome: 'uncertain',
      reason: 'interrupted_run',
      run: id,
      repeated: true,
      phase: entries.filter((e) => e?.kind === 'intent').map((e) => e.phase).at(-1) ?? null,
      board_state: boardState,
      task_id: attempt.task_id,
      attempt_id: attempt.attempt_id,
      candidate_sha: submission.candidate_sha,
    };
  }

  let seq = 0;
  const append = async (entry) => {
    await appendFile(file, JSON.stringify({ seq: seq++, ...entry }) + '\n', { flush: true });
  };
  await fh.close();

  await append({
    kind: 'run',
    task_id: attempt.task_id,
    attempt_id: attempt.attempt_id,
    epoch: attempt.epoch,
    candidate_sha: submission.candidate_sha,
    policy_version: policy.version,
    finish: attempt.finish,
    has_ui: attempt.has_ui ?? null,
    subject_digest: null,
    // Переключение на резерв фиксируется в квитанции попытки.
    ...((attempt.fallback_reason !== undefined || attempt.attempted_workers !== undefined)
      ? { worker_trail: { fallback_reason: attempt.fallback_reason ?? null,
          attempted_workers: attempt.attempted_workers ?? [] } }
      : {}),
    ...(key ? { contract: {
      repo_id: attempt.repo_id,
      tree_sha: attempt.tree_sha ?? null,
      spec_digest: attempt.spec_digest,
      policy_digest: attempt.policy_digest,
      fixtures_digest: attempt.fixtures_digest ?? null,
      release_target: attempt.release_target ?? null,
      has_ui: attempt.has_ui ?? null,
    } } : {}),
  });

  const intent = async (phase) => append({ kind: 'intent', phase });
  const step = async (phase, ok, detail) => append({ kind: 'result', phase, ok, detail });

  // tree_sha из реальной инспекции снимка (не из слов воркера и не только из
  // манифеста): фиксируется сразу после успешного ports.inspect.
  let inspectedTreeSha = attempt.tree_sha ?? null;

  const settle = async (outcome, extra = {}) => {
    const { receipt: receiptExtra, ...rest } = extra;
    const record = {
      outcome,
      task_id: attempt.task_id,
      attempt_id: attempt.attempt_id,
      epoch: attempt.epoch,
      candidate_sha: submission.candidate_sha,
      run: id,
      subject_digest: digest,
      tree_sha: inspectedTreeSha,
      receipt: {
        tree_sha: inspectedTreeSha,
        task_id: attempt.task_id,
        attempt_id: attempt.attempt_id,
        epoch: attempt.epoch,
        candidate_sha: submission.candidate_sha,
        policy_version: policy.version,
        finish: attempt.finish,
        subject_digest: digest,
        outcome,
        ...((attempt.fallback_reason !== undefined || attempt.attempted_workers !== undefined)
          ? { worker_trail: { fallback_reason: attempt.fallback_reason ?? null,
              attempted_workers: attempt.attempted_workers ?? [] } }
          : {}),
        ...receiptExtra,
      },
      ...rest,
    };
    await append({ kind: 'outcome', ...record });
    return record;
  };

  // Видимый операционный стоп: карточка уходит в blocked с причиной.
  const hold = async (reason) => {
    await intent('block');
    try {
      await ports.board.block(attempt.task_id, attempt.epoch, reason);
      await step('block', true, reason);
    } catch (e) {
      await step('block', false, messageOf(e));
      return settle('uncertain', { reason: `block_failed:${reason}`, receipt: { reason } });
    }
    return settle('hold', { reason, receipt: { reason } });
  };

  // Манифест достраивается на первом снимке: tree_sha из инспекции (или закреплённый),
  // расхождение закреплённого дерева с фактическим — дрейф.
  const finalizeSubject = async (ins) => {
    if (subject !== null || attempt.spec_digest === undefined) return null;
    const actualTree = ins?.tree ?? ins?.tree_sha ?? null;
    if (attempt.tree_sha !== undefined && actualTree !== null && attempt.tree_sha !== actualTree) {
      return { status: 'hold', reason: 'tree_sha_drift' };
    }
    const treeSha = attempt.tree_sha ?? actualTree;
    if (!treeSha) return { status: 'hold', reason: 'subject_contract_incomplete' };
    try {
      subject = attemptSubject(attempt, submission, treeSha);
      digest = subjectDigest(subject);
    } catch (e) {
      return { status: 'hold',
        reason: e instanceof Denied ? e.reason : `subject_failed:${messageOf(e)}` };
    }
    await append({ kind: 'subject', subject_digest: digest });
    await step('subject', true, { subject_digest: digest });
    return null;
  };

  // Доказательство действующей аренды: настоящий native epoch/token, не цифра из сдачи.
  await intent('verify_claim');
  let live;
  try {
    live = await ports.board.verifyHeld(attempt.task_id, attempt.epoch);
    await step('verify_claim', true, { epoch: live.epoch, until: live.until });
  } catch (e) {
    await step('verify_claim', false, messageOf(e));
    return settle('denied', { reason: `claim_not_held:${messageOf(e)}` });
  }

  // Печать: операторские входы, контракт карточки и снимок перепроверяются после L2
  // и до complete — смена брифа, политики или спеки во время проверок останавливает
  // кандидата, а не закрывает карточку устаревшим вердиктом. Тот же полный seal
  // обязателен и для арбитрованного accept_with_notes.
  const doSeal = async () => {
    await intent('seal');
    if (typeof ports.verifyPinned === 'function') {
      try {
        await ports.verifyPinned();
        await step('seal', true, 'operator_inputs_pinned');
      } catch (e) {
        await step('seal', false, messageOf(e));
        return { fail: 'policy_digest_drift' };
      }
    }
    if (subject !== null) {
      let labels = null;
      try {
        labels = await ports.board.labels?.(attempt.task_id);
      } catch (e) {
        await step('seal', false, messageOf(e));
        return { fail: `seal_failed:${messageOf(e)}` };
      }
      if (labels === null || typeof labels !== 'object') {
        await step('seal', false, 'contract_labels_unavailable');
        return { fail: 'contract_labels_unavailable' };
      }
      // Все закреплённые поля контракта сверяются с живыми метками карточки: дрейф
      // любого из них после L2 останавливает кандидата до complete.
      const expectedLabels = {
        repo_id: attempt.repo_id,
        profile_id: attempt.check_profile,
        finish: attempt.finish,
        spec_digest: attempt.spec_digest,
        policy_digest: attempt.policy_digest,
      };
      for (const [field, expected] of Object.entries(expectedLabels)) {
        // GUARD:NoStaleCommit — seal обязан видеть живые метки равными контракту.
        if (!ports.__unsafeSkipSealCheck && labels[field] !== expected) {
          await step('seal', false, `${field}_drift`);
          return { fail: `${field}_drift` };
        }
      }
      // Обязательный UI-гейт не отключается меткой карточки: если has_ui
      // требуется (контракт или профиль), а на карточке появилось live 'false',
      // кандидат останавливается до complete.
      if ((attempt.has_ui === true || profile.has_ui === true) &&
          labels.has_ui === 'false') {
        await step('seal', false, 'has_ui_drift');
        return { fail: 'has_ui_drift' };
      }
      // fixtures_digest сверяется всегда и нормализуется как в манифесте: отсутствие
      // значения в контракте и на карточке — null, появление метки во время L2 — дрейф.
      const expectedFixtures = attempt.fixtures_digest ?? null;
      const liveFixtures = typeof labels.fixtures_digest === 'string' ? labels.fixtures_digest : null;
      if (liveFixtures !== expectedFixtures) {
        await step('seal', false, 'fixtures_digest_drift');
        return { fail: 'fixtures_digest_drift' };
      }
      if (policy.digest !== undefined && policy.digest !== attempt.policy_digest) {
        await step('seal', false, 'policy_digest_drift');
        return { fail: 'policy_digest_drift' };
      }
      await step('seal', true, 'contract_pinned');
    }
    let ins;
    try {
      ins = await ports.inspect(binding);
    } catch (e) {
      await step('seal', false, messageOf(e));
      return { fail: `seal_failed:${messageOf(e)}` };
    }
    const changed = inspectionProblem(ins, binding.candidate_sha);
    if (changed) {
      await step('seal', false, changed);
      return { fail: changed };
    }
    // tree_sha снимка не должен сдвинуться с момента инспекции манифеста.
    const sealTree = ins?.tree ?? ins?.tree_sha ?? null;
    if (subject?.source?.tree_sha && sealTree && sealTree !== subject.source.tree_sha) {
      await step('seal', false, 'tree_sha_drift');
      return { fail: 'tree_sha_drift' };
    }
    try {
      const proof = await ports.board.verifyHeld(attempt.task_id, attempt.epoch);
      await step('seal', true, { epoch: proof.epoch, until: proof.until });
      return { ok: true, live: proof };
    } catch (e) {
      await step('seal', false, `claim_lost:${messageOf(e)}`);
      return { denied: `claim_not_held:${messageOf(e)}` };
    }
  };

  const verdict = await runVerification({ binding, profile, ports, intent, step,
    beforeReview: () => ports.board.verifyHeld(attempt.task_id, attempt.epoch),
    onInspect: async (ins) => {
      if (ins !== null && typeof ins === 'object') {
        inspectedTreeSha = ins.tree_sha ?? ins.tree ?? inspectedTreeSha;
      }
    },
    onSnapshot: finalizeSubject,
    subjectDigest: () => digest,
    journal });
  if (verdict.status === 'lost') return settle('denied', { reason: verdict.reason });

  // GUARD:NoBlindRoundClose — возврат на доработку никогда не превращается в
  // complete без свежего verified-вердикта на тот же кандидат.
  if (!ports.__unsafeAutoCloseRework && verdict.status === 'rework') {
    // Исправимый дефект: та же аренда остаётся живой, никаких settle-эффектов.
    const record = await settle('rework', {
      reason: verdict.reason,
      feedback: verdict.feedback,
      receipt: { settle: 'deferred', reason: verdict.reason, until: live.until },
    });
    // Арбитрованное принятие (accept_with_notes) обязано пройти тот же полный
    // seal перед complete: контроллер вызывает sealAndComplete с квитанцией
    // арбитра — прямого board.complete в обход seal не существует.
    // Callback выдаётся только для L2-возврата ревью при готовом манифесте:
    // детерминированные гейты (local_checks/tamper/visual) и отсутствие
    // манифеста арбитражом не принимаются никогда.
    if (subject !== null && String(verdict.reason).startsWith('review_verdict:')) {
      record.sealAndComplete = async (arbitrationReceipt) => {
      // Строгая валидация квитанции арбитра ДО seal: любой пропуск —
      // hold без complete.
      const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
        (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
      let receiptOk = isPlain(arbitrationReceipt) &&
        arbitrationReceipt.decision === 'accept_with_notes' &&
        typeof arbitrationReceipt.notes === 'string' && arbitrationReceipt.notes.trim().length > 0 &&
        Number.isFinite(arbitrationReceipt.max_harm) && arbitrationReceipt.max_harm < 10 &&
        (arbitrationReceipt.dod_violation === false ||
          arbitrationReceipt.dod_violation === undefined) &&
        arbitrationReceipt.subject_digest === digest &&
        isPlain(arbitrationReceipt.arbiter) &&
        typeof arbitrationReceipt.arbiter.provider === 'string' &&
        arbitrationReceipt.arbiter.provider.trim().length > 0 &&
        typeof arbitrationReceipt.arbiter.model === 'string' &&
        arbitrationReceipt.arbiter.model.trim().length > 0;
      if (receiptOk) {
        try {
          assertTriadIndependent({
            executor: attempt.executor ?? profile.executor,
            critic: profile.review,
            arbiter: arbitrationReceipt.arbiter,
          });
        } catch {
          receiptOk = false;
        }
      }
      if (!receiptOk) return hold('invalid_arbitration_receipt');
      const sealed = await doSeal();
      if (sealed.denied) return settle('denied', { reason: sealed.denied });
      if (sealed.fail) return hold(sealed.fail);
      const sealLive = sealed.live;
      const rev = verdict.review ?? {};
      const actual = verdict.actual ?? {};
      const evidence = compactEvidence({
        sha: binding.candidate_sha,
        subject_digest: digest,
        worker: attempt.bb_thread_id,
        checks: verdict.loc?.evidence ?? [],
        tamper: verdict.tamper ? 'pass' : 'na',
        visual: verdict.visual,
        review: { verdict: rev.verdict, checkpoint: rev.checkpoint, actual },
        arbitration: arbitrationReceipt,
      }, id);
      const gateReceipts = {
        tamper: verdict.tamper ? { ok: verdict.tamper.ok === true, sha: verdict.tamper.sha,
          base_sha: verdict.tamper.base_sha, digest: verdict.tamper.digest,
          violations: verdict.tamper.violations ?? [] } : null,
        visual: !verdict.visual || verdict.visual.status === 'not_applicable'
          ? { status: 'not_applicable' } : verdict.visual,
      };
      if (attempt.finish !== 'verified') {
        return settle('verified', {
          evidence: verdict.loc?.evidence,
          receipt: { settle: 'deferred', until: sealLive.until, evidence,
            ...gateReceipts },
        });
      }
      await intent('complete');
      try {
        await ports.board.complete(attempt.task_id, attempt.epoch, evidence);
        await step('complete', true, { epoch: attempt.epoch });
      } catch (e) {
        await step('complete', false, messageOf(e));
        let state = null;
        try {
          state = (await ports.board.lookup(attempt.task_id))?.state ?? null;
        } catch {
          state = null;
        }
        return settle('uncertain', {
          reason: `complete_failed:${messageOf(e)}`,
          board_state: state,
          receipt: { settle: 'unknown', evidence, ...gateReceipts },
        });
      }
      return settle('verified', {
        evidence: verdict.loc?.evidence,
        receipt: { settle: 'completed', evidence, ...gateReceipts },
      });
      };
    }
    return record;
  }
  if (verdict.status === 'hold') {
    return hold(verdict.reason);
  }

  const { loc, review: rev, actual, tamper, visual } = verdict;

  const sealed = await doSeal();
  if (sealed.denied) return settle('denied', { reason: sealed.denied });
  if (sealed.fail) return hold(sealed.fail);
  live = sealed.live;

  const evidence = compactEvidence({
    sha: binding.candidate_sha,
    subject_digest: digest,
    worker: attempt.bb_thread_id,
    checks: loc.evidence,
    tamper: tamper ? 'pass' : 'na',
    visual,
    review: { verdict: rev.verdict, checkpoint: rev.checkpoint, actual },
  }, id);

  // Полные квитанции L1-tamper и L3 остаются в локальном журнале, привязанные к
  // (task_id, epoch, attempt_id, subject_digest) этой же записью settle.
  const gateReceipts = {
    tamper: tamper ? { ok: tamper.ok === true, sha: tamper.sha, base_sha: tamper.base_sha,
      digest: tamper.digest, violations: tamper.violations ?? [] } : null,
    visual: visual.status === 'not_applicable' ? { status: 'not_applicable' } : visual,
  };

  // finish=verified закрывает карточку; finish=deployed ждёт выкладки и smoke.
  if (attempt.finish !== 'verified') {
    return settle('verified', {
      evidence: loc.evidence,
      receipt: { settle: 'deferred', until: live.until, evidence, ...gateReceipts },
    });
  }

  await intent('complete');
  try {
    await ports.board.complete(attempt.task_id, attempt.epoch, evidence);
    await step('complete', true, { epoch: attempt.epoch });
  } catch (e) {
    await step('complete', false, messageOf(e));
    let state = null;
    try {
      state = (await ports.board.lookup(attempt.task_id))?.state ?? null;
    } catch {
      state = null;
    }
    return settle('uncertain', {
      reason: `complete_failed:${messageOf(e)}`,
      board_state: state,
      receipt: { settle: 'unknown', evidence, ...gateReceipts },
    });
  }

  return settle('verified', {
    evidence: loc.evidence,
    receipt: { settle: 'completed', evidence, ...gateReceipts },
  });
}

export const _internals = {
  runId,
  validateHandoff,
  validatePolicy,
  validateAttempt,
  validateSubmission,
  validateContract,
  attemptSubject,
  contractKey,
  sameContract,
  compactEvidence,
  runVerification,
};
