// Managed intake is opt-in on the enrolled fleet project's operator policy:
// intake_mode: managed_dispatcher, teamlead: { owner_actor, arbiter_actor },
// policyDigest, projectMemory and decisionLedger.sqlitePath. Owner posts are roots
// in <repo_id>/requests (an optional allowed_paths label bounds every card).
// An authenticated arbiter posts there with decision=SPLIT and a
// verbatim_request_id pointing to the owner root, or replies to that root.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkChannel } from './board-stigmergy.mjs';
import { resolveIntakeMode } from './field-mode.mjs';
import { inside } from './fs-safe.mjs';
import { resolveHerdrSpace } from './herdr-spaces.mjs';
import { teamleadIntakePrompt } from './intake-prompt.mjs';
import { createPilotSwitch } from './pilot-gate.mjs';
import { resolveMemoryStoreDir, resolveProjectMemory } from './project-memory.mjs';
import { verbatimOwnerRequestBlock } from './review-policy.mjs';
import { parseAllowedPaths } from './scope-fence.mjs';
import { readUnifiedDecisionSlice } from './unified-ledger.mjs';
import { scrubbedWorkerChildEnv } from './worker-runtime.mjs';

const exec = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const actor = id => typeof id === 'string' && !!id.trim() && id.length <= 256;
const fail = code => { throw new Error(code); };

// No worker executor, shell tool, MCP, project extensions, or Board client is
// exposed to the model. Only the trusted wrapper writes stdout to a private
// scratch file (hc screen output is not a lossless structured transport).
export async function runProjectTeamlead(project, prompt, { docsPath, execFile = exec, signal } = {}) {
  const cwd = await realpath(project.repo_dir);
  const space = await resolveHerdrSpace({ ...project, repo_dir: cwd,
    herdrSpaceId: project.policyData?.route?.herdrSpaceId ?? project.herdrSpaceId }, { docsPath });
  const temp = await realpath(tmpdir());
  if (inside(cwd, temp) || inside(project.worktree, temp)) fail('teamlead_scratch_inside_project');
  const scratch = await mkdtemp(join(temp, 'df-teamlead-'));
  const output = join(scratch, 'plan.json');
  try {
    // The terminal metadata and process list need only the private file name.
    const input = join(scratch, 'request.txt');
    await writeFile(input, prompt, { mode: 0o600 });
    const argv = ['run', '--no-parent', '--no-notify', '--rm', '--timeout', '240', '--cwd', cwd,
      '--label', `herdr.space=${space}`, '--label', 'darkfactory.role=teamlead', '--',
      '/bin/sh', '-c', 'umask 077; exec "$@" > "$0"', output, 'timeout', '-k', '5s', '180s',
      'pi', '--print', '--provider', 'google', '--model', 'gemini-4-neon', '--no-session', '--no-tools',
      '--no-mcp', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-approve', '--', `@${input}`];
    // Keep private terminal diagnostics out of dispatcher logs.
    await execFile('hc', argv, { signal, timeout: 250_000, env: scrubbedWorkerChildEnv(process.env) })
      .catch(() => fail('teamlead_hc_failed'));
    const json = await readFile(output, 'utf8');
    try { return JSON.parse(json); } catch { fail('teamlead_plan_invalid'); }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

// Require topological order: a dependency can only name an earlier key in
// this batch. Model output supplies no labels, routing, IDs or owner quotes.
function boardCards(plan, policy, message, block) {
  const { cards } = plan ?? {};
  if (!Array.isArray(cards) || !cards.length || cards.length > 100) fail('teamlead_plan_invalid');
  const keys = new Set();
  const fence = message.labels?.allowed_paths;
  const ceiling = fence === undefined ? null : parseAllowedPaths(fence);
  return cards.map(card => {
    if (!card || Object.keys(card).some(k => !['key', 'text', 'needs', 'allowed_paths'].includes(k)) ||
        !token(card.key) || card.key.length > 64 || keys.has(card.key) ||
        typeof card.text !== 'string' || !card.text.trim() || !Array.isArray(card.needs) ||
        card.needs.length > 20 || new Set(card.needs).size !== card.needs.length ||
        !card.needs.every(dep => keys.has(dep))) fail('teamlead_plan_invalid');
    const allowed = card.allowed_paths ?? fence;
    const paths = parseAllowedPaths(allowed);
    if (allowed.length > 256 || (ceiling && paths.some(path => !ceiling.some(limit =>
      path === limit || (limit.endsWith('/') && path.startsWith(limit)))))) fail('teamlead_scope_invalid');
    keys.add(card.key);
    const text = `${card.text}\n\n${block}`;
    if (text.length > 10_000) fail('teamlead_card_too_long'); // never truncate the original
    return { key: card.key, text, needs: card.needs.map(key => ({ key })), noSync: true,
      labels: { [policy.label.key]: policy.label.value, repo_id: policy.route.repoId,
        profile_id: policy.route.checkProfile, finish: 'verified', policy_digest: policy.policyDigest,
        allowed_paths: allowed, verbatim_request_id: message.id, spec_digest: digest(text) } };
  });
}

async function projectKnowledge(project) {
  const { repo_id: projectId, policyData: policy } = project;
  const dbPath = policy.decisionLedger?.sqlitePath ?? process.env.DF_UNIFIED_LEDGER_DB;
  const storeDir = resolveMemoryStoreDir({ policy: policy.projectMemory });
  const workspaces = [project.repo_dir, project.worktree, policy.handoffDir].filter(Boolean);
  if (!dbPath || await realpath(dbPath) !== dbPath || workspaces.some(dir => inside(dir, dbPath))) {
    fail('teamlead_ledger_path_invalid');
  }
  if (!storeDir || await realpath(storeDir) !== storeDir || workspaces.some(dir => inside(dir, storeDir) || inside(storeDir, dir))) {
    fail('teamlead_memory_path_invalid');
  }
  return {
    memory: await resolveProjectMemory({ projectId, storeDir, worktree: project.repo_dir }),
    decisions: readUnifiedDecisionSlice({ projectId, dbPath }),
  };
}

// Single project's Board long-poll subscription, independent of ready-card
// polls and writer capacity. A batch ID is also its durable Board receipt:
// replay (including after a lost POST reply) does not invoke the lead again.
export async function watchProjectRequests(project, { signal, docsPath, execFile, fetchImpl = fetch } = {}) {
  const policy = project.policyData;
  if (resolveIntakeMode(policy) !== 'managed_dispatcher') return;
  const lead = policy.teamlead;
  const channel = checkChannel(project.channel);
  if (!token(project.repo_id) || policy.route?.repoId !== project.repo_id ||
      channel !== policy.channel || !actor(lead?.owner_actor) || !actor(lead.arbiter_actor) ||
      lead.owner_actor === lead.arbiter_actor || !/^[0-9a-f]{64}$/.test(policy.policyDigest ?? '') ||
      policy.route.finish !== 'verified') fail('teamlead_policy_invalid');
  const requests = checkChannel(`${project.repo_id}/requests`);
  const checkSwitch = await createPilotSwitch(policy.pilot.killSwitch);
  async function guard() {
    signal?.throwIfAborted();
    if (await readFile(project.policy, 'utf8') !== project.bytes) fail('fleet_policy_changed');
    await checkSwitch();
  }
  async function board(path, { body, missingBatch = false } = {}) {
    const res = await fetchImpl(`${policy.boardUrl}${path}`, { redirect: 'error', method: body ? 'POST' : 'GET',
      signal: AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]),
      headers: { 'content-type': 'application/json', accept: 'application/json',
        'x-board-can': `${requests}=read;${channel}=read,post,label`,
        ...(process.env.BOARD_PROFILE ? { 'x-board-profile': process.env.BOARD_PROFILE } : {}),
        ...(process.env.BOARD_TOKEN ? { authorization: `Bearer ${process.env.BOARD_TOKEN}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (missingBatch && res.status === 404 && (await res.json()).error?.code === 'batch_not_found') return undefined;
    if (!res.ok) fail(`teamlead_board_http_${res.status}`);
    return res.json();
  }
  let after = '0';
  while (!signal?.aborted) {
    const page = await board(`/events?${new URLSearchParams({ channel: requests, after, wait: '25' })}`);
    if (!Array.isArray(page.events) || !token(page.cursor)) fail('teamlead_events_invalid');
    for (const { type, message: trigger } of page.events) {
      if (type !== 'message.posted' || trigger?.channel !== requests || trigger.deleted) continue;
      const split = trigger.by?.actor === lead.arbiter_actor && trigger.labels?.decision === 'SPLIT';
      if (!split && (trigger.re !== null || trigger.by?.actor !== lead.owner_actor ||
          typeof trigger.text !== 'string' || !trigger.text.trim())) continue; // e.g. attachment-only post
      if (!token(trigger.id)) fail('teamlead_event_invalid');
      await guard();
      const batch = digest(JSON.stringify(['teamlead', project.repo_id, channel, trigger.id]));
      const existing = await board(`/tasks/batch/${batch}`, { missingBatch: true });
      if (existing !== undefined) {
        if (!Array.isArray(existing?.tasks) || !existing.tasks.length || existing.tasks.some(t => t.channel !== channel)) {
          fail('teamlead_batch_invalid');
        }
        continue;
      }
      let owner = trigger;
      if (split) {
        const id = trigger.labels.verbatim_request_id ?? trigger.re;
        if (!token(id) || (trigger.re !== null && id !== trigger.re)) fail('verbatim_request_invalid');
        owner = (await board(`/messages/${encodeURIComponent(id)}?limit=1`)).message;
        if (owner?.id !== id || owner.channel !== requests || owner.by?.actor !== lead.owner_actor ||
            owner.re !== null || owner.deleted || owner.editedAt) fail('verbatim_request_invalid');
      }
      const block = verbatimOwnerRequestBlock({ verbatim_request_id: owner.id, verbatim_owner_quote: owner.text });
      const fence = owner.labels?.allowed_paths;
      if (fence !== undefined) parseAllowedPaths(fence);
      const prompt = teamleadIntakePrompt({ requestBlock: block, splitContext: split && trigger.text, fence,
        ...await projectKnowledge(project) });
      const plan = await runProjectTeamlead(project, prompt, { docsPath, execFile, signal });
      const tasks = boardCards(plan, policy, owner, block);
      await guard();
      const receipt = await board('/tasks/batch', { body: { channel, id: batch, tasks } });
      if (receipt?.tasks?.length !== tasks.length || !receipt.tasks.every(t => t.channel === channel)) {
        fail('teamlead_batch_invalid');
      }
    }
    after = page.cursor;
  }
}
