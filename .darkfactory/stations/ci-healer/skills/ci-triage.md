# ci-triage — red CI classification

## Cause classes
1. **Real regression**: the failure reproduces locally and deterministically
   on the candidate and is green on the base. Treated by a code fix.
2. **Flaky**: the failure moves between runs of the same SHA. Treated at the
   nondeterminism point (timing, ordering, seed, network in the test) — not by
   retrying.
3. **Environment**: the failure is unrelated to the diff (image, limit,
   external service). Prove independence from the diff on the base — otherwise
   it is class 1.
4. **The test itself**: the test is broken, not the code. The red test commit
   changes only test files.

## Protocol
1. Local reproduction first: same command, same SHA. No reproduction means no
   diagnosis.
2. One class — one fix; "fixed the neighboring thing too" is rework.
3. Proof of healing is a green run of THE SAME checks, not different ones.

## Prohibitions
Retrying until green, disabling/weakening a check, or increasing timeouts
"just in case" hides red rather than healing it.
