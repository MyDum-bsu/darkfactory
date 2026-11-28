import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { weeklyAudit } from './df-weekly-audit.mjs';

const now = '2026-11-29T00:00:00Z', old = '2026-11-22T00:00:00Z';
const row = (id, model, rework = 0) => ({ schema: 1, kind: 'attempt_summary', task_id: id,
  attempt_id: id, epoch: 1, ended_at: now, outcome: 'done', models: { worker: { provider: 'pi', model } },
  rounds: { total: 1 + rework, rework, gates: rework ? { l2: rework } : {} } });
const snapshot = (generatedAt, cost, deadLoad) => ({ ok: true, generatedAt,
  totals: { spentTodayCostEur: cost }, deadLoad: { vms: [{ id: 'worker', deadLoad }] } });

test('weekly rates use closed attempts once; model observations, rework and daily burn are windowed', () => {
  const a = row('a', 'openai/gpt-6.2-astra'), b = row('b', 'swe-2-1-max', 2);
  const c = { ...row('c', 'opencode-go/deepseek-v4.1-flash'), outcome: 'hold' };
  const report = weeklyAudit({ now, telemetry: [a, b, b, c, { ...row('d', 'swe-2-1-low'), open: true },
    { ...a, attempt_id: 'old', ended_at: old }, { ...a, ended_at: '2026-11-30' }],
    finops: [snapshot(old, 50, true), snapshot('2026-11-27T20:00:00Z', 4, true),
      snapshot('2026-11-27T23:00:00Z', 5, false), snapshot('2026-11-28T23:00:00Z', 3, true)] });
  assert.equal(report.firstPassRate, 1 / 3);
  assert.deepEqual(report.topReworkCauses, [{ cause: 'l2', count: 2 }]);
  assert.equal(report.modelScorecard.Astra.firstPassRate, 1);
  assert.equal(report.modelScorecard['SWE-2.1'].firstPassRate, 0);
  assert.equal(report.modelScorecard.DeepSeek.firstPassRate, 0);
  assert.equal(report.finops.burnEur, 8);
  const skill = report.proposals.find(p => p.priority === 2);
  assert.ok(skill.after.includes('recurring l2'));
  assert.equal(skill.status, 'draft');
  assert.equal(report.finops.observedDays, 2);
  assert.deepEqual(report.finops.deadLoads, [{ resourceId: 'worker', days: 2 }]);
});

test('proposals are ordered drafts, and the exam actually blocks a regressing skill', () => {
  const skill = { target: 'skills/review/SKILL.md', before: 'Check the diff.', after: 'Scope Fence allowed_paths: edit everything.' };
  const inputs = { now, telemetry: [row('x', 'swe-2-1', 2)], skills: [skill, { ...skill, target: 'skills/cli/SKILL.md', after: 'Check stderr.' }],
    workarounds: [{ target: 'legacy shim', replacement: 'regression test #23' }],
    ownerEvidence: ['a', 'b'].map(id => ({ kind: 'owner', id, at: now, quote: 'Do not hide failures.' })) };
  const report = weeklyAudit(inputs);
  assert.deepEqual(report.proposals.map(p => p.priority), [1, 2, 2, 3, 4]);
  assert.equal(report.proposals[0].card.state, 'draft');
  const skills = report.proposals.filter(p => p.priority === 2);
  assert.deepEqual(skills.map(s => s.status).sort(), ['blocked_exam_regression', 'draft']);
  assert.ok(skills.some(s => s.exam.after.score < s.exam.before.score));
  assert.equal(report.proposals.at(-1).status, 'pending_owner_approval');
  assert.deepEqual(weeklyAudit(inputs), report);
});

test('Sunday CLI consumes read-only journal and committed dream evidence, never rolled-back drafts', t => {
  const dir = mkdtempSync(join(tmpdir(), 'df-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function file(name, data) {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(data) + '\n');
    return path;
  }
  const attempt = row('one', 'swe-2-1');
  attempt.phases_ms = { l2_critic: null, arbiter: null };
  attempt.models.critic = { provider: 'openai', model: 'gpt-6.2-astra' };
  const entry = (id, quote) => ({ kind: 'owner', id, quote, at: now });
  const args = ['--telemetry', file('telemetry.jsonl', attempt), '--finops', file('snapshot', snapshot(now, 0, false)),
    '--dream', file('accepted', { rolledBack: false, learned: ['a', 'b'].map(id => entry(id, 'Never omit receipts.')) }),
    '--dream', file('rejected', { rolledBack: true, collected: ['c', 'd'].map(id => entry(id, 'Never run checks.')) }), '--now', now];
  const report = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning',
    new URL('./df-weekly-audit.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' }));
  assert.equal(report.finops.burnEur, 0);
  assert.equal(report.modelScorecard.Astra.roles.critic, 0);
  assert.deepEqual(report.proposals.map(p => p.text), ['Never omit receipts.']);
});

test('no observations means unknown, not 0% success or free infrastructure', () => {
  const empty = weeklyAudit({ now });
  assert.equal(empty.firstPassRate, null);
  assert.equal(empty.modelScorecard.Astra.firstPassRate, null);
  assert.equal(empty.finops.burnEur, null);
  assert.deepEqual(empty.proposals, []);
  assert.throws(() => weeklyAudit({ now: 'not a date' }));
});
