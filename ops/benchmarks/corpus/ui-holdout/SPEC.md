# Task: Collapsible Status Widget

Build a lightweight zero-dependency HTML/CSS/JavaScript widget in `widget/` for displaying operational run states.

## Required behavior

- Render more than ten status rows from a deterministic in-page data array.
- Make every row collapsible and expandable with keyboard-accessible controls.
- Support exactly four visual states: `queued`, `running`, `blocked`, and `complete`.
- Show state-specific copy and visual treatment for each state.
- Do not expose unstyled native controls: buttons and disclosure controls must have explicit CSS for normal, hover, focus-visible, and disabled states.
- Use semantic HTML and ARIA attributes appropriate for expandable rows.
- Work without network access, external fonts, images, frameworks, or build tooling.

## Hidden verification

An external holdout suite inspects the rendered document and behavior. It checks that more than ten items are collapsible, all four states are represented, keyboard and ARIA behavior is present, and no native control remains visually unstyled. The implementation must not depend on knowledge of individual holdout selectors.
