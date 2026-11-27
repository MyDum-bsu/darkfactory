const INVALID_PATH = 'scope_fence_path_invalid';
const INVALID_INPUT = 'scope_fence_input_invalid';
const INVALID_NOTES = 'submission_notes_invalid';

function invalid(message = INVALID_PATH) {
  return new Error(message);
}

function validateRelativePrefix(entry) {
  if (typeof entry !== 'string') throw invalid();
  const value = entry.trim();
  if (!value) throw invalid();
  if (value.includes('\0') || value.includes('\\') || value.includes('\r') || value.includes('\n')) {
    throw invalid();
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw invalid();
  if (value === '.' || value === './' || value.startsWith('./')) throw invalid();
  if (value.includes('//')) throw invalid();
  const segments = value.split('/');
  if (segments.some(segment => segment === '..')) throw invalid();
  if (segments.some((segment, index) => segment === '' && index !== segments.length - 1)) throw invalid();
  return value;
}

function normalizeAllowed(allowedPaths) {
  if (typeof allowedPaths === 'string') return parseAllowedPaths(allowedPaths);
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) throw invalid(INVALID_INPUT);
  return allowedPaths.map(validateRelativePrefix);
}

function validChangedPath(path) {
  try {
    return validateRelativePrefix(path) === path && !path.endsWith('/');
  } catch {
    return false;
  }
}

function matchesAllowed(path, prefix) {
  return prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix;
}

// Parse a comma-separated allowlist of relative file paths and directory
// prefixes. Directory prefixes are explicit and end in '/'. The parser is
// intentionally syntactic: it does not inspect the filesystem.
export function parseAllowedPaths(raw) {
  if (typeof raw !== 'string') throw invalid(INVALID_INPUT);
  const entries = raw.split(',').map(entry => entry.trim());
  if (entries.length === 0 || entries.some(entry => entry === '')) throw invalid();
  return entries.map(validateRelativePrefix);
}

// Check candidate paths against an exact-file/directory-prefix allowlist.
// An absent allowlist denies by default; legacy unrestricted mode requires opt-in.
export function checkScopeFence(options = {}) {
  const { changedPaths, allowedPaths } = options ?? {};
  if (allowedPaths === null || allowedPaths === undefined) {
    if (options?.allowUnrestricted === true) return { ok: true, mode: 'unrestricted', violations: [] };
    return { ok: false, mode: 'denied', reason: 'allowed_paths_required', violations: [] };
  }
  const allowed = normalizeAllowed(allowedPaths);
  if (!Array.isArray(changedPaths)) throw invalid(INVALID_INPUT);
  const violations = [];
  for (const path of changedPaths) {
    if (!validChangedPath(path) || !allowed.some(prefix => matchesAllowed(path, prefix))) {
      if (!violations.includes(path)) violations.push(path);
    }
  }
  if (violations.length > 0) {
    return { ok: false, reason: 'scope_fence_violation', violations };
  }
  return { ok: true, mode: 'restricted', violations: [] };
}

function sanitizeNote(value) {
  if (typeof value !== 'string') throw invalid(INVALID_NOTES);
  const sanitized = value
    .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized || sanitized.length > 200) throw invalid(INVALID_NOTES);
  return sanitized;
}

// Validate and normalize optional operator-facing submission notes. Notes are
// evidence text only: control characters are removed, whitespace is flattened,
// at most ten non-empty notes of at most 200 characters are accepted.
export function validateSubmissionNotes(notes) {
  if (notes === undefined || notes === null) return [];
  if (!Array.isArray(notes) || notes.length > 10) throw invalid(INVALID_NOTES);
  const sanitized = [];
  for (let index = 0; index < notes.length; index += 1) {
    if (!Object.hasOwn(notes, index)) throw invalid(INVALID_NOTES);
    sanitized.push(sanitizeNote(notes[index]));
  }
  return sanitized;
}

// Render the worker-facing fence as data/instructions inside the intake
// prompt. The trusted controller independently enforces the same allowlist.
export function scopeFencePromptBlock(allowedPaths) {
  const allowed = normalizeAllowed(allowedPaths);
  return [
    'Scope Fence (hard constraint):',
    'Modify or create files only under these exact files or directory prefixes:',
    ...allowed.map(path => `- ${path}`),
    'Treat every other repository path as read-only, even if you notice an incidental defect there.',
    'Report incidental out-of-scope findings in submission notes instead of editing unrelated files.',
    'The trusted verification gate compares the committed diff with this allowlist and returns scope_fence_violation for any mismatch.',
  ].join('\n');
}
