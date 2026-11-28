// Session Archive (Board #7922, WAVE2-3): локальный архив всех агентских
// сессий на узле в SQLite (node:sqlite DatabaseSync, без новых npm-зависимостей).
// FTS5 BM25 полнотекстовый поиск суб-10ms + метаданные (host/project/harness/
// диапазон дат) + подключаемое векторное хранилище с гибридным поиском
// Reciprocal Rank Fusion: облачный embedder (gemini-embedding-001 и др.)
// инъецируется снаружи; без явной настройки облачного адаптера сеть не нужна.

import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { posix } from 'node:path';
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

const REPOS = new Set(['darkfactory', 'music-restoration', 'optimization', 'autoresearcher',
  'moml-course', 'bsu-cabinet-skill']);

export function inferSessionProject({ cwd, title, fallback } = {}) {
  const hasCwd = typeof cwd === 'string' && cwd.trim() !== '';
  if (hasCwd) {
    const segments = posix.normalize(cwd.replaceAll('\\', '/')).toLowerCase().split('/');
    for (const name of segments.reverse()) {
      if (name === 'darkfactory-hub') return 'cto';
      if (REPOS.has(name)) return name;
      if (/^df-.+/.test(name)) return 'darkfactory';
      if (/^mr-.+/.test(name)) return 'music-restoration';
    }
  }
  if (typeof title === 'string' && /\b(cto|darkfactory-hub|fleet[- ]wide)\b/i.test(title)) return 'cto';
  // A reported cwd outside the fleet isn't the scanner's default project.
  return !hasCwd && typeof fallback === 'string' && fallback.trim() ? fallback.trim() : 'general';
}

// The CLI and terminal hook share the same retrieval model, authentication and
// request shape. gemini-embedding-001 on Vertex accepts one instance per call;
// return vectors in input order so the SQLite batch commits all or nothing.
export function configuredArchiveEmbedder(model, taskType, env = process.env, { vertexOnly = false } = {}) {
  const { GEMINI_API_KEY: key, DF_VERTEX_PROJECT: project, DF_VERTEX_LOCATION: location,
    DF_VERTEX_ACCESS_TOKEN: token } = env;
  const post = async (url, auth, body) => {
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`df_archive_embedder_http: HTTP ${response.status}`);
    return response.json();
  };
  if (!vertexOnly && key?.trim()) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`;
    return async texts => {
      const vectors = [];
      for (let i = 0; i < texts.length; i += 100) {
        const requests = texts.slice(i, i + 100).map(text => ({
          model: `models/${model}`, content: { parts: [{ text }] }, taskType,
        }));
        const { embeddings } = await post(url, { 'x-goog-api-key': key }, { requests });
        if (!Array.isArray(embeddings) || embeddings.length !== requests.length) {
          throw new Error('df_archive_embedder_invalid_response');
        }
        vectors.push(...embeddings.map(embedding => embedding.values));
      }
      return vectors;
    };
  }
  if (!project?.trim() || !location?.trim() || !token?.trim()) return null;
  if (!/^[a-z0-9-]+$/.test(location)) throw new Error('df_archive_vertex_location_invalid');
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:predict`;
  return async texts => {
    const vectors = [];
    for (const content of texts) {
      const { predictions } = await post(url, { authorization: `Bearer ${token}` }, {
        instances: [{ content, task_type: taskType }],
      });
      if (!Array.isArray(predictions) || predictions.length !== 1) throw new Error('df_archive_embedder_invalid_response');
      vectors.push(predictions[0].embeddings.values);
    }
    return vectors;
  };
}

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

// Эвристика epoch-времени: валидные epoch milliseconds современных дат
// всегда >= 1e12 (2001-09-09), поэтому меньшие числа — epoch seconds.
const EPOCH_SECONDS_CEILING = 1e12;
const NUMERIC_STRING = /^\d+(\.\d+)?$/;

function epochToIso(numeric) {
  const ms = numeric < EPOCH_SECONDS_CEILING ? numeric * 1000 : numeric;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Нормализация временной метки в каноническую UTC ISO-8601 форму
// new Date(...).toISOString() для лексикографически корректных сравнений
// диапазонов since/until в SQL: смешанные формы («Z» без миллисекунд,
// смещения часовых поясов, epoch) иначе сортируются неправильно. Числа и
// числовые строки трактуются как epoch: < 1e12 — секунды, иначе
// миллисекунды. Невалидная непустая строка сохраняется как есть (fail-open
// для мусорных транскриптов), пустой/неподходящий ввод — null.
export function normalizeTimestamp(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return epochToIso(value);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (NUMERIC_STRING.test(trimmed)) return epochToIso(Number(trimmed));
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
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

function jsonRecord(text) {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch { return null; }
}

function* transcriptRows(rawText) {
  if (typeof rawText !== 'string') return;
  for (const [seq, line] of rawText.split('\n').entries()) {
    const row = jsonRecord(line);
    if (row) yield [seq, row];
  }
}

function messageRecord(seq, role, rawContent, timestamp) {
  const content = extractText(rawContent);
  return role && content?.trim() ? { seq, role, content, createdAt: normalizeTimestamp(timestamp) } : null;
}

export function parseCodexTranscript(jsonlText, { includeSystem = false } = {}) {
  const messages = [];
  // Rollouts may emit the same turn in both formats. Pair each mirror once,
  // keeping the earliest physical seq stable even across incremental imports.
  const unpaired = new Map();
  for (const [seq, { type, payload, timestamp }] of transcriptRows(jsonlText)) {
    if (!isRecord(payload)) continue;
    let role, content;
    if (type === 'response_item' && payload.type === 'message') {
      if (payload.role === 'developer' && includeSystem === true) role = 'system';
      else if (payload.role === 'user' || payload.role === 'assistant') role = payload.role;
      else continue;
      content = payload.content;
    } else if (type === 'event_msg' && ['user_message', 'agent_message'].includes(payload.type)) {
      role = payload.type === 'user_message' ? 'user' : 'assistant';
      content = payload.message;
    } else continue;
    const message = messageRecord(seq, role, content, timestamp);
    if (!message) continue;
    const key = `${role}\0${message.content}`;
    const delta = type === 'event_msg' ? -1 : 1;
    const previous = unpaired.get(key) ?? 0;
    if (previous * delta >= 0) messages.push(message);
    if (previous + delta === 0) unpaired.delete(key);
    else unpaired.set(key, previous + delta);
  }
  return messages;
}

export function parseOmpTranscript(jsonlText) {
  const messages = [];
  for (const [seq, row] of transcriptRows(jsonlText)) {
    if (row.type !== 'message' || !isRecord(row.message)) continue;
    const { role, content, timestamp } = row.message;
    const entry = messageRecord(seq, normalizeRole(role), content, timestamp ?? row.timestamp);
    if (entry) messages.push(entry);
  }
  return messages;
}

export function parseClaudeTranscript(jsonlText) {
  const messages = [];
  for (const [seq, row] of transcriptRows(jsonlText)) {
    if (!['user', 'assistant'].includes(row.type)) continue;
    const role = row.message?.role ?? row.type;
    if (!['user', 'assistant'].includes(role)) continue;
    const entry = messageRecord(seq, role, row.message?.content, row.timestamp);
    if (entry) messages.push(entry);
  }
  return messages;
}

function devinRole(source, includeSystem) {
  const role = typeof source === 'string' && source.toLowerCase() === 'devin' ? 'assistant' : normalizeRole(source);
  return role === 'system' && includeSystem !== true ? null : role;
}

export function parseDevinTranscript(rawText, { includeSystem = false } = {}) {
  const steps = jsonRecord(rawText)?.steps;
  const messages = [];
  for (const [seq, step] of Array.isArray(steps) ? steps.entries() : transcriptRows(rawText)) {
    if (!isRecord(step)) continue;
    const eventRole = typeof step.type === 'string' ? step.type.split('_', 1)[0] : null;
    const role = devinRole(step.source ?? step.message?.role ?? step.role ?? eventRole, includeSystem);
    const entry = messageRecord(seq, role, step.message?.content ?? step.message?.text ?? step.message ?? step.content ?? step.text,
      step.timestamp ?? step.message?.timestamp);
    if (entry) messages.push(entry);
  }
  return messages;
}

export function extractTranscriptMeta(harness, rawText) {
  const meta = {};
  function take(row, id) {
    for (const [key, value] of [['sessionId', id], ['cwd', row.cwd], ['title', row.title]]) {
      if (!meta[key] && typeof value === 'string' && value.trim()) meta[key] = value.trim();
    }
  }
  if (typeof rawText !== 'string') return meta;
  if (harness === 'devin') {
    const session = jsonRecord(rawText);
    if (session) take(session, session.session_id);
    return meta;
  }
  if (harness === 'pi' || harness === 'agy') {
    const header = jsonRecord(rawText.trimStart().split('\n', 1)[0]);
    if (header) take(header, header.sessionId ?? header.session_id ?? (!header.message && !header.role ? header.id : null));
    return meta;
  }
  for (const [, row] of transcriptRows(rawText)) {
    if (harness === 'codex' && row.type === 'session_meta' && isRecord(row.payload)) {
      take(row.payload, row.payload.id);
      break;
    }
    if (harness === 'omp' && row.type === 'session') take(row, row.id);
    if (harness === 'omp' && row.type === 'title') take({ title: row.title });
    if (harness === 'claude') take(row, row.sessionId);
    if (meta.sessionId && meta.cwd && meta.title) break;
  }
  return meta;
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
  // Нулевой вектор не имеет направления: косинусная близость не определена,
  // поэтому он отклоняется fail-closed и у запроса, и у embedder'а.
  if (vector.every(value => value === 0)) throw fail('session_archive_vector_zero');
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

// Each reader exposes only session metadata to the outer cursor. Materialize
// at most one transcript (ingestSession's transaction boundary) at a time.
function devinReader(db, includeSystem) {
  const nodes = db.prepare(`SELECT chat_message, created_at FROM message_nodes
    WHERE session_id = ? ORDER BY row_id`);
  return {
    sessions: `SELECT id, working_directory AS cwd, title, created_at AS startedAt,
      last_activity_at AS updatedAt FROM sessions`,
    readMessages(id) {
      const messages = [];
      let seq = 0;
      for (const row of nodes.iterate(id)) {
        const data = jsonRecord(row.chat_message);
        // Count skipped nodes too: opting in to system messages on a later
        // import must not shift the keys of already-archived turns.
        const entry = messageRecord(seq++, devinRole(data?.role, includeSystem), data?.content, row.created_at);
        if (entry) messages.push(entry);
      }
      return messages;
    },
  };
}

function opencodeReader(db) {
  // Interpolate only known identifiers, never column names supplied by a DB.
  const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  const s = columns('session'), m = columns('message'), p = columns('part');
  const optional = (cols, key, prefix = '') => cols.has(key) ? prefix + key : 'NULL';
  const order = (cols, prefix) => ['sequence', 'time_created', cols.has('id') ? 'id' : 'rowid']
    .filter(key => key === 'rowid' || cols.has(key)).map(key => `${prefix}.${key}`).join(', ');
  const rows = db.prepare(`SELECT m.id, m.data AS message, ${optional(m, 'time_created', 'm.')} AS created,
    p.data AS part FROM message m LEFT JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? ORDER BY ${order(m, 'm')}, ${order(p, 'p')}`);
  return {
    sessions: `SELECT id, COALESCE(${optional(s, 'directory')}, ${optional(s, 'path')}) AS cwd,
      ${optional(s, 'title')} AS title, ${optional(s, 'time_created')} AS startedAt,
      ${optional(s, 'time_updated')} AS updatedAt FROM session ${s.has('time_deleted') ? 'WHERE time_deleted IS NULL' : ''}`,
    readMessages(sessionId) {
      const messages = [];
      let previous, role, createdAt, parts = [], seq = -1;
      function finishMessage() {
        if (role && parts.length) messages.push({ seq, role, content: parts.join('\n'), createdAt });
      }
      for (const row of rows.iterate(sessionId)) {
        if (row.id !== previous) {
          finishMessage();
          previous = row.id;
          seq++;
          const data = jsonRecord(row.message);
          role = normalizeRole(data?.role);
          createdAt = normalizeTimestamp(row.created ?? data?.time?.created);
          parts = [];
        }
        const part = jsonRecord(row.part);
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) parts.push(part.text);
      }
      finishMessage();
      return messages;
    },
  };
}

function importSqlite({ archive, sourceDbPath, host, harness, fallbackProject, since, limit, includeSystem }, reader) {
  if (typeof host !== 'string' || !host.trim()) throw fail('session_archive_import_host_invalid');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw fail('session_archive_import_limit_invalid');
  if (since !== undefined && (typeof since !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/i.test(since) ||
      !Number.isFinite(Date.parse(since)))) throw fail('session_archive_import_since_invalid');
  const report = { harness, sourceDbPath, scannedSessions: 0, ingestedSessions: 0, skippedEmpty: 0,
    insertedMessages: 0, totalMessages: 0 };
  const db = new DatabaseSync(sourceDbPath, { readOnly: true });
  try {
    const { sessions, readMessages } = reader(db, includeSystem);
    // Devin may store ISO strings or epoch seconds; OpenCode uses epoch ms.
    db.function('archive_time', { deterministic: true }, value => Date.parse(normalizeTimestamp(value)));
    const activity = 'archive_time(COALESCE(updatedAt, startedAt))';
    const order = limit === undefined ? 'id' : `${activity} DESC, id`;
    const stmt = db.prepare(`SELECT * FROM (${sessions}) ${since === undefined ? '' : `WHERE ${activity} >= ?`}
      ORDER BY ${order} LIMIT ?`);
    const params = since === undefined ? [] : [Date.parse(since)];
    for (const row of stmt.iterate(...params, limit ?? -1)) {
      report.scannedSessions++;
      const messages = readMessages(row.id);
      if (!messages.length) { report.skippedEmpty++; continue; }
      const { cwd, title, startedAt, updatedAt } = row;
      const project = inferSessionProject({ cwd, title, fallback: fallbackProject });
      const result = archive.ingestSession({ sessionId: `${harness}:${row.id}`, host, harness, cwd, title,
        project, startedAt, updatedAt, messages });
      report.ingestedSessions++;
      report.insertedMessages += result.insertedMessages;
      report.totalMessages += result.messageCount;
    }
    return report;
  } finally { db.close(); }
}

export function importDevinSqlite({ harness = 'devin', ...options }) {
  if (harness !== 'devin') throw fail('session_archive_import_harness_invalid');
  return importSqlite({ ...options, harness }, devinReader);
}

export function importOpencodeSqlite({ harness = 'opencode', ...options }) {
  if (!['opencode', 'zcode'].includes(harness)) throw fail('session_archive_import_harness_invalid');
  return importSqlite({ ...options, harness }, opencodeReader);
}

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

// Index only the completed attempt, never a host-wide transcript directory.
// Fixed seqs make replay after a controller restart harmless. The worker tail
// is optional (e.g. after restart); the durable spec and outcome are not.
export async function indexTerminalAttempt({ dbPath, result, record, cwd, host, harness, brief,
  tail, fallback, embedder = null }) {
  if (!['done', 'hold'].includes(result?.phase) || !result.attemptId ||
      record?.attemptId !== result.attemptId || record.phase !== result.phase) return null;
  const sessionId = `attempt:${record.attemptId}`;
  const title = `Task ${record.taskId ?? ''} attempt ${record.attemptId}`;
  const summary = [title, result.phase, result.sha, result.reason].filter(Boolean).join(' ');
  const messages = [
    { seq: 0, role: 'user', content: record.contract?.specText ?? brief },
    { seq: 1, role: 'assistant', content: tail },
    { seq: result.phase === 'hold' ? 2 : 3, role: 'system', content: summary },
  ].filter(message => typeof message.content === 'string' && message.content.trim());
  const inferred = inferSessionProject({ cwd, title });
  // The controller can attest the repo even for a generically named slot.
  const project = inferred === 'general' ? record.contract?.repo_id ?? fallback ?? inferred : inferred;
  const archive = openSessionArchive(dbPath, { embedder });
  try {
    const ingestion = archive.ingestSession({ sessionId, cwd, host, title, summary, harness, project, messages });
    if (embedder) await archive.embedPending({ sessionId });
    return ingestion;
  } finally { archive.close(); }
}

export function openSessionArchive(dbPath, { embedder = null } = {}) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw fail('session_archive_path_invalid');
  }
  if (embedder !== null && typeof embedder !== 'function') {
    throw fail('session_archive_embedder_invalid');
  }
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    // Архив содержит транскрипты сессий — права только владельцу. Best effort:
    // на не-POSIX ФС chmod может не поддерживаться, тогда пропускаем.
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // не-POSIX платформа или ФС без chmod — best effort по контракту
    }
  }

  // Set the database mode before WAL/SHM sidecars inherit it.
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const upsertSession = db.prepare(`
    INSERT INTO sessions (session_id, host, harness, project, cwd, title, started_at, updated_at, summary, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(session_id) DO UPDATE SET
      host = excluded.host,
      harness = excluded.harness,
      project = CASE WHEN ? THEN excluded.project ELSE COALESCE(sessions.project, excluded.project) END,
      cwd = COALESCE(excluded.cwd, sessions.cwd),
      title = COALESCE(excluded.title, sessions.title),
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
    WHERE e.message_id IS NULL AND (? IS NULL OR m.session_id = ?)
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
    const inferred = inferSessionProject(input);
    const project = typeof input.project === 'string' && input.project.trim() ? input.project.trim() : inferred;
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertSession.run(
        sessionId,
        input.host.trim(),
        input.harness.trim(),
        project,
        typeof input.cwd === 'string' ? input.cwd : null,
        typeof input.title === 'string' ? input.title : null,
        normalizeTimestamp(input.startedAt),
        normalizeTimestamp(input.updatedAt),
        typeof input.summary === 'string' ? input.summary : null,
        input.project || input.cwd || inferred !== 'general' ? 1 : 0,
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

  // Порядок top-K: близость по убыванию, ничьи детерминированно по message_id.
  const compareScored = (a, b) =>
    b.similarity - a.similarity || a.row.message_id - b.row.message_id;

  // Вставка в ограниченный массив top-K размером не более cap: бинарный поиск
  // позиции, худший элемент выталкивается. Память ограничена cap записями
  // независимо от числа embedding'ов в архиве.
  const insertBounded = (top, entry, cap) => {
    if (top.length >= cap && compareScored(entry, top[top.length - 1]) >= 0) return;
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareScored(entry, top[mid]) < 0) hi = mid;
      else lo = mid + 1;
    }
    top.splice(lo, 0, entry);
    if (top.length > cap) top.pop();
  };

  // Потоковое сканирование embedding'ов через iterate(): в памяти никогда не
  // материализуется полная таблица — только bounded top-K. Парсинг vector_json
  // fail-open (битая строка пропускается), размерность и модель фильтруются.
  const vectorTopK = (filters, vector, poolSize, queryModel) => {
    const clauses = ['e.dims = ?'];
    const params = [vector.length];
    if (queryModel !== null) {
      clauses.push('e.model = ?');
      params.push(queryModel);
    }
    const sql = `
      SELECT m.id AS message_id, m.session_id, m.seq, m.role, m.created_at,
             substr(m.content, 1, 160) AS snippet,
             s.host, s.harness, s.project,
             e.vector_json
      FROM message_embeddings e
      JOIN messages m ON m.id = e.message_id
      JOIN sessions s ON s.session_id = m.session_id
      WHERE ${clauses.join(' AND ')}${filters.clause}
    `;
    const stmt = db.prepare(sql);
    const top = [];
    for (const row of stmt.iterate(...params, ...filters.params)) {
      let stored;
      try {
        stored = JSON.parse(row.vector_json);
      } catch {
        continue;
      }
      if (!Array.isArray(stored) || stored.length !== vector.length) continue;
      insertBounded(top, { row, similarity: cosineSimilarity(vector, stored) }, poolSize);
    }
    return top;
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
      queryModel = null,
    } = input;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
        !SEARCH_MODES.includes(mode) || typeof query !== 'string' ||
        (queryModel !== null && (typeof queryModel !== 'string' || !queryModel.trim()))) {
      throw fail('session_archive_search_invalid');
    }
    const embedModel = queryModel === null ? null : queryModel.trim();
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
    // той же размерности, что и вектор запроса, с потоковым bounded top-K.
    let vectorRank = new Map();
    if (effective === 'hybrid' && vector !== null) {
      const top = vectorTopK(filters, vector, poolSize, embedModel);
      vectorRank = new Map(top
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

  const embedPending = async ({ batchSize = DEFAULT_EMBED_BATCH, model = DEFAULT_EMBED_MODEL, sessionId = null } = {}) => {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 ||
        typeof model !== 'string' || !model.trim()) {
      throw fail('session_archive_embed_invalid');
    }
    if (embedder === null) throw fail('session_archive_embedder_missing');
    const rows = pendingEmbeddings.all(sessionId, sessionId, batchSize);
    if (!rows.length) return Object.freeze({ embedded: 0, remaining: 0, model });
    const vectors = await embedder(rows.map(row => row.content));
    if (!Array.isArray(vectors) || vectors.length !== rows.length) {
      throw fail('session_archive_embedder_invalid', 'vector count mismatch');
    }
    const dims = validateVector(vectors[0]).length;
    const at = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
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
      WHERE e.message_id IS NULL AND (? IS NULL OR m.session_id = ?)
    `).get(sessionId, sessionId).n);
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
