# lean4-frozen-core — working in the frozen core

## Allowed
- Imports strictly from the card core list; a new import is a separate owner
  decision, not yours.
- Tactics from the core standard library; custom tactics and macros are
  forbidden.
- `decide`, `simp`, `omega`, `ring`, `exact`, `intro`, `apply`, constructors —
  the baseline set; check everything else against the permitted list.

## Forbidden (holes)
- `sorry`, `admit`, `axiom`, `unsafe`, `native_decide` used to skip checking,
  `set_option ... maxHeartbeats` as a bypass, commented-out goals.
- Changing the theorem statement/signature is goal substitution, not proof.

## Practice
1. Prove locally: helper lemma nearby, not in someone else's file.
2. Run after every closure; do not accumulate ten edits before checking.
3. Compiler diagnostics are part of the artifact: sorry warnings are
   inadmissible even with exit 0.
