export const NEON_ISOLATION = 'docker-ro-pack+host-agy-rotools-v2';
export const NEON_CRITIC = Object.freeze({ provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'medium' });
export const SOL_ARBITER = Object.freeze({ provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' });

// Дефолтная пара без зачисленного keyring: исторический Pi/Sol-критик и
// Neon-арбитр через pi-egress (host-agy/keyring не нужен — арбитр идёт
// изолированным pi-раннером на egress generativelanguage.googleapis.com).
export const PI_SOL_CRITIC = Object.freeze({ provider: 'openai', model: 'gpt-6.2-sol', reasoningLevel: 'medium' });
export const NEON_PI_ARBITER = Object.freeze({ provider: 'google', model: 'gemini-4-neon', reasoningLevel: 'high' });

// Зачисление host-agy credential: непустой DF_AGY_KEYRING_ITEM (desktop) или
// DF_AGY_OAUTH_TOKEN_FILE (headless cloud). Строгая форма пути, права и
// мост проверяются самим транспортом — здесь только факт enrolment.
export function agyKeyringEnrolled(env = process.env) {
  const hasKeyring = typeof env?.DF_AGY_KEYRING_ITEM === 'string' && env.DF_AGY_KEYRING_ITEM.trim() !== '';
  const hasTokenFile = typeof env?.DF_AGY_OAUTH_TOKEN_FILE === 'string' && env.DF_AGY_OAUTH_TOKEN_FILE.trim() !== '';
  return hasKeyring || hasTokenFile;
}

// Дефолтные роли L2 (Board #1666 DF-OPS-1.5): Neon medium primary +
// Pi/Sol-арбитр — только при зачисленном keyring; без него дефолт
// остаётся Pi/Sol L2 с Neon-арбитром через pi. Явно выбранный Neon сюда
// не попадает: его fail-closed — agy_keyring_item_not_enrolled.
export function defaultReviewRoles(env = process.env) {
  return agyKeyringEnrolled(env)
    ? { critic: NEON_CRITIC, arbiter: SOL_ARBITER }
    : { critic: PI_SOL_CRITIC, arbiter: NEON_PI_ARBITER };
}

const SKILLS = new Set(['logika', 'humanizer']);
const LEGACY_PI_MODELS = new Set(['gpt-6.2-sol', 'gpt-6.2-astra']);

export function isLegacyPiReview(review) {
  return review?.provider === 'openai' && review.reasoningLevel === 'medium' && LEGACY_PI_MODELS.has(review.model);
}

export function isNeonReview(review) {
  return Object.entries(NEON_CRITIC).every(([key, value]) => review?.[key] === value);
}

export function isSolArbiter(arbiter) {
  return arbiter?.provider === SOL_ARBITER.provider && arbiter.model === SOL_ARBITER.model &&
    ['medium', 'high'].includes(arbiter.reasoningLevel);
}

export function isReviewSkillList(skills) {
  return Array.isArray(skills) && skills.length > 0 && new Set(skills).size === skills.length &&
    skills.every(skill => SKILLS.has(skill));
}

// ============================================================================
// V2-2: Severity Gating, Diff-Scoped Round 2+, Stalled-State Early Arbiter,
// Policy-Driven Auto-Approve (Board #1745).
// ============================================================================

import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

const SEVERITIES = new Set(['P0', 'P1', 'P2', 'nit']);
const BLOCKING_SEVERITIES = new Set(['P0', 'P1']);
const SHA_HEX = /^[a-f0-9]{64}$/;

// Неизвестная или отсутствующая severity — fail-closed 'P1' (блокирует):
// legacy-находки без severity продолжают останавливать конвейер.
export function normalizeSeverity(value) {
  return SEVERITIES.has(value) ? value : 'P1';
}

export function partitionFindingsBySeverity(findings) {
  const blocking = [];
  const nonBlocking = [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    (BLOCKING_SEVERITIES.has(normalizeSeverity(finding?.severity)) ? blocking : nonBlocking).push(finding);
  }
  return { blocking, nonBlocking };
}

// P2/nit никогда не блокируют: выносятся в приватный append-only sidecar-лог
// журнала (0600) и не имеют права выдать REVIEW_BLOCKED. REWORK и ESCALATE
// только по P2/nit программно переводятся в PASS; при наличии P0/P1 исход
// сохраняется, а non-blocking находки уходят в sidecar_findings.
export async function applySeverityGating(verdict, { journal, taskId, candidateSha, round } = {}) {
  if (verdict === null || typeof verdict !== 'object') throw new Error('severity_gating_verdict_invalid');
  const { blocking, nonBlocking } = partitionFindingsBySeverity(verdict.findings);
  if (nonBlocking.length && typeof journal === 'string' && journal) {
    const file = join(journal, `review-sidecar-${taskId}-${candidateSha}.jsonl`);
    const line = JSON.stringify({ task_id: taskId, candidate_sha: candidateSha,
      round: round ?? null, findings: nonBlocking });
    await appendFile(file, `${line}\n`, { mode: 0o600 });
  }
  const base = { ...verdict };
  if (nonBlocking.length) base.sidecar_findings = nonBlocking;
  // Блокирующая находка не отменяется верхнеуровневым PASS: противоречивый
  // вердикт программно переводится в REWORK до приёмки — REVIEW_OK с P0/P1
  // (или неразмеченной) находкой никогда не доходит до settle.
  if (verdict.status === 'PASS' && blocking.length) {
    const excerpt = blocking.map(f =>
      `${f.file ?? '?'}${f.line != null ? `:${f.line}` : ''}: expected ${f.expected ?? '?'}, ` +
      `actual ${f.actual ?? '?'}`).join('\n').slice(0, 1400) || 'blocking finding under PASS verdict';
    return { ...base, status: 'REWORK', verdict: 'REVIEW_BLOCKED', findings: blocking,
      severity_gated: true, excerpt };
  }
  if ((verdict.status === 'REWORK' || verdict.status === 'ESCALATE') &&
      Array.isArray(verdict.findings) &&
      verdict.findings.length > 0 && blocking.length === 0) {
    return { ...base, status: 'PASS', verdict: 'REVIEW_OK', findings: [],
      sidecar_findings: nonBlocking, severity_gated: true, excerpt: undefined };
  }
  if (verdict.status === 'REWORK' && nonBlocking.length) {
    return { ...base, findings: blocking, severity_gated: true };
  }
  return base;
}

export const SEVERITY_RUBRIC = [
  'Grade every finding with "severity": "P0" (data loss, gate bypass, forged evidence),',
  '"P1" (spec contract violation, broken test, bug inside this card\'s scope),',
  '"P2" (real defect outside this card\'s scope — recorded, never blocking) or',
  '"nit" (style/taste — recorded, never blocking). A finding without "severity"',
  'is treated as P1. Only P0/P1 findings may justify REVIEW_BLOCKED.',
].join('\n');

// Промпт критика. Round 1 — полный аудит кандидата с явной рубрикой severity.
// Round 2+ — узкий diff-scoped пересмотр: проверяется только закрытие P0/P1
// находок прошлого раунда и отсутствие новых P0/P1 регрессий в текущем diff;
// полный аудит и блокировка по P2/nit запрещены.
export function buildReviewInstruction({ binding, diffLine, subjectLine, prompt,
  round = 1, priorBlockingFindings = [] } = {}) {
  if (!Number.isSafeInteger(round) || round <= 1) {
    return [
      `Independent, read-only review for Board #${binding.task_id} at ${binding.candidate_sha}.`,
      `The candidate tree is mounted read-only at /candidate, ${diffLine}.`,
      'Review against the spec below. You have read-only tools only;',
      'do not attempt to write.',
      'Finish with exactly one verdict: a JSON code block {"verdict":"PASS"|"REWORK"|"ESCALATE",',
      '"summary":"...","findings":[{"file","line","input","expected","actual","freq","harm","severity"}],',
      '"checked_invariants":["..."]}, or a final line REVIEW_OK or REVIEW_BLOCKED.',
      'A REWORK verdict is rejected unless "findings" contains at least one object',
      'with non-empty "file", "expected" and "actual" (or an explicit "excerpt" string).',
      'Return REVIEW_BLOCKED only for real bugs, broken contracts or tests, or a violation',
      'of an explicit invariant inside this card\'s scope. Do not demand new hardening,',
      'refactors or features outside the spec scope.',
      SEVERITY_RUBRIC,
      subjectLine,
      '',
      prompt,
    ].join('\n');
  }
  const prior = priorBlockingFindings.length
    ? priorBlockingFindings.map((finding, i) =>
        `${i + 1}. ${finding.file ?? '?'}${finding.line != null ? `:${finding.line}` : ''}` +
        ` — expected: ${finding.expected ?? '?'}; actual: ${finding.actual ?? '?'}` +
        ` [${normalizeSeverity(finding.severity)}]`).join('\n')
    : '(none supplied)';
  return [
    `Diff-scoped re-review round ${round} for Board #${binding.task_id} at ${binding.candidate_sha}.`,
    `The candidate tree is mounted read-only at /candidate, ${diffLine}.`,
    'Scope of this round is strictly limited. Verify ONLY:',
    '(a) that each blocking (P0/P1) finding from the previous round is resolved',
    'in the current diff, and (b) that the current diff introduces no NEW P0/P1',
    'regressions. Do NOT re-audit files from scratch, do NOT raise P2/nit, and',
    'never issue REVIEW_BLOCKED for P2/nit alone.',
    'Blocking findings from the previous round:',
    prior,
    SEVERITY_RUBRIC,
    'Finish with exactly one verdict: a JSON code block {"verdict":"PASS"|"REWORK"|"ESCALATE",',
    '"summary":"...","findings":[{"file","line","input","expected","actual","freq","harm","severity"}],',
    '"checked_invariants":["..."]}, or a final line REVIEW_OK or REVIEW_BLOCKED.',
    'A REWORK verdict is rejected unless "findings" contains at least one object',
    'with non-empty "file", "expected" and "actual" (or an explicit "excerpt" string).',
    subjectLine,
    '',
    prompt,
  ].join('\n');
}

// Детерминированная SHA-256 сигнатура блокирующих находок раунда:
// канонические ключи [file, line ?? null, expected, actual, severity]
// отсортированы; P2/nit в сигнатуру не входят.
export function findingSignatureSha(findings) {
  const keys = (Array.isArray(findings) ? findings : [])
    .filter(f => f !== null && typeof f === 'object' && !Array.isArray(f) &&
      BLOCKING_SEVERITIES.has(normalizeSeverity(f.severity)))
    .map(f => [f.file ?? null, f.line ?? null, f.expected ?? null, f.actual ?? null,
      normalizeSeverity(f.severity)])
    .map(entry => JSON.stringify(entry))
    .sort();
  return createHash('sha256').update(`[${keys.join(',')}]`).digest('hex');
}

// Ранний арбитр по стагнации: на L2-раундах 2..maxRounds-1 повтор SHA-
// сигнатуры блокирующих находок любого предыдущего L2-раунда (не обязательно
// подряд) — прогресс отсутствует, арбитр вызывается до исчерпания лимита.
export function detectStalledReview({ roundsHistory = [], maxRounds = 4 } = {}) {
  const l2Rounds = (Array.isArray(roundsHistory) ? roundsHistory : []).filter(r => r?.gate === 'l2');
  const latest = l2Rounds.at(-1);
  if (!latest) return { stalled: false, trigger: null, round: 0, signatureSha: null };
  const signatureSha = findingSignatureSha(latest.findings);
  const hasBlocking = Array.isArray(latest.findings) && latest.findings.some(
    f => f !== null && typeof f === 'object' && BLOCKING_SEVERITIES.has(normalizeSeverity(f.severity)));
  if (hasBlocking && l2Rounds.length >= 2 && l2Rounds.length < maxRounds) {
    const prior = l2Rounds.slice(0, -1);
    const repeated = prior.some(round =>
      findingSignatureSha(round.findings) === signatureSha ||
      (typeof round.signature === 'string' && round.signature &&
        round.signature === latest.signature));
    if (repeated) {
      return { stalled: true, trigger: 'no_progress', kind: 'stalled_findings_signature',
        round: l2Rounds.length, signatureSha };
    }
  }
  return { stalled: false, trigger: null, round: l2Rounds.length, signatureSha };
}

// Строгий загрузчик .darkfactory/approval-policy.yaml: файл — не симлинк,
// без YAML-алиасов, requireGreenL1 и requireCleanTamper обязаны быть true —
// отключить L1 или Tamper Gate политикой нельзя (fail-closed).
const POLICY_ID = /^[a-z][a-z0-9-]{0,47}$/;
const policyRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const policyList = (v, check, required = true) => Array.isArray(v) && v.length <= 64 &&
  (v.length > 0 || !required) && new Set(v).size === v.length && v.every(check);

// Парсинг уже полученных доверенных байтов политики: тот же строгий контракт,
// что у файлового загрузчика, — без доступа к ФС. Источник байтов (закреплённый
// base_sha, доверенный checkout) выбирает вызывающий.
export function parseApprovalPolicy(bytes) {
  let manifest;
  try {
    const yaml = parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      { schema: 'core', uniqueKeys: true, merge: false });
    if (yaml.errors.length || yaml.warnings.length) throw new Error('invalid YAML');
    manifest = yaml.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw new Error('approval_policy_invalid', { cause });
  }
  const auto = manifest?.autoApprove;
  if (!policyRecord(manifest) || Object.keys(manifest).length !== 2 ||
      manifest.version !== 1 || !policyRecord(auto) ||
      Object.keys(auto).length !== 8 ||
      typeof auto.enabled !== 'boolean' ||
      !policyList(auto.allowedCategories, c => POLICY_ID.test(c)) ||
      !Number.isSafeInteger(auto.maxChangedFiles) || auto.maxChangedFiles < 1 ||
      !Number.isSafeInteger(auto.maxChangedLines) || auto.maxChangedLines < 1 ||
      auto.requireGreenL1 !== true || auto.requireCleanTamper !== true ||
      !policyList(auto.allowPathPatterns, p => typeof p === 'string' && p && !p.includes('..')) ||
      !policyList(auto.denyPathPatterns, p => typeof p === 'string' && p && !p.includes('..'), false)) {
    throw new Error('approval_policy_invalid');
  }
  const policy = Object.freeze({ version: 1, autoApprove: Object.freeze({
    enabled: auto.enabled,
    allowedCategories: Object.freeze([...auto.allowedCategories]),
    maxChangedFiles: auto.maxChangedFiles,
    maxChangedLines: auto.maxChangedLines,
    requireGreenL1: true,
    requireCleanTamper: true,
    allowPathPatterns: Object.freeze([...auto.allowPathPatterns]),
    denyPathPatterns: Object.freeze([...auto.denyPathPatterns]),
  }) });
  return Object.freeze({ policy, digest: createHash('sha256').update(bytes).digest('hex') });
}

export async function loadApprovalPolicy(trustedCheckout) {
  const dir = await realpath(trustedCheckout);
  const path = join(dir, '.darkfactory', 'approval-policy.yaml');
  const info = await lstat(path);
  if (!info.isFile() || info.size > 64 * 1024 || await realpath(path) !== path) {
    throw new Error('approval_policy_invalid');
  }
  return parseApprovalPolicy(await readFile(path));
}

// Мини-матчер path-паттернов: '**/' — ноль и более каталогов, '**' — любые
// символы, '*' — в пределах сегмента, '?' — один символ сегмента.
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const followedBySlash = pattern[i + 2] === '/';
        out += followedBySlash ? '(?:.*/)?' : '.*';
        i += followedBySlash ? 2 : 1;
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function evaluateAutoApprove({ policy, digest, category, changedFiles,
  changedLines = 0, l1Passed, tamperPassed } = {}) {
  if (l1Passed !== true) return { approved: false, reason: 'auto_approve_requires_green_l1' };
  if (tamperPassed !== true) return { approved: false, reason: 'auto_approve_requires_clean_tamper' };
  const auto = policy?.autoApprove;
  if (!auto?.enabled) return { approved: false, reason: 'auto_approve_disabled' };
  if (!Array.isArray(auto.allowedCategories) || !auto.allowedCategories.includes(category)) {
    return { approved: false, reason: 'auto_approve_category_denied' };
  }
  if (!Array.isArray(changedFiles) || changedFiles.length === 0 ||
      changedFiles.length > auto.maxChangedFiles) {
    return { approved: false, reason: 'auto_approve_file_limit_exceeded' };
  }
  if (!Number.isSafeInteger(changedLines) || changedLines < 0 || changedLines > auto.maxChangedLines) {
    return { approved: false, reason: 'auto_approve_line_limit_exceeded' };
  }
  const allow = auto.allowPathPatterns.map(globToRegExp);
  const deny = (auto.denyPathPatterns ?? []).map(globToRegExp);
  for (const file of changedFiles) {
    if (typeof file !== 'string' || !file || file.includes('..') || file.startsWith('/') ||
        /^[a-zA-Z]:[\\/]/.test(file) || deny.some(re => re.test(file)) ||
        !allow.some(re => re.test(file))) {
      return { approved: false, reason: 'auto_approve_path_outside_allowlist', file };
    }
  }
  return { approved: true, reason: 'policy_auto_approved',
    policyDigest: SHA_HEX.test(digest ?? '') ? digest : null };
}
