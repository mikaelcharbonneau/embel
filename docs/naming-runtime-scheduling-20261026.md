# Naming runtime scheduling and authority — phase two, source only

This isolated change starts from remote main
`56efd115c67baab57c478c60cb186e2bd7e321f6` plus the exact 22 frozen
phase-one receipt/index files. The full 2,329-file baseline identity is
`521690e742b3bf6a2b9429f3ee733f87e0ea2fcacc1affb1e14fa8da9627f233`.
The database specialist owns the new authority/lock migration and its tests;
this component owns the hosted Naming scheduler, authority controller and
explicit store integration. This is local source/test work. Naming remains
paused; no production access, provider calls, deployment or activation occurred.

## Schedules and their real latency tradeoff

The hosted daemon has one preference/expiry lane and one job runner. Preference
scans and bounded expiry run every 15 seconds, measured from RPC completion.
They never overlap each other, including during a long provider job. Authority
renewal remains independent and coalesced with manual dispatch checks. The
database connection pool remains two; provider/handler concurrency is unchanged.

Empty claims wait 1, 2, 4, then at most 5 seconds. For an already queued job under
stable authority after bootstrap, this preserves the former five-second polling
bound, excluding query duration, contention and outages. Completed jobs can
proceed immediately; lease loss and rejected claims back off instead of spinning.
The scheduler does not retry any provider request or reinterpret an unknown create.

**Preference-to-admission latency is different.** Saving preferences creates a
new version. The server verifies that exact saved version before admission
(`src/server/data/naming-brain.ts:99`), and SQL requires a matching worker
attestation (`20261016180000_naming_brain.sql:671`). An absent attestation returns
`preferences_validation_pending`, rather than admitting an unvalidated run.
A save just after an empty scan can now wait nearly 15 seconds for its next
validation pass, versus roughly five seconds in the former idle loop, plus work
and query duration. A fake-clock real-store-adapter test saves at 1 ms and
acknowledges attestation at 15,000 ms. The queued-job pickup claim does not cover
this earlier readiness delay. No UI success or attestation is fabricated.

First acquisition and every new generation perform a preference pass before
claims. A failed pass still permits fenced recovery claims; it does not certify
preferences or allow SQL admission to skip validation. Late completion of a
previous generation's pass cannot release the new generation's claim lane.
Preference work batches retain their original generation across every attestation;
a changed generation discards that batch rather than replaying it under new authority.

Expected steady empty minute after startup, before actual work:

| RPC | Previous | New |
|---|---:|---:|
| Claim | 12 | 12 |
| Preference scan | 12 | 4 |
| Expiry | 12 | 4 |
| Readiness / authority status | 3 | 3 |
| Total | 39 | 23 |

These are whole RPC counts, not physical disk I/O. A preference scan may return
up to 20 actual attestations, each counted separately. Paid-dispatch status
checks, continuation gateways, heartbeats and evidence writes are also separate.
A follower makes three status attempts per steady minute and no maintenance or
claim calls. The resolved phase-one claim does not contain nested expiry; this
change removes the runtime's every-cycle maintenance cadence, not a hidden
second expiry call inside claim.

## Explicit hosted authority contract

`report_naming_brain_worker_status(policy,deployment,worker,generation|null,60)`
returns `version:1`, `leader`, `generation|null`, `expiresAt|null`, `serverTime`,
`ready` and `reason`. Maintenance leadership can remain valid when paid readiness
is false. Null generation acquires a vacant/expired epoch or reads the same
worker's existing epoch after a lost acknowledgment, without extending it.
Renewal requires the exact unexpired generation. Healthy competitors remain
followers. Readiness false alone does not cancel known-session observation.

The client anchors `expiresAt - serverTime` at the **request start** on a
monotonic clock and deducts one second. It does not extend a delayed or nearly
expired response to a fresh minute, and wallclock skew cannot extend its cache.
One in-flight status query is shared by scheduled and manual checks. A failed,
malformed or expired response suppresses new work immediately. This cache never
grants database authority: every mutation rechecks under the SQL mutation locks.

Configured hosted stores route preference work, attestation, expiry, claim and
`assert_continue{jobId,leaseToken}` through
`naming_brain_worker_maintenance_v2(worker,deployment,generation,action,payload)`.
The gateway receives no client owner ID. A claim establishes the trusted job/lease
generation sidecar. Heartbeat and resume do not rewrite it. Thus reacquiring the
same worker ID under a new generation cannot revive paid authority for an old
lease. New creates retain their existing authoritative dispatch gate; required
action/tool-result POSTs use the continuation gateway before resuming paid model
execution. The existing transport checks continuation before reading and again
before submitting the durable tool result.

The versioned continuation check retains its authoritative heartbeat, then checks
the gateway. This adds one gateway RPC to each allowed continuation assertion;
a denied assertion refreshes heartbeat once more to detect a Stop that won
between checks. These work-dependent calls are outside the idle 23-RPC budget.
Only the specific `NamingContinuationUnavailableError` selects bounded GET-only
observation without automatic provider cancellation. Explicit Stop/abort,
deadline expiry, ordinary persistence failures and provider errors keep their
existing best-effort cancellation. A cancellation acknowledgment is never treated
as proof of a cancelled terminal provider outcome.

Existing job-lease receipt, provider-item, tool-evidence and terminal settlement
methods do not gain a blanket generation check. Supported known-session GET
observation, cancellation evidence and unknown-cost holds remain recoverable.
Historical capped and uncapped request bodies, hashes and accounting are retained;
no monetary limits or provider-policy changes are introduced.

## Outages, lifecycle and compatibility

Each polling operation backs off independently from about one second to one
minute with bounded 80–100% jitter. Authority failure suppresses other hosted
polling until a valid response. At maximum jitter, continuous status failure
attempts seven queries in 120 seconds; repeated manual assertions cannot bypass
that backoff. After a slow RPC, deadlines start at completion, with no catch-up
burst. Diagnostic events contain fixed operation names and no private exceptions.

Abort fences the authority snapshot synchronously, wakes all waits, prevents new
maintenance/claims, and drains existing status/maintenance/job promises before
closing the pool once. Existing job cancellation and 15-second abort grace remain.
Initial native TLS/role verification and read-only preflight/standby keep their
existing fail-fast qualification behavior. The qualified-runtime outage budget
does not quantify the hosting platform's process restart policy.

The optional store authority callback is **explicit**: omitted callbacks retain
the supported legacy adapter signatures. They do not silently acquire v2 authority.
The new hosted runtime requires the new SQL functions; missing/invalid interfaces
fail closed without legacy fallback. After v2 enrollment, old maintenance writers
are fenced by SQL. A stopped schema/worker cutover is mandatory; this is not a
rolling compatibility claim. Historical saved jobs remain data to recover through
matching supported handlers, not permission to run an old unfenced binary.

The SQL specialist documents and tests the lock order: positive work and takeover
take owner/account before leadership and the existing job/run locks; healthy
renewal uses short control-row locks. Empty authorized probes should acquire no
owner/account/tuple locks. Runtime scheduling does not replace these checks.

Logo, API Text, the generic runner, and the local Mac launcher are not refactored
here. Their differing schedules and resource behavior remain explicit coverage
gaps. Native tests are coordinated on the reviewer's disposable cluster only;
mock/PGlite schedules do not prove native locks, WAL or production recovery.
Final test results, source manifests, remaining limitations and native evidence
are retained in the task's `runtime-phase-two` review artifacts.

The composed native suite exercised the actual 85-migration schema, scoped store,
installed SDK and synthetic HTTP: old sidecar fencing after same-worker epoch
change, heartbeat/resume without rebinding, GET-only required-action/completed/
cancelled observation, real Stop before/between continuation guards, deadline
cancellation, and a bounded two-connection pool under a held owner lock. Eight
cases passed; exact PID/queue evidence is retained separately. The full progressive
SDK suite also includes new generation-fenced hosted completed/failed Director
cases, crash/reclaim under a new generation, exact acknowledgment timestamps,
100 readable names and idempotent publication/Stop. These are local proofs, not
successful paid inference or production recovery evidence.
