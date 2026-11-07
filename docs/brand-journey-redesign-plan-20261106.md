# Brand journey redesign — build plan (2026-11-06)

Design source: the "Embel Design Refresh" canvas (https://claude.ai/artifact/EqGeEVeHh2jPfzagUzNzzq).
Approved screens: Home `v4 · 1 · Floating pill nav` (rounder corners) and the 14-board row
"Brand creation flow · v1 style" (`Flow · 1` … `Flow · 14`). Other rows on the canvas are
explorations and are not part of this build.

This is a plan only. Nothing here is implemented yet.

## Decisions already confirmed by the user

| Decision | Consequence for the build |
| --- | --- |
| Four steps: **Strategy** (Competitors, Audience, Positioning), **Voice** (Personality, Name, Slogan — optional), **Identity** (Inspiration, Logo, Creative direction), **Assets** (Brand images, Brand guidelines, Design system) | New journey model; Personality moves out of Strategy; Positioning and Slogan become guided steps |
| Home = floating pill navigation (Home · Projects · Library · Tools), rounder corners | Replace the sidebar rail and top bar |
| No magenta accent | Remove `--magenta`, `--magenta-soft`, `--accent-text`; neutral ink for emphasis |
| No cost estimates anywhere, and never ask about them | Remove every estimate label, cost-review dialog and allowance label; AGENTS.md line "Show expected cost beside Generate" must be updated |
| Competitor research starts as soon as the idea is sent from Home | Sending the Home prompt is the one deliberate click; remove the "Review the research request, then start research" gate |
| One conversation per project; answers collapse into editable summaries | Extend the existing inline-conversation pattern (Naming already mounts inline in Strategy) |
| Compact choice cards: click the card to choose; no "Use this…" buttons, no style tags or descriptions on name/logo cards | Shared ChoiceCard component |
| Questions before generation (naming choices; logo types) | Reuse the app's existing questions, restyled |

## Screen-to-code map

| Design board | Current code | Change |
| --- | --- | --- |
| Home (v4 · 1) | `app-shell.tsx`, `project-editor.tsx` (`NewProjectForm`), `home-scope-picker.tsx`, `home-recent-brands.tsx`, `project-card.tsx` | Rework shell; restyle Home; recent cards need a journey-stage label from the server |
| Project capsule (all flow boards) | Breadcrumb in `app-shell.tsx`; `project-workspace.tsx` stage logic | New: project name, 4-step bar, Saved status in the floating capsule |
| 1 · Competitors | `account-guided-interview.tsx`, `guided-interview-widgets.tsx`, `guided-start-consent.ts`, `server/ai/strategy-response.ts` | Restyle; auto-start research; add competitor logos |
| 2 · Audience | Same files (stage `audience`) | Restyle only |
| 3 · Positioning | Legacy `strategy.positioning` operation, `strategy-review.tsx`, `context.positioning` | New guided stage (proposals, single choice) |
| 4 · Personality | Guided stage `personality` | Move from Strategy to Voice; restyle |
| 5 · Naming choices | `naming-approach-widgets.tsx` (approaches, directness, length) | Restyle into question cards |
| 6 · Name | `project-naming-workspace.tsx`, naming feed, shared domain check (#185/#186) | Compact cards with .com status; Saved filter |
| 7 · Slogan | — (only "Your tagline here" placeholders in `features/brand-assets/model/artwork.ts`) | New AI operation, storage and step |
| 8 · Inspiration | `components/inspiration/*`, `inspiration-catalog.json` | Move into the conversation; masonry + detail chips |
| 9–10 · Logo types, concepts | `components/logo-creation/*` (brief `logoTypes`, six concepts, refinement) | Restyle; remove cost dialog; refine through the composer |
| 11 · Creative direction | `components/visual-directions/*`, `features/identity-directions/*` | Restyle; auto-start after logo choice; compact cards |
| 12 · Brand images | `features/brand-assets/model/artwork.ts` (5 social formats) | Restyle; "In use" mockups are new generation |
| 13 · Brand guidelines | `features/brand-assets/model/guides.ts` (HTML export) | New in-app view; extend content (overview, logo, voice, imagery) |
| 14 · Design system | CSS/JSON colour export in `brand-kit-contents.tsx` | Extend tokens (type scale, spacing, radii), preview, export; final brand-kit download |

## Phases

Each phase ends in a working app, focused tests and a browser check at 1440 and 390 widths.
Phases 3–6 can run as parallel workstreams once Phases 0–2 land, with disjoint file ownership.

### Phase 0 — Foundations (size: M)
- Tokens: remove magenta from `tokens.css` and its 87 uses in `src/styles`; add the rounder radius scale used by the v1 design (pills 999, cards 16–20, buttons 999).
- Shared components: `FloatingNav`, `ProjectCapsule`, `Composer` (attach, dictate, send, optional "Changing X" chip), `ChoiceCard` (radio/checkbox), `AnswerSummary`, `EmbelMessage`, `ProgressCard`.
- Remove cost-estimate UI: `use-generation-estimate.ts`, `generation-action.tsx`, `cost-confirmation.tsx`, estimate text in `visual-directions-view.tsx`, `refinement-gallery.tsx`, `vector-conversion-controls.tsx`, `vector-proposal-panel.tsx`, `strategyAllowanceLabel` in the interview. Keep server reservations, duplicate prevention, cancellation and reconciliation.
- Update AGENTS.md lines that conflict with confirmed decisions (cost display, steps).

### Phase 1 — Shell and Home (size: M)
- Replace sidebar + top bar with the floating pill navigation; Tools menu (Ideas, Names, Handles, Domains, Trademarks); account menu keeps Settings. Library = today's `/assets` (to confirm).
- Home: headline, composer with Complete brand / Name only / Visual identity switch inside the box, idea pills, recent project cards.
- Server: add the journey stage to the project listing so cards can say "Look · choosing" etc.

### Phase 2 — Journey model and conversation host (size: L)
- Journey model in `domain/`: steps and sub-steps derived from saved evidence (extend `project-handoff.ts`), no new stored stage column unless derivation proves unreliable.
- One project conversation at `/brands/account/[id]`: mounts each step's widget inline (generalise `InlineNamingConversation`), collapses finished answers into summaries with Edit, keeps the composer pinned at the bottom.
- Existing deep routes (`/naming`, `/logo`, `/logo/directions`, `/logo/deliverables`, `/inspiration`) redirect into the conversation at the right step.
- Capsule shows the brand name once chosen ("Untitled brand" before).

### Phase 3 — Strategy (size: M–L)
- Auto-start competitor research on Home send; remove the client start-consent gate; keep the single deliberate request identity so a reload never redispatches.
- Competitor cards with logos: fetch each competitor site's icon server-side with SSRF protection, store privately, show a neutral monogram when none is found.
- Change `guidedStageSchema` to `competitors → audience → positioning`; add a guided positioning policy (proposals with angle, statement, "why it works", lead tags; single choice). Existing interview data is disposable test data and can be reset.

### Phase 4 — Voice (size: L)
- Personality becomes Voice 1 of 3 (reuse the guided personality policy; new placement and copy).
- Naming: restyle the three naming questions; compact name cards; .com status from the shared domain check for visible names; Saved filter; selecting a name renames the project.
- Slogan (new): `voice.slogan` operation and policy, `context.slogan` field, optional step (Skip / Write your own), slogan flows into brand images and guidelines.

### Phase 5 — Identity (size: L)
- Inspiration inside the conversation (masonry, like whole look or details); likes feed the logo brief as today.
- Logo: types question → six concepts (one deliberate click, no cost dialog) → choose by clicking → refine through the composer chip.
- Creative direction: starts automatically after the logo choice; compact cards (board, swatches, type); refine via composer or "More directions".

### Phase 6 — Assets (size: L)
- Brand images: the five existing formats at true proportions with redo/download; "In use" mockups (jar label, bike, tote) as a new generation if confirmed.
- Brand guidelines: in-app document built from saved data (overview, logo, colours, typography, voice, imagery); section Edit routes a change request through the conversation; download keeps the existing HTML guide format.
- Design system: token set (colours with roles, type scale, spacing, radii), live preview, CSS/JSON export, final "Download brand kit" including slogan, guidelines and tokens.

### Phase 7 — Retire and verify (size: M)
- Remove the old Logo/Visual direction/Brand assets layouts, project docks and unused CSS; migrate or drop obsolete saved formats per AGENTS.md.
- Full regression: vitest suites, e2e journeys (`tests/e2e`), one live end-to-end brand with real providers, usage reported.

## Open questions for the user
1. Is "Library" today's `/assets` page?
2. The project step bar returns in the capsule (bars were removed on 2026-10-21). The approved flow designs include it — confirm.
3. Add the new generations: "In use" mockups (Brand images) and AI-edited guideline sections?
4. Competitor logos: fetch directly from each competitor's site (preferred, no third party) — confirm.

## Delivery
Build on `main` behind a `journeyV2` flag so phases can merge and deploy safely; switch the flag on when Phases 0–6 pass, then run Phase 7. While there are no customers, the old flow can be removed instead of maintained in parallel.

## Status — Phases 3 to 7 (2026-11-06)

Implemented on `journey-v2/phase-3-strategy` (stacked on Phase 2, PR #192), desktop only.

- **Strategy:** research starts from the Home Send with no second approval (the
  request key stays project + revision + operation, so a reload never starts a
  second request); competitor cards and answer chips show each competitor's own
  site icon, fetched by the server from public HTTPS addresses only (checked on
  every redirect, raster images up to 256 KB, 8 s), with a neutral initial when a
  site has none; the research progress card with Cancel; the toolbar row with
  Add a competitor, Suggest more, "N selected" and Continue; Positioning is the
  third Strategy question (angle, statement, why it works, what to lead with;
  choose one); once answered, Strategy collapses into one summary card.
- **Voice:** Personality is Voice 1 of 3; naming questions restyled; name cards
  show only the name, its .com status (shared domain check, only for names on
  screen, waiting out the lookup limit) and the heart; click a card to choose;
  All / Saved filter; the chosen name renames the project wherever it is shown;
  the optional Slogan is proposed for the chosen name (choose, write your own,
  More slogans, Skip for now) and flows into the guidelines and the kit.
- **Identity:** Inspiration, Logo and Creative direction open with Embel's
  message; Logo asks the logo-types question before Explore six concepts (one
  click), cards show only the image, click to choose, refine in the box below;
  Creative direction starts on its own once per chosen logo; boards are chosen
  by clicking; no money is shown in the journey.
- **Assets:** Brand images (five formats at true proportions, PNG/SVG),
  Brand guidelines in the app (overview with slogan, logo, colours, type in the
  real fonts, voice, imagery; Edit opens the step that sets each part; HTML
  download kept) and a Design system (preview, colour tokens with roles, type
  scale, spacing, corners, CSS/JSON export); the brand kit ZIP now includes the
  design tokens and the slogan.

Decisions taken while building:
- The slogan uses a new guided `strategy.slogan` operation on the Strategy lane
  (same policy shape as audience and personality) instead of a separate lane;
  the chosen line is kept on the slogan answer of the guided interview, so the
  project context format is unchanged.
- Not built (open questions still unanswered): "In use" mockups and AI edits of
  guideline sections. Guideline Edit opens the step that owns each part instead.

Release requirements (production is unchanged until these are applied together):
1. Migration `20261106150000_guided_journey_stages.sql`.
2. Post-install packet `candidates/shared_guided_journey_stages.sql` (pinned in
   the authority manifest and production composer).
3. A worker release built from this source whose pool configuration gives the
   Strategy slot six policies (adds `strategy.positioning` and `strategy.slogan`,
   both `guidedStrategyPolicy`).
4. Local development: the shared schema now differs, so a local stack must be
   rebuilt (`npm run dev:down`, remove the local volumes, `npm run dev:up`), and
   each local test account needs the local naming pilot re-enabled.
