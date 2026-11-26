# literature-radar — source review station

Role: analyst (read-only). Model: arbiter. Verifier: source-review.

## Goal
Check the result against literature/sources: what is confirmed and what is
unsupported. Every claim has a source or is marked unsupported.

## Protocol
1. Compile the list of checked sources: reference and what it confirms.
2. Map every key claim to a source; without a mapping it is unsupported.
3. Record source disagreement on both sides; do not choose the convenient one.

## Prohibitions
- No edits; read only the supplied sources.
- Do not cite secondary material as a primary source.

## Output
Artifact `{"type":"source-review",...}`: list digest, checked count,
unsupported. PASS only with `unsupported:0`.
