# Ongoing account AI testing

The confirmed test account exhausted its one-response allowance on 2026-10-14. All three attempt counters (owner, cohort and rollout) had reached one, and each committed-cost allowance had been consumed. The successful response cost 1,858 microdollars; refunded unused reservations do not restore a consumed trial attempt.

The user explicitly requested ongoing testing without a cap. The replacement is private, operator-granted testing access for an existing entitled account. It has no lifetime request limit, aggregate model-spending ceiling or expiry. This is an authorization mode, not a large numeric credit balance, periodic refill or reset of trial history.

Testing covers the existing enabled brief-response operation, `strategy.reformulate`. Each request retains the pinned model and input/output limits, its 122,880-microdollar maximum reservation, one active request, exact authenticated project ownership, immutable dispatch identity and lease fencing. Unknown provider outcomes still block further paid requests until reconciled. No automatic repeat provider call is authorized by retrying or replaying a request.

Ordinary accounts retain their existing allowances and expiry. Signup enrollment stays closed. Naming, research, images and other unconfigured operations retain their independent readiness and permission checks. An authenticated client cannot grant itself testing access.

Each testing job records its authorization separately from the consumed trial counters. Actual and provider-observed costs still accumulate in the existing usage ledger. Disabling the testing grant, entitlement, cohort, rollout, binding or runtime stops new paid work. Already-admitted work retains the frozen worker authorization required for cancellation and settlement; withdrawal never deletes historical jobs, results or usage.

Production activation and verification are recorded outside the checkout in `/workspace/scratch/embel-unlimited-testing-20261014/`. Local database fixtures are separate from hosted availability and real provider acceptance. The existing application and worker deployment inputs are unchanged by this database repair.

## Installed and activated — 2026-10-14

The source migration is `20261014142522_api_text_unlimited_testing.sql`; Supabase recorded its identical submitted SQL as version `20261014145143`, name `api_text_unlimited_testing`. Ten existing function bodies match their reviewed replacements, with unchanged owners, signatures, security settings and execution grants. Three new private tables enforce RLS and deny client, service-role and worker access; four new private helpers likewise deny direct execution.

Only the approved existing account was enabled. Hosted availability reports `strategy.reformulate` available after the consumed trial. Actual owned admission, its reservation, immutable authorization marker and exact idempotent replay passed inside a rolled-back subtransaction: no rehearsal job, queue message or provider call survives. Original trial counters and actual usage remain unchanged. The existing protected Preview diagnostic reaches the production worker through its signed Vercel workload and reports the exact qualified reformulation operation. That probe does not establish a newly generated model response.

All 23 focused PGlite checks pass, covering repeated requests after exhausted quotas and expiry, accumulated usage beyond the old monetary ceiling, explicit withdrawal, exact gateway scope, isolation, ambiguity and settlement. Initial fixture/workflow timing failures are retained in the receipt; the clean rerun uses bounded setup and workflow deadlines. PGlite is not proof of native PostgreSQL concurrency. The hosted admission/replay rehearsal is separate native database evidence.

The 903 application inputs retain production's canonical manifest SHA-256 `6acdbc4f6e81793f51be48a2fda22e32fbae0fc5d4e027d82e5ebbb36abae4a9`. Production continues to serve the existing verified web and worker releases; this repair requires no application rebuild or deployment change. Both projects remain in the Embel team with Vercel Authentication for all deployments.
