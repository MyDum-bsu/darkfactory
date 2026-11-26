import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  normalizeTimestamp,
  openSessionArchive,
  parseAgyTranscript,
  parsePiTranscript,
  sanitizeFtsQuery,
} from './session-archive.mjs';

// Детерминированный mock-embedder: тематические группы слов отображаются в
// ортогональные размерности, имитируя семантические embedding'и облачной
// модели без сети и локального ML. «Синонимы» без общих слов оказываются
// близкими по косинусной близости.
const SEMANTIC_GROUPS = [
  ['database', 'sql', 'query', 'latency', 'index', 'indexes', 'slow', 'optimized', 'tuning', 'postgres'],
  ['frontend', 'css', 'button', 'render', 'alignment', 'ui', 'layout'],
  ['deploy', 'kubernetes', 'pod', 'cluster', 'rollout', 'release'],
];

function mockEmbedder(texts) {
  return Promise.resolve(texts.map(text => {
    const vector = [0, 0, 0];
    for (const word of text.toLowerCase().match(/[\p{L}]+/gu) ?? []) {
      SEMANTIC_GROUPS.forEach((group, dim) => {
        if (group.includes(word)) vector[dim] += 1;
      });
    }
    if (vector.every(value => value === 0)) vector[0] = 0.001; // нулевые векторы недопустимы
    return vector;
  }));
}

function sessionFixture(overrides = {}) {
  return {
    sessionId: 'sess-1',
    host: 'cloud-hub',
    harness: 'agy',
    project: 'darkfactory',
    cwd: '/home/user/repo',
    title: 'Тестовая сессия',
    startedAt: '2025-01-01T10:00:00Z',
    updatedAt: '2025-01-01T11:00:00Z',
    summary: 'краткое резюме',
    messages: [
      { seq: 0, role: 'user', content: 'настройка базы данных postgres', createdAt: '2025-01-01T10:00:01Z' },
      { seq: 1, role: 'assistant', content: 'database setup complete with sql index', createdAt: '2025-01-01T10:00:02Z' },
      { seq: 2, role: 'user', content: 'foo bar test passed successfully', createdAt: '2025-01-01T10:00:03Z' },
    ],
    ...overrides,
  };
}

test('ingestSession: incremental idempotent upsert, no duplicates on re-ingest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-archive-'));
  try {
    const archive = openSessionArchive(join(dir, 'archive.db'));
    const first = archive.ingestSession(sessionFixture());
    assert.equal(first.insertedMessages, 3);
    assert.equal(first.messageCount, 3);

    // Полный повтор того же входа: ни одного нового сообщения.
    const repeat = archive.ingestSession(sessionFixture());
    assert.equal(repeat.insertedMessages, 0);
    assert.equal(repeat.messageCount, 3);

    // Инкрементальная дозапись транскрипта: старые seq игнорируются, новые добавляются.
    const grown = sessionFixture({
      messages: [
        ...sessionFixture().messages,
        { seq: 3, role: 'assistant', content: 'дополнительный ответ', createdAt: '2025-01-01T10:00:04Z' },
        { seq: 4, role: 'user', content: 'еще один вопрос', createdAt: '2025-01-01T10:00:05Z' },
      ],
    });
    const incremental = archive.ingestSession(grown);
    assert.equal(incremental.insertedMessages, 2);
    assert.equal(incremental.messageCount, 5);

    // Повторная дозапись того же выросшего транскрипта — снова ноль.
    assert.equal(archive.ingestSession(grown).insertedMessages, 0);
    assert.equal(archive.stats().messages, 5);
    archive.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ingestSession: fail-closed validation of malformed input', () => {
  const archive = openSessionArchive(':memory:');
  assert.throws(() => archive.ingestSession({}), /session_archive_ingest_invalid/);
  assert.throws(() => archive.ingestSession(sessionFixture({ sessionId: '' })), /session_archive_ingest_invalid/);
  assert.throws(() => archive.ingestSession(sessionFixture({ messages: [{}] })), /session_archive_message_invalid/);
  assert.throws(() => archive.ingestSession(sessionFixture({
    messages: [{ seq: -1, role: 'user', content: 'x' }],
  })), /session_archive_message_invalid/);
  archive.close();
});

test('search: FTS5 on Russian and English queries with snippets and bm25 order', async () => {
  const archive = openSessionArchive(':memory:');
  archive.ingestSession(sessionFixture());

  const russian = await archive.search({ query: 'настройка базы', mode: 'fts' });
  assert.ok(russian.length >= 1);
  assert.equal(russian[0].sessionId, 'sess-1');
  assert.equal(russian[0].seq, 0);
  assert.equal(russian[0].role, 'user');
  assert.equal(russian[0].host, 'cloud-hub');
  assert.equal(russian[0].matchSource, 'fts');
  assert.ok(russian[0].snippet.includes('«'));
  assert.ok(russian[0].score > 0);

  const english = await archive.search({ query: 'database setup', mode: 'fts' });
  assert.equal(english[0].seq, 1);
  assert.equal(english[0].harness, 'agy');
  assert.equal(english[0].project, 'darkfactory');
  archive.close();
});

test('search: special characters foo-bar: "test" never throw SQL syntax errors', async () => {
  const archive = openSessionArchive(':memory:');
  archive.ingestSession(sessionFixture());
  for (const query of [
    'foo-bar: "test"',
    '"незакрытая кавычка',
    'foo:bar NEAR/3 baz',
    'a"b"c-d:e',
    '*** --- ::: ',
    'SELECT * FROM messages; DROP TABLE',
  ]) {
    const rows = await archive.search({ query, mode: 'fts' });
    assert.ok(Array.isArray(rows), `query must not throw: ${query}`);
  }
  const hit = await archive.search({ query: 'foo-bar: "test"', mode: 'fts' });
  assert.equal(hit[0].seq, 2);
  // Пунктуация без единой словоформы — пустой результат, а не ошибка.
  const empty = await archive.search({ query: '--- ::: ***', mode: 'fts' });
  assert.deepEqual(empty, []);
  archive.close();
});

test('search: metadata filters host/project/harness/since/until', async () => {
  const archive = openSessionArchive(':memory:');
  archive.ingestSession(sessionFixture());
  archive.ingestSession(sessionFixture({
    sessionId: 'sess-2',
    host: 'cloud-worker',
    harness: 'pi',
    project: 'other-project',
    messages: [
      { seq: 0, role: 'user', content: 'database migration on worker', createdAt: '2025-02-01T09:00:00Z' },
    ],
  }));
  archive.ingestSession(sessionFixture({
    sessionId: 'sess-3',
    host: 'laptop',
    harness: 'devin',
    project: 'laptop-project',
    messages: [
      { seq: 0, role: 'user', content: 'database notes from laptop', createdAt: '2025-03-01T09:00:00Z' },
    ],
  }));

  const all = await archive.search({ query: 'database', mode: 'fts' });
  assert.equal(all.length, 3);

  const byHost = await archive.search({ query: 'database', host: 'cloud-worker' });
  assert.deepEqual(byHost.map(row => row.sessionId), ['sess-2']);

  const byProject = await archive.search({ query: 'database', project: 'darkfactory' });
  assert.deepEqual(byProject.map(row => row.sessionId), ['sess-1']);

  const byHarness = await archive.search({ query: 'database', harness: 'devin' });
  assert.deepEqual(byHarness.map(row => row.sessionId), ['sess-3']);

  const since = await archive.search({ query: 'database', since: '2025-02-01T00:00:00Z' });
  assert.deepEqual(since.map(row => row.sessionId).sort(), ['sess-2', 'sess-3']);

  const until = await archive.search({ query: 'database', until: '2025-02-15T00:00:00Z' });
  assert.deepEqual(until.map(row => row.sessionId).sort(), ['sess-1', 'sess-2']);

  const range = await archive.search({
    query: 'database',
    since: '2025-01-15T00:00:00Z',
    until: '2025-02-15T00:00:00Z',
  });
  assert.deepEqual(range.map(row => row.sessionId), ['sess-2']);

  const combined = await archive.search({ query: 'database', host: 'cloud-hub', harness: 'agy', project: 'darkfactory' });
  assert.deepEqual(combined.map(row => row.sessionId), ['sess-1']);

  // Эпохальные миллисекунды нормализуются в ISO.
  const epoch = await archive.search({ query: 'database', since: Date.parse('2025-02-01T00:00:00Z') });
  assert.deepEqual(epoch.map(row => row.sessionId).sort(), ['sess-2', 'sess-3']);
  archive.close();
});

test('parseAgyTranscript: normalized records, fail-open on corrupt lines', () => {
  const jsonl = [
    '{"type":"user_message","message":{"role":"user","content":"привет, настрой архив"},"timestamp":"2025-01-01T10:00:00Z"}',
    '{"role":"assistant","content":[{"type":"text","text":"готово, архив настроен"}],"created_at":"2025-01-01T10:01:00Z"}',
    '{corrupt json line!!!',
    '',
    '{"type":"system","text":"системная заметка"}',
    '{"message":{"role":"human","content":[{"type":"text","text":"первая часть"},{"type":"text","text":"вторая часть"}]},"time":1735689600000}',
    '{"type":"tool_use","content":"   "}',
  ].join('\n');
  const rows = parseAgyTranscript(jsonl);
  assert.equal(rows.length, 4);
  // seq — индекс строки файла: устойчив к дозаписи транскрипта.
  assert.deepEqual(rows.map(row => row.seq), [0, 1, 4, 5]);
  assert.deepEqual(rows.map(row => row.role), ['user', 'assistant', 'system', 'user']);
  assert.equal(rows[0].content, 'привет, настрой архив');
  // ISO-вход нормализуется в каноническую UTC-форму toISOString() с миллисекундами.
  assert.equal(rows[0].createdAt, '2025-01-01T10:00:00.000Z');
  assert.equal(rows[1].content, 'готово, архив настроен');
  // Блочный content склеивается переводом строки.
  assert.equal(rows[3].content, 'первая часть\nвторая часть');
  // Числовой timestamp нормализуется в ISO.
  assert.equal(rows[3].createdAt, new Date(1735689600000).toISOString());
});

test('parsePiTranscript: normalized records, fail-open on corrupt lines', () => {
  const jsonl = [
    '{"type":"user","content":"hello pi session","time":"2025-01-02T09:00:00Z"}',
    '{"type":"assistant","message":{"content":"pi отвечает"},"createdAt":"2025-01-02T09:00:05Z"}',
    'not json at all',
    '{"role":"assistant","content":[{"type":"output_text","text":"streaming chunk"}]}',
  ].join('\n');
  const rows = parsePiTranscript(jsonl);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.seq), [0, 1, 3]);
  assert.deepEqual(rows.map(row => row.role), ['user', 'assistant', 'assistant']);
  assert.equal(rows[1].content, 'pi отвечает');
  assert.equal(rows[2].content, 'streaming chunk');
  assert.throws(() => parsePiTranscript(null), /session_archive_transcript_invalid/);
});

test('embedPending + hybrid RRF: semantic match with zero overlapping words', async () => {
  const archive = openSessionArchive(':memory:', { embedder: mockEmbedder });
  archive.ingestSession(sessionFixture({
    sessionId: 'vec-1',
    messages: [
      { seq: 0, role: 'assistant', content: 'optimized sql indexes for latency tuning', createdAt: '2025-01-01T10:00:00Z' },
      { seq: 1, role: 'assistant', content: 'css button render alignment fix', createdAt: '2025-01-01T10:01:00Z' },
      { seq: 2, role: 'assistant', content: 'kubernetes pod rollout status', createdAt: '2025-01-01T10:02:00Z' },
    ],
  }));

  // Батчинг: первый проход покрывает batchSize сообщений, остаток — второй.
  const first = await archive.embedPending({ batchSize: 2, model: 'test-embedder' });
  assert.equal(first.embedded, 2);
  assert.equal(first.remaining, 1);
  const second = await archive.embedPending({ batchSize: 2, model: 'test-embedder' });
  assert.equal(second.embedded, 1);
  assert.equal(second.remaining, 0);
  assert.equal(await archive.embedPending({ batchSize: 2 }).then(r => r.embedded), 0);
  assert.equal(archive.stats().embeddings, 3);

  // «why is the database slow» не имеет НИ ОДНОГО общего слова с
  // «optimized sql indexes for latency tuning» — чистый FTS ничего не находит.
  const query = 'why is the database slow';
  const ftsOnly = await archive.search({ query, mode: 'fts' });
  assert.equal(ftsOnly.length, 0);

  // Гибридный режим auto: векторное плечо вытаскивает семантическое совпадение.
  const hybrid = await archive.search({ query, mode: 'auto' });
  assert.ok(hybrid.length >= 1);
  assert.equal(hybrid[0].seq, 0);
  assert.equal(hybrid[0].matchSource, 'vector');
  assert.ok(hybrid[0].score > 0);

  // Явный mode hybrid с прямым queryVector работает без вызова embedder.
  const [vector] = await mockEmbedder([query]);
  const direct = await archive.search({ query, mode: 'hybrid', queryVector: vector });
  assert.equal(direct[0].seq, 0);

  // Запрос с пересекающимися словами попадает в оба плеча → matchSource both
  // и RRF-score выше, чем у чисто векторных совпадений.
  const both = await archive.search({ query: 'sql latency', mode: 'hybrid' });
  assert.equal(both[0].seq, 0);
  assert.equal(both[0].matchSource, 'both');

  // Детерминизм: повторный прогон даёт идентичный порядок и score.
  const again = await archive.search({ query: 'sql latency', mode: 'hybrid' });
  assert.deepEqual(again.map(row => [row.seq, row.score]), both.map(row => [row.seq, row.score]));
  archive.close();
});

test('search: hybrid without embedder and invalid input are fail-closed', async () => {
  const archive = openSessionArchive(':memory:');
  archive.ingestSession(sessionFixture());
  await assert.rejects(() => archive.search({ query: 'database', mode: 'hybrid' }),
    /session_archive_embedder_missing/);
  await assert.rejects(() => archive.search({ query: 'x', limit: 0 }), /session_archive_search_invalid/);
  await assert.rejects(() => archive.search({ query: 'x', mode: 'vector' }), /session_archive_search_invalid/);
  await assert.rejects(() => archive.search({ query: 'x', since: {} }), /session_archive_search_invalid/);
  await assert.rejects(() => archive.search({ query: 'x', host: 42 }), /session_archive_search_invalid/);
  const noEmbedder = openSessionArchive(':memory:');
  await assert.rejects(() => noEmbedder.embedPending(), /session_archive_embedder_missing/);
  noEmbedder.close();
  archive.close();
});

test('stats: counts sessions, messages, embeddings and distinct metadata', () => {
  const archive = openSessionArchive(':memory:');
  assert.deepEqual(archive.stats(), {
    sessions: 0, messages: 0, embeddings: 0, hosts: 0, projects: 0, harnesses: 0, schemaVersion: 1,
  });
  archive.ingestSession(sessionFixture());
  archive.ingestSession(sessionFixture({ sessionId: 'sess-2', host: 'laptop', harness: 'pi', project: 'other' }));
  const stats = archive.stats();
  assert.equal(stats.sessions, 2);
  assert.equal(stats.messages, 6);
  assert.equal(stats.hosts, 2);
  assert.equal(stats.projects, 2);
  assert.equal(stats.harnesses, 2);
  assert.equal(stats.embeddings, 0);
  archive.close();
});

test('sanitizeFtsQuery: pure token extraction, always safe for MATCH', () => {
  assert.equal(sanitizeFtsQuery('foo-bar: "test"'), '"foo" OR "bar" OR "test"');
  assert.equal(sanitizeFtsQuery('настройка базы'), '"настройка" OR "базы"');
  assert.equal(sanitizeFtsQuery('---'), '');
  assert.equal(sanitizeFtsQuery(42), '');
});

test('normalizeTimestamp: epoch seconds/ms detection and canonical UTC ISO output', () => {
  // 1735689600 — epoch seconds; 1735689600000 — те же сутки в миллисекундах.
  assert.equal(normalizeTimestamp(1735689600), '2025-01-01T00:00:00.000Z');
  assert.equal(normalizeTimestamp(1735689600000), '2025-01-01T00:00:00.000Z');
  // Числовые строки проходят ту же epoch-эвристику.
  assert.equal(normalizeTimestamp('1735689600'), '2025-01-01T00:00:00.000Z');
  // Валидные даты нормализуются в UTC ISO независимо от исходной формы:
  // «Z» без миллисекунд и смещения часовых поясов — в единую каноническую форму.
  assert.equal(normalizeTimestamp('2025-01-01T10:00:00Z'), '2025-01-01T10:00:00.000Z');
  assert.equal(normalizeTimestamp('2025-01-01T13:00:00+03:00'), '2025-01-01T10:00:00.000Z');
  assert.equal(normalizeTimestamp('2025-01-01T10:00:00.000Z'), '2025-01-01T10:00:00.000Z');
  // Невалидная строка сохраняется как есть (fail-open), пустой ввод — null.
  assert.equal(normalizeTimestamp('not a date at all'), 'not a date at all');
  assert.equal(normalizeTimestamp(''), null);
  assert.equal(normalizeTimestamp('   '), null);
  assert.equal(normalizeTimestamp(null), null);
  assert.equal(normalizeTimestamp(undefined), null);
  assert.equal(normalizeTimestamp(-5), null);
  assert.equal(normalizeTimestamp(NaN), null);
  assert.equal(normalizeTimestamp({}), null);
});

test('ingestSession: re-ingest without optional metadata preserves title/project/cwd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-archive-meta-'));
  try {
    const dbPath = join(dir, 'archive.db');
    const archive = openSessionArchive(dbPath);
    archive.ingestSession(sessionFixture());
    // Повторный инжест транскрипта без title/project/cwd (обрезанная выгрузка).
    archive.ingestSession({
      sessionId: 'sess-1',
      host: 'cloud-hub',
      harness: 'agy',
      messages: sessionFixture().messages,
    });
    archive.close();

    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare('SELECT * FROM sessions WHERE session_id = ?').get('sess-1');
    assert.equal(row.title, 'Тестовая сессия');
    assert.equal(row.project, 'darkfactory');
    assert.equal(row.cwd, '/home/user/repo');
    assert.equal(row.summary, 'краткое резюме');
    // started_at тоже переживает повторный инжест и нормализован в каноническую форму.
    assert.equal(row.started_at, '2025-01-01T10:00:00.000Z');
    raw.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('openSessionArchive: db file is chmod 0600 and journal_mode is WAL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-archive-perms-'));
  try {
    const dbPath = join(dir, 'archive.db');
    const archive = openSessionArchive(dbPath);
    archive.ingestSession(sessionFixture());
    archive.close();

    const info = await stat(dbPath);
    assert.equal(info.mode & 0o777, 0o600, 'archive db must be owner-only');

    const raw = new DatabaseSync(dbPath);
    assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    raw.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('search: since/until accurate across mixed timestamp formats', async () => {
  const archive = openSessionArchive(':memory:');
  archive.ingestSession(sessionFixture({
    sessionId: 'mixed-1',
    messages: [
      // epoch seconds (число) = 2025-01-01T00:00:00Z
      { seq: 0, role: 'user', content: 'database epoch seconds entry', createdAt: 1735689600 },
      // ISO со смещением +03:00 = 2025-01-01T02:00:00Z UTC
      { seq: 1, role: 'user', content: 'database offset entry', createdAt: '2025-01-01T05:00:00+03:00' },
      // epoch milliseconds как числовая строка = 2025-01-01T06:00:00Z
      { seq: 2, role: 'user', content: 'database numeric string entry', createdAt: '1735711200000' },
    ],
  }));

  const all = await archive.search({ query: 'database', mode: 'fts' });
  assert.equal(all.length, 3);
  // Все метки приведены к канонической UTC ISO-форме с миллисекундами.
  assert.deepEqual(all.map(row => row.createdAt).sort(), [
    '2025-01-01T00:00:00.000Z',
    '2025-01-01T02:00:00.000Z',
    '2025-01-01T06:00:00.000Z',
  ]);

  // Лексикографические фильтры корректны независимо от исходного формата меток.
  const since = await archive.search({ query: 'database', since: '2025-01-01T01:00:00Z' });
  assert.deepEqual(since.map(row => row.seq).sort(), [1, 2]);
  const until = await archive.search({ query: 'database', until: '2025-01-01T01:00:00Z' });
  assert.deepEqual(until.map(row => row.seq), [0]);
  // since/until тоже принимают epoch seconds.
  const epochRange = await archive.search({ query: 'database', since: 1735687200, until: 1735689600 });
  assert.deepEqual(epochRange.map(row => row.seq), [0]);
  archive.close();
});

test('search: all-zero queryVector is rejected fail-closed', async () => {
  const archive = openSessionArchive(':memory:', { embedder: mockEmbedder });
  archive.ingestSession(sessionFixture());
  await assert.rejects(
    () => archive.search({ query: 'database', mode: 'hybrid', queryVector: [0, 0, 0] }),
    /session_archive_vector_zero/,
  );
  // Ненулевой вектор по-прежнему принимается.
  const [vector] = await mockEmbedder(['database']);
  const rows = await archive.search({ query: 'database', mode: 'hybrid', queryVector: vector });
  assert.ok(Array.isArray(rows));
  archive.close();
});

test('search: queryModel filters vector leg by embedding model', async () => {
  const archive = openSessionArchive(':memory:', { embedder: mockEmbedder });
  archive.ingestSession(sessionFixture({
    sessionId: 'models-1',
    messages: [
      { seq: 0, role: 'assistant', content: 'optimized sql indexes for latency tuning', createdAt: '2025-01-01T10:00:00Z' },
    ],
  }));
  await archive.embedPending({ model: 'model-a' });
  // «why is the database slow» не пересекается по словам — только векторное плечо.
  const query = 'why is the database slow';

  const wrongModel = await archive.search({ query, mode: 'hybrid', queryModel: 'model-b' });
  assert.deepEqual(wrongModel, []);

  const rightModel = await archive.search({ query, mode: 'hybrid', queryModel: 'model-a' });
  assert.ok(rightModel.length >= 1);
  assert.equal(rightModel[0].seq, 0);
  assert.equal(rightModel[0].matchSource, 'vector');

  // Без queryModel — все embedding'и участвуют, поведение прежнее.
  const unfiltered = await archive.search({ query, mode: 'hybrid' });
  assert.ok(unfiltered.length >= 1);

  await assert.rejects(() => archive.search({ query, mode: 'hybrid', queryModel: '' }),
    /session_archive_search_invalid/);
  await assert.rejects(() => archive.search({ query, mode: 'hybrid', queryModel: 42 }),
    /session_archive_search_invalid/);
  archive.close();
});

test('search: streaming top-K stays correct when embeddings exceed the pool cap', async () => {
  const archive = openSessionArchive(':memory:', { embedder: mockEmbedder });
  // 45 embedding'ов при poolSize 40 (limit 5): bounded top-K вытесняет худшие,
  // лучшее совпадение — последняя вставленная строка — не теряется.
  const messages = [];
  for (let i = 0; i < 44; i += 1) {
    messages.push({ seq: i, role: 'assistant', content: `css button render alignment note ${i}`, createdAt: '2025-01-01T10:00:00Z' });
  }
  messages.push({ seq: 44, role: 'assistant', content: 'optimized sql indexes for latency tuning', createdAt: '2025-01-01T10:00:00Z' });
  archive.ingestSession(sessionFixture({ sessionId: 'bulk-1', messages }));
  for (let round = 0; round < 3; round += 1) {
    await archive.embedPending({ batchSize: 32, model: 'test-embedder' });
  }
  assert.equal(archive.stats().embeddings, 45);

  const hybrid = await archive.search({ query: 'why is the database slow', mode: 'hybrid', limit: 5 });
  assert.ok(hybrid.length >= 1);
  assert.equal(hybrid[0].seq, 44);
  assert.equal(hybrid[0].matchSource, 'vector');
  // Детерминизм: повторный прогон — тот же порядок и score.
  const again = await archive.search({ query: 'why is the database slow', mode: 'hybrid', limit: 5 });
  assert.deepEqual(again.map(row => [row.seq, row.score]), hybrid.map(row => [row.seq, row.score]));
  archive.close();
});
