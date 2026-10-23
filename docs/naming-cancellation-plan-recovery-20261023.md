# Naming cancellation plan acknowledgement

## Observed defect

The October 23 synthetic live acceptance attempt was stopped by the test operator
before completion. This interrupted test does not establish whether the full
100-name generation path succeeds. Its four issued provider calls remained
unresolved. Subsequent worker cycles reported `lease_lost` without reading the
saved provider history.

The database claim correctly returned a cancellation-requested, observe-only
job with a fresh lease. `runOneJob` then registers/acknowledges the immutable step
plan before executing recovery. `public.register_job_plan` rejected any state
other than `running` **before** checking whether that same plan was already
registered. Consequently every observation claim failed at the plan boundary,
consuming the bounded observation attempts without reaching provider history.

## Narrow correction

Migration `20261023154915_cancelled_job_plan_replay.sql` moves the identical-plan
acknowledgement ahead of the cancellation guard, but **after** the existing
owner/runtime/lease lock. It changes only that exact predecessor block and fails
closed if the installed definition differs. Existing function OID, owner,
security-definer configuration and ACLs are retained.

- An exact existing plan can be acknowledged without modifying any job row.
- A different plan still conflicts, and a new plan on a stopped job is refused.
- Wrong/expired leases and unauthorized callers still fail.
- Beginning new paid work remains forbidden after Stop.
- Actual terminal provider evidence can complete cancellation; missing evidence
  remains unresolved. Neither outcome fabricates a cost or releases a hold.

The regression matrix exercises the real runner, Naming store, restricted SQL
worker identity and migrated local PGlite database. Provider observations in
those tests are synthetic. They prove recovery control flow, not live provider
completion, native PostgreSQL concurrency or billing settlement.

## Accounting and spending boundary

The active hosted progressive requests carry the `local_unlimited_v1` provider
profile. The retained US$5 reservation is **not an enforced provider spending
cap**, and receipt token/cost observations are provisional, not final invoice
proof. A test with a hard US$5 maximum must not be started on the assumption
that this reservation enforces it. The automatic trigger is submission of the
last preference, so spending constraints must be verified before that action.

This patch does not add a final-cost source, rewrite old usage records, release
reservations, reset observation counters/deadlines, resume stopped jobs or issue
provider calls. Output cancellation and financial reconciliation are distinct.
Existing exhausted runs require a separately reviewed, evidence-preserving
recovery plan; installing this patch does not silently reset their bounds.

## Rollout boundary

This is a database-only correction. Merging source or deploying unchanged web
code does not install it. Live installation requires explicit approval for the
exact migration. No worker replacement, credential change or new grant is
necessary. Verify the installed function definition and unchanged ACLs afterward.
A complete live 100-name acceptance remains outstanding, separately from the
synthetic checks and any unresolved provider charges.

## Verification on this patch

- Original regression failed with `cancel_requested`; after the patch the seven
  immutable-plan tests pass.
- Nine targeted files: 89/89 tests passed, including runner/store/SQL observation,
  unchanged financial holds, cancellation fences and function-catalog scope.
- Broader progressive/SDK-SQL checks: 25/27 passed initially; two existing
  integration cases hit the default 15-second harness timeout. Historical-input
  compatibility passed unchanged in isolation. The 500-record capacity case
  passed unchanged with an explicit 90-second test-only CLI budget. No production
  deadlines or repository test budgets were changed. This is not a single-run
  full-suite pass.
- Final Next.js production build (including TypeScript), full ESLint plus the
  final test-file recheck, and `git diff --check` passed.
- No new live generation, database migration or historical accounting write was
  performed as part of these checks.
