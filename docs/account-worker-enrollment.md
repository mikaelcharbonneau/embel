# Account worker enrollment SQL contract

> Historical per-customer candidate. The current shared design is documented in
> [shared-worker-pool.md](shared-worker-pool.md). Keep this packet as review and
> compatibility evidence; use the shared configuration for new deployment planning.

`supabase/candidates/account_worker_enrollment.sql` is an **unapplied** source
packet following `account_service_enrollment.sql`. It prepares concrete
provisioning, delivery, qualification and revocation RPCs. It does not configure a
provider, create a live worker, publish credentials, start a process or establish
production readiness. Its approval registries start empty.

The approved process controller, credential store, dedicated launcher reporter,
provider access and private Storage service identity remain separate deployment
prerequisites. Missing prerequisites block enrollment; they do not produce a
simulated ready result. Source tests use explicitly synthetic observations and
disposable PostgreSQL roles, never live credentials or paid model calls.

## Authority and prerequisites

Only the existing registered enrollment operator can use the lease-bound
`provision_account_worker_enrollment`, `adopt_account_worker_enrollment`,
`publish_account_worker_enrollment`, `verify_account_worker_enrollment`,
`disable_account_worker_enrollment` and `verify_account_worker_revocation` RPCs.
Installation grants these to no operator login. Owner, generation, operation key
and role name come from the locked enrollment, not an HTTP owner field.

An approved durable credential store reserves one stable credential per operation
before provisioning. SQL retains its opaque reference and accepts only its SCRAM
verifier, never a plaintext password. The existing NOLOGIN/NOSUPER role manager
creates deterministic, separate per-owner Strategy, Naming and Logo logins. Its
fixed grant function delegates only listed RPCs. Neither the manager nor workers
receive customer-table SELECT. Strategy's two existing step reads use narrow
owned-job RPCs. No web/service-role CREATEROLE capability is introduced.

The role manager retains PostgreSQL's single creator ADMIN edge with INHERIT and
SET false. Managed worker roles have exactly that incoming edge, no outgoing
memberships, no object ownership, no privileged flags or direct application,
Auth, Storage or enrollment relation privileges. The supported NOSUPER installer
temporarily obtains only the SET/schema-CREATE capabilities needed to transfer
the fixed grant function, then removes them and verifies the original ADMIN edge.

Operators separately populate immutable `account_worker_provider_approvals` and
`account_worker_profile_approvals`. A profile binds the exact model verification
receipt, provider reference, application/Supabase target, artifact/source/runtime
identity, deployment, managed-proof hash and policy identities. Provider records
contain only references and receipts, never key material. They expire and can be
revoked through the separate append-only revocation registry. Changed approvals
require a new identifier; runtime operators cannot write these tables.

Naming uses the existing `hosted_owner_v1` authority and uncapped provider budget
version 2. Its original policy/accounting fields remain intact. Logo requires
`admissionContract: account_logo_operation` and `spendControl: uncapped`. The
existing single Logo local capability requires matching concept/refinement policy
identities; mismatched approved identities are rejected rather than rewritten.

The fixed `account_logo_operation` wrapper reuses the reviewed per-owner
`local_logo_operation` transaction witness for concepts and saved-preview
refinement. It removes no accepted quote, source, lease, ownership or per-operation
integrity check. Its existing aggregate-allowance exception is retained: the
offline regression admits and claims owned jobs with an explicit zero aggregate
allowance. Exact committed request/rejection replays remain available without
adding historical markers. Ordinary unmanaged Logo behavior is preserved.

Strategy requires `hosted_strategy_owner_uncapped_v1` and `spendControl: uncapped`.
Apply the separate `account_strategy_uncapped.sql` packet after this one before
qualifying Strategy readiness. Its immutable job witness and claim sidecar
authorize the existing queue/engine without introducing an aggregate monetary
gate. Historical bounded, subscription and local requests retain their original
contracts. No default funding or credit amount is introduced.

First qualified owned uncapped admissions initialize a missing bookkeeping row
with zero balances/limit, using `ON CONFLICT DO NOTHING`. This is not a monetary
cap: the distinct uncapped authority bypasses the aggregate allowance check.
Profile installation, ordinary reads, unqualified calls and committed replays do
not create that row. Existing balances remain untouched by initialization;
normal reservations and actual-cost accounting still update their own fields.

The packet requires the existing Logo Storage broker SQL. Uncapped Logo also
requires the reviewed local-concepts and local-refinements candidates, including
their original predecessor chain. Installation pins supported predecessor
bodies/security metadata and preserves their legacy branches. An unknown
predecessor stops installation; it is not patched speculatively.

## Storage service actors

The optional operator-only `storage-actor.ts` provisioner reserves its UUID and
credential in the separately approved durable store, then commits the exact UUID
and opaque reference through `reserve_account_worker_storage_actor` before any
Auth create request. SQL stores no password and can reserve a UUID before its
Auth row exists. It then creates a dedicated
nonanonymous Auth service identity **unconfirmed**. It sets the exact
`embel_worker_storage` object in server-owned Auth app metadata: enrollment ID,
owner, generation, Logo operation key, identity reference and reservation reference.
The lease-bound `register_account_worker_storage_actor` RPC checks that object,
the exact approved profile and current owner lease, then atomically records its
service-actor exclusion and approved owner/identity reference. A user-editable
metadata object cannot authorize registration. Confirm that identity only after
registration. Exact registered replays remain idempotent after confirmation.
The Auth outbox
excludes registered actors from customer enrollment, preventing recursively
provisioned worker stacks. Already-confirmed customer identities cannot be
reclassified by this helper. Approval rows retain their original generation and
operation; retired actors stay fenced when a later generation rotates identity.
The one-hour Storage registration approval is an activation window, not an
ongoing session lease. An already-consumed exact binding can restart without
creating another approval; approved profile/provider expiry and fresh Auth
session checks still govern runtime authority. Actual Admin/Vault configuration
and live identity creation are not authorized by source installation.

Logo binds this distinct confirmed Auth identity, exact worker role/OID, worker
ID and operation policy to the existing private Storage principal/capabilities.
Readiness requires an actual live matching Auth session. Existing object
ownership, immutable reservations and session/job/lease grants remain
authoritative; no privileged Storage key or public object URL is introduced.

## Readiness and delivery

Provisioning writes no ready flag. The actual managed worker reports its exact
binding through `report_account_worker_heartbeat`; SQL checks its current session
identity and uses a 45-second deadline. Naming additionally needs its actual
generation-fenced leadership/readiness, and Logo needs both operation readiness
rows and its bound live Storage session.

Separately, the profile's dedicated restricted launcher reporter records a
running receipt only after the approved controller observes the actual child
ready. It has no memberships, customer-table access or enrollment authority, and
cannot be the enrollment operator. Its sole permitted incoming membership is an
optional exact trusted creator ADMIN edge with INHERIT/SET false. Reports bind the complete immutable child
descriptor, generation and revision. SQL requires a fresh matching report and
worker heartbeat before publishing/ready; passing a JavaScript boolean cannot
advance the step. Reporter and database clocks must agree on fresh observation
timestamps. No report proves provider output quality or live acceptance.

Completed enrollments receive periodic real operator maintenance leases. The
read RPC returns the same approved descriptor and actual heartbeat. Suspension
closes admission and withdraws heartbeat without discarding observation identity
or changing the durable completed phase. Restart requires a fresh trusted stopped
report and no live heartbeat, leadership or job lease; an unobserved supervisor
crash is not a stopped-process proof. Resume changes no role, password, generation,
operation key or job, and fresh actual worker heartbeat remains necessary before
new work. Requalification preserves the initial publication receipt.

`get_account_worker_strategy_route` accepts only the five-field durable queue
descriptor. The registered reporter can resolve an already-admitted dispatch to
its current ready child binding. SQL matches job, frozen policy, deployment and
dispatch identity; no owner, prompt or new admission enters the queue payload.
Missing, foreign or stale routes return no binding. The controller still checks
the returned descriptor against its actual tracked process.

## Two-stage revocation

Auth ban/deletion or enrollment revocation immediately closes new managed
admission, claim, begin and dispatch. Logo Storage authority is disabled first.
SQL retains the exact old worker identity, policy and lease checks while issued
calls drain, permitting durable provider receipts, original items, accounting,
artifacts and unknown-outcome records. New Naming publication/planning is denied.
The separate observation proof returns only that actual login's frozen binding;
it grants no new owner or historical generation selection.

Only a separately reported actual stopped process, no remaining running or
leased lane work, and Storage denial permit the final revocation witness.
Thereafter the existing manager disables LOGIN and clears the password, and SQL
verifies the denial. A missing child handle, uncertain drain or stale stop report
remains blocked; it never becomes a successful revocation through timeout alone.
Existing immutable provider, job, Stop and accounting evidence is retained.
The separate lease-bound `revoke_account_worker_storage_actor` proof verifies the
original actor binding and final worker/Storage denial before the optional Admin
port performs global logout and ban. SQL itself gets no Auth admin API authority.

Partial setup has a distinct `never_provisioned` cleanup path. SQL must prove the
exact current generation has no managed worker binding/login, lane work or
Storage authority. It checks the reserved UUID, original metadata/registration,
and actual session/refresh-token absence before permitting an unconfirmed actor
to skip global logout. A confirmed actor still requires ordinary verified global
logout and ban. Missing session schema never counts as absence. A Vault-only
reservation can be retired only after concrete Auth UUID absence; SQL writes a
terminal cleanup-only UUID fence rather than assigning an existing account.
An append-only retired-UUID fence and matching transaction advisory lock on Auth
insertion prevent a delayed Admin create acknowledgement from recreating that
retired actor after absence was checked. Existing ordinary signup identifiers
retain their original behavior.

Final revocation acknowledgement independently requires actual Auth absence or
ban, no sessions/unrevoked refresh records, and no worker/Storage authority. The
proof explicitly says `scope: never_provisioned, authorityAbsent: true`; it has
no `runtimeStopped` claim. An existing/unknown process or managed binding cannot
use this branch. The regular drained-process proof remains unchanged. These
checks cover reservation-only, unconfirmed, registered, confirmed and lost
publication stages without reclassifying a crash as an observed process exit.

## Evidence

`tests/database/account-worker-enrollment.test.ts` executes the packet and its
restricted sessions in disposable migrated PGlite. It checks actual role/ADMIN
edges and grants, all three owner bindings, immutable approvals, hostile default
ACL denial, real worker/reporter qualification, service-actor exclusion, the
uncapped Logo admission/claim/replay, post-ban issued Naming receipt retention,
new-dispatch denial and stopped-to-NOLOGIN revocation. These checks are separate
from native PostgreSQL permission qualification, real Auth/Storage/provider
acceptance, approved secret-store/launcher configuration and production rollout.
