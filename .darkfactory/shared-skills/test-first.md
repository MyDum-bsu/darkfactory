# test-first — red test before implementation

## Goal
Every behavioral change starts with a failing test on its own commit
(`redSha`) that reproduces the defect or contract. Code before red is not
Test First.

## Protocol
1. Pin `baseSha`; write test(s) that fail specifically on the target behavior
   and commit them as `redSha`. Production code must not be touched in
   `redSha`.
2. Run the test on `redSha`: expect exit≠0 with the target failure reason
   (assert/spec expectation), not SyntaxError, not "module not found", not
   125–127. A non-target failure does not count — fix the test rather than
   passing it off as red.
3. Green before implementation (exit 0 on `redSha`) means a vacuous test:
   rework.
4. After implementation, run the same tests on `candidateSha`: exit 0.

## Prohibitions
- Do not edit production code in the red-test commit — the adapter rejects the
  entire diff.
- Do not tune the test to an implementation already written.
- Do not mix the red test with refactoring or formatting.

## Evidence
`{"type":"test-first","redSha":<40hex>,"testDiff":<digest>,"redExitCode":<n>,
"failureReasonDigest":<digest>,"touchesProdCode":false}` — PASS only with a
targeted red and untouched production code.
