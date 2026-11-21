import assert from 'node:assert/strict';
import test from 'node:test';
import { pickPersonalWorker } from './pick-personal-worker.mjs';

const now = Date.parse('2026-11-21T03:00:00Z');
const window = { label:'GLM-5.3-Flash', usedPercent:20, resetsAt:'2026-11-23T01:00:00Z' };
const choose = (...windows) => pickPersonalWorker({ status:'ok', windows }, { now });

test('available Start quota uses the real ZCode Start model ID', () => {
  assert.deepEqual(choose(window),{ provider:'acp-zcode-start', model:'builtin:zai-start-plan\\GLM-5.3-Flash', reasoningLevel:'max', reason:'zcode-quota-available' });
});
test('exhausted matching window selects SWE-2, not another ZCode model', () => {
  const selected=choose(window,{...window,usedPercent:100});
  assert.equal(selected.provider,'acp-devin');
  assert.equal(selected.model,'swe-2-high');
  assert.equal(selected.reason,'zcode-quota-exhausted');
});
test('unknown quota and exhausted quota stay distinguishable', () => {
  assert.equal(choose({...window,label:'Other model'}).reason,'zcode-quota-unavailable');
  assert.equal(choose({...window,resetsAt:'2026-11-20T01:00:00Z'}).reason,'zcode-quota-unavailable');
  assert.equal(pickPersonalWorker({status:'lookup-error'}).reason,'zcode-lookup-error');
});
test('actual explicit quota failure allows fallback for a new attempt', () => {
  assert.deepEqual(pickPersonalWorker(null,{afterQuota:true}),{provider:'acp-devin',model:'swe-2-high',reason:'zcode-explicit-quota-failure'});
});
