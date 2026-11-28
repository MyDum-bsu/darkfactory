import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { memoryBoard } from './board-test-fixture.mjs';
import { loadSdk } from './sdk.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createRolePass, schemas } from './board-stigmergy.mjs';
import { setup } from '../ops/df-board-setup.mjs';

const sha = 'a'.repeat(40);
const trace = { task_id: '42', epoch: 1, attempt_id: 'attempt-1', candidate_sha: sha, worker_thread_id: 'worker-1' };
const opts = { channel: 'queue', taskId: '42', epoch: 1, role: 'worker' };
const root = { message: { id: '42', channel: 'queue', task: { epoch: 1 } } };
function ack(args, attachments = []) {
  const [schema, version] = args[args.indexOf('--schema') + 1].split('@');
  return { message: { channel: opts.channel, re: args[3], attachments,
    blocks: [{ schema, version: Number(version), data: JSON.parse(args[4]) }] } };
}

test('a bound role pass denies forbidden operations before any Board call', async () => {
  for (const [role, schema] of [['worker', 'df.owner_request@1'], ['teamlead', 'df.submission@1'],
    ['teamlead', 'df.deploy_receipt@1'], ['critic', 'df.owner_request@1']]) {
    const pass = createRolePass({ ...opts, role, run: assert.fail });
    await assert.rejects(pass.post(schema, trace), /role_denied/);
    await assert.rejects(pass.complete(1, {}), /role_denied/);
  }
  assert.throws(() => createRolePass({ ...opts, role: 'constructor' }), /role_denied/);
});

test('trace retries bind the same id to ordered validated bytes; files are private and removed', async () => {
  const seen = [], paths = [];
  const run = async args => {
    if (args[2] === 'read') return root;
    assert.deepEqual(args.slice(0, 4), ['--as', 'worker', 'post', '42']);
    const key = args[args.indexOf('--idempotency-key') + 1];
    assert.match(key, /^df-[a-f0-9]{64}$/);
    seen.push(key);
    for (const [i, arg] of args.entries()) if (arg === '--attach') {
      const path = args[i + 1];
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(await readFile(path, 'utf8'), basename(path)); paths.push(path);
    }
    if (seen.length === 2) throw new Error('disconnect after write');
    return ack(args, ['diff-summary.txt', 'l1-tail.txt'].map(name => ({ name, size: name.length })));
  };
  const pass = createRolePass({ ...opts, run });
  await pass.post('df.submission@1', trace, { 'diff-summary.txt': 'diff-summary.txt', 'l1-tail.txt': 'l1-tail.txt' });
  await assert.rejects(pass.post('df.submission@1', Object.fromEntries(Object.entries(trace).reverse()),
    { 'l1-tail.txt': 'l1-tail.txt', 'diff-summary.txt': 'diff-summary.txt' }), /disconnect/);
  assert.equal(seen[0], seen[1]);
  for (const path of paths) await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('invalid schema payload, evidence name/size, stale epoch and wrong channel never post', async () => {
  const pass = createRolePass({ ...opts, run: assert.fail });
  for (const data of [null, {}, { ...trace, epoch: -1 }, { ...trace, candidate_sha: 'X'.repeat(40) },
    { ...trace, role: 'owner' }, { ...trace, worker_thread_id: '' }]) {
    await assert.rejects(pass.post('df.submission@1', data), /invalid_trace/);
  }
  for (const evidence of [null, { '../secrets': 'file' }, { 'diff-summary.txt': 'Ω'.repeat(2049) }]) {
    await assert.rejects(pass.post('df.submission@1', trace, evidence), /invalid_evidence/);
  }
  await assert.rejects(pass.post('df.submission@2', trace), /role_denied/);
  await assert.rejects(pass.post('df.submission@1', { ...trace, epoch: 2 }), /scope_changed/);
  const wrong = createRolePass({ ...opts, run: async args => { assert.equal(args[2], 'read');
    return { message: { ...root.message, channel: 'other' } }; } });
  await assert.rejects(wrong.post('df.submission@1', trace), /scope_changed/);
  const replay = createRolePass({ ...opts, run: async args => args[2] === 'read' ? root : ack(args) });
  await assert.rejects(replay.post('df.submission@1', trace, { 'diff-summary.txt': 'not acknowledged' }), /ack_mismatch/);
});

test('assignment reserves settlement profiles; owner/pi requests keep exact text', async () => {
  let posted;
  const run = async args => {
    if (args[2] === 'read') return root;
    if (args[2] !== 'post') return args;
    posted = args; return ack(args);
  };
  const lead = createRolePass({ ...opts, role: 'teamlead', run });
  assert.deepEqual(await lead.assign(1), ['--as', 'teamlead', 'tasks', 'assign', '42', 'arbiter']);
  await assert.rejects(lead.assign(1, 'worker'), /invalid_settlement_profile/);
  const request = '  Deploy?\nНе менять текст.  ';
  for (const role of ['owner', 'pi']) {
    await createRolePass({ ...opts, role, run }).post('df.owner_request@1', { request, epoch: 1 });
    assert.equal(posted[1], role); assert.equal(JSON.parse(posted[4]).request, request);
  }
});

const apply = ['--apply', '--url', 'http://fixture.invalid', '--channel', 'queue', '--broker', 'broker', '--reader', 'agent'];
test('setup is inert by default, reconciles only exact grants, and stops on policy drift', async () => {
  const dry = await setup(['--dry-run'], { run: assert.fail });
  assert.equal(dry.mode, 'dry-run'); assert.equal(dry.schemas.length, 5);
  const installed = new Map(), grants = [];
  const run = async (args, input) => {
    assert.deepEqual(args.slice(0, 2), ['--as', 'owner']);
    if (args[2] === 'schemas') {
      const key = args[4], def = JSON.parse(args[6]);
      assert.deepEqual(def, schemas[key]);
      if (installed.has(key)) assert.deepEqual(installed.get(key), def);
      installed.set(key, def); return {};
    }
    if (args[3] === 'list') return { grants };
    grants.push(...JSON.parse(input)); return {};
  };
  assert.equal((await setup(apply, { run })).grantsCreated, 3);
  assert.equal((await setup(apply, { run })).grantsCreated, 0);
  assert.equal(installed.size, 5);
  grants.push({ principals: [{ kind: 'user', userId: 'agent' }], can: { queue: ['post'] } });
  await assert.rejects(setup(apply, { run }), /conflicting_exact/);
  await assert.rejects(setup(['--apply'], { run: assert.fail }), /apply_requires/);
  await assert.rejects(setup([...apply, '--dry-run'], { run: assert.fail }), /choose_one/);
});

// The check container has no installed CLI/SDK. Keep just the protocol state
// this contract observes: exact-channel grants, immutable versions, and the
// acknowledged reply for each idempotency key. Task roots use the shared fixture.
async function offlineTraceBoard() {
  const handle = memoryBoard(), grants = [], definitions = new Map(), replies = new Map();
  const { task } = await handle.tasks.create('queue', { text: 'fixture' });
  const permits = (userId, permission) => grants.some(g => g.can.queue?.includes(permission) &&
    g.principals.some(p => p.kind === 'everyone' || p.userId === userId));
  const run = async (args, stdin) => {
    const [, profile, cmd, target] = args;
    if (profile === 'owner' && cmd === 'grants') {
      if (target === 'list') return { grants };
      assert.deepEqual(args.slice(3), ['create', '--file', '-']);
      grants.push(...JSON.parse(stdin)); return {};
    }
    if (profile === 'owner' && cmd === 'schemas') {
      assert.equal(target, 'create');
      const id = args[4], def = JSON.parse(args[6]);
      if (definitions.has(id) && !isDeepStrictEqual(definitions.get(id), def)) throw Error('schema_immutable');
      definitions.set(id, def); return {};
    }
    assert.equal(target, task.id);
    if (cmd === 'read' && permits('broker', 'read')) return handle.thread(target);
    assert.equal(cmd, 'post'); assert.ok(permits('broker', 'post'));
    const id = args[args.indexOf('--schema') + 1], key = args[args.indexOf('--idempotency-key') + 1];
    assert.ok(definitions.has(id)); assert.match(key, /^df-[0-9a-f]{64}$/);
    if (!replies.has(key)) {
      const attachments = [];
      for (const [i, arg] of args.entries()) if (arg === '--attach') {
        const path = args[i + 1]; attachments.push({ name: basename(path), size: (await readFile(path)).length });
      }
      const result = ack(args, attachments); result.message.id = String(replies.size + 100);
      replies.set(key, result);
    }
    return replies.get(key);
  };
  return { task, run, replyCount: () => replies.size,
    // --as changes provenance, not the authenticated reader's permissions.
    readerStatus: permission => permits('agent', permission) ? 200 : 403 };
}

async function installedTraceBoard(t, requireBoard) {
  const sdk = loadSdk();
  const { vb } = requireBoard('@vercel/board/cli');
  const backend = sdk.local({ memory: true }); t.after(() => backend.close());
  const handle = sdk.board({ backend, authenticate: async () => ({ id: 'local:user:agent', kind: 'person', handle: 'agent' }) });
  const run = async (args, stdin) => {
    const r = await vb(handle, ['--json', ...args], { readFile, stdin });
    assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout);
  };
  await handle.createChannel('queue');
  const { task } = await handle.tasks.create('queue', { text: 'fixture', noSync: true });
  return { task, run, replyCount: async () => (await handle.thread(task.id)).replies.length,
    async readerStatus(permission, profile) {
      const headers = { 'content-type': 'application/json', 'x-board-profile': profile };
      const url = 'http://fixture.invalid/api/board';
      const req = permission === 'read' ? new Request(`${url}/tasks?channel=queue`, { headers })
        : permission === 'post' ? new Request(`${url}/messages`, { method: 'POST', headers,
          body: JSON.stringify({ channel: 'queue', text: 'forged receipt' }) })
        : new Request(`${url}/tasks/${task.id}/claim`, { method: 'POST', headers, body: '{}' });
      return (await handle.fetch(req)).status;
    } };
}

async function checkTraceBoard({ task, run, readerStatus, replyCount }) {
  await setup(apply, { run }); assert.equal((await setup(apply, { run })).grantsCreated, 0);
  await assert.rejects(run(['--as', 'owner', 'schemas', 'create', 'df.submission@1', '--data', '{"type":"object"}']), /different|immutable|registered/i);
  assert.equal(await readerStatus('read', 'worker'), 200);
  assert.equal(await readerStatus('post', 'owner'), 403);
  assert.equal(await readerStatus('label', 'arbiter'), 403);
  const pass = createRolePass({ ...opts, epoch: 0, taskId: task.id, run });
  const submission = { ...trace, task_id: task.id, epoch: 0 };
  const send = () => pass.post('df.submission@1', submission, { 'diff-summary.txt': '1 file, +1 line' });
  const a = await send(), b = await send();
  assert.equal(a.message.id, b.message.id); assert.equal(await replyCount(), 1);
  assert.equal(a.message.attachments[0].name, 'diff-summary.txt');
  assert.deepEqual(a.message.blocks[0], { schema: 'df.submission', version: 1, data: submission });
}

test('Board 0.54 offline: principal grants, immutable schemas and idempotent attached replies', async () => {
  await checkTraceBoard(await offlineTraceBoard());
});

// Register an additional integration case on SDK-equipped hosts. Resolution
// is the only optional step; a broken installation or failed assertion fails.
const requireBoard = createRequire(join(homedir(), '.local/share/vercel-board/package.json'));
let installedSdk;
try { installedSdk = requireBoard.resolve('@vercel/board'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
if (installedSdk) {
  test('Board 0.54 SDK: principal grants, immutable schemas and idempotent attached replies', async t => {
    await checkTraceBoard(await installedTraceBoard(t, requireBoard));
  });
}
