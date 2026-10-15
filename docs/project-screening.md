# Project-linked screening research

The selected-name screening pane now mounts `ProjectScreeningEvidence` with the exact project, selection ID, saved project revision and candidate name. Existing standalone research links remain separate. Checking a name is optional and never becomes a purchase, reservation, filing or legal-clearance action.

## Two distinct kinds of information

`POST /api/projects/[projectId]/screening/check` validates the owned current selection before calling the existing bounded standalone adapter, then checks the selection/context again before returning. Domain, handle and trademark criteria remain exact and visible. The result is transient: it is not written into a project or manual tool draft. Existing adapter semantics remain unchanged, including Unknown for absent registration/profile records and incomplete EU-only trademark research.

The owner may research manually or explicitly copy a live observation into editable review notes. `POST /api/projects/[projectId]/screening` records those notes only after acknowledgement. The durable record is always `provenance: user_recorded`, `verification: unverified`, `legalClearance: not_assessed`. It accepts no provider-result payload, provider signature, price quote, availability status or clearance field. Source URLs and reported observation time are user-supplied, not independently verified. Recording time comes from the database.

## Owned persistence and freshness

The applied migration is `supabase/migrations/20261013190225_project_screening.sql`, byte-identical to the frozen `supabase/candidates/project_screening.sql` review source. It creates only `public.project_screening_records` plus narrow authenticated read/record RPCs and private DTO/basis helpers. It does not activate providers, provision credentials or create a privileged writer. The lead applied and verified it on 2026-10-13; see the [database rollout receipt](database-rollout-20261013.md).

Each immutable record binds the exact owner, project, Naming selection, candidate, selected-name spelling, project revision and saved context hash. SQL derives the binding from owned saved rows while holding the same project-first lock used by Naming. Stale selection/revision writes fail. There are no direct browser insert/update/delete grants, and history mutation triggers prevent rewriting records. Owner IDs and provenance are never accepted from a browser. An exact request ID/payload replay returns the original record, including after subsequent context changes; conflicting reuse fails. History is bounded to 1,000 records per project with 20-record cursor pages.

History stays visible after a new name or context is selected. A matching selection/context is labeled current context, observation freshness unverified. Different criteria and earlier context are displayed separately. Saved notes never become fresh provider evidence by being reloaded. The transient domain status becomes Unknown when the adapter’s expiry passes. Trademark dataset freshness remains unknown.

## Browser recovery

Private responses require the exact verified owner and project. Requests bound decoded response bytes and the complete HTTP wait, refuse redirects, and fence late results after abort/account changes. Changing criteria clears the transient lookup; changing selection/revision remounts the pane and cancels its in-flight checks. Check and record requests run individually, with no automatic retry.

The shared AccountSession owns `createProjectScreeningMemory()`. Same-owner reverification preserves unsaved notes and the exact pending record intent; unverified sessions cannot read them, and confirmed owner replacement/sign-out clears them. Its dirty/unload checks include these notes. A timeout keeps the exact intent for an explicit idempotent retry. Earlier-context drafts remain separately visible for recovery or discard; they are not silently applied to the current name. Dates use the existing account date preference and time zone.

## Verification scope

Focused domain, API, browser/client and local SQL suites are under `tests/{domain,api,client,database}/project-screening*`. All provider replies and account identities in those tests are synthetic. The database suite executes the candidate in a local PostgreSQL engine and covers real ownership/RLS, immutable history, strict writes, source/time limits, selection/context conflicts, uncertain-save replay and pagination. No credentialed provider acceptance, remote database mutation, deployment or production availability is claimed. Final local run receipts belong in `/workspace/scratch/fluid-integration-20261013/screening`.

On 2026-10-13 (America/Toronto), all five focused suites passed: 32 tests, one worker, exit 0. The local SQL suite used PGlite with the candidate explicitly applied to its disposable database. The UI suite covered React Strict Mode, explicit review/record actions, exact uncertain-save retry, selection cancellation, stale observations and earlier drafts. Full output is `focused-run-1.log`; the source hashes and command are recorded in `final-receipt.json` in the receipt directory above. Combined lint, type checking, build and release remain the lead's integration checks.
