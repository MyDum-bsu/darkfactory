// Project Memory (Board #1265): автономная компактная память проекта в стиле
// iva/osinara/mia в доверенном операторском каталоге вне worktree воркера.
// Путь приходит только извне (policy.projectMemory или DF_PROJECT_MEMORY_DIR);
// в модуле нет зашитых путей. Воркер, критик и арбитр читают строго read-only
// закреплённый срез; запись разрешена только через доверенный пост-шаг с
// подтверждённым REVIEW_OK + verified_sha + независимой парой семейств.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readlink, realpath, rename, rm,
  unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertCrossFamily, executorFamily } from './review-runner.mjs';
import { canonicalJson } from './subject.mjs';

export const PROJECT_MEMORY_DIR_ENV = 'DF_PROJECT_MEMORY_DIR';
export const PROJECT_MEMORY_SCHEMA = 'darkfactory.project-memory.v1';
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

const inside = (root, p) => {
  const rel = relative(root, p);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

const emptySections = () => Object.fromEntries(PROJECT_MEMORY_SECTIONS.map(s => [s, []]));

const normalizeText = text => text.trim().replace(/\s+/g, ' ').toLowerCase();

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

async function withStoreLock(file, fn) {
  const lock = `${file}.lock`;
  let fd;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fd = await open(lock, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await delay(50);
    }
  }
  if (fd === undefined) throw new Error('project_memory_locked');
  try {
    return await fn();
  } finally {
    await fd.close().catch(() => {});
    await rm(lock, { force: true }).catch(() => {});
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

// Жёсткая граница доверия на запись:
// - явный allowlist доверенного post-review контекста (post_review_steward / operator / controller);
// - подтверждённая квитанция ревью (receipt.verdict === 'REVIEW_OK' и receipt.sha === verified_sha);
// - строгий формат Git SHA (40 или 64 hex-символа);
// - каноническое кросс-семейство через executorFamily/assertCrossFamily из review-runner.mjs.
function assertTrustedAttestation(attestation, explicitSourceCard) {
  if (attestation === null || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new Error('project_memory_untrusted_write');
  }
  if (attestation.untrusted === true) {
    throw new Error('project_memory_untrusted_write');
  }
  const roleCandidates = [attestation.trusted_role, attestation.role, attestation.actor]
    .filter(v => v !== undefined);
  if (roleCandidates.length === 0 ||
      roleCandidates.some(v => typeof v !== 'string' || !TRUSTED_ROLE_SET.has(v.trim().toLowerCase()))) {
    throw new Error('project_memory_untrusted_write');
  }
  for (const field of ['source', 'caller']) {
    if (attestation[field] !== undefined) {
      const val = typeof attestation[field] === 'string' ? attestation[field].trim().toLowerCase() : '';
      if (!TRUSTED_ROLE_SET.has(val)) throw new Error('project_memory_untrusted_write');
    }
  }
  if (attestation.review_verdict !== 'REVIEW_OK') {
    throw new Error('project_memory_untrusted_write');
  }
  if (typeof attestation.verified_sha !== 'string' || !GIT_SHA.test(attestation.verified_sha)) {
    throw new Error('project_memory_untrusted_write');
  }
  const receipt = attestation.receipt;
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt) ||
      receipt.verdict !== 'REVIEW_OK' ||
      typeof receipt.sha !== 'string' || !GIT_SHA.test(receipt.sha) ||
      receipt.sha !== attestation.verified_sha) {
    throw new Error('project_memory_untrusted_write');
  }
  const workerExecSpec = attestation.worker_executor !== undefined
    ? toCanonicalFamilySpec(attestation.worker_executor) : null;
  const workerFamSpec = attestation.worker_family !== undefined
    ? toCanonicalFamilySpec(attestation.worker_family) : null;
  if (attestation.worker_executor !== undefined && workerExecSpec === null) {
    throw new Error('project_memory_untrusted_write');
  }
  if (attestation.worker_family !== undefined && workerFamSpec === null) {
    throw new Error('project_memory_untrusted_write');
  }
  if (workerExecSpec !== null && workerFamSpec !== null &&
      executorFamily(workerExecSpec) !== executorFamily(workerFamSpec)) {
    throw new Error('project_memory_untrusted_write');
  }
  const reviewerExecSpec = attestation.reviewer_executor !== undefined
    ? toCanonicalFamilySpec(attestation.reviewer_executor) : null;
  const reviewerFamSpec = attestation.reviewer_family !== undefined
    ? toCanonicalFamilySpec(attestation.reviewer_family) : null;
  if (attestation.reviewer_executor !== undefined && reviewerExecSpec === null) {
    throw new Error('project_memory_untrusted_write');
  }
  if (attestation.reviewer_family !== undefined && reviewerFamSpec === null) {
    throw new Error('project_memory_untrusted_write');
  }
  if (reviewerExecSpec !== null && reviewerFamSpec !== null &&
      executorFamily(reviewerExecSpec) !== executorFamily(reviewerFamSpec)) {
    throw new Error('project_memory_untrusted_write');
  }
  const workerSpec = workerExecSpec ?? workerFamSpec;
  const reviewerSpec = reviewerExecSpec ?? reviewerFamSpec;
  let families;
  try {
    families = assertCrossFamily(workerSpec, reviewerSpec);
  } catch {
    throw new Error('project_memory_untrusted_write');
  }
  const attCard = attestation.source_card !== undefined ? String(attestation.source_card) : undefined;
  const paramCard = explicitSourceCard !== undefined ? String(explicitSourceCard) : undefined;
  const receiptCard = receipt.source_card !== undefined ? String(receipt.source_card) : undefined;
  if (attCard !== undefined && paramCard !== undefined && attCard !== paramCard) {
    throw new Error('project_memory_untrusted_write');
  }
  if (receiptCard !== undefined && (attCard ?? paramCard) !== undefined && receiptCard !== (attCard ?? paramCard)) {
    throw new Error('project_memory_untrusted_write');
  }
  const card = attCard ?? paramCard ?? receiptCard ?? '';
  if (!CARD.test(card)) {
    throw new Error('project_memory_source_card_invalid');
  }
  return {
    verifiedSha: attestation.verified_sha,
    sourceCard: card,
    workerFamily: families.executor,
    reviewerFamily: families.critic,
  };
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

export async function recordProjectMemoryUpdate({
  storeDir,
  projectId,
  updates,
  attestation,
  sourceCard,
  worktree,
  maxChars = DEFAULT_MAX_CHARS,
  maxEntriesPerSection = DEFAULT_MAX_ENTRIES_PER_SECTION,
  now = new Date(),
}) {
  const verified = assertTrustedAttestation(attestation, sourceCard);
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
    if (typeof u.text !== 'string' || !u.text.trim() || u.text.trim().length > MAX_ENTRY_CHARS) {
      throw new Error('project_memory_text_invalid');
    }
    const id = u.id ?? randomUUID();
    if (!ID.test(id)) throw new Error('project_memory_id_invalid');
    if (batchIds.has(id)) throw new Error('project_memory_duplicate_id');
    batchIds.add(id);
    const entry = {
      id,
      text: u.text.trim(),
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
  typeof s.project_id === 'string' && s.project_id === s.projectId &&
  (expectedProjectId === undefined || s.project_id === expectedProjectId) &&
  typeof s.pin_key === 'string' && s.pin_key.length > 0 && s.pin_key === expectedKey &&
  DIGEST.test(s.pin_sha256 ?? '') && pinIntegrity(s) === s.pin_sha256;

const emptySlice = projectId => ({
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
// к project_id + pin_key; отсутствие памяти (пустой срез) также персистится.
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
    const { projectId, text, digest, ids, truncated, total, items } = saved;
    return { projectId, text, digest, ids, truncated, total, items };
  };
  return key => {
    if (typeof key !== 'string' || !key) throw new Error('project_memory_pin_key_invalid');
    let pin = pins.get(key);
    if (pin === undefined) {
      pin = (async () => {
        const file = persistDir === undefined ? null : fileFor(key);
        if (file !== null) {
          const saved = await readPinned(file, key);
          if (saved !== undefined) return saved;
        }
        let slice = (await resolve_()) ?? null;
        if (slice === null && expectedProjectId !== undefined) {
          slice = emptySlice(expectedProjectId);
        }
        if (file !== null && slice !== null) {
          if (!isSliceContent(slice)) throw new Error('project_memory_slice_invalid');
          if (expectedProjectId !== undefined && slice.projectId !== expectedProjectId) {
            throw new Error('project_memory_pin_invalid');
          }
          const { projectId, text, digest, ids, truncated, total, items } = slice;
          const payload = { projectId, text, digest, ids, truncated, total, items };
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
