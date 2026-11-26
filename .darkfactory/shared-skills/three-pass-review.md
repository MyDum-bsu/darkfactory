# three-pass-review — three independent passes

## Goal
A single-pass review misses whole classes of defects. Perform three passes
with different lenses; every finding is bound to a pass and a location.

## Passes
1. **Contract**: every acceptance/spec item is either confirmed by code and a
   check or is a finding. Silent omission is a P1 finding.
2. **Defects**: read the executable path, not the intention — boundaries,
   empty collections, failures mid-stream, fail-open validation, silent catch.
3. **Truth**: compare artifacts and claims with fact — the test really fails
   before and turns green after, the digest matches the bytes, and "covered"
   means covered.

## Finding classification
- `P0` — data loss/corruption, gate bypass, evidence substitution.
- `P1` — violation of the card contract, red test, in-scope bug.
- `P2` — defect outside the card scope; record it, do not block.
- `nit` — style and taste; sidecar only.

## Prohibitions
- Do not present P2/nit as blockers and do not hide P1 among "comments".
- Do not review from memory: every finding needs file/line and expected/actual.
- Do not demand work outside scope — scope expansion is not a finding.
