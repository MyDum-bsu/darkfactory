// Taste Profile (Board #7922, WAVE2-3): двухуровневый профиль вкуса владельца
// для промптов лида, воркера и L2-критика. Уровень 1 — глобальный markdown
// owner-taste (путь пинается оператором извне), уровень 2 — репозиторный
// .darkfactory/project-profile.yaml (stack, указатель на AGENTS.md, вкусовые
// переопределения, отображение доменов в скиллы) плюс ограниченный excerpt
// AGENTS.md. Результат — компактный детерминированный digest-пиннутый блок
// projectContext строго в пределах maxChars. Чтение путей — fail-closed:
// любой выход за пределы repoRoot (.. или symlink) отклоняется.

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync,
  realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';

export const DEFAULT_PROFILE_RELPATH = '.darkfactory/project-profile.yaml';
export const DEFAULT_MAX_CHARS = 4096;
export const AGENTS_EXCERPT_CHARS = 1500;
export const DOMAINS = Object.freeze(['backend', 'ui', 'security', 'docs', 'research', 'ml']);
export const PROFILE_KEYS = Object.freeze([
  'repo_id', 'stack', 'l1_profile', 'agents_md', 'taste', 'domain_skills',
]);
const PROFILE_LIMIT_BYTES = 256 * 1024;
const AGENTS_READ_BYTES = 256 * 1024;
const STRING_LIMIT = 4096;
const DOMAIN_SET = new Set(DOMAINS);

function fail(code, detail) {
  const error = new Error(detail === undefined ? code : `${code}: ${detail}`);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function inside(root, path) {
  const rel = relative(root, path);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && rel !== '..');
}

// Отказ-закрытое разрешение относительного пути внутри repoRoot: запрет
// абсолютных путей и сегментов '..', а также symlink-целей, выходящих за
// канонический корень. missingOk допускает отсутствие файла (null).
function resolveInsideRepo(repoRoot, relPath, { missingOk = true } = {}) {
  if (typeof relPath !== 'string' || !relPath.trim() || isAbsolute(relPath) ||
      relPath.split(/[\\/]/).includes('..')) {
    throw fail('taste_profile_path_traversal', relPath);
  }
  const root = realpathSync(repoRoot);
  const candidate = resolve(root, relPath);
  if (!inside(root, candidate)) throw fail('taste_profile_path_traversal', relPath);
  let canonical;
  try {
    canonical = realpathSync(candidate);
  } catch (error) {
    if (missingOk && error && error.code === 'ENOENT') return null;
    throw fail('taste_profile_file_error', relPath);
  }
  if (!inside(root, canonical)) throw fail('taste_profile_path_traversal', relPath);
  return canonical;
}

function validString(value, max = STRING_LIMIT) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function toStringList(value, field) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (!list.every(entry => validString(entry, STRING_LIMIT))) {
    throw fail('taste_profile_invalid', `${field} must be non-empty strings`);
  }
  return list.map(entry => entry.trim());
}

function parseYamlStrict(text, path) {
  try {
    const doc = parseDocument(text, { schema: 'core', uniqueKeys: true, merge: false });
    if (doc.errors.length || doc.warnings.length) throw new Error('yaml parser rejected document');
    return doc.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw fail('taste_profile_yaml_invalid', `${path}: ${cause.message}`);
  }
}

// Чтение и валидация опционального .darkfactory/project-profile.yaml.
// Отсутствие файла — не ошибка (null); битый YAML, чужие ключи, неверные
// типы и выходы за repoRoot — fail-closed.
export function loadProjectProfile(repoRoot, { profileRelPath = DEFAULT_PROFILE_RELPATH } = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
    throw fail('taste_profile_root_invalid');
  }
  const canonical = resolveInsideRepo(repoRoot, profileRelPath);
  if (canonical === null) return null;
  const info = lstatSync(canonical);
  if (!info.isFile() || info.size === 0 || info.size > PROFILE_LIMIT_BYTES) {
    throw fail('taste_profile_file_invalid', profileRelPath);
  }
  const text = readFileSync(canonical, 'utf8');
  const raw = parseYamlStrict(text, profileRelPath);
  if (!isRecord(raw)) throw fail('taste_profile_invalid', 'top-level mapping required');
  for (const key of Object.keys(raw)) {
    if (!PROFILE_KEYS.includes(key)) throw fail('taste_profile_invalid', `unknown key ${key}`);
  }
  if (raw.repo_id !== undefined && !validString(raw.repo_id, 128)) {
    throw fail('taste_profile_invalid', 'repo_id');
  }
  if (raw.l1_profile !== undefined && !validString(raw.l1_profile, 256)) {
    throw fail('taste_profile_invalid', 'l1_profile');
  }
  let agentsMd = null;
  if (raw.agents_md !== undefined) {
    if (!validString(raw.agents_md, 512)) throw fail('taste_profile_invalid', 'agents_md');
    agentsMd = raw.agents_md.trim();
    // Указатель на AGENTS.md проверяется на traversal при загрузке профиля,
    // даже если файл ещё не читался: отказ-закрытая валидация контракта.
    // Проверяется trim()'нутое значение — то, что реально пойдёт в resolve.
    if (isAbsolute(agentsMd) || agentsMd.split(/[\\/]/).includes('..')) {
      throw fail('taste_profile_path_traversal', 'agents_md');
    }
  }
  const domainSkills = {};
  if (raw.domain_skills !== undefined) {
    if (!isRecord(raw.domain_skills)) throw fail('taste_profile_invalid', 'domain_skills');
    for (const [domain, skills] of Object.entries(raw.domain_skills)) {
      if (!DOMAIN_SET.has(domain)) throw fail('taste_profile_invalid', `unknown domain ${domain}`);
      domainSkills[domain] = Object.freeze(toStringList(skills, `domain_skills.${domain}`));
    }
  }
  return Object.freeze({
    repoId: raw.repo_id === undefined ? null : raw.repo_id.trim(),
    stack: Object.freeze(toStringList(raw.stack, 'stack')),
    l1Profile: raw.l1_profile === undefined ? null : raw.l1_profile.trim(),
    agentsMd,
    taste: Object.freeze(toStringList(raw.taste, 'taste')),
    domainSkills: Object.freeze(domainSkills),
    path: canonical,
  });
}

export function normalizeDomain(domain) {
  if (typeof domain !== 'string') return null;
  const lower = domain.trim().toLowerCase();
  return DOMAIN_SET.has(lower) ? lower : null;
}

// Детерминированный подбор скиллов домена: сначала скиллы домена из профиля
// (в объявленном порядке), затем defaultSkills; дубликаты схлопываются с
// сохранением первой позиции. Неизвестный или отсутствующий домен — только
// дефолтные скиллы.
export function pickDomainSkills({ profile = null, domain = null, defaultSkills = [] } = {}) {
  if (profile !== null && !isRecord(profile)) throw fail('taste_profile_skills_invalid');
  if (!Array.isArray(defaultSkills) || !defaultSkills.every(entry => validString(entry))) {
    throw fail('taste_profile_skills_invalid', 'defaultSkills must be strings');
  }
  const normalized = normalizeDomain(domain);
  const domainList = normalized !== null && profile !== null && isRecord(profile.domainSkills)
    ? (profile.domainSkills[normalized] ?? [])
    : [];
  if (!domainList.every(entry => validString(entry))) {
    throw fail('taste_profile_skills_invalid', 'domain skills must be strings');
  }
  const seen = new Set();
  const ordered = [];
  for (const skill of [...domainList, ...defaultSkills]) {
    if (!seen.has(skill)) {
      seen.add(skill);
      ordered.push(skill);
    }
  }
  return Object.freeze(ordered);
}

// Конец буфера не должен разрезать многобайтовую UTF-8 последовательность:
// неполный хвост (lead byte без всех continuation bytes) отбрасывается,
// иначе декодер подставит U+FFFD и сломает кириллический текст на границе.
function utf8SafeEnd(buffer, length) {
  if (length === 0) return 0;
  let continuation = 0;
  while (continuation < 3 && continuation < length &&
      (buffer[length - 1 - continuation] & 0xC0) === 0x80) {
    continuation += 1;
  }
  const leadIndex = length - 1 - continuation;
  const lead = buffer[leadIndex];
  if ((lead & 0x80) === 0) return length; // хвост — ASCII, граница чистая
  let expected = 0;
  if ((lead & 0xE0) === 0xC0) expected = 2;
  else if ((lead & 0xF0) === 0xE0) expected = 3;
  else if ((lead & 0xF8) === 0xF0) expected = 4;
  if (expected === 0) return leadIndex; // битый lead byte — отбросить
  return length - leadIndex === expected ? length : leadIndex;
}

// Ограниченное чтение начала файла без загрузки целиком в память. readSync
// вправе вернуть меньше запрошенного (короткие чтения, гонка усечения файла),
// поэтому чтение циклично до заполнения или EOF, а декодируются только
// реально прочитанные байты — без хвостовых NUL из недозаполненного буфера.
function readBounded(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = Math.min(fstatSync(fd).size, maxBytes);
    if (size === 0) return '';
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.toString('utf8', 0, utf8SafeEnd(buffer, offset));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readOptionalFile(path, maxBytes) {
  try {
    const info = statSync(path);
    if (!info.isFile()) return null;
    return readBounded(path, maxBytes);
  } catch {
    return null; // опциональные файлы отсутствуют штатно — fail-open
  }
}

// Усечение секции по границе строки (fallback — граница слова): бюджетные
// обрезки не разрывают строки посередине, когда это можно избежать.
function cutAtBoundary(text, cap) {
  if (text.length <= cap) return text;
  const slice = text.slice(0, cap);
  const lastNewline = slice.lastIndexOf('\n');
  if (lastNewline > 0) return slice.slice(0, lastNewline);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > 0) return slice.slice(0, lastSpace);
  return slice;
}

export const TRUNCATION_MARKER = '\n…[truncated]';

// Сборка секций в пределах maxChars с per-section бюджетными кепами: каждая
// секция получает равную долю оставшегося бюджета, неизрасходованный остаток
// меньших секций перетекает дальше. Превышающая долю секция обрезается по
// границе строки, поэтому одна гигантская секция не вытесняет остальные.
// Итог всегда завершается явным маркером усечения и никогда не превышает
// maxChars; при вырожденно малом бюджете (меньше маркера) — пустой текст.
function assembleSections(sections, maxChars) {
  const full = sections.join('\n\n');
  if (full.length <= maxChars) return { text: full, truncated: false };
  const marker = TRUNCATION_MARKER;
  if (maxChars <= marker.length) return { text: '', truncated: true };
  const parts = [];
  let used = 0; // длина parts, соединённых '\n\n'
  for (let i = 0; i < sections.length; i += 1) {
    const sep = parts.length === 0 ? 0 : 2;
    const remaining = maxChars - marker.length - used - sep;
    if (remaining < 1) break;
    const share = Math.max(1, Math.floor(remaining / (sections.length - i)));
    const section = sections[i];
    if (section.length <= share) {
      parts.push(section);
      used += sep + section.length;
      continue;
    }
    const cut = cutAtBoundary(section, share);
    if (cut.length > 0) {
      parts.push(cut);
      used += sep + cut.length;
    }
  }
  return { text: parts.join('\n\n') + marker, truncated: true };
}

// Сборка компактного projectContext: фиксированный порядок секций делает
// текст и digest детерминированными при неизменных входах. Бюджет maxChars
// гарантируется per-section кепами с явным маркером усечения вместо среза
// посередине текста.
export function buildProjectContext({ globalTastePath = null, repoRoot, domain = null,
  maxChars = DEFAULT_MAX_CHARS, defaultSkills = [], agentsExcerptChars = AGENTS_EXCERPT_CHARS } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1024 * 1024) {
    throw fail('taste_profile_maxchars_invalid');
  }
  if (!Number.isSafeInteger(agentsExcerptChars) || agentsExcerptChars < 1) {
    throw fail('taste_profile_excerpt_invalid');
  }
  const profile = loadProjectProfile(repoRoot);

  let globalTaste = null;
  if (typeof globalTastePath === 'string' && globalTastePath.trim()) {
    const content = readOptionalFile(globalTastePath, PROFILE_LIMIT_BYTES);
    if (content !== null && content.trim()) globalTaste = content.trim();
  }

  let agentsExcerpt = null;
  if (profile !== null && profile.agentsMd !== null) {
    const canonical = resolveInsideRepo(repoRoot, profile.agentsMd);
    if (canonical !== null) {
      const content = readOptionalFile(canonical, AGENTS_READ_BYTES);
      if (content !== null && content.trim()) {
        const trimmed = content.trim();
        agentsExcerpt = trimmed.length > agentsExcerptChars
          ? `${trimmed.slice(0, agentsExcerptChars)}…`
          : trimmed;
      }
    }
  }

  const skills = pickDomainSkills({ profile, domain, defaultSkills });
  const sections = [];
  if (globalTaste !== null) {
    sections.push(`## Owner Taste (global)\n${globalTaste}`);
  }
  if (profile !== null) {
    const lines = [];
    if (profile.repoId !== null) lines.push(`repo: ${profile.repoId}`);
    if (profile.stack.length) lines.push(`stack: ${profile.stack.join(', ')}`);
    if (profile.l1Profile !== null) lines.push(`l1_profile: ${profile.l1Profile}`);
    for (const bullet of profile.taste) lines.push(`- ${bullet}`);
    if (lines.length) sections.push(`## Repo Taste (project profile)\n${lines.join('\n')}`);
  }
  if (agentsExcerpt !== null) {
    sections.push(`## AGENTS.md (excerpt)\n${agentsExcerpt}`);
  }
  if (skills.length) {
    const normalized = normalizeDomain(domain);
    const title = normalized !== null ? `## Domain Skills (${normalized})` : '## Domain Skills';
    sections.push(`${title}\n${skills.map(skill => `- ${skill}`).join('\n')}`);
  }

  const { text, truncated } = assembleSections(sections, maxChars);
  return Object.freeze({
    text,
    digest: sha256(text),
    skills,
    layers: Object.freeze({
      hasGlobalTaste: globalTaste !== null,
      hasRepoProfile: profile !== null,
      hasAgentsMd: agentsExcerpt !== null,
    }),
    truncated,
  });
}
