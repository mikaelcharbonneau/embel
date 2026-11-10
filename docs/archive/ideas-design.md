> Archived November 10, 2026: describes the system before the generation engine.

# Ideas screen design

## Approved reference

On 2026-10-09 the user requested that the app's Ideas screen match **Page - Ideas** on Wonder's Workspace page.

- [Wonder Workspace page](https://app.wonder.so/fluid/files/01a11dfe-6aa3-7091-98fe-2fad32cf9fc0/branches/main/pages/01a11ed5-9795-737b-b0ba-404021959e88), artboard `psp`.
- Live reference read on 2026-10-09. The current artboard has an empty footer; the earlier privacy and AI-availability footer notices were removed in Wonder.
- Reuse the approved Home shell: 80 px collapsed rail, black active edge, 76 px toolbar, and a continuous 16 px grid.
- Main content: 1088 px maximum width including 40 px side padding, 40 px top padding, 32/48 px heading, and 44 px search/filter controls.
- Three card columns with 18 px gaps; white 10 px rounded cards, 20 px padding, 18/26 px titles, 14/22 px descriptions, and 12/20 px metadata. State appears beside the idea icon; theme and arrow appear at the bottom.

## Implementation boundaries

- The initial increment applied to `/ideas`. The subsequent [Idea Detail implementation](idea-detail-design.md) extends the approved design to `/ideas/[ideaId]`.
- Cards remain owner-verified account results. The reference's six named ideas are not seeded into production.
- Existing capture, search, pagination, retry, and account-change fences remain authoritative. Search submits with Enter, matching the reference's single search field.
- The state control retains a native, keyboard-accessible select underneath its styled label.
- Home and Ideas share shell CSS. Other routes are not opted into the new shell.
- Account identity uses the real session's generic account label rather than hardcoding the reference's name/avatar.
- Smaller viewports use two or one card columns and the existing mobile navigation drawer.

## Verification — 2026-10-09

- Typecheck, lint, and production build passed.
- The four relevant client suites passed: 22 tests covering Ideas memory/attachment behavior and Home account/scope controls.
- Existing Ideas and Home recovery browser suites passed: 50 checks across desktop and mobile using isolated, intercepted account fixtures. No live database/provider validation was performed.
- Updated obsolete Home account-menu test selectors and completed the Ideas fixture's saved-project-list response; the app's persistence/recovery logic was not changed to accommodate tests.
- Visual checks at 1440 × 900 and 390 × 844 showed no horizontal overflow. Desktop: heading x=256/y=116, search x=256/y=212 and 1008 × 44, first card x=256/y=280 and 324 × 196; three 324 px columns with 18 px gaps.
- Evidence: `output/playwright/ideas/desktop.png`, `mobile.png`, and `regression/`. The images contain explicit synthetic fixtures, not production seed data.
- Local production preview: `http://127.0.0.1:3133/ideas`. The visiting browser uses its actual account state.
- No deployment, commit, or push was performed.
