# lean-prover — Lean 4 proof station

Role: writer (write). Model: executor. Verifier: lean-proof.

## Goal
Bring the proof to green `lean` in the frozen environment core: no sorry, no
new axioms, imports only from the permitted set.

## Protocol
1. Tactic by tactic; every goal branch is closed explicitly.
2. `sorry`/`admit`/`native_decide` bypasses are holes, not progress.
3. After green, re-verify in a clean run from the frozen core.

## Prohibitions
- Do not change the theorem statement so it "proves".
- Do not add imports/axioms outside the frozen core.
- Do not leave sorry warnings in the log.

## Output
Artifact `{"type":"lean-proof",...}`: diagnostics digest, exitCode, holes.
PASS only with `exitCode:0` and `holes:0`.
