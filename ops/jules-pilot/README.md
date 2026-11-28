# Google Jules: one-file issue pilot

`jules-triage.mjs` answers **candidate or deny**, offline. A candidate is not permission to send data, start a task, run generated code, or merge a PR. Board remains the queue. No GitHub token, model, network call or quota is needed to run the filter.

## Try a decision locally

Use Node 22.18+. Supply two separate inputs. The first is **operator policy**, never an attachment or path list provided by the issue author. For example, an owner-reviewed `enrollment.json` outside this repository could contain:

```json
{"repository":"acme/sampler","files":["docs/guide.md","tests/unit/format.test.mjs","examples/format.js"]}
```

The second input is one open GitHub **issue** snapshot. Obtain repository identity, number, state and all label names from GitHub, not from the issue body. Use the original title and full body unchanged; do not summarize rejected text into a passing template. Example (synthetic; nothing is submitted):

```sh
node ops/jules-pilot/jules-triage.mjs enrollment.json <<'JSON'
{"repository":"acme/sampler","number":17,"state":"OPEN","title":"Fix a documentation typo","body":"File: docs/guide.md\nLine: 12","labels":["docs"]}
JSON
```

Expected: `{"eligible":true,"kind":"docs","path":"docs/guide.md"}` (exit 0). Denials return `eligible:false` and a fixed reason (exit 1); any error, missing decision or nonzero exit means **do not send**. The equivalent pure API is `triageIssue(issue, policy)`. Run the regression suite with `node --test ops/jules-pilot/jules-triage.test.mjs`.

### Accepted issue forms

| Exact title (choose one) | Kind / optional sole label | Permitted file |
| --- | --- | --- |
| `Fix a documentation typo` or `Clarify a documentation example` | `docs` | Markdown under `docs/` |
| `Test the empty input case` or `Test the single item case` | `unit-test` | `*.test.{js,mjs,cjs,ts}` under `tests/unit/` |
| `Extract a repeated literal into a local constant` | `isolated-refactor` | `*.{js,mjs,cjs,ts}` under `examples/` |

The body is exactly `File: <enrolled-path>`, optionally followed by LF and `Line: <1–9999999>` without leading zeroes. No trailing newline. Labels must be `[]` or `[kind]`. Each file must be a literal repo-relative ASCII path; directory and filename stems use letters, digits, `_` and `-` and start with a letter or digit. No globs or aliases. Repository and path must match enrollment exactly. Unexpected fields, extra prose, multiple targets and malformed input deny. This deliberately leaves many benign issues for manual triage: a `docs` label is not evidence that prose is free of PII. Deny rules also apply to sensitive names even in the enrollment file (e.g. `docs/billing.md`).

## Operating protocol

1. **Enroll before intake.** With owner approval, pin the clean base SHA on the Board card. Enroll only a repository whose *entire Jules-visible context* is cleared for external access. If necessary use an approved sanitized sandbox; a path filter does not isolate a repository checkout. Never enroll `moml-course`, the Trust Kernel (`board_pipeline/`, `ops/local/`), secrets or PII, auth/RLS, billing or deployment material. Never give Jules production credentials, Board access, owner decision data or release rights.
2. **Review the scope at that SHA.** Keep an independent list of exact, tracked regular files, not symlinks, submodules or generated files. Inspect contents, dependencies and consumers. A guide describing authentication, a test using customer fixtures, or an example imported by production is ineligible regardless of its filename. Reject uncertainty. For tests require synthetic data and no production or integration changes; for refactors require unchanged behavior and no external consumers. Invalidate enrollment when the base changes.
3. **Triage locally.** Check the complete issue and any context Jules could read. Reject PRs, comments, links/attachments or other unreviewed context; do not drop discussion or truncate labels to get a pass. Record the decision and issue revision on the card. Recheck the snapshot, SHA and authorization immediately before dispatch. If anything changed, triage again. Even on a pass, delegate only the approved snapshot and one-file fence in the sanctioned pilot sandbox, with no automatic push to a protected branch, merge or deploy.
4. **Reserve quota, then dispatch once.** One operator serializes reservations in the private Board pilot ledger, across all repositories sharing the account. Google AI Ultra: **up to 60 tasks/day**, not a target. Record provider quota day/reset, issue ID, attempt, reservation time, provider task ID (when known) and outcome; no raw issue text. Before every submission, including retries, count reserved, submitted and uncertain attempts for the provider day. Stop at the lower of 60 or the account's effective limit, or earlier if the provider shows no capacity. If usage elsewhere or the reset is uncertain, pause and reconcile against the provider. Never retry an ambiguous submission or release its slot until reconciled. Close out the day before opening the next bucket.
5. **Evaluate the returned diff as untrusted.** Independently check base and exact changed path, file type, dependencies, content and applicable tests. Reject scope drift (including renames or symlinks); do not run proposed code with credentials. Apply normal branch checks and independent review. Only the owner-authorized release path may merge. Record rejects/timeouts as well as successful PRs. Stop the pilot on any suspected disclosure or boundary crossing; escalate to the owner rather than resubmitting.

## Weekly evaluation rubric

| Measure | How to score |
| --- | --- |
| Latency | From submission to first reviewable diff: report median and p90 by kind, plus pending age and timeouts separately. |
| Merge quality | First-pass clean diffs / all returned diffs (in scope, independent review and checks pass, no fixes); also report merged / submitted and any post-merge regression or revert. |
| Rework rate | Returned diffs requiring any requested correction, manual fix or new attempt / all returned diffs. Count each diff once; track extra attempts and reviewer minutes separately. |

Keep counts with each ratio (`N/A` for zero denominators), compare like task kinds to the normal Board path, and present quota spent, failures and safety incidents alongside speed. Expansion requires owner review; faster turnaround does not offset a safety failure.
