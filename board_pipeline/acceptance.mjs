// Ядро приёмки F1: submit → local_checks → review → completed | blocked.
// Все внешние эффекты — только через порты. Журнал append-only: intent ДО эффекта.

import { open, readFile, appendFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildSubject, canonicalJson, subjectDigest } from './subject.mjs';

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
];
const CONTRACT_REQUIRED = ['repo_id', 'spec_digest', 'policy_digest'];
const RELEASE_TARGET_KEYS = ['finish', 'target_id', 'release_channel', 'previous_live_digest'];

// Сдача воркера: типизированный результат, без worktree/профиля/команд/токена.
const SUBMISSION_KEYS = ['task_id', 'epoch', 'attempt_id', 'worker_thread_id', 'candidate_sha'];

const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const REVIEW_OK = 'REVIEW_OK';
const REVIEW_BLOCKED = 'REVIEW_BLOCKED';
const FINISH = new Set(['verified', 'deployed']);
const REVIEW_MODELS = new Set(['gpt-6.2-sol', 'gpt-6.2-astra']);

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
  if (!/^thr_[a-z0-9]+$/.test(handoff.worker_thread_id)) throw new Denied('invalid_worker_thread');
  if (!path.isAbsolute(handoff.worktree)) throw new Denied('worktree_not_absolute');
  if (!SHA_RE.test(handoff.candidate_sha)) throw new Denied('candidate_sha_not_full');
  if (!SHA_RE.test(handoff.base_sha)) throw new Denied('base_sha_not_full');
}

function validatePolicy(policy, checkProfile) {
  if (policy === null || typeof policy !== 'object') throw new Denied('policy_not_object');
  if (typeof policy.version !== 'string' && typeof policy.version !== 'number') {
    throw new Denied('policy_version_missing');
  }
  const profiles = policy.profiles;
  if (profiles === null || typeof profiles !== 'object') throw new Denied('profiles_missing');
  const profile = Object.hasOwn(profiles, checkProfile) ? profiles[checkProfile] : null;
  if (profile === null || typeof profile !== 'object') {
    throw new Denied(`unknown_profile:${checkProfile}`);
  }
  if (profile.review?.provider !== 'openai' || profile.review.reasoningLevel !== 'medium' ||
      !REVIEW_MODELS.has(profile.review.model)) {
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
  if (!/^thr_[a-z0-9]+$/.test(attempt.bb_thread_id)) throw new Denied('invalid_worker_thread');
  if (!path.isAbsolute(attempt.worktree)) throw new Denied('worktree_not_absolute');
  if (!SHA_RE.test(attempt.base_sha)) throw new Denied('base_sha_not_full');
  if (!FINISH.has(attempt.finish)) throw new Denied('invalid_finish');
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

// Ключ контракта для журнала: смена spec/policy/fixtures/release при том же SHA
// создаёт новый запуск вместо переиспользования старого терминального вердикта.
// (candidate_sha уже в ключе запуска, а tree_sha однозначно выводится из него в Git.)
function contractKey(attempt) {
  if (attempt.spec_digest === undefined) return null;
  return createHash('sha256').update(canonicalJson({
    repo_id: attempt.repo_id,
    base_sha: attempt.base_sha,
    spec_digest: attempt.spec_digest,
    policy_digest: attempt.policy_digest,
    fixtures_digest: attempt.fixtures_digest ?? null,
    release_target: attempt.release_target ?? null,
    finish: attempt.finish,
  })).digest('hex');
}

// Сверка контракта записи журнала с текущей попыткой: ключ совпал, а контракт нет —
// журнал не может подтвердить вердикт для этого манифеста.
function sameContract(runEntry, attempt) {
  if (attempt.spec_digest === undefined) return true;
  const recorded = runEntry?.contract;
  if (recorded === null || typeof recorded !== 'object') return false;
  return recorded.repo_id === attempt.repo_id &&
    recorded.spec_digest === attempt.spec_digest &&
    recorded.policy_digest === attempt.policy_digest &&
    (recorded.fixtures_digest ?? null) === (attempt.fixtures_digest ?? null) &&
    (JSON.stringify(recorded.release_target ?? null) ===
      JSON.stringify(attempt.release_target ?? null));
}

// Сверка сдачи с доверенной попыткой. Любое расхождение — отказ до эффекта.
function validateSubmission(submission, attempt) {
  strictKeys(submission, SUBMISSION_KEYS);
  if (!/^[1-9][0-9]{0,14}$/.test(submission.task_id)) throw new Denied('invalid_task_id');
  if (!Number.isSafeInteger(submission.epoch) || submission.epoch <= 0) throw new Denied('invalid_epoch');
  if (!ID_RE.test(submission.attempt_id)) throw new Denied('invalid_attempt_id');
  if (!/^thr_[a-z0-9]+$/.test(submission.worker_thread_id)) throw new Denied('invalid_worker_thread');
  if (!SHA_RE.test(submission.candidate_sha)) throw new Denied('candidate_sha_not_full');
  if (submission.task_id !== attempt.task_id) throw new Denied('task_mismatch');
  if (submission.epoch !== attempt.epoch) throw new Denied('epoch_mismatch');
  if (submission.attempt_id !== attempt.attempt_id) throw new Denied('attempt_mismatch');
  if (submission.worker_thread_id !== attempt.bb_thread_id) throw new Denied('worker_thread_mismatch');
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
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ kind: 'corrupt', raw: line });
    }
  }
  return entries;
}

function terminalOutcome(entries) {
  const last = [...entries].reverse().find((e) => e.kind === 'outcome');
  if (!last || entries.some((entry) => entry.kind === 'corrupt')) return null;
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

function compactEvidence(evidence, run) {
  const review = evidence.review ?? {};
  const base = {
    v: 1,
    sha: evidence.sha,
    subject_digest: evidence.subject_digest,
    worker: evidence.worker,
    checks: compactChecks(evidence.checks),
    review: {
      verdict: review.verdict,
      checkpoint: review.checkpoint,
      provider: review.actual?.provider,
      model: review.actual?.model,
    },
    run,
  };
  const variants = [
    base,
    () => ({ ...base, checks: { ...base.checks, checks: base.checks.checks.map(({ i, ok }) => ({ i, ok })) } }),
    () => ({ ...base, checks: { ok: base.checks.ok, n: base.checks.n } }),
  ];
  for (const variant of variants) {
    const text = JSON.stringify(variant);
    if (typeof text === 'string' && text.length <= 1000) return variant;
  }
  throw new Error('Compact Board receipt cannot fit the 1000 character limit');
}

// Один общий механизм Git-снимка, проверок и ревью для ручного v1 и для приёмки по аренде.
// Возвращает verified | rework (исправимый дефект) | hold (среда/неизвестный эффект).
async function runVerification({ binding, profile, ports, intent, step, beforeReview, onSnapshot }) {
  await intent('inspect');
  let ins;
  try {
    ins = await ports.inspect(binding);
    await step('inspect', true, ins);
  } catch (e) {
    await step('inspect', false, messageOf(e));
    return { status: 'hold', reason: `inspect_failed:${messageOf(e)}` };
  }
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
    };
  }
  if (loc.evidence === undefined || loc.evidence === null || loc.evidence === '') {
    return { status: 'hold', reason: 'missing_evidence' };
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
    rev = await ports.review(binding, profile);
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
  if (rev.verdict !== REVIEW_OK) {
    if (rev.verdict === REVIEW_BLOCKED && (typeof rev.excerpt !== 'string' || !rev.excerpt.trim())) {
      return { status: 'hold', reason: 'review_objection_missing' };
    }
    return {
      status: rev.verdict === REVIEW_BLOCKED ? 'rework' : 'hold',
      reason: `review_verdict:${rev.verdict}`,
      feedback: { reason: `review_verdict:${rev.verdict}`, verdict: rev.verdict, checkpoint: rev.checkpoint,
        threadId: rev.threadId, excerpt: rev.excerpt },
    };
  }

  return { status: 'verified', loc, review: rev, actual };
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
  } catch (e) {
    if (e instanceof Denied) {
      return { outcome: 'denied', reason: e.reason, task_id: handoff?.task_id ?? null };
    }
    throw e;
  }

  const id = runId(handoff.task_id, handoff.candidate_sha, policy.version);
  const file = path.join(journal, `${id}.jsonl`);

  // Атомарное создание запуска: блокировка параллельных/повторных запусков.
  let fh;
  try {
    fh = await open(file, 'wx', 0o600);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const entries = (await readExistingRun(file)) ?? [];
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
      phase: entries.filter((e) => e.kind === 'intent').map((e) => e.phase).at(-1) ?? null,
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

  const verdict = await runVerification({ binding: handoff, profile, ports, intent, step });
  if (verdict.status !== 'verified') return block(verdict.reason, epoch);
  const { loc, review: rev, actual } = verdict;

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
      checks: loc.evidence, review: { verdict: rev.verdict, checkpoint: rev.checkpoint, actual },
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
    profile = validatePolicy(policy, attempt.check_profile);
    validateEnrolled(attempt, profile);
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
  };
  // Ключ запуска включает контракт: новый манифест при том же SHA не переиспользует
  // терминальный вердикт старого.
  const id = runId(`${attempt.task_id}.${attempt.attempt_id}.${attempt.epoch}`,
    submission.candidate_sha, policy.version) + (key ? `-s${key}` : '');
  const file = path.join(journal, `${id}.jsonl`);

  let fh;
  try {
    fh = await open(file, 'wx', 0o600);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const entries = (await readExistingRun(file)) ?? [];
    const runEntry = entries.find((entry) => entry.kind === 'run');
    if (runEntry && !sameContract(runEntry, attempt)) {
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
      phase: entries.filter((e) => e.kind === 'intent').map((e) => e.phase).at(-1) ?? null,
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
    subject_digest: null,
    ...(key ? { contract: {
      repo_id: attempt.repo_id,
      spec_digest: attempt.spec_digest,
      policy_digest: attempt.policy_digest,
      fixtures_digest: attempt.fixtures_digest ?? null,
      release_target: attempt.release_target ?? null,
    } } : {}),
  });

  const intent = async (phase) => append({ kind: 'intent', phase });
  const step = async (phase, ok, detail) => append({ kind: 'result', phase, ok, detail });

  const settle = async (outcome, extra = {}) => {
    const { receipt: receiptExtra, ...rest } = extra;
    const record = {
      outcome,
      task_id: attempt.task_id,
      attempt_id: attempt.attempt_id,
      epoch: attempt.epoch,
      candidate_sha: submission.candidate_sha,
      run: id,
      receipt: {
        task_id: attempt.task_id,
        attempt_id: attempt.attempt_id,
        epoch: attempt.epoch,
        candidate_sha: submission.candidate_sha,
        policy_version: policy.version,
        finish: attempt.finish,
        subject_digest: digest,
        outcome,
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
    if (attempt.tree_sha !== undefined && ins.tree !== undefined && attempt.tree_sha !== ins.tree) {
      return { status: 'hold', reason: 'tree_sha_drift' };
    }
    const treeSha = attempt.tree_sha ?? ins.tree;
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

  const verdict = await runVerification({ binding, profile, ports, intent, step,
    beforeReview: () => ports.board.verifyHeld(attempt.task_id, attempt.epoch),
    onSnapshot: finalizeSubject });
  if (verdict.status === 'lost') return settle('denied', { reason: verdict.reason });

  if (verdict.status === 'rework') {
    // Исправимый дефект: та же аренда остаётся живой, никаких settle-эффектов.
    return settle('rework', {
      reason: verdict.reason,
      feedback: verdict.feedback,
      receipt: { settle: 'deferred', reason: verdict.reason, until: live.until },
    });
  }
  if (verdict.status === 'hold') {
    return hold(verdict.reason);
  }

  const { loc, review: rev, actual } = verdict;

  // Печать: операторские входы, контракт карточки и снимок перепроверяются после L2
  // и до complete — смена брифа, политики или спеки во время проверок останавливает
  // кандидата, а не закрывает карточку устаревшим вердиктом.
  await intent('seal');
  if (typeof ports.verifyPinned === 'function') {
    try {
      await ports.verifyPinned();
      await step('seal', true, 'operator_inputs_pinned');
    } catch (e) {
      await step('seal', false, messageOf(e));
      return hold('policy_digest_drift');
    }
  }
  if (subject !== null) {
    let labels = null;
    try {
      labels = await ports.board.labels?.(attempt.task_id);
    } catch (e) {
      await step('seal', false, messageOf(e));
      return hold(`seal_failed:${messageOf(e)}`);
    }
    if (labels === null || typeof labels !== 'object') {
      await step('seal', false, 'contract_labels_unavailable');
      return hold('contract_labels_unavailable');
    }
    if (labels.spec_digest !== attempt.spec_digest) {
      await step('seal', false, 'spec_digest_drift');
      return hold('spec_digest_drift');
    }
    if (labels.policy_digest !== attempt.policy_digest) {
      await step('seal', false, 'policy_digest_drift');
      return hold('policy_digest_drift');
    }
    if (policy.digest !== undefined && policy.digest !== attempt.policy_digest) {
      await step('seal', false, 'policy_digest_drift');
      return hold('policy_digest_drift');
    }
    await step('seal', true, 'contract_pinned');
  }
  let changed;
  try {
    changed = inspectionProblem(await ports.inspect(binding), binding.candidate_sha);
  } catch (e) {
    await step('seal', false, messageOf(e));
    return hold(`seal_failed:${messageOf(e)}`);
  }
  if (changed) {
    await step('seal', false, changed);
    return hold(changed);
  }
  try {
    live = await ports.board.verifyHeld(attempt.task_id, attempt.epoch);
    await step('seal', true, { epoch: live.epoch, until: live.until });
  } catch (e) {
    await step('seal', false, `claim_lost:${messageOf(e)}`);
    return settle('denied', { reason: `claim_not_held:${messageOf(e)}` });
  }

  const evidence = compactEvidence({
    sha: binding.candidate_sha,
    subject_digest: digest,
    worker: attempt.bb_thread_id,
    checks: loc.evidence,
    review: { verdict: rev.verdict, checkpoint: rev.checkpoint, actual },
  }, id);

  // finish=verified закрывает карточку; finish=deployed ждёт выкладки и smoke.
  if (attempt.finish !== 'verified') {
    return settle('verified', {
      evidence: loc.evidence,
      receipt: { settle: 'deferred', until: live.until, evidence },
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
      receipt: { settle: 'unknown', evidence },
    });
  }

  return settle('verified', {
    evidence: loc.evidence,
    receipt: { settle: 'completed', evidence },
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
