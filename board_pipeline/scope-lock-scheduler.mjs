// Scope-Lock Multi-Slot Scheduler (Board #7919): deterministic greedy planner
// that packs as many ready tasks as possible into idle slots while guaranteeing
// that no two tasks in the same repository hold overlapping `allowed_paths`
// scopes. Tasks in different repositories never conflict. Unscoped tasks
// (null/empty scope) take an exclusive repo-wide lock — the fail-closed
// direction, because an unknown scope can never be proven disjoint.
//
// Path validation and prefix semantics are aligned with scope-fence.mjs, the
// gate that actually enforces the fence at submission time: an entry ending
// in '/' is a directory prefix, any other entry is an exact file. Entries
// with backslashes, './' prefixes, doubled slashes, traversal segments,
// absolute or drive-letter paths, control characters and '*' are invalid —
// never normalized into a valid lookalike. Repository identity is canonical:
// trimmed and lowercased, so 'REPO-A' and 'repo-a' share one lock domain.
//
// The module is pure and deterministic: no I/O, no randomness, no clock.
// Ordering never depends on locale — all tie-breaks use codepoint comparison.

const INVALID_SCOPE = 'invalid_scope_path';
const INVALID_INPUT = 'invalid_scheduler_input';
const INVALID_TASK = 'invalid_scheduler_task';

function invalidScope() {
  return new Error(INVALID_SCOPE);
}

// Validate one scope entry with exactly the rules of scope-fence.mjs
// (validateRelativePrefix) plus rejection of '*': the fence has no glob
// support, so any wildcard intent can never be honored — deferring the task
// as invalid is the fail-closed direction. The entry is preserved verbatim
// after trim: a trailing slash stays significant because it is the only
// difference between a directory prefix and an exact file.
function validateScopeEntry(rawEntry) {
  if (typeof rawEntry !== 'string') throw invalidScope();
  const value = rawEntry.trim();
  if (value === '') throw invalidScope();
  if (value.includes('\0') || value.includes('\\') || value.includes('\r') ||
      value.includes('\n') || value.includes('*')) {
    throw invalidScope();
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw invalidScope();
  if (value === '.' || value === './' || value.startsWith('./')) throw invalidScope();
  if (value.includes('//')) throw invalidScope();
  const segments = value.split('/');
  if (segments.some(segment => segment === '..')) throw invalidScope();
  if (segments.some((segment, index) => segment === '' && index !== segments.length - 1)) {
    throw invalidScope();
  }
  return value;
}

// Accepts a comma-separated string or a string array of relative file paths
// and directory prefixes and returns a validated, de-duplicated array with
// entries verbatim (trailing slashes preserved). Returns null when the task
// is unscoped (null/undefined input or empty input) — an unscoped task holds
// an exclusive repo-wide lock. Traversal segments, absolute paths,
// backslashes, './' prefixes, wildcards, empty entries and malformed input
// are rejected fail-closed with `invalid_scope_path`.
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
  if (entries.some(entry => typeof entry !== 'string' || entry === '')) throw invalidScope();
  return [...new Set(entries.map(validateScopeEntry))];
}

// One path pair overlaps under scope-fence semantics: exact files overlap
// only when equal, a directory prefix overlaps every entry beneath it, and
// two directory prefixes overlap when one contains the other. An exact file
// is never beneath a same-named directory prefix ('ops' the file and 'ops/'
// the directory cannot coexist in one repository, so they cannot conflict).
function pairOverlaps(a, b) {
  const aIsDir = a.endsWith('/');
  const bIsDir = b.endsWith('/');
  if (aIsDir && bIsDir) return a.startsWith(b) || b.startsWith(a);
  if (aIsDir) return b.startsWith(a);
  if (bIsDir) return a.startsWith(b);
  return a === b;
}

// Decide whether two scope path sets overlap. Null or empty on either side
// means an unscoped task with an exclusive repo-wide lock, which overlaps
// everything — fail-closed. String AND array inputs are always validated
// before comparison: the comparison never sees a raw caller-supplied form,
// and invalid entries propagate the validation error.
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

// Repository identity is canonical — trimmed and lowercased — so that lock
// domains never split over spelling differences ('Repo-A' vs 'repo-a').
function canonicalRepoId(repoId) {
  if (typeof repoId !== 'string') return null;
  const canonical = repoId.trim().toLowerCase();
  return canonical === '' ? null : canonical;
}

function validateTask(task, index, kind) {
  if (task === null || typeof task !== 'object' || Array.isArray(task) ||
      typeof task.taskId !== 'string' || task.taskId === '' ||
      canonicalRepoId(task.repoId) === null) {
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
// Active tasks whose own scope fails validation are treated as unscoped
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
    return { taskId: task.taskId, repoId: canonicalRepoId(task.repoId), paths };
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
    const repoId = canonicalRepoId(task.repoId);
    const blockers = [];
    for (const other of [...activeNorm, ...assigned]) {
      if (other.repoId !== repoId) continue; // different repos never conflict
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
    assignments.push({ slot, taskId: task.taskId, repoId, allowedPaths: paths });
    assigned.push({ taskId: task.taskId, repoId, paths });
  }
  return { assignments, deferred };
}
