# Naming lease expiry on the shared worker pool

> Historical: retired by the November 2026 Naming generation rebuild (docs/naming-generation-contract.md).

## Problem

Every shared worker job holds a lease that it renews while it works. When a
worker stops (crash, restart, a sleeping machine), the lease expires. The shared
Strategy lane has an `expire` action for that case, and the older per-account
Naming worker ran `expire_naming_brain_leases`. The shared Naming lane had
neither, so an interrupted Naming job stayed `running` forever: the project kept
showing "Exploring your next names…", More names stayed blocked and the $5 hold
never resolved.

## Behavior

`supabase/candidates/shared_naming_lease_expiry.sql` adds the slot-level action
`expire` to `public.shared_naming_worker_action`, and the shared Naming engine
calls it before each claim. For at most 20 jobs admitted to that slot's
deployment and policy, in `running` or `cancel_requested` with an expired lease:

| Situation | Result |
| --- | --- |
| A brainstorm call that may have reached the provider (not completed or rejected, or completed but unpublished) | `needs_reconciliation`, `provider_outcome_unknown`; execution parked for observation; hold stays open |
| No call yet, Stop requested, project paused or run superseded | `cancelled`; zero-spend hold settled |
| No unresolved call, attempts left | `queued`; the next claim continues, publishes or finishes it |
| No call and no attempts left | `failed`; zero-spend hold settled |
| Earlier multi-stage pipeline with any step or call | `needs_reconciliation` |

It never creates, resumes or dispatches a provider request and never settles a
possibly paid one. The expired lease already fences a delayed old handler.

## Release

1. Drain the shared lanes.
2. Apply the packet (it accepts only the two reviewed gateway versions after
   delivery recovery, with or without the event-capacity correction).
3. Release the worker build whose authority manifest pins it.

## Rollback

Drain the shared lanes, run `supabase/operator/rollback_naming_lease_expiry.sql`,
then restore the previous worker artifact. The rollback checks the exact
function hashes, removes only the `expire` branch and function, and confirms the
gateway returns to its exact previous hash. Job states already moved by expiry
are truthful outcomes and stay as they are.
