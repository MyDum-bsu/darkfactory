import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { requireWorkspaceSpace } from './check-workspace-space.mjs';

const home = dirname(fileURLToPath(import.meta.url));
const POLICIES = new Map([
  ['openai/gpt-6.2-sol', 'review.pi.sol62.medium.v1'],
  ['openai/gpt-6.2-astra', 'review.pi.astra62.medium.v1'],
]);
const approvedPreset = model => ({ provider: 'pi', model, reasoningLevel: 'medium' });
function jobPreset(job) {
  const preset = approvedPreset(job.preset?.model);
  requireThat(POLICIES.has(preset.model) && POLICIES.get(preset.model) === job.policy &&
    Object.entries(preset).every(([k, v]) => job.preset?.[k] === v), 'invalid review receipt preset');
  return preset;
}
const SESSION_ID = /^pi_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const THREAD_ID = /^thr_[a-z0-9]+$/;
const JOB_DIR = join(home, 'review-jobs');
const BOARD_URL = process.env.DF_REVIEW_BOARD_URL ?? 'http://127.0.0.1:44100/api/board';

function requireThat(value, message) {
  if (!value) throw new Error(message);
}

function validateIdentity(task, sha) {
  requireThat(/^[1-9][0-9]{0,14}$/.test(task ?? ''), 'task must be a positive Board ID');
  requireThat(/^[0-9a-f]{40}$/.test(sha ?? ''), 'sha must be the exact full revision');
}

export function prepareReview(request, configured) {
  validateIdentity(request.task, request.sha);
  requireThat(THREAD_ID.test(request.source ?? ''), 'source must be a BB thread ID');
  const preset = approvedPreset(configured?.model);
  const policy = POLICIES.get(preset.model);
  requireThat(policy, 'review preset does not match an approved route');
  for (const [key, value] of Object.entries(preset)) {
    requireThat(configured?.[key] === value, `review preset does not match ${policy}: ${key}`);
    requireThat(request[key] === undefined || request[key] === value,
      `review requires ${preset.provider} / ${preset.model} / ${preset.reasoningLevel}: incompatible ${key}`);
  }
  return { policy, preset, task: request.task, sha: request.sha, source: request.source };
}

export function reviewerArguments(job, scope, promptFile) {
  requireThat(/^proj_[a-z0-9]+$/.test(scope.projectId ?? '') && /^env_[a-z0-9]+$/.test(scope.environmentId ?? ''),
    'review requires an existing BB project and environment');
  const preset = jobPreset(job);
  return ['thread','spawn','--project',scope.projectId,'--environment',scope.environmentId,
    '--parent-thread',job.source,'--parent-notifications','off', '--provider',preset.provider,'--model',preset.model,
    '--reasoning-level',preset.reasoningLevel,'--title',`Ревью #${job.task} · ${job.sha.slice(0,7)}`,
    '--prompt-file',promptFile,'--json'];
}

function oneEvent(events, type) {
  const matching = events.filter(e => e.type === type);
  requireThat(matching.length === 1, `review requires exactly one ${type} event`);
  return matching[0];
}

function binding(events, preset) {
  const request = oneEvent(events, 'client/turn/requested');
  const start = oneEvent(events, 'turn/started');
  const end = oneEvent(events, 'turn/completed');
  requireThat(request.seq < start.seq && start.seq < end.seq && end.data?.status === 'completed', 'review turn not completed');
  requireThat(request.data?.execution?.model === preset.model && request.data.execution.reasoningLevel === preset.reasoningLevel,
    'review request route does not match preset');
  const sessionId = start.data?.providerThreadId;
  requireThat(SESSION_ID.test(sessionId ?? '') && end.data?.providerThreadId === sessionId,
    'cannot bind the review to one native Pi session');
  const checkpoint = end.data?.providerCheckpointId;
  requireThat(typeof checkpoint === 'string' && /^[0-9a-f]{8,64}$/.test(checkpoint), 'missing or invalid checkpoint');
  return { sessionId, checkpoint };
}

export function attestReview(job, observed) {
  requireThat(job.phase === 'launched' && THREAD_ID.test(job.threadId ?? ''), 'no confirmed launch receipt');
  const preset = jobPreset(job);
  requireThat(observed.head === job.sha && observed.clean, 'reviewed revision changed or checkout has tracked changes');
  requireThat(observed.reviewer?.providerId === preset.provider && observed.reviewer.environmentId === job.environmentId,
    'review thread provider or environment has changed');
  requireThat(observed.reviewer.status === 'idle', 'review thread is not idle');
  const { sessionId, checkpoint } = binding(observed.events, preset);
  const at = observed.session.findIndex(e => e.id === checkpoint);
  requireThat(at >= 0, 'native Pi checkpoint not found');
  let effort;
  let assistantCount = 0;
  for (const entry of observed.session.slice(0, at+1)) {
    if (entry.type === 'thinking_level_change') effort = entry.thinkingLevel;
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    assistantCount++;
    requireThat(`${entry.message.provider}/${entry.message.model}` === preset.model, 'runtime model does not match preset');
    requireThat(effort === preset.reasoningLevel, 'runtime reasoning does not match preset');
  }
  const last = observed.session[at].message;
  requireThat(assistantCount > 0 && last?.role === 'assistant' && last.stopReason === 'stop', 'checkpoint is not a final assistant message');
  const lines = last.content.filter(part=>part.type==='text').flatMap(part=>part.text.split(/\r?\n/));
  const isVerdict = line => ['REVIEW_OK', 'REVIEW_BLOCKED'].includes(line.trim());
  const verdicts = lines.filter(isVerdict).map(line=>line.trim());
  requireThat(verdicts.length === 1, 'missing or ambiguous final review verdict');
  const excerpt = verdicts[0] === 'REVIEW_BLOCKED'
    ? lines.filter(line => !isVerdict(line)).join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 1400)
    : undefined;
  requireThat(verdicts[0] !== 'REVIEW_BLOCKED' || excerpt, 'blocked review has no objection');
  return { policy: job.policy, task: job.task, sha: job.sha, threadId: job.threadId, sessionId, checkpoint,
    actual: { provider: last.provider, model: last.model, reasoningLevel: effort }, verdict: verdicts[0], excerpt };
}

function invokeJson(bin, args, env = process.env) {
  try {
    return JSON.parse(execFileSync(bin, args, { encoding:'utf8', env, timeout:35000, maxBuffer:32*1024*1024,
      stdio:['ignore','pipe','pipe'] }));
  } catch (error) {
    throw new Error(`${bin.split('/').pop()} ${args[0]}: failed (${error.code || error.status || 'invalid JSON'})`);
  }
}
const bb = (...args) => invokeJson('bb', args);
function vb(...args) {
  requireThat(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/api\/board$/.test(BOARD_URL), 'review Board must be loopback');
  return invokeJson(join(home,'node_modules/.bin/vb'), ['--url',BOARD_URL,...args,'--json'],
    { ...process.env, XDG_CONFIG_HOME:join(home,'config') });
}
async function loadJson(path) { return JSON.parse(await readFile(path,'utf8')); }
function lookupBoardTask(root, id) {
  if (!root || typeof root !== 'object') return null;
  if (String(root.id) === id && root.task?.state) return root;
  for (const value of Object.values(root)) {
    const match = lookupBoardTask(value,id);
    if (match) return match;
  }
  return null;
}

function gitState(path) {
  requireThat(typeof path === 'string' && isAbsolute(path), 'BB environment does not expose a local worktree');
  const call = args=>execFileSync('git',['-C', path,...args],{encoding:'utf8',timeout:10000}).trim();
  return { head:call(['rev-parse','HEAD']), clean:!call(['status','--porcelain=v1','--untracked-files=no']) };
}
function jobPath(task, sha) { return join(JOB_DIR, `${task}-${sha}.json`); }
async function saveNew(path, object) {
  await writeFile(path, JSON.stringify(object,null,2)+'\n', { flag:'wx', mode:0o600 });
}
async function start(values) {
  const routes = process.env.DF_REVIEW_ROUTES ?? join(home,'routes.json');
  requireThat(isAbsolute(routes), 'review policy must be an absolute operator file');
  const preset = (await loadJson(routes)).workerPresets?.reviewer;
  const plan = prepareReview({...values, reasoningLevel:values['reasoning-level']},preset);
  const boardTask = lookupBoardTask(vb('read',plan.task),plan.task);
  requireThat(boardTask && ['ready','claimed'].includes(boardTask.task.state), 'Board task is not ready or claimed');
  const source = bb('thread','show',plan.source,'--json');
  const scope = { projectId:source.thread?.projectId, environmentId:source.thread?.environmentId };
  const path = source.environment?.path;
  const current = gitState(path);
  requireThat(current.head===plan.sha && current.clean,'target revision must match and have no tracked changes');
  await requireWorkspaceSpace(path, 'review');
  requireThat(values['prompt-file'] && isAbsolute(values['prompt-file']), 'prompt-file must be absolute');
  const body = await readFile(values['prompt-file'],'utf8');
  requireThat(body.trim() && Buffer.byteLength(body) <= 65536, 'review prompt must be nonempty and at most 64 KiB');
  await mkdir(JOB_DIR,{recursive:true,mode:0o700});
  const receipt = jobPath(plan.task,plan.sha);
  const prompt = receipt.replace(/\.json$/,'.md');
  const intent = { ...plan, ...scope, worktree:path, phase:'intent', createdAt:new Date().toISOString(),
    promptSha256:createHash('sha256').update(body).digest('hex') };
  try { await saveNew(receipt,intent); }
  catch (error) { if (error.code==='EEXIST') throw new Error('launch already exists for this task and revision; do not retry blindly'); throw error; }
  await writeFile(prompt, `Independent, read-only review for Board #${plan.task} at ${plan.sha}. No writes, subagents, other providers, CI or release actions. Finish with exactly one verdict line: REVIEW_OK or REVIEW_BLOCKED.\n\n${body}\n`, { flag:'wx',mode:0o600 });
  const spawned = bb(...reviewerArguments(plan,scope,prompt));
  requireThat(THREAD_ID.test(spawned.id ?? ''), 'BB launch did not return a thread ID; reconcile before retrying');
  const launched = { ...intent, phase:'launched', threadId:spawned.id };
  const temp=receipt+'.tmp';
  await saveNew(temp,launched);
  await rename(temp,receipt);
  return { policy:plan.policy, task:plan.task, sha:plan.sha, threadId:spawned.id, state:spawned.status };
}

async function verify(values) {
  validateIdentity(values.task,values.sha);
  const job=await loadJson(jobPath(values.task,values.sha));
  requireThat(job.task===values.task && job.sha===values.sha && job.phase==='launched' && THREAD_ID.test(job.threadId ?? ''), 'no matching launch receipt');
  const reviewer=bb('thread','show',job.threadId,'--json');
  requireThat(reviewer.environment?.path===job.worktree,'reviewer workspace changed');
  const state=gitState(job.worktree);
  const events=bb('thread','log',job.threadId,'--all','--json');
  const {sessionId}=binding(events, jobPreset(job));
  const native=join(homedir(),'.bb/plugins/provider-pi/bridge-data/sessions',sessionId+'.jsonl');
  requireThat((await lstat(native)).isFile(),'native Pi evidence is not a regular file');
  const session=(await readFile(native,'utf8')).split('\n').filter(Boolean).map(row=>JSON.parse(row));
  const proof=attestReview(job,{ ...state, reviewer:reviewer.thread,events,session });
  if (values.publish) {
    vb('--as','review-gate','reply',job.task,`[Подтверждённый запуск ревью] ${proof.verdict}; BB ${proof.threadId}; Pi/${proof.actual.provider}/${proof.actual.model}, ${proof.actual.reasoningLevel}; SHA ${proof.sha}; native checkpoint ${proof.checkpoint}.`,
      '--no-sync','--idempotency-key',`review-proof-${job.task}-${job.sha}`);
  }
  return proof;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  try {
    const [op,...args]=process.argv.slice(2);
    requireThat(op==='launch'||op==='verify','usage: board-review.mjs launch|verify --task ID --sha SHA');
    const options={task:{type:'string'},sha:{type:'string'}};
    if (op==='launch') for (const key of ['source','prompt-file','provider','model','reasoning-level']) options[key]={type:'string'};
    else options.publish={type:'boolean'};
    const {values}=parseArgs({args,options});
    const result=op==='launch'?await start(values):await verify(values);
    console.log(JSON.stringify(result,null,2));
  } catch (error) {
    console.error(`review gate: ${error.message}`);
    process.exitCode=1;
  }
}
