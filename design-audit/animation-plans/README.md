# Animation plans (design audit, pass 2)

Written by the `improve-animations` skill in read-only mode on 2026-11-11, at commit `06ba8a7`.
**Nothing here has been applied.** Each plan is self-contained: someone (or a coding agent) with no
other context can carry it out. The findings behind them are in `../02_motion_interaction.md`.

These plans cover only the motion fixes whose answer is already clear. Decisions that need a
designer (the look of selection on the logo and direction screens, one loading language, how a brand
reopens) are findings tagged "needs redesign" in the main file, not plans.

| # | Plan | Severity | Findings | Status |
| --- | --- | --- | --- | --- |
| 001 | [Motion tokens and press feedback](001-motion-tokens-and-press-feedback.md) | HIGH | M-001, M-002 | TODO |
| 002 | [Dialogs and menus: one quiet entrance](002-overlay-enter-and-exit.md) | MEDIUM | M-003 | TODO |
| 003 | [Reduced motion: gentler, not zero](003-reduced-motion-gentler-not-zero.md) | MEDIUM | M-004 | TODO |
| 004 | [Hover timing and touch gating](004-hover-transitions-and-touch-gating.md) | MEDIUM | M-002, M-005 | TODO |
| 005 | [Loaded content fades in](005-content-arrives-without-popping.md) | LOW | M-009, M-017 | TODO |

## Order and dependencies

1. **001 first.** It adds the tokens every other plan uses.
2. **003 before or together with 002 and 004.** Plan 003 replaces the global reduced-motion switch.
   If 002 or 004 land first, the old switch still protects reduced-motion users, so the order is safe
   either way, but 003 must be re-checked after each of the others.
3. 002, 004 and 005 are independent of each other.

The token names and values in plan 001 are the proposal from "Proposed motion tokens" in
`../02_motion_interaction.md`. If pass 3b or Claude Design changes a name or a value, change it in
plan 001 only; the other plans refer to tokens, not numbers (except the 150 ms menu timing in 002).

## Before running any plan

- The redesign may restructure these files. Each plan is stamped with commit `06ba8a7`; if a step
  does not match the code, the plan says to stop. Pass 7b (reference refresh) should update the
  file and line references.
- Do not use the skill's "execute" mode as part of the audit. Implementation happens in the
  implementation prompt, after the design system is approved.
