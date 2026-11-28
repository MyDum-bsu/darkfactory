import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hcReviewerArguments, parseReviewOutcome, prepareReview } from './board-review.mjs';

const sha = '1'.repeat(40);
const preset = { provider: 'pi', model: 'openai/gpt-6.2-sol', reasoningLevel: 'medium' };
const request = { task: '66', source: 'df-66-0123456789', sha };
const sessionId = '12345678-0123-4567-8901-123456789012';
const job = () => ({ ...prepareReview(request, preset), spaceId: 'space-one', worktree: '/repo',
  sessionId, sessionDir: '/journal/session', promptFile: '/journal/prompt.md', phase: 'launched', threadId: 't7' });
function evidence(j, text = 'REVIEW_OK', { model = j.preset.model.split('/')[1], effort = 'medium', checkpoint = 'cafebabe' } = {}) {
  const args = hcReviewerArguments(j);
  const observed = { head: sha, clean: true, reviewer: { address: j.threadId, cwd: j.worktree, state: 'finished', exit_code: 0,
    labels: Object.fromEntries(args.flatMap((v, i) => v === '--label' ? [args[i + 1].split('=')] : [])),
    argv: args.slice(args.indexOf('--') + 1) }, session: [
    { type: 'session', id: sessionId, cwd: j.worktree },
    { type: 'thinking_level_change', id: 'deadbeef', parentId: null, thinkingLevel: effort },
    { type: 'message', id: 'feedface', parentId: 'deadbeef', message: { role: 'user' } },
    { type: 'message', id: 'cafebabe', parentId: 'feedface', message: { role: 'assistant', provider: 'openai',
      model, stopReason: 'stop', content: [{ type: 'text', text }] } },
  ] };
  const digest = createHash('sha256').update(JSON.stringify(observed.session)).digest('base64url');
  return { ...observed, terminalRead: { text: `REVIEW_OK\nL2:${checkpoint}:${digest}\n` } };
}

test('reject Codex or a 6.1 request before producing any spawn arguments', () => {
  assert.throws(() => prepareReview({...request,provider:'codex',model:'gpt-6.1-sol'},preset), /review.*pi.*6\.2/i);
  assert.throws(() => prepareReview(request,{...preset,model:'openai/gpt-6.1-sol'}), /preset/i);
});

test('the one valid route pins provider, model, effort and environment', () => {
  const j = job();
  const args = hcReviewerArguments(j);
  assert.equal(args[args.indexOf('--cwd') + 1], j.worktree);
  assert.ok(args.includes('run-pi'));
  assert.equal(args[args.indexOf('--model') + 1], 'openai/gpt-6.2-sol');
  assert.equal(args[args.indexOf('--thinking') + 1], 'medium');
  assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.ok(args.includes('--no-approve'));
  assert.throws(() => prepareReview({ ...request, 'permission-mode': 'full' }, preset), /review mode/);
  const explicit = prepareReview({ ...request, 'permission-mode': 'accept-edits' }, preset);
  assert.deepEqual(hcReviewerArguments({ ...j, ...explicit }), args); // cannot grant write tools
});

test('accepts real runtime metadata only when it matches the pinned route and SHA', () => {
  const j = job();
  const proof = parseReviewOutcome(j, evidence(j));
  assert.equal(proof.actual.provider,'openai');
  assert.equal(proof.actual.model,'gpt-6.2-sol');
  assert.equal(proof.actual.reasoningLevel,'medium');
  assert.equal(proof.verdict,'REVIEW_OK');
  assert.equal(proof.sha,sha);
  assert.equal(proof.task, request.task);
});

test('requested 6.2 cannot hide actual 6.1, missing effort or a different checkpoint', () => {
  const j = job();
  // Even an internally consistent completion stamp cannot authorize route drift.
  assert.throws(() => parseReviewOutcome(j, evidence(j, 'REVIEW_OK', { model: 'gpt-6.1-sol' })), /runtime route/);
  assert.throws(() => parseReviewOutcome(j, evidence(j, 'REVIEW_OK', { effort: 'low' })), /runtime route/);
  assert.throws(() => parseReviewOutcome(j, evidence(j, 'REVIEW_OK', { effort: null })), /runtime route/);
  assert.throws(() => parseReviewOutcome(j, evidence(j, 'REVIEW_OK', { checkpoint: '01234567' })), /checkpoint/);
});

// Same route-binding regression as before the migration; hc argv is now the startup evidence.
test('explicit Astra requires Astra at BB startup and at the native checkpoint', () => {
  const expected = { ...preset, model: 'openai/gpt-6.2-astra' };
  const astra = { ...job(), ...prepareReview(request, expected) };
  const observed = evidence(astra);
  assert.equal(parseReviewOutcome(astra, observed).actual.model, 'gpt-6.2-astra');
  assert.throws(() => parseReviewOutcome(astra, evidence(astra, 'REVIEW_OK', { model: 'gpt-6.2-sol' })), /runtime route/);
  observed.reviewer.argv = evidence(job()).reviewer.argv;
  assert.throws(() => parseReviewOutcome(astra, observed), /terminal or route changed/);
});

test('drift, absent launch receipt, and absent verdict fail closed', () => {
  const j = job();
  assert.throws(() => parseReviewOutcome(j, { ...evidence(j), head: '2'.repeat(40) }), /revision/i);
  assert.throws(() => parseReviewOutcome({ ...j, phase: 'intent' }, evidence(j)), /launch/i);
  assert.throws(() => parseReviewOutcome(j, evidence(j, 'looks fine')), /verdict/i);
  assert.throws(() => parseReviewOutcome(j, evidence(j, 'REVIEW_REWORK')), /no objection/);
  const blocked = parseReviewOutcome(j, evidence(j, 'Bad input: expected refusal\nREVIEW_REWORK'));
  assert.equal(blocked.verdict, 'REVIEW_REWORK');
  assert.equal(blocked.excerpt, 'Bad input: expected refusal');
});

test('gate only launches direct hc and pins a read-only Pi invocation to the task and revision', async () => {
  assert.doesNotMatch(await readFile(new URL('./board-review.mjs', import.meta.url), 'utf8'), /\b(?:bb|getbb)\b/i);
  const args = hcReviewerArguments(job());
  assert.deepEqual(args.slice(0, 5), ['run', '--bg', '--no-parent', '--no-notify', '--json']);
  for (const label of ['herdr.space=space-one', 'herdr.tab=L2 #66', 'darkfactory.role=critic', 'darkfactory.task=66']) {
    assert.ok(args.some((v, i) => v === '--label' && args[i + 1] === label));
  }
  for (const [flag, value] of [['--model', preset.model], ['--thinking', 'medium'], ['--session-id', sessionId]]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.equal(prepareReview({ ...request, source: 't2abc' }, preset).source, 't2abc');
  for (const changed of [{ source: '-arg' }, { source: 'df-77-0123456789' }, { task: '66/..' }, { sha: 'ab' }, { model: 'other' }]) {
    assert.throws(() => prepareReview({ ...request, ...changed }, preset));
  }
  assert.throws(() => prepareReview(request, { ...preset, reasoningLevel: 'low' }));
});

test('receipt comes from the bound final native checkpoint, deterministically for either approved route', () => {
  for (const model of [preset.model, 'openai/gpt-6.2-astra']) {
    const j = { ...job(), ...prepareReview(request, { ...preset, model }) };
    const proof = parseReviewOutcome(j, evidence(j));
    assert.deepEqual(proof, parseReviewOutcome(j, evidence(j)));
    assert.equal(proof.verdict, 'REVIEW_OK');
    assert.equal(proof.sessionId, sessionId);
    assert.equal(proof.criticTerminal, 't7');
    assert.equal(proof.checkpoint, 'cafebabe');
    assert.deepEqual(proof.actual, { provider: 'openai', model: model.split('/')[1], reasoningLevel: 'medium' });
    const rework = parseReviewOutcome(j, evidence(j, 'Fix missing lookup\nREVIEW_REWORK'));
    assert.equal(rework.verdict, 'REVIEW_REWORK');
    assert.equal(rework.excerpt, 'Fix missing lookup');
  }
});

test('accepts a verdict followed only by horizontal whitespace and trailing blank lines', () => {
  const j = job();
  for (const suffix of ['  ', '\t', ' \t']) {
    assert.equal(parseReviewOutcome(j, evidence(j, `REVIEW_OK${suffix}\n\n`)).verdict, 'REVIEW_OK');
    const rework = parseReviewOutcome(j, evidence(j, `Fix the route\nREVIEW_REWORK${suffix}`));
    assert.equal(rework.verdict, 'REVIEW_REWORK');
    assert.equal(rework.excerpt, 'Fix the route');
  }
  for (const text of [' REVIEW_REWORK\nREVIEW_OK', 'REVIEW_OK  \nREVIEW_OK']) {
    assert.throws(() => parseReviewOutcome(j, evidence(j, text)));
  }
});

test('hc argv runs Pi and emits a completion stamp for the actual native file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'review-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const j = { ...job(), sessionDir: join(dir, 'sessions'), worktree: dir };
  await mkdir(j.sessionDir);
  const o = evidence(j);
  const native = join(j.sessionDir, `now_${sessionId}.jsonl`);
  // The fixture supplies Pi's native evidence and process exit independently.
  // /tmp is data-only (noexec) in the factory; never execute a temp script.
  await writeFile(native, o.session.map(e => JSON.stringify(e)).join('\n'));
  const pi = join(dir, 'pi');
  const [cmd, ...args] = o.reviewer.argv;
  const run = () => execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PATH: dir } });
  await symlink('/bin/false', pi);
  assert.throws(run, err => err.status !== 0 && !err.stdout.includes('L2:'));
  await unlink(pi);
  await symlink('/bin/true', pi);
  o.terminalRead = { text: run() };
  assert.equal(parseReviewOutcome(j, o).checkpoint, 'cafebabe');
  o.session.at(-1).message.content[0].text = 'objection\nREVIEW_REWORK';
  assert.throws(() => parseReviewOutcome(j, o), /checkpoint/);
});

async function assertLaunchCollisionLeavesNoReceipt(t, suffix) {
  const dir = await mkdtemp(join(tmpdir(), 'review-intent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gate = join(dir, 'board-review.mjs');
  await copyFile(new URL('./board-review.mjs', import.meta.url), gate);
  await writeFile(join(dir, 'check-workspace-space.mjs'), 'export async function requireWorkspaceSpace() {}\n');
  await writeFile(join(dir, 'routes.json'), JSON.stringify({ workerPresets: { reviewer: preset } }));
  const prompt = join(dir, 'input.md');
  await writeFile(prompt, 'Review this revision.');
  const jobs = join(dir, 'review-jobs');
  await mkdir(jobs);
  const receipt = join(jobs, `${request.task}-${sha}.json`);
  await writeFile(receipt + suffix, 'existing');
  // Stub command responses in the child only; no live Board, terminal or Git process.
  const preload = join(dir, 'commands.cjs');
  await writeFile(preload, `
  require('node:child_process').execFileSync = (bin, args) => {
    if (bin.endsWith('/vb') && args.includes('read')) return JSON.stringify({ id: '${request.task}', task: { state: 'ready' } });
    if (bin === 'hc' && args[0] === 'get') return JSON.stringify({ address: '${request.source}', cwd: process.cwd(), labels: { 'darkfactory.task': '${request.task}', 'herdr.space': 'test-space' } });
    if (bin === 'git' && args.includes('rev-parse')) return '${sha}';
    if (bin === 'git' && args.includes('status')) return '';
    throw new Error('unexpected external command');
  };
  require('node:module').syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ['--require', preload, gate, 'launch', '--source', request.source, '--task', request.task, '--sha', sha, '--prompt-file', prompt], { cwd: dir, encoding: 'utf8', env: {} });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EEXIST/);
  assert.ok(result.stderr.includes(receipt + suffix));
  assert.equal(await readFile(receipt + suffix, 'utf8'), 'existing');
  await assert.rejects(readFile(receipt), { code: 'ENOENT' });
}

test('launch cleans the intent receipt when session mkdir fails with EEXIST', async t => {
  await assertLaunchCollisionLeavesNoReceipt(t, '.sessions');
});

test('launch cleans the intent receipt when prompt write fails with EEXIST', async t => {
  await assertLaunchCollisionLeavesNoReceipt(t, '.md');
});

test('rejects drift, wrong terminal/session/route, missing checkpoint and missing or ambiguous verdict', () => {
  const j = job();
  for (const mutate of [o => o.head = '2'.repeat(40), o => o.clean = false, o => o.reviewer.exit_code = 1,
    o => o.reviewer.address = 't8', o => o.reviewer.cwd = '/other', o => o.reviewer.argv.pop(),
    o => o.session[0].id = 'wrong', o => o.session.at(-1).id = undefined,
    o => o.session.at(-1).id = 'decafbad', o => o.terminalRead.text = 'REVIEW_OK', o => delete o.terminalRead,
    o => o.session.at(-1).parentId = null, o => o.session.at(-1).message.model = 'other',
    o => o.session[1].thinkingLevel = 'low']) {
    const observed = evidence(j); mutate(observed);
    assert.throws(() => parseReviewOutcome(j, observed));
  }
  for (const text of ['looks fine', ' REVIEW_OK', 'REVIEW_OK later', 'REVIEW_BLOCKED', 'REVIEW_REWORK',
    'REVIEW_OK\nactually no', 'REVIEW_BLOCKED\nREVIEW_OK', 'REVIEW_OK\nREVIEW_REWORK', 'REVIEW_OK\nREVIEW_OK']) assert.throws(() => parseReviewOutcome(j, evidence(j, text)));
  assert.throws(() => parseReviewOutcome({ ...j, phase: 'intent' }, evidence(j)));
});
