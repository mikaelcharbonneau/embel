# Recoverable project deletion

_Status, November 10, 2026: "Product behavior" and "API and UI contract" describe the running feature.
The lock-order, job, reservation and rollout sections were written for the retired worker system and
are kept as a record of the design; the retired worker objects they mention no longer exist._

## Product behavior

The three-dot menu on Projects and Home cards contains Delete. One confirmation,
**Stop active work and delete project**, handles stopping without a separate job
screen. Assets, revisions and immutable history are retained. There is no purge
or retention deadline; legacy browser recovery copies are not silently removed.

Only an acknowledged durable intent removes a card from active Projects and Home.
Once acknowledged, the project immediately shows **Deleted** in the Deleted
projects view and in its deletion date, independently of earlier work or usage
settlement. This presentation follows the user's 2026-10-20 request to delete and
cancel work rather than wait on **Awaiting resolution**.

If the server reports work still stopping, a secondary **Cancellation requested**
line appears beneath the Deleted badge. Uncertain provider outcomes or retained
reservations do not become a blocking status on the project card. The confirmation
explains that active work receives a cancellation request and already-started work
may still finish or incur usage; Deleted does not claim confirmed provider
cancellation, a refund, or automatic reconciliation.

Restore is available immediately for every acknowledged deletion. It returns the
project to Projects and withdraws deletion intent. It never restarts canceled AI
work or erases a cancellation already sent. An unconfirmed transport outcome is
not labeled Deleted until an owner-bound acknowledgment or status read confirms
intent. Users are never told to find a separate Stop control first.

## Persistence and concurrency

`deletion_requested_at` stores durable intent; existing `deleted_at` records stay
supported. `lifecycle_version` advances for a newly accepted request and Restore.
Internal work-completion status is derived from owned jobs, steps, and reservations; it does not
require a second write, browser polling, a finalizer trigger, or a new cron. The
content `current_revision` and immutable output history are preserved.

The request RPC obtains the existing strategy-owner lock before rows and uses
NOWAIT for the required usage account, project, job and reservation rows. If a
required lock is contested, the request rolls back and the application can retry
the same CAS. No worker receives a new waiting lock-order requirement. Once held,
the request records intent and applies safe cancellation in the same transaction,
so an interrupted HTTP response cannot strand intent between cancellation phases.

Proven never-dispatched queued work uses existing cancellation and reservation
settlement. Queued jobs with provider/step/spend evidence are not assumed free:
uncertainty remains pending with cancellation recorded. Running jobs receive the
existing cancellation state. Fully settled partial outcomes are terminal; failed
jobs with active reservations or ambiguous steps retain `awaiting_resolution`
internally while the project is presented as Deleted.
Existing billing limits, active-slot controls and provider policies are unchanged.

Running/already-cancel-requested jobs receive a durable
`jobs.project_deletion_requested_at` provenance marker. The existing subscription
completion core accepts an already-produced success in `cancel_requested` only
when this marker is present, retaining its lease, policy and result checks. This
repairs the observed in-flight Naming settlement rejection without broadening
ordinary Stop semantics. Restore never clears the marker or restarts dispatch.
The migration verifies the exact prior core definition before replacing its one
success-state predicate; its signature, privileges and identity are preserved.

Pending intent fences new job admission, queued claims, new provider work and stale
owner mutations. Existing owner-bound worker publication, provider-evidence,
heartbeat and settlement paths retain their permissions. Caller identity must be
the original database caller, never a security-definer function's current_user.
Read-only history and downloads stay owner scoped. Restore does not bypass job or
budget admission checks.

Revision/lifecycle CAS prevents a late request from deleting a restored project.
An exact replay of an already acknowledged intent returns the same epoch without
repeating cancellation or settlement. Uncertain transport outcomes are reconciled
with an owner-bound status read rather than blind mutation replay.

## API and UI contract

Project page and lifecycle responses require:

- `deleted_at`: timestamp or null
- `deletion_requested_at`: timestamp or null
- `lifecycle_version`: bounded nonnegative integer
- `deletion_state`: `active`, `stopping`, `awaiting_resolution`, or `deleted`

`GET /api/projects/page?state=active|deleted` keeps bounded created-at/ID cursor
ordering. Active rows require both markers null; Deleted includes either marker.
Deleted-page status enrichment is a bounded owner-scoped RPC and rejects a
different lifecycle snapshot rather than merging a concurrent Restore into a
stale page. Ordinary project detail/list entrypoints also exclude pending intent.

`POST /api/projects/:projectId/deletion` requires `X-Embel-Account`, same origin,
and strict JSON `{expectedRevision, expectedLifecycleVersion, stopActiveWork:true}`.
It returns `{project}`, with 200 for completed deletion or 202 while pending.
`GET` on that route is an authenticated read-only status check. `DELETE` restores
or withdraws intent using the original two CAS fields. Generic older project RPC
readers remain compatible; lifecycle/page readers require the new fields.

The UI preserves account-generation fencing, duplicate locks, bounded requests,
keyboard/focus behavior and card click isolation. Unsettled work statuses refresh
with bounded read-only requests, pause while hidden, and stop on unmount/account
change. The Deleted badge, deletion date and Restore availability never depend on
polling success or work settlement. A failed status read does not undo the deletion
acknowledgment. Restore clearly explains that it will not restart canceled AI.

The 2026-10-20 presentation correction changes only UI/copy and tests. It does not
write `deleted_at`, change lifecycle values, release reservations, fabricate
terminal jobs or add a migration/provider operation.

## 2026-10-20 presentation verification

The focused client, API, database and safety suites passed: **9 files, 188 tests**.
The three changed client suites and production components also passed scoped
ESLint. Coverage includes immediate Home/Projects removal after acknowledgment,
Deleted badges/dates before work settlement, continued Restore through status
outages, lost-acknowledgment recovery, account/lifecycle fencing, and existing
queued/running cancellation with retained uncertain outcomes and accounting.
Database checks use synthetic PGlite fixtures, not live provider execution or
native PostgreSQL concurrency. This focused run does not establish a production
build, deployed behavior, or browser visual acceptance.

## Earlier lifecycle rollout and qualification

The initial feature was merged in PR #14 at
`f0d709a1b442fd0d7c9a963c4a13e8d4a0f44695`, with the reviewed first migration
applied as hosted `20261015234109_project_soft_deletion`. Its 125 focused tests,
standalone typecheck/lint and normal hosted Next build passed. That release's busy
error failed the user's acceptance test and is replaced by this correction.

For the correction, recheck current main, review the exact additive migration and
lock/ACL changes, run focused ownership, queued/ambiguous/partial, interruption,
duplicate and UI tests, then apply the exact migration before the matching app.
Do not use broad db push/history repair: hosted timestamps differ from local
filenames. Preserve lifecycle markers and retained data during rollback; an old
unfiltered application can re-expose deleted projects. Prefer a compatible
application rollback or forward fix.

No real project is deleted, canceled or restored as a test, and no provider call
is started. Browser visual validation is still unavailable: Chromium failed before
page creation with `socket() failed: Operation not permitted`; the synthetic
fixture is retained. Do not claim screenshots or desktop/mobile visual passes.
Actual concurrent two-session PostgreSQL behavior must be distinguished from
PGlite synthetic and static lock-order tests.
