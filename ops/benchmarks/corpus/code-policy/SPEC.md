# Task: Pure Policy Key Validator

Implement a zero-dependency JavaScript module `src/policy-key.mjs` exporting `isPolicyKey(value)`.

## Required behavior

- Return exactly `true` or `false`; never throw for invalid input.
- Accept only a string of 1 to 24 ASCII characters.
- The first character must be lowercase `a` through `z`.
- Remaining characters may be lowercase `a` through `z`, digits `0` through `9`, or hyphen `-`.
- Reject empty strings, non-strings, whitespace, underscores, uppercase letters, Unicode, and strings longer than 24 characters.

## Verification

Add `src/policy-key.test.mjs` using only `node:test` and `node:assert/strict`. Cover positive, negative, boundary-length, and non-string cases. Do not add dependencies or modify unrelated files.
