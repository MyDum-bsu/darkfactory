// Scope-Lock Multi-Slot Scheduler (Board #7919): deterministic greedy planner
// that packs as many ready tasks as possible into idle slots while guaranteeing
// that no two tasks in the same repository hold overlapping `allowed_paths`
// scopes. Tasks in different repositories never conflict. Unscoped tasks
// (null/empty scope) take an exclusive repo-wide lock — the fail-closed
// direction, because an unknown scope can never be proven disjoint.
//
// The module is pure and deterministic: no I/O, no randomness, no clock.
// Ordering never depends on locale — all tie-breaks use codepoint comparison.

const INVALID_SCOPE = 'invalid_scope_path';
const INVALID_INPUT = 'invalid_scheduler_input';
const INVALID_TASK = 'invalid_scheduler_task';

function invalidScope() {
  return new Error(INVALID_SCOPE);
}

// Normalize one raw entry after slash normalization. Validation happens after
// normalization so that a backslash or doubled-slash variant of a traversal or
// absolute path is rejected exactly like its canonical form — fail-closed.
function normalizeEntry(rawEntry) {
  if (typeof rawEntry !== 'string') throw invalidScope();
  let value = rawEntry.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (value.startsWith('./')) value = value.slice(2);
  value = value.replace(/\/+$/, '');
  if (value === '' || value.includes('\0')) throw invalidScope();
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw invalidScope();
  const segments = value.split('/');
  if (segments.some(segment => segment === '..' || segment === '.')) throw invalidScope();
  return value;
}

// Accepts a comma-separated string or a string array of relative file or
// directory paths and returns a normalized, de-duplicated array. Returns null
// when the task is unscoped (null/undefined input, empty input, or a wildcard
// entry) — an unscoped task holds an exclusive repo-wide lock. Traversal
// segments, absolute paths, empty entries and malformed input are rejected
// fail-closed with `invalid_scope_path`.
export function normalizeScopePaths(raw) {
  if (raw === null || raw === undefined) return null;
  let entries;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    entries = trimmed.split(',').map(entry => entry.trim());
  } else if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    entries = raw.map(entry => (typeof entry === 'string' ? entry.trim() : entry));
  } else {
    throw invalidScope();
  }
  // Validation precedes wildcard widening: every entry is normalized (and
  // thereby validated fail-closed) before any '*' is honored, so a traversal
  // or absolute path hiding next to a wildcard is rejected, never laundered
  // into a legitimate unscoped lock.
  if (entries.some(entry => typeof entry !== 'string' || entry === '')) throw invalidScope();
  const normalized = entries.map(normalizeEntry);
  // A wildcard anywhere widens the scope to the whole repository; treating it
  // as unscoped is the safe direction (more locking, never less).
  if (normalized.includes('*')) return null;
  return [...new Set(normalized)];
}

// One path pair overlaps when they are equal or one is a directory prefix of
// the other on a `/` segment boundary — `ops/foo` never overlaps `ops/foobar`,
// while `ops/control-room` does overlap `ops/control-room/finops.mjs`.
function pairOverlaps(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// Decide whether two scope path sets overlap. Null or empty on either side
// means an unscoped task with an exclusive repo-wide lock, which overlaps
// everything — fail-closed. String AND array inputs are always normalized
// before comparison: trailing slashes, backslashes, './' prefixes and
// wildcards inside arrays must not bypass the boundary check (fail-open), so
// the comparison never sees a raw caller-supplied form. Invalid entries
// propagate the normalization error.
export function pathsOverlap(pathsA, pathsB) {
  const a = (typeof pathsA === 'string' || Array.isArray(pathsA)) ? normalizeScopePaths(pathsA) : pathsA;
  const b = (typeof pathsB === 'string' || Array.isArray(pathsB)) ? normalizeScopePaths(pathsB) : pathsB;
  if (a === null || a === undefined || a.length === 0) return true;
  if (b === null || b === undefined || b.length === 0) return true;
  for (const pathA of a) {
    for (const pathB of b) {
      if (pairOverlaps(pathA, pathB)) return true;
    }
  }
  return false;
}

function validateTask(task, index, kind) {
  if (task === null || typeof task !== 'object' || Array.isArray(task) ||
      typeof task.taskId !== 'string' || task.taskId === '' ||
      typeof task.repoId !== 'string' || task.repoId === '') {
    throw new Error(`${INVALID_TASK}:${kind}:${index}`);
  }
}

// Deterministic total order over ready tasks: higher numeric priority first
// (missing priority counts as 0), ties broken by taskId codepoint order. The
// input array is never mutated.
function priorityOrder(tasks) {
  return [...tasks].sort((a, b) => {
    const diff = (Number.isFinite(b.priority) ? b.priority : 0) -
      (Number.isFinite(a.priority) ? a.priority : 0);
    if (diff !== 0) return diff;
    if (a.taskId < b.taskId) return -1;
    if (a.taskId > b.taskId) return 1;
    return 0;
  });
}

// Greedily pack ready tasks into idle slots. A task is assigned when its scope
// is valid, no active or already-assigned task in the SAME repository overlaps
// it, and a free slot remains. Deferral reasons are checked in a fixed order —
// `invalid_scope` before `scope_conflict` before `no_free_slot` — so the output
// is a pure function of the input. Slots are consumed in input order.
// Active tasks whose own scope fails to normalize are treated as unscoped
// (exclusive lock) rather than dropped: fail-closed, never silently disjoint.
export function planSlotAssignments({ slots, activeTasks, readyTasks } = {}) {
  const idleSlots = slots ?? [];
  const active = activeTasks ?? [];
  const ready = readyTasks ?? [];
  if (!Array.isArray(idleSlots) || idleSlots.some(slot => typeof slot !== 'string' || slot === '') ||
      !Array.isArray(active) || !Array.isArray(ready)) {
    throw new Error(INVALID_INPUT);
  }
  const activeNorm = active.map((task, index) => {
    validateTask(task, index, 'active');
    let paths = null;
    try {
      paths = normalizeScopePaths(task.allowedPaths);
    } catch {
      paths = null; // fail-closed: unparseable active scope locks the whole repo
    }
    return { taskId: task.taskId, repoId: task.repoId, paths };
  });
  ready.forEach((task, index) => validateTask(task, index, 'ready'));

  const freeSlots = [...idleSlots];
  const assignments = [];
  const deferred = [];
  const assigned = [];

  for (const task of priorityOrder(ready)) {
    let paths;
    try {
      paths = normalizeScopePaths(task.allowedPaths);
    } catch {
      deferred.push({ taskId: task.taskId, reason: 'invalid_scope', conflictingTaskIds: [] });
      continue;
    }
    const blockers = [];
    for (const other of [...activeNorm, ...assigned]) {
      if (other.repoId !== task.repoId) continue; // different repos never conflict
      if (pathsOverlap(paths, other.paths)) blockers.push(other.taskId);
    }
    if (blockers.length > 0) {
      const conflictingTaskIds = [...new Set(blockers)].sort();
      deferred.push({ taskId: task.taskId, reason: 'scope_conflict', conflictingTaskIds });
      continue;
    }
    if (freeSlots.length === 0) {
      deferred.push({ taskId: task.taskId, reason: 'no_free_slot', conflictingTaskIds: [] });
      continue;
    }
    const slot = freeSlots.shift();
    assignments.push({ slot, taskId: task.taskId, repoId: task.repoId, allowedPaths: paths });
    assigned.push({ taskId: task.taskId, repoId: task.repoId, paths });
  }
  return { assignments, deferred };
}
