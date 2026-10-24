# Naming safety and UI fixes — 2026-10-24

This is a reviewable, undeployed fix. AI generation remains unavailable because
no enforceable provider-supported US$5 managed-Agents cap was established. See
[native cap evidence and architecture options](naming-provider-budget-compatibility-20261024.md).
No paid call, production deployment, database mutation, account/credential change
or historical hold adjustment was performed.

## Verified base and isolation

GitHub repository `mikaelcharbonneau/embel`, ID `1410624483`, was checked through
the connected repository API and the Mac checkout's exact origin. The branch
starts at current main `75df99a920149b9c63a70625ba62b8594e9b5a27` (PR 144).
The original `/Users/mikael/embel` dirty work and other worktrees were preserved.
The final worktree is `/tmp/embel-naming-review-20261024`. The initial Documents
worktree was preserved when iCloud repeatedly evicted regular source files into
dataless placeholders; all reviewed changes were transferred, and the one evicted
edited controller was reconstructed using its exact captured patch.

## Root causes and behavior

- The real pinned SDK sends `/v1/agents/sessions` with `agents=v1`; its declared
  `spend_control` is rejected by the supplied production evidence. Types and
  nullable usage do not establish enforcement or final cost. Web admission now
  refuses the known incompatibility before the admission RPC, with no new job
  or reservation. Independent default-adapter checks block creation and paid
  tool-result continuation. Issued-session reads/cancellation remain available.
- Stage evidence retained generic request rejection while the UI emphasized
  incomplete fulfillment. Safe fixed configuration classifications now persist
  in the existing stage evidence and are projected with owner/project/job checks.
  Reload shows an actionable blocker and status check, without generation Retry
  or a misleading 0-of-100 progress claim. Existing holds remain unsettled.
- Final preferences Continue could collide with a polling feed-read lock. Start
  now waits for that read, rechecks current account/visibility/eligibility, then
  reads a fresh authoritative head before the same idempotent admission. Polls
  and reloads alone do not start generation.
- The topbar Projects breadcrumb was a span. It is now a real keyboard-operable
  route link. The sidebar Projects link already worked in the local reproduction;
  both controls passed from Naming screening.

Manual add/select, reload, focus account re-verification, navigation/reopen and
layout bounds passed with synthetic desktop/mobile APIs. No supplied production
project was used for testing. Historical immutable requests, original model,
allocations, unknown-call quarantine, ownership and accounting were retained.
A server-qualified saved-membership continuation still works without a new job
or reservation; it does not restart paid work.

## Validation

- Production web build, typecheck, repository lint and Naming worker bundle passed.
- Four production-build browser checks passed on desktop/mobile using dedicated
  headless Chrome and intercepted account APIs.
- SQL regressions prove repeated blocked starts leave jobs/runs/reservations
  unchanged; safe configuration errors survive repeated reads; the old US$5 hold
  and null confirmed cost remain unchanged; saved membership continues for free.
- Provider adapter tests prove zero real HTTP creation/continuation, with existing
  retrieval/cancellation still usable. Historical SDK/SQL fixtures explicitly
  model provider capability and use synthetic HTTP.
- Final affected Naming regressions: **168 tests / 12 suites passed** on the
  finished code. This includes the corrected route, historical SDK/timing,
  provider boundary, SQL admission/accounting and UI suites.
- The broad standard sweep completed with 10,982 passing tests, 24 skipped and
  31 failures while implementation/fixture updates were still in progress. All
  30 Naming failures were superseded by the final affected-suite pass above.
  The remaining failure is unchanged `tests/worker/openai-strategy.test.ts:60`
  (`needs_reconciliation` expected, `failed` received). It reproduces in a
  separate untouched-main worktree at `75df99a` (7 passed / 1 failed). No Strategy
  source/test fix is included, and a clean full-standard-suite pass is not claimed.

Initial source commit: `66cc62956d58390309ed1d5d24fa865fbe522ec0`.
Draft PR: https://github.com/mikaelcharbonneau/embel/pull/145.
The initial follow-up evidence commit changes this record only.

## Review correction: unavailable continuation of an issued session

Review found that `creation_unavailable` also comes from a refused tool-result
submission. An unconditional catch had incorrectly returned
`rejected_before_dispatch` for an already-issued session, discarding its receipt
and skipping cancellation/observation. That classification now requires no prior
receipt, no invoked create and no session ID. An issued session follows bounded
cancellation and terminal-history observation instead. A cancellation acceptance
without terminal history stays unresolved with its original session/turn/agent
identity and null confirmed cost. Read-only recovery remains GET-only.

The new composition suite uses the actual runtime and its default SDK adapter's
unavailable continuation guard, with synthetic global HTTP and retained pending
tool output. Before the fix, four issued-session cases failed exactly as reported;
three read-only cases passed. After the fix, all seven pass for native/local
profiles, cancellation acceptance versus observed cancellation, and observe-only,
expired and already-aborted recovery. No create or tool-result submission occurs.
The complete affected recovery/pre-dispatch run passed **80 tests / 9 suites**.
Typecheck, lint and both local builds passed for this correction; the unchanged
main Strategy failure above remains outside this patch. No production or paid
call was made.

## Changed files

- `docs/naming-provider-budget-compatibility-20261024.md`
- `services/naming-worker/source-inputs.json`
- `src/components/naming/naming-approach-widgets.tsx`
- `src/components/naming/naming-feed-controller.ts`
- `src/components/naming/naming-feed-results.tsx`
- `src/components/naming/project-naming-workspace.tsx`
- `src/components/workspace/app-shell.tsx`
- `src/domain/naming-brain.ts`
- `src/server/ai/naming-brain/budget-availability.ts`
- `src/server/ai/naming-brain/protocol.ts`
- `src/server/ai/naming-brain/transport.ts`
- `src/server/data/naming-brain.ts`
- `tests/api/naming-brain.test.ts`
- `tests/client/naming-feed.test.tsx`
- `tests/client/naming-provider-failure-presentation.test.tsx`
- `tests/database/naming-brain-progressive.test.ts`
- `tests/e2e/naming-safe-handoff.spec.ts`
- `tests/server/naming-brain-protocol.test.ts`
- `tests/server/naming-brain.test.ts`
- `tests/server/naming-brain-unavailable-recovery.test.ts`
- `tests/server/naming-budget-unavailable.test.ts`
- `tests/server/naming-read-availability.test.ts`
- `tests/worker/naming-brain-local-sdk.test.ts`
- `tests/worker/naming-brain-local-timing.test.ts`
- `tests/worker/naming-brain-rejected-dispatch.test.ts`
- `tests/worker/naming-progressive-sdk.test.ts`
- `worker/handlers/naming-brain.ts`

This record is also part of the change. No migrations are included.
