> Archived November 10, 2026: describes the system before the generation engine.

# Inspiration workspace

Implemented locally on 2026-10-13 as the user's first requested workstream, without delegation. The approved current Figma page is [Inspiration](https://www.figma.com/design/HP219GuYbpE8F1wHxj0h6N/Fluid-Screens?node-id=159-433): Browse 159:434, detail 159:435, style drawer 159:436 and Liked 159:437. The earlier generic Identity reference grid remains available for existing uploaded references and systems.

## User behavior

Open Identity in an account project's stage navigation to reach `/brands/account/:projectId/inspiration`. Browse the 15 curated designs, search brands/studios/descriptions/tags, filter Identities or Logos, inspect artwork with attribution, and like an overall look or relevant elements independently. Liked includes either kind of choice. Counts start at zero and reflect that project's actual saved preferences; the six illustrative likes in Figma are not account data. Your style lists those saved choices. It does not invent an AI interpretation.

Whole-design likes do not implicitly select components, and removing a whole-design like preserves component likes. Opening a detail or changing gallery filters does not write anything. Actual saved choices return on reload. Pending changes remain in owner-fenced tab memory during navigation or session rechecking, participate in sign-out and unload protection, and never enter localStorage. Changing accounts discards that owner's pending memory. A failed write requires a fresh read before an explicit retry; a lost successful response is resolved by reading, without another write. Confirmed saved choices are distinct from unconfirmed intent.

## Catalog and ownership

`src/domain/inspiration-catalog.json` contains the approved original artwork descriptors, relevant elements, stable UUIDs, dimensions, attribution URLs and SHA-256 hashes. Original images and heart icons are in `public/inspiration/`. Images were extracted byte-for-byte from authenticated Figma image objects, verified against Figma's SHA-1 hashes and recorded with SHA-256; no app markup was imported. Their designers are COLLINS (Dropbox), Studio Dumbar/DEPT® (INBO and INTO), and Pentagram (Mastercard and Cardless). Attribution is not a license grant. These are reference artworks, never generated Embel outputs or brand deliverables.

The existing `identity_references` contract requires exact privately owned media versions. Global catalog images must not fabricate those assets or storage paths. The additive `20261013120000_project_inspiration.sql` migration therefore seeds immutable private catalog metadata, with separate project-owned preference heads and choices. RLS restricts direct reads, raw writes are revoked, and narrow authenticated RPCs derive the owner from `auth.uid()`. A project lock, project revision, per-design revision and aggregate selection revision prevent stale scope/context writes and lost updates. Naming-only projects can browse but cannot save visual preferences until explicitly expanded.

The GET and PATCH API routes use authenticated context, private no-store replies, strict bounded JSON and verified project/owner receipt binding. PATCH requires the configured application origin. No service-role credential, AI job, external discovery request or asset mutation is involved. Each request is bounded to 15 seconds, and late responses cannot publish into another account.

## Integration boundary

The catalog is intentionally a bounded first collection, not a claim of live discovery. Existing uploaded reference snapshots and generation contracts remain intact. Saved choices can now be explicitly translated into [reviewed visual guidance](visual-direction-review.md) for post-logo Identity directions. Initial logo concepts retain their existing brief and owned reference inputs. Links to saved references/systems and logo creation preserve access to existing workflows.

The migration was applied and verified in the approved Supabase project on 2026-10-13 as part of the [authorized database rollout](database-rollout-20261013.md). Existing private-reference data was preserved. Application promotion and signed-in browser acceptance remain separate release steps.

## Verification

Focused domain/client/API tests verify original image bytes/dimensions, combined search/filter behavior, no fabricated likes, owner/generation fences, response bounds, timeouts, authentication, origin enforcement and exact write receipts. Local PGlite runs the full migration chain and checks real RLS/privileges, ownership, project separation, revision conflicts, strict inputs, independent likes and read-after-save persistence. Browser tests use actual Next components and original assets with explicitly intercepted local account/API fixtures; they do not claim live database/provider connectivity.

The full checkout typecheck is currently blocked by two preserved, pre-existing unfinished test files: `tests/client/project-workspace-progress.test.tsx` expects an unimplemented `useProjectLogoEvidence` export, and `tests/domain/project-handoff.test.ts` imports an absent `src/domain/project-handoff.ts`. A separate temporary configuration outside the checkout excludes only those two files to verify the remaining source. The production JavaScript compilation succeeded; a complete production build is not claimed while that baseline typecheck is blocked. Those unrelated tests were not removed or rewritten to make this work appear green.

Final local result: 15 new feature tests plus 43 existing account/reference regressions passed. All 12 browser scenarios passed across desktop (1440×900), iPhone (390×664) and narrow (320×740) viewports; two phone timing failures passed when rerun separately without the competing typecheck. Scoped lint and the final scoped typecheck passed. The repeated-save browser check caught and fixed accidental inclusion of saved-row metadata in mutation payloads; a dedicated hook regression now exercises three successive edits of the persisted reaction. This evidence uses local fixtures and does not establish live production persistence.
