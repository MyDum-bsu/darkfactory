# prod-recon — live-environment reconnaissance

## Goal
Answer a question about production/staging from facts: what is actually
deployed, what is in the logs, and what is in the data. Read-only —
reconnaissance changes nothing.

## Protocol
1. First pin the target identity: host, version/SHA of deployed code, and
   observation time. A conclusion not bound to a version is not a conclusion.
2. Read in this order: process status → recent logs (head and tail, not only
   tail) → database/queue state read-only → config. Every fact needs a source.
3. Compare the observed state with the spec's expectation: the discrepancy is
   the primary output.
4. Separate "I observe" from "I infer": label hypotheses explicitly.

## Prohibitions
- No edits, restarts, migrations, or flushes — even "harmless" ones.
- Do not emit secrets/tokens/PII into the artifact: mask values and show shape.
- Do not trust one source: a log saying "all good" without checking data is
  half a fact.

## Output
List of observations `{fact, source, time}`, discrepancies from the spec, and
explicit unresolved questions.
