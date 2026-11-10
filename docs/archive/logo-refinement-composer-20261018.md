> Archived November 10, 2026: describes the system before the generation engine.

> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../architecture-review.md).

# Refining a selected logo from the concepts screen

## User-approved behavior

The user requested describing changes and refining the selected logo directly on the concepts screen. Keep the concepts grid and saved selections; do not restore the removed inspection/refinement screen. Each refinement is a new immutable image with its original source and instruction retained by the durable job.

## Implementation

The composer shows the verified selected logo and its name. An explicit Review refinement cost click quotes the exact saved source and entered instruction, verifies the returned quote matches, and opens the shared cost review. The review shows the operation, immutable source and requested changes alongside the existing server-provided estimate and maximum. Only its separate confirmation admits one durable `identity.logo_refine` request. Cancel or Escape dismisses an unadmitted estimate without enqueuing work and returns focus to the composer. Refresh, selection, typing and mounting do not dispatch generation. Ctrl/Cmd+Enter opens the same review; ordinary Enter remains a newline. Messages remain when availability or admission fails.

Progress and verified saved refinement cards appear on the same screen. Selecting a refinement saves it through the existing account command; further edits use that exact refinement as the source. Only succeeded outputs with recorded billing, verified details and committed previews can be selected. No unverified image is presented as completed work.

The local worker activation extends only the existing owner-bound concepts lane to saved-preview refinements. Existing restricted credentials, image identity, exact per-call accounting, cancellation, leases, duplicate protection and unknown-outcome stops remain. Vector and unrelated operations remain separately configured. Runtime activation and real provider acceptance are recorded after verification.

## Checks

Dedicated headless desktop and mobile tests verify direct selection, exact-source composer requests, exactly one admission per submission, retained instruction, Ctrl+Enter and editing a saved refinement without navigation. Client tests cover verified results, unverified details and unknown billing. TypeScript and targeted ESLint passed before activation.

## Live verification completed

Installed `local_logo_preview_refinements` (20261018220216) and `local_logo_preview_refinements_activation` (20261018220222). Independent live audit verified exact installed function bodies, the same 14 worker grants and paired owner/role/Storage policy bindings. The renewal-enabled no-dispatch check passed, the previous idle worker drained, and the replacement worker advertised both image operations. A duplicate in-flight migration request returned expired requestState / duplicate migration version; installed catalog/source checks confirmed exactly the two intended migrations, so nothing was retried blindly.

A first stale quote was correctly rejected before provider dispatch after the saved project advanced from revision 7 to 8. Composer submission now refreshes authoritative workspace metadata, preserves the instruction and requires every non-project head to remain unchanged before quoting; changed sources or protected drafts block safely. Desktop/mobile regression covers this old-tab case.

One real Send refined Concept 1 with the requested lettering/spacing adjustment. Job `8b6e2b8d-02ee-4bd5-aaec-0dc25cf99ce7` succeeded with one step, one provider receipt, one committed publication and one immutable raster result. The recorded charge is 23,552 micro-USD ($0.023552). The image appears on the same screen, survives reload and was selected through the normal saved selection command for further edits. No second image call was required.

The live discovery exposed queued billing recorded as zero before a receipt exists. History compatibility now permits that provisional observation to advance, while receipt-backed/final charges and source lineage remain immutable. Tests cover queued-to-completed updates without reload and refusal to change retained final billing.

Final audit: zero active image jobs/reservations; all six original concept jobs, steps, provider receipts, publications, versions and results retain digest `bc037704f02091d4e4340aa4ae8b8fd0`. Concepts revision 2 selects refinement `c90ae182-e8c4-4d8d-ae8d-505bed74b08e`; refinement stage revision 1 retains it. Screenshot: `/private/tmp/embel-logo-chat-refinement-20261018.png`. Database tests (11), worker tests (92), targeted client tests and dedicated desktop/mobile browser regressions passed. TypeScript and targeted ESLint passed.

## Concept card versions (approved 2026-10-18)

The user requested that a refinement replace its original logo visually, with previous versions accessible on the same card. The concepts gallery now projects verified immutable refinement lineage into the original six slots. A completed chat refinement becomes the selected version in that slot; no additional refinement card is rendered. Each card with history has a Version selector (Original, Version 2, and subsequent versions), and changing it saves the selected source through the existing account selection API. Original output records remain unchanged. A later refinement updates the slot; deliberate earlier-version selections remain after reload.

Verification: 40 relevant client tests passed; four desktop/mobile browser tests cover in-place completion, six retained slots, selection of Original, persistence after reload, and refining a previously refined source. Typecheck and targeted lint passed. These tests use explicitly synthetic provider records; no new paid generation was required.

## Launch-readiness cost review (2026-10-20, issue #68)

New refinements no longer bypass the existing estimate dialog. This changes only the client presentation and explicit confirmation boundary; server quote validation, caps, provider configuration, retained request keys and accepted request bodies remain unchanged. Unknown outcomes still use the original-request check/replay flow, never a replacement estimate. Existing originals and version assets are preserved.

Synthetic client regressions cover cancellation by button and Escape, quoted instruction/source/amounts, keyboard review, rapid duplicate submissions and confirmation, expired quotes, unknown-outcome recovery and previous-version retention. Browser scenarios are updated to require review before admission; no live-provider acceptance is claimed.
