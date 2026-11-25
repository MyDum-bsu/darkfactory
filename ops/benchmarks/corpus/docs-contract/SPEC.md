# Task: Structured Handoff Contract and Validator

Write a concise technical specification `docs/handoff-contract.md` and a zero-dependency validator `scripts/validate-handoff-contract.mjs`.

## Required document contract

The document must contain exactly these level-two sections, in this order:

1. `Fields`
2. `Rejection`
3. `Validation`

It must define the handoff fields `task_id`, `epoch`, `attempt_id`, `worker_thread_id`, and `candidate_sha`; explain that stale, foreign, dirty, or unconfirmed submissions are rejected; and include exactly one fenced JSON example containing those five fields.

## Validator behavior

`node scripts/validate-handoff-contract.mjs [file]` must:

- Validate the target file, defaulting to `docs/handoff-contract.md`.
- Require the exact ordered sections and exactly one JSON example.
- Require all five fields and a 40-character lowercase hexadecimal `candidate_sha`.
- Exit 0 without dependencies on success.
- Exit non-zero with a clear English error on violation.
