# Product reliability

## Current priority

The product helps people turn a product idea into usable branding. The user
confirmed on October 29, 2026 that Embel has no customers yet. Reliability comes
first, followed by a consistent, professional interface. The subsequent rules
review permits broader redesign, deliberate cleanup of existing disposable test
projects/outputs, publication of tested fixes and focused real AI tests within
requested work. Follow [the current working agreement](../AGENTS.md).

## Confirmed findings

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
[the forward SQL packet](../supabase/candidates/shared_logo_raster_uncapped.sql).
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

The initial website upload omitted five required source files, although a full
checkout built correctly. The corrected Vercel allowlist passed a build from
the actual upload-only file set; credential and build-artifact sentinels remained
excluded. Deployment verification must use that file set as well as the full
checkout.

## Remaining work, in order

1. Complete the coordinated uncapped-generation release and verify a real
   request plus saved results. Confirm the signed-in browser journey separately
   from the successful backend acceptance above.
2. Make interrupted requests recover reliably without duplicate paid calls.
   Current shared recovery verifies saved files but leaves ambiguous concept
   steps unresolved; only exports have a completion resolver. Choose a maintainable
   recovery design and verify actual saved image bytes. Existing test requests
   may instead be retired deliberately; that does not establish future recovery.
3. Verify one complete journey: idea → Strategy → Naming → six logo concepts →
   selection → Identity → usable downloads. Include reload, cancellation,
   interrupted saves and a second account. Record local and live results
   separately.
4. Improve the broader desktop/mobile journey with the newly permitted design
   freedom. Check empty, loading, partial-result and recovery states together.
5. Retire older execution paths after handling their callers and data dependencies.
   Existing Embel projects/outputs are disposable test data; report deliberate
   resets. Establish measured concurrency and recovery before claiming capacity.

Current authorization comes from [AGENTS.md](../AGENTS.md), including its scope
for existing services and test data. This work does not certify the whole product
as ready for launch.
