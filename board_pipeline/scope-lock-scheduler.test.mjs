import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScopePaths, pathsOverlap, planSlotAssignments } from './scope-lock-scheduler.mjs';

test('normalizeScopePaths parses comma-separated strings and arrays verbatim', () => {
  assert.deepEqual(normalizeScopePaths('a/b.mjs, c/d.mjs'), ['a/b.mjs', 'c/d.mjs']);
  assert.deepEqual(normalizeScopePaths(['ops/x.mjs', 'ops/y.mjs']), ['ops/x.mjs', 'ops/y.mjs']);
  assert.deepEqual(normalizeScopePaths('a.mjs,a.mjs'), ['a.mjs']);
  // Пробелы вокруг записей снимаются, ядро сохраняется как есть.
  assert.deepEqual(normalizeScopePaths('  ops/x.mjs  ,  docs/ '), ['ops/x.mjs', 'docs/']);
  // Завершающий слэш значим и не срезается: это маркер префикса директории.
  assert.deepEqual(normalizeScopePaths('ops/'), ['ops/']);
  assert.deepEqual(normalizeScopePaths(['ops/control-room/']), ['ops/control-room/']);
});

test('normalizeScopePaths returns null for unscoped input (exclusive repo lock)', () => {
  assert.equal(normalizeScopePaths(null), null);
  assert.equal(normalizeScopePaths(undefined), null);
  assert.equal(normalizeScopePaths(''), null);
  assert.equal(normalizeScopePaths('   '), null);
  assert.equal(normalizeScopePaths([]), null);
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
});

test('normalizeScopePaths rejects backslashes instead of normalizing them', () => {
  // regression: fence-aligned validation never launders a backslash spelling
  // into a valid lookalike — malformed input is invalid, not normalized
  assert.throws(() => normalizeScopePaths('ops\\control-room\\finops.mjs'), /^Error: invalid_scope_path$/);
  assert.throws(() => normalizeScopePaths(['ops\\x.mjs']), /^Error: invalid_scope_path$/);
  assert.throws(() => normalizeScopePaths('a\\b'), /^Error: invalid_scope_path$/);
});

test('normalizeScopePaths rejects dot-slash prefixes and doubled slashes', () => {
  for (const raw of ['./a/b.mjs', './', '.', 'a//b.mjs', './x']) {
    assert.throws(() => normalizeScopePaths(raw), /^Error: invalid_scope_path$/, JSON.stringify(raw));
  }
  assert.throws(() => normalizeScopePaths(['./ops/x.mjs']), /^Error: invalid_scope_path$/);
  // fence-exact alignment: an inner '.' segment is legal in scope-fence.mjs
  // (only leading './' is rejected), so the scheduler accepts it verbatim too
  assert.deepEqual(normalizeScopePaths('a/./b'), ['a/./b']);
});

test('normalizeScopePaths rejects wildcards in any position', () => {
  // regression: the fence has no glob support, so '*' can never be honored —
  // it is invalid input, never an unscoped lock
  assert.throws(() => normalizeScopePaths('*'), /^Error: invalid_scope_path$/);
  assert.throws(() => normalizeScopePaths(['*']), /^Error: invalid_scope_path$/);
  assert.throws(() => normalizeScopePaths(['ops/x.mjs', '*']), /^Error: invalid_scope_path$/);
  assert.throws(() => normalizeScopePaths('ops/*.mjs'), /^Error: invalid_scope_path$/);
  assert.throws(() => normalizeScopePaths('a*b'), /^Error: invalid_scope_path$/);
  assert.throws(() => normalizeScopePaths('../x, *'), /^Error: invalid_scope_path$/);
});

test('normalizeScopePaths rejects control characters like the fence does', () => {
  assert.throws(() => normalizeScopePaths('a\0b'), /^Error: invalid_scope_path$/);
  assert.throws(() => normalizeScopePaths('a\rb'), /^Error: invalid_scope_path$/);
  assert.throws(() => normalizeScopePaths('a\nb'), /^Error: invalid_scope_path$/);
});

test('pathsOverlap detects exact file overlap only for equal files', () => {
  assert.equal(pathsOverlap(['board_pipeline/daemon.mjs'], ['board_pipeline/daemon.mjs']), true);
  assert.equal(pathsOverlap(['a.mjs'], ['b.mjs']), false);
  // exact file entries without trailing slash are files, not prefixes:
  // 'ops/control-room' the file cannot overlap a file beneath a same-named directory
  assert.equal(pathsOverlap(['ops/control-room'], ['ops/control-room/finops.mjs']), false);
  assert.equal(pathsOverlap(['ops/control-room/finops.mjs'], ['ops/control-room']), false);
  assert.equal(pathsOverlap(['ops'], ['ops/x.mjs']), false);
});

test('pathsOverlap honors directory prefixes only with a trailing slash', () => {
  assert.equal(pathsOverlap(['ops/control-room/'], ['ops/control-room/finops.mjs']), true);
  assert.equal(pathsOverlap(['ops/control-room/finops.mjs'], ['ops/control-room/']), true);
  assert.equal(pathsOverlap(['ops/control-room/'], ['ops/control-room/']), true);
  // nested directory prefixes overlap by containment in either direction
  assert.equal(pathsOverlap(['ops/'], ['ops/control-room/']), true);
  assert.equal(pathsOverlap(['ops/control-room/'], ['ops/']), true);
  // sibling directory prefixes do not overlap
  assert.equal(pathsOverlap(['ops/foo/'], ['ops/bar/']), false);
});

test('pathsOverlap fence semantics: an exact file and a same-named directory never conflict', () => {
  // 'ops' the file and 'ops/' the directory cannot coexist in one repository
  assert.equal(pathsOverlap(['ops'], ['ops/']), false);
  assert.equal(pathsOverlap(['ops/'], ['ops']), false);
  // but a directory prefix does overlap exact files beneath it
  assert.equal(pathsOverlap(['ops/'], ['ops/foo.mjs']), true);
  assert.equal(pathsOverlap(['ops/foo.mjs'], ['ops/']), true);
});

test('pathsOverlap does not overlap sibling prefixes (ops/foo vs ops/foobar)', () => {
  assert.equal(pathsOverlap(['ops/foo/'], ['ops/foobar/']), false);
  assert.equal(pathsOverlap(['ops/foo/'], ['ops/foobar/x.mjs']), false);
  assert.equal(pathsOverlap(['ops/foo/x.mjs'], ['ops/foobar/']), false);
  // but a true child does overlap
  assert.equal(pathsOverlap(['ops/foo/'], ['ops/foo/bar.mjs']), true);
  assert.equal(pathsOverlap(['ops/foo/'], ['ops/foo/bar/']), true);
});

test('pathsOverlap rejects invalid input fail-closed instead of comparing raw forms', () => {
  assert.throws(() => pathsOverlap(['../x'], ['a.mjs']), /^Error: invalid_scope_path$/);
  assert.throws(() => pathsOverlap(['a.mjs'], ['/abs']), /^Error: invalid_scope_path$/);
  assert.throws(() => pathsOverlap(['ops\\x'], ['a.mjs']), /^Error: invalid_scope_path$/);
  assert.throws(() => pathsOverlap(['./ops'], ['a.mjs']), /^Error: invalid_scope_path$/);
  assert.throws(() => pathsOverlap(['*'], ['a.mjs']), /^Error: invalid_scope_path$/);
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

test('planSlotAssignments allows disjoint exact files under one directory', () => {
  // fence-aligned regression: exact-file scopes no longer lock whole subtrees,
  // so two files in the same directory can run in parallel
  const result = planSlotAssignments({
    slots: ['df-auto', 'df-slot-2'],
    activeTasks: [],
    readyTasks: [
      { taskId: 't1', repoId: 'repo-a', allowedPaths: ['docs/readme.md'], priority: 10 },
      { taskId: 't2', repoId: 'repo-a', allowedPaths: ['docs/other.md'], priority: 9 },
    ],
  });
  assert.deepEqual(result.assignments.map(a => a.taskId), ['t1', 't2']);
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
  // t1 conflicts with active-1 (ops/ is a directory prefix of its path)
  const t1 = result.deferred.find(d => d.taskId === 't1');
  assert.equal(t1.reason, 'scope_conflict');
  assert.deepEqual(t1.conflictingTaskIds, ['active-1']);
  // t2 is clean and takes a slot; docs/readme.md and docs/other.md are
  // disjoint exact files, so t3 also assigns.
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

test('planSlotAssignments canonicalizes repoId by trim and lowercase', () => {
  // regression: 'REPO-A' and 'repo-a' are one lock domain — a case or
  // whitespace difference must never split the exclusive scope
  const result = planSlotAssignments({
    slots: ['df-auto', 'df-slot-2'],
    activeTasks: [{ taskId: 'active-1', repoId: 'REPO-A', allowedPaths: ['ops/'] }],
    readyTasks: [
      { taskId: 't1', repoId: 'repo-a', allowedPaths: ['ops/x.mjs'], priority: 10 },
    ],
  });
  assert.deepEqual(result.assignments, []);
  const t1 = result.deferred.find(d => d.taskId === 't1');
  assert.equal(t1.reason, 'scope_conflict');
  assert.deepEqual(t1.conflictingTaskIds, ['active-1']);

  // whitespace padding canonicalizes too, and the assignment echoes the canonical id
  const padded = planSlotAssignments({
    slots: ['df-auto'],
    activeTasks: [],
    readyTasks: [{ taskId: 't2', repoId: '  Repo-B  ', allowedPaths: ['a.mjs'], priority: 1 }],
  });
  assert.deepEqual(padded.assignments.map(a => a.taskId), ['t2']);
  assert.equal(padded.assignments[0].repoId, 'repo-b');

  // a repoId that is empty after trimming is not a valid task
  assert.throws(() => planSlotAssignments({ slots: [], readyTasks: [{ taskId: 'x', repoId: '   ' }] }),
    /^Error: invalid_scheduler_task/);
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

test('planSlotAssignments defers invalid paths with invalid_scope instead of throwing', () => {
  const result = planSlotAssignments({
    slots: ['df-auto'],
    activeTasks: [],
    readyTasks: [
      { taskId: 'evil', repoId: 'repo-a', allowedPaths: ['../etc/passwd'], priority: 10 },
      { taskId: 'backslash', repoId: 'repo-a', allowedPaths: ['ops\\x.mjs'], priority: 9 },
      { taskId: 'wildcard', repoId: 'repo-a', allowedPaths: ['*'], priority: 8 },
      { taskId: 'dotslash', repoId: 'repo-a', allowedPaths: ['./ops/x.mjs'], priority: 7 },
      { taskId: 'good', repoId: 'repo-a', allowedPaths: ['a.mjs'], priority: 6 },
    ],
  });
  assert.deepEqual(result.deferred, [
    { taskId: 'evil', reason: 'invalid_scope', conflictingTaskIds: [] },
    { taskId: 'backslash', reason: 'invalid_scope', conflictingTaskIds: [] },
    { taskId: 'wildcard', reason: 'invalid_scope', conflictingTaskIds: [] },
    { taskId: 'dotslash', reason: 'invalid_scope', conflictingTaskIds: [] },
  ]);
  assert.deepEqual(result.assignments.map(a => a.taskId), ['good']);
});

test('planSlotAssignments treats an active task with invalid scope as an exclusive lock', () => {
  const result = planSlotAssignments({
    slots: ['df-auto'],
    activeTasks: [{ taskId: 'active-legacy', repoId: 'repo-a', allowedPaths: ['ops\\control-room'] }],
    readyTasks: [
      { taskId: 't1', repoId: 'repo-a', allowedPaths: ['docs/x.md'], priority: 10 },
    ],
  });
  // fail-closed: the unparseable active scope locks the whole repo even for
  // a task whose own paths are disjoint from the intended scope
  assert.deepEqual(result.assignments, []);
  assert.equal(result.deferred[0].reason, 'scope_conflict');
  assert.deepEqual(result.deferred[0].conflictingTaskIds, ['active-legacy']);
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

test('assignment output preserves trailing-slash directory prefixes verbatim', () => {
  const result = planSlotAssignments({
    slots: ['df-auto'],
    activeTasks: [],
    readyTasks: [
      { taskId: 't1', repoId: 'repo-a', allowedPaths: 'ops/control-room/, board_pipeline/merge-queue.mjs', priority: 1 },
    ],
  });
  assert.deepEqual(result.assignments[0].allowedPaths,
    ['ops/control-room/', 'board_pipeline/merge-queue.mjs']);
});
