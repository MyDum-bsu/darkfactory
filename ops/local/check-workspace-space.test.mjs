import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBudget } from './check-workspace-space.mjs';

const blocksGiB = 262144n;
const disk = (available) => ({ bsize:4096n, bavail:available*blocksGiB, bfree:12n*blocksGiB });

test('uses available bytes rather than including reserved free blocks', () => {
  assert.deepEqual(checkBudget(disk(5n),'worktree'),{ kind:'worktree',minGiB:8,availableGiB:5,allowed:false });
  assert.equal(checkBudget(disk(8n),'worktree').allowed,true);
});
test('build needs 8 GiB; read-only review on an existing tree needs 3', () => {
  assert.equal(checkBudget(disk(7n),'build').allowed,false);
  assert.equal(checkBudget(disk(3n),'review').allowed,true);
  assert.equal(checkBudget(disk(2n),'review').allowed,false);
});
test('unknown policy or unavailable data fails closed', () => {
  assert.throws(()=>checkBudget(disk(90n),'whatever'),/kind/);
  assert.throws(()=>checkBudget({},'build'),/could not be measured/);
});
