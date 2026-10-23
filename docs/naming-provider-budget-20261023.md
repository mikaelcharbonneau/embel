# Future hosted Naming provider budget

## Status and scope

Prepared for new hosted progressive Naming runs. Not live until the compatible
web and Naming worker are deployed and the migration is explicitly approved and
applied. No paid provider call or credential change is part of local validation.
The earlier cancelled run and its unknown accounting remain untouched.

## Why

The historical `local_unlimited_v1` compatibility profile omits `spend_control`.
Its US$5 reservation is accounting evidence, not an enforced spending limit.
The provider rejected that parameter during earlier qualification. Never retry a
rejected capped request by stripping its cap.

The current [OpenAI session-create reference](https://developers.openai.com/api/reference/python/resources/beta/subresources/agents/subresources/sessions/methods/create)
and pinned OpenAI 7.35.0 types document `spend_control.limit` in USD cents,
with omission/null meaning unlimited. The session response exposes the configured
limit and best-effort consumption. Documentation and synthetic tests do not prove
this account accepts the parameter today or establish final billed cost.

## Implementation

- Only newly admitted hosted jobs receive immutable `providerBudgetVersion: 1`.
  Ordinary local and already-admitted hosted inputs are not rewritten.
- Each new progressive role request freezes `providerSpendCapCents` in its policy,
  hash, outgoing provider body, metadata and receipts. The old local mode marker
  remains an execution compatibility identifier, not a claim of unlimited spend
  when the orthogonal provider cap is present.
- Allocations: Research 25 cents, Director 10, Creator 10, Curator 5, Verifier 10.
  These are conservative maximum allocations, not estimates of actual charges.
- Under the existing run lock, Postgres reserves the full sum of planned session
  caps, refusing more than 500 cents per run. Dispatch independently rechecks the
  sum of issued caps and exact per-role allocation. Parallel planning is serialized.
  A repeated exact plan does not allocate twice; dispatch remains single-use.
- Failed, cheap, unknown or never-issued calls do not replenish the envelope.
  This conservative rule can stop before 100 names; it must not manufacture a
  completion, silently extend the budget or start another run.
- The SDK sends native `spend_control` with retries disabled. Missing/changed caps
  fail locally or fail provider acknowledgement. Unsupported caps fail closed,
  never trigger an unlimited fallback. A lost acknowledgement remains unknown.
- Returned limits must match the immutable request. An observed overrun is retained
  and prevents further capped-run dispatch/publication; it is not final expense.
- Existing cancellation, ownership, leases, unknown-outcome handling, immutable
  requests, original provider sessions and historical reservations are retained.

## Rollout boundary

1. Qualify and merge source with synthetic tests, TypeScript, lint and both builds.
2. Deploy compatible web and Naming worker source first, using the established
   single-worker standby/cutover procedure. Do not overlap readiness publishers.
3. Apply `20261023230404_naming_provider_budget_guard.sql` only with approval.
   It changes future hosted admission and guarded functions, not historical data.
4. Verify actual function definitions/ACLs and the new job witness before any
   approved live test. A new paid test needs its own scope and budget approval.
5. A provider rejection is a blocker, not permission to remove spend_control.
   If native caps are not supported, stop and report the incompatibility.

The US$5 allocation applies to one Naming run, not Strategy, Logo, visual
Direction, Brand Board, hosting fees or additional continuations. Successful
100-name generation and the full branding flow still need separate live evidence.
Final bill settlement remains separate from output completion.

## Local qualification (2026-10-23)

- 643 tests passed across 52 Naming domain/server/worker and hosted-authority files
  with two test workers.
- A separate 10-test run passed: six SDK-plus-SQL progressive scenarios and four
  budget database tests. Synthetic hosted runs reach 100 names and recover exact
  saved plans without recreating issued sessions.
- Budget tests cover a 500-cent planned-allocation boundary, missing/mismatched
  caps, immutable old jobs/requests and preserved function ACLs, single-use dispatch,
  overrun quarantine, blocked publication and nullable actual expense.
- Synthetic HTTP verifies unsupported limits cause one rejected create with no
  unlimited retry. Missing/changed returned caps retain the verified session ID
  so cancellation and subsequent observation remain possible.
- TypeScript, full ESLint, production Next.js build and Naming worker bundle passed.
  Initial unconstrained validation exhausted local memory; final type/build checks
  used a 4-GiB Node heap and the broader tests used two workers. No production
  deadline or repository test timeout was increased. The SDK fixture now returns
  the requested cap for new budgeted sessions while legacy fixtures omit it.
- `git diff --check` passed. No live provider qualification or final-charge evidence
  is claimed by these tests.
