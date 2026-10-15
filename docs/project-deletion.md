# Recoverable project deletion

## Scope

The requested project-card menu adds Delete to the top-right of project cards in
Projects and Home. Delete requires an explicit confirmation and moves the account
project to Deleted projects. Restore is available there. This is reversible
collection management, not permanent erasure: revisions, assets, job evidence and
usage records are retained. No retention deadline or automatic purge is created.
Legacy browser recovery copies are not silently removed or attached to accounts.

The implementation is prepared and tested locally. Hosted migration, publication
and deployment require their separate reviewed rollout; local evidence must not
be presented as live acceptance.

## Persistence and safety

- `projects.deleted_at` marks a deleted project; `lifecycle_version` starts at zero
  and advances on each delete or restore. `current_revision` and content history
  remain unchanged.
- Lifecycle requests require the observed content revision and lifecycle version.
  Stale requests, including a late delete after a restore, cannot replay over a
  newer lifecycle transition. Uncertain HTTP outcomes require a fresh listing.
- `set_project_deleted` derives ownership from the authenticated session and
  returns inaccessible IDs as not found. HTTP mutations also enforce the existing
  same-origin and expected-account header fences, strict body shape and bounds.
- Deletion is rejected while the project has queued, running, partial,
  cancel-requested or reconciliation work, or an active usage reservation. The UI
  points to the existing project so the owner can stop or resolve work. Deletion
  never cancels it, changes an allowance, releases a reservation or bypasses
  active-request controls.
- Project lifecycle changes and all database job admission paths share a project
  row lock. Deleted projects reject new jobs and reactivation. Content-write
  guards reject content writes begun after deletion without introducing new
  child/parent lock inversions. A content-only save already in flight can finish
  concurrently with deletion; that saved content is retained for Restore.
  Accounting, settlement and audit paths keep their existing controls.
- Active project lists and the ordinary project-detail API exclude deleted rows.
  The Deleted projects listing includes only the verified owner's deleted rows.
  Existing RLS and owner-filtered historical reads remain in force; deleting is
  not a claim to revoke the owner's access to retained history or files.

## API

`GET /api/projects/page?state=active|deleted` defaults to active. Both views retain
the same bounded created-at/ID cursor ordering and include `deleted_at` and
`lifecycle_version`. Missing lifecycle fields fail closed in the collection.

`POST /api/projects/:projectId/deletion` deletes and `DELETE` on the same route
restores. Both require `X-Embel-Account` and JSON containing only
`expectedRevision` and `expectedLifecycleVersion`. The response is `{ project }`
with the acknowledged lifecycle fields. `project_busy` is a safe 409 reason;
ordinary CAS conflicts are also 409. Arbitrary database diagnostics stay private.

## Rollout order

1. Recheck current main and preserve concurrent contributors' work.
2. Review the exact additive migration, including its installed descendant-write
   triggers, existing grants/default privileges and lock interactions.
3. After explicit hosted approval, apply and verify that migration on the approved
   database, without changing real projects or executing provider jobs as tests.
4. Publish the matching application revision and verify the collection response
   contract and authenticated UI through separately approved acceptance checks.

Read-only creation-receipt replays may still identify a previously created
deleted project. They never restore it or admit new work; ordinary project reads
remain unavailable until Restore.

Do not deploy the new collection reader against a database missing the lifecycle
columns. There is deliberately no fallback that pretends deletion succeeded.


## Local qualification

- 125 focused tests pass across API, database, independent review and client suites.
  Coverage includes owner isolation, malformed/stale/foreign requests, lifecycle
  CAS, nonterminal jobs and active reservations, terminal history, preserved
  cancellation/settlement behavior, admissions, retained downloads, upload fences,
  exact inherited ACL cleanup, keyboard/focus/dialog controls, late responses,
  account changes, uncertain outcomes, pagination, Home refill and Restore.
- The full standalone TypeScript check passes. Production webpack compilation
  succeeds, but the production build does not complete: its cold TypeScript
  subprocess is killed with exit 137 in this workspace. No type-check bypass or
  release configuration change is included.
- Dedicated Chromium could not start: `process_singleton_posix.cc:297` reported
  `socket() failed: Operation not permitted (1)`, including the supported escalation
  attempt. No desktop/mobile visual pass or screenshot exists. A synthetic browser
  harness is retained in `tests/client/project-deletion-browser-check.mjs`.
- PGlite applies the full migration chain and checks both serialized admission/
  deletion orderings. Actual concurrent PostgreSQL sessions, hosted schema state
  and production browser behavior remain unverified. No real project was deleted,
  restored or used for testing; no provider job was started.
