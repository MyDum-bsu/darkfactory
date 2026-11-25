# visual-rubric — visual verification rubric

## Violation counters
- `unstyledControls`: native-looking control or control outside the design
  system.
- `uncollapsedLongLists`: list >7 items without collapsing/pagination/
  virtualization.
- `missingStates`: a required state (empty/loading/error/disabled/focus) is
  not rendered in captures.
- `consoleErrors`, `a11yViolations`: any entry is a blocker.
- `holdoutFailures`: failure on a rubric holdout scenario.

## Procedure
1. Each viewport (≥2) gets a separate pass: structure, alignment, contrast.
2. For every control in a capture answer: styled? all states? focus visible?
   No answer means the state is considered missing.
3. satisfactionScore = weighted fraction of passed rubric items ×100; a score
   below 85 means rework even without blockers.

## Honesty
Do not round "generally good" into 85+: the score is composed of items, each
with capture and area identified. An item not bound to a capture does not
count.
