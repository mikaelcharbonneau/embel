# Database migration records

The handoff below is the **October 13, 2026 historical checkpoint**. Its
"unapplied" labels describe that checkpoint, not the current database. The shared
runtime, including advanced Logo operations, has since shipped; see
[shared worker authority](shared-worker-pool.md) and
[the visual identity release record](visual-identity-release-20261030.md).

For current work, compare the target's actual migration history, installed
function bodies and the compiled `worker/shared-pool/authority-manifest.json`.
The production composer prepares only missing reviewed forward packets.
Preserve historical files and their exact predecessors; do not apply both a
candidate and its promoted migration, or treat every candidate as pending.

## Historical database and vector-proposal handoff

The authorized 2026-10-13 database rollout applied eight changes for the integrated application release. See the [exact source-to-hosted migration mapping and verification](database-rollout-20261013.md). The three promoted candidates now have byte-identical versioned migrations; do not apply both copies. The vector-proposal candidates below remain separate and unapplied.

This source upload does not apply SQL or activate a provider. Historical source filenames are not proof of hosted history. Reconcile the authorized target’s actual migration history before any rollout; do not blindly run a migration push or repair old version mappings. Use the existing reviewed Supabase CLI `migration new` process when the CLI and a separately authorized environment are available. No CLI was available while this vector-proposal bundle was assembled, so no dated migration was invented.

## New unapplied vector-proposal candidates

Apply each exact candidate once, in this predecessor order, only after separate review and authorization:

1. `supabase/candidates/logo-vector-proposals.sql`
2. `supabase/candidates/logo-vector-proposal-quotes.sql`
3. `supabase/candidates/logo-vector-proposal-admission.sql`
4. `supabase/candidates/logo-vector-proposal-observations.sql` (accepted v2)
5. `supabase/candidates/logo-vector-proposal-completion.sql`
6. `supabase/candidates/logo-vector-proposal-materialization.sql`
7. `supabase/candidates/logo-vector-proposal-capabilities.sql`

All 28 function-body predecessor guards were independently checked against the ordered local chain. Preserve those exact guards, OIDs, ACLs, transaction boundaries and historical migrations. Other candidates and activation templates are separate work; their presence is not an instruction to apply them.

The optional proposal operation remains disabled without an independently qualified policy, explicit configuration and approved provider route. The text worker receives no vector/font storage capability. Ordinary web UI setup must not install worker grants, provision credentials, apply migrations or authorize paid inference.

See the [approved logo/identity specification](superpowers/specs/2026-10-06-fluid-logo-visual-identity-approved.md), [bounded refinement plan](superpowers/plans/2026-10-08-vector-refinement.md) and [current verification limits](verification-status.md).

## November 2 forward recovery packet

`supabase/candidates/shared_naming_brainstorm_delivery_recovery.sql` follows the
installed brainstorm and event-capacity packets. It publishes verified retained
names without settling unknown provider costs. Use the coordinated worker drain,
compatibility checks and rollback in [Naming recovery](naming-delivery-recovery.md)
and [the rollout procedure](review-fixes-rollout-20261102.md). Historical migration
files remain unchanged.

## November 7 Naming lease expiry packet

`supabase/candidates/shared_naming_lease_expiry.sql` follows the delivery
recovery packet. It adds the shared Naming slot action `expire`, which moves a
job whose worker stopped out of `running` instead of leaving it there
indefinitely. A possibly dispatched call becomes `needs_reconciliation` with its
hold kept; work with no dispatch evidence returns to the queue or ends with a
zero-spend settlement. See [Naming lease expiry](naming-lease-expiry.md). Apply
the packet before the worker build that calls `expire`.

## November 8 Naming generation packet

`supabase/candidates/shared_naming_generation.sql` follows
`shared_naming_brainstorm_continuation.sql`. It adds the Naming generation run
functions (`start_naming_run`, `get_naming_generation`, `stop_naming_run`,
`get_naming_usage`), the `naming_rounds` table, and replaces the Naming lane
gateway `shared_naming_worker_action` in place. It also leaves runs out of the
old batch list and drops the previous engine's feed-counter triggers. Apply it
with the worker build that uses the new Naming lane. See
[the generation contract](naming-generation-contract.md).

## November 9 Naming cleanup packet

`supabase/candidates/shared_naming_cleanup.sql` follows
`shared_naming_generation.sql`. It removes the retired Naming engines: about 157
database functions and 35 private tables. It first rewrites fifteen shared
functions that still referred to them, each guarded by its reviewed predecessor
body, then ends old Naming jobs that were still open (releasing their internal
usage holds, keeping the job rows) and removes the names those engines generated,
with their likes, selections and screening records. Names people added
themselves and names from the new generation path stay. A final check fails the
packet if any remaining function still names a removed object.

