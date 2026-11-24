import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVED_IMPLEMENTATION_MODELS,
  validateImplementationPreset,
} from './check-host.mjs';

test('doctor implementation preset accepts SWE-2.1 and legacy SWE-2 High, rejects unknown models', () => {
  assert.deepEqual([...APPROVED_IMPLEMENTATION_MODELS], [
    'swe-2-high',
    'swe-2-1-medium',
    'swe-2-1-high',
    'swe-2-1-xhigh',
    'swe-2-1-max',
  ]);
  for (const model of ['swe-2-1-medium', 'swe-2-high']) {
    assert.equal(validateImplementationPreset({ provider: 'acp-devin', model }), true);
  }
  assert.equal(validateImplementationPreset({ provider: 'acp-devin', model: 'swe-2-1-fake' }), false);
  assert.equal(validateImplementationPreset({ provider: 'google', model: 'swe-2-1-medium' }), false);
});
