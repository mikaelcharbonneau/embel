# Design refinement implementation ledger

Scope: the 16 findings in the 2026-10-20 production design audit. Preserve the existing Geist typography, palette, icon language, grid motifs and thin borders. This is a staged implementation, not a new visual identity.

Base: `5f7a1306fb35c346e0e5bbe541b4a6e4825bd0b8` (`main`). The original `/Users/mikael/embel` checkout and its local documentation/design changes are untouched. No database migration, provider activation, generation, project selection, deletion/restoration, deployment or merge is part of this work.

## Stage 1: shared project foundations

| Finding | Implementation | Acceptance contract | Status |
| --- | --- | --- | --- |
| F01 P1: inconsistent navigation | Restore the same global header/trigger on project routes. Keep Strategy, Naming, Logo & identity and Files in one shared row. Give the six existing visual subpages explicit names and one shared subnavigation. Remove duplicate page-local journey rows. | Consistent trigger coordinates across page families; one stage row; truthful current page; keyboard access; existing dirty/scope/readiness gates; stable shell/editor lifetime. | Implemented; focused tests and synthetic desktop/narrow browser contracts passed. |
| F02 P1: arbitrary project-card title artwork | One Home/Projects card construction. Read only the persisted Logo V2 choice through existing owner-bound APIs and hash-verified preview bytes. Keep project title separate from saved brief name and metadata; neutral fallback for missing/unavailable/naming/deleted artwork. | Real selected bytes or honest fallback; no rename; two-line long title; no overflow; no wrong-owner or late preview; released object URLs; bounded lazy reads; keyboard options. | Implemented; owner-fenced unit coverage and decoded synthetic artwork browser contracts passed. |
| F03 P1: saved-choice vocabulary | Name the project logo choice and exact refinement target. Explain that asset retention, asset-version selection, project logo choice, vector approval, Inspiration choices and saved-system references have independent scopes. Rename the retention view to Kept assets without changing its query. | No semantic merging or data migration; existing filters/actions/ownership unchanged; distinct scopes visible where apparent contradictions occurred. The recorded usage field remains authoritative; a project logo choice is not inferred to be recorded asset use. | Implemented; focused tests and synthetic desktop/narrow browser contracts passed. |
| F04 P1: overlapping Logo composer | Put a compact refinement disclosure before the grid in normal document flow. Expose its exact target and Project context. Keep the textarea and context editors mounted while collapsed; expand only on explicit action. | No preview/composer overlap at desktop or narrow viewport; retained edits/focus; keyboard dialog cancellation; reachable final CTA; cost review remains explicit; no automatic request. | Implemented; continuity, delayed-dialog focus return and no-overlap browser contracts passed. |
| F05 P1: late prerequisites | Put confirmed/unknown/stale vector, identity and variant states before disabled downstream controls. Link to the existing review step. Move export preparation options into a native disclosure while prerequisites are missing. Remove the premature ready heading. | Prerequisite and next step visible before unavailable controls; gates unchanged; no false ready/approved state during unknown/loading/error; reviewers/options retain DOM lifetime and values. | Implemented; prerequisite, retained-approval uncertainty and keyboard browser contracts passed. |

## Remaining authorized groups

| Finding | Next implementation and main acceptance criterion | Status |
| --- | --- | --- |
| F06 P2: Settings unavailable density | Align editable setting rows and consolidate unsupported/read-only capabilities with clear status. Preserve all unavailable services and controls. | Pending. |
| F07 P2: Names Workshop result distance | Bring the live results next to the relevant controls and reduce initial narrow-screen configuration depth. Keep all entered values and independent view state. | Pending. |
| F08 P2: competing Names libraries | Unify the visible library/search/filter hierarchy while preserving saved versus favorite semantics, source provenance, revisions and deleted-project history. | Pending. |
| F09 P2: Domains hierarchy/provider IDs | Bring view navigation above results, clarify action labels and present provider identifiers as subordinate technical detail. Preserve current manual/provider availability. | Pending. |
| F10 P2: Handles preview hierarchy | Prioritize the comparison preview on narrow screens and distinguish building a local comparison from unavailable checks. Preserve empty/disabled honesty. | Pending. |
| F11 P2: Trademarks task vocabulary | Clarify research/preparation/current-draft/revision navigation and coverage labels without implying availability, legal clearance or completed checks. | Pending. |
| F12 P2: loading frames and blocker copy | Keep stable page geometry through account/project/workspace loading; distinguish checking from unsaved changes. Stage 1 corrects navigation's checking tooltip only. | Partial; wider loading audit pending. |
| F13 P2: component scale/hierarchy | Apply role-based control/row/toolbar sizes using current tokens; verify long data and narrow layouts. Stage 1 only aligns shared project navigation/cards. | Partial; page-family refinement pending. |
| F14 P2: Usage geometry | Do not duplicate PR75's four-file geometry patch. Integrate its separately verified commit only through parent coordination, then check Settings/Usage together at desktop and narrow sizes with unknown/unavailable billing. Never invent totals or completeness. | Dependency: draft PR75 `9cfe51f7b58968fca1db032a00c77f676be4fdc4`; rendered acceptance pending. |
| F15 P3: Home unavailable branches | Make unavailable attachments/scopes concise and predictable; support Escape/outside-pointer/focus behavior without changing supported operations. | Pending. |
| F16 P3: Ideas metadata hierarchy | De-emphasize Storage/Version metadata and clarify existing create/attach progression without creating drafts or attaching records during verification. | Pending. |

## Verification and release boundaries

Focused regression coverage includes owner/generation masking, late responses, unchanged approval/cost predicates, saved-input continuity, collapsed-editor continuity and keyboard behavior. Browser fixtures are explicitly synthetic: they establish rendered local layout/interaction contracts, not authenticated production acceptance or provider availability. No claim of WCAG conformance, measured frame duration or live reduced-motion compliance follows from screenshots/builds.

Production reference screenshots remain in the audit workspace; Stage 1 screenshots and exact commands/results are recorded in the implementation checkpoint. The parent owns integration, authenticated acceptance, merge and deployment. Persimmon must remain paused and Saint-Roch deleted throughout subsequent verification.

### Stage 1 validation checkpoint

- Focused UI regression: 52 suites, 484 tests passed, including exact-source cost review, background-refresh editor focus, owner masking, preview cleanup, and retained-approval uncertainty. Subsequent targeted navigation/cost checks cover the final label/focus cleanup.
- Production lint, typecheck and webpack build passed. No package lock, privileged worker/server, database migration or Usage file changed.
- Serial intercepted-account browser contracts: 38 passed across desktop and narrow Chrome. Representative cards, prerequisites and refinement captures use 1440×900 and 390×844; the screenshot index records each image's actual dimensions. Functional refinement behavior was exercised with reduced-motion emulation and reset afterward; no frame timings or application-wide motion conformance are claimed.
- The interrupted broad run has no completion summary and is not treated as a pass. Recovery verified that its Vitest/Next processes were no longer running before restarting scoped checks.
- An independent 18-run comparison against exact base `5f7a1306fb35c346e0e5bbe541b4a6e4825bd0b8` reproduced matching failures in seven database/worker files and one unchanged account-menu test: 16 failed cases on each tree. Reasons include a vector-process runtime-pin hash mismatch, three extra grant signatures, a lost-upload-acknowledgment status mismatch, protected worker-build input rejection, and a menu-open assertion that conflicts with the existing pathname-close effect. These remain separate release concerns, not silently accepted behavior or fixes in this UI scope.
- A current-only Logo test selected the first dialog after the context drawer moved before cost review. It now targets `dialog[aria-label="Review generation cost"]`; all four operation-UI tests pass. No assertion or gate was relaxed to conceal the difference.

Detailed local evidence lives in the task workspace at `implementation/stage-1/`: `baseline/baseline-comparison.md`, `baseline/focused-run-index.json`, `baseline/source-and-runtime-evidence.json`, the dedicated browser-result directories and `screenshots-verified-index.json`. This evidence uses synthetic local data, not live provider/production acceptance. F06–F16 remain as tracked above; PR75 remains an independent dependency.

### Stage 1 independent-review follow-up

- F01: the six visual subpages now share the top-level visual-navigation lock policy for checking, dirty/conflicted edits and naming-only scope. Disabled destinations retain the same frame, current-page indicator and truthful reason. No server, ownership or generation gate changes.
- F05: the dock and component-choice badge use the same current-versus-last-confirmed approval qualification as the prerequisite summary. Retained selection controls, local values and focus stay mounted through checking and read errors; approval/save predicates are unchanged.
- Verification: 34 focused tests in five suites, full lint/typecheck/production build, and eight serial desktop/narrow read-only intercepted-fixture browser contracts passed. The browser suite verifies the disabled six-item row remains 44px high and both rows agree on a naming-only direct visual route. Evidence is in `implementation/stage-1/review-followup/`; synthetic local acceptance does not imply authenticated deployment acceptance.
