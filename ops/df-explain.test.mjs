import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { canonicalJson } from '../board_pipeline/subject.mjs';
import { explainAttempt, formatExplanation } from './df-explain.mjs';

const cli = fileURLToPath(new URL('./df-explain.mjs', import.meta.url));
const id = { task_id: '13300', attempt_id: 'attempt-a', epoch: 7 };
const sha = 'a'.repeat(40);
const wal = { taskId: id.task_id, attemptId: id.attempt_id, epoch: id.epoch, sha, phase: 'done' };
const worker = { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash' };
const critic = { provider: 'google', model: 'gemini-4-neon' };
const arbiter = { provider: 'openai', model: 'gpt-6.2-sol' };
const summary = { kind: 'attempt_summary', schema: 1, ...id, outcome: 'done', reason: null, open: false,
  phases_status: { l1_local: 'ok', tamper: 'ok', l2_critic: 'ok' },
  phases_ms: { l1_local: 21, tamper: 0, l2_critic: 84 }, rounds: { rework: 0 }, models: { worker, critic, arbiter } };
const ndjson = (...records) => records.map(row => JSON.stringify(row)).join('\n') + '\n';
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

async function fixture(t, files = {}) {
  const dir = await mkdtemp(fileURLToPath(new URL('../.df-explain-test-', import.meta.url)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

test('joins WAL, rotated events and telemetry without modifying or disclosing private state', async t => {
  const bom = block => ({ ...id, kind: 'prompt_bom', detail: { blocks: [block] } });
  const files = {
    'attempt.json': JSON.stringify({ ...wal, token: 'SECRET', metadata: { contextBlocks: ['spec'] } }),
    'events.10.ndjson': ndjson(bom('scope fence')),
    'events.2.ndjson': ndjson(bom('project memory'), { ...bom('other epoch'), epoch: 6 }),
    'events.ndjson': ndjson(bom('spec'), { ...bom('other attempt'), attempt_id: 'attempt-b' }),
    'telemetry.jsonl': ndjson(summary, { ...summary, epoch: 6, outcome: 'hold' },
      { ...summary, task_id: 'other', outcome: 'hold' }),
  };
  const stateDir = await fixture(t, files);
  const report = await explainAttempt({ stateDir });
  assert.deepEqual(report.identity, { taskId: id.task_id, attemptId: id.attempt_id, epoch: 7, sha, outcome: 'done', reason: null });
  assert.equal(report.grade, 'VERIFIED');
  assert.deepEqual(report.models, { worker, critic, arbiter, workerFamily: 'deepseek', criticFamily: 'google', crossFamilyVerified: true });
  assert.deepEqual(report.gates.phases.map(p => [p.name, p.status, p.durationMs]), [
    ['l1_local', 'ok', 21], ['tamper', 'ok', 0], ['l3_visual', 'not_recorded', null],
    ['l2_critic', 'ok', 84], ['arbiter', 'not_recorded', null],
  ]);
  assert.equal(report.gates.reworkRounds, 0);
  assert.deepEqual(report.promptBom, { recorded: true, blocks: ['spec', 'scope fence', 'project memory'] });
  assert.match(report.blockingInvariants.join(' '), /clean worktree.*allowed_paths.*tamper/);
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
  assert.deepEqual(await explainAttempt({ stateDir }), report);
  assert.deepEqual((await readdir(stateDir)).sort(), Object.keys(files).sort());
  for (const [name, text] of Object.entries(files)) assert.equal(await readFile(join(stateDir, name), 'utf8'), text);
});

test('done does not imply verified: single or unknown family, absent or failed gate, stale snapshot', async t => {
  const stateDir = await fixture(t, { 'attempt.json': JSON.stringify(wal) });
  for (const patch of [
    { models: { worker: { provider: 'acp-antigravity-acp', model: critic.model }, critic } },
    { models: { worker: { provider: 'openai', model: critic.model }, critic } },
    { models: { worker } },
    { phases_status: { ...summary.phases_status, tamper: 'fail' } },
    { phases_status: { l1_local: 'ok', tamper: 'ok' } },
    { phases_status: { tamper: 'ok', l2_critic: 'ok' } },
    { outcome: 'working', open: true },
    { sha: 'b'.repeat(40) },
  ]) {
    await writeFile(join(stateDir, 'telemetry.jsonl'), ndjson({ ...summary, ...patch }));
    const report = await explainAttempt({ stateDir });
    assert.equal(report.grade, 'CHECKED', JSON.stringify(patch));
    assert.deepEqual(report.promptBom, { recorded: false, blocks: [] });
  }
});

test('held after rework: separates final reason from rejection history and avoids double counting', async t => {
  const stateDir = await fixture(t, {
    'attempt.json': JSON.stringify({ ...wal, phase: 'hold', reason: 'no_progress_deterministic_gate',
      roundsHistory: [{ sha: 'b'.repeat(40), gate: 'scope_fence' }, { sha, gate: 'tamper' }] }),
    'events.1.ndjson': ndjson({ ...id, kind: 'rework', phase: 'working', reason: 'scope_fence_violation' }),
    'telemetry.jsonl': ndjson({ ...summary, outcome: 'hold', rounds: { rework: 2, gates: { scope_fence: 1, tamper: 1 } } }),
  });
  const report = await explainAttempt({ stateDir });
  assert.equal(report.grade, 'HELD');
  assert.equal(report.identity.reason, 'no_progress_deterministic_gate');
  assert.equal(report.gates.reworkRounds, 2);
  assert.deepEqual(report.gates.gateFailures, { scope_fence: 1, tamper: 1 });
  assert.deepEqual(report.gates.reworkReasons, ['scope_fence_violation']);
  assert.equal(report.gates.phases.find(p => p.name === 'tamper').status, 'fail');
  assert.match(formatExplanation(report), /HELD[\s\S]*no_progress_deterministic_gate[\s\S]*scope_fence_violation/);
});

test('event-only historical attempt is isolated from current WAL; selector misses are errors', async t => {
  const historical = { task_id: 'older-task', attempt_id: 'older-attempt', epoch: 1 };
  const stateDir = await fixture(t, {
    'attempt.json': JSON.stringify({ ...wal, phase: 'working' }),
    'events.1.ndjson': ndjson({ ...historical, kind: 'phase', phase: 'checking', detail: { sha } }),
    'events.ndjson': ndjson({ ...historical, kind: 'question_blocked', phase: 'awaiting_answer',
      reason: 'owner_question', detail: { sha } }),
    'telemetry.jsonl': '  \n',
  });
  assert.equal((await explainAttempt({ stateDir })).grade, 'IN_PROGRESS');
  for (const filter of [{ taskId: historical.task_id }, { attemptId: historical.attempt_id }]) {
    const report = await explainAttempt({ stateDir, ...filter });
    assert.equal(report.grade, 'BLOCKED');
    assert.equal(report.identity.sha, sha);
    assert.equal(report.identity.reason, 'owner_question');
    assert.equal(report.models.worker, null);
    assert.equal(report.gates.reworkRounds, null);
  }
  await assert.rejects(explainAttempt({ stateDir, taskId: id.task_id, attemptId: historical.attempt_id }), /No matching attempt/);
});

test('idle WAL with multiple historical attempts requires disambiguation; old SHA is not proof', async t => {
  const stateDir = await fixture(t, { 'attempt.json': 'null',
    'events.1.ndjson': ndjson({ ...id, attempt_id: 'b', kind: 'phase', phase: 'checking', detail: { sha } }),
    'telemetry.jsonl': ndjson(summary, { ...summary, attempt_id: 'b' }) });
  await assert.rejects(explainAttempt({ stateDir, taskId: id.task_id }), /specify --attempt/);
  const report = await explainAttempt({ stateDir, attemptId: 'b' });
  assert.equal(report.identity.sha, null); // Telemetry does not invent a historical commit.
  assert.equal(report.grade, 'VERIFIED');
});

test('WAL-only models identify the executor, not the planned worker; a recorded empty BOM stays empty', async t => {
  const stateDir = await fixture(t, { 'attempt.json': JSON.stringify({ ...wal, executor: worker,
    triad: { worker: arbiter, critic, arbiter }, metadata: { promptBom: { blocks: [] } } }) });
  const report = await explainAttempt({ stateDir });
  assert.equal(report.grade, 'CHECKED');
  assert.deepEqual(report.models, { worker, critic, arbiter, workerFamily: 'deepseek', criticFamily: 'google', crossFamilyVerified: false });
  assert.deepEqual(report.promptBom, { recorded: true, blocks: [] });
});

test('CLI JSON is canonical; default text explains the same attempt', async t => {
  const stateDir = await fixture(t, { 'attempt.json': JSON.stringify(wal), 'telemetry.jsonl': ndjson(summary) });
  const report = await explainAttempt({ stateDir });
  const json = run('--state', stateDir, '--task', id.task_id, '--attempt', id.attempt_id, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stdout, canonicalJson(report) + '\n');
  const text = run('--state', stateDir);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, formatExplanation(report) + '\n');
  assert.match(text.stdout, /VERIFIED[\s\S]*Cross-family L2 verified: yes[\s\S]*Prompt context: not recorded/);
});

test('missing, empty, invalid and corrupt input: nonzero status, useful stderr, no JSON or stack trace', async t => {
  const stateDir = await fixture(t, { 'attempt.json': '\n' });
  function fails(args, message) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
  fails([], /--state/);
  fails(['--state', join(stateDir, 'missing')], /ENOENT/);
  fails(['--state', join(stateDir, 'attempt.json')], /ENOTDIR/);
  fails(['--state', stateDir], /No matching attempt/);
  await writeFile(join(stateDir, 'events.ndjson'), '\n{bad\n');
  fails(['--state', stateDir, '--json'], /events.ndjson:2: invalid JSON/);
});

test('refuses symlinked artifacts instead of reading through them', async t => {
  const stateDir = await fixture(t, { unrelated: JSON.stringify(wal) });
  await symlink('unrelated', join(stateDir, 'attempt.json'));
  await assert.rejects(explainAttempt({ stateDir }), /ELOOP/);
});
