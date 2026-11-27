// Offline projection of the controller WAL, event bus and attempt telemetry.
// No Board, Git, model calls or replay: missing evidence stays missing.
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson } from '../board_pipeline/subject.mjs';
import { roundGateOf } from '../board_pipeline/telemetry.mjs';

// Telemetry phase names and the corresponding round-history gate keys.
const GATES = { l1_local: 'l1', tamper: 'tamper', l3_visual: 'l3', l2_critic: 'l2', arbiter: 'arbiter' };
const INVARIANTS = [
  'Handoff must match the claimed task, epoch, attempt and worker thread.',
  'Candidate must equal clean worktree HEAD and descend from the pinned base.',
  'Scope Fence rejects changed paths outside the pinned allowed_paths when configured.',
  'Trusted L1 checks must pass; the enabled tamper gate rejects test or gate bypasses.',
  'Before settlement the seal rechecks the candidate, pinned inputs and live claim.',
];
const string = value => typeof value === 'string' && value.length ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const taskOf = row => string(row?.task_id ?? row?.taskId);
const attemptOf = row => string(row?.attempt_id ?? row?.attemptId);

async function readRecords(dir, name, single = false) {
  // Do not follow an artifact symlink outside the supplied state directory.
  const fd = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await fd.stat()).isFile()) throw new Error(`${name}: expected a regular file`);
    const text = await fd.readFile('utf8');
    const lines = single ? [text] : text.split('\n');
    const records = [];
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      const where = single ? name : `${name}:${i + 1}`;
      let row;
      try { row = JSON.parse(line); } catch { throw new Error(`${where}: invalid JSON`); }
      if (row === null && single) continue; // Idle queue WAL.
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${where}: expected an object`);
      records.push(row);
    }
    return records;
  } finally { await fd.close(); }
}

function selectAttempt(wal, summaries, events, taskId, attemptId) {
  const matches = row => attemptOf(row) && (!taskId || taskOf(row) === taskId) &&
    (!attemptId || attemptOf(row) === attemptId);
  // Current WAL is the default. Without one, don't arbitrarily pick a past
  // attempt by file order (seq restarts, and the journals rotate separately).
  const anchors = matches(wal) ? [wal] : [...summaries, ...events].filter(matches);
  if (!anchors.length) throw new Error('No matching attempt in attempt.json, events or telemetry');
  const ids = new Set(anchors.map(attemptOf));
  if (ids.size !== 1) throw new Error('Multiple matching attempts; specify --attempt');
  const id = attemptOf(anchors[0]);
  let related = [wal, ...summaries, ...events].filter(row => attemptOf(row) === id);
  function dimension(pinned, get) {
    if (pinned != null) return pinned;
    const values = new Set(related.map(get).filter(value => value != null));
    if (values.size > 1) throw new Error(`Conflicting identity for attempt ${id}`);
    return [...values][0] ?? null;
  }
  const task = dimension(taskId ?? (matches(wal) ? taskOf(wal) : null), taskOf);
  related = related.filter(row => taskOf(row) === task);
  const epoch = dimension(matches(wal) ? count(wal.epoch) : null, row => count(row.epoch));
  const belongs = row => attemptOf(row) === id && taskOf(row) === task && count(row.epoch) === epoch;
  return { taskId: task, attemptId: id, epoch, wal: belongs(wal) ? wal : null,
    summary: summaries.filter(belongs).at(-1), events: events.filter(belongs) };
}

function promptInventory(records) {
  const blocks = new Set();
  let recorded = false;
  for (const row of records) {
    for (const source of [row, row?.metadata, row?.detail]) {
      const bom = source?.promptBom ?? source?.prompt_bom;
      const list = Array.isArray(bom) ? bom : (bom?.recorded === false ? null : bom?.blocks) ??
        source?.contextBlocks ?? source?.context_blocks ?? (row?.kind === 'prompt_bom' ? source?.blocks : null);
      if (!Array.isArray(list)) continue;
      recorded = true;
      for (const item of list) {
        const label = string(item) ?? string(item?.id) ?? string(item?.name);
        if (label) blocks.add(label); // Labels only, never raw prompt text from metadata objects.
      }
    }
  }
  return { recorded, blocks: [...blocks] };
}

function summarizeGates(wal, summary, events, sha, reason) {
  const history = Array.isArray(wal?.roundsHistory) ? wal.roundsHistory : [];
  const reworks = events.filter(e => e.kind === 'rework');
  const reasons = [...new Set(reworks.map(e => string(e.reason)).filter(Boolean))];
  const rounds = summary?.rounds;
  const observed = Math.max(history.length, reworks.length);
  const measured = count(rounds?.rework);
  const reworkRounds = measured !== null || observed > 0 || Array.isArray(wal?.roundsHistory)
    ? Math.max(observed, measured ?? 0) : null;
  // Three overlapping views, not three sets of failures. A partial journal
  // or process restart may omit rounds; do not add duplicate observations.
  const gateFailures = {};
  for (const [phase, key] of [...Object.entries(GATES), ['scope_fence', 'scope_fence']]) {
    const latestFailed = summary?.phases_status?.[phase] === 'fail' || roundGateOf(reason) === key;
    const n = Math.max(Number(latestFailed), count(rounds?.gates?.[key]) ?? 0,
      history.filter(r => r?.gate === key).length, reworks.filter(e => roundGateOf(e.reason) === key).length);
    if (n) gateFailures[key] = n;
  }
  // phases_status describes port return/throw. A negative verdict can be a
  // normal return, so a recorded rejection of THIS SHA takes precedence.
  const rejected = new Set(history.filter(r => sha && r?.sha === sha).map(r => r.gate));
  rejected.add(roundGateOf(reason));
  const phases = Object.entries(GATES).map(([name, key]) => ({ name,
    status: rejected.has(key) ? 'fail' : string(summary?.phases_status?.[name]) ?? 'not_recorded',
    durationMs: count(summary?.phases_ms?.[name]) }));
  return { phases, reworkRounds, gateFailures, reworkReasons: reasons };
}

function modelSpec(spec) {
  if (typeof spec === 'string') return string(spec);
  return string(spec?.provider) && string(spec?.model) ? { provider: spec.provider, model: spec.model } : null;
}

// Offline counterpart of review-runner's attested provider/model pairs.
// Do not import the execution stack (including its YAML policy loader), or
// infer independence from two different harness/provider display names.
const FAMILY_PAIRS = [
  ['cognition', ['acp-devin', 'cognition'], ['swe-2-high', 'swe-2-medium', 'swe-2-low', 'swe-2-1',
    ...['low', 'medium', 'high', 'xhigh', 'max'].map(tier => `swe-2-1-${tier}`)]],
  ['deepseek', ['deepseek', 'opencode-go'], ['deepseek-v4.1-flash', 'deepseek-v4', 'deepseek-reasoner']],
  ['google', ['google', 'acp-antigravity-acp'], ['gemini-4-neon']],
  ['glm', ['glm', 'acp-zcode-start'], ['glm-5.3-flash', 'builtin:zai-start-plan\\glm-5.3-flash']],
  ['openai', ['openai'], ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-5.6-sol', 'codex']],
  ['anthropic', ['agy'], ['claude-opus-5.5']],
];
function executorFamily(spec) {
  if (!spec) return null;
  const id = (typeof spec === 'string' ? spec : `${spec.provider}/${spec.model}`).toLowerCase().replace(/^pi\//, '');
  const slash = id.indexOf('/');
  return FAMILY_PAIRS.find(([, providers, models]) =>
    providers.includes(id.slice(0, slash)) && models.includes(id.slice(slash + 1)))?.[0] ?? null;
}

function buildReport({ taskId, attemptId, epoch, wal, summary, events }) {
  const phaseEvent = events.findLast(e => ['phase', 'completed', 'hold', 'lease_lost', 'uncertain',
    'blocked', 'question_blocked', 'rework'].includes(e.kind) && string(e.phase));
  const outcome = string(wal?.phase) ?? string(wal?.outcome) ??
    (summary?.open !== true ? string(summary?.outcome) : null) ?? string(phaseEvent?.phase) ??
    string(summary?.outcome) ?? 'unknown';
  // A historical checking/rework event may describe a different candidate
  // from the terminal summary. Only bind a SHA from the selected outcome.
  const sha = string(wal?.sha) ?? (phaseEvent?.phase === outcome ? string(phaseEvent.detail?.sha) : null) ??
    (summary?.outcome === outcome ? string(summary.sha) : null);
  const reason = string(wal?.reason) ?? (phaseEvent?.phase === outcome ? string(phaseEvent.reason) : null) ??
    (summary?.outcome === outcome ? string(summary.reason) : null);
  // An open telemetry snapshot from a prior run of this same attempt is not
  // evidence for the now-completed candidate.
  const snapshot = (summary?.outcome && summary.outcome !== outcome) || (summary?.sha && summary.sha !== sha) ||
    (outcome === 'done' && summary?.open === true) ? null : summary;
  const gates = summarizeGates(wal, snapshot, events, sha, reason);
  const worker = modelSpec(wal?.executor ?? snapshot?.models?.worker ?? wal?.triad?.worker);
  const critic = modelSpec(snapshot?.models?.critic ?? wal?.triad?.critic);
  const arbiter = modelSpec(snapshot?.models?.arbiter ?? wal?.triad?.arbiter);
  const workerFamily = executorFamily(worker), criticFamily = executorFamily(critic);
  const ok = name => gates.phases.find(p => p.name === name).status === 'ok';
  const crossFamilyVerified = ok('l2_critic') && workerFamily !== null && criticFamily !== null && workerFamily !== criticFamily;
  let grade = 'IN_PROGRESS';
  if (outcome === 'done') grade = crossFamilyVerified && ok('l1_local') && ok('tamper') ? 'VERIFIED' : 'CHECKED';
  else if (['blocked', 'awaiting_answer'].includes(outcome)) grade = 'BLOCKED';
  else if (['hold', 'held', 'lease_lost', 'uncertain'].includes(outcome)) grade = 'HELD';
  return { identity: { taskId, attemptId, epoch, sha, outcome, reason }, grade,
    models: { worker, critic, arbiter, workerFamily, criticFamily, crossFamilyVerified }, gates,
    promptBom: promptInventory([wal, snapshot, ...events]), blockingInvariants: [...INVARIANTS] };
}

export async function explainAttempt({ stateDir, taskId, attemptId } = {}) {
  if (!string(stateDir)) throw new Error('A state directory (--state <dir>) is required');
  const names = await readdir(stateDir);
  const read = (name, single) => names.includes(name) ? readRecords(stateDir, name, single) : [];
  const [wal] = await read('attempt.json', true);
  const summaries = (await read('telemetry.jsonl')).filter(e => e.kind === 'attempt_summary' && e.schema === 1);
  const rotations = names.filter(name => /^events\.\d+\.ndjson$/.test(name))
    .sort((a, b) => Number(b.split('.')[1]) - Number(a.split('.')[1]));
  const events = [];
  for (const name of [...rotations, 'events.ndjson']) {
    for (const event of await read(name)) events.push(event);
  }
  return buildReport(selectAttempt(wal, summaries, events, taskId, attemptId));
}

export function formatExplanation({ identity: id, grade, models, gates, promptBom, blockingInvariants }) {
  const show = value => String(value ?? 'not recorded').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  const model = spec => show(typeof spec === 'object' && spec ? `${spec.provider}/${spec.model}` : spec);
  return [
    `${grade} | ${show(id.outcome)} | SHA ${show(id.sha)}`,
    `Task ${show(id.taskId)} / attempt ${show(id.attemptId)} / epoch ${show(id.epoch)}`,
    ...(id.reason ? [`Reason: ${show(id.reason)}`] : []), '',
    `Worker: ${model(models.worker)} (${show(models.workerFamily)})`,
    `Critic: ${model(models.critic)} (${show(models.criticFamily)})`, `Arbiter: ${model(models.arbiter)}`,
    `Cross-family L2 verified: ${models.crossFamilyVerified ? 'yes' : 'no'}`, '',
    'Gates (last status; accumulated phase time):', ...gates.phases.map(p =>
      `  ${p.name.padEnd(10)} ${show(p.status)}; ${p.durationMs === null ? 'time not recorded' : `${p.durationMs} ms`}`),
    `Rework rounds: ${show(gates.reworkRounds)}; gate failures: ${Object.entries(gates.gateFailures)
      .map(([gate, n]) => `${gate}=${n}`).join(', ') || 'none recorded'}`,
    ...(gates.reworkReasons.length ? [`Rework reasons: ${gates.reworkReasons.map(show).join(', ')}`] : []),
    `Prompt context: ${promptBom.recorded ? promptBom.blocks.map(show).join(', ') || '(empty)' : 'not recorded'}`, '',
    'Blocking invariants (controller policy, not additional observations):', ...blockingInvariants.map(s => `  - ${s}`),
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { state: { type: 'string' }, task: { type: 'string' },
      attempt: { type: 'string' }, json: { type: 'boolean' } } });
    const report = await explainAttempt({ stateDir: values.state, taskId: values.task, attemptId: values.attempt });
    console.log(values.json ? canonicalJson(report) : formatExplanation(report));
  } catch (error) {
    console.error(`df-explain: ${error.message}`);
    process.exitCode = 1;
  }
}
