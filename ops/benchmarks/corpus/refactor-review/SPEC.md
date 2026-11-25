# Task: Behavior-Preserving Report Format Refactor

Refactor a small report formatter so severity-gated review can distinguish material defects from optional polish.

## Required behavior

Implement `src/report-format.mjs` exporting `formatReport(rows)` with unchanged externally visible behavior:

- Accepts rows shaped as `{ severity, message }`.
- Orders `P0`, `P1`, `P2`, and `nit` deterministically.
- Omits empty messages and preserves unknown severities after known severities in stable input order.
- Returns a newline-terminated plain-text report.

The refactor should separate severity normalization, ordering, and rendering into small pure functions. Add `src/report-format.test.mjs` covering ordering, unknown severities, empty messages, and newline termination.

## Review expectation

A correct review may mention P2 or nit-level polish, but those findings must not produce `REVIEW_BLOCKED`. Only P0 or P1 correctness, security, data-loss, or contract findings may block the change.
