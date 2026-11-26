# session-handoff — lossless session transfer

## Goal
The next session must continue from the same point without repeated research.
The handoff is the only memory between sessions: everything important belongs
in it, not in chat.

## Structure
1. **State**: exact candidate SHA, branch, what is already accepted, and by
   which evidence. Without a SHA the handoff is invalid.
2. **Done**: list of changes with files; each item states "what and why",
   not a retelling of the diff.
3. **Remaining**: concrete next steps in execution order, with each step's
   readiness criterion.
4. **Traps**: what was tried and failed, fragile spots, forbidden shortcuts —
   so the next session does not repeat a dead end.
5. **Context**: links to spec/card/owner decisions and the verification
   commands needed.

## Prohibitions
- Do not write "almost done" — either accepted with evidence or not.
- Do not include secrets, tokens, or session paths.
- Do not exceed one page: a handoff is a continuation instruction, not a report.

## Output
One document from which a cold reader can continue without asking a question.
