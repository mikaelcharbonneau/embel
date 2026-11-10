> Archived November 10, 2026: describes the system before the generation engine.

# Product reliability

## Current status, November 2, 2026

The owner completed the signed-in main journey on October 30, including selecting
Northline Direction 3 and opening its downloaded brand package. The later
[visual identity release record](visual-identity-release-20261030.md) supersedes
the pending selection/download status in the earlier checkpoints below.

The November 2 review identified stalled save acknowledgements, Logo draft-cache
exhaustion, missing automatic saves, unfair Naming recovery paging, retained
Naming output that was not delivered, limited font coverage and vulnerable
runtime dependencies. Corrections are implemented with focused regression coverage. The integrated
release is undergoing final checks; source status is not a deployment or live
acceptance claim. See [the coordinated rollout](review-fixes-rollout-20261102.md).

The user selected broad multilingual support for finished assets. The supported
scripts and remaining character limits are documented in the repository README.
Preserve the current visual style while improving reliability and clarity.

## Product priority

The product helps people turn a product idea into usable branding. The user
confirmed on October 29, 2026 that Embel has no customers yet. Reliability comes
first, followed by a consistent, professional interface. The subsequent rules
review permits broader redesign, deliberate cleanup of existing disposable test
projects/outputs, publication of tested fixes and focused real AI tests within
requested work. Follow [the current working agreement](../../AGENTS.md).

## Historical October 29 findings

| Finding | Action |
| --- | --- |
| A recent six-concept Logo request saved four concepts; two remained uncertain despite retained provider receipts. One also had a verified staged image. | Repair confirmation handling and distinguish prevention from recovery of existing requests. |
| A failed acknowledgement of a saved Logo provider receipt discards the generated image before publication. | Replay the exact idempotent receipt once, retaining the image and rejecting invalid acknowledgements. Never repeat generation to retry this save. |
| Shared Storage rejects the documented legacy duplicate-upload response. | Recognize that precise response while preserving create-only uploads and exact owned-byte verification. The live logs do not establish which response-body format was returned. |
| Reviewed older projects can lose their Naming continuation. Selecting a name in the integrated interview closes Naming before screening. | Restore the continuation and keep the selected-name screen available. |
| Four source modules have no application callers; some onboarding instructions describe replaced interfaces or worker builds. | This first change removes those modules and their exclusive tests and corrects the instructions. Further cleanup may retire older readers once their callers and disposable data dependencies are handled. |

Read-only hosted evidence establishes retained records, not the cause of the
original delivery failures. Local reproductions establish the confirmation and
duplicate-response defects. They do not establish live acceptance, output
quality or capacity for thousands of users.

## Verification of this change

- 2,123 client, project-handoff, database-adversarial and Strategy metadata tests
  passed across 190 files.
- 231 relevant worker, Logo server and domain tests passed across 22 files.
  An outdated authenticated Storage download fixture caused four initial
  failures; correcting that fixture made all five tests in that file pass.
- 14 production-build browser checks passed on desktop and mobile, covering
  guided Strategy, both Naming navigation repairs, retained Logo results and
  recovery of an uncertain request admission.
- Typecheck, production web build and isolated shared-worker build passed.
  Lint passed with one existing unused-variable warning in an unrelated test.
- An independent source review found no actionable issues in the retry,
  Storage verification and documentation changes.

These checks used disposable local databases and synthetic provider responses.
The complete repository test suite was not run to completion.

## Generation behavior

Logo concepts, preview refinements, Identity directions and vector suggestions
now place their estimate beside a single Generate action. Quotes are prepared
without dispatching paid work. Changes to saved inputs invalidate the quote;
uncertain requests retain their original identity for recovery. An unavailable
estimate is stated honestly. Applying a vector suggestion and accepting a final
logo remain deliberate, separate actions.

Shared Logo concepts and preview refinements use an uncapped contract. Estimates
do not reserve funds or stop generation; actual provider usage is recorded once.
Existing capped job formats remain readable for historical work. Other current
shared paid operations already use uncapped policies.

Combined verification passed typecheck, production build and lint (one existing
unused-variable warning). The UI changes passed 911 client/feature tests and 74
production-build desktop/mobile browser checks. Backend verification passed 157
focused tests, five shared-engine tests and 111 native PostgreSQL checks. A final
integration run passed 84 focused tests. Independent reviews found no blocking
issues. These test groups overlap and should not be added into one total.

Deployment requires the compatible worker, two updated raster policies and
[the forward SQL packet](../../supabase/candidates/shared_logo_raster_uncapped.sql).
Drain all shared lanes before changing database authority. Existing unadmitted
quotes become stale; existing uncertain jobs are not repaired by this change.
After SQL installation, retain the compatible worker when stopping admissions;
rolling back only the worker would fail its database compatibility checks.

## Hosted verification, October 30, 2026 UTC

The first reliability worker release used source `ed9fe91`, deployment
`dpl_2oMyT2u47nVF4vmskZiryzVmXmQv`. A disposable Northline project completed all
six concepts: six successful jobs, six committed PNGs with matching saved byte
checks, six provider receipts and six saved previews. Replaying the same
admission returned the original batch. A fresh database read confirmed the
results persisted. Recorded provider usage totaled 85,835 microUSD (about
US$0.086); this is application-recorded usage, not invoice settlement.

The test called the same public database operations under the existing owner's
account scope. It exercised the real worker, provider and Storage path. It did
not test browser sign-in, customer HTTP downloads or visual output quality.

The coordinated generation release is live at `https://www.embel.xyz`, using
source `11a7e3a98a117f9a2ef1c3124332be8a564002e4`:

- Web: `dpl_7vV4fpdatRQvt6YiYuqRW9kRwAmH`.
- Shared worker: `dpl_EkEc31HfzEGFtgSrAf2VH7o3cEau`, artifact
  `1abf7cf4573112f995388f22c3568de26092fa13a6ad55a9e60d346df3053cf3`.
- Forward SQL packet SHA256:
  `91d7ab31e7da04c3f7edd82b924f2330d425f55aea9126453482094c6c280798`.

All three worker lanes became ready after the update. The Naming owner binding
advanced to revision 6. Production aliases point to the released web build;
public liveness/readiness returned 200 and the unauthenticated session route
returned 401. That release's health response labeled its revision `unknown`;
deployment metadata established the source revision above. The recovery release
below fixes that label.

A second six-concept request used the new uncapped contract and saved all six
previews, recording 85,835 microUSD. One uncapped refinement of a concept saved
under the previous contract also succeeded, recording 22,702 microUSD. Exact
request replays returned the original jobs. The seven new jobs reserved and
captured zero funds; recorded usage matched their retained provider receipts.
The six-concept estimate was 87,600 microUSD; the refinement estimate remained
honestly unavailable.

Across both tests, all 13 image jobs succeeded with committed, verified PNGs and
persisted previews. Total recorded usage was 194,372 microUSD (about US$0.194).
The disposable project is `b0c19fc2-d24b-4b79-8082-40d79fb1ffaa` (Northline).
No existing projects were deleted. At that point, the two previously uncertain
jobs remained unresolved; their recovery is recorded below. On October 30, 2026,
the user confirmed
that the saved logos appear in their signed-in Northline project. This confirms
preview visibility; it does not establish the remaining approval/export journey.

One saved concept was selected in this disposable project and converted with
the real VTracer worker. The job succeeded at zero provider cost, retained its
original source and produced a verified canonical document and SVG. A fresh
owner-scoped read resolved both committed assets and the vector-history entry.
The vector correctly remains review-required. Final acceptance, reviewed font
import, Identity directions and customer downloads require the authenticated
web path and were not bypassed with synthetic authorization or file evidence.

The initial website upload omitted five required source files, although a full
checkout built correctly. The corrected Vercel allowlist passed a build from
the actual upload-only file set; credential and build-artifact sentinels remained
excluded. Deployment verification must use that file set as well as the full
checkout.

## Recovery and continuation update

Interrupted concept and preview-refinement delivery can now finish from the
original complete provider receipt and verified saved PNG. When that receipt
exists but no image publication or upload was ever issued, recovery records a
delivery failure instead. It keeps the original usage and permits a deliberate
new request. Recovery never calls the AI provider, invents a refund, changes
current design selections or treats unknown billing as settled evidence.

The resolver preserves original failure details in a private generic recovery
record. Existing job-row formats remain unchanged so historical receipt checks
continue to match. Cancellations, deleted projects, mismatched evidence and
database contention do not publish a result. Install the compatible
[forward packet](../../supabase/candidates/shared_logo_raster_recovery.sql) with
shared lanes drained, then deploy its regenerated worker manifest. Public
gateway proofs and provider policies are unchanged.

The interface now refreshes generation inputs after a project font is added,
offers a verified retry for failed variant previews, and links approved vectors
directly to Identity directions. Missing-image delivery failures explain how to
continue while retaining usage. The health revision reader also handles the
empty Vercel revision variable used by source-upload deployments.

Local verification passed 382 feature tests, 59 focused recovery/authority tests,
116 native PostgreSQL checks including concurrent locks, and 16 desktop/mobile
production-build browser cases. Recovery tests use synthetic Auth/Storage/provider
evidence and confirm zero provider calls. These are not live customer acceptance.
The independent review's job-row compatibility finding was corrected before
release. The integrated source also passed 94 focused tests, typecheck and lint
(one existing warning), plus a production build from the actual upload file set.
Test groups overlap and should not be summed.

The update is live at `https://www.embel.xyz`, source
`a0e1e1602947b2dc02f13f26bd81bbc83c2f89da`:

- Web: `dpl_HurUbjDDpnbep1fdCFxTXbehU8tc`.
- Shared worker: `dpl_5UW99NSFi8fiftFEUNJHmBgYQKbp`, artifact
  `15b59ab2314beeba5aed07fff805468b740cc05e174a3fdb573586e32a052315`.
- Forward packet SHA256:
  `d70df635c40735a584916af4f63c0a11553017fc05a9b1a3d2599da79b077ac2`.

All 273 installed function bodies match the compiled worker authority manifest.
All three lanes are ready; the existing Naming owner binding advanced to
revision 7. Production aliases point to this web deployment. Health and core
readiness return 200 with the exact source revision; unauthenticated session
access returns 401. The packaged native runtime smoke passed all seven checks.

The real original batch `1146a4d2-a588-4805-a7e8-37ca4e5fb633`, in project
`9843ef50-fbf7-4d70-abea-796f1b95ca78`, now has five successful saved concepts
and one explicit `logo_image_unavailable` delivery failure. Recovery committed
the existing staged PNG for job `8e30674d-90f4-4d03-a1bf-f36d0660909b` and
closed job `c47f2d5a-797a-4a11-9547-efd6cd2654f2` without an image. Both
executions are closed and their reservations settled. The six original provider
receipts and total recorded usage of 87,395 microUSD are unchanged: recovery made
no new provider request and recorded no new charge.

A fresh owner-scoped public application read returns the original request as
partial with five saved outputs and recorded billing. Preparing a quote for
only the failed slot succeeds under the uncapped policy, with an informational
estimate of 14,600 microUSD. That quote was not admitted; no replacement image
was generated. No projects or existing outputs were deleted. Final readback
found no unfinished shared executions or pending jobs and no new worker errors.
This checkpoint established live backend acceptance. Signed-in selection and
download were subsequently accepted by the owner on October 30, as recorded in
[the later release](visual-identity-release-20261030.md).

## Continuing verification

1. Recheck affected desktop/mobile journeys and failure recovery for each release.
   The October 30 owner acceptance is evidence for that release, not a substitute
   for testing later changes or broader languages.
2. Deliver verified retained results while keeping uncertain provider outcomes
   and costs explicit. Never repeat a possibly completed paid request.
3. Keep measured account isolation, cancellation and recovery coverage. Capacity
   for thousands of users has not been established.
4. Retire older execution paths after handling their callers and data dependencies.
   Existing projects/outputs are disposable test data; report deliberate resets.

Current authorization comes from [AGENTS.md](../../AGENTS.md), including its scope
for existing services and test data. This work does not certify the whole product
as ready for launch.
