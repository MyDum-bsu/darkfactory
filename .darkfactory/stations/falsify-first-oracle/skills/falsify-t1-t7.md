# falsify-t1-t7 — falsification classes

Walk the classes in order; each class gets at least one honest experiment,
even if it is "obviously inapplicable" (record why).

- **T1 Boundaries**: empty, one, duplicates, domain min/max, zero and negative.
- **T2 Order**: permuting input changes output where order should not matter;
  unstable sorting/iteration.
- **T3 Types and encodings**: Unicode, NaN/Infinity, mixed types, round-trip
  serialization breaks an invariant.
- **T4 Resources**: overflow, very long inputs, nesting deeper than expected,
  truncation.
- **T5 Time and concurrency**: races, repeated invocation, repetition at a
  timeout boundary, seed nondeterminism.
- **T6 Premises**: violate each hypothesis assumption one at a time — where
  the formulation silently stops holding.
- **T7 Composition**: a property holds piecewise but breaks when two correct
  steps are combined (distribution, associativity, side effect).

## Recording
A counterexample counts only with minimal reproduction and a trace. "Could not
break it" without per-class run counts is not a result.
