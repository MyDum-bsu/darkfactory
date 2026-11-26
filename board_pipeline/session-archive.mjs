// Session Archive (Board #7922, WAVE2-3): локальный архив всех агентских
// сессий на узле в SQLite (node:sqlite DatabaseSync, без новых npm-зависимостей).
// FTS5 BM25 полнотекстовый поиск суб-10ms + метаданные (host/project/harness/
// диапазон дат) + подключаемое векторное хранилище с гибридным поиском
// Reciprocal Rank Fusion: облачный embedder (gemini-embedding-001 и др.)
// инъецируется снаружи, локального ML и расхода RAM нет. Модуль не знает
// путей и не ходит в сеть — входы приходят только из доверенного вызывающего.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const SESSION_ARCHIVE_SCHEMA_VERSION = 1;
export const DEFAULT_EMBED_MODEL = 'gemini-embedding-001';
export const DEFAULT_SEARCH_LIMIT = 20;
export const DEFAULT_EMBED_BATCH = 32;
const RRF_K = 60;
const SEARCH_MODES = Object.freeze(['auto', 'fts', 'hybrid']);
const ROLE_ALIAS = new Map([
  ['human', 'user'],
  ['ai', 'assistant'],
  ['bot', 'assistant'],
  ['model', 'assistant'],
  ['agent', 'assistant'],
  ['tool_result', 'tool'],
  ['function', 'tool'],
]);
const ROLE_SET = new Set(['user', 'assistant', 'system', 'tool']);
const WORD = /[\p{L}\p{N}_]+/gu;
const MAX_QUERY_TOKENS = 32;
const MAX_VECTOR_DIMS = 4096;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function fail(code, detail) {
  const error = new Error(detail === undefined ? code : `${code}: ${detail}`);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Нормализация временной метки в ISO-строку для лексикографически корректных
// сравнений диапазонов: число трактуется как epoch milliseconds, строка
// сохраняется как есть (ISO-8601 уже сортируется лексикографически).
export function normalizeTimestamp(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function normalizeRole(value) {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  if (!lower) return null;
  const alias = ROLE_ALIAS.get(lower) ?? lower;
  return ROLE_SET.has(alias) ? alias : null;
}

// Извлечение текста из строкового или блочного (Claude/OpenAI-стиль) content.
function extractText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const parts = [];
  for (const block of value) {
    if (typeof block === 'string') parts.push(block);
    else if (isRecord(block)) {
      const text = block.text ?? block.content;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

function pickFirst(record, keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

// Толерантный разбор одной jsonl-строки транскрипта агентского harness'а в
// нормализованную запись. Источники полей различаются между agy и pi, поэтому
// перебираются известные обёртки (message/event/payload) и синонимы полей.
function parseTranscriptLine(line, seq, wrappers) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(row)) return null;
  const candidates = [row];
  for (const key of wrappers) {
    if (isRecord(row[key])) candidates.push(row[key]);
  }
  let role = null;
  let content = null;
  let createdAt = null;
  for (const layer of candidates) {
    if (role === null) {
      role = normalizeRole(pickFirst(layer, ['role', 'speaker', 'author']));
    }
    if (role === null) {
      // Некоторые транскрипты кодируют роль в типе события: user_message и т.п.
      const type = pickFirst(layer, ['type', 'event', 'kind']);
      if (typeof type === 'string') {
        const head = type.trim().toLowerCase().split(/[_\-.]/, 1)[0];
        role = normalizeRole(head);
      }
    }
    if (content === null) {
      content = extractText(pickFirst(layer, ['content', 'text', 'body', 'message']));
    }
    if (createdAt === null) {
      createdAt = normalizeTimestamp(pickFirst(layer,
        ['createdAt', 'created_at', 'timestamp', 'time', 'ts', 'date']));
    }
  }
  if (role === null) return null;
  if (typeof content !== 'string' || !content.trim()) return null;
  return { seq, role, content, createdAt };
}

const AGY_WRAPPERS = Object.freeze(['message', 'event', 'payload', 'data']);
const PI_WRAPPERS = Object.freeze(['message', 'payload', 'entry', 'data']);

// Чистые помощники разбора транскриптов: fail-open на пустых и битых строках,
// seq — индекс строки в файле (0-based), что стабильно при инкрементальной
// дозаписи транскрипта: хвостовые строки получают новые seq без сдвига старых.
export function parseAgyTranscript(jsonlText) {
  if (typeof jsonlText !== 'string') throw fail('session_archive_transcript_invalid');
  const out = [];
  jsonlText.split('\n').forEach((line, seq) => {
    if (!line.trim()) return;
    const parsed = parseTranscriptLine(line, seq, AGY_WRAPPERS);
    if (parsed !== null) out.push(parsed);
  });
  return out;
}

export function parsePiTranscript(jsonlText) {
  if (typeof jsonlText !== 'string') throw fail('session_archive_transcript_invalid');
  const out = [];
  jsonlText.split('\n').forEach((line, seq) => {
    if (!line.trim()) return;
    const parsed = parseTranscriptLine(line, seq, PI_WRAPPERS);
    if (parsed !== null) out.push(parsed);
  });
  return out;
}

// Санитизация FTS5-запроса: из произвольного пользовательского ввода
// (кавычки, дефисы, двоеточия, кириллица) извлекаются словоформы Unicode и
// каждая экранируется двойными кавычками — синтаксическая ошибка MATCH
// исключена конструктивно. Токены соединяются OR для полноты выдачи, а BM25
// ранжирует документы с большим числом совпадений выше.
export function sanitizeFtsQuery(query) {
  if (typeof query !== 'string') return '';
  const tokens = [];
  for (const match of query.matchAll(WORD)) {
    tokens.push(match[0]);
    if (tokens.length >= MAX_QUERY_TOKENS) break;
  }
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}

function cosineSimilarity(a, b) {
  // Векторы в хранилище нормализованы при записи, поэтому скалярное
  // произведение равно косинусной близости; запрос нормализуется здесь.
  let dot = 0;
  let norm = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    norm += a[i] * a[i];
  }
  if (norm === 0) return 0;
  return dot / Math.sqrt(norm);
}

function normalizeVector(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) throw fail('session_archive_vector_zero');
  const scale = Math.sqrt(norm);
  return vector.map(value => value / scale);
}

function validateVector(vector, dims = null) {
  if (!Array.isArray(vector) || vector.length === 0 || vector.length > MAX_VECTOR_DIMS ||
      !vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw fail('session_archive_vector_invalid');
  }
  if (dims !== null && vector.length !== dims) throw fail('session_archive_vector_dims');
  return vector;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  harness TEXT NOT NULL,
  project TEXT,
  cwd TEXT,
  title TEXT,
  started_at TEXT,
  updated_at TEXT,
  summary TEXT,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT,
  content_sha256 TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  role UNINDEXED,
  content=messages,
  content_rowid=id
);
CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content, session_id, role)
    VALUES (new.id, new.content, new.session_id, new.role);
END;
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id);
`;

function validateMessage(entry, index) {
  if (!isRecord(entry) || !Number.isSafeInteger(entry.seq) || entry.seq < 0 ||
      typeof entry.role !== 'string' || !entry.role.trim() ||
      typeof entry.content !== 'string' || !entry.content.trim()) {
    throw fail('session_archive_message_invalid', `index ${index}`);
  }
  return {
    seq: entry.seq,
    role: entry.role.trim().toLowerCase(),
    content: entry.content,
    createdAt: normalizeTimestamp(entry.createdAt),
  };
}

export function openSessionArchive(dbPath, { embedder = null } = {}) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw fail('session_archive_path_invalid');
  }
  if (embedder !== null && typeof embedder !== 'function') {
    throw fail('session_archive_embedder_invalid');
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const upsertSession = db.prepare(`
    INSERT INTO sessions (session_id, host, harness, project, cwd, title, started_at, updated_at, summary, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(session_id) DO UPDATE SET
      host = excluded.host,
      harness = excluded.harness,
      project = excluded.project,
      cwd = excluded.cwd,
      title = excluded.title,
      started_at = COALESCE(excluded.started_at, sessions.started_at),
      updated_at = COALESCE(excluded.updated_at, sessions.updated_at),
      summary = COALESCE(excluded.summary, sessions.summary)
  `);
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages (session_id, seq, role, content, created_at, content_sha256)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const countMessages = db.prepare('SELECT count(*) AS n FROM messages WHERE session_id = ?');
  const updateCount = db.prepare('UPDATE sessions SET message_count = ? WHERE session_id = ?');
  const pendingEmbeddings = db.prepare(`
    SELECT m.id, m.content FROM messages m
    LEFT JOIN message_embeddings e ON e.message_id = m.id
    WHERE e.message_id IS NULL
    ORDER BY m.id ASC
    LIMIT ?
  `);
  const insertEmbedding = db.prepare(`
    INSERT OR REPLACE INTO message_embeddings (message_id, model, dims, vector_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const ingestSession = input => {
    if (!isRecord(input) || typeof input.sessionId !== 'string' || !input.sessionId.trim() ||
        typeof input.host !== 'string' || !input.host.trim() ||
        typeof input.harness !== 'string' || !input.harness.trim() ||
        (input.messages !== undefined && !Array.isArray(input.messages))) {
      throw fail('session_archive_ingest_invalid');
    }
    const sessionId = input.sessionId.trim();
    const messages = (input.messages ?? []).map(validateMessage);
    db.exec('BEGIN');
    try {
      upsertSession.run(
        sessionId,
        input.host.trim(),
        input.harness.trim(),
        typeof input.project === 'string' ? input.project : null,
        typeof input.cwd === 'string' ? input.cwd : null,
        typeof input.title === 'string' ? input.title : null,
        normalizeTimestamp(input.startedAt),
        normalizeTimestamp(input.updatedAt),
        typeof input.summary === 'string' ? input.summary : null,
      );
      // Идемпотентный инкремент: INSERT OR IGNORE по UNIQUE(session_id, seq)
      // вставляет только новые сообщения, повторный прогон не плодит дублей.
      let inserted = 0;
      for (const message of messages) {
        const result = insertMessage.run(sessionId, message.seq, message.role,
          message.content, message.createdAt, sha256(message.content));
        inserted += Number(result.changes);
      }
      const total = Number(countMessages.get(sessionId).n);
      updateCount.run(total, sessionId);
      db.exec('COMMIT');
      return Object.freeze({ sessionId, insertedMessages: inserted, messageCount: total });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const metadataFilters = ({ host, project, harness, since, until }) => {
    const where = [];
    const params = [];
    const push = (column, value) => {
      if (typeof value !== 'string' || !value.trim()) {
        throw fail('session_archive_search_invalid', 'host/project/harness must be non-empty strings');
      }
      where.push(`${column} = ?`);
      params.push(value);
    };
    if (host !== undefined) push('s.host', host);
    if (project !== undefined) push('s.project', project);
    if (harness !== undefined) push('s.harness', harness);
    for (const [column, value] of [['m.created_at >=', since], ['m.created_at <=', until]]) {
      if (value === undefined) continue;
      const iso = normalizeTimestamp(value);
      if (iso === null) throw fail('session_archive_search_invalid', 'since/until must be ISO strings or epoch ms');
      where.push(`${column} ?`);
      params.push(iso);
    }
    return { clause: where.length ? ` AND ${where.join(' AND ')}` : '', params };
  };

  const ftsLeg = (matchQuery, filters, poolSize) => {
    const sql = `
      SELECT m.id AS message_id, m.session_id, m.seq, m.role, m.created_at,
             s.host, s.harness, s.project,
             snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet,
             bm25(messages_fts) AS bm25
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN sessions s ON s.session_id = m.session_id
      WHERE messages_fts MATCH ?${filters.clause}
      ORDER BY bm25 ASC, m.id ASC
      LIMIT ?
    `;
    return db.prepare(sql).all(matchQuery, ...filters.params, poolSize);
  };

  const vectorRows = (filters, dims) => {
    const sql = `
      SELECT m.id AS message_id, m.session_id, m.seq, m.role, m.created_at,
             substr(m.content, 1, 160) AS snippet,
             s.host, s.harness, s.project,
             e.vector_json
      FROM message_embeddings e
      JOIN messages m ON m.id = e.message_id
      JOIN sessions s ON s.session_id = m.session_id
      WHERE e.dims = ?${filters.clause}
    `;
    return db.prepare(sql).all(dims, ...filters.params);
  };

  const resolveQueryVector = async ({ query, queryVector }) => {
    if (queryVector !== undefined && queryVector !== null) {
      return validateVector(queryVector);
    }
    if (embedder === null) return null;
    const vectors = await embedder([query]);
    if (!Array.isArray(vectors) || vectors.length !== 1) {
      throw fail('session_archive_embedder_invalid');
    }
    return validateVector(vectors[0]);
  };

  const hasEmbeddings = () =>
    Number(db.prepare('SELECT count(*) AS n FROM message_embeddings').get().n) > 0;

  const search = async (input = {}) => {
    if (!isRecord(input)) throw fail('session_archive_search_invalid');
    const {
      query = '',
      limit = DEFAULT_SEARCH_LIMIT,
      mode = 'auto',
      queryVector = null,
    } = input;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
        !SEARCH_MODES.includes(mode) || typeof query !== 'string') {
      throw fail('session_archive_search_invalid');
    }
    const filters = metadataFilters(input);
    const poolSize = Math.max(limit * 4, 40);
    const matchQuery = sanitizeFtsQuery(query);

    // Вектор запроса вычисляется только когда он действительно нужен: чистый
    // fts-режим не трогает облачный embedder, auto — лишь при наличии
    // сохранённых embedding'ов, hybrid — fail-closed без источника вектора.
    const wantVector = mode === 'hybrid' || (mode === 'auto' && hasEmbeddings());
    const vector = wantVector ? await resolveQueryVector({ query, queryVector }) : null;
    const embeddingsAvailable = vector !== null && hasEmbeddings();
    const effective = mode === 'auto'
      ? (embeddingsAvailable ? 'hybrid' : 'fts')
      : mode;
    if (effective === 'hybrid' && vector === null) {
      throw fail('session_archive_embedder_missing', 'hybrid mode needs embedder or queryVector');
    }

    // FTS-плечо: позиционный ранг по BM25.
    const ftsRows = matchQuery ? ftsLeg(matchQuery, filters, poolSize) : [];
    const ftsRank = new Map(ftsRows.map((row, index) => [row.message_id, { rank: index + 1, row }]));

    // Векторное плечо: косинусная близость к нормализованным embedding'ам
    // той же размерности, что и вектор запроса.
    let vectorRank = new Map();
    if (effective === 'hybrid' && vector !== null) {
      const scored = [];
      for (const row of vectorRows(filters, vector.length)) {
        let stored;
        try {
          stored = JSON.parse(row.vector_json);
        } catch {
          continue;
        }
        if (!Array.isArray(stored) || stored.length !== vector.length) continue;
        scored.push({ row, similarity: cosineSimilarity(vector, stored) });
      }
      scored.sort((a, b) => b.similarity - a.similarity || a.row.message_id - b.row.message_id);
      vectorRank = new Map(scored.slice(0, poolSize)
        .map((entry, index) => [entry.row.message_id, { rank: index + 1, row: entry.row, similarity: entry.similarity }]));
    }

    if (effective === 'fts') {
      return Object.freeze(ftsRows.slice(0, limit).map((row, index) => Object.freeze({
        sessionId: row.session_id,
        host: row.host,
        harness: row.harness,
        project: row.project,
        role: row.role,
        seq: row.seq,
        createdAt: row.created_at,
        snippet: row.snippet,
        // bm25 в SQLite отрицателен (лучше = меньше); знак инвертирован,
        // чтобы больший score всегда означал лучшее совпадение.
        score: Math.round(-row.bm25 * 1e6) / 1e6,
        matchSource: 'fts',
        rank: index + 1,
      })));
    }

    // Reciprocal Rank Fusion: score = Σ 1/(k + rank) по обоим плечам,
    // детерминированное разрешение ничьих по лучшему рангу и id сообщения.
    const fused = new Map();
    const blend = (id, rank, row, source) => {
      const entry = fused.get(id) ?? { score: 0, bestRank: Infinity, row: null, sources: new Set() };
      entry.score += 1 / (RRF_K + rank);
      entry.bestRank = Math.min(entry.bestRank, rank);
      entry.sources.add(source);
      // Строка fts-плеча предпочтительнее независимо от порядка обхода:
      // у неё точный snippet с подсветкой совпадений.
      entry.row = source === 'fts' ? row : (entry.row ?? row);
      fused.set(id, entry);
    };
    for (const [id, { rank, row }] of ftsRank) blend(id, rank, row, 'fts');
    for (const [id, { rank, row }] of vectorRank) blend(id, rank, row, 'vector');
    const ordered = [...fused.entries()].sort((a, b) =>
      b[1].score - a[1].score || a[1].bestRank - b[1].bestRank || a[0] - b[0]);
    return Object.freeze(ordered.slice(0, limit).map(([id, entry], index) => {
      const row = entry.row;
      const hasFts = entry.sources.has('fts');
      const hasVec = entry.sources.has('vector');
      return Object.freeze({
        sessionId: row.session_id,
        host: row.host,
        harness: row.harness,
        project: row.project,
        role: row.role,
        seq: row.seq,
        createdAt: row.created_at,
        snippet: typeof row.snippet === 'string' ? row.snippet : '',
        score: Math.round(entry.score * 1e9) / 1e9,
        matchSource: hasFts && hasVec ? 'both' : (hasFts ? 'fts' : 'vector'),
        rank: index + 1,
      });
    }));
  };

  const embedPending = async ({ batchSize = DEFAULT_EMBED_BATCH, model = DEFAULT_EMBED_MODEL } = {}) => {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 ||
        typeof model !== 'string' || !model.trim()) {
      throw fail('session_archive_embed_invalid');
    }
    if (embedder === null) throw fail('session_archive_embedder_missing');
    const rows = pendingEmbeddings.all(batchSize);
    if (!rows.length) return Object.freeze({ embedded: 0, remaining: 0, model });
    const vectors = await embedder(rows.map(row => row.content));
    if (!Array.isArray(vectors) || vectors.length !== rows.length) {
      throw fail('session_archive_embedder_invalid', 'vector count mismatch');
    }
    const dims = validateVector(vectors[0]).length;
    const at = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (let i = 0; i < rows.length; i += 1) {
        const vector = normalizeVector(validateVector(vectors[i], dims));
        insertEmbedding.run(rows[i].id, model.trim(), dims, JSON.stringify(vector), at);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const remaining = Number(db.prepare(`
      SELECT count(*) AS n FROM messages m
      LEFT JOIN message_embeddings e ON e.message_id = m.id
      WHERE e.message_id IS NULL
    `).get().n);
    return Object.freeze({ embedded: rows.length, remaining, model: model.trim() });
  };

  const stats = () => {
    const scalar = sql => Number(db.prepare(sql).get().n);
    return Object.freeze({
      sessions: scalar('SELECT count(*) AS n FROM sessions'),
      messages: scalar('SELECT count(*) AS n FROM messages'),
      embeddings: scalar('SELECT count(*) AS n FROM message_embeddings'),
      hosts: scalar('SELECT count(DISTINCT host) AS n FROM sessions'),
      projects: scalar('SELECT count(DISTINCT project) AS n FROM sessions'),
      harnesses: scalar('SELECT count(DISTINCT harness) AS n FROM sessions'),
      schemaVersion: SESSION_ARCHIVE_SCHEMA_VERSION,
    });
  };

  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      db.close();
    }
  };

  return Object.freeze({
    ingestSession,
    parseAgyTranscript,
    parsePiTranscript,
    search,
    embedPending,
    stats,
    close,
  });
}
