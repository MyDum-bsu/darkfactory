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
  assert.deepEqual(await port.lookup(fix.id),
    { state: 'completed', epoch, claim: null, result: evidence });
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

// claimReady: allowlist-допуск и честный ноль эффектов на чужих, неполных и waiting-карточках.
const CONTRACT = { spec_digest: 'a'.repeat(64), policy_digest: 'b'.repeat(64), repo_id: 'fixture-repo',
  profile_id: 'pilot', finish: 'verified', queue: 'vs1' };
const FILTER = {
  owner: 'board:client',
  label: { key: 'queue', value: 'vs1' },
  finish: 'verified',
  profileId: 'pilot',
  required: ['profile_id', 'repo_id', 'spec_digest', 'policy_digest'],
};

async function claimedBoard(t) {
  const backend = local({ memory: true });
  t.after(() => backend.close());
  const handle = board({ backend });
  await handle.createChannel('pilot');
  const seen = { claim: 0 };
  const ported = {
    ...handle,
    tasks: {
      ...handle.tasks,
      claim: async (...args) => {
        seen.claim++;
        const claimed = await handle.tasks.claim(...args);
        seen.token = claimed.token;
        return claimed;
      },
    },
  };
  return { handle, ported, seen };
}

function contractTask(handle, labels, over = {}) {
  return handle.tasks.create('pilot', { text: 'Synthetic claimReady', noSync: true, labels, ...over });
}

test('claimReady takes the oldest admitted ready card and returns its contract labels', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  const plain = await contractTask(handle, { queue: 'vs1', finish: 'verified' });
  const admitted = await contractTask(handle, { ...CONTRACT, queue: 'vs1' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  const picked = await port.claimReady(FILTER);
  assert.equal(picked.taskId, admitted.task.id);
  assert.equal(picked.labels.spec_digest, CONTRACT.spec_digest);
  assert.notEqual(picked.taskId, plain.task.id);
  assert.equal(seen.claim, 1, 'ровно один native claim — только допущенная карточка');
  const held = await port.verifyHeld(picked.taskId, picked.epoch);
  assert.equal(held.epoch, picked.epoch);
  const labels = await port.labels(admitted.task.id);
  assert.equal(labels.spec_digest, CONTRACT.spec_digest);
  assert.equal(labels.queue, 'vs1');
  assert.equal(await port.claimReady(FILTER), null, 'захваченная карточка больше не ready');
});

test('claimReady does not claim on an empty, foreign, mislabeled or incomplete queue', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  await contractTask(handle, { ...CONTRACT, queue: 'vs1' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  assert.equal(await port.claimReady({ ...FILTER, owner: 'board:other' }), null);
  assert.equal(await port.claimReady({ ...FILTER, label: { key: 'queue', value: 'other' } }), null);
  assert.equal(await port.claimReady({ ...FILTER, finish: 'deployed' }), null);
  assert.equal(await port.claimReady({ ...FILTER, required: [...FILTER.required, 'fixtures_digest'] }), null);
  assert.equal(seen.claim, 0, 'ни один нативный claim не сделан');
  await assert.rejects(port.claimReady({ owner: '' }), /trusted claim filter/);
  await assert.rejects(port.claimReady({ label: { key: 'queue' } }), /trusted claim filter/);
  await assert.rejects(port.claimReady({ required: 'spec_digest' }), /trusted claim filter/);
});

test('claimReady with a repoId filter never takes a card of a foreign repo_id', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  const foreign = await contractTask(handle, { ...CONTRACT, queue: 'vs1', repo_id: 'other-repo' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  assert.equal(await port.claimReady({ ...FILTER, repoId: 'fixture-repo' }), null,
    'карточка чужого repo_id не захватывается');
  assert.equal(seen.claim, 0, '0 native claim на чужой карточке');
  await assert.rejects(port.claimReady({ ...FILTER, repoId: '' }), /trusted claim filter/);
  await assert.rejects(port.claimReady({ ...FILTER, repoId: 42 }), /trusted claim filter/);
  const picked = await port.claimReady({ ...FILTER, repoId: 'other-repo' });
  assert.equal(picked.taskId, foreign.task.id, 'совпадающий repo_id захватывается');
  assert.equal(picked.labels.repo_id, 'other-repo');
});

test('claimReady never touches a waiting card and unlocks it only after native completion', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  const [head, dependent] = await handle.tasks.createMany('pilot', [
    { key: 'head', text: 'Head', noSync: true, labels: { ...CONTRACT, queue: 'vs1' } },
    { text: 'Dependent', needs: [{ key: 'head' }], noSync: true, labels: { ...CONTRACT, queue: 'vs1' } },
  ], { id: 'claim-ready-unlock' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  const first = await port.claimReady(FILTER);
  assert.equal(first.taskId, head.id);
  assert.equal((await port.lookup(dependent.id)).state, 'waiting');
  await port.complete(head.id, first.epoch, { sha: 'c'.repeat(40) });
  const second = await port.claimReady(FILTER);
  assert.equal(second.taskId, dependent.id);
  assert.equal(seen.claim, 2);
});


test('claimReady rejects empty or partial filters outright', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  await contractTask(handle, { ...CONTRACT, queue: 'vs1' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  for (const bad of [
    undefined,
    {},
    { owner: 'board:client' },
    { owner: 'board:client', label: { key: 'queue', value: 'vs1' } },
    { owner: 'board:client', label: { key: 'queue', value: 'vs1' }, finish: 'verified' },
    { owner: 'board:client', label: { key: 'queue', value: 'vs1' }, finish: 'verified',
      required: ['spec_digest', 'policy_digest'] },
    { owner: 'board:client', label: { key: 'queue', value: 'vs1' }, finish: 'shipped',
      required: ['profile_id', 'repo_id', 'spec_digest', 'policy_digest'] },
  ]) {
    await assert.rejects(port.claimReady(bad), /trusted claim filter/, JSON.stringify(bad ?? null));
  }
  assert.equal(seen.claim, 0);
});

test('claimReady validates contract label values, not just their presence', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  await contractTask(handle, { ...CONTRACT, queue: 'vs1', spec_digest: 'not-hex-at-all' });
  await contractTask(handle, { ...CONTRACT, queue: 'vs1', policy_digest: 'a'.repeat(63) });
  await contractTask(handle, { ...CONTRACT, queue: 'vs1', repo_id: '-bad-repo' });
  await contractTask(handle, { ...CONTRACT, queue: 'vs1', finish: 'shipped' });
  await contractTask(handle, { ...CONTRACT, queue: 'vs1', profile_id: 'other-profile' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  assert.equal(await port.claimReady({ ...FILTER, profileId: 'pilot' }), null);
  assert.equal(await port.claimReady({ ...FILTER, profileId: 'fixture' }), null,
    'чужой профиль маршрута не допускается');
  assert.equal(seen.claim, 0, 'ни одна карточка с невалидным контрактом не захвачена');
});

test('claimReady re-reads the card before the claim and skips a card that changed', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  const { task } = await contractTask(handle, { ...CONTRACT, queue: 'vs1' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  // Первое чтение (перечитывание перед claim) возвращает чужого владельца: захват не делается.
  const original = handle.thread.bind(handle);
  ported.thread = async (id, opts) => {
    const snap = await original(id, opts);
    if (id === task.id) {
      return { message: { ...snap.message, task: { ...snap.message.task, owner: 'board:other' } } };
    }
    return snap;
  };
  assert.equal(await port.claimReady(FILTER), null);
  assert.equal(seen.claim, 0);
});

test('claim() returns only epoch and until: the lease token never leaves the adapter', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  const { task } = await contractTask(handle, { ...CONTRACT, queue: 'vs1' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  const claimed = await port.claim(task.id);
  assert.deepEqual(Object.keys(claimed).sort(), ['epoch', 'until']);
  assert.ok(seen.token);
  assert.ok(!JSON.stringify(claimed).includes(seen.token), 'токен аренды не попадает в ответ claim');
  const picked = await port.claimReady(FILTER).catch(() => null);
  if (picked) assert.ok(!JSON.stringify(picked).includes(seen.token));
});

test('claimReady requires an explicit profileId in the filter', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  await contractTask(handle, { ...CONTRACT, queue: 'vs1' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  for (const bad of [
    { ...FILTER, profileId: undefined },
    { ...FILTER, profileId: '' },
    { ...FILTER, profileId: 7 },
  ]) {
    await assert.rejects(port.claimReady(bad), /trusted claim filter/, JSON.stringify(bad));
  }
  assert.equal(seen.claim, 0);
});

test('claimReady returns labels of the final verified snapshot and reads the card once', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  const { task } = await contractTask(handle, { ...CONTRACT, queue: 'vs1' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  let reads = 0;
  const original = handle.thread.bind(handle);
  ported.thread = async (id, opts) => {
    reads++;
    const snap = await original(id, opts);
    if (id === task.id) {
      // Последний снимок перед claim отличается от выдачи списка: возвращены должны
      // быть именно проверенные метки этого снимка.
      return { message: { ...snap.message,
        labels: { ...snap.message.labels, spec_digest: 'f'.repeat(64) } } };
    }
    return snap;
  };
  const picked = await port.claimReady(FILTER);
  assert.equal(picked.taskId, task.id);
  assert.equal(picked.labels.spec_digest, 'f'.repeat(64), 'метки последнего проверенного снимка');
  assert.equal(seen.claim, 1);
  assert.equal(reads, 1, 'один перечитанный снимок перед SDK claim, без лишнего lookup');
  await port.complete(task.id, picked.epoch, { sha: 'c'.repeat(40) });
});

test('claim() refuses a card that is not ready', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  const [head, dependent] = await handle.tasks.createMany('pilot', [
    { key: 'head', text: 'Head', noSync: true, labels: { ...CONTRACT, queue: 'vs1' } },
    { text: 'Dependent', needs: [{ key: 'head' }], noSync: true },
  ], { id: 'claim-not-ready' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  await assert.rejects(port.claim(dependent.id), /not ready for a native claim/);
  const { epoch } = await port.claim(head.id);
  await assert.rejects(port.claim(head.id), /not ready for a native claim/, 'повторный claim захваченной карточки');
  assert.equal(seen.claim, 1, 'SDK claim сделан ровно один раз');
  await port.complete(head.id, epoch, { sha: 'c'.repeat(40) });
});
