import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryBoardSdk } from './board-test-fixture.mjs';
import { nativeBoardPort, isDefinitiveClaimLoss, isTransientBoardError } from './native-board.mjs';
import { loadSdk } from './sdk.mjs';

let sdk;
let memoryFallback = false;
try {
  sdk = loadSdk();
} catch {
  sdk = memoryBoardSdk();
  memoryFallback = true;
}
const { board, local } = sdk;

function compatibleHandle(handle) {
  if (!memoryFallback) return handle;
  return {
    ...handle,
    tasks: {
      ...handle.tasks,
      async createMany(channel, items, options) {
        const keyed = new Map();
        const created = [];
        for (const item of items) {
          const needs = (item.needs ?? []).map(dep => {
            if (dep === null || typeof dep !== 'object' || typeof dep.key !== 'string') return dep;
            if (!keyed.has(dep.key)) throw new Error(`Unknown keyed dependency ${dep.key}`);
            return keyed.get(dep.key);
          });
          const { task } = await handle.tasks.create(channel, { ...item, needs });
          if (typeof item.key === 'string') keyed.set(item.key, task.id);
          created.push(task);
        }
        return created;
      },
    },
  };
}

async function isolated(t) {
  const backend = local({ memory: true });
  t.after(() => backend.close());
  const handle = compatibleHandle(board({ backend }));
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
  const handle = compatibleHandle(board({ backend }));
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
  const admitted = await contractTask(handle, { ...CONTRACT, queue: 'vs1' },
    { text: 'Card-specific claimReady specification' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  const picked = await port.claimReady(FILTER);
  assert.equal(picked.taskId, admitted.task.id);
  assert.equal(picked.labels.spec_digest, CONTRACT.spec_digest);
  assert.equal(picked.text, 'Card-specific claimReady specification');
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

test('claimReady continues past an individual 409 claim conflict and claims the next ready card', async t => {
  const { handle, ported } = await claimedBoard(t);
  const first = await contractTask(handle, { ...CONTRACT, queue: 'vs1' }, { text: 'raced card' });
  const second = await contractTask(handle, { ...CONTRACT, queue: 'vs1' }, { text: 'claimable card' });
  const realClaim = handle.tasks.claim.bind(handle.tasks);
  const calls = [];
  ported.tasks.claim = async (id, opts) => {
    calls.push(id);
    if (id === first.task.id) {
      const error = new Error('already_claimed');
      error.code = 'already_claimed';
      error.statusCode = 409;
      throw error;
    }
    return realClaim(id, opts);
  };
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  const picked = await port.claimReady(FILTER);
  assert.equal(picked.taskId, second.task.id);
  assert.deepEqual(calls, [first.task.id, second.task.id]);
  assert.equal((await port.lookup(first.task.id)).state, 'ready');
  assert.equal((await port.lookup(second.task.id)).state, 'claimed');
});

test('verifyHeld preserves the held capability through transient renew failures but drops definitive loss', async t => {
  const { handle, ported } = await claimedBoard(t);
  const { task } = await contractTask(handle, { ...CONTRACT, queue: 'vs1' });
  const realClaim = handle.tasks.claim.bind(handle.tasks);
  let renews = 0;
  let transientFailures = 2;
  let definitiveLoss = false;
  ported.tasks.claim = async (id, opts) => {
    const capability = await realClaim(id, opts);
    return {
      ...capability,
      async renew(lease) {
        renews++;
        if (transientFailures > 0) {
          transientFailures--;
          const error = new Error(transientFailures === 1 ? 'temporary network timeout' : 'HTTP 503');
          if (transientFailures === 0) error.statusCode = 503;
          throw error;
        }
        if (definitiveLoss) {
          const error = new Error('claim_lost');
          error.code = 'claim_lost';
          error.statusCode = 409;
          throw error;
        }
        return capability.renew(lease);
      },
    };
  };
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  const claimed = await port.claim(task.id);
  await assert.rejects(port.verifyHeld(task.id, claimed.epoch), /temporary network timeout/);
  await assert.rejects(port.verifyHeld(task.id, claimed.epoch), /HTTP 503/);
  const held = await port.verifyHeld(task.id, claimed.epoch);
  assert.equal(held.epoch, claimed.epoch);
  assert.equal(renews, 3, 'transient failures did not delete the held capability');
  definitiveLoss = true;
  await assert.rejects(port.verifyHeld(task.id, claimed.epoch), /claim_lost/);
  await assert.rejects(port.verifyHeld(task.id, claimed.epoch), /no native claim is held/);
});

// --- Astra #15 (P1): policyDigest — часть доверенного допуска очереди ---
test('claimReady with a pinned policyDigest never steals a card of a foreign policy', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  const own = await contractTask(handle, { ...CONTRACT, queue: 'vs1' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  // Чужой policyDigest слота: карточка не допускается, эффектов нет.
  assert.equal(await port.claimReady({ ...FILTER, policyDigest: 'f'.repeat(64) }), null);
  assert.equal(seen.claim, 0, 'чужая политика — ноль claim-эффектов');
  assert.equal((await port.lookup(own.task.id)).state, 'ready');
  // Совпадающий дайджест допускается и захватывается.
  const picked = await port.claimReady({ ...FILTER, policyDigest: CONTRACT.policy_digest });
  assert.equal(picked.taskId, own.task.id);
  assert.equal(seen.claim, 1);
});

test('claimReady re-reads policy_digest before the claim and skips a rewritten card', async t => {
  const { handle, ported, seen } = await claimedBoard(t);
  const { task } = await contractTask(handle, { ...CONTRACT, queue: 'vs1' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  // Выдача списка несёт совпадающий дайджест, но перечитанный перед claim
  // снимок — уже чужой: захват недопустим даже при гонке перезаписи.
  const original = handle.thread.bind(handle);
  ported.thread = async (id, opts) => {
    const snap = await original(id, opts);
    if (id === task.id) {
      return { message: { ...snap.message,
        labels: { ...snap.message.labels, policy_digest: 'e'.repeat(64) } } };
    }
    return snap;
  };
  assert.equal(await port.claimReady({ ...FILTER, policyDigest: CONTRACT.policy_digest }), null);
  assert.equal(seen.claim, 0, 'переписанная карточка не захватывается');
  // Гонка исчезла: честный снимок вновь допускается и захватывается этим слотом.
  ported.thread = original;
  assert.equal((await port.claimReady({ ...FILTER, policyDigest: CONTRACT.policy_digest })).taskId, task.id);
  assert.equal(seen.claim, 1);
  // Без закреплённого policyDigest допускается любая валидная карточка (совместимость).
  const plain = await claimedBoard(t);
  const { task: legacyTask } = await contractTask(plain.handle, { ...CONTRACT, queue: 'vs1' });
  const legacyPort = nativeBoardPort(plain.ported, { channel: 'pilot', lease: 60 });
  assert.equal((await legacyPort.claimReady(FILTER)).taskId, legacyTask.id);
});

test('claimReady validates a configured policyDigest as a 64-char lowercase hex digest', async t => {
  const { ported } = await claimedBoard(t);
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  for (const bad of ['', 'not-hex', 'A'.repeat(64), 'b'.repeat(63), 'b'.repeat(65), 42, null]) {
    await assert.rejects(port.claimReady({ ...FILTER, policyDigest: bad }),
      /trusted claim filter/, JSON.stringify(bad));
  }
  // Валидный дайджест не отвергается фильтром (пустая очередь — честный null).
  assert.equal(await port.claimReady({ ...FILTER, policyDigest: 'b'.repeat(64) }), null);
});

// --- Astra #16 (P1): классификаторы definitive/transient отказов Board ---
test('isDefinitiveClaimLoss classifies 409/claim loss definitively and 5xx/network as transient', () => {
  const withStatus = statusCode => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
  const coded = code => Object.assign(new Error(code), { code });
  // Дефинитивная потеря: 409, claim_lost/epoch_mismatch коды.
  assert.equal(isDefinitiveClaimLoss(withStatus(409)), true);
  assert.equal(isDefinitiveClaimLoss(coded('claim_lost')), true);
  assert.equal(isDefinitiveClaimLoss(coded('epoch_mismatch')), true);
  assert.equal(isDefinitiveClaimLoss(Object.assign(new Error('x'), { code: 'claim_lost', statusCode: 503 })), true);
  // Транзитные: 5xx, таймауты и сетевые обрывы не являются потерей.
  for (const status of [500, 502, 503, 504]) {
    assert.equal(isDefinitiveClaimLoss(withStatus(status)), false, `HTTP ${status}`);
    assert.equal(isTransientBoardError(withStatus(status)), true, `HTTP ${status}`);
  }
  assert.equal(isTransientBoardError(coded('ETIMEDOUT')), true);
  assert.equal(isTransientBoardError(coded('ECONNRESET')), true);
  assert.equal(isTransientBoardError(coded('ECONNREFUSED')), true);
  assert.equal(isTransientBoardError(coded('EAI_AGAIN')), true);
  assert.equal(isTransientBoardError(new TypeError('fetch failed')), true);
  // Ошибки вне сети/5xx не считаются транзитными обновления аренды.
  assert.equal(isTransientBoardError(coded('claim_lost')), false);
  assert.equal(isTransientBoardError(withStatus(409)), false);
  assert.equal(isTransientBoardError(withStatus(404)), false);
  assert.equal(isTransientBoardError(new Error('boom')), false);
});

// --- Review P1: adopt() маркирует потерю владения кодом окончательной потери ---
test('adopt tags lost ownership as definitive claim loss, never as an untransparent plain error', async t => {
  const { handle, ported } = await claimedBoard(t);
  const { task } = await contractTask(handle, { ...CONTRACT, queue: 'vs1' });
  const port = nativeBoardPort(ported, { channel: 'pilot', lease: 60 });
  const picked = await port.claimReady(FILTER);
  const token = 'a'.repeat(43);
  // Чужая эпоха: код epoch_mismatch — окончательная потеря, не транзитный сбой.
  const epochLoss = await port.adopt(task.id, { epoch: picked.epoch + 1, token }).catch(error => error);
  assert.equal(epochLoss.message, 'Held epoch no longer owns the card');
  assert.equal(epochLoss.code, 'epoch_mismatch');
  assert.equal(isDefinitiveClaimLoss(epochLoss), true);
  assert.equal(isTransientBoardError(epochLoss), false);
  // Карточка не в claimed (завершена честным путём): код claim_lost.
  await port.complete(task.id, picked.epoch, { sha: 'c'.repeat(40) });
  const stateLoss = await port.adopt(task.id, { epoch: picked.epoch, token }).catch(error => error);
  assert.equal(stateLoss.code, 'claim_lost');
  assert.equal(isDefinitiveClaimLoss(stateLoss), true);
  assert.equal(isTransientBoardError(stateLoss), false);
  // Корректный adopt по-прежнему восстанавливает capability.
  const { task: fresh } = await contractTask(handle, { ...CONTRACT, queue: 'vs1' });
  const claim = await port.claim(fresh.id, {});
  await port.adopt(fresh.id, { epoch: claim.epoch, token });
});
