# Home Concept 22 — historical design reference

## Current status — 2026-10-29

The user now permits broader redesign to improve the app's quality and usability. Follow the [current working agreement](../AGENTS.md) for design freedom, product priorities, feature-removal decisions, testing and release authority. The dimensions, layout, control styling and route boundaries below record an earlier implementation; they no longer require future screens to match Concept 22. Reference provenance remains useful without freezing the design.

This document update changes instructions only. It does not implement a redesign or change runtime cost policies or confirmation dialogs.

## Historical design selection

On 2026-10-08 the user selected the latest **Home Concept 22 — Scope Dropdown** as the app's design source of truth and requested that implementation start with Home.

- [Wonder file](https://app.wonder.so/fluid/files/01a11dfe-6aa3-7091-98fe-2fad32cf9fc0)
- Page: `01a11dfe-6aa5-743e-bddf-2597d8f3b1ae`; home artboard: `was`; menu detail: `ump`.
- Reference viewport: 1440 × 900. Latest reference markup is preserved in ignored `.references/concept-22/canvas.json`.
- The supplied `image (4).svg` was selected as the app mark, stored at `public/embel-mark.svg` (with `public/fluid-mark.svg` retained as a compatibility alias). Original SHA-256: `d35a02f13f469a0c2a72b5bcfb826d3313c643cc687dda72a62ff1a0b7e261ac`.
- The reference used Geist, neutral/magenta tokens, an 80 px collapsed sidebar, black active edge marker, 16 px background grid, 40 px headline, 800 px composer, and a bottom blur/fade over continuing brand cards.
- On 2026-10-14 the user set background grid lines to 20% opacity across all screens. This records the historical setting, not a constraint on the newly authorized redesign.
- The reference composer used a bare + before the Brand dropdown, 22 px gray icons, 16 px scope label, 128 × 44 px dropdown, bare mic, and 44 × 44 px arrow-only send button. It excluded a Save draft button inside the composer.

## Original implementation boundaries

These describe the original increment, not current feature availability or permission to remove features. Consult the current implementation and working agreement before changing product behavior.

- This increment implemented Home and its home-route shell. Other editing routes retained their existing layouts; the selected mark was shared.
- Real local drafts and owner-verified account project summaries populated the cards. The design's named example brands were visual-test fixtures, not production seed data.
- Typographic card previews came from project titles, without claiming to be generated logo files. Account summaries did not expose a saved stage, so their action said “Continue your brand.” Browser cards used their saved stage.
- Account metadata provided an owner ID rather than a display name. The header used a generic account label/avatar instead of hardcoding the reference's personal identity.
- The scope mapping was Brand → `complete_brand`, Name → `naming_only`, System → `visual_identity_only`. Logo directed users to the Brands workflow via an unavailable-option hint; standalone Font, Color, and Guide were unavailable in this increment.
- Attachment and on-device speech controls retained capability checks, session fencing, transcript review, and recovery behavior. This increment did not include paid inference.
- Recovery and generation/cost disclosures appeared when a prompt or retained operation required them. Retained-draft recovery actions stayed outside the composer.
- The home viewport scrolled. The decorative, pointer-transparent bottom fade disappeared at the bottom to keep content accessible. Smaller screens used a navigation drawer and fewer brand columns.

## Historical verification

See `output/playwright/concept-22/` for local browser captures. These use an isolated headless browser and explicit synthetic fixtures; they are not live provider or production-account acceptance.

The results and pixel measurements below document that increment. They are neither current readiness evidence nor fixed visual acceptance criteria for future designs.

### Verified on 2026-10-08

- `npm run typecheck`, `npm run lint`, and `npm run build` passed.
- `vitest run tests/client --maxWorkers=2`: 63 files, 657 tests passed. The affected Home suites were also rerun after the final control-order change: 25 passed.
- `FLUID_E2E_PORT=3131 FLUID_E2E_BROWSER_CHANNEL=chrome npm run test:e2e -- tests/e2e/home-recovery-lifecycle.spec.ts --workers=1`: eight checks passed across desktop/mobile, including sign-in recovery, duplicate-dispatch prevention, and uncertain-save edit fences. The bundled headless shell crashed before reaching the form on this host; the optional installed-Chrome override keeps the normal test command reproducible without changing the default CI browser.
- Production visual checks at 1440×900 and 390×844: no horizontal overflow; dropdown 128×44; send 44×44; desktop composer x=360, y=236, 800×164; brand cards 324×170 at y=592 and y=780; the second row extends below the viewport; the 96 px bottom fade clears at the scroll end.
- Images: `output/playwright/concept-22/desktop.png` and `mobile.png` (synthetic browser drafts only). No live provider calls, credential changes, database mutations, deployment, commit, or push were performed in this increment.
- Local production review server: `http://127.0.0.1:3132`. It displays the visiting browser's actual drafts/account state; the isolated QA browser's sample brands are not app seed data.
