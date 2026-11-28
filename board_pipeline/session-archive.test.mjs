import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  configuredArchiveEmbedder,
  DEFAULT_EMBED_MODEL,
  extractTranscriptMeta,
  importDevinSqlite,
  importOpencodeSqlite,
  indexTerminalAttempt,
  inferSessionProject,
  normalizeTimestamp,
  openSessionArchive,
  parseAgyTranscript,
  parseClaudeTranscript,
  parseCodexTranscript,
  parseDevinTranscript,
  parseOmpTranscript,
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

test('project inference uses canonical path components before title and fallback', () => {
  for (const id of ['darkfactory', 'music-restoration', 'optimization', 'autoresearcher', 'moml-course', 'bsu-cabinet-skill']) {
    assert.equal(inferSessionProject({ cwd: `/src/${id}/lib`, title: 'CTO', fallback: 'general' }), id);
  }
  for (const [cwd, title, expected] of [
    ['/src/df-v12-4-wt', '', 'darkfactory'], ['/work/mr-a/tests', '', 'music-restoration'],
    ['/src/darkfactory-hub', '', 'cto'], ['/tmp', 'Fleet-wide CTO review', 'cto'],
    ['/src/not-optimization', 'doctor', 'general'], ['/src/darkfactory/../tmp', '', 'general'],
    [undefined, undefined, 'general'],
  ]) assert.equal(inferSessionProject({ cwd, title }), expected);
  assert.equal(inferSessionProject({ fallback: 'optimization' }), 'optimization');
  assert.equal(inferSessionProject({ cwd: '/tmp', fallback: 'darkfactory' }), 'general');
});

test('terminal replay indexes only this attempt, with Vertex document/query vectors fused with FTS', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'terminal-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'archive.db');
  const env = { DF_VERTEX_PROJECT: 'offline', DF_VERTEX_LOCATION: 'global', DF_VERTEX_ACCESS_TOKEN: 'mock' };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /aiplatform\.googleapis\.com\/v1\/projects\/offline\/.+:predict$/);
    const { instances } = JSON.parse(options.body);
    assert.equal(instances.length, 1);
    const { content, task_type } = instances[0];
    calls.push(task_type);
    const [values] = await mockEmbedder([content]);
    return Response.json({ predictions: [{ embeddings: { values } }] });
  });
  const embedder = configuredArchiveEmbedder(DEFAULT_EMBED_MODEL, 'RETRIEVAL_DOCUMENT', env);
  const query = configuredArchiveEmbedder(DEFAULT_EMBED_MODEL, 'RETRIEVAL_QUERY', env);
  const archive = openSessionArchive(dbPath, { embedder: query });
  t.after(() => archive.close());
  archive.ingestSession(sessionFixture()); // pending unrelated messages must not leave this host
  for (const phase of ['working', 'lease_lost', 'hold', 'done']) {
    const result = { phase, attemptId: phase }, record = { ...result, taskId: '7', contract: { specText: 'database index' } };
    const input = { dbPath, record, result, cwd: '/repos/mr-work', host: 'test', harness: 'pi', tail: 'postgres tuning', embedder };
    const index = () => indexTerminalAttempt(input);
    if (!['done', 'hold'].includes(phase)) { assert.equal(await index(), null); continue; }
    assert.equal((await index()).insertedMessages, 3);
    assert.equal((await index()).insertedMessages, 0);
  }
  assert.equal(archive.stats().embeddings, 6);
  assert.deepEqual(calls, Array(6).fill('RETRIEVAL_DOCUMENT'));
  const hits = await archive.search({ query: 'index', mode: 'hybrid', project: 'music-restoration', queryModel: DEFAULT_EMBED_MODEL });
  assert.equal(hits[0].matchSource, 'both');
  assert.ok(hits.some(hit => hit.seq === 1 && hit.matchSource === 'vector'));
  assert.equal(calls.at(-1), 'RETRIEVAL_QUERY');
});

test('CLI automatically tags a Pi transcript from its session cwd, not the scanner cwd', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'archive-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'archive.db'), file = join(dir, 'session.jsonl');
  await writeFile(file, [JSON.stringify({ type: 'session', cwd: '/work/mr-mix/lib' }),
    JSON.stringify({ message: { role: 'user', content: 'archive test' } })].join('\n'));
  for (const count of [1, 0]) {
    const result = execFileSync(process.execPath, [join(import.meta.dirname, '../ops/df-archive.mjs'),
      'ingest', '--db', dbPath, '--file', file, '--host', 'test', '--harness', 'pi', '--json']);
    assert.equal(JSON.parse(result).insertedMessages, count);
  }
  const archive = openSessionArchive(dbPath);
  try { assert.equal((await archive.search({ query: 'archive' }))[0].project, 'music-restoration'); }
  finally { archive.close(); }
});

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

const jsonl = (...rows) => rows.map(row => JSON.stringify(row)).join('\n');
const stamp = '2025-03-01T00:00:00.000Z';

test('Codex rollout ignores non-messages, merges mirrored events, and opts in to developer text', () => {
  const response = (role, content) => ({ type: 'response_item', timestamp: stamp, payload: { type: 'message', role, content } });
  const event = (type, message) => ({ type: 'event_msg', payload: { type, message } });
  const text = 'broken\n' + jsonl(response('developer', 'policy'), response('user', [{ type: 'input_text', text: 'query' }]),
    event('user_message', 'query'), response('assistant', [{ type: 'output_text', text: 'one' }, { text: 'two' }]),
    event('agent_message', 'event only'), event('user_message', 'query'), { type: 'response_item', payload: { type: 'tool_call' } });
  const parsed = parseCodexTranscript(text);
  assert.deepEqual(parsed, [
    { seq: 2, role: 'user', content: 'query', createdAt: stamp },
    { seq: 4, role: 'assistant', content: 'one\ntwo', createdAt: stamp },
    { seq: 5, role: 'assistant', content: 'event only', createdAt: null },
    { seq: 6, role: 'user', content: 'query', createdAt: null },
  ]);
  assert.deepEqual(parseCodexTranscript(text, { includeSystem: true }), [
    { seq: 1, role: 'system', content: 'policy', createdAt: stamp }, ...parsed]);
});

test('OMP and Claude use their native message wrapper, timestamps and physical line numbers', () => {
  const message = { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: Date.parse(stamp) };
  const fixture = type => jsonl({ type: 'session', message }, null, { type, message, timestamp: stamp }, { type, message: {} });
  const expected = [{ seq: 2, role: 'assistant', content: 'answer', createdAt: stamp }];
  assert.deepEqual(parseOmpTranscript(fixture('message')), expected);
  assert.deepEqual(parseClaudeTranscript(fixture('assistant')), expected);
  assert.deepEqual(parseClaudeTranscript(jsonl({ type: 'user', message: { role: 'user', content: 'hello' } })),
    [{ seq: 0, role: 'user', content: 'hello', createdAt: null }]);
});

test('Devin steps and JSONL fallback retain positions despite system, empty and malformed rows', () => {
  const steps = [null, { step_id: 'a', source: 'system', message: 'policy' },
    { source: 'human', message: 'question', timestamp: stamp }, { source: 'devin', message: [{ text: 'reply' }] },
    { source: 'unknown', message: 'skip' }, { source: 'tool', message: ' ' }];
  const expected = [{ seq: 2, role: 'user', content: 'question', createdAt: stamp },
    { seq: 3, role: 'assistant', content: 'reply', createdAt: null }];
  for (const text of [JSON.stringify({ schema_version: 1, session_id: 'd', steps }, null, 2), jsonl(...steps) + '\nbad']) {
    assert.deepEqual(parseDevinTranscript(text), expected);
    assert.deepEqual(parseDevinTranscript(text, { includeSystem: true }), [
      { seq: 1, role: 'system', content: 'policy', createdAt: null }, ...expected]);
  }
});

test('transcript metadata uses native headers and omits absent fields and message IDs', () => {
  const header = { type: 'session', id: 'h', cwd: '/work', title: 't' };
  const expected = { sessionId: 'h', cwd: '/work', title: 't' };
  for (const harness of ['agy', 'pi']) {
    assert.deepEqual(extractTranscriptMeta(harness, jsonl(header, { id: 'wrong' })), expected);
    assert.deepEqual(extractTranscriptMeta(harness, jsonl({ id: 'turn', message: {} })), {});
  }
  assert.deepEqual(extractTranscriptMeta('codex', jsonl({ type: 'session_meta', payload: header })), expected);
  assert.deepEqual(extractTranscriptMeta('omp', 'broken\n' + jsonl({ ...header, title: undefined }, { type: 'title', title: 't' })), expected);
  assert.deepEqual(extractTranscriptMeta('claude', jsonl({ id: 'turn' }, { cwd: '/work', sessionId: 'c' })), { cwd: '/work', sessionId: 'c' });
  assert.deepEqual(extractTranscriptMeta('devin', JSON.stringify({ session_id: 'd', steps: [] }, null, 2)), { sessionId: 'd' });
  for (const input of [undefined, null, 'bad\n[]\nnull', '']) {
    assert.deepEqual(extractTranscriptMeta('omp', input), {});
    for (const parse of [parseCodexTranscript, parseOmpTranscript, parseClaudeTranscript, parseDevinTranscript]) {
      assert.deepEqual(parse(input), []);
    }
  }
});

async function sourceFixture(t, name, ddl) {
  const dir = await mkdtemp(join(tmpdir(), 'archive-import-'));
  const sourceDbPath = join(dir, name);
  const source = new DatabaseSync(sourceDbPath);
  try { source.exec(ddl); } finally { source.close(); }
  const original = await readFile(sourceDbPath);
  const archive = openSessionArchive(':memory:');
  t.after(() => archive.close());
  t.after(async () => {
    try { assert.deepEqual(await readFile(sourceDbPath), original); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  return { archive, sourceDbPath, host: 'offline', fallbackProject: 'fallback' };
}

test('Devin SQLite: latest activity cutoff, ordered nodes, system opt-in, empty sessions, replay', async t => {
  const opts = await sourceFixture(t, 'sessions.db', `
    CREATE TABLE sessions(id, working_directory, created_at, last_activity_at, title);
    CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY, session_id, chat_message, created_at);
    INSERT INTO sessions VALUES ('old',NULL,0,'2025-02-28T23:59:59Z',NULL),
      ('empty',NULL,0,'2025-03-02',NULL), ('s','/work/df-session',0,'2025-03-01','s');
    INSERT INTO message_nodes VALUES (7,'s','{"role":"assistant","content":[{"text":"answer"}]}','2025-03-01'),
      (1,'s','{"role":"system","content":"policy"}',0), (3,'s','{"role":"user","content":"question"}',0),
      (5,'s','broken',0), (8,'empty','{}',0), (10,'old','{"role":"user","content":"old"}',0);`);
  const run = extra => importDevinSqlite({ ...opts, since: stamp, ...extra });
  assert.deepEqual(run({ limit: 1 }), { harness: 'devin', sourceDbPath: opts.sourceDbPath, scannedSessions: 1,
    ingestedSessions: 0, skippedEmpty: 1, insertedMessages: 0, totalMessages: 0 });
  assert.deepEqual(run(), { harness: 'devin', sourceDbPath: opts.sourceDbPath, scannedSessions: 2,
    ingestedSessions: 1, skippedEmpty: 1, insertedMessages: 2, totalMessages: 2 });
  assert.equal((await opts.archive.search({ query: 'policy' })).length, 0);
  const included = run({ includeSystem: true });
  assert.equal(included.insertedMessages, 1);
  assert.equal(included.totalMessages, 3);
  assert.equal(run({ includeSystem: true }).insertedMessages, 0);
  const hits = await opts.archive.search({ query: 'policy question answer' });
  assert.deepEqual([...hits].sort((a, b) => a.seq - b.seq).map(hit => hit.role), ['system', 'user', 'assistant']);
  assert.ok(hits.every(hit => hit.sessionId === 'devin:s' && hit.project === 'darkfactory'));
  for (const args of [{ host: ' ' }, { since: 'bad' }, { limit: 0 }, { harness: 'zcode' }]) {
    assert.throws(() => run(args), /session_archive_import_/);
  }
});

for (const harness of ['opencode', 'zcode']) {
  test(`${harness} SQLite: optional schema, ordering, text-only parts, filters and replay`, async t => {
    const full = harness === 'zcode';
    const opts = await sourceFixture(t, full ? 'db.sqlite' : 'opencode.db', `
      CREATE TABLE session(id, ${full ? 'path' : 'directory'}, title, time_created, time_updated ${full ? ', time_deleted' : ''});
      CREATE TABLE message(id, session_id, data, time_created ${full ? ', sequence' : ''});
      CREATE TABLE part(id, message_id, data, time_created ${full ? ', sequence' : ''});
      INSERT INTO session VALUES ('s','/repos/mr-mix','main',0,${Date.parse(stamp)} ${full ? ',NULL' : ''}),
        ('old',NULL,NULL,0,0 ${full ? ',NULL' : ''});
      ${full ? "INSERT INTO session VALUES ('deleted',NULL,NULL,0,1999999999999,0);" : ''}
      INSERT INTO message VALUES ('m1','s','{"role":"assistant"}',1 ${full ? ',2' : ''}),
        ('m2','s','{"role":"user"}',2 ${full ? ',1' : ''}), ('m3','s','bad',3 ${full ? ',3' : ''});
      INSERT INTO part VALUES ('p2','m1','{"type":"text","text":"second"}',2 ${full ? ',1' : ''}),
        ('p1','m1','{"type":"text","text":"first"}',1 ${full ? ',2' : ''}),
        ('p3','m1','{"type":"tool","text":"secret"}',3 ${full ? ',3' : ''}),
        ('p4','m1','{"type":"text","text":" "}',4 ${full ? ',4' : ''}),
        ('p5','m2','{"type":"text","text":"question"}',1 ${full ? ',1' : ''}),
        ('p6','m3','broken',1 ${full ? ',1' : ''});`);
    const run = extra => importOpencodeSqlite({ ...opts, harness, ...extra });
    assert.deepEqual(run({ since: stamp }), { harness, sourceDbPath: opts.sourceDbPath, scannedSessions: 1,
      ingestedSessions: 1, skippedEmpty: 0, insertedMessages: 2, totalMessages: 2 });
    assert.equal(run({ limit: 1 }).insertedMessages, 0);
    assert.equal(run().skippedEmpty, 1);
    assert.equal((await opts.archive.search({ query: 'secret' })).length, 0);
    const [answer] = await opts.archive.search({ query: 'first' });
    assert.equal(answer.seq, full ? 1 : 0);
    assert.equal(answer.snippet, full ? 'second\n«first»' : '«first»\nsecond');
    assert.equal(answer.sessionId, `${harness}:s`);
    assert.equal(answer.project, 'music-restoration');
    assert.throws(() => run({ harness: 'devin' }), /harness_invalid/);
  });
}

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
