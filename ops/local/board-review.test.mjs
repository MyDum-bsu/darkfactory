import assert from 'node:assert/strict';
import test from 'node:test';

import { attestReview, prepareReview, reviewerArguments } from './board-review.mjs';

const sha = '1'.repeat(40);
const preset = { provider: 'pi', model: 'openai/gpt-6.2-sol', reasoningLevel: 'medium' };
const request = { task: '66', source: 'thr_evidence', sha };
const launched = 'pi_12345678-0123-4567-8901-123456789012';

function observation({ model = 'gpt-6.2-sol', effort = 'medium', checkpoint = 'cafebabe', verdict = 'REVIEW_OK', head = sha } = {}) {
  return {
    head,
    clean: true,
    reviewer: { providerId: 'pi', environmentId: 'env_review', status: 'idle' },
    events: [
      { type:'client/turn/requested', seq:1, data:{ execution:{ model:'openai/gpt-6.2-sol', reasoningLevel:'medium' } } },
      { type:'turn/started', seq:2, data:{ providerThreadId:launched } },
      { type:'turn/completed', seq:5, data:{ status:'completed', providerThreadId:launched, providerCheckpointId:checkpoint } },
    ],
    session: [
      { type:'thinking_level_change', thinkingLevel:effort },
      { type:'message', id:'cafebabe', message:{ role:'assistant', provider:'openai',model,stopReason:'stop',content:[{type:'text',text:verdict}] } },
    ],
  };
}
const job = () => ({ ...prepareReview(request, preset), environmentId:'env_review', threadId:'thr_actualreview', phase:'launched' });

test('reject Codex or a 6.1 request before producing any spawn arguments', () => {
  assert.throws(() => prepareReview({...request,provider:'codex',model:'gpt-6.1-sol'},preset), /review.*pi.*6\.2/i);
  assert.throws(() => prepareReview(request,{...preset,model:'openai/gpt-6.1-sol'}), /preset/i);
});

test('the one valid route pins provider, model, effort and environment', () => {
  const args = reviewerArguments(job(),{projectId:'proj_test',environmentId:'env_review'},'/tmp/review-prompt.md');
  for (const [flag,value] of [['--provider','pi'],['--model','openai/gpt-6.2-sol'],['--reasoning-level','medium'],
    ['--permission-mode','accept-edits'],['--environment','env_review']]) {
    assert.equal(args[args.indexOf(flag)+1],value);
  }
});

test('accepts real runtime metadata only when it matches the pinned route and SHA', () => {
  const proof = attestReview(job(),observation());
  assert.equal(proof.actual.provider,'openai');
  assert.equal(proof.actual.model,'gpt-6.2-sol');
  assert.equal(proof.actual.reasoningLevel,'medium');
  assert.equal(proof.verdict,'REVIEW_OK');
  assert.equal(proof.sha,sha);
});

test('requested 6.2 cannot hide actual 6.1, missing effort or a different checkpoint', () => {
  assert.throws(() => attestReview(job(),observation({model:'gpt-6.1-sol'})),/runtime model/i);
  assert.throws(() => attestReview(job(),observation({effort:'low'})),/runtime reasoning/i);
  assert.throws(() => attestReview(job(),observation({checkpoint:'01234567'})),/checkpoint/i);
});

test('explicit Astra requires Astra at BB startup and at the native checkpoint', () => {
  const expected = { ...preset, model: 'openai/gpt-6.2-astra' };
  const astra = { ...job(), ...prepareReview(request, expected) };
  const observed = observation({ model: 'gpt-6.2-astra' });
  observed.events[0].data.execution.model = expected.model;
  assert.equal(attestReview(astra, observed).actual.model, 'gpt-6.2-astra');
  observed.session[1].message.model = 'gpt-6.2-sol';
  assert.throws(() => attestReview(astra, observed), /runtime model/i);
  assert.throws(() => attestReview(job(), observed), /request route/i);
});

test('drift, absent launch receipt, and absent verdict fail closed', () => {
  assert.throws(() => attestReview(job(),observation({head:'2'.repeat(40)})),/revision/i);
  assert.throws(() => attestReview({...job(),phase:'intent'},observation()),/launch/i);
  assert.throws(() => attestReview(job(),observation({verdict:'looks fine'})),/verdict/i);
  assert.throws(() => attestReview(job(), observation({ verdict: 'REVIEW_BLOCKED' })), /no objection/);
  const blocked = attestReview(job(), observation({ verdict: 'Bad input: expected refusal\nREVIEW_BLOCKED' }));
  assert.equal(blocked.verdict, 'REVIEW_BLOCKED');
  assert.equal(blocked.excerpt, 'Bad input: expected refusal');
});
