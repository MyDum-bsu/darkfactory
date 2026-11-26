# issue-register — open issue register

## Goal
Keep the issue register synchronized with reality: open means reproducible now;
closed means supported by evidence.

## Protocol
1. For each open entry, verify currency against code/logs, not memory: do the
   file, line, and symptom still exist?
2. New issue: symptom statement, minimal reproduction, boundary (what exactly
   is broken), and question owner. Without reproduction it is an "observation",
   not an issue.
3. Close only with a link to evidence (SHA, test, log). "Probably fixed" leaves
   the entry open.
4. Merge duplicates with an explicit reference: "same symptom as #N".

## Prohibitions
- Do not close entries just to make the register clean.
- Do not blur the issue boundary ("something is wrong with X") — one entry =
  one reproducible symptom.
- Do not rewrite someone else's wording; clarify by addition.

## Output
Updated register: {open, closed with evidence, new}, with the last verification
date for each entry.
