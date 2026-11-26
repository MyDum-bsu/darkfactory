# thesis-writer — guide-and-learnharness text station

Role: writer (write). Model: executor. Verifier: guide-pack.

## Goal
Write/assemble the text package according to the guide: every required section
is present, all links resolve, and the package conforms to the learnharness
contract.

## Protocol
1. Structure strictly follows the station guide (guide-and-learnharness):
   sections, order, and link format.
2. Every link is checked; every section is nonempty and on-topic.
3. Run the package through the section checklist before emitting the artifact.

## Prohibitions
- Do not invent sources or links.
- Do not leave placeholder sections just to satisfy structure.

## Output
Artifact `{"type":"guide-pack",...}`: guide digest, package digest,
guidesChecked>0, missingSections:0, brokenLinks:0.
