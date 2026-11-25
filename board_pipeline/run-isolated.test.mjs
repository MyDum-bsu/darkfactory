import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { allowedPathsFromAttempt, allowedPathsFromLabels, isApprovedWorker, queueModeSpecInputs,
  scopeFenceReworkResult } from './run-isolated.mjs';

test('isApprovedWorker accepts SWE-2.1 implementation workers and legacy SWE-2 High', () => {
  for (const model of ['swe-2-1-medium', 'swe-2-1-high', 'swe-2-1-xhigh', 'swe-2-1-max']) {
    assert.equal(isApprovedWorker({ provider: 'acp-devin', model }), true);
  }
  assert.equal(isApprovedWorker({ provider: 'acp-devin', model: 'swe-2-high' }), true);
});

test('isApprovedWorker rejects unapproved SWE-2.1 variants and provider/model mismatches', () => {
  for (const spec of [
    { provider: 'acp-devin', model: 'swe-2-1-fake' },
    { provider: 'acp-devin', model: 'swe-2-1-low' },
    { provider: 'openai', model: 'swe-2-1-medium' },
    { provider: 'acp-devin' },
  ]) {
    assert.equal(isApprovedWorker(spec), false);
  }
});


const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

test('queue mode injects the verified card specification into worker and review specs', () => {
  const specText = 'Card-specific implementation specification\nwith a second line.';
  const digest = sha256(specText);
  const result = queueModeSpecInputs({ route: {}, attempt: { spec_digest: digest, specText },
    operatorBrief: 'Static operator brief', reviewSpec: 'Static review policy' });
  const block = `Task specification (verified spec_digest ${digest}):\n${specText}`;
  assert.equal(result.workerBrief, `Static operator brief\n\n${block}`);
  assert.equal(result.reviewSpec, `Static review policy\n\n${block}`);
  assert.equal(result.specText, specText);
});

test('queue mode fails closed when card text does not match spec_digest', () => {
  assert.throws(() => queueModeSpecInputs({ route: {},
      attempt: { spec_digest: sha256('trusted specification'), specText: 'tampered specification' },
      operatorBrief: 'Static operator brief', reviewSpec: 'Static review policy' }),
    /card_spec_digest_mismatch/);
});

test('single-card mode ignores card spec text and preserves static operator inputs', () => {
  const result = queueModeSpecInputs({ route: { taskId: '7' },
    attempt: { spec_digest: sha256('trusted specification'), specText: 'tampered specification' },
    operatorBrief: 'Static operator brief', reviewSpec: 'Static review policy' });
  assert.equal(result.workerBrief, 'Static operator brief');
  assert.equal(result.reviewSpec, 'Static review policy');
  assert.equal(result.specText, null);
});

test('legacy static-brief queue cards keep the existing unprefixed behavior', () => {
  const operatorBrief = 'Static operator brief';
  const result = queueModeSpecInputs({ route: {},
    attempt: { spec_digest: sha256(operatorBrief), specText: 'queue card text is not the pinned brief' },
    operatorBrief, reviewSpec: 'Static review policy' });
  assert.equal(result.workerBrief, operatorBrief);
  assert.equal(result.reviewSpec, 'Static review policy');
});

test('sealed pilot cards pinned to the review spec keep static inputs unchanged', () => {
  const operatorBrief = 'Static operator brief';
  const reviewSpec = 'Sealed A/B pilot review policy';
  const result = queueModeSpecInputs({ route: {},
    attempt: { spec_digest: sha256(reviewSpec), specText: 'Isolated #1448 policy' },
    operatorBrief, reviewSpec });
  assert.equal(result.workerBrief, operatorBrief);
  assert.equal(result.reviewSpec, reviewSpec);
  assert.equal(result.specText, null);
  assert.equal(result.block, null);

  assert.throws(() => queueModeSpecInputs({ route: {},
      attempt: { spec_digest: sha256('unrelated digest'), specText: 'Isolated #1448 policy' },
      operatorBrief, reviewSpec }),
    /card_spec_digest_mismatch/);
});

test('queue mode without card spec text preserves existing static behavior', () => {
  const result = queueModeSpecInputs({ route: {},
    attempt: { spec_digest: 'f'.repeat(64) },
    operatorBrief: 'Static operator brief', reviewSpec: 'Static review policy' });
  assert.equal(result.workerBrief, 'Static operator brief');
  assert.equal(result.reviewSpec, 'Static review policy');
});

test('allowedPathsFromLabels parses the card label and treats absence as unrestricted', () => {
  assert.equal(allowedPathsFromLabels({}), null);
  assert.equal(allowedPathsFromLabels(null), null);
  assert.deepEqual(allowedPathsFromLabels({ allowed_paths: 'board_pipeline/,ops/control-room/' }),
    ['board_pipeline/', 'ops/control-room/']);
  assert.throws(() => allowedPathsFromLabels({ allowed_paths: '../x' }), /scope_fence_path_invalid/);
  assert.throws(() => allowedPathsFromLabels({ allowed_paths: '' }), /scope_fence_path_invalid/);
  assert.throws(() => allowedPathsFromLabels({ allowed_paths: 42 }), /allowed_paths_invalid/);
});

test('allowedPathsFromAttempt prefers pinned attempt data over live labels', () => {
  assert.deepEqual(allowedPathsFromAttempt({ allowed_paths: 'a.mjs' }, { allowed_paths: 'b.mjs' }), ['a.mjs']);
  assert.deepEqual(allowedPathsFromAttempt({ labels: { allowed_paths: 'a.mjs,b/' } }, null), ['a.mjs', 'b/']);
  assert.deepEqual(allowedPathsFromAttempt({}, { allowed_paths: 'c.mjs' }), ['c.mjs']);
  assert.equal(allowedPathsFromAttempt({}, {}), null);
});

test('scopeFenceReworkResult is typed deterministic worker feedback', () => {
  const result = scopeFenceReworkResult(['outside.mjs'], ['board_pipeline/']);
  assert.equal(result.outcome, 'rework');
  assert.equal(result.reason, 'scope_fence_violation');
  assert.deepEqual(result.feedback.violations, ['outside.mjs']);
  assert.equal(result.feedback.findings[0].file, 'outside.mjs');
  assert.match(result.feedback.findings[0].expected, /board_pipeline\//);
  assert.deepEqual(result, scopeFenceReworkResult(['outside.mjs'], ['board_pipeline/']));
});
