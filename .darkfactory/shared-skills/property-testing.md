# property-testing — invariants instead of examples

## Goal
Examples check a point; a property checks a region. For every nontrivial
transformation, formulate an invariant that must hold for every input in the
domain.

## Protocol
1. Choose a property from a class: round-trip (f⁻¹∘f=id), invariant (sorting
   preserves the multiset), metamorphic (monotonicity in input), or oracle
   (naive reference implementation).
2. Define the generation domain honestly: edge cases (empty, single element,
   integer boundaries, Unicode) must be generated, not filtered out.
3. Minimize the counterexample before reading it: shrink to the smallest case
   that still breaks the property.
4. Pin every discovered counterexample as a permanent regression test.

## Prohibitions
- Do not write the property "implementation equals itself" — that is a vacuum.
- Do not narrow the generator so the bug becomes unreachable.
- Do not disable shrinking or reduce run counts without a reason.

## Output
List of verified properties with run counts and counterexamples; PASS only with
`counterexamples:0`.
