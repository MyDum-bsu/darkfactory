import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runArchiveCli } from './df-archive.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'df-archive-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = join(dir, 'archive.db');
  return { dir, db, run: (...args) => runArchiveCli(args, { defaultDbPath: db }) };
}

test('ingest reads native metadata; explicit flags take precedence; search filters by harness', async t => {
  const { dir, db, run } = await fixture(t);
  const file = join(dir, 'rollout.jsonl');
  await writeFile(file, [JSON.stringify({ type: 'session_meta', payload: { id: 'rollout', cwd: '/work/df-one', title: 'native' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'needle' } })].join('\n'));
  const ingest = (...flags) => run('ingest', '--harness', 'codex', '--host', 'test', '--file', file, ...flags);
  assert.equal((await ingest()).sessionId, 'rollout');
  assert.equal((await ingest('--cwd', '/work/mr-one', '--title', 'override', '--session-id', 'manual')).sessionId, 'manual');
  const reader = new DatabaseSync(db, { readOnly: true });
  try {
    assert.deepEqual(reader.prepare('SELECT session_id, cwd, title, project FROM sessions ORDER BY session_id').all().map(Object.values), [
      ['manual', '/work/mr-one', 'override', 'music-restoration'], ['rollout', '/work/df-one', 'native', 'darkfactory'],
    ]);
  } finally { reader.close(); }
  for (const harness of ['agy', 'pi', 'omp', 'codex', 'claude', 'devin', 'opencode', 'zcode']) {
    assert.equal((await run('search', '--query', 'needle', '--harness', harness)).length, harness === 'codex' ? 2 : 0);
  }
});

test('ingest dispatches OMP, Claude and Devin native transcripts', async t => {
  const { dir, run } = await fixture(t);
  const message = { role: 'user', content: 'needle' };
  for (const [harness, rows] of [
    ['omp', [{ type: 'session', id: 'omp-id' }, { type: 'message', message }]],
    ['claude', [{ type: 'user', sessionId: 'claude-id', message }]],
    ['devin', [{ session_id: 'devin-id', steps: [{ source: 'user', message: 'needle' }] }]],
  ]) {
    const file = join(dir, harness);
    await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n'));
    assert.deepEqual(await run('ingest', '--file', file, '--harness', harness, '--host', 'test'),
      { sessionId: `${harness}-id`, insertedMessages: 1, messageCount: 1 });
    assert.equal((await run('search', '--query', 'needle', '--harness', harness))[0].sessionId, `${harness}-id`);
  }
  await assert.rejects(run('search', '--query', 'needle', '--harness', 'unsupported'), /--harness/);
});

test('import-db routes both shared-schema harnesses to distinct searchable sessions', async t => {
  const { dir, run } = await fixture(t);
  const source = join(dir, 'source.sqlite');
  const sqlite = new DatabaseSync(source);
  sqlite.exec(`CREATE TABLE session(id, directory, title); CREATE TABLE message(id, session_id, data);
    CREATE TABLE part(message_id, data); INSERT INTO session VALUES ('a', NULL, NULL);
    INSERT INTO message VALUES ('m','a','{"role":"user"}'); INSERT INTO part VALUES ('m','{"type":"text","text":"question"}');`);
  sqlite.close();
  for (const harness of ['opencode', 'zcode']) {
    const report = await run('import-db', '--harness', harness, '--source', source, '--host', 'tester', '--project', 'fallback');
    assert.equal(report.ingestedSessions, 1);
    const hits = await run('search', '--query', 'question', '--harness', harness);
    assert.deepEqual(hits.map(row => [row.sessionId, row.host, row.project]), [[`${harness}:a`, 'tester', 'fallback']]);
  }
});

test('import-db reads large regular files, forwards filters and system opt-in, formats JSON and human reports', async t => {
  const { dir, db } = await fixture(t);
  const source = join(dir, 'sessions.db');
  const sqlite = new DatabaseSync(source);
  sqlite.exec(`CREATE TABLE sessions(id, working_directory, created_at, last_activity_at, title);
    CREATE TABLE message_nodes(row_id, session_id, chat_message, created_at);
    INSERT INTO sessions VALUES ('a',NULL,0,0,NULL), ('b',NULL,0,1800000000,NULL), ('c',NULL,0,1900000000,NULL);
    INSERT INTO message_nodes VALUES (1,'c','{"role":"user","content":"query"}',0), (2,'c','{"role":"system","content":"system"}',0);`);
  sqlite.close();
  await truncate(source, 65 * 1024 * 1024); // sparse, valid DB with trailing pages; JSONL cap must not apply
  const cli = (...flags) => execFileSync(process.execPath, [join(import.meta.dirname, 'df-archive.mjs'),
    'import-db', '--db', db, '--source', source, '--harness', 'devin', '--host', 'offline', '--since', '2025-01-01',
    '--limit', '1', '--project', 'fallback', ...flags], { encoding: 'utf8' });
  const summary = JSON.parse(cli('--json'));
  assert.deepEqual(summary, { harness: 'devin', sourceDbPath: source, scannedSessions: 1, ingestedSessions: 1,
    skippedEmpty: 0, insertedMessages: 1, totalMessages: 1 });
  assert.equal(JSON.parse(cli('--json', '--include-system')).totalMessages, 2);
  assert.match(cli(), /devin/);
});

test('import-db rejects directories, symlinks and aliases of its writable destination', async t => {
  const { dir, db, run } = await fixture(t);
  const source = join(dir, 'source.db'), alias = join(dir, 'alias');
  new DatabaseSync(source).close();
  await symlink(source, alias);
  const before = await readFile(source);
  await link(source, db);
  for (const path of [dir, alias, source]) {
    await assert.rejects(run('import-db', '--source', path, '--harness', 'devin', '--host', 'offline'), /regular file|different/);
  }
  assert.deepEqual(await readFile(source), before);
});
