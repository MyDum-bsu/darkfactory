// Project Memory (Board #1265): автономная компактная память проекта в стиле
// iva/osinara/mia в доверенном операторском каталоге вне worktree воркера.
// Путь приходит только извне (policy.projectMemory или DF_PROJECT_MEMORY_DIR);
// в модуле нет зашитых путей. Воркер, критик и арбитр читают строго read-only
// закреплённый срез; запись разрешена только через доверенный пост-шаг с
// подтверждённым REVIEW_OK + verified_sha + независимой парой семейств.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readlink, realpath, rename, rm,
  stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertCrossFamily, executorFamily } from './review-runner.mjs';
import { weakensSecurityGate } from './rework-distiller.mjs';
import { canonicalJson } from './subject.mjs';

export const PROJECT_MEMORY_DIR_ENV = 'DF_PROJECT_MEMORY_DIR';
export const PROJECT_MEMORY_SCHEMA = 'darkfactory.project-memory.v1';
export const REVIEW_RECEIPT_SCHEMA = 'darkfactory.review-receipt.v1';
export const PROJECT_MEMORY_SECTIONS = Object.freeze([
  'invariants',
  'pitfalls',
  'dead_ends',
  'conventions',
]);
export const TRUSTED_WRITE_ROLES = Object.freeze([
  'post_review_steward',
  'operator',
  'controller',
]);
export const DEFAULT_MAX_CHARS = 4000;
export const DEFAULT_MAX_ENTRIES_PER_SECTION = 25;

const MAX_RECEIPT_BYTES = 256 * 1024;
const MIN_HMAC_KEY_BYTES = 16;

const SECTION_SET = new Set(PROJECT_MEMORY_SECTIONS);
const TRUSTED_ROLE_SET = new Set(TRUSTED_WRITE_ROLES);
const CANONICAL_FAMILY_SPEC = new Map([
  ['cognition', 'acp-devin/swe-2-high'],
  ['glm', 'acp-zcode-start/glm-5.3-flash'],
  ['deepseek', 'opencode-go/deepseek-v4'],
  ['openai', 'openai/gpt-6.2-sol'],
  ['google', 'google/gemini-4-neon'],
  ['anthropic', 'agy/claude-opus-5.5'],
]);
const ID = /^[a-z0-9-]{1,64}$/;
const PROJECT = /^[a-z0-9_-]{1,64}$/;
const CARD = /^[0-9]{1,15}$/;
const GIT_SHA = /^([a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_ENTRY_CHARS = 500;
const MAX_MEMORY_BYTES = 4 * 1024 * 1024;
const MAX_SYMLINK_HOPS = 40;
const SUBSUMPTION_MIN_CHARS = 20;
// Жёсткий LRU-cap закреплённых срезов в кэше pinProjectMemory.
const PIN_CACHE_CAP = 64;

const inside = (root, p) => {
  const rel = relative(root, p);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

const emptySections = () => Object.fromEntries(PROJECT_MEMORY_SECTIONS.map(s => [s, []]));

const normalizeText = text => text.trim().replace(/\s+/g, ' ').toLowerCase();
const sanitizeSnippet = (text, maxLen = 240) => {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
};

// Санация любого текста, идущего в память: весь whitespace (включая переводы
// строк) схлопывается в один пробел — многострочная инъекция поддельных
// заголовков вида '\n[invariants]\n- forged' невозможна по построению.
const sanitizeMemoryText = (text, maxLen = 240) => sanitizeSnippet(text, maxLen);

// Fail-closed фильтр самоослабления: текст критика/ревью, предлагающий
// отключить или обойти тесты, гейты, ревью, изоляцию или scope-fence, никогда
// не становится памятью проекта — ни через явный memoryUpdates, ни через
// автоматическую экстракцию.
const gateWeakening = text => typeof text === 'string' && weakensSecurityGate(text);

// Явный memoryUpdates — тот же недоверенный текст критика: каждая запись
// санитизируется (схлопывание whitespace) и фильтруется через
// weakensSecurityGate. Ослабляющие и пустые после санации записи удаляются;
// неструктурные записи (не объект/не строковый text) проходят без изменений —
// их отклоняет fail-closed валидация записи.
function sanitizeExplicitUpdates(explicit) {
  const cleaned = [];
  for (const u of explicit) {
    if (u === null || typeof u !== 'object' || Array.isArray(u) || typeof u.text !== 'string') {
      cleaned.push(u);
      continue;
    }
    const text = sanitizeMemoryText(u.text, MAX_ENTRY_CHARS);
    if (!text || gateWeakening(u.text) || gateWeakening(text)) continue;
    cleaned.push({ ...u, text });
  }
  return cleaned;
}

// Автоматическое извлечение компактных записей памяти из реального результата
// acceptHeld / квитанции ревью, когда явный список memoryUpdates не передан.
// Инварианты берутся из конкретных checked_invariants критика (эфемерный
// summary — только обратносовместимый fallback), pitfalls — из блокирующих
// находок roundsHistory / prior findings, когда они переданы.
export function extractPostReviewMemoryUpdates({
  outcome,
  result,
  attempt,
  reviewReceipt,
  verifiedSha,
  roundsHistory,
}) {
  const res = result ?? outcome;
  const explicit = res?.memoryUpdates ?? reviewReceipt?.memoryUpdates;
  if (Array.isArray(explicit) && explicit.length > 0) return sanitizeExplicitUpdates(explicit);

  const updates = [];
  const seen = new Set();
  const push = (section, text) => {
    if (!text || seen.has(`${section}${text}`)) return;
    // Любой кандидат, ослабляющий тесты/гейты/ревью/scope-fence, отклоняется —
    // независимо от секции и источника текста.
    if (gateWeakening(text)) return;
    seen.add(`${section}${text}`);
    updates.push({ section, text });
  };

  const checkedRaw = Array.isArray(reviewReceipt?.checked_invariants)
    ? reviewReceipt.checked_invariants
    : (Array.isArray(res?.review?.checked_invariants) ? res.review.checked_invariants : []);
  for (const rawInvariant of checkedRaw.slice(0, 5)) {
    const text = sanitizeSnippet(
      typeof rawInvariant === 'string' ? rawInvariant : (rawInvariant?.text ?? rawInvariant?.invariant),
    );
    if (text) push('invariants', text);
  }
  if (!updates.some(u => u.section === 'invariants')) {
    const summary = sanitizeSnippet(
      reviewReceipt?.summary ?? res?.review?.summary ?? res?.summary,
    );
    if (summary) {
      push('invariants', summary);
    }
  }

  const rounds = Array.isArray(roundsHistory) ? roundsHistory
    : (Array.isArray(res?.roundsHistory) ? res.roundsHistory
      : (Array.isArray(reviewReceipt?.roundsHistory) ? reviewReceipt.roundsHistory : []));
  let pitfallCount = 0;
  for (const round of rounds) {
    if (pitfallCount >= 3) break;
    for (const finding of Array.isArray(round?.findings) ? round.findings : []) {
      if (pitfallCount >= 3) break;
      if (finding === null || typeof finding !== 'object') continue;
      // Только блокирующие находки — P2/nit не становятся уроком проекта.
      if (['P2', 'nit'].includes(finding.severity)) continue;
      const file = sanitizeSnippet(finding.file, 80);
      const expected = sanitizeSnippet(finding.expected, 100);
      const actual = sanitizeSnippet(finding.actual, 100);
      const parts = [
        file || null,
        expected ? `expected ${expected}` : null,
        actual ? `actual ${actual}` : null,
      ].filter(p => p !== null);
      if (parts.length === 0) continue;
      const text = sanitizeSnippet(parts.join(' — '), 240);
      if (text) {
        push('pitfalls', text);
        pitfallCount += 1;
      }
    }
  }

  const notes = reviewReceipt?.notes ?? res?.review?.notes;
  if (Array.isArray(notes)) {
    for (const rawNote of notes.slice(0, 3)) {
      const note = sanitizeSnippet(typeof rawNote === 'string' ? rawNote : rawNote?.text);
      if (note) push('conventions', note);
    }
  }
  if (updates.length === 0) {
    const card = String(attempt?.task_id ?? res?.task_id ?? '').trim();
    const sha = typeof verifiedSha === 'string' ? verifiedSha : (res?.sha ?? reviewReceipt?.sha ?? '');
    if (CARD.test(card) && GIT_SHA.test(sha)) {
      updates.push({
        section: 'invariants',
        text: `Verified task #${card} (${sha.slice(0, 12)})`,
      });
    }
  }
  return updates;
}

export function entryDigest(entry) {
  const { sha256, ...body } = entry;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function storeIntegrity(doc) {
  return createHash('sha256').update(canonicalJson({
    schema: doc.schema,
    project_id: doc.project_id,
    updated_at: doc.updated_at,
    sections: doc.sections,
  })).digest('hex');
}

function validateEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
      !ID.test(entry.id ?? '') ||
      typeof entry.text !== 'string' || !entry.text.trim() || entry.text.trim().length > MAX_ENTRY_CHARS ||
      !CARD.test(String(entry.source_card ?? '')) ||
      typeof entry.verified_sha !== 'string' || !GIT_SHA.test(entry.verified_sha) ||
      typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp)) ||
      !DIGEST.test(entry.sha256 ?? '')) {
    throw new Error('project_memory_entry_invalid');
  }
  if (entryDigest(entry) !== entry.sha256) throw new Error('project_memory_tampered');
}

function validateStoreDoc(doc, expectedProjectId) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) ||
      doc.schema !== PROJECT_MEMORY_SCHEMA ||
      typeof doc.project_id !== 'string' || !PROJECT.test(doc.project_id)) {
    throw new Error('project_memory_corrupt');
  }
  if (doc.project_id !== expectedProjectId) {
    throw new Error('project_memory_project_mismatch');
  }
  if (doc.updated_at !== null &&
      (typeof doc.updated_at !== 'string' || !Number.isFinite(Date.parse(doc.updated_at)))) {
    throw new Error('project_memory_corrupt');
  }
  if (doc.sections === null || typeof doc.sections !== 'object' || Array.isArray(doc.sections)) {
    throw new Error('project_memory_corrupt');
  }
  const keys = Object.keys(doc.sections);
  if (keys.length !== PROJECT_MEMORY_SECTIONS.length || keys.some(k => !SECTION_SET.has(k))) {
    throw new Error('project_memory_corrupt');
  }
  for (const section of PROJECT_MEMORY_SECTIONS) {
    if (!Array.isArray(doc.sections[section])) throw new Error('project_memory_corrupt');
  }
  if (!DIGEST.test(doc.pin_sha256 ?? '') || storeIntegrity(doc) !== doc.pin_sha256) {
    throw new Error('project_memory_tampered');
  }
  const seenIds = new Set();
  for (const section of PROJECT_MEMORY_SECTIONS) {
    for (const entry of doc.sections[section]) {
      validateEntry(entry);
      if (seenIds.has(entry.id)) throw new Error('project_memory_duplicate_id');
      seenIds.add(entry.id);
    }
  }
}

async function resolveExisting(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Полный резолв цели пути с обходом ещё не существующего хвоста и dangling
// symlink (аналогично decision-ledger.mjs): ссылка на несуществующий файл или
// каталог внутри worktree не может обойти границу доверия.
async function resolveLoose(path) {
  let probe = path;
  const tail = [];
  let hops = 0;
  for (;;) {
    const real = await resolveExisting(probe);
    if (real !== null) return tail.length ? join(real, ...tail.reverse()) : real;
    const st = await lstat(probe).catch(() => null);
    if (st?.isSymbolicLink()) {
      if (++hops > MAX_SYMLINK_HOPS) throw new Error('project_memory_symlink_loop');
      probe = resolve(dirname(probe), await readlink(probe));
      continue;
    }
    tail.push(basename(probe));
    const parent = dirname(probe);
    if (parent === probe) return join(probe, ...tail.reverse());
    probe = parent;
  }
}

async function assertStoreOutside(storeDir, worktree) {
  if (typeof storeDir !== 'string' || !isAbsolute(storeDir)) {
    throw new Error('project_memory_path_relative');
  }
  const target = await resolveLoose(storeDir);
  if (worktree === undefined) return target;
  const tree = await resolveExisting(worktree);
  if (tree === null) throw new Error('project_memory_worktree_missing');
  const norm = resolve(storeDir);
  const dirTarget = await resolveLoose(dirname(storeDir));
  const targetDir = dirname(target);
  if (inside(tree, norm) || inside(norm, tree) ||
      inside(tree, target) || inside(target, tree) ||
      inside(tree, dirTarget) || inside(dirTarget, tree) ||
      inside(tree, targetDir) || inside(targetDir, tree)) {
    throw new Error('project_memory_inside_worker_paths');
  }
  return target;
}

async function resolveProjectFile(storeDir, projectId, worktree) {
  if (typeof projectId !== 'string' || !PROJECT.test(projectId)) {
    throw new Error('project_memory_project_invalid');
  }
  const dir = await assertStoreOutside(storeDir, worktree);
  const expectedFileName = `${projectId}.memory.json`;
  const expectedFile = join(dir, expectedFileName);
  // Запрещаем любые симлинки на сам файл памяти проекта (включая dangling
  // symlink на ещё не созданный файл другого проекта).
  try {
    const st = lstatSync(expectedFile);
    if (st.isSymbolicLink()) throw new Error('project_memory_symlink_disallowed');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const resolvedTarget = await resolveLoose(expectedFile);
  if (worktree !== undefined) {
    const tree = await resolveExisting(worktree);
    if (tree === null) throw new Error('project_memory_worktree_missing');
    if (inside(tree, resolvedTarget) || inside(resolvedTarget, tree) ||
        inside(tree, dirname(resolvedTarget)) || inside(dirname(resolvedTarget), tree)) {
      throw new Error('project_memory_inside_worker_paths');
    }
  }
  if (resolvedTarget !== expectedFile) {
    throw new Error('project_memory_symlink_disallowed');
  }
  return { dir, file: resolvedTarget };
}

async function readStoreDoc(file, projectId) {
  // Размер и тип проверяются ДО чтения: многогигабайтный или не-файл не
  // загружается в память процесса.
  let st;
  try { st = await stat(file); } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        schema: PROJECT_MEMORY_SCHEMA,
        project_id: projectId,
        updated_at: null,
        sections: emptySections(),
      };
    }
    throw error;
  }
  if (!st.isFile()) throw new Error('project_memory_corrupt');
  if (st.size > MAX_MEMORY_BYTES) throw new Error('project_memory_oversized');
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        schema: PROJECT_MEMORY_SCHEMA,
        project_id: projectId,
        updated_at: null,
        sections: emptySections(),
      };
    }
    throw error;
  }
  if (Buffer.byteLength(raw) > MAX_MEMORY_BYTES) throw new Error('project_memory_oversized');
  let doc;
  try { doc = JSON.parse(raw); } catch { throw new Error('project_memory_corrupt'); }
  validateStoreDoc(doc, projectId);
  return doc;
}

export const DEFAULT_STALE_LOCK_MS = 60_000;

// Жив ли процесс: ESRCH — процесса нет (мёртвый лок); EPERM и прочие —
// процесс существует, но принадлежит другому пользователю, лок живой.
const pidAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
};

// Восстановление после SIGKILL посреди записи: лок несёт JSON
// { pid, token, createdAt }. Мульти-слотовая гонка: истёкший лок ЖИВОГО pid
// не снимается никогда — владелец может быть просто медленным, а рейп под ним
// размыкает взаимное исключение. Лок снимается только когда он И просрочен
// (старше staleLockMs), И владелец мёртв (либо pid не читается — legacy или
// оборванная на создании запись, у которой живого владельца не существует).
// Перед unlink идентичность лока перепроверяется по inode и точному контенту:
// если конкурент успел снять и пересоздать лок, чужой валидный лок не трогаем.
async function clearStaleStoreLock(lock, staleLockMs, now = Date.now()) {
  let before;
  try { before = await stat(lock); } catch { return false; }
  if (!before.isFile()) return false;
  let raw;
  try { raw = await readFile(lock, 'utf8'); } catch { return false; }
  let meta = null;
  try { meta = JSON.parse(raw); } catch { /* legacy/пустой лок — судим по mtime */ }
  let createdAtMs = NaN;
  let pid = null;
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    if (typeof meta.createdAt === 'string') createdAtMs = Date.parse(meta.createdAt);
    if (Number.isSafeInteger(meta.pid) && meta.pid > 0) pid = meta.pid;
  }
  if (!Number.isFinite(createdAtMs)) createdAtMs = before.mtimeMs;
  const expired = Number.isFinite(createdAtMs) && (now - createdAtMs) > staleLockMs;
  if (!expired) return false;
  if (pid !== null && pidAlive(pid)) return false;
  let after;
  try { after = await stat(lock); } catch { return false; }
  if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) return false;
  let rawAgain;
  try { rawAgain = await readFile(lock, 'utf8'); } catch { return false; }
  if (rawAgain !== raw) return false;
  await rm(lock, { force: true }).catch(() => {});
  return true;
}

async function withStoreLock(file, fn, { staleLockMs = DEFAULT_STALE_LOCK_MS } = {}) {
  const lock = `${file}.lock`;
  // Уникальный токен владения: рейпер сверяет контент перед снятием, а
  // владелец не удалит чужой лок, пересозданный после гонки.
  const token = randomBytes(16).toString('hex');
  let fd;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fd = await open(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await clearStaleStoreLock(lock, staleLockMs);
      await delay(50);
    }
  }
  if (fd === undefined) throw new Error('project_memory_locked');
  try {
    await fd.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
    return await fn();
  } finally {
    // Снятие лока только если файл по пути — тот же самый inode, что мы
    // открыли: пересозданный конкурентом лок никогда не удаляется из-под него.
    try {
      const handleStat = await fd.stat();
      let pathStat = null;
      try { pathStat = await stat(lock); } catch { /* лок уже отсутствует */ }
      if (pathStat !== null && pathStat.isFile() &&
          pathStat.dev === handleStat.dev && pathStat.ino === handleStat.ino) {
        await unlink(lock).catch(() => {});
      }
    } catch { /* fd недействителен — остаток снимет stale-рейп */ }
    await fd.close().catch(() => {});
  }
}

async function writeStoreAtomic(file, doc) {
  const signed = {
    schema: PROJECT_MEMORY_SCHEMA,
    project_id: doc.project_id,
    updated_at: doc.updated_at,
    sections: doc.sections,
  };
  signed.pin_sha256 = storeIntegrity(signed);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
    return signed;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

function renderItems(items) {
  const grouped = emptySections();
  for (const item of items) grouped[item.section].push(item);
  const blocks = [];
  for (const section of PROJECT_MEMORY_SECTIONS) {
    if (grouped[section].length === 0) continue;
    const lines = [
      `[${section}]`,
      ...grouped[section].map(item =>
        `- ${item.text} (${item.id}, #${item.source_card}, ${item.verified_sha.slice(0, 8)})`),
    ];
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n');
}

function flattenSections(sections) {
  const items = [];
  for (const section of PROJECT_MEMORY_SECTIONS) {
    for (const entry of sections[section]) {
      items.push({
        section,
        id: entry.id,
        text: entry.text,
        source_card: String(entry.source_card),
        verified_sha: entry.verified_sha,
      });
    }
  }
  return items;
}

const sliceDigest = (projectId, items) =>
  createHash('sha256').update(canonicalJson({ projectId, items })).digest('hex');

const countEntries = sections =>
  PROJECT_MEMORY_SECTIONS.reduce((sum, s) => sum + sections[s].length, 0);

// Консолидация памяти проекта:
// 1) дедупликация по нормализованному тексту (оставляем более свежую запись)
//    и сжатие устаревшей более короткой записи, полностью поглощённой новой;
// 2) жёсткий лимит maxEntriesPerSection (вытесняются самые старые);
// 3) жёсткий бюджет maxChars (вытесняются самые старые записи, при равенстве
//    времени — из наиболее заполненной секции).
function compactSections(sections, { maxChars, maxEntriesPerSection }) {
  const next = emptySections();
  for (const section of PROJECT_MEMORY_SECTIONS) {
    const ordered = sections[section].map((entry, idx) => ({
      entry,
      idx,
      ts: Date.parse(entry.timestamp),
      norm: normalizeText(entry.text),
    }));
    ordered.sort((a, b) => (a.ts - b.ts) || (a.idx - b.idx));

    const keptNewestFirst = [];
    for (let i = ordered.length - 1; i >= 0; i--) {
      const candidate = ordered[i];
      const shadowed = keptNewestFirst.some(newer =>
        newer.norm === candidate.norm ||
        (candidate.norm.length >= SUBSUMPTION_MIN_CHARS && newer.norm.includes(candidate.norm)));
      if (!shadowed) keptNewestFirst.push(candidate);
    }
    keptNewestFirst.reverse();
    const bounded = keptNewestFirst.length > maxEntriesPerSection
      ? keptNewestFirst.slice(keptNewestFirst.length - maxEntriesPerSection)
      : keptNewestFirst;
    next[section] = bounded.map(x => x.entry);
  }

  while (renderItems(flattenSections(next)).length > maxChars) {
    let victimSection = null;
    let victimTs = Infinity;
    let victimCount = -1;
    for (const section of PROJECT_MEMORY_SECTIONS) {
      const list = next[section];
      if (list.length === 0) continue;
      const oldestTs = Date.parse(list[0].timestamp);
      if (oldestTs < victimTs || (oldestTs === victimTs && list.length > victimCount)) {
        victimTs = oldestTs;
        victimCount = list.length;
        victimSection = section;
      }
    }
    if (victimSection === null) break;
    next[victimSection].shift();
  }
  return next;
}

function toCanonicalFamilySpec(spec) {
  if (spec === null || spec === undefined) return null;
  if (executorFamily(spec) !== null) return spec;
  if (typeof spec === 'string') {
    const mapped = CANONICAL_FAMILY_SPEC.get(spec.trim().toLowerCase());
    if (mapped !== undefined) return mapped;
  }
  return null;
}

export function reviewReceiptDigest(receipt) {
  const { receipt_sha256, receipt_hmac_sha256, ...body } = receipt;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function assertValidHmacKey(hmacKey) {
  if (typeof hmacKey === 'string') {
    if (Buffer.byteLength(hmacKey, 'utf8') >= MIN_HMAC_KEY_BYTES) return;
  } else if (Buffer.isBuffer(hmacKey)) {
    if (hmacKey.length >= MIN_HMAC_KEY_BYTES) return;
  }
  throw new Error('project_memory_untrusted_write');
}

export function reviewReceiptHmac(receipt, hmacKey) {
  assertValidHmacKey(hmacKey);
  const { receipt_hmac_sha256, ...body } = receipt;
  return createHmac('sha256', hmacKey).update(canonicalJson(body)).digest('hex');
}

function validateReceiptFields(raw, { requireDigest = false, hmacKey } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('project_memory_untrusted_write');
  }
  if (raw.schema !== REVIEW_RECEIPT_SCHEMA) {
    throw new Error('project_memory_untrusted_write');
  }
  const role = typeof raw.role === 'string' ? raw.role.trim().toLowerCase() : '';
  if (!TRUSTED_ROLE_SET.has(role)) {
    throw new Error('project_memory_untrusted_write');
  }
  if (raw.verdict !== 'REVIEW_OK') {
    throw new Error('project_memory_untrusted_write');
  }
  if (typeof raw.sha !== 'string' || !GIT_SHA.test(raw.sha)) {
    throw new Error('project_memory_untrusted_write');
  }
  const workerSpec = toCanonicalFamilySpec(raw.worker);
  const reviewerSpec = toCanonicalFamilySpec(raw.reviewer);
  let families;
  try {
    families = assertCrossFamily(workerSpec, reviewerSpec);
  } catch {
    throw new Error('project_memory_untrusted_write');
  }
  const card = String(raw.source_card ?? '');
  if (!CARD.test(card)) {
    throw new Error('project_memory_source_card_invalid');
  }
  if (requireDigest) {
    assertValidHmacKey(hmacKey);
    if (typeof raw.receipt_sha256 !== 'string' || !DIGEST.test(raw.receipt_sha256) ||
        reviewReceiptDigest(raw) !== raw.receipt_sha256) {
      throw new Error('project_memory_untrusted_write');
    }
    if (typeof raw.receipt_hmac_sha256 !== 'string' || !DIGEST.test(raw.receipt_hmac_sha256)) {
      throw new Error('project_memory_untrusted_write');
    }
    const expected = reviewReceiptHmac(raw, hmacKey);
    const actualBuf = Buffer.from(raw.receipt_hmac_sha256, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
      throw new Error('project_memory_untrusted_write');
    }
  }
  return {
    role,
    verifiedSha: raw.sha,
    sourceCard: card,
    workerFamily: families.executor,
    reviewerFamily: families.critic,
  };
}

async function assertTrustedReceiptDir(trustedReceiptDir, worktree) {
  if (typeof trustedReceiptDir !== 'string' || !isAbsolute(trustedReceiptDir)) {
    throw new Error('project_memory_untrusted_write');
  }
  let dirStat;
  try {
    dirStat = lstatSync(trustedReceiptDir);
  } catch {
    throw new Error('project_memory_untrusted_write');
  }
  if (dirStat.isSymbolicLink()) {
    throw new Error('project_memory_symlink_disallowed');
  }
  if (!dirStat.isDirectory()) {
    throw new Error('project_memory_untrusted_write');
  }
  return assertStoreOutside(trustedReceiptDir, worktree);
}

export async function writeTrustedReviewReceipt({
  receiptPath,
  trustedReceiptDir,
  receipt,
  hmacKey,
  worktree,
}) {
  if (typeof receiptPath !== 'string' || !isAbsolute(receiptPath)) {
    throw new Error('project_memory_path_relative');
  }
  const trustedDir = await assertTrustedReceiptDir(trustedReceiptDir, worktree);
  const body = {
    schema: REVIEW_RECEIPT_SCHEMA,
    role: typeof receipt?.role === 'string' ? receipt.role.trim().toLowerCase() : receipt?.role,
    verdict: receipt?.verdict,
    sha: receipt?.sha,
    worker: receipt?.worker,
    reviewer: receipt?.reviewer,
    source_card: (receipt?.sourceCard ?? receipt?.source_card) !== undefined
      ? String(receipt.sourceCard ?? receipt.source_card) : undefined,
  };
  validateReceiptFields(body, { requireDigest: false });
  assertValidHmacKey(hmacKey);
  const signed = { ...body, receipt_sha256: reviewReceiptDigest(body) };
  signed.receipt_hmac_sha256 = reviewReceiptHmac(signed, hmacKey);
  try {
    const st = lstatSync(receiptPath);
    if (st.isSymbolicLink()) throw new Error('project_memory_symlink_disallowed');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const resolved = await resolveLoose(receiptPath);
  if (!inside(trustedDir, resolved) || resolved === trustedDir) {
    throw new Error('project_memory_untrusted_write');
  }
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 });
  const tmp = `${resolved}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, resolved);
    return resolved;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function readTrustedReceiptFile(receiptPath, trustedReceiptDir, worktree, hmacKey) {
  const trustedDir = await assertTrustedReceiptDir(trustedReceiptDir, worktree);
  if (typeof receiptPath !== 'string' || !isAbsolute(receiptPath)) {
    throw new Error('project_memory_untrusted_write');
  }
  let st;
  try {
    st = lstatSync(receiptPath);
  } catch {
    throw new Error('project_memory_untrusted_write');
  }
  if (st.isSymbolicLink()) {
    throw new Error('project_memory_symlink_disallowed');
  }
  if (!st.isFile()) {
    throw new Error('project_memory_untrusted_write');
  }
  // Размер проверяется ДО чтения — oversized квитанция не грузится в память.
  if (st.size > MAX_RECEIPT_BYTES) {
    throw new Error('project_memory_untrusted_write');
  }
  const resolved = await resolveLoose(receiptPath);
  // Квитанция обязана лежать строго внутри trustedReceiptDir (не просто «вне worktree»)
  // и не иметь подменённых симлинком промежуточных сегментов.
  if (!inside(trustedDir, resolved) || resolved === trustedDir) {
    throw new Error('project_memory_untrusted_write');
  }
  if (relative(resolve(trustedReceiptDir), resolve(receiptPath)) !== relative(trustedDir, resolved)) {
    throw new Error('project_memory_symlink_disallowed');
  }
  let raw;
  try { raw = await readFile(resolved, 'utf8'); } catch {
    throw new Error('project_memory_untrusted_write');
  }
  if (Buffer.byteLength(raw) > MAX_RECEIPT_BYTES) {
    throw new Error('project_memory_untrusted_write');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('project_memory_untrusted_write');
  }
  return validateReceiptFields(parsed, { requireDigest: true, hmacKey });
}

// Жёсткая граница доверия на запись:
// единственный допустимый путь — квитанция ревью на диске строго внутри
// доверенного операторского каталога trustedReceiptDir (не symlink, вне worktree),
// с проверкой receipt_sha256, REVIEW_OK, assertCrossFamily и опционального HMAC-SHA256.
async function verifyTrustedWrite({
  attestation,
  receiptPath,
  trustedReceiptDir,
  hmacKey,
  sourceCard,
  worktree,
}) {
  if (receiptPath === undefined || trustedReceiptDir === undefined || hmacKey === undefined) {
    throw new Error('project_memory_untrusted_write');
  }
  assertValidHmacKey(hmacKey);
  const verified = await readTrustedReceiptFile(receiptPath, trustedReceiptDir, worktree, hmacKey);

  if (sourceCard !== undefined && String(sourceCard) !== verified.sourceCard) {
    throw new Error('project_memory_untrusted_write');
  }

  if (attestation !== undefined) {
    if (attestation === null || typeof attestation !== 'object' || Array.isArray(attestation) ||
        attestation.untrusted === true) {
      throw new Error('project_memory_untrusted_write');
    }
    for (const field of ['trusted_role', 'role', 'actor', 'source', 'caller']) {
      if (field in attestation) {
        const val = typeof attestation[field] === 'string' ? attestation[field].trim().toLowerCase() : '';
        if (!TRUSTED_ROLE_SET.has(val) || val !== verified.role) {
          throw new Error('project_memory_untrusted_write');
        }
      }
    }
    if ('review_verdict' in attestation && attestation.review_verdict !== 'REVIEW_OK') {
      throw new Error('project_memory_untrusted_write');
    }
    if ('verified_sha' in attestation && attestation.verified_sha !== verified.verifiedSha) {
      throw new Error('project_memory_untrusted_write');
    }
    if ('source_card' in attestation && String(attestation.source_card) !== verified.sourceCard) {
      throw new Error('project_memory_untrusted_write');
    }
    for (const wField of ['worker_executor', 'worker_family']) {
      if (wField in attestation) {
        const spec = toCanonicalFamilySpec(attestation[wField]);
        if (spec === null || executorFamily(spec) !== verified.workerFamily) {
          throw new Error('project_memory_untrusted_write');
        }
      }
    }
    for (const rField of ['reviewer_executor', 'reviewer_family']) {
      if (rField in attestation) {
        const spec = toCanonicalFamilySpec(attestation[rField]);
        if (spec === null || executorFamily(spec) !== verified.reviewerFamily) {
          throw new Error('project_memory_untrusted_write');
        }
      }
    }
  }
  return verified;
}

export async function resolveProjectMemory({
  storeDir,
  projectId,
  maxChars = DEFAULT_MAX_CHARS,
  worktree,
}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error('project_memory_maxchars_invalid');
  }
  const { file } = await resolveProjectFile(storeDir, projectId, worktree);
  const doc = await readStoreDoc(file, projectId);
  const allItems = flattenSections(doc.sections);
  const included = [];
  let truncated = false;
  for (const item of allItems) {
    if (renderItems([...included, item]).length > maxChars) {
      truncated = true;
      break;
    }
    included.push(item);
  }
  const sections = emptySections();
  for (const item of included) {
    const original = doc.sections[item.section].find(e => e.id === item.id);
    if (original) sections[item.section].push(original);
  }
  return {
    projectId,
    text: renderItems(included),
    digest: sliceDigest(projectId, included),
    ids: included.map(i => i.id),
    sections,
    truncated,
    total: allItems.length,
    items: included,
  };
}

async function recordProjectMemoryUpdate({
  storeDir,
  projectId,
  updates,
  attestation,
  receiptPath,
  trustedReceiptDir,
  hmacKey,
  sourceCard,
  worktree,
  maxChars = DEFAULT_MAX_CHARS,
  maxEntriesPerSection = DEFAULT_MAX_ENTRIES_PER_SECTION,
  now = new Date(),
}) {
  const verified = await verifyTrustedWrite({
    attestation,
    receiptPath,
    trustedReceiptDir,
    hmacKey,
    sourceCard,
    worktree,
  });
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error('project_memory_updates_invalid');
  }
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error('project_memory_maxchars_invalid');
  }
  if (!Number.isSafeInteger(maxEntriesPerSection) || maxEntriesPerSection < 1) {
    throw new Error('project_memory_maxentries_invalid');
  }
  const prepared = [];
  const batchIds = new Set();
  const ts = now.toISOString();
  for (const u of updates) {
    if (u === null || typeof u !== 'object' || Array.isArray(u) || !SECTION_SET.has(u.section)) {
      throw new Error('project_memory_section_invalid');
    }
    if (typeof u.text !== 'string') {
      throw new Error('project_memory_text_invalid');
    }
    // Запись памяти — строго одна строка: весь whitespace (включая переводы
    // строк) схлопывается перед проверкой длины. Срез рендерится построчно,
    // поэтому многострочная инъекция поддельных [section]-заголовков в текст
    // среза невозможна независимо от пути, которым updates попали сюда —
    // в том числе в обход extractPostReviewMemoryUpdates.
    const text = u.text.replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_ENTRY_CHARS) {
      throw new Error('project_memory_text_invalid');
    }
    const id = u.id ?? randomUUID();
    if (!ID.test(id)) throw new Error('project_memory_id_invalid');
    if (batchIds.has(id)) throw new Error('project_memory_duplicate_id');
    batchIds.add(id);
    const entry = {
      id,
      text,
      source_card: verified.sourceCard,
      verified_sha: verified.verifiedSha,
      timestamp: ts,
    };
    entry.sha256 = entryDigest(entry);
    prepared.push({ section: u.section, entry });
  }

  const { dir, file } = await resolveProjectFile(storeDir, projectId, worktree);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withStoreLock(file, async () => {
    const doc = await readStoreDoc(file, projectId);
    const existingIds = new Set(flattenSections(doc.sections).map(i => i.id));
    for (const { entry } of prepared) {
      if (existingIds.has(entry.id)) throw new Error('project_memory_duplicate_id');
    }
    const merged = emptySections();
    for (const section of PROJECT_MEMORY_SECTIONS) merged[section] = [...doc.sections[section]];
    for (const { section, entry } of prepared) merged[section].push(entry);
    const before = countEntries(merged);
    const compacted = compactSections(merged, { maxChars, maxEntriesPerSection });
    const after = countEntries(compacted);
    const saved = await writeStoreAtomic(file, {
      project_id: projectId,
      updated_at: ts,
      sections: compacted,
    });
    const items = flattenSections(saved.sections);
    return {
      projectId,
      added: prepared.map(p => ({ section: p.section, ...p.entry })),
      total: after,
      removed: before - after,
      digest: sliceDigest(projectId, items),
      pin_sha256: saved.pin_sha256,
    };
  });
}

// Доверенная фабрика записи: однократно закрепляет storeDir, trustedReceiptDir,
// hmacKey и worktree в замыкании из операторской конфигурации; вызывающий
// writer.recordUpdate(...) не может переопределить доверенный каталог или ключ.
export function createProjectMemoryWriter({
  storeDir,
  trustedReceiptDir,
  hmacKey,
  worktree,
  maxChars = DEFAULT_MAX_CHARS,
  maxEntriesPerSection = DEFAULT_MAX_ENTRIES_PER_SECTION,
}) {
  if (typeof storeDir !== 'string' || !isAbsolute(storeDir)) {
    throw new Error('project_memory_path_relative');
  }
  if (typeof trustedReceiptDir !== 'string' || !isAbsolute(trustedReceiptDir)) {
    throw new Error('project_memory_untrusted_write');
  }
  assertValidHmacKey(hmacKey);
  const pinnedStoreDir = storeDir;
  const pinnedReceiptDir = trustedReceiptDir;
  const pinnedHmacKey = Buffer.isBuffer(hmacKey) ? Buffer.from(hmacKey) : hmacKey;
  const pinnedWorktree = worktree;
  const defaultMaxChars = maxChars;
  const defaultMaxEntries = maxEntriesPerSection;

  return Object.freeze({
    async recordUpdate(params) {
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        throw new Error('project_memory_untrusted_write');
      }
      if ('trustedReceiptDir' in params || 'hmacKey' in params ||
          'storeDir' in params || 'worktree' in params) {
        throw new Error('project_memory_untrusted_write');
      }
      return recordProjectMemoryUpdate({
        storeDir: pinnedStoreDir,
        trustedReceiptDir: pinnedReceiptDir,
        hmacKey: pinnedHmacKey,
        worktree: pinnedWorktree,
        projectId: params.projectId,
        receiptPath: params.receiptPath,
        updates: params.updates,
        attestation: params.attestation,
        sourceCard: params.sourceCard,
        maxChars: params.maxChars ?? defaultMaxChars,
        maxEntriesPerSection: params.maxEntriesPerSection ?? defaultMaxEntries,
        now: params.now,
      });
    },
  });
}

export async function compactProjectMemory({
  storeDir,
  projectId,
  maxChars = DEFAULT_MAX_CHARS,
  maxEntriesPerSection = DEFAULT_MAX_ENTRIES_PER_SECTION,
  worktree,
  now = new Date(),
}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error('project_memory_maxchars_invalid');
  }
  if (!Number.isSafeInteger(maxEntriesPerSection) || maxEntriesPerSection < 1) {
    throw new Error('project_memory_maxentries_invalid');
  }
  const { dir, file } = await resolveProjectFile(storeDir, projectId, worktree);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withStoreLock(file, async () => {
    const doc = await readStoreDoc(file, projectId);
    const before = countEntries(doc.sections);
    const compacted = compactSections(doc.sections, { maxChars, maxEntriesPerSection });
    const after = countEntries(compacted);
    const saved = await writeStoreAtomic(file, {
      project_id: projectId,
      updated_at: now.toISOString(),
      sections: compacted,
    });
    const items = flattenSections(saved.sections);
    return {
      projectId,
      before,
      after,
      removed: before - after,
      digest: sliceDigest(projectId, items),
      pin_sha256: saved.pin_sha256,
    };
  });
}

export async function removeProjectMemoryEntry({
  storeDir,
  projectId,
  entryId,
  worktree,
  now = new Date(),
}) {
  if (typeof entryId !== 'string' || !ID.test(entryId)) {
    throw new Error('project_memory_id_invalid');
  }
  const { dir, file } = await resolveProjectFile(storeDir, projectId, worktree);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withStoreLock(file, async () => {
    const doc = await readStoreDoc(file, projectId);
    let found = false;
    const next = emptySections();
    for (const section of PROJECT_MEMORY_SECTIONS) {
      next[section] = doc.sections[section].filter(e => {
        if (e.id === entryId) { found = true; return false; }
        return true;
      });
    }
    if (!found) throw new Error('project_memory_entry_not_found');
    const saved = await writeStoreAtomic(file, {
      project_id: projectId,
      updated_at: now.toISOString(),
      sections: next,
    });
    const items = flattenSections(saved.sections);
    return {
      projectId,
      removedId: entryId,
      remaining: items.length,
      digest: sliceDigest(projectId, items),
      pin_sha256: saved.pin_sha256,
    };
  });
}

export async function clearProjectMemory({
  storeDir,
  projectId,
  worktree,
  now = new Date(),
}) {
  const { dir, file } = await resolveProjectFile(storeDir, projectId, worktree);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withStoreLock(file, async () => {
    const doc = await readStoreDoc(file, projectId);
    const removedCount = countEntries(doc.sections);
    const saved = await writeStoreAtomic(file, {
      project_id: projectId,
      updated_at: now.toISOString(),
      sections: emptySections(),
    });
    return {
      projectId,
      cleared: true,
      removedCount,
      digest: sliceDigest(projectId, []),
      pin_sha256: saved.pin_sha256,
    };
  });
}

const isSlice = s => s !== null && typeof s === 'object' && !Array.isArray(s) &&
  typeof s.projectId === 'string' && PROJECT.test(s.projectId) &&
  DIGEST.test(s.digest ?? '') &&
  Array.isArray(s.ids) && s.ids.every(id => typeof id === 'string') &&
  typeof s.text === 'string' && typeof s.truncated === 'boolean' && Number.isSafeInteger(s.total);

const pinIntegrity = s => createHash('sha256').update(canonicalJson({
  project_id: s.project_id,
  pin_key: s.pin_key,
  enabled: s.enabled,
  digest: s.digest,
  ids: s.ids,
  items: s.items,
  truncated: s.truncated,
  total: s.total,
})).digest('hex');

const isSliceContent = s => isSlice(s) && Array.isArray(s.items) &&
  s.items.length === s.ids.length &&
  s.total >= s.ids.length &&
  s.items.every((item, i) => item !== null && typeof item === 'object' &&
    SECTION_SET.has(item.section) && item.id === s.ids[i] &&
    typeof item.text === 'string' && CARD.test(String(item.source_card ?? '')) &&
    GIT_SHA.test(item.verified_sha ?? '')) &&
  s.text === renderItems(s.items) &&
  s.truncated === (s.total > s.ids.length) &&
  sliceDigest(s.projectId, s.items) === s.digest;

const isPin = (s, expectedKey, expectedProjectId) => isSliceContent(s) &&
  typeof s.enabled === 'boolean' &&
  (s.enabled === true || (s.ids.length === 0 && s.items.length === 0 && s.total === 0 &&
    s.text === '' && s.truncated === false)) &&
  typeof s.project_id === 'string' && s.project_id === s.projectId &&
  (expectedProjectId === undefined || s.project_id === expectedProjectId) &&
  typeof s.pin_key === 'string' && s.pin_key.length > 0 && s.pin_key === expectedKey &&
  DIGEST.test(s.pin_sha256 ?? '') && pinIntegrity(s) === s.pin_sha256;

const emptySlice = (projectId, enabled = true) => ({
  enabled,
  projectId,
  text: '',
  digest: sliceDigest(projectId, []),
  ids: [],
  truncated: false,
  total: 0,
  items: [],
});

// Закрепление read-only среза памяти проекта за попыткой (task_id:attempt_id:epoch):
// воркер, критик и арбитр одного кандидата видят один и тот же snapshot/digest.
// При persistDir публикация атомарна через tmp + link с pin_sha256, привязанным
// к project_id + pin_key + enabled; отсутствие памяти и отключённая память
// (enabled: false) также персистятся, защищая попытку от смены DF_PROJECT_MEMORY_DIR.
export function pinProjectMemory(resolve_, { persistDir, projectId: expectedProjectId } = {}) {
  if (expectedProjectId !== undefined && (typeof expectedProjectId !== 'string' || !PROJECT.test(expectedProjectId))) {
    throw new Error('project_memory_project_invalid');
  }
  const pins = new Map();
  const fileFor = key => join(persistDir,
    `project-memory-${createHash('sha256').update(`${expectedProjectId ?? ''}\x00${key}`).digest('hex').slice(0, 32)}.json`);
  const readPinned = async (file, expectedKey) => {
    let saved;
    try { saved = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    if (!isPin(saved, expectedKey, expectedProjectId)) throw new Error('project_memory_pin_invalid');
    const { enabled, projectId, text, digest, ids, truncated, total, items } = saved;
    return { enabled, projectId, text, digest, ids, truncated, total, items };
  };
  return key => {
    if (typeof key !== 'string' || !key) throw new Error('project_memory_pin_key_invalid');
    let pin = pins.get(key);
    if (pin !== undefined) {
      // LRU-освежение: затронутый ключ переставляется в конец порядка вставки.
      pins.delete(key);
      pins.set(key, pin);
      return pin;
    }
    pin = (async () => {
      const file = persistDir === undefined ? null : fileFor(key);
      if (file !== null) {
        const saved = await readPinned(file, key);
        if (saved !== undefined) return saved;
      }
      const raw = (await resolve_()) ?? null;
      let slice;
      if (raw === null) {
        slice = expectedProjectId !== undefined ? emptySlice(expectedProjectId, false) : null;
      } else {
        slice = { enabled: raw.enabled ?? true, ...raw };
      }
      if (file !== null && slice !== null) {
        if (!isSliceContent(slice) || typeof slice.enabled !== 'boolean') {
          throw new Error('project_memory_slice_invalid');
        }
        if (expectedProjectId !== undefined && slice.projectId !== expectedProjectId) {
          throw new Error('project_memory_pin_invalid');
        }
        const { enabled, projectId, text, digest, ids, truncated, total, items } = slice;
        const payload = { enabled, projectId, text, digest, ids, truncated, total, items };
        const stored = { project_id: projectId, pin_key: key, ...payload };
        stored.pin_sha256 = pinIntegrity(stored);
        const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify(stored), { mode: 0o600 });
          try {
            await link(tmp, file);
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const saved = await readPinned(file, key);
            if (saved === undefined) throw new Error('project_memory_pin_invalid');
            return saved;
          }
        } finally {
          await unlink(tmp).catch(() => {});
        }
        return payload;
      }
      return slice;
    })();
    pins.set(key, pin);
    // Отклонённый pin не закрепляется в кэше: повторный вызов того же ключа
    // честно перезапускает resolve, а не возвращает навсегда битый Promise.
    pin.catch(() => {
      if (pins.get(key) === pin) pins.delete(key);
    });
    // Жёсткий LRU-cap: не больше PIN_CACHE_CAP ключей на фабрику — память
    // процесса не растёт без ограничений от числа попыток.
    while (pins.size > PIN_CACHE_CAP) {
      const oldest = pins.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      pins.delete(oldest);
    }
    return pin;
  };
}

export function resolveMemoryStoreDir({ explicit, policy, env = process.env } = {}) {
  const raw = explicit ??
    (typeof policy === 'string' ? policy : policy?.storeDir ?? policy?.dir ?? policy?.path) ??
    env[PROJECT_MEMORY_DIR_ENV];
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !isAbsolute(raw)) throw new Error('project_memory_path_relative');
  return raw;
}

export function memoryPolicyConfig(policy) {
  if (policy === undefined || policy === null) return {};
  if (typeof policy === 'string') return { storeDir: policy };
  if (typeof policy === 'object' && !Array.isArray(policy)) return policy;
  throw new Error('project_memory_policy_invalid');
}

export const PROJECT_MEMORY_HMAC_KEY_ENV = 'DF_PROJECT_MEMORY_HMAC_KEY';

// Разрешение операторского HMAC-ключа без plaintext в policy JSON:
// явный ключ > env DF_PROJECT_MEMORY_HMAC_KEY > приватный key-файл 0600
// (читается или создаётся с случайным ключом). Key-файл fail-closed:
// symlink, не-файл или group/world-readable режим — отказ, а не чтение.
export async function resolveMemoryHmacKey({ hmacKey, env = process.env, keyFile } = {}) {
  if (hmacKey !== undefined && hmacKey !== null && hmacKey !== '') {
    assertValidHmacKey(hmacKey);
    return hmacKey;
  }
  const fromEnv = env?.[PROJECT_MEMORY_HMAC_KEY_ENV];
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    assertValidHmacKey(fromEnv);
    return fromEnv;
  }
  if (keyFile !== undefined) {
    if (typeof keyFile !== 'string' || !isAbsolute(keyFile)) {
      throw new Error('project_memory_keyfile_path_invalid');
    }
    const meta = await lstat(keyFile).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (meta !== null) {
      if (meta.isSymbolicLink()) throw new Error('project_memory_keyfile_symlink');
      if (!meta.isFile()) throw new Error('project_memory_keyfile_not_a_file');
      if ((meta.mode & 0o077) !== 0) throw new Error('project_memory_keyfile_mode_insecure');
      const stored = (await readFile(keyFile, 'utf8')).trim();
      assertValidHmacKey(stored);
      return stored;
    }
    // Первичная генерация: wx-захват делает гонку двух создателей
    // идемпотентной — проигравший перечитывает уже записанный ключ.
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
    const generated = randomBytes(32).toString('hex');
    try {
      const handle = await open(keyFile, 'wx', 0o600);
      try {
        await handle.writeFile(`${generated}\n`);
      } finally {
        await handle.close();
      }
      return generated;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return resolveMemoryHmacKey({ keyFile, env: {} });
    }
  }
  throw new Error('project_memory_untrusted_write');
}

async function cli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'store-dir': { type: 'string' },
      project: { type: 'string' },
      id: { type: 'string' },
      'max-chars': { type: 'string' },
      'max-entries': { type: 'string' },
      worktree: { type: 'string' },
    },
  });
  const storeDir = resolveMemoryStoreDir({ explicit: values['store-dir'] });
  if (!storeDir) throw new Error(`Store dir required: --store-dir PATH or ${PROJECT_MEMORY_DIR_ENV}`);
  if (!values.project) throw new Error('Project required: --project ID');
  const projectId = values.project;
  const worktree = values.worktree;
  const maxChars = values['max-chars'] === undefined ? DEFAULT_MAX_CHARS : Number(values['max-chars']);
  const maxEntriesPerSection = values['max-entries'] === undefined
    ? DEFAULT_MAX_ENTRIES_PER_SECTION : Number(values['max-entries']);

  switch (positionals[0]) {
    case 'show': {
      const slice = await resolveProjectMemory({ storeDir, projectId, maxChars, worktree });
      process.stdout.write(`${JSON.stringify(slice)}\n`);
      return;
    }
    case 'compact': {
      const res = await compactProjectMemory({ storeDir, projectId, maxChars, maxEntriesPerSection, worktree });
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return;
    }
    case 'remove': {
      if (values.id === undefined) throw new Error('remove requires --id ENTRY_ID');
      const res = await removeProjectMemoryEntry({ storeDir, projectId, entryId: values.id, worktree });
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return;
    }
    case 'clear': {
      const res = await clearProjectMemory({ storeDir, projectId, worktree });
      process.stdout.write(`${JSON.stringify(res)}\n`);
      return;
    }
    default:
      throw new Error('Use: project-memory.mjs show|compact|remove|clear --store-dir DIR --project ID');
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  cli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
