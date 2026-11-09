> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Brand-board application placeholder copy — 2026-10-20

## Scope

[Issue #66](https://github.com/mikaelcharbonneau/embel/issues/66) identified raw
project instructions appearing as website and social marketing copy. The saved
logo brief's activity is input context, not reviewed customer-facing writing.
The earlier choice to use saved activity in the application examples is
superseded for these previews.

- The board no longer passes activity into its presentation components. Neither
  the board system nor the website/social mockups accept an activity prop.
- Website body text is the fixed layout placeholder “Your brand introduction
  goes here.” The social headline and caption are “Your announcement goes here.”
  and “Your message goes here.”
- Both affected tiles say **Application preview · Placeholder copy** in their
  visible captions and accessible region descriptions. The business-card tile
  retains **Application preview** without implying it contains placeholder prose.
- The saved name, exact selected artwork, proposed palette, default typography,
  precise stale-selection guidance and six-tile layout remain unchanged. No
  removed review banner, brand/audience summary or design-notes section returns.

There is no reviewed marketing-copy field in this flow. The implementation does
not guess whether a brief looks publishable, trim a prompt into a slogan or
generate replacement copy. Supporting reviewed customer-facing writing later
requires a distinct source and review contract; it must not fall back to raw
brief fields.

No saved brief, selection, proposal or approval is modified. Opening and
reloading the board remain read-only, with no provider call, persistence change,
new permission or export path.

## Verification

Focused synthetic tests cover the fixed text and visible/accessibility labels,
raw QA instructions, multiline French instructions, ordinary descriptive text
and an empty activity. Reload produces the same application text without writes,
quotes, generation admissions or selection changes. Existing board tests retain
the exact logo, palette/default-font states, ownership fences, read failures and
read-only retries.

- `node node_modules/vitest/vitest.mjs run tests/client/brand-board-direction.test.tsx tests/client/brand-board-page.test.tsx --maxWorkers=1`: **20 tests passed**.
- Targeted ESLint passed for the changed presentation components, both focused
  client test files, the layout fixture and the browser test file.
- The existing layout fixture now omits the removed activity prop. The browser
  test includes the new visible labels and accessible descriptions; it has not
  been executed for this increment.

Full typecheck, build, browser layout checks and live acceptance are not part of
this focused implementation. The new caption uses the existing wrapping caption
layout; desktop/mobile appearance still needs integration verification.
