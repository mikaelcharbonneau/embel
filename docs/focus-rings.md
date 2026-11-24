# Focus rings: one per focus

_November 24, 2026._ A focused control shows exactly one ring.

- The design system draws the ring (`:focus-visible` in `src/styles/embel/components.css`).
- A box that stands for the control inside it draws the ring itself, and the control inside draws
  none: a text field (`.e-input`), the reply box (`.e-composer`), a choice card (`.e-choice`), a name
  card (`.e-name-card`), the Home prompt box.
- Such a box rings only for its own field. A button inside it (show password, attach, dictate, Send)
  shows its own ring and the box stays quiet.
- Page stylesheets add no blanket focus rule. The old `.project-workspace :is(button, a, …):focus-visible`
  rule did, and doubled every ring inside a brand; it was removed.

Checks: `tests/client/single-focus-ring.test.ts` (source contracts). To look at the rendered result,
tab through a screen and compare the focused element's outline with its ancestors' outlines; no
ancestor that matches `:has(:focus-visible)` should have one at the same time.
