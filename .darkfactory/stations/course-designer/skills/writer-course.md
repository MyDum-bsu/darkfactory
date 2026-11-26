# writer-course — course design

## Goals → lessons
- A goal is formulated with a measurable-result verb ("explains", "builds",
  "debugs"), not "understands"/"learns".
- Every lesson covers ≥1 goal and declares this explicitly; a lesson without
  a goal is dead weight.
- Lesson dependencies form a DAG: a later lesson relies only on earlier ones.

## Lesson structure
- Motivation → material → comprehension check (question/exercise) whose answer
  is verifiable from the lesson text.
- Lesson load is uniform: a lesson three times longer than its neighbors must
  be split.

## Coverage
Before output, build a goal→lesson table: an empty row is an uncoveredGoal.
Coverage "indirectly, somewhere in the text" does not count.
