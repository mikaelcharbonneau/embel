> Archived November 10, 2026: describes the system before the generation engine.

> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../architecture-review.md).

# Naming worker lifecycle hardening — 2026-10-20

> Historical: retired by the November 2026 Naming generation rebuild (docs/naming-generation-contract.md).

## Scope and rollout boundary

Issues #49 and #50 are local source corrections. The supplied audit snapshot has
no Git metadata; the integrating lead identifies its starting main revision as
`4e422a51e974745cfa703cae2f9ceb20b7769d5c`. That is a starting-point reference,
not a claim that this snapshot is a clean checkout or that these changes are live.

No provider model, policy, runtime fingerprint, database capability, credential,
accounting rule, historical request or deployment binding changes. No database,
provider, credential-transfer, rollout or policy-activation action is required to
exercise these hermetic tests. The integrating lead owns complete-repository
verification, source publication and any separately authorized live qualification.

## #49: Removed idle clients do not imply failed active work

The cloud worker handles the Pool idle-client error as one operational event:
`cloud_naming_database_idle_client_removed`. The event contains only its fixed
name. Error arguments, attached Client objects, nested causes and connection
parameters are never inspected or serialized. A throwing diagnostic sink cannot
abort a healthy job or prevent cleanup.

[The node-postgres Pool contract](https://node-postgres.com/apis/pool#events)
states that the idle client is terminated and removed automatically. This event
cannot establish the outcome of a separately checked-out query or an issued
provider request. The worker therefore neither aborts its lifetime solely for
this event nor invents a retry. Actual restricted-role/TLS qualification failures,
readiness query failures, lease/heartbeat failures and ambiguous provider outcomes
retain their existing fail-closed behavior. SIGTERM's existing abort signal still
fences dispatch and drives drain/Pool cleanup.

## #50: One readiness report, fenced and drained at stop

Timer and manual callers share one tracked in-flight readiness report. The report
is tracked before its callback runs. If stop begins before that queued callback
starts, the callback is skipped. If it has already started, stop fences future
reports immediately, clears the interval and waits for that tracked report to
settle. Every waiting assertion rechecks the stopped fence before returning,
even when the report finishes successfully.

A false, rejected or synchronously throwing report remains unavailable. Concurrent
waiters do not each start another probe, and timer ticks cannot overlap a manual
probe. A later explicitly requested refresh can recover readiness; there is no
new retry policy. Readiness is still only the paid-dispatch gate: observing
already-issued requests remains independent of fresh paid authorization, so
unknown outcomes remain retained rather than replayed or discarded.

## Regression coverage

- `tests/worker/naming-brain-configuration.test.ts`: deferred-report and fake-timer
  races, manual/timer coalescing in both orders, stopped true/false/rejected late
  results, drain ordering, no report start after stop, and fail-closed recovery.
- `tests/worker/cloud-naming-runtime.test.ts`: repeated secret-bearing idle events
  during healthy work; throwing log sink; actual qualification/readiness failure;
  the real runner's heartbeat-loss and unknown-provider outcomes; shutdown waits
  for manual readiness before closing the Pool; existing TLS/role/standby gates.
- `tests/worker/naming-readiness-observation.test.ts`: the real Naming handler,
  runner, job store and actual readiness gate composed with a synthetic provider.
  Unready/rejected/stopped gates permit retained read-only observation without a
  replacement request; new provider dispatch remains blocked.

All added scenarios use synthetic data and local in-memory dependencies. They
establish source behavior, not live database or provider success. Existing runner,
Naming handler, configuration, authority and package tests remain part of the
integrating lead's wider verification matrix.

## Required before describing the correction as live

Build and qualify the exact merged immutable Naming artifact, verify the expected
source/runtime identity, and use the existing drain/freeze/stop/no-overlap release
procedure in `cloud-naming-worker-20261019.md`. Confirm that only the qualified
replacement is running and that shutdown drains before Pool disposal. Do not
rebind or re-admit historical jobs, reset leases or replay unknown paid requests.
