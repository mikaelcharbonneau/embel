> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Brand board proposal labels — 2026-10-20

## Scope

Issue #36 clarifies the existing compact board without changing its six-tile
layout, selected artwork, color values, typography specimens or application
mockups. The constraints in [the approved board research](brand-board-research-20261018.md)
remain in force: no review banner, attribution list, brand/audience summary or
design-notes section is restored.

- The logo tile says **Selected logo** and **Saved selection**. It continues to
  read the exact selected concept or refinement and reuse that same verified
  private image in all three application previews.
- The palette says **Proposed palette** and identifies its source as saved
  Inspiration choices or a neutral starting point. Colors are still the existing
  deterministic proposal, not sampled artwork or a generated identity decision.
- Type says **Proposed typography** and **Geist Sans · Default preview**. Its
  existing choice-dependent weight and specimen remain unchanged. This is not a
  saved brand-font selection or a new licensing claim.
- All three mockups retain **Application preview**. Each tile's source or status
  is also associated with its accessible region description.
- Existing stale brief/concepts evidence adds **Review changed inputs** inside
  the logo tile; stale refinements do so only for a selected refinement. The
  selected artwork stays visible. Later vector, direction and deliverable stages
  do not relabel an otherwise unchanged raster selection.

The direction helper explicitly identifies its output as a presentation proposal.
Opening the board, reloading it and retrying a failed read do not write a
selection, approval, identity snapshot or export. Account ownership, saved name,
private preview verification and error handling retain their existing contracts.
No new provider, database, storage, generation, approval or download path is added.

## Remaining boundaries

Immutable approved board snapshots and production export work remain separate.
The small stale-selection note uses the workspace's existing stale-stage
evidence; it does not add logo-to-brief provenance comparisons or resolve the
broader old-logo/new-brief lineage work in issue #56. This board does not present
its suggested palette, default font or mockups as approved or export-ready assets.

## Verification

Final targeted run:

- `npx vitest run tests/client/brand-board-direction.test.tsx tests/client/brand-board-page.test.tsx tests/client/logo-candidate-review.test.ts --maxWorkers=1`: **29 tests passed**.
- Targeted ESLint on the three changed board source files, both board unit/client
  suites and the updated board section of `tests/e2e/logo-creation.spec.ts`: passed.
- Actual page/hooks/account-client tests cover saved concept and refinement
  selection, absent selection, stale selections, neutral fallback, missing
  candidate with read-only retry, unavailable private bytes, failed Inspiration
  reads, account changes and reload. The tests verify no mutations and unchanged
  saved name/artwork evidence.
- Static presentation tests cover six tiles, source/status accessibility,
  contrast, deterministic proposal status, precise stale-stage scope and absence
  of restored sections or unsupported approval/export claims.

The existing desktop/mobile layout test now checks the new visible labels.
Browser execution was **blocked before any layout assertion**: the bundled
Playwright browser was absent, and one normal launch of the installed Chromium
failed at process-singleton socket creation with `Operation not permitted`.
No retry with weakened restrictions or escalation was attempted. A successful
browser layout check, full typecheck and production build remain with integration
verification; the local tests are synthetic, not live-provider acceptance.
