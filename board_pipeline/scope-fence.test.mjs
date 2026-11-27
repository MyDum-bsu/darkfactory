import test from 'node:test';
import assert from 'node:assert/strict';
import { checkScopeFence, parseAllowedPaths, scopeFencePromptBlock,
  validateSubmissionNotes } from './scope-fence.mjs';

test('parseAllowedPaths accepts comma-separated exact files and directory prefixes', () => {
  assert.deepEqual(parseAllowedPaths('board_pipeline/intake-prompt.mjs, ops/control-room/'),
    ['board_pipeline/intake-prompt.mjs', 'ops/control-room/']);
  assert.deepEqual(parseAllowedPaths('a.mjs'), ['a.mjs']);
  assert.deepEqual(parseAllowedPaths('dir/'), ['dir/']);
});

test('parseAllowedPaths rejects empty entries and unsafe path forms fail-closed', () => {
  for (const raw of [
    '', ' ', ',', 'a.mjs,', ',a.mjs', 'a.mjs,,b.mjs', '/abs/path', '//server/share',
    'C:/temp/file', '../x', 'a/../b', '..', 'a\\b', 'a\0b', './a.mjs', '.', 'a//b',
  ]) {
    assert.throws(() => parseAllowedPaths(raw), /scope_fence_(path_invalid|input_invalid)/, JSON.stringify(raw));
  }
  assert.throws(() => parseAllowedPaths(null), /scope_fence_input_invalid/);
  assert.throws(() => parseAllowedPaths(undefined), /scope_fence_input_invalid/);
  assert.throws(() => parseAllowedPaths(['a.mjs']), /scope_fence_input_invalid/);
});

test('checkScopeFence preserves unrestricted mode with explicit opt-in and no allowlist', () => {
  const optIn = { changedPaths: ['anything'], allowUnrestricted: true };
  const unrestricted = { ok: true, mode: 'unrestricted', violations: [] };
  assert.deepEqual(checkScopeFence(optIn), unrestricted);
  assert.deepEqual(checkScopeFence({ ...optIn, allowedPaths: null }), unrestricted);
  assert.deepEqual(checkScopeFence({ ...optIn, allowedPaths: undefined }), unrestricted);
});

test('checkScopeFence denies missing, null or undefined allowedPaths by default', () => {
  for (const options of [undefined, null, {}, { allowedPaths: null }, { allowedPaths: undefined },
    { allowUnrestricted: 'true' }]) {
    assert.deepEqual(checkScopeFence(options),
      { ok: false, mode: 'denied', reason: 'allowed_paths_required', violations: [] });
  }
});

test('checkScopeFence matches exact files and explicit directory prefixes', () => {
  const allowed = parseAllowedPaths('board_pipeline/intake-prompt.mjs,ops/control-room/');
  assert.deepEqual(checkScopeFence({ changedPaths: [
    'board_pipeline/intake-prompt.mjs',
    'ops/control-room/index.html',
    'ops/control-room/nested/app.js',
  ], allowedPaths: allowed }), { ok: true, mode: 'restricted', violations: [] });

  const result = checkScopeFence({ changedPaths: [
    'board_pipeline/intake-prompt.mjs.bak',
    'ops/control-room',
    'ops/other.js',
  ], allowedPaths: allowed });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'scope_fence_violation');
  assert.deepEqual(result.violations, [
    'board_pipeline/intake-prompt.mjs.bak',
    'ops/control-room',
    'ops/other.js',
  ]);
});

test('checkScopeFence accepts an empty diff and is deterministic on repeated invocation', () => {
  const allowedPaths = ['board_pipeline/'];
  assert.deepEqual(checkScopeFence({ changedPaths: [], allowedPaths }),
    { ok: true, mode: 'restricted', violations: [] });
  const input = { changedPaths: ['x', 'x', 'board_pipeline/a.mjs'], allowedPaths };
  const first = checkScopeFence(input);
  assert.deepEqual(first, checkScopeFence(input));
  assert.deepEqual(first.violations, ['x']);
});

test('checkScopeFence never passes malformed restricted input or candidate paths', () => {
  assert.throws(() => checkScopeFence({ changedPaths: ['a.mjs'], allowedPaths: [] }), /scope_fence_input_invalid/);
  assert.throws(() => checkScopeFence({ changedPaths: ['a.mjs'], allowedPaths: ['../a'] }), /scope_fence_path_invalid/);
  assert.throws(() => checkScopeFence({ changedPaths: null, allowedPaths: ['a.mjs'] }), /scope_fence_input_invalid/);
  const malformed = checkScopeFence({ changedPaths: ['../x', 'a\\b', ''], allowedPaths: ['a.mjs'] });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, 'scope_fence_violation');
  assert.deepEqual(malformed.violations, ['../x', 'a\\b', '']);
});

test('scopeFencePromptBlock states the hard constraint and trusted gate', () => {
  const block = scopeFencePromptBlock(['board_pipeline/intake-prompt.mjs', 'ops/control-room/']);
  assert.match(block, /Scope Fence \(hard constraint\)/);
  assert.match(block, /board_pipeline\/intake-prompt\.mjs/);
  assert.match(block, /ops\/control-room\//);
  assert.match(block, /read-only/);
  assert.match(block, /scope_fence_violation/);
  assert.throws(() => scopeFencePromptBlock([]), /scope_fence_input_invalid/);
});

test('validateSubmissionNotes normalizes optional bounded notes', () => {
  assert.deepEqual(validateSubmissionNotes(undefined), []);
  assert.deepEqual(validateSubmissionNotes(null), []);
  assert.deepEqual(validateSubmissionNotes([]), []);
  assert.deepEqual(validateSubmissionNotes(['  incidental finding  ', 'line\nwith\ttab', 'nul\0byte']),
    ['incidental finding', 'line with tab', 'nul byte']);
  assert.deepEqual(validateSubmissionNotes(Array.from({ length: 10 }, (_, i) => `note ${i}`)).length, 10);
});

test('validateSubmissionNotes rejects malformed input fail-closed', () => {
  assert.throws(() => validateSubmissionNotes('note'), /submission_notes_invalid/);
  assert.throws(() => validateSubmissionNotes(Array(11).fill('note')), /submission_notes_invalid/);
  assert.throws(() => validateSubmissionNotes(['']), /submission_notes_invalid/);
  assert.throws(() => validateSubmissionNotes(['   ']), /submission_notes_invalid/);
  assert.throws(() => validateSubmissionNotes([42]), /submission_notes_invalid/);
  assert.throws(() => validateSubmissionNotes(Array(1)), /submission_notes_invalid/);
  assert.throws(() => validateSubmissionNotes(['x'.repeat(201)]), /submission_notes_invalid/);
  assert.equal(validateSubmissionNotes(['x'.repeat(200)])[0].length, 200);
});
