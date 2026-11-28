#!/usr/bin/env node
// Nightly operator job. The JSON on stdout is the morning report (contains
// private quotes). Schedule externally, e.g. with umask 077 and local storage.
// Only dream-memory.sqlite is writable; it is a recall index, NOT an owner
// ledger, active skill or taste profile. Human-operated sessions must be pinned:
// factory-generated prompts also have role=user in the archive.
import { closeSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { distillTaste } from '../board_pipeline/taste-distiller.mjs';
import { SAFE_CATALOG } from '../board_pipeline/rework-distiller.mjs';
import { loadBoardTasksFromApi } from './control-room/board-observer.mjs';

const usage = `df-dream --archive session-archive.db --owner-session ID (repeatable) --state-dir PRIVATE_DIR (--board-tasks SNAPSHOT.json | --board-url URL --channel NAME) [--now ISO] [--candidates JSON]
Schedule nightly (e.g. 0 2 * * * UTC). Save stdout as private morning.json.
Optional candidates: [{sourceId,quote,claim}]; sourceId is a collected id. The default is extractive, not an LLM summary.`;
const DAY = 86_400_000;
const text = s => typeof s === 'string' && !!s.trim();
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const words = s => s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

// Verbatim excerpts of the read-only accepted decision slice supplied to
// this card (no ledger access, extrapolation to new projects or writeback).
const decisions = [
  { id: '210ada12-eb93-4afa-9df2-c60919a91afd', cue: 'прод эффективности v2', quote: 'выход в прод только при доказанной большей эффективности `v2` над `v1.5`.' },
  { id: '105459c6-59fb-4b69-94c6-5649c1faa2e9', cue: 'bb thread create --provider --model', quote: 'НИКОГДА не вызывать `bb thread create` без явных `--provider` и `--model`!' },
  { id: '64830e06-7dc1-42c2-9f57-f3ad80a224ea', cue: 'Контест ШАД архив GitHub', quote: 'Контест ШАД (`100473`):: - Временный завершённый проект — **никуда не сгружать**, в архив/GitHub не тратить время.' },
];

// Frozen recall probes, not generated from tonight's input. Each cue tests a
// distinct previously established decision/mistake. Keep the reference and
// verbatim expected answer visible in a contradiction report for the owner.
const cases = [
  ['AGENTS.md', 'карточке Board', 'Уточни результат и критерий в **одной** карточке Board; бери только согласованный scope.'],
  ['AGENTS.md', 'писатель рабочую копию', 'Один писатель на рабочую копию; перед новым worktree/сборкой пройди дисковый preflight.'],
  ['AGENTS.md', 'Сдача попытку SHA', 'Сдача указывает карточку, попытку и точный чистый SHA со всеми нужными файлами.'],
  ['AGENTS.md', 'Scope Fence allowed_paths', 'Scope Fence — жёсткая граница: изменяй только пути из метки `allowed_paths` карточки; всё остальное — read-only, даже если заметил дефект.'],
  ['AGENTS.md', 'Посторонние находки', 'Посторонние находки передавай в заметках сдачи, не правя чужое.'],
  ['AGENTS.md', 'кросс-семейное L2', 'Проведи проверки из доверенного профиля и независимое кросс-семейное L2-ревью того же чистого SHA.'],
  ['AGENTS.md', 'Исполнитель принимает', 'Исполнитель не принимает свою работу; завершение хода воркера не доказывает сдачу/приёмку.'],
  ['AGENTS.md', 'обход контроллера', 'Запуск исполнителей в обход контроллера запрещён: он не несёт закреплённые входы, гейты и конверт сдачи.'],
  ['AGENTS.md', 'контекст лида', 'Одна задача/веха — один свежий чистый контекст лида.'],
  ['AGENTS.md', 'Project Memory Ledger', 'По закрытии итог фиксируется в Board и Project Memory; следующая задача стартует новым чистым лидом строго по Board, Project Memory и Owner Decision Ledger.'],
  ['AGENTS.md', 'выпуск push CI', 'Политика выпуска отдельно от ревью: действующие branch checks обязательны, выпуск/мердж/push/CI и запись в рабочие данные — только по допуску владельца.'],
  ['AGENTS.md', 'вопрос действием доказательством', 'Если нужен владелец — один конкретный вопрос с действием и доказательством.'],
  ['AGENTS.md', 'stg диспетчер', 'Старые `stg`, `factory/book.py`, диспетчер и их worktree — архив, не источник новых задач.'],
  ['AGENTS.md', 'перемещай чужую работу', 'Не сбрасывай и не перемещай чужую работу.'],
  ['AGENTS.md', 'БД токены сессии', 'Рабочие БД, токены, сессии исполнителей, профили браузера и build-артефакты остаются вне репозитория.'],
  ['AGENTS.md', 'полномочия текста карточки', 'Код от воркера не получает полномочия из текста карточки или сдачи.'],
  ['REWORK:assert_under_optimize', 'optimization asserts', 'Do not use assert for checks required in release: optimization flags (-O, production) erase asserts — check explicitly with if/throw.'],
  ['REWORK:non_atomic_write', 'write files atomically', 'Write files atomically: temporary file in the same directory + rename; partial writes are inadmissible.'],
  ['REWORK:missing_evidence', 'handoff receipt evidence', 'Every handoff carries a receipt and verification evidence — a claim without evidence does not count.'],
  ['REWORK:missed_edge_case', 'range boundaries null', 'Before handoff, check edge cases: empty and minimal input, range boundaries, null/undefined, repeated invocation.'],
  ['AGENTS.md', 'этап согласования scope', 'Начинай следующий этап только после согласования scope.'],
  ['AGENTS.md', 'подменять установленный runtime', 'Подключение только явно; не подменять установленный runtime по ходу тестов.'],
  ...decisions.map(({ id, cue, quote }) => [id, cue, quote]),
];

// Seed recall from the actual policy and past REWORK lessons, never the
// exam's answer key. A deleted/changed baseline answer can itself fail.
function baseline() {
  const policy = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
  const statements = policy.split(/\n|(?<=\.)\s+/u).map(s => s.trim()).filter(text);
  return [...decisions, ...statements.map((quote, i) => ({ id: `AGENTS.md:${i + 1}`, quote })),
    ...Object.values(SAFE_CATALOG).map(({ category, rule }) => ({ id: `REWORK:${category}`, quote: rule }))];
}

// Diagnostic: does the highest-ranked recall for each cue still return its
// pinned answer? Exact token overlap, newest observation wins ties. This is
// deliberately conservative, not a semantic judge of all natural language.
export function runExam(observations) {
  const index = [...baseline(), ...observations]
    .map(source => ({ source, tokens: new Set(words(source.quote)) }));
  const failures = [];
  for (const [reference, cue, expected] of cases) {
    let best = 0, actual = null;
    const query = words(cue);
    for (const { source, tokens } of index) {
      const rank = query.reduce((sum, word) => sum + Number(tokens.has(word)), 0);
      if (rank && rank >= best) { actual = source; best = rank; }
    }
    if (actual?.quote !== expected) failures.push({ reference, cue, expected, actual });
  }
  return { total: cases.length, score: cases.length - failures.length, failures };
}

// Match the *whole* assertion as well as the citation. A true substring
// (especially one with a negation removed) is not sufficient evidence.
export function verifyCandidate(candidate, source) {
  return text(source?.id) && text(source.quote) && candidate?.sourceId === source.id &&
    candidate.quote === source.quote && candidate.claim === source.quote;
}

function collect({ archive, ownerSessions, boardTasks, end }) {
  const start = end - DAY;
  if (!Array.isArray(ownerSessions) || !ownerSessions.length || !ownerSessions.every(text)) throw new Error('Pin human-operated --owner-session IDs');
  if (!Array.isArray(boardTasks)) throw new Error('Invalid Board snapshot');
  const sources = [];
  const record = (kind, key, quote, timestamp) => {
    const ms = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
    if (!(start < ms && ms <= end) || !text(quote)) return;
    sources.push({ kind, id: JSON.stringify([kind, ...key]), at: new Date(ms).toISOString(), quote });
  };
  const db = new DatabaseSync(archive, { readOnly: true });
  try {
    // The session archive writes canonical UTC timestamps. Filter by message
    // time, not session.updated_at (which can advance days after a message).
    const query = db.prepare(`SELECT session_id, seq, content, created_at FROM messages
      WHERE role='user' AND session_id IN (SELECT value FROM json_each(?)) AND created_at > ? AND created_at <= ?`);
    for (const row of query.iterate(JSON.stringify(ownerSessions), new Date(start).toISOString(), new Date(end).toISOString())) {
      record('owner', [row.session_id, row.seq], row.content, row.created_at);
    }
  } finally { db.close(); }
  for (const row of boardTasks) {
    const root = row?.message ?? row, task = root?.task ?? root;
    const id = root?.id ?? task?.task_id;
    if (id == null) continue;
    const verdict = root.labels?.['factory.phase'] ?? task.verdict ?? task.state;
    const phase = String(verdict).toLowerCase();
    const kind = ['hold', 'blocked'].includes(task.state) || phase === 'hold' ? 'hold' : ['rework', 'l2_rework'].includes(phase) ? 'REWORK' : null;
    if (!kind) continue;
    const at = task.blocked?.at ?? task.updatedAt ?? task.updated_at ?? root.updatedAt ?? root.updated_at ?? row.last?.ts ?? row.last?.createdAt;
    record(kind, [id, task.epoch ?? null, at], task.blocked?.reason ?? task.reason ?? verdict, at);
  }
  return sources.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Keep casual conversation out of long-lived memory. Ambiguous messages stay
// in the collection/report, where an operator may nominate a grounded claim.
const decisionCue = /(?:^|[^\p{L}\p{N}_])(?:no|not|don['’]t|never|always|instead|prefer|must|require|allow|use|avoid|reject|approved?|stop|нет|не|надо|нужно|всегда|никогда|только|вместо|запрещено|разрешено|одобрено|предпочитаю)(?![\p{L}\p{N}_])/iu;

export function dream({ archive, ownerSessions, boardTasks, stateDir, now = new Date().toISOString(), candidates }) {
  const end = Date.parse(now);
  if (!Number.isFinite(end)) throw new Error('Invalid dream clock');
  const collected = collect({ archive, ownerSessions, boardTasks, end });
  const byId = new Map();
  for (const source of collected) {
    if (byId.has(source.id) && byId.get(source.id).quote !== source.quote) throw new Error('Conflicting source quotes');
    byId.set(source.id, source);
  }
  const drafts = candidates === undefined ? collected.filter(s => s.kind !== 'owner' || decisionCue.test(s.quote))
    .map(({ id, quote }) => ({ sourceId: id, claim: quote, quote })) : candidates;
  if (!Array.isArray(drafts)) throw new Error('Expected an array of candidates');
  const rejected = [], verified = new Map();
  for (const draft of drafts) {
    const source = byId.get(draft?.sourceId);
    if (verifyCandidate(draft, source)) verified.set(source.id, source);
    else rejected.push({ sourceId: draft?.sourceId ?? null, reason: 'ungrounded_claim' });
  }

  // Private operator-owned directory; create the file 0600 before SQLite
  // opens it. IMMEDIATE serializes the before/after pair across invocations.
  const path = join(stateDir, 'dream-memory.sqlite');
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || realpathSync(path) === realpathSync(archive)) {
    throw new Error('Unsafe dream memory destination');
  }
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    const { application_id: app } = db.prepare('PRAGMA application_id').get();
    if (!app && !db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
      db.exec(`PRAGMA application_id = 0x44464d31;
        CREATE TABLE observations(id TEXT PRIMARY KEY, kind TEXT NOT NULL, at TEXT NOT NULL, quote TEXT NOT NULL)`);
    } else if (app !== 0x44464d31) throw new Error('Not a dream memory database');
    const read = () => db.prepare('SELECT id, kind, at, quote FROM observations ORDER BY at, id').all();
    const put = db.prepare('INSERT INTO observations VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING');
    const previous = read(), before = runExam(previous);
    const saved = new Map(previous.map(s => [s.id, s]));
    for (const { id, kind, at, quote } of verified.values()) {
      if (saved.has(id) && saved.get(id).quote !== quote) throw new Error('Previously learned source quote changed');
      put.run(id, kind, at, quote);
    }
    const staged = read(), after = runExam(staged);
    const rolledBack = after.score < before.score;
    const contradictions = after.failures.filter(f => !before.failures.some(old => old.cue === f.cue));
    const memory = rolledBack ? previous : staged;
    const tasteCandidates = distillTaste(memory);
    db.exec(rolledBack ? 'ROLLBACK' : 'COMMIT');
    return { window: { sinceExclusive: new Date(end - DAY).toISOString(), untilInclusive: new Date(end).toISOString() },
      collected, rejected, learned: rolledBack ? [] : [...verified.values()], exam: { before, after },
      rolledBack, contradictions, memorySize: memory.length, tasteCandidates };
  } finally { db.close(); } // SQLite also rolls back an interrupted transaction.
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const str = { type: 'string' };
    const { values: v } = parseArgs({ options: { archive: str, 'state-dir': str, 'board-tasks': str, 'board-url': str,
      channel: str, now: str, candidates: str, 'owner-session': { ...str, multiple: true }, help: { type: 'boolean' } } });
    if (v.help) console.log(usage);
    else {
      if (!v.archive || !v['state-dir'] || !!v['board-tasks'] === !!v['board-url'] || (v['board-url'] && !v.channel)) throw new Error(usage);
      const page = v['board-url'] ? await loadBoardTasksFromApi(v['board-url'], { channel: v.channel, token: process.env.DF_BOARD_READ_TOKEN }) : readJson(v['board-tasks']);
      console.log(JSON.stringify(dream({ archive: v.archive, stateDir: v['state-dir'], ownerSessions: v['owner-session'],
        boardTasks: page?.tasks ?? page, candidates: v.candidates === undefined ? undefined : readJson(v.candidates), now: v.now })));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
