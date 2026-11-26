# Task: Red-First Boundary Parser Bugfix

A boundary parser incorrectly accepts a trailing delimiter as a valid empty final field. Repair this behavior while proving the regression test was written first.

## Required behavior

Implement or repair `src/boundary-parser.mjs` so `splitBoundary(input, delimiter)`:

- Splits a non-empty string on a single-character delimiter.
- Preserves empty interior fields.
- Rejects a trailing delimiter by returning `null` instead of an array ending in an empty field.
- Returns `null` for non-string input, empty input, or a delimiter that is not exactly one character.

## Test-first evidence

The first test commit or test patch must add a failing `node:test` case for the trailing delimiter before the implementation fix. The verifier is the `test-first` verifier: it must be able to observe that the new test fails against the unfixed implementation and passes after the repair. Do not weaken or delete existing tests.
