import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { requireWorkspaceSpace } from './check-workspace-space.mjs';

const home = dirname(fileURLToPath(import.meta.url));
const POLICIES = new Map([
  ['openai/gpt-6.2-sol', 'review.pi.sol62.medium.v1'],
  ['openai/gpt-6.2-astra', 'review.pi.astra62.medium.v1'],
]);
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ADDRESS = /^t[a-z0-9]+$/;
const JOB_DIR = join(home, 'review-jobs');
const BOARD_URL = process.env.DF_REVIEW_BOARD_URL ?? 'http://127.0.0.1:44100/api/board';

function requireThat(value, message) {
  if (!value) throw new Error(message);
}
function validateIdentity(task, sha) {
  requireThat(typeof task === 'string' && /^[1-9][0-9]{0,14}$/.test(task), 'task must be a positive Board ID');
  requireThat(typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha), 'sha must be the exact full revision');
}
export function prepareReview(request, configured) {
  validateIdentity(request.task, request.sha);
  requireThat(request['permission-mode'] === undefined || request['permission-mode'] === 'accept-edits',
    'unsupported explicit review mode');
  const { source, task, sha } = request;
  requireThat(typeof source === 'string' && (ADDRESS.test(source) ||
    new RegExp(`^df-${task.slice(0, 12)}-[a-f0-9]{10}$`).test(source)), 'invalid source terminal');
  const preset = { provider: 'pi', model: configured?.model, reasoningLevel: 'medium' };
  const policy = POLICIES.get(preset.model);
  requireThat(policy, 'review preset does not match an approved route');
  for (const [key, value] of Object.entries(preset)) {
    requireThat(configured[key] === value && (request[key] === undefined || request[key] === value),
      `review requires ${preset.provider} / ${preset.model} / ${preset.reasoningLevel}: incompatible ${key}`);
  }
  return { policy, preset, task, sha, source };
}

function reviewerLabels(job) {
  return { 'herdr.space': job.spaceId, 'herdr.tab': `L2 #${job.task}`, 'darkfactory.role': 'critic', 'darkfactory.task': job.task };
}
function reviewerCommand(job) {
  const { policy, preset } = prepareReview(job, job.preset);
  requireThat(job.policy === policy, 'invalid review receipt policy');
  requireThat(SESSION_ID.test(job.sessionId) && isAbsolute(job.sessionDir) && isAbsolute(job.promptFile),
    'review requires an enrolled session and prompt');
  return [process.execPath, fileURLToPath(import.meta.url), 'run-pi', '--print',
    '--no-approve', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files',
    '--tools', 'read,grep,find,ls', '--model', preset.model, '--thinking', preset.reasoningLevel,
    '--session-id', job.sessionId, '--session-dir', job.sessionDir, '--', `@${job.promptFile}`];
}
export function hcReviewerArguments(job) {
  requireThat(typeof job.spaceId === 'string' && job.spaceId.trim() && !/[\x00-\x1f\x7f]/.test(job.spaceId) &&
    isAbsolute(job.worktree), 'review requires a local Herdr space and worktree');
  return ['run', '--bg', '--no-parent', '--no-notify', '--json', '--cwd', job.worktree,
    ...Object.entries(reviewerLabels(job)).flatMap(([k,v]) => ['--label', `${k}=${v}`]), '--', ...reviewerCommand(job)];
}

// The trusted terminal wrapper emits this only after Pi exits. The model's
// screen text is never a verdict; the digest binds the independent native log.
function checkpointStamp(session, checkpoint) {
  const hash = createHash('sha256').update(JSON.stringify(session)).digest('base64url');
  return `L2:${checkpoint}:${hash}`;
}

export function parseReviewOutcome(job, { head, clean, reviewer, session, terminalRead }) {
  requireThat(job.phase === 'launched' && ADDRESS.test(job.threadId ?? ''), 'no confirmed launch receipt');
  requireThat(head === job.sha && clean === true, 'reviewed revision changed or checkout has tracked changes');
  requireThat(reviewer?.address === job.threadId && reviewer.cwd === job.worktree &&
    Object.entries(reviewerLabels(job)).every(([k,v]) => reviewer.labels?.[k] === v) &&
    isDeepStrictEqual(reviewer.argv, reviewerCommand(job)), 'review terminal or route changed');
  requireThat(reviewer.state === 'finished' && reviewer.exit_code === 0 && (!reviewer.reason || reviewer.reason === 'exited'),
    'review terminal has not completed successfully');
  const [header, ...entries] = session;
  requireThat(header?.type === 'session' && header.id === job.sessionId && header.cwd === job.worktree,
    'native Pi session mismatch');
  let parent = null, effort, last, userTurns = 0;
  const ids = new Set();
  for (const entry of entries) {
    requireThat(/^[a-f0-9]{8,64}$/.test(entry.id ?? '') && !ids.has(entry.id) && entry.parentId === parent,
      'invalid native checkpoint chain');
    ids.add(entry.id);
    parent = entry.id;
    if (entry.type === 'thinking_level_change') effort = entry.thinkingLevel;
    if (entry.type !== 'message') continue;
    last = entry;
    if (entry.message.role === 'user') userTurns++;
    if (entry.message.role !== 'assistant') continue;
    requireThat(userTurns === 1 && `${entry.message.provider}/${entry.message.model}` === job.preset.model &&
      effort === job.preset.reasoningLevel, 'native Pi turn or runtime route mismatch');
  }
  requireThat(userTurns === 1 && last?.message.role === 'assistant' && last.message.stopReason === 'stop',
    'checkpoint is not a final assistant message');
  const stamp = checkpointStamp(session, last.id);
  requireThat(terminalRead?.text?.split(/\r?\n/).filter(line => line.trimEnd() === stamp).length === 1,
    'native checkpoint does not match terminal completion');
  const lines = last.message.content.filter(part => part.type === 'text').flatMap(part => part.text.split(/\r?\n/));
  // Count indented markers as ambiguous, but never accept one as the verdict.
  const verdicts = lines.map(line => line.trimEnd()).filter(line => /^\s*REVIEW_[A-Z_]+$/.test(line));
  const [verdict] = verdicts;
  requireThat(verdicts.length === 1 && ['REVIEW_OK', 'REVIEW_REWORK'].includes(verdict) &&
    lines.findLast(line => line.trimEnd())?.trimEnd() === verdict, 'missing or ambiguous final review verdict');
  const excerpt = verdict === 'REVIEW_REWORK' ? lines.filter(line => line.trimEnd() !== verdict).join('\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, 1400) : undefined;
  requireThat(verdict !== 'REVIEW_REWORK' || excerpt, 'rework has no objection');
  return { policy: job.policy, task: job.task, sha: job.sha, threadId: job.threadId, criticTerminal: job.threadId,
    sessionId: header.id, checkpoint: last.id, actual: { provider: last.message.provider, model: last.message.model,
      reasoningLevel: job.preset.reasoningLevel }, verdict, excerpt };
}

function invokeJson(bin, args, env = process.env) {
  try {
    return JSON.parse(execFileSync(bin, args, { encoding:'utf8', env, timeout:35000, maxBuffer:32*1024*1024,
      stdio:['ignore','pipe','pipe'] }));
  } catch (error) {
    throw new Error(`${bin.split('/').pop()} ${args[0]}: failed (${error.code || error.status || 'invalid JSON'})`);
  }
}
const hc = (...args) => invokeJson('hc', args);
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
  requireThat(typeof path === 'string' && isAbsolute(path), 'terminal does not expose a local worktree');
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
  const source = hc('get','--json','--',plan.source);
  requireThat((source.address === plan.source || source.name === plan.source) && source.labels?.['darkfactory.task'] === plan.task,
    'source terminal does not match Board task');
  const worktree = source.cwd;
  const current = gitState(worktree);
  requireThat(current.head===plan.sha && current.clean,'target revision must match and have no tracked changes');
  await requireWorkspaceSpace(worktree, 'review');
  requireThat(values['prompt-file'] && isAbsolute(values['prompt-file']), 'prompt-file must be absolute');
  const body = await readFile(values['prompt-file'],'utf8');
  requireThat(body.trim() && Buffer.byteLength(body) <= 65536, 'review prompt must be nonempty and at most 64 KiB');
  await mkdir(JOB_DIR,{recursive:true,mode:0o700});
  const receipt = jobPath(plan.task,plan.sha);
  const intent = { ...plan, spaceId: source.labels['herdr.space'], worktree, phase:'intent', createdAt:new Date().toISOString(),
    sessionId: randomUUID(), sessionDir: receipt + '.sessions', promptFile: receipt + '.md',
    promptSha256:createHash('sha256').update(body).digest('hex') };
  const args = hcReviewerArguments(intent);
  try { await saveNew(receipt,intent); }
  catch (error) { if (error.code==='EEXIST') throw new Error('launch already exists for this task and revision; do not retry blindly'); throw error; }
  try {
    await mkdir(intent.sessionDir, {mode:0o700});
    await writeFile(intent.promptFile, `Independent, read-only review for Board #${plan.task} at ${plan.sha}. No writes, subagents, other providers, CI or release actions. Finish with exactly one verdict line: REVIEW_OK or REVIEW_REWORK.\n\n${body}\n`, { flag:'wx',mode:0o600 });
  } catch (error) {
    try { await unlink(receipt); } catch { /* Preserve the setup error. */ }
    throw error;
  }
  const spawned = hc(...args);
  requireThat(ADDRESS.test(spawned.address ?? ''), 'launch did not return a terminal address; reconcile before retrying');
  const launched = { ...intent, phase:'launched', threadId:spawned.address };
  try {
    await saveNew(receipt+'.tmp',launched);
    await rename(receipt+'.tmp',receipt);
  } catch (error) {
    hc('kill', '--json', '--', spawned.address);
    throw error;
  }
  return { policy:plan.policy, task:plan.task, sha:plan.sha, threadId:spawned.address, criticTerminal:spawned.address, state:spawned.state };
}

async function nativeSession(dir, sessionId) {
  const files = await readdir(dir);
  requireThat(files.length === 1 && files[0].endsWith(`_${sessionId}.jsonl`), 'no unique native Pi session');
  const native = join(dir, files[0]);
  requireThat((await lstat(native)).isFile(), 'native Pi evidence is not a regular file');
  return (await readFile(native,'utf8')).trimEnd().split('\n').map(row => JSON.parse(row));
}

// Executed *inside* the terminal. Seal the evidence when Pi exits, not when
// an operator later asks to verify it. A stale/edited JSONL is not a receipt.
async function runPi(args) {
  execFileSync('pi', args, { stdio: 'inherit' });
  const dir = args[args.indexOf('--session-dir') + 1];
  const sessionId = args[args.indexOf('--session-id') + 1];
  const session = await nativeSession(dir, sessionId);
  console.log('\n' + checkpointStamp(session, session.findLast(e => e.type === 'message')?.id));
}

async function verify(values) {
  validateIdentity(values.task,values.sha);
  const receipt = jobPath(values.task,values.sha);
  const job=await loadJson(receipt);
  requireThat(job.task===values.task && job.sha===values.sha && job.phase==='launched' && ADDRESS.test(job.threadId ?? '') &&
    job.sessionDir === receipt+'.sessions' && job.promptFile === receipt+'.md', 'no matching launch receipt');
  const reviewer=hc('get','--json','--',job.threadId);
  const session = await nativeSession(job.sessionDir, job.sessionId);
  const terminalRead = hc('read', '--json', '--lines', '20', '--', job.threadId);
  const proof=parseReviewOutcome(job,{ ...gitState(job.worktree), reviewer, session, terminalRead });
  if (values.publish) {
    vb('--as','review-gate','reply',job.task,`[Подтверждённый запуск ревью] ${proof.verdict}; hc ${proof.threadId}; Pi/${proof.actual.provider}/${proof.actual.model}, ${proof.actual.reasoningLevel}; SHA ${proof.sha}; native checkpoint ${proof.checkpoint}.`,
      '--no-sync','--idempotency-key',`review-proof-${job.task}-${job.sha}`);
  }
  return proof;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  try {
    const [op,...args]=process.argv.slice(2);
    if (op === 'run-pi') {
      await runPi(args);
    } else await cli(op, args);
  } catch (error) {
    console.error(`review gate: ${error.message}`);
    process.exitCode=1;
  }
}

async function cli(op, args) {
  requireThat(op==='launch'||op==='verify','usage: board-review.mjs launch|verify --task ID --sha SHA');
  const options={task:{type:'string'},sha:{type:'string'}};
  if (op==='launch') for (const key of ['source','prompt-file','provider','model','reasoning-level','permission-mode']) {
    options[key]={type:'string'};
  }
  else options.publish={type:'boolean'};
  const {values}=parseArgs({args,options});
  const result=op==='launch'?await start(values):await verify(values);
  console.log(JSON.stringify(result,null,2));
}
