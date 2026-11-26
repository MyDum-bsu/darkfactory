// VS-4.2 Self-Learning Review Loop (Board #1263): read-only дистиллятор
// повторяющихся REWORK-уроков и fail-closed гейт их принятия. Дистиллятор
// только ЧИТАЕТ историю раундов попытки (roundsHistory из состояния
// контроллера) и выдаёт компактных кандидатов правил/чек-листов — он не
// мутирует ни конвейер, ни хранилище. Гейт validateDistilledLessons
// дедуплицирует, ограничивает размер/число правил и отклоняет любой
// кандидат, ослабляющий ревью/тесты/изоляцию/push/release/триаду, с
// причиной 'lesson_weakens_security_gate'. Критичные кандидаты помечаются
// requires_owner_approval и НЕ попадают в чек-лист автоматически.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink,
  writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const LESSONS_SCHEMA = 1;

// Минимум раундов REWORK в истории попытки для дистилляции урока.
export const DEFAULT_MIN_REWORK_ROUNDS = 2;

// Жёсткие лимиты чек-листа: урок короткий, их мало — воркер получает
// дистиллированную выжимку, а не сырой лог.
export const DEFAULT_MAX_RULE_CHARS = 200;
export const DEFAULT_MAX_LESSONS = 12;
export const DEFAULT_MAX_TOTAL_CHARS = 1600;

// Нормализация текста замечания ревьюера: регистр, хэши, числовые и
// путевые идентификаторы стираются — два раунда об одном и том же дают
// один нормализованный фрагмент.
function normalizeText(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  return raw.toLowerCase()
    .replace(/[0-9a-f]{7,64}/g, '#')
    .replace(/\/[\w./-]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

// Сканируемый текст раунда: хэши стираются, но пути СОХРАНЯЮТСЯ —
// паттерн host_path_leak обязан видеть '/home/...' до любой маскировки.
function scanText(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  return raw.toLowerCase()
    .replace(/[0-9a-f]{7,64}/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

// Весь проверяемый текст раунда: находки L2 (expected/actual/file),
// выдержка критика и директива арбитра.
function roundText(round) {
  const parts = [];
  for (const f of Array.isArray(round?.findings) ? round.findings : []) {
    if (f === null || typeof f !== 'object') continue;
    parts.push(f.file, f.expected, f.actual, f.input);
  }
  parts.push(round?.excerpt, round?.directive, round?.signature);
  return scanText(parts.filter(p => typeof p === 'string' && p).join(' '));
}

// Каталог детерминированных паттернов блокеров. match проверяется против
// нормализованного текста раунда; rule — готовая строка чек-листа.
const PATTERNS = Object.freeze([
  {
    category: 'assert_under_optimize',
    match: /\bassert\b[\s\S]{0,160}(-\s?o\b|optimiz|production|-o\b)/i,
    alt: /(-\s?o\b|optimiz|production)[\s\S]{0,160}\bassert\b/i,
    rule: 'Do not use assert for checks required in release: optimization flags (-O, production) erase asserts — check explicitly with if/throw.',
    risk_level: 'medium',
  },
  {
    category: 'host_path_leak',
    match: /(^|\s)\/(home|users)\/[a-z0-9._-]+/i,
    rule: 'Code and tests must not contain paths like /home/<user>/... — use only parameters, env, and paths computed from the root.',
    risk_level: 'medium',
  },
  {
    category: 'non_atomic_write',
    match: /(не\s)?атомарн|atomic|tmp.*rename|rename.*tmp|temporar/,
    context: /запис|write|файл|handoff|конверт/,
    rule: 'Write files atomically: temporary file in the same directory + rename; partial writes are inadmissible.',
    risk_level: 'medium',
  },
  {
    category: 'missed_edge_case',
    match: /edge.?case|граничн|пуст(ой|ого|ую|ым|ом)|empty|boundary|overflow|null|undefined|none\b/,
    rule: 'Before handoff, check edge cases: empty and minimal input, range boundaries, null/undefined, repeated invocation.',
    risk_level: 'low',
  },
  {
    category: 'missing_evidence',
    match: /нет\s+(доказ|evidence|квитанц)|missing\s+(evidence|receipt)|без\s+квитанц/,
    rule: 'Every handoff carries a receipt and verification evidence — a claim without evidence does not count.',
    risk_level: 'low',
  },
]);

// Детектор самоослабления гейтов безопасности: любой текст кандидата,
// предлагающий отключить/пропустить/обойти проверку, гейт, изоляцию,
// ревью, тесты, push/release-ограничения или триаду — fail-closed отказ.
// Fail-closed: ложное срабатывание на вольную формулировку дешевле, чем
// пропуск ослабляющего правила — поэтому совпадение отклоняет кандидат
// без исключений.
const WEAKENING = [
  /\b(skip|disable|bypass|ignore|remove|turn off|switch off|waive|waived|relax|relaxed)\b/,
  /\bwithout\s+(tests?|review|checks?|isolation|gates?|triad|release|push)\b/,
  /\bno\s+(tests?|review|checks?|isolation|gates?|triad|release|push)\b/,
  /отключ(и|ить|ать|ен|ена|ено)/,
  /пропусти(ть|л|ла|ли)|пропускай(те)?\s+(тест|ревью|проверк|гейт|изоляц|триад|выпуск|релиз|push)/,
  /обойти|обход(а|у)?\s+(гейт|проверк|ревью|изоляц|политик|триад)/,
  /ослаб(ь|ить|лен|ляет|лять|ление)/,
  /без\s+(тест|ревью|проверк|изоляц|квитанц|арбитр|триад|выпуск|релиз|push)/,
  /разреш(и|ить|ено|ён)\s+(push|force|мердж|merge|выпуск|релиз)/,
  /force[\s-]?push|push\s+--force|push\s+-f\b/,
  /не\s+нужн[аыо]?\s+(тест|ревью|проверк|арбитр|триад|изоляц)/,
  /ненужн[аыо]\s+(тест|ревью|проверк|арбитр|триад|изоляц)/,
  /можно\s+(пропусти|не\s+делать|обойтись|не\s+провер)/,
  /необязательн|не\s+обязательн|не\s+требуется/,
];

// Шесть охраняемых доменов: ревью, тесты, изоляция, push, release, триада.
const GATE_DOMAINS =
  /(ревью|review|тест|tests?|проверк|checks?|изоляц|isolation|sandbox|push|пуш|release|релиз|выпуск|триад|triad|арбитр|arbiter|гейт|gate)/i;
// «Необязательность» охраняемого домена — то же ослабление, что и отключение.
const OPTIONALIZING =
  /(optional|not required|unnecessary|unneeded|waive|waived|relax|relaxed|необязательн|не\s+обязательн|не\s+требуется|можно\s+(пропусти|не\s+делать|обойтись)|без\s+необходимости)/i;

export function weakensSecurityGate(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (WEAKENING.some(re => re.test(normalized))) return true;
  // Свободная формулировка «X необязателен» по любому из шести доменов.
  return OPTIONALIZING.test(normalized) && GATE_DOMAINS.test(normalized);
}

const lessonId = (category, rule) =>
  `lesson-${category}-${createHash('sha256').update(`${category}${rule}`).digest('hex').slice(0, 8)}`;

// Валидная форма кандидата урока — fail-closed: неполный/непустой
// кандидат не доходит до остальных проверок.
export function validLesson(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  if (typeof candidate.id !== 'string' || !/^lesson-[a-z0-9_]+-[0-9a-f]{8}$/.test(candidate.id)) return false;
  if (typeof candidate.category !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(candidate.category)) return false;
  if (typeof candidate.pattern !== 'string' || !candidate.pattern) return false;
  if (typeof candidate.rule !== 'string' || !candidate.rule.trim()) return false;
  if (!Array.isArray(candidate.evidence_cards)) return false;
  if (!Number.isSafeInteger(candidate.occurrences) || candidate.occurrences < 1) return false;
  if (!['low', 'medium', 'high'].includes(candidate.risk_level)) return false;
  // Флаг owner-approval — строго boolean: строковое 'true' и прочие типы
  // делают кандидата невалидным, а не «почти одобренным».
  if (candidate.requires_owner_approval !== undefined &&
      typeof candidate.requires_owner_approval !== 'boolean') return false;
  return true;
}

// Авто-инъекция строго из закрытого каталога проверенных шаблонов:
// категория вне каталога (включая свободный текст repeated_finding) —
// всегда pending для владельца, никогда в чек-лист автоматически.
// Каталог — единственный источник текста правила: авто-инъекция берёт
// канонический rule записи каталога, никогда произвольный candidate.rule.
export const SAFE_CATALOG = Object.freeze(
  Object.fromEntries(PATTERNS.map(p => [p.category, Object.freeze({ category: p.category, rule: p.rule })])));
const SAFE_CATEGORIES = new Set(Object.keys(SAFE_CATALOG));

// Дистилляция истории REWORK-раундов одной карточки. roundsHistory —
// массив раундов из состояния попытки ({ gate, findings, excerpt,
// signature, directive? }). Меньше minReworkRounds раундов — пустой
// список: единичный срыв уроком не считается.
// Возврат: [{ id, category, pattern, rule, evidence_cards, occurrences,
// risk_level }] — один кандидат на повторившийся паттерн (>=2 раундов с
// совпадением), плюс 'repeated_finding' за дословно повторившееся
// замечание ревьюера.
export function distillReworkLessons(roundsHistory, { cardId = 'unknown',
  minReworkRounds = DEFAULT_MIN_REWORK_ROUNDS } = {}) {
  const rounds = Array.isArray(roundsHistory)
    ? roundsHistory.filter(r => r !== null && typeof r === 'object') : [];
  if (rounds.length < minReworkRounds) return [];
  const card = typeof cardId === 'string' && cardId ? cardId : String(cardId ?? 'unknown');
  const texts = rounds.map(roundText);
  const candidates = [];
  for (const pattern of PATTERNS) {
    let hits = 0;
    for (const text of texts) {
      if (!text) continue;
      const matched = pattern.match.test(text) || pattern.alt?.test(text);
      if (matched && (!pattern.context || pattern.context.test(text))) hits += 1;
    }
    if (hits < 2) continue;
    const rule = pattern.rule;
    candidates.push({
      id: lessonId(pattern.category, rule),
      category: pattern.category,
      pattern: pattern.match.source,
      rule,
      evidence_cards: [card],
      occurrences: hits,
      risk_level: pattern.risk_level,
    });
  }
  // Дословно повторившееся замечание: одинаковая сигнатура/нормализованный
  // текст в >=2 раундах — урок о повторе конкретного блокера.
  const seen = new Map();
  for (const [index, text] of texts.entries()) {
    const signature = normalizeText(rounds[index]?.signature) || text.slice(0, 120);
    if (!signature) continue;
    const entry = seen.get(signature) ?? { count: 0, text };
    entry.count += 1;
    seen.set(signature, entry);
  }
  for (const [signature, entry] of seen) {
    if (entry.count < 2) continue;
    const rule = 'Before handoff, check the exact finding that already repeated in this attempt: ' +
      `"${signature.slice(0, 80)}" — a repeated blocker is not allowed.`;
    candidates.push({
      id: lessonId('repeated_finding', rule),
      category: 'repeated_finding',
      pattern: `signature:${signature.slice(0, 80)}`,
      rule: rule.slice(0, DEFAULT_MAX_RULE_CHARS * 2),
      evidence_cards: [card],
      occurrences: entry.count,
      risk_level: 'medium',
      // Свободный текст из ревью никогда не инъектируется автоматически —
      // только после явного решения владельца.
      requires_owner_approval: true,
    });
  }
  return candidates;
}

// Fail-closed гейт принятия уроков. candidates — выдача дистиллятора;
// existing — уроки, уже лежащие в хранилище. Возврат:
// { accepted, pending, rejected, accumulated } — pending несёт кандидатов с
// requires_owner_approval === true (в чек-лист не попадают сами),
// rejected — { id, reason } по каждому отказу.
// Порядок проверок детерминирован: форма → безопасность → owner-флаг →
// дедуп → лимиты. Любой кандидат, ослабляющий ревью/тесты/изоляцию/
// push/release/триаду, отклоняется с 'lesson_weakens_security_gate'.
// С allowAccumulate повтор уже хранящегося канонического урока (тот же id
// и тот же rule) не отклоняется, а уходит в accumulated — appendLessons
// смержит occurrences и evidence_cards вместо мёртвого lesson_duplicate.
// Без флага (default false) поведение дедупа не меняется.
export function validateDistilledLessons(candidates, { existing = [],
  maxRuleChars = DEFAULT_MAX_RULE_CHARS, maxLessons = DEFAULT_MAX_LESSONS,
  maxTotalChars = DEFAULT_MAX_TOTAL_CHARS, allowAccumulate = false } = {}) {
  const accepted = [];
  const pending = [];
  const rejected = [];
  const accumulated = [];
  const known = new Map();
  for (const lesson of Array.isArray(existing) ? existing : []) {
    if (lesson !== null && typeof lesson === 'object' && typeof lesson.id === 'string') {
      known.set(lesson.id, lesson);
      if (typeof lesson.rule === 'string') known.set(`rule:${lesson.rule}`, lesson);
    }
  }
  let totalChars = 0;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const id = candidate?.id ?? 'unknown';
    if (!validLesson(candidate)) {
      rejected.push({ id, reason: 'lesson_invalid' });
      continue;
    }
    // Запрет самоослабления — раньше всех остальных проверок.
    if (weakensSecurityGate(candidate.rule) ||
        weakensSecurityGate(candidate.pattern) ||
        weakensSecurityGate(candidate.category)) {
      rejected.push({ id, reason: 'lesson_weakens_security_gate' });
      continue;
    }
    // Авто-инъекция — только канонический текст каталога: категория вне
    // каталога ИЛИ rule, отличный от SAFE_CATALOG[category].rule, —
    // pending для владельца, в чек-лист не попадает никогда.
    if (candidate.requires_owner_approval === true || candidate.risk_level === 'high' ||
        SAFE_CATALOG[candidate.category] === undefined ||
        candidate.rule !== SAFE_CATALOG[candidate.category].rule) {
      pending.push({ ...candidate, requires_owner_approval: true });
      continue;
    }
    if (candidate.rule.length > maxRuleChars) {
      rejected.push({ id, reason: 'lesson_too_large' });
      continue;
    }
    if (known.has(candidate.id) || known.has(`rule:${candidate.rule}`)) {
      // Аккумуляция — только точный повтор того же урока (id И rule
      // совпали): чужой урок с тем же текстом правила остаётся дублем.
      const prior = known.get(candidate.id);
      if (allowAccumulate && prior !== undefined && prior.rule === candidate.rule) {
        accumulated.push(candidate);
        continue;
      }
      rejected.push({ id, reason: 'lesson_duplicate' });
      continue;
    }
    if (accepted.length >= maxLessons || totalChars + candidate.rule.length > maxTotalChars) {
      rejected.push({ id, reason: 'lesson_limit_exceeded' });
      continue;
    }
    known.set(candidate.id, candidate);
    known.set(`rule:${candidate.rule}`, candidate);
    totalChars += candidate.rule.length;
    accepted.push(candidate);
  }
  return { accepted, pending, rejected, accumulated };
}

// path находится строго внутри root (как у изоляции run-isolated).
const inside = (root, p) => {
  const rel = relative(root, p);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

// Хранилище уроков — JSONL-файл в приватном каталоге состояния, вне
// рабочего дерева воркера. Fail-closed границы чтения:
// — сам файл обязан быть обычным файлом, НЕ симлинком (lstat, не stat):
//   симлинк, в том числе указывающий внутрь worktree, — отказ;
// — канонический путь обязан совпасть с заданным и лежать в allowedDir
//   вне любого каталога из outside (worktree и его поддеревья);
// — незавершённая последняя строка без '\n' игнорируется (частичная
//   запись убитого процесса не становится полууроком), полные строки
//   перед ней сохраняются;
// — битая полная строка пропускается, отсутствующий файл — пусто.
// Единая fail-closed граница пути хранилища — общая для чтения и записи:
// — существующий файл обязан быть обычным файлом, НЕ симлинком;
// — канонический путь совпадает с заданным, каталог — ровно allowedDir;
// — путь вне любого каталога из outside (worktree и его поддеревья).
// Для несуществующего файла (первая запись) проверяются dirname/allowedDir/
// outside по заданному пути — .tmp создаётся в том же каталоге.
async function assertLessonsPathAllowed(path, { allowedDir = null, outside = [] } = {}) {
  const meta = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (meta !== null && (meta.isSymbolicLink() || !meta.isFile())) {
    throw new Error('lessons_store_not_a_file');
  }
  const real = meta === null ? path : await realpath(path);
  if (real !== path) throw new Error('lessons_store_path_resolved');
  if (allowedDir !== null && dirname(real) !== await realpath(allowedDir)) {
    throw new Error('lessons_store_dir_mismatch');
  }
  for (const dir of Array.isArray(outside) ? outside : []) {
    if (typeof dir === 'string' && dir && inside(dir, real)) {
      throw new Error('lessons_store_in_worktree');
    }
  }
}

export async function loadLessons(path, { allowedDir = null, outside = [] } = {}) {
  const meta = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (meta === null) {
    // Хранилище ещё не создано — но заявленные границы проверяются и для
    // пустого чтения: каталог за пределами allowedDir — отказ, не пусто.
    if (allowedDir !== null || (Array.isArray(outside) && outside.length)) {
      await assertLessonsPathAllowed(path, { allowedDir, outside });
    }
    return [];
  }
  await assertLessonsPathAllowed(path, { allowedDir, outside });
  // Чтение строго по дескриптору, открытому с O_NOFOLLOW: подмена файла
  // симлинком между проверкой пути и чтением (TOCTOU) невозможна —
  // open на симлинке падает ELOOP ещё до fstat.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(error => {
      if (error.code === 'ELOOP') throw new Error('lessons_store_not_a_file');
      throw error;
    });
  let text;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('lessons_store_not_a_file');
    text = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const lines = text.split('\n');
  // Хвост без завершающего перевода строки — неполная запись, не урок.
  if (!text.endsWith('\n')) lines.pop();
  const lessons = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.schema === LESSONS_SCHEMA && validLesson(entry.lesson)) {
        lessons.push(entry.lesson);
      }
    } catch { /* битая строка не ломает чтение */ }
  }
  return lessons;
}

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

export const LESSONS_STALE_LOCK_MS = 60_000;

// Lockfile хранилища уроков — та же модель, что у project-memory/decision-
// ledger: лок несёт JSON { pid, token, createdAt } и снимается рейпером
// только когда он И просрочен, И владелец мёртв (либо pid не читается —
// оборванная на создании запись). Перед unlink идентичность перепроверяется
// по inode и точному контенту — чужой пересозданный лок не удаляется.
async function clearStaleLessonsLock(lock, staleLockMs, now = Date.now()) {
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

// Эксклюзивная блокировка read-modify-write хранилища уроков: конкурентные
// слоты не могут потерять чужие уроки гонкой «прочитали один снимок —
// перезаписали друг друга».
async function withLessonsLock(storePath, fn, { staleLockMs = LESSONS_STALE_LOCK_MS } = {}) {
  const lock = `${storePath}.lock`;
  const token = randomBytes(16).toString('hex');
  let fd;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fd = await open(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await clearStaleLessonsLock(lock, staleLockMs);
      await delay(50);
    }
  }
  if (fd === undefined) throw new Error('lessons_store_locked');
  try {
    await fd.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
    return await fn();
  } finally {
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

// Слияние принятых уроков в хранилище: повтор id аккумулирует
// occurrences и объединяет evidence_cards, а не плодит дубли. Запись
// всего файла атомарна; число уроков ограничено maxLessons.
// Весь цикл чтение-слияние-запись выполняется под эксклюзивным lockfile:
// база слияния перечитывается ВНУТРИ блокировки и потому всегда свежая —
// опция existing сохранена в сигнатуре для совместимости, но авторитетным
// источником остаётся хранилище под локом.
export async function appendLessons(path, accepted, { existing = null,
  maxLessons = DEFAULT_MAX_LESSONS, allowedDir = null, outside = [] } = {}) {
  // Та же граница, что и у чтения — ДО создания цели и любого .tmp:
  // симлинк/не-файл, расходящийся канонический путь, каталог вне
  // allowedDir или путь внутри outside (worktree) — отказ до записи.
  await assertLessonsPathAllowed(path, { allowedDir, outside });
  // Каталог создаётся до захвата лока — lockfile живёт рядом с хранилищем.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withLessonsLock(path, async () => {
    const store = await loadLessons(path, { allowedDir, outside });
    const byId = new Map(store.map(lesson => [lesson.id, lesson]));
    for (const lesson of Array.isArray(accepted) ? accepted : []) {
      const prev = byId.get(lesson.id);
      if (prev) {
        prev.occurrences += lesson.occurrences;
        prev.evidence_cards = [...new Set([...prev.evidence_cards, ...lesson.evidence_cards])];
      } else if (byId.size < maxLessons) {
        byId.set(lesson.id, { ...lesson, evidence_cards: [...lesson.evidence_cards] });
      }
    }
    const merged = [...byId.values()].slice(0, maxLessons);
    const body = merged.map(lesson =>
      JSON.stringify({ schema: LESSONS_SCHEMA, lesson })).join('\n') + (merged.length ? '\n' : '');
    const tmp = join(dirname(path), `.lessons-${randomUUID()}.tmp`);
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, path);
    return merged;
  });
}

// Персистентный pending-стóр уроков, ожидающих решения владельца: тот же
// JSONL-формат и те же fail-closed границы пути (symlink/allowedDir/outside),
// что у основного хранилища. Раньше pending-кандидаты просто терялись после
// validateDistilledLessons — теперь они накапливаются до явного approve.
// Ослабляющий гейты урок fail-closed не попадает даже в pending-стóр.

// Валидация кандидата для pending-стóра: форма + запрет самоослабления.
function assertPendingLessonStorable(lesson) {
  if (!validLesson(lesson)) throw new Error('lesson_invalid');
  if (weakensSecurityGate(lesson.rule) ||
      weakensSecurityGate(lesson.pattern) ||
      weakensSecurityGate(lesson.category)) {
    throw new Error('lesson_weakens_security_gate');
  }
}

export async function savePendingLessons(pendingPath, lessons, { allowedDir = null,
  outside = [], maxLessons = DEFAULT_MAX_LESSONS } = {}) {
  const list = Array.isArray(lessons) ? lessons : [];
  for (const lesson of list) assertPendingLessonStorable(lesson);
  // Аккумуляция повторов по id та же, что в основном хранилище:
  // occurrences суммируются, evidence_cards объединяются без дублей.
  return appendLessons(pendingPath, list, { allowedDir, outside, maxLessons });
}

export async function loadPendingLessons(pendingPath, { allowedDir = null, outside = [] } = {}) {
  return loadLessons(pendingPath, { allowedDir, outside });
}

// Одобрение владельцем: урок уходит из pending-стóра в основное хранилище
// уроков с отметкой approved_by/approved_at. Fail-closed даже на approve:
// ослабляющий гейты безопасности урок не может быть принят никогда —
// решение владельца не отменяет запрет самоослабления.
export async function approvePendingLesson({ pendingPath, lessonsPath, lessonId, approvedBy,
  options = {} }) {
  if (typeof lessonId !== 'string' || !lessonId) throw new Error('pending_lesson_id_invalid');
  if (typeof approvedBy !== 'string' || !approvedBy.trim()) {
    throw new Error('pending_lesson_approver_invalid');
  }
  const { allowedDir = null, outside = [], maxLessons = DEFAULT_MAX_LESSONS, now = new Date() } = options;
  const pending = await loadPendingLessons(pendingPath, { allowedDir, outside });
  const target = pending.find(lesson => lesson.id === lessonId);
  if (target === undefined) throw new Error('pending_lesson_not_found');
  // Повторная fail-closed проверка на момент approve: стóр могли подменить
  // между distillation и решением владельца — безопасность не делегируется.
  assertPendingLessonStorable(target);
  const approved = {
    ...target,
    requires_owner_approval: false,
    approved_by: approvedBy.trim(),
    approved_at: now.toISOString(),
  };
  // Сначала append в основное хранилище (идемпотентный merge по id), затем
  // перезапись pending без одобренного: сбой между шагами оставляет урок в
  // обоих стóрах — повторный approve безопасен, потери урока нет.
  const merged = await appendLessons(lessonsPath, [approved], { allowedDir, outside, maxLessons });
  await assertLessonsPathAllowed(pendingPath, { allowedDir, outside });
  await mkdir(dirname(pendingPath), { recursive: true, mode: 0o700 });
  // Перезапись pending — тот же read-modify-write, что и appendLessons:
  // база перечитывается под эксклюзивным локом, иначе конкурентный
  // savePendingLessons теряется гонкой last-write-wins. Локи не вложены —
  // appendLessons выше уже отпустил лок lessonsPath.
  await withLessonsLock(pendingPath, async () => {
    const current = await loadLessons(pendingPath, { allowedDir, outside });
    const remaining = current.filter(lesson => lesson.id !== lessonId);
    const body = remaining.map(lesson =>
      JSON.stringify({ schema: LESSONS_SCHEMA, lesson })).join('\n') + (remaining.length ? '\n' : '');
    const tmp = join(dirname(pendingPath), `.pending-${randomUUID()}.tmp`);
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, pendingPath);
  });
  return merged.find(lesson => lesson.id === lessonId) ?? approved;
}
