# feature-blueprint — feature plan before code

## Goal
Before the first edit, record the minimum verifiable plan: what changes, where
the interface boundary is, and how it will be proven. Code without a blueprint
is rework.

## Protocol
1. Extract the acceptance criterion and explicit scope from the card. Anything
   outside scope is forbidden.
2. Find the existing module that owns the change; create a new file/abstraction
   only if the current structure cannot hold the contract, and say why.
3. Break the work into steps, each with a verifiable result ("file X exports
   Y; test Z goes red→green"). A step without verification is not a step.
4. Name the main risk and how you will falsify it yourself.

## Prohibitions
- Do not start implementation until every step is independently verifiable.
- Do not design "for growth": implement only what the card requires.
- Do not copy other patterns blindly — read the repository conventions first.

## Output
Writer-station artifact: diff + list of completed checks (`failedChecks`),
bound to each blueprint step.
