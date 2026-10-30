# Product reliability

## Current priority

The product helps people turn a product idea into usable branding. The user
confirmed on October 29, 2026 that Embel has no customers yet. Reliability comes
first, followed by a consistent, professional interface. Preserve saved work and
the approved design while fixing broken behavior.

## Confirmed findings

| Finding | Action |
| --- | --- |
| A recent six-concept Logo request saved four concepts; two remained uncertain despite retained provider receipts. One also had a verified staged image. | Repair confirmation handling and distinguish prevention from recovery of existing requests. |
| A failed acknowledgement of a saved Logo provider receipt discards the generated image before publication. | Replay the exact idempotent receipt once, retaining the image and rejecting invalid acknowledgements. Never repeat generation to retry this save. |
| Shared Storage rejects the documented legacy duplicate-upload response. | Recognize that precise response while preserving create-only uploads and exact owned-byte verification. The live logs do not establish which response-body format was returned. |
| Reviewed older projects can lose their Naming continuation. Selecting a name in the integrated interview closes Naming before screening. | Restore the continuation and keep the selected-name screen available. |
| Four source modules have no application callers; some onboarding instructions describe replaced interfaces or worker builds. | Remove only those unused modules and their exclusive tests; correct current instructions. Preserve historical data readers and active compatibility paths. |

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
The complete repository test suite was not run to completion. No provider was
charged, saved hosted record changed, or deployment performed by this change.

## Remaining work, in order

1. Release and verify the bounded fixes in this change. Confirm a complete
   six-concept request and reload through the real app, with separately
   authorized provider use.
2. Complete recovery of an existing verified staged concept. Current shared
   recovery verifies saved files but leaves ambiguous concept steps unresolved;
   only exports have a completion resolver. Extend that existing path with
   exact provider, ownership, image and billing evidence and an immutable
   recovery record. Do not add another incident-specific repair script or mark
   an outcome successful from metadata alone. A receipt without saved image
   bytes is insufficient to recover the missing image.
3. Verify one complete journey: idea → Strategy → Naming → six logo concepts →
   selection → Identity → usable downloads. Include reload, cancellation,
   interrupted saves and a second account. Record local and live results
   separately.
4. Review that journey on desktop and mobile, fixing inconsistent controls,
   error recovery and inaccessible layouts against the approved design.
5. Retire older execution paths only after confirming their remaining callers
   and saved-data requirements. Establish measured concurrency and failure
   recovery before claiming launch capacity.

These are implementation priorities, not approval for deployment, paid requests,
new services or changes to saved production records. This work does not certify
the whole product as ready for launch.
