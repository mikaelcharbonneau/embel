# Home design source of truth

## Approved design

On 2026-10-08 the user selected the latest **Home Concept 22 — Scope Dropdown** as the app's design source of truth and requested that implementation start with Home.

- [Wonder file](https://app.wonder.so/fluid/files/01a11dfe-6aa3-7091-98fe-2fad32cf9fc0)
- Page: `01a11dfe-6aa5-743e-bddf-2597d8f3b1ae`; home artboard: `was`; menu detail: `ump`.
- Reference viewport: 1440 × 900. Latest reference markup is preserved in ignored `.references/concept-22/canvas.json`.
- The supplied `image (4).svg` is the approved app mark, now `public/embel-mark.svg` (with `public/fluid-mark.svg` retained as a compatibility alias). Original SHA-256: `d35a02f13f469a0c2a72b5bcfb826d3313c643cc687dda72a62ff1a0b7e261ac`.
- Keep Geist, the existing neutral/magenta tokens, 80 px collapsed sidebar, black active edge marker, 16 px background grid, 40 px headline, 800 px composer, and the bottom blur/fade over continuing brand cards.
- On 2026-10-14 the user set background grid lines to 20% opacity across all screens. The shared CSS grid and every screen-specific SVG grid use this value; original design captures remain historical references.
- Composer: bare + before the Brand dropdown, 22 px gray icons, 16 px scope label, 128 × 44 px dropdown, bare mic, and 44 × 44 px arrow-only send button. No Save draft button inside the composer.

## Implementation boundaries

- This increment implements Home and its home-route shell. Other editing routes keep their existing layouts; the approved mark is shared.
- Real local drafts and owner-verified account project summaries populate the cards. The design's named example brands are visual-test fixtures only and are not seeded into production storage.
- Typographic card previews are derived from project titles; they are not claimed to be generated logo files. Account summaries do not expose a saved stage, so their action says “Continue your brand.” Browser cards use their real saved stage.
- Account metadata currently provides an owner ID, not a display name. The header uses a generic account label/avatar instead of hardcoding the reference's personal identity.
- Existing server scopes remain authoritative: Brand → `complete_brand`, Name → `naming_only`, System → `visual_identity_only`. Logo directs users to the existing Brands workflow via its unavailable-option hint; standalone Font, Color, and Guide remain unavailable. Enabling these as new creation contracts is separate product work.
- Attachment and on-device speech controls retain their real capability checks, session fencing, transcript review, and recovery behavior. The redesign does not authorize or initiate paid inference.
- Recovery and generation/cost disclosures appear when a prompt or retained operation requires them. Retained-draft recovery actions remain outside the composer.
- The home viewport scrolls. The bottom fade is decorative and pointer-transparent, and disappears at the bottom so content remains accessible. Smaller screens use a navigation drawer and fewer brand columns.

## Verification

See `output/playwright/concept-22/` for local browser captures. These use an isolated headless browser and explicit synthetic fixtures; they are not live provider or production-account acceptance.

### Verified on 2026-10-08

- `npm run typecheck`, `npm run lint`, and `npm run build` passed.
- `vitest run tests/client --maxWorkers=2`: 63 files, 657 tests passed. The affected Home suites were also rerun after the final control-order change: 25 passed.
- `FLUID_E2E_PORT=3131 FLUID_E2E_BROWSER_CHANNEL=chrome npm run test:e2e -- tests/e2e/home-recovery-lifecycle.spec.ts --workers=1`: eight checks passed across desktop/mobile, including sign-in recovery, duplicate-dispatch prevention, and uncertain-save edit fences. The bundled headless shell crashed before reaching the form on this host; the optional installed-Chrome override keeps the normal test command reproducible without changing the default CI browser.
- Production visual checks at 1440×900 and 390×844: no horizontal overflow; dropdown 128×44; send 44×44; desktop composer x=360, y=236, 800×164; brand cards 324×170 at y=592 and y=780; the second row extends below the viewport; the 96 px bottom fade clears at the scroll end.
- Images: `output/playwright/concept-22/desktop.png` and `mobile.png` (synthetic browser drafts only). No live provider calls, credential changes, database mutations, deployment, commit, or push were performed in this increment.
- Local production review server: `http://127.0.0.1:3132`. It displays the visiting browser's actual drafts/account state; the isolated QA browser's sample brands are not app seed data.
