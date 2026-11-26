import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { CASES } from '../board_pipeline/ab-pilot.mjs';
import { collectTelemetry, diffSnapshots } from '../board_pipeline/telemetry-collector.mjs';
import { normalizeCost, normalizeUsage, sumUsages } from '../board_pipeline/telemetry.mjs';
import { canonicalDigest } from '../board_pipeline/subject.mjs';
import { loadRoleRegistry } from '../board_pipeline/role-registry.mjs';
import { matchesNativeStageWitness } from '../board_pipeline/bb-stage-adapter.mjs';

const ARMS = ['linear', 'foreman'];
const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const id = /^thr_[a-z0-9]+$/;
const readObject = async path => JSON.parse(await readFile(path, 'utf8'));
async function readLines(path) {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function bbJson(args) {
  return JSON.parse((await exec('bb', args, { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 })).stdout);
}
async function readBb(run, threadId, policy, taskId, role, workspace) {
  if (!id.test(threadId ?? '')) throw new Error('ab_metrics_thread_invalid');
  const { thread, environment } = await bbJson(['thread', 'show', threadId, '--json']);
  if (thread?.id !== threadId || thread.parentThreadId !== policy.abPilot.parent ||
      thread.projectId !== policy.bb.project || environment?.path !== join(run, workspace)) throw new Error('ab_metrics_thread_unbound');
  const events = await bbJson(['thread', 'log', threadId, '--all', '--json']);
  if (events.some(event => event.threadId !== threadId)) throw new Error('ab_metrics_log_unbound');
  const requested = events.filter(event => event.type === 'client/turn/requested');
  const terminals = events.filter(event => event.type === 'turn/completed');
  const usageEvent = events.findLast(event => event.type === 'thread/tokenUsage/updated');
  const usage = normalizeUsage(usageEvent?.data?.tokenUsage?.total);
  const cost = normalizeCost(usageEvent?.data?.tokenUsage?.total);
  const complete = requested.length === 1 && terminals.length === 1 && terminals[0].data?.status === 'completed' &&
    usageEvent?.seq > requested[0].seq && thread.status === 'idle';
  const terminal = complete ? terminals[0] : null;
  const native = terminal?.scope?.kind === 'turn' ? { eventSeq: terminal.seq,
    session: terminal.data.providerThreadId, checkpoint: terminal.data.providerCheckpointId } : null;
  return { id: threadId, task_id: taskId, channel: 'ab-pilot', status: complete ? 'completed' : 'interrupted',
    provider: thread.providerId, model: requested[0]?.data?.execution?.model ?? null, role, usage, cost_usd: cost, complete, native };
}

const hex64 = value => /^[a-f0-9]{64}$/.test(value ?? '');
const sandboxTransport = value => value === 'docker-ro-v1' || value === 'landlock-ro-v1';
const validActual = actual => actual !== null && typeof actual === 'object' &&
  ['provider', 'model', 'reasoningLevel'].every(key => typeof actual[key] === 'string' && actual[key].length > 0);

function matchesSandboxStageWitness(row, stage, history, accepted) {
  return row !== null && typeof row === 'object' && stage === row.stage && row.stage === history?.stage &&
    row.verdict === 'PASS' && history?.verdict === 'PASS' && row.artifactDigest === history?.digest &&
    hex64(row.artifactDigest) && hex64(row.snapshotDigest) && hex64(row.challenge) && hex64(row.transcript_sha256) &&
    row.mode === 'read-only' && sandboxTransport(row.transport) && row.threadId === `sandbox:${row.transport}` &&
    row.worktreeFingerprint?.head === accepted?.sha && validActual(row.actual);
}

async function stagesCovered(run, policy, stages, accepted, threads) {
  const native = new Map(threads.filter(row => row.role === 'stage').map(row => [row.id, row.native]));
  const registry = await loadRoleRegistry(policy.abPilot.catalog);
  const graph = registry.playbooks[policy.abPilot.playbook];
  if (!graph || registry.digest !== policy.abPilot.registryDigest) return false;
  const planned = [];
  for (let next = graph.entry; next !== 'ready' && next !== 'hold'; next = graph.stages[next].next.pass) planned.push(next);
  const receipts = await readLines(join(run, 'state/ab-stage-receipts.jsonl'));
  const traces = await readLines(join(run, 'state/ab-foreman.jsonl'));
  const trace = traces[0];
  const confirmed = traces.length === 1 && trace.status === 'ready_for_native_acceptance' &&
    trace.candidate === accepted?.sha && trace.subject === accepted?.subject_digest &&
    Array.isArray(trace.history) && receipts.length === trace.history.length;
  if (!confirmed) return false;
  if (stages.length === 0) {
    return planned.length === receipts.length && planned.every((stage, i) =>
      matchesSandboxStageWitness(receipts[i], stage, trace.history[i], accepted));
  }
  return planned.length === stages.length && stages.length === receipts.length && planned.every((stage, i) => {
    const row = receipts[i];
    return stage === stages[i].stage && stage === row.stage && row.threadId === stages[i].threadId &&
      row.verdict === 'PASS' && trace.history[i].stage === stage && trace.history[i].verdict === 'PASS' &&
      row.artifactDigest === trace.history[i].digest && hex64(row.artifactDigest) &&
      matchesNativeStageWitness(row, native.get(row.threadId));
  });
}

async function readCell(root, name, arm) {
  const run = join(root, `${name}-${arm}`);
  const outcome = await readObject(join(run, 'outcome.json'));
  if (outcome.runnerSha !== undefined && !/^[a-f0-9]{40}$/.test(outcome.runnerSha)) throw new Error('ab_metrics_runner_invalid');
  const policy = await readObject(join(run, 'operator/policy.json'));
  const receipt = await readObject(join(run, 'board-receipt.json'));
  if (outcome?.name !== name || outcome.arm !== arm || receipt?.id !== outcome.taskId ||
      receipt.task?.state !== outcome.board || !Number.isSafeInteger(outcome.elapsed_ms) || outcome.elapsed_ms < 0) {
    throw new Error('ab_metrics_cell_unconfirmed');
  }
  const runs = await readLines(join(run, 'state/telemetry.jsonl'));
  const stages = await readLines(join(run, 'state/ab-stage-threads.jsonl'));
  if (runs.length !== 1 || runs[0].task_id !== outcome.taskId || stages.some(row => row?.taskId !== outcome.taskId)) {
    throw new Error('ab_metrics_attempt_unbound');
  }
  const attempt = runs[0];
  const wal = await readObject(join(run, 'state/attempt.json'));
  if (wal?.taskId !== outcome.taskId || wal.attemptId !== attempt.attempt_id || wal.threadId !== attempt.bb_thread_id) {
    throw new Error('ab_metrics_wal_unbound');
  }
  const bb = [];
  if (attempt.bb_thread_id) bb.push(await readBb(run, attempt.bb_thread_id, policy, name, 'worker', 'worktree'));
  for (const stage of stages) bb.push(await readBb(run, stage.threadId, policy, name, 'stage', 'observer'));
  if (new Set(bb.map(row => row.id)).size !== bb.length) throw new Error('ab_metrics_duplicate_thread');
  const closed = outcome.exit === 0 && outcome.board === 'completed' && attempt.outcome === 'done';
  let accepted = null;
  if (outcome.board === 'completed') {
    accepted = typeof receipt.task.result === 'string' ? JSON.parse(receipt.task.result) : receipt.task.result;
    if (!closed || wal.phase !== 'done' || !/^[a-f0-9]{40}$/.test(wal.sha ?? '') || accepted?.sha !== wal.sha) {
      throw new Error('ab_metrics_completion_unconfirmed');
    }
  }
  const first = closed && attempt.rounds.total === 1 && attempt.rounds.pass === 1 && attempt.rounds.rework === 0;
  const modelUsages = [attempt.tokens?.worker ?? bb[0]?.usage ?? null, attempt.tokens?.critic ?? null,
    ...(attempt.tokens?.arbiter ? [attempt.tokens.arbiter] : []), ...bb.filter(item => item.role === 'stage').map(item => item.usage)];
  const fragment = sumUsages(modelUsages);
  // A truncated turn or aggregate L2 receipt cannot prove complete coverage of a cell.
  const witnessedStages = arm === 'linear' ? stages.length === 0 : await stagesCovered(run, policy, stages, accepted, bb);
  const allStages = arm === 'linear' ? witnessedStages : first && witnessedStages;
  const completeRoles = first && attempt.rounds.arbitration === 0 && allStages && bb.length > 0 && bb.every(row => row.complete);
  const coverage = completeRoles &&
    modelUsages.every(usage => usage && usage.input !== null && usage.output !== null && usage.cached !== null);
  const costs = [bb[0]?.cost_usd ?? null, normalizeCost(attempt.costs?.critic),
    ...bb.filter(item => item.role === 'stage').map(item => item.cost_usd)];
  const completeCost = completeRoles && costs.every(value => value !== null);
  const envelope = { case: name, arm, closed, first_round_pass: first, elapsed_ms: outcome.elapsed_ms,
    rework: attempt.rounds.rework, attempted_rounds: attempt.rounds.total, stage_threads: stages.length,
    stage_witness_coverage: arm === 'foreman' ? (witnessedStages ? 1 : 0) : null,
    tokens: coverage ? fragment : null, known_tokens: fragment,
    cost_usd: completeCost ? costs.reduce((sum, value) => sum + value, 0) : null };
  const pinned = canonicalDigest({ base: outcome.baseSha, checks: policy.profiles.case.checks,
    review: policy.profiles.case.review, worker: { provider: policy.bb.provider, model: policy.bb.model },
    arbiter: policy.arbiter, routing: policy.routing, timeout: policy.waitMs,
    brief: sha(await readFile(join(run, 'operator/brief.md'))), reviewPrompt: sha(await readFile(join(run, 'operator/review.md'))) });
  return { envelope, pinned, bb, runnerSha: outcome.runnerSha ?? null, attempt: { ...attempt, task_id: name } };
}

async function snapshot(cells) {
  const stats = await collectTelemetry({ boardTasks: cells.map(({ envelope: e }) => ({ task_id: e.case,
    channel: 'ab-pilot', state: e.closed ? 'completed' : 'open', wall_clock_ms: e.elapsed_ms })),
  telemetryRuns: cells.map(row => row.attempt), bbThreads: cells.flatMap(row => row.bb) });
  const all = cells.map(row => row.envelope);
  stats.portfolio.first_round_pass_rate = all.filter(e => e.first_round_pass).length / all.length;
  stats.portfolio.avg_rework_rounds = all.reduce((total, e) => total + e.rework, 0) / all.length;
  stats.portfolio.median_wall_clock_ms = all.reduce((total, e) => total + e.elapsed_ms, 0) / all.length;
  stats.portfolio.tokens = all.every(e => e.tokens !== null) ? sumUsages(all.map(e => e.tokens)) : null;
  stats.portfolio.cost_usd = all.every(e => e.cost_usd !== null) ? all.reduce((sum, e) => sum + e.cost_usd, 0) : null;
  return { ...stats, channels: [], models: [] }; // do not present partial per-model totals as whole-arm metrics
}

try {
  const root = process.argv[2], legacy = process.argv[3];
  if (!isAbsolute(root ?? '') || await realpath(root) !== root) throw new Error('Use absolute pilot evidence root');
  const cells = {};
  for (const arm of ARMS) {
    cells[arm] = [];
    for (const name of Object.keys(CASES)) cells[arm].push(await readCell(root, name, arm));
  }
  if (cells.linear.some((cell, i) => cell.pinned !== cells.foreman[i].pinned)) throw new Error('ab_metrics_pair_mismatch');
  const revisions = new Set(ARMS.flatMap(arm => cells[arm].map(row => row.runnerSha)));
  if (revisions.size !== 1) throw new Error('ab_metrics_runner_mismatch');
  const [recorded] = revisions;
  if (recorded === null ? !/^[a-f0-9]{40}$/.test(legacy ?? '') : legacy !== undefined) {
    throw new Error('ab_metrics_runner_unconfirmed');
  }
  const provenance = { runnerSha: recorded ?? legacy, source: recorded ? 'recorded' : 'operator-declared-legacy' };
  const [a, b] = await Promise.all(ARMS.map(arm => snapshot(cells[arm])));
  const envelopes = ARMS.flatMap(arm => cells[arm].map(row => row.envelope));
  const delta = diffSnapshots(a, b).portfolio;
  if (envelopes.some(row => !row.closed)) delta.median_wall_clock_ms.speedup_pct = null;
  console.log(JSON.stringify({ provenance, timing: 'controller_until_exit', cells: envelopes, delta }, null, 2));
} catch (error) {
  console.error('ab-pilot-compare:', error.message.split('\n')[0]);
  process.exitCode = 1;
}
