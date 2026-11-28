import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { advance } from '../../board_pipeline/controller.mjs';
import { createEventBus } from '../../board_pipeline/event-bus.mjs';
import { memoryBoard } from '../../board_pipeline/board-test-fixture.mjs';
import { nativeBoardPort } from '../../board_pipeline/native-board.mjs';
import { resolveL1Profile } from '../../board_pipeline/l1-profiles.mjs';
import { validateTrace } from './trace-validate.mjs';

test('tla-node is an attested offline L1 profile', () => {
  const profile = resolveL1Profile({ l1Profile: 'tla-node' });
  assert.equal(profile.network, 'none');
  assert.equal(profile.readOnlyCandidate, true);
  assert.equal(profile.user, '65534:65534');
  assert.equal(profile.dockerfile, 'ops/l1-profiles/tla-node/Dockerfile');
});

// Additional image integration gate: pass the LOCAL image ID after building
// ops/l1-profiles/tla-node. No registry pull, operator data or writable checkout.
const image = process.env.TLA_NODE_TEST_IMAGE;
test('image discovers product models before the original recipe, even from a subdirectory',
  { skip: !image && 'set TLA_NODE_TEST_IMAGE to a built image ID' }, async t => {
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const root = await mkdtemp(join(tmpdir(), 'tlc-product-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await chmod(root, 0o755);
    const dir = join(root, 'specs/tla');
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const run = () => promisify(execFile)('docker', ['run', '--rm', '--pull=never', '--network=none',
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
      '--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777', '--mount', `type=bind,src=${root},dst=/candidate,readonly`,
      '-w', '/candidate/specs', image, 'node', '-e', 'console.log("recipe_ok")'], { timeout: 30_000 });
    assert.match((await run()).stdout, /^recipe_ok\s*$/);
    await writeFile(join(dir, 'Counter.tla'), '---- MODULE Counter ----\nVARIABLE n\nInit == n = 0\n' +
      "Next == n' = 1\nBad == n = 0\nGood == n \\in {0, 1}\n====\n");
    await assert.rejects(run(), /no same-name TLC configuration/);
    for (const invariant of ['Bad', 'Good']) {
      await writeFile(join(dir, 'Counter.cfg'), `INIT Init\nNEXT Next\nINVARIANT ${invariant}\n`);
      if (invariant === 'Good') assert.match((await run()).stdout, /No error has been found[\s\S]*recipe_ok/);
      else await assert.rejects(run(), e => e.code === 12 && e.stdout.includes('Invariant Bad is violated.') &&
        !e.stdout.includes('recipe_ok'));
    }
  });

test('replay controller + Board + event-bus journal, including a rejected round', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'controller-trace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bus = createEventBus({ stateDir: dir, socketPath: null });
  t.after(() => bus.close());
  const handle = memoryBoard();
  await handle.createChannel('lab');
  const { task } = await handle.tasks.create('lab', { text: 'trace', noSync: true });
  const board = nativeBoardPort(handle, { channel: 'lab', lease: 30 });
  let stored;
  const route = { taskId: task.id, base: 'a'.repeat(40), worktree: dir,
    finish: 'verified', checkProfile: 'lab', policyVersion: 'v1' };
  const tick = () => advance({ route, board, eventBus: bus, authorize: async () => true,
    state: { load: () => structuredClone(stored), save: value => { stored = structuredClone(value); } },
    bb: { spawn: () => ({ threadId: 'df-task-0123456789' }), feedback: async () => ({ confirmed: true }) },
    submissions: { read: (a, after) => ({ turnSeq: after + 1, submission: { task_id: a.task_id,
      attempt_id: a.attempt_id, epoch: a.epoch, worker_thread_id: a.bb_thread_id,
      candidate_sha: (after === 0 ? 'b' : 'c').repeat(40) } }) },
    verify: async (a, s) => {
      if (s.candidate_sha.startsWith('b')) return { outcome: 'rework', reason: 'red' };
      await board.complete(a.task_id, a.epoch, { sha: s.candidate_sha, subject_digest: 'a'.repeat(64) });
      return { outcome: 'verified', receipt: { settle: 'completed' } };
    },
  });
  assert.equal((await tick()).phase, 'working');
  assert.equal((await tick()).phase, 'working');
  assert.equal((await tick()).phase, 'done');
  await bus.close();
  const journal = await readFile(join(dir, 'events.ndjson'), 'utf8');
  const rows = journal.trim().split('\n').map(s => JSON.parse(s));
  const [claim, launch, working] = rows;
  const done = rows.at(-1);
  const configured = process.env.TLA_TOOLS_JAR !== undefined;
  // Plain Node L1 must actually replay the trace, not skip this test. The
  // formal gate checks exactly the same cases against the TLA definitions.
  for (const engine of configured ? ['node', 'tlc'] : ['node']) {
    await t.test(engine, async () => {
      const options = engine === (configured ? 'tlc' : 'node') ? undefined : { engine };
      const result = await validateTrace(journal, options);
      assert.equal(result.engine, engine);
      assert.ok(result.states > 0);
      const replay = events => validateTrace(events.map((e, i) => JSON.stringify({ ...e, seq: i + 1 })).join('\n'), options);
      await assert.rejects(replay([claim, launch, launch]), /NoDuplicateSpawn/);
      await assert.rejects(replay(rows.map(e => e === done ? { ...e, detail: { ...e.detail,
        threadId: 'thr_other' } } : e)), /SingleLiveWriter/);
      await assert.rejects(replay([...rows.slice(0, -1),
        { ...claim, attempt_id: 'new' }, { ...launch, attempt_id: 'new', epoch: done.epoch + 1 }, done]), /NoStaleCommit/);
      await assert.rejects(replay([claim, working]), /without worker receipt/);
      await assert.rejects(replay([...rows.slice(0, -1), { ...done, detail: { ...done.detail,
        sha: 'b'.repeat(40) } }]), /NoStaleCommit/);
      await assert.rejects(replay([...rows.slice(0, -2), done]), /NoBlindRoundClose/);
      await assert.rejects(replay(rows.map(e => e === done ? { ...e, epoch: e.epoch + 1 } : e)), /epoch|NoStaleCommit/);
    });
  }
  if (!configured) await assert.rejects(validateTrace(journal, { engine: 'tlc' }), /TLA_TOOLS_JAR/);
});

test('empty, malformed and unrelated journals are not conformance evidence', async () => {
  for (const input of ['', '\n', '{', 'null', '{}', '{"role":"daemon","kind":"tick"}']) {
    await assert.rejects(validateTrace(input));
  }
});
