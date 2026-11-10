> Archived November 10, 2026: describes the system before the generation engine.

> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../architecture-review.md).

# One-shot observation after a stopped test exhausted recovery

> Historical: retired by the November 2026 Naming generation rebuild (docs/naming-generation-contract.md).

After the saved-plan cancellation fix was installed, the user approved one
additional observation of the four provider sessions already issued by the
interrupted synthetic test. No new generation or financial adjustment was
approved.

## Implementation

Migration `20261023161943_naming_observation_recovery_audit.sql` creates a private,
RLS-enabled append-only audit table with no application or worker grants. The
migration itself does not reopen a run.

`scripts/operator/reopen-cancelled-naming-observation.sql` is an operator-only
transaction block, not a publicly callable RPC. Its transaction-local request
must identify the exact owner, project, job and run, the expected SHA-256 of all
four immutable authorized calls, and an external approval reference. It refuses
active leases, missing cancellation, changed scope/calls, known final cost,
overrun, missing held reservation, non-observation mode, or any attempt to repeat
a previously recorded recovery.

The block records the prior observation counters/deadline/revision and job
status/accounting summary before allowing one more claim: the attempt counter
moves from 12 to 11 and the next claim increments it back to 12. The new window
is five minutes. The original cancellation, observe-only mode, provider requests,
results and all financial records remain unchanged. It neither creates provider
sessions nor calls a provider. Existing worker and database gates still prohibit
new paid work on the cancelled run.

## Verification and outcome

Two local PGlite tests passed using real restricted worker claims and SQL gates:
unchanged job/call/receipt/reservation records at reopening; retained original
history; exactly one eligible claim; new-dispatch refusal; duplicate recovery
refusal; immutable audit; no anon/authenticated/service-role audit access; and
rejection of altered calls, owner or cancellation state.

The approved live recovery committed on October 23 at 16:24:45 UTC. The existing
worker observed all four retained sessions and finalized the job as `cancelled`.
One provider turn was cancelled and three had completed. The authorized-call
count and digest stayed identical, establishing no additional generation
allocation. This is actual cancellation-recovery evidence, not a successful
100-name creation test.

The run's confirmed actual cost is still NULL and its US$5 reservation remains
active. Terminal execution does not establish final invoice charges. This
recovery does not supply missing financial evidence, invent a refund, authorize
another run, or convert that historical hold into a provider spending cap.
