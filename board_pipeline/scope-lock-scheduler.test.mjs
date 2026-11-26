import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScopePaths, pathsOverlap, planSlotAssignments } from './scope-lock-scheduler.mjs';

test('normalizeScopePaths parses comma-separated strings and arrays with slash normalization', () => {
  assert.deepEqual(normalizeScopePaths('a/b.mjs, c/d/'), ['a/b.mjs', 'c/d']);
  assert.deepEqual(normalizeScopePaths(['ops/x.mjs', 'ops/y.mjs']), ['ops/x.mjs', 'ops/y.mjs']);
  assert.deepEqual(normalizeScopePaths('ops\\control-room\\finops.mjs'), ['ops/control-room/finops.mjs']);
  assert.deepEqual(normalizeScopePaths('a//b.mjs'), ['a/b.mjs']);
  assert.deepEqual(normalizeScopePaths('./a/b.mjs'), ['a/b.mjs']);
  assert.deepEqual(normalizeScopePaths('a.mjs,a.mjs'), ['a.mjs']);
});

test('normalizeScopePaths returns null for unscoped input (exclusive repo lock)', () => {
  assert.equal(normalizeScopePaths(null), null);
  assert.equal(normalizeScopePaths(undefined), null);
  assert.equal(normalizeScopePaths(''), null);
  assert.equal(normalizeScopePaths('   '), null);
  assert.equal(normalizeScopePaths([]), null);
  assert.equal(normalizeScopePaths('*'), null);
  assert.equal(normalizeScopePaths(['ops/x.mjs', '*']), null);
});

test('normalizeScopePaths rejects traversal, absolute and malformed paths fail-closed', () => {
  for (const raw of [
    '../x', 'a/../b', '..', 'a/../../etc/passwd', '/abs/path', '/etc/passwd',
    'C:/temp/file', 'c:\\temp\\file', 'a.mjs,', ',a.mjs', 'a.mjs,,b.mjs',
  ]) {
    assert.throws(() => normalizeScopePaths(raw), /^Error: invalid_scope_path$/, JSON.stringify(raw));
  }
  assert.throws(() => normalizeScopePaths(['ops/x.mjs', '']), /^Error: invalid_scope_path$/);
  assert.throws(() => normalizeScopePaths(['ops/x.mjs', 42]), /^Error: invalid_scope_path$/);
  assert.throws(() => normalizeScopePaths(42), /^Error: invalid_scope_path$/);
  assert.throws(() => normalizeScopePaths('a/./b'), /^Error: invalid_scope_path$/);
});

test('pathsOverlap detects exact file overlap', () => {
  assert.equal(pathsOverlap(['board_pipeline/daemon.mjs'], ['board_pipeline/daemon.mjs']), true);
  assert.equal(pathsOverlap(['a.mjs'], ['b.mjs']), false);
});

test('pathsOverlap detects directory prefix overlap in both slash forms', () => {
  assert.equal(pathsOverlap(['ops/control-room'], ['ops/control-room/finops.mjs']), true);
  assert.equal(pathsOverlap(['ops/control-room/finops.mjs'], ['ops/control-room']), true);
  // trailing slash normalized away — same result
  assert.equal(pathsOverlap(normalizeScopePaths('ops/control-room/'), ['ops/control-room/finops.mjs']), true);
  assert.equal(pathsOverlap(['ops/control-room'], ['ops/control-room']), true);
});

test('pathsOverlap does not overlap sibling prefixes (ops/foo vs ops/foobar)', () => {
  assert.equal(pathsOverlap(['ops/foo'], ['ops/foobar']), false);
  assert.equal(pathsOverlap(['ops/foo'], ['ops/foobar/x.mjs']), false);
  assert.equal(pathsOverlap(['ops/foo/x.mjs'], ['ops/foobar']), false);
  assert.equal(pathsOverlap(['ops/foo'], ['ops/foo-bar']), false);
  // but a true child does overlap
  assert.equal(pathsOverlap(['ops/foo'], ['ops/foo/bar.mjs']), true);
});

test('pathsOverlap treats null or empty scope as exclusive lock overlapping everything', () => {
  assert.equal(pathsOverlap(null, ['a.mjs']), true);
  assert.equal(pathsOverlap(['a.mjs'], null), true);
  assert.equal(pathsOverlap(null, null), true);
  assert.equal(pathsOverlap([], ['a.mjs']), true);
  assert.equal(pathsOverlap(['a.mjs'], []), true);
  assert.equal(pathsOverlap([], []), true);
});

test('planSlotAssignments packs non-overlapping tasks across multiple slots greedily', () => {
  const result = planSlotAssignments({
    slots: ['df-auto', 'df-slot-2', 'df-slot-3', 'df-slot-4'],
    activeTasks: [],
    readyTasks: [
      { taskId: 't1', repoId: 'repo-a', allowedPaths: ['ops/control-room/'], priority: 10 },
      { taskId: 't2', repoId: 'repo-a', allowedPaths: ['board_pipeline/daemon.mjs'], priority: 9 },
      { taskId: 't3', repoId: 'repo-a', allowedPaths: ['docs/'], priority: 8 },
    ],
  });
  assert.equal(result.assignments.length, 3);
  assert.deepEqual(result.assignments.map(a => a.slot), ['df-auto', 'df-slot-2', 'df-slot-3']);
  assert.deepEqual(result.assignments.map(a => a.taskId), ['t1', 't2', 't3']);
  assert.deepEqual(result.deferred, []);
});

test('planSlotAssignments defers overlapping tasks with scope_conflict and tracks conflicting ids', () => {
  const result = planSlotAssignments({
    slots: ['df-auto', 'df-slot-2'],
    activeTasks: [{ taskId: 'active-1', repoId: 'repo-a', allowedPaths: ['ops/'] }],
    readyTasks: [
      { taskId: 't1', repoId: 'repo-a', allowedPaths: ['ops/control-room/finops.mjs'], priority: 10 },
      { taskId: 't2', repoId: 'repo-a', allowedPaths: ['docs/readme.md'], priority: 9 },
      { taskId: 't3', repoId: 'repo-a', allowedPaths: ['docs/other.md'], priority: 8 },
    ],
  });
  // t1 conflicts with active-1 (ops/ is a prefix of its path)
  const t1 = result.deferred.find(d => d.taskId === 't1');
  assert.equal(t1.reason, 'scope_conflict');
  assert.deepEqual(t1.conflictingTaskIds, ['active-1']);
  // t2 is clean and takes a slot; t3 conflicts with t2's docs/ sibling? no —
  // docs/readme.md and docs/other.md are disjoint files, so t3 also assigns.
  assert.deepEqual(result.assignments.map(a => a.taskId), ['t2', 't3']);
});

test('planSlotAssignments tracks conflicts against newly assigned tasks in priority order', () => {
  const result = planSlotAssignments({
    slots: ['df-auto', 'df-slot-2'],
    activeTasks: [],
    readyTasks: [
      { taskId: 'low', repoId: 'repo-a', allowedPaths: ['ops/foo/x.mjs'], priority: 1 },
      { taskId: 'high', repoId: 'repo-a', allowedPaths: ['ops/foo/'], priority: 100 },
    ],
  });
  // higher priority task wins the slot; the lower priority overlapping task defers
  assert.deepEqual(result.assignments.map(a => a.taskId), ['high']);
  const low = result.deferred.find(d => d.taskId === 'low');
  assert.equal(low.reason, 'scope_conflict');
  assert.deepEqual(low.conflictingTaskIds, ['high']);
});

test('planSlotAssignments never conflicts tasks in different repos even with identical paths', () => {
  const result = planSlotAssignments({
    slots: ['df-auto', 'df-slot-2'],
    activeTasks: [{ taskId: 'active-1', repoId: 'repo-a', allowedPaths: ['ops/'] }],
    readyTasks: [
      { taskId: 't1', repoId: 'repo-b', allowedPaths: ['ops/'], priority: 10 },
    ],
  });
  assert.deepEqual(result.assignments.map(a => a.taskId), ['t1']);
  assert.deepEqual(result.deferred, []);
});

test('planSlotAssignments enforces exclusive lock for unscoped tasks', () => {
  const result = planSlotAssignments({
    slots: ['df-auto', 'df-slot-2'],
    activeTasks: [],
    readyTasks: [
      { taskId: 'scoped', repoId: 'repo-a', allowedPaths: ['ops/foo.mjs'], priority: 10 },
      { taskId: 'unscoped', repoId: 'repo-a', allowedPaths: null, priority: 9 },
    ],
  });
  // unscoped overlaps everything in its repo — scoped wins by priority
  assert.deepEqual(result.assignments.map(a => a.taskId), ['scoped']);
  const unscoped = result.deferred.find(d => d.taskId === 'unscoped');
  assert.equal(unscoped.reason, 'scope_conflict');
  assert.deepEqual(unscoped.conflictingTaskIds, ['scoped']);

  // an unscoped task takes the repo when nothing else runs there
  const solo = planSlotAssignments({
    slots: ['df-auto'],
    activeTasks: [],
    readyTasks: [{ taskId: 'unscoped', repoId: 'repo-a', allowedPaths: undefined, priority: 1 }],
  });
  assert.deepEqual(solo.assignments.map(a => a.taskId), ['unscoped']);
  assert.equal(solo.assignments[0].allowedPaths, null);
});

test('planSlotAssignments defers no_free_slot when slots are exhausted', () => {
  const result = planSlotAssignments({
    slots: ['df-auto'],
    activeTasks: [],
    readyTasks: [
      { taskId: 't1', repoId: 'repo-a', allowedPaths: ['a.mjs'], priority: 10 },
      { taskId: 't2', repoId: 'repo-a', allowedPaths: ['b.mjs'], priority: 9 },
    ],
  });
  assert.deepEqual(result.assignments.map(a => a.taskId), ['t1']);
  assert.deepEqual(result.deferred, [{ taskId: 't2', reason: 'no_free_slot', conflictingTaskIds: [] }]);
});

test('planSlotAssignments defers invalid .. paths with invalid_scope instead of throwing', () => {
  const result = planSlotAssignments({
    slots: ['df-auto'],
    activeTasks: [],
    readyTasks: [
      { taskId: 'evil', repoId: 'repo-a', allowedPaths: ['../etc/passwd'], priority: 10 },
      { taskId: 'good', repoId: 'repo-a', allowedPaths: ['a.mjs'], priority: 9 },
    ],
  });
  assert.deepEqual(result.deferred, [{ taskId: 'evil', reason: 'invalid_scope', conflictingTaskIds: [] }]);
  assert.deepEqual(result.assignments.map(a => a.taskId), ['good']);
});

test('planSlotAssignments is deterministic regardless of ready input order', () => {
  const tasks = [
    { taskId: 't3', repoId: 'repo-a', allowedPaths: ['c.mjs'], priority: 5 },
    { taskId: 't1', repoId: 'repo-a', allowedPaths: ['a.mjs'], priority: 5 },
    { taskId: 't2', repoId: 'repo-a', allowedPaths: ['b.mjs'], priority: 5 },
  ];
  const args = { slots: ['s1', 's2', 's3'], activeTasks: [], readyTasks: tasks };
  const first = planSlotAssignments(args);
  const second = planSlotAssignments({ ...args, readyTasks: [...tasks].reverse() });
  assert.deepEqual(first, second);
  // equal priorities fall back to taskId codepoint order
  assert.deepEqual(first.assignments.map(a => a.taskId), ['t1', 't2', 't3']);
  // inputs are not mutated
  assert.deepEqual(tasks.map(t => t.taskId), ['t3', 't1', 't2']);
});

test('planSlotAssignments rejects malformed input fail-closed', () => {
  assert.throws(() => planSlotAssignments({ slots: 'nope' }), /^Error: invalid_scheduler_input$/);
  assert.throws(() => planSlotAssignments({ slots: [], readyTasks: [{ repoId: 'r' }] }),
    /^Error: invalid_scheduler_task/);
});
