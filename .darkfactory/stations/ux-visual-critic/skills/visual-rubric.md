# visual-rubric — Satisfaction Testing for ux-visual-critic

## Hard blockers
- `unstyledControls`: native-looking control or control outside the design
  system. Threshold: **0**.
- `uncollapsedLongLists`: list/table longer than **10** visible items without
  collapsing, pagination, or virtualization. Threshold: **0**.
- `missingStates`: `loading`, `empty`, `error`, or `ready` is not shown/not
  available. Threshold: **0**.
- `consoleErrors`, `a11yViolations`, `a11yCritical`: any value >0 is a blocker.
- `holdoutFailures`: any hidden scenario failure is a blocker.
- `satisfactionScore`: below **85** means REWORK even with zero counters.

## Mandatory viewports
Evaluate `1440x900` and `1024x768` separately. If one viewport has no PNG,
coverage is incomplete and PASS is forbidden. Identify the viewport for every
deduction.

## Score
Start at 100 and subtract only observed defects:
- blocker by control/list/state/a11y/holdout: at least 15 per category;
- unreadable visual hierarchy or lost primary action: 10–20;
- overflow, overlap, accidental grid/typography: 5–15 by severity;
- minor polish without scenario violation: at most 5 and not independently
  blocking.

Do not raise the total to 85 "overall". The total is the sum of items, each
with capture and area.

## REWORK coordinates
Every blocking violation must be actionable for the worker without exposing
the holdout: category, viewport, CSS selector or bounding box
`x/y/width/height`. Scenario text, file path, secret, host path, and ANSI
escape are forbidden in a violation.
