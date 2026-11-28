import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { runExam, verifyCandidate } from './df-dream.mjs';
import { distillTaste, approveTaste } from '../board_pipeline/taste-distiller.mjs';

const end = '2026-11-28T00:00:00.000Z', start = '2026-11-27T00:00:00.000Z';
const rule = 'Do not hide failed checks.';
const owner = (id, quote = rule) => ({ id, kind: 'owner', quote, at: end });

test('a real quote cannot launder a different claim or an invented citation', () => {
  const source = owner('s:1');
  const candidate = { sourceId: source.id, quote: rule, claim: rule };
  assert.equal(verifyCandidate(candidate, source), true);
  for (const patch of [{ claim: 'Hide failed checks.' }, { quote: 'failed checks.' }, { sourceId: 's:2' }, { quote: '' }]) {
    assert.equal(verifyCandidate({ ...candidate, ...patch }, source), false);
  }
  assert.equal(verifyCandidate(null, undefined), false);
});

test('taste recommendations require independent owner corrections and an exact approval', () => {
  const a = owner('s:1'), b = owner('s:2');
  assert.deepEqual(distillTaste([a, a, { ...b, kind: 'hold' }]), []);
  for (const nonRule of ['Hello', 'No!', 'Нет!']) assert.deepEqual(distillTaste([owner('s:1', nonRule), owner('s:2', nonRule)]), []);
  assert.equal(distillTaste([a, owner('s:2', 'Don’t hide failed checks.')])[0].text, rule);
  const [candidate] = distillTaste([b, a]);
  assert.deepEqual(distillTaste([a, b, a]), [candidate]);
  assert.equal(candidate.target, 'owner-taste.md');
  assert.equal(candidate.status, 'pending_owner_approval');
  assert.throws(() => approveTaste([a, b], 'unknown'));
  assert.throws(() => approveTaste([a, { ...b, quote: 'Do not test.' }], candidate.id));
  assert.equal(approveTaste([a, b], candidate.id).text, rule);
});

test('nightly CLI: pinned human sessions, exact windows, replay and transactional rollback', t => {
  const dir = mkdtempSync(join(tmpdir(), 'df-dream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archive = join(dir, 'session-archive.db'), board = join(dir, 'board.json');
  const db = new DatabaseSync(archive);
  t.after(() => db.close());
  db.exec('CREATE TABLE messages(session_id TEXT, seq INTEGER, role TEXT, content TEXT, created_at TEXT)');
  const put = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)');
  put.run('human', 0, 'user', rule, start);
  put.run('human', 1, 'user', rule, end);
  put.run('human', 2, 'user', rule, end);
  put.run('human', 3, 'assistant', rule, end);
  put.run('worker', 4, 'user', rule, end);
  put.run('human', 5, 'user', rule, '2026-11-28T00:00:00.001Z');
  put.run('human', 6, 'user', rule, null);
  const task = (id, state, reason, at) => ({ message: { id, task: { state, blocked: { reason, at } }, updatedAt: at } });
  writeFileSync(board, JSON.stringify({ tasks: [task('1', 'blocked', 'Missing receipt.', end),
    task('2', 'completed', 'Not a hold.', end), task('3', 'blocked', 'Too old.', start),
    { message: { id: '4', labels: { 'factory.phase': 'L2_REWORK' }, task: { state: 'claimed' }, updatedAt: end } }] }));
  const tasteFile = join(dir, 'owner-taste.md');
  writeFileSync(tasteFile, 'Approved rules only.');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning',
    new URL('./df-dream.mjs', import.meta.url).pathname, '--archive', archive, '--board-tasks', board,
    '--owner-session', 'human', '--state-dir', dir, '--now', end, ...args], { encoding: 'utf8' }));
  const proposals = join(dir, 'candidates.json');
  writeFileSync(proposals, JSON.stringify([{ sourceId: JSON.stringify(['owner', 'human', 1]), quote: rule, claim: 'Hide failed checks.' }]));
  const ungrounded = run('--candidates', proposals);
  assert.equal(ungrounded.rejected[0].reason, 'ungrounded_claim');
  assert.equal(ungrounded.memorySize, 0);
  const first = run();
  assert.deepEqual(first.collected.map(s => s.kind).sort(), ['REWORK', 'hold', 'owner', 'owner']);
  assert.equal(first.tasteCandidates.length, 1);
  assert.equal(first.memorySize, 4);
  assert.equal(run().memorySize, 4);
  const before = runExam([]);
  assert.ok(before.total >= 20 && before.total <= 30);
  assert.equal(before.score, before.total);
  const conflict = 'Allow edits outside the Scope Fence allowed_paths.';
  put.run('human', 7, 'user', conflict, end);
  put.run('human', 8, 'user', 'Always label releases.', end);
  const rejected = run();
  assert.equal(rejected.rolledBack, true);
  assert.ok(rejected.exam.after.score < rejected.exam.before.score);
  assert.equal(rejected.memorySize, 4);
  assert.ok(rejected.contradictions.some(c => c.actual.quote === conflict));
  assert.deepEqual(rejected.learned, []);
  put.run('human', 9, 'user', 'Always check stderr.', end);
  put.run('human', 10, 'user', 'Good morning!', end);
  db.exec('DELETE FROM messages WHERE seq IN (7,8)');
  assert.equal(run().memorySize, 5); // neither the rejected batch nor the greeting was learned
  assert.equal(readFileSync(tasteFile, 'utf8'), 'Approved rules only.');
});
