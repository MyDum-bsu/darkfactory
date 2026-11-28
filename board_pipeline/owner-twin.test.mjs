import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { advanceWithProjection } from './controller.mjs';
import { isolatedArbiterRunner, splitVerdict } from './review-runner.mjs';
import { verbatimOwnerRequestBlock } from './review-policy.mjs';
import { watchProjectRequests } from './teamlead-runner.mjs';
import * as selector from './worker-selector.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteLedgerJournal } from './decision-ledger.mjs';
import { openUnifiedLedger } from './unified-ledger.mjs';
import { judgeOwnerQuestion } from './owner-twin.mjs';

const prompt = 'Which format for local diagnostics?';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'df-twin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, 'worker'), vault = join(root, 'private');
  await mkdir(worktree); await mkdir(vault, { mode: 0o700 });
  const dbPath = join(vault, 'unified-ledger.db');
  const ledger = openUnifiedLedger(dbPath);
  t.after(() => ledger.close());
  const approve = ({ topic = prompt, decision = 'Use JSON.  Preserve whitespace.', scope = 'project:demo',
    applicability = 'reversible', approvedBy = 'owner', supersedesId } = {}) => {
    const p = ledger.proposeDecision({ topic, decision, applicability, scope, proposedBy: 'lead' });
    return ledger.approveProposal(p.proposal_id, { approvedBy, supersedesId });
  };
  const judge = options => judgeOwnerQuestion({ kind: 'product', prompt, evidence: '', projectId: 'demo',
    principal: 'owner', dbPath, worktree, ...options });
  return { approve, judge, worktree, dbPath, ledger };
}

test('an exact, reusable owner decision is returned verbatim with its source and date', async t => {
  const { approve, judge } = await fixture(t);
  const old = approve(), active = approve({ decision: 'Use YAML.\n  Preserve indentation.', supersedesId: old.id });
  approve({ scope: 'project:other' });
  assert.deepEqual(await judge(), { verdict: 'RESOLVE', citation: { quote: active.decision,
    source: `unified-ledger.db#decisions/${active.id}`, date: active.approved_at } });
});

test('writable database, WAL or shared memory cannot authorize a decision', async t => {
  const { approve, judge, dbPath } = await fixture(t);
  approve();
  for (const suffix of ['', '-wal', '-shm']) {
    for (const mode of [0o620, 0o602]) {
      await chmod(dbPath + suffix, mode);
      assert.deepEqual(await judge(), { verdict: 'ESCALATE', reason: 'untrusted_ledger' }, suffix);
      await chmod(dbPath + suffix, 0o600);
      assert.equal((await judge()).verdict, 'RESOLVE');
    }
  }
});

test('no applicable owner citation, fuzzy-only hit, conflict, or unavailable DB never authorizes', async t => {
  const { approve, judge, ledger } = await fixture(t);
  ledger.proposeDecision({ scope: 'global', topic: prompt, decision: 'Just use CSV.', proposedBy: 'lead' });
  assert.equal((await judge()).verdict, 'ESCALATE');
  approve({ approvedBy: 'other' });
  assert.equal((await judge()).verdict, 'ESCALATE');
  approve({ topic: 'Local diagnostics in JSON?' });
  assert.equal((await judge({ prompt: 'Local diagnostics NOT in JSON?' })).verdict, 'ESCALATE');
  approve({ topic: 'Unknown impact?', applicability: '' });
  assert.equal((await judge({ prompt: 'Unknown impact?' })).verdict, 'ESCALATE');
  approve(); approve({ decision: 'Use TSV.' });
  assert.equal((await judge()).verdict, 'ESCALATE');
  assert.equal((await judge({ dbPath: '/nonexistent/db' })).verdict, 'ESCALATE');
});

test('a verified ledger hit without any one of quote, source ID, or approval date fails closed', async t => {
  const { approve, dbPath, judge } = await fixture(t);
  const row = approve();
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  const journal = openSqliteLedgerJournal(db);
  for (const field of ['decision', 'id', 'approved_at']) {
    journal.write(append => append({ collection: 'decisions', entity: row.id, row: { ...row, [field]: '' } }));
    assert.equal((await judge()).verdict, 'ESCALATE', field);
  }
});

test('hard stops go directly to the human even with exact active approval', async t => {
  const { approve, judge } = await fixture(t);
  for (const topic of ['Raise the GCP billing cap?', 'Permanently delete production data?',
    'Expose PII in diagnostics?', 'Share the API secret?', 'Pay the external vendor?',
    'Contact the customer?', 'Public push of moml-course to GitHub?']) {
    approve({ topic });
    assert.deepEqual(await judge({ prompt: topic }), { verdict: 'ESCALATE', reason: 'red_stop' });
  }
  approve();
  assert.equal((await judge({ evidence: 'Includes PII' })).reason, 'red_stop');
  assert.equal((await judge({ kind: 'release' })).verdict, 'ESCALATE');
});

const digest = text => createHash('sha256').update(text).digest('hex');
const actor = { owner_actor: 'owner', arbiter_actor: 'arbiter' };
const taskId = '52', subject_digest = 'd'.repeat(64);
const owner = { id: '51', channel: 'demo/requests', by: { actor: 'owner' }, re: null, text: 'Keep both APIs compatible.' };
const specText = 'Implement both changes.\n' + verbatimOwnerRequestBlock({ verbatim_request_id: owner.id,
  verbatim_owner_quote: owner.text });
const split = { verdict: 'SPLIT', subject_digest, reason: 'Two independent changes keep blocking each other.',
  subtasks: ['Update parser', 'Update renderer'] };

// Start at the first observed writer turn. Still use the real progress detector,
// arbiter admission, controller WAL, native message shape and Teamlead consumer.
function controller({ worktree, dbPath }, ruling = split, routeOptions = {}) {
  const route = { taskId, worktree, teamlead: actor, repoId: 'demo', decisionLedger: { sqlitePath: dbPath },
    base: 'a'.repeat(40), policyVersion: 'v1', checkProfile: 'test', finish: 'verified', ...routeOptions };
  const contract = { specText, spec_digest: digest(specText), repo_id: 'demo', verbatim_request_id: owner.id };
  let record = { phase: 'working', binding: digest(JSON.stringify(route)), contract, taskId, seenShas: [],
    attemptId: 'a-1', threadId: 'thr_test', epoch: 1, token: 't'.repeat(43) };
  const parent = { id: taskId, text: specText, task: { state: 'claimed', epoch: 1 }, labels: contract };
  const posts = [], feedback = [], blocks = [];
  let seq = 0, submission;
  const options = { route, authorize: async () => true,
    state: { load: async () => structuredClone(record), save: async next => { record = structuredClone(next); } },
    board: { adopt: async () => {}, verifyHeld: async () => ({ epoch: 1 }), project: assert.fail,
      block: async (id, epoch, text) => { blocks.push(text); parent.task.state = 'blocked'; }, lookup: async () => parent.task },
    splitBoard: { me: async () => ({ actor: actor.arbiter_actor }),
      thread: async id => ({ message: id === taskId ? parent : id === owner.id ? owner : assert.fail(id) }),
      post: async (channel, body) => {
        assert.equal(body.noSync, true); assert.equal(channel, 'demo/requests');
        const message = { ...body, channel, id: '60', by: { actor: 'arbiter' }, re: null };
        assert.equal(posts.length, 0); posts.push(message); return message;
      }, tasks: { held(id, proof) {
        assert.equal(id, taskId); assert.deepEqual(proof, { epoch: 1, token: record.token });
        return { async fail(reason) { parent.task = { state: 'failed', epoch: 1, reason }; return parent; } };
      } } },
    workerSelector: { ...selector, arbitrate: async req => { assert.equal(req.subject_digest, subject_digest); return ruling; } },
    bb: { feedback: async packet => { feedback.push(packet); return { confirmed: true }; } },
    verify: async () => ({ outcome: 'rework', reason: 'review_verdict:REVIEW_BLOCKED', subject_digest,
      feedback: { findings: [{ file: 'parser', expected: 'separate concerns', actual: 'coupled', harm: 3 }] } }),
    submissions: { read: async (attempt, after) => after < seq ? { turnSeq: seq, submission: {
      task_id: taskId, attempt_id: attempt.attempt_id, worker_thread_id: attempt.bb_thread_id, epoch: 1, ...submission } } : null },
  };
  return { options, parent, feedback, posts, blocks, record: () => record, tick: () => advanceWithProjection(options),
    submit: value => { seq++; submission = value; } };
}

test('product question gate delivers only cited answers, without manufacturing a signed answer', async t => {
  const f = await fixture(t), h = controller(f);
  const row = f.approve();
  h.options.questionGate = { capture: async () => 'a'.repeat(40), canResume: async () => true,
    principal: 'owner', ttlMs: 60000, now: () => 500 };
  h.submit({ question: { prompt, evidence: '' } });
  assert.equal((await h.tick()).phase, 'working');
  assert.deepEqual(h.feedback[0].evidence.citation, { quote: row.decision, date: row.approved_at,
    source: `unified-ledger.db#decisions/${row.id}` });
  assert.equal(h.record().ownerAnswer, undefined); assert.equal(h.blocks.length, 0);
  await h.tick(); assert.equal(h.feedback.length, 1);
  h.submit({ question: { prompt, evidence: 'Requires sending PII' } });
  assert.equal((await h.tick()).phase, 'awaiting_answer');
  assert.equal(h.blocks.length, 1); assert.equal(h.feedback.length, 1);
});

async function stalled(h) {
  h.submit({ candidate_sha: 'a'.repeat(40) }); assert.equal((await h.tick()).phase, 'working');
  h.submit({ candidate_sha: 'b'.repeat(40) }); return h.tick();
}

test('SPLIT rejects malformed subtasks and a ruling for another subject before effects', async t => {
  for (const subtasks of [[], ['one'], ['', 'two'], ['a', 'a'], [null, 'ok']]) {
    assert.throws(() => splitVerdict({ ...split, subtasks }));
  }
  const h = controller(await fixture(t), { ...split, subject_digest: '0'.repeat(64) });
  h.options.board.project = async () => {};
  assert.equal((await stalled(h)).reason, 'arbiter_subject_mismatch');
  assert.equal(h.posts.length, 0); assert.equal(h.parent.task.state, 'blocked');
});

test('an explicit over-scope objection can split on the first round, but cannot extend the L2 budget', async t => {
  const f = await fixture(t);
  for (const ruling of [split, { decision: 'directed_rework', subject_digest, directive: 'Retry both concerns' }]) {
    const h = controller(f, ruling, { maxL2ReworkRounds: 1 });
    h.options.board.project = async () => {};
    h.options.verify = async () => ({ outcome: 'rework', subject_digest, reason: 'review_verdict:REVIEW_BLOCKED',
      feedback: { excerpt: 'Over-scoped: parser and renderer have independent acceptance criteria.' } });
    h.submit({ candidate_sha: 'b'.repeat(40) }); const out = await h.tick();
    assert.equal(out.reason, ruling === split ? 'superseded_by_split' : 'l2_rework_limit_exceeded');
    assert.equal(h.feedback.length, 0);
  }
});

test('Arbiter SPLIT supersedes only its claim and is consumed by Project Teamlead', async t => {
  const f = await fixture(t), h = controller(f);
  const piRoot = join(dirname(f.dbPath), 'arbiter'); await mkdir(piRoot);
  await writeFile(join(piRoot, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'fixture' } }));
  h.options.workerSelector.arbitrate = isolatedArbiterRunner({ piRoot, sandbox: async ({ argv }) => {
    assert.match(argv.at(-1), /"verdict":"SPLIT"/);
    const { provider, model, reasoningLevel: thinkingLevel } = selector.DEFAULT_ARBITER;
    const reply = { type: 'message_end', message: { role: 'assistant', provider, model, thinkingLevel,
      responseId: 'fixture', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(split) }] } };
    return { code: 0, stdout: [reply, { type: 'agent_settled', aborted: false }].map(v => JSON.stringify(v)).join('\n') };
  } });
  // Lose the reply after Board ends the claim. Restart must observe the exact
  // supersession receipt, not post another request or accept the candidate.
  const held = h.options.splitBoard.tasks.held;
  h.options.splitBoard.tasks.held = (...args) => ({ fail: async reason => {
    await held(...args).fail(reason); throw Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' });
  } });
  assert.equal((await stalled(h)).phase, 'splitting');
  const out = await h.tick(); assert.equal(out.reason, 'superseded_by_split'); assert.equal(out.phase, 'done');
  assert.equal(out.sha, null); assert.equal(h.record().receipt.request_id, '60');
  assert.equal(h.parent.task.state, 'failed'); assert.match(h.parent.task.reason, /superseded_by_split: demo\/requests#60/);
  assert.equal(h.blocks.length, 0); assert.equal(h.feedback.length, 1);
  await h.tick(); assert.equal(h.posts.length, 1);

  const storeDir = join(dirname(f.dbPath), 'memory'), docsPath = join(storeDir, 'docs.json');
  const killSwitch = join(storeDir, 'switch'), policy = join(storeDir, 'policy');
  await mkdir(storeDir, { mode: 0o700 }); await writeFile(killSwitch, 'run\n', { mode: 0o600 });
  await writeFile(docsPath, JSON.stringify({ 'herdr-app': { value: { spaces: [
    { name: 'Demo', folder: f.worktree, id: 'demo-space' }] } } }));
  const policyData = { teamlead: actor, intake_mode: 'managed_dispatcher', channel: 'writers', boardUrl: 'http://fixture/api/board',
    policyDigest: digest('policy'), route: h.options.route, projectMemory: { storeDir }, decisionLedger: { sqlitePath: f.dbPath },
    pilot: { killSwitch }, label: { key: 'queue', value: 'dev' } };
  const bytes = JSON.stringify(policyData); await writeFile(policy, bytes);
  const stop = new AbortController(); let batch;
  await watchProjectRequests({ repo_id: 'demo', repo_dir: f.worktree, channel: 'writers', policyData,
    herdr_space_name: 'Demo', policy, bytes }, { docsPath, signal: stop.signal,
    execFile: async (cmd, argv) => {
      assert.equal(cmd, 'hc'); const prompt = await readFile(argv.at(-1).slice(1), 'utf8');
      for (const text of [owner.text, split.reason, ...split.subtasks]) assert.ok(prompt.includes(text));
      await writeFile(argv[argv.indexOf('-c') + 2], JSON.stringify({ cards: split.subtasks.map((text, i) =>
        ({ key: `s${i}`, text, allowed_paths: 'src/', needs: [] })) }));
    }, fetchImpl: async (url, init) => {
      const { pathname } = new URL(url);
      if (pathname.endsWith('/events')) return Response.json({ cursor: '60', events: [{ type: 'message.posted', message: h.posts[0] }] });
      if (pathname.includes('/tasks/batch/')) return Response.json({ error: { code: 'batch_not_found' } }, { status: 404 });
      if (pathname.endsWith('/messages/51')) return Response.json({ message: owner });
      assert.ok(pathname.endsWith('/tasks/batch')); batch = JSON.parse(init.body); stop.abort();
      return Response.json({ tasks: batch.tasks.map(() => ({ channel: 'writers' })) });
    } });
  assert.deepEqual(batch.tasks.map(c => c.labels.verbatim_request_id), ['51', '51']);
});
