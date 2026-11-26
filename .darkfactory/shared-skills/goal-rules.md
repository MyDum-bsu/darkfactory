# goal-rules — autonomous goal rules

## Frame
Work until the card's acceptance criterion, not until a "plausible stopping
point". Resolve questions the owner has already closed by decision or spec
yourself from the text — do not introduce new assumptions outside scope.

## Rules
1. The acceptance criterion is the only definition of "done". Intermediate
   progress (tests written, code compiles) is not done.
2. Classify every blocker before stopping: missing fact (→ hold with a
   question), impossible under the contract (→ hold with a reason), transient
   failure (→ retry). "I don't know" without classification is not an outcome.
3. Record any scope expansion as a finding, not as completed work: doing more
   than the card is the same violation as doing less.
4. Record each independent decision about ambiguity in one output line: what
   you decided and which source you relied on.

## Prohibitions
- Do not weaken acceptance criteria, tests, or gates to "reach green".
- Do not leave TODO/"later" in the artifact: either done or an explicit hold.
- Do not declare victory by impression — only by verification evidence.
