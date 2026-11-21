import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeBoardPort } from './native-board.mjs';
import { loadSdk } from './sdk.mjs';

const { board, local } = loadSdk();

async function isolated(t) {
  const backend = local({ memory: true });
  t.after(() => backend.close());
  const handle = board({ backend });
  await handle.createChannel('pilot');
  return handle;
}

test('native completion unlocks an actual dependency and records typed evidence', async t => {
  const handle = await isolated(t);
  const [fix, after] = await handle.tasks.createMany('pilot', [
    { key: 'fix', text: 'Synthetic work', noSync: true },
    { text: 'Dependent', needs: [{ key: 'fix' }], noSync: true },
  ], { id: 'native-green' });
  const port = nativeBoardPort(handle, { channel: 'pilot' });
  assert.equal((await port.lookup(after.id)).state, 'waiting');
  const { epoch } = await port.claim(fix.id);
  const evidence = { sha: '78'.repeat(20), verdict: 'REVIEW_OK' };
  await port.complete(fix.id, epoch, evidence);
  assert.deepEqual(await port.lookup(fix.id), { state: 'completed', epoch, result: evidence });
  assert.equal((await port.lookup(after.id)).state, 'ready');
});

test('native block holds failed work and does not unlock a dependent', async t => {
  const handle = await isolated(t);
  const { task } = await handle.tasks.create('pilot', { text: 'Synthetic failure', noSync: true });
  const { task: after } = await handle.tasks.create('pilot', { text: 'Dependent', needs: [task.id] });
  const port = nativeBoardPort(handle, { channel: 'pilot' });
  const { epoch } = await port.claim(task.id);
  await port.block(task.id, epoch, 'Targeted test failed');
  assert.equal((await port.lookup(task.id)).state, 'blocked');
  assert.equal((await port.lookup(after.id)).state, 'waiting');
  const { message } = await handle.thread(task.id);
  assert.equal(message.task.blocked.reason, 'Targeted test failed');
});

test('expired lease cannot complete an attempt after a newer claim', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1780000000000 });
  const handle = await isolated(t);
  const { task } = await handle.tasks.create('pilot', { text: 'Synthetic work', noSync: true });
  const old = nativeBoardPort(handle, { channel: 'pilot', lease: 30 });
  const newer = nativeBoardPort(handle, { channel: 'pilot', lease: 30 });
  const first = await old.claim(task.id);
  t.mock.timers.tick(31_000);
  const second = await newer.claim(task.id);
  assert.ok(second.epoch > first.epoch);
  await assert.rejects(old.complete(task.id, first.epoch, { sha: '0'.repeat(40) }));
  assert.equal((await newer.lookup(task.id)).state, 'claimed');
  await newer.complete(task.id, second.epoch, { sha: '1'.repeat(40) });
  assert.equal((await newer.lookup(task.id)).result.sha, '1'.repeat(40));
});
