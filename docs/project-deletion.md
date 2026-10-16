# Recoverable project deletion

## Product behavior

The three-dot menu on Projects and Home cards contains Delete. One confirmation,
**Stop active work and delete project**, handles stopping without a separate job
screen. Assets, revisions and immutable history are retained. There is no purge
or retention deadline; legacy browser recovery copies are not silently removed.

Only an acknowledged durable intent removes a card from active Projects. The
Deleted projects view includes completed and pending requests:

- **Stopping…**: existing work is processing cancellation or finishing safely.
- **Awaiting resolution**: provider outcome, cost, or retained reservation is
  unresolved. The app must not imply a refund or promise automatic reconciliation
  that the existing worker contract cannot perform.
- **Deleted**: retained evidence shows work and reservations are safely terminal.

Restore is available for pending and completed deletion. It returns the project
to Projects and withdraws deletion intent. It never restarts canceled AI work or
erases a cancellation already sent. The original busy-error implementation is
superseded; users are never told to find a separate Stop control first.

## Persistence and concurrency

`deletion_requested_at` stores durable intent; existing `deleted_at` records stay
supported. `lifecycle_version` advances for a newly accepted request and Restore.
Completion status is derived from owned jobs, steps, and reservations; it does not
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
jobs with active reservations or ambiguous steps remain Awaiting resolution.
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
keyboard/focus behavior and card click isolation. Pending statuses refresh with
bounded read-only requests, pause while hidden, and stop on unmount/account change.
Logical completion does not depend on this polling. Restore clearly explains that
it will not restart canceled AI.

## Rollout and qualification

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
