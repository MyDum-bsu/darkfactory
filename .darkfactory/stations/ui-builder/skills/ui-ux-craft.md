# ui-ux-craft — production UI/UX standard

This is an execution contract, not advice. Any deviation is a candidate defect.
Verify the result with code and screenshots at **1440x900** (desktop) and
**1024x768** (compact/laptop) before handoff.

## 1. Design contract

- Use only semantic theme tokens: color, background, surface, border,
  text-primary/secondary, danger/success/warning, focus-ring. Do not introduce
  random hex/rgb in a component; if a token is missing, stop and extend the
  design system within the card scope.
- Typography is fixed by scale: page heading, section heading, body,
  caption/label. Do not mix arbitrary px values; line height and weight must
  come from the same scale.
- Grid and spacing use the 4px base step: 4/8/12/16/24/32. Outer edges of
  related blocks are aligned; random 1–3px compensations are forbidden.
- Text and interactive-element contrast is **at least 4.5:1**; for large text,
  at least 3:1. Do not apply the disabled palette to an active control.
- One column on a compact viewport must not create horizontal scrolling; wide
  tables need an explicit adaptive model (cards, sticky column, controlled
  overflow with the region labeled).

## 2. Controls and data

- **Bare native controls are forbidden**: raw `<select>`, `<input>`, `<button>`,
  `<textarea>` without a design-system class/reset and tokens; browser default
  appearance is automatic rework. The same applies to an unaligned table without
  header/cell/row/state styles.
- Every interactive element has default, hover, focus-visible, active, and
  disabled states; the focus ring is visible and not clipped by overflow.
- Lists, tables, and timelines **longer than 10 items** must be collapsed,
  virtualized, filtered, or paginated. By default show the first 10 and an
  explicit "Show all/N more" control with an accessible expanded state.
- Long strings, Unicode, empty values, and very large values are checked with
  real data. Overflow is clipped with ellipsis/wrapping according to the
  component rule, without overlapping neighboring controls.
- Date, number, currency, and empty-value formats strictly follow the card spec;
  do not mix locales and placeholders within one screen.

## 3. Four required screen states

Every screen/widget with asynchronous data implements and visually verifies:

1. `loading` — skeleton/spinner with layout preserved and `aria-busy` wherever
   data is still substituted.
2. `empty` — clear heading, next action, and no false table.
3. `error` — readable reason/category, retry/recovery action, no raw stack
   trace, and no loss of already entered data.
4. `ready` — primary state with real long data.

An empty `div`, layout-shift flicker, or a state that exists only in code but
cannot be reached by test/screenshot counts as missing.

## 4. Accessibility (a11y)

- The complete scenario is keyboard-accessible: Tab/Shift+Tab, Enter/Space,
  Escape for layers; focus order matches the visual hierarchy.
- Every interactive element has an accessible name (`aria-label`, associated
  `<label>`, or visible text). An icon-only button without a name is a blocker.
- Use semantic elements and landmark/heading structure; do not imitate a button
  with a div. For a custom control add role, state, and keyboard contract.
- `aria-expanded`, `aria-controls`, `aria-selected`, `aria-invalid`, and live
  regions must reflect real state; decorative markup is hidden with
  `aria-hidden`.
- Do not rely only on color for error/status; add text or a named icon.

## 5. Viewport acceptance

Two runs and saved captures are mandatory:

- `1440x900`: desktop layout, no empty dead zones or accidental overflow.
- `1024x768`: compact/laptop layout, content and primary actions accessible
  without page-level horizontal scrolling.

On each viewport check ready plus applicable loading/empty/error. The screenshot
is PNG with a stable name of form `mo-tracker-<state>-<width>x<height>.png`.

## 6. Final self-check before handoff

- 0 unstyled controls; 0 uncollapsed lists longer than 10; 0 console errors;
  0 critical axe-core a11y violations; rubric satisfaction score >= 85.
- All code and configuration lines contain no host paths; test data is
  synthetic, without PII and without access to the live database.
- If an item is "almost done", it is not done. Do not hand off a screen without
  two viewport captures and state verification.
