#!/usr/bin/env node
// Sunday read-only job. Pass the week's slot journals (including rotations)
// and saved Control Room FinOps snapshots as JSONL, oldest segment first.
// Optional inventory is JSON {skills:[{target,before,after}],workarounds:
// [{target,replacement}]}; evidence of a replacement nominates a deletion,
// it does NOT authorize one. --dream reads morning reports for tier 4.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { roleInvoked, SCORE_ROLES } from '../board_pipeline/model-scorecard.mjs';
import { TELEMETRY_SCHEMA } from '../board_pipeline/telemetry.mjs';
import { distillTaste } from '../board_pipeline/taste-distiller.mjs';
import { runExam } from './df-dream.mjs';

const usage = `df-weekly-audit --telemetry telemetry.jsonl [--finops snapshots.jsonl] [--dream morning.json] [--inventory drafts.json] [--now ISO] (journal/report paths repeatable)
Schedule on Sundays (e.g. 0 6 * * 0 UTC). Stdout contains private draft proposals; nothing is enqueued or applied.`;
const DAY = 86_400_000;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const count = n => Number.isSafeInteger(n) && n >= 0;
const text = s => typeof s === 'string' && !!s.trim();
const rate = (n, total) => total ? n / total : null;
const families = ['Astra', 'SWE-2.1', 'DeepSeek'];
function family(model) {
  const id = model?.split('/').at(-1)?.toLowerCase();
  if (/^(?:gpt-[\d.]+-)?astra$/.test(id)) return 'Astra';
  if (/^swe-2[.-]1(?:-|$)/.test(id)) return 'SWE-2.1';
  if (/^deepseek(?:-|$)/.test(id)) return 'DeepSeek';
  return null;
}

function weeklyAttempts(rows, inWindow) {
  const attempts = new Map();
  for (const row of rows) {
    if (row?.kind !== 'attempt_summary' || row.schema !== TELEMETRY_SCHEMA || row.open === true ||
        !text(row.outcome) || !text(row.attempt_id) || !inWindow(row.ended_at)) continue;
    const key = JSON.stringify([row.task_id, row.epoch, row.attempt_id]);
    const prior = attempts.get(key);
    if (!prior || Date.parse(row.ended_at) >= Date.parse(prior.ended_at)) attempts.set(key, row);
  }
  return [...attempts.values()];
}

function quality(attempts) {
  const scorecard = Object.fromEntries(families.map(name => [name,
    { workerAttempts: 0, measured: 0, firstPass: 0, criticCatches: 0, roles: { worker: 0, critic: 0, arbiter: 0 } }]));
  const causes = new Map();
  let passed = 0, measured = 0;
  const add = (key, n) => causes.set(key, (causes.get(key) ?? 0) + n);
  for (const row of attempts) {
    const rework = row.rounds?.rework;
    // Partial worker windows can hide a rework in a previous process.
    const known = row.outcome !== 'done' || (count(rework) && (rework > 0 || row.partial !== true));
    const first = known && row.outcome === 'done' && rework === 0;
    measured += Number(known); passed += Number(first);
    for (const role of SCORE_ROLES) {
      if (!roleInvoked(row, role)) continue;
      const cell = scorecard[family(row.models[role].model)];
      if (!cell) continue;
      cell.roles[role]++;
      if (role === 'critic' && row.rounds?.gates?.l2 > 0) cell.criticCatches++;
      if (role === 'worker') { cell.workerAttempts++; cell.measured += Number(known); cell.firstPass += Number(first); }
    }
    if (!count(rework) || !rework) continue;
    const gates = Object.entries(row.rounds?.gates ?? {}).filter(([, n]) => count(n) && n);
    const explained = gates.reduce((sum, [, n]) => sum + n, 0);
    // A gate count can also describe a terminal hold. Do not attribute more
    // rework causes than there were rework rounds.
    if (explained <= rework) for (const [key, n] of gates) add(key, n);
    const unknown = explained <= rework ? rework - explained : rework;
    if (unknown) add('unattributed', unknown);
  }
  for (const cell of Object.values(scorecard)) {
    cell.firstPassRate = rate(cell.firstPass, cell.measured);
    cell.criticCatchRate = rate(cell.criticCatches, cell.roles.critic);
  }
  const topReworkCauses = [...causes].map(([cause, n]) => ({ cause, count: n }))
    .sort((a, b) => b.count - a.count || compare(a.cause, b.cause));
  return { closedAttempts: attempts.length, measuredAttempts: measured, firstPassRate: rate(passed, measured),
    topReworkCauses, modelScorecard: scorecard };
}

function finances(snapshots, inWindow, since) {
  const days = new Map(), dead = new Map();
  for (const row of snapshots) {
    if (row?.ok !== true || !inWindow(row.generatedAt)) continue;
    const ms = Date.parse(row.generatedAt), day = new Date(ms).toISOString().slice(0, 10);
    const cost = row.totals?.spentTodayCostEur;
    // Cumulative *daily* values: use only the latest measured snapshot per
    // UTC day. Never sum monthly projections, or charge a partial opening
    // day's pre-window burn. Missing coverage is exposed, not extrapolated.
    if (Date.parse(day) >= since && Number.isFinite(cost) && cost >= 0 && (!days.has(day) || days.get(day).ms <= ms)) days.set(day, { ms, cost });
    for (const vm of row.deadLoad?.vms ?? []) {
      if (vm?.deadLoad !== true || !text(vm.id)) continue;
      if (!dead.has(vm.id)) dead.set(vm.id, new Set());
      dead.get(vm.id).add(day);
    }
  }
  const burn = [...days.values()].reduce((sum, { cost }) => sum + cost, 0);
  return { observedDays: days.size, burnEur: days.size ? Number(burn.toFixed(4)) : null,
    deadLoads: [...dead].sort(([a], [b]) => compare(a, b)).map(([resourceId, dates]) => ({ resourceId, days: dates.size })) };
}

function guard(title, evidence, acceptance) {
  return { priority: 1, kind: 'guard', card: { state: 'draft', title, evidence, acceptance } };
}

function skillProposal({ target, before, after }) {
  if (!text(target) || typeof before !== 'string' || !text(after) || before === after) throw new Error('Expected a concrete skill edit');
  const examine = content => runExam(content.split(/\r?\n/).filter(text).map((quote, line) => ({ id: `${target}:${line + 1}`, quote })));
  const exam = { before: examine(before), after: examine(after) };
  return { priority: 2, kind: 'skill_update', target, before, after, exam,
    status: exam.after.score < exam.before.score ? 'blocked_exam_regression' : 'draft' };
}

// Only propose a default skill edit for a recurring, attributed gate. Read
// fixed repo targets, never a path supplied by telemetry or an inventory.
function recurringSkillEdits(causes) {
  const edits = new Map();
  for (const { cause, count: hits } of causes) {
    if (hits < 2) continue;
    const guidance = cause === 'scope_fence' ? ['model-prompting-guides',
      'Before routing, compare every planned test and implementation path with the card’s path list.'] :
      cause === 'l1' || cause === 'l2' ? ['darkfactory-feature-blueprint',
        `For recurring ${cause} findings, identify the previously rejected behavior and its regression fixture in the acceptance criteria.`] : null;
    if (!guidance) continue;
    const [skill, rule] = guidance, target = `.agents/skills/${skill}/SKILL.md`;
    if (!edits.has(target)) {
      const before = readFileSync(new URL(`../${target}`, import.meta.url), 'utf8');
      edits.set(target, { target, before, after: before });
    }
    const edit = edits.get(target);
    if (!edit.after.includes(rule)) edit.after = `${edit.after.trimEnd()}\n\n- ${rule}\n`;
  }
  return [...edits.values()].filter(edit => edit.before !== edit.after);
}

export function weeklyAudit({ now = new Date().toISOString(), telemetry = [], finops = [], skills,
  workarounds = [], ownerEvidence = [] } = {}) {
  const end = Date.parse(now), since = end - 7 * DAY;
  if (!Number.isFinite(end)) throw new Error('Invalid audit clock');
  const inWindow = at => { const ms = Date.parse(at); return ms > since && ms <= end; };
  const metrics = quality(weeklyAttempts(telemetry, inWindow));
  const spend = finances(finops, inWindow, since);
  const proposals = metrics.topReworkCauses.map(evidence => guard(`Catch ${evidence.cause} before handoff`, evidence,
    'Replay a failing round in an offline regression test: reject the bad candidate and pass its corrected counterpart.'));
  for (const vm of spend.deadLoads) proposals.push(guard(`Detect idle running compute: ${vm.resourceId}`, vm,
    'A no-task fixture must raise one idle alert; a claimed-task fixture must raise none. Do not stop resources.'));
  for (const edit of skills ?? recurringSkillEdits(metrics.topReworkCauses)) proposals.push(skillProposal(edit));
  for (const { target, replacement } of workarounds) {
    if (!text(target) || !text(replacement)) throw new Error('Missing workaround replacement evidence');
    proposals.push({ priority: 3, kind: 'delete_obsolete_workaround', target, replacement, status: 'draft',
      acceptance: 'Verify the cited replacement covers the original failure before deleting the workaround.' });
  }
  for (const item of distillTaste(ownerEvidence.filter(e => inWindow(e?.at)))) proposals.push({ priority: 4, kind: 'taste_rule', ...item });
  return { window: { sinceExclusive: new Date(since).toISOString(), untilInclusive: new Date(end).toISOString() },
    ...metrics, finops: spend, proposals };
}

function readJournal(paths = []) {
  return paths.flatMap(path => readFileSync(path, 'utf8').split('\n').flatMap((line, i) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { throw new Error(`Invalid JSON: ${path}:${i + 1}`); }
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const paths = { type: 'string', multiple: true };
    const { values: v } = parseArgs({ options: { telemetry: paths, finops: paths, dream: paths,
      inventory: { type: 'string' }, now: { type: 'string' }, help: { type: 'boolean' } } });
    if (v.help) console.log(usage);
    else {
      if (!v.telemetry?.length) throw new Error(usage);
      const inventory = v.inventory ? JSON.parse(readFileSync(v.inventory, 'utf8')) : {};
      const ownerEvidence = (v.dream ?? []).flatMap(path => {
        const report = JSON.parse(readFileSync(path, 'utf8'));
        return report.rolledBack === false ? report.learned : [];
      });
      console.log(JSON.stringify(weeklyAudit({ now: v.now, telemetry: readJournal(v.telemetry), finops: readJournal(v.finops),
        skills: inventory.skills, workarounds: inventory.workarounds, ownerEvidence })));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
