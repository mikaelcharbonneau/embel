# Shared worker authority

The shared path replaces customer-specific SQL passwords, resident workers,
Storage Auth users and online role provisioning with a finite operator-installed
set of lane slots. Signup writes ordinary account metadata. It creates no login,
secret, process, provider request or remote service.

This source is a separately versioned authority migration. Existing jobs, their
immutable inputs, provider receipts, accounting and historical capped contracts
retain their original handlers. New shared Strategy, Naming and Logo admissions
must satisfy their reviewed uncapped lane contracts. Identity generation uses
Logo slot 1; it adds no fourth lane or customer-specific process.
Installing a packet does not
enable an application flag, register a slot, configure credentials or prove live
generation.

## Installation dependencies

The selected deployment target is the existing Embel app and database. Follow
the current [working agreement](../AGENTS.md): tested updates within the user's
requested work are authorized while Embel has no customers. Do not create a separate test app or
reapply the baseline to an existing database. The source-only production composer
checks the read-only target inventory and prepares one guarded transaction from
the missing reviewed packets. It opens no database connection and grants nothing.

Disposable local fixtures reconstruct the ordered 85 baseline migrations,
including the reviewed `local`-prefixed predecessors in their documented
chronological positions. Their dependency order is:

1. `identity_transactions.sql` installs the qualified standalone Identity helpers.
2. For Logo, install `logo_worker_storage.sql`, `logo_production_storage.sql`, its
   matching activation packet, `logo_generative_storage.sql`, its matching
   activation packet, `logo_local_concepts.sql`, the empty
   `activation/logo_concepts_50_publication_adjudication.sql` predecessor, and
   `logo_local_refinements.sql`. Do not insert an adjudication incident.
3. `shared_worker_pool.sql` installs data-only signup metadata, immutable job
   admissions, the slot registry, execution records and transaction contexts.
4. `shared_account_http.sql` installs the Home/Identity request boundary. It needs
   the actual Auth `sessions`/JWT interfaces and the standalone Identity helpers.
5. `shared_worker_strategy.sql` and `shared_worker_naming.sql` install their lane
   admission and fixed action gateways.
6. `shared_worker_logo.sql`, then `shared_storage_authority.sql`, install Logo
   admission, execution and Storage authority.
7. `shared_logo_http.sql` installs the separate fixed Logo web request boundary
   after the shared Home/Identity and Logo prerequisites. It does not widen the
   Home/Identity issuer or grant a customer direct trusted mutation rights.
8. `shared_logo_advanced.sql` adds independently versioned directions, vector,
   proposal and export authority while preserving historical admissions and
   provider evidence. The native drawing, font and file checks run before the
   slot can advertise those operations.
9. `shared_identity_generation.sql` adds reference upload preparation, immutable
   generation admissions, per-call evidence, staged outputs and atomic
   publication of complete Identity systems. The combined shared installation
   contains ten forward packets: the standalone Identity packet and nine shared
   packets. Historical Logo setup in item 2 is a fixture prerequisite, not an
   instruction to reinstall it in production.
   Fresh shared production compilation then applies the additive, hash-pinned
   `shared_storage_download_metadata.sql` correction before COMMIT; it does not
   rewrite any of those ten historical packets. See
   [the metadata-read rollout](shared-storage-download-metadata.md).

The superseded `account_service_enrollment.sql`, `account_worker_enrollment.sql`
and `account_strategy_uncapped.sql` packets are not installation prerequisites.
The shared path does not require their online CREATEROLE manager, per-customer
credential registry or Vault composition. Unknown predecessor hashes fail the
install; reconcile the target rather than bypassing a guard.

## Fixed authority

Each configured worker slot has an immutable role name/OID, lane, deployment,
operation-to-policy mapping and index. Its login is LOGIN, NOINHERIT, NOSUPERUSER,
NOCREATEROLE, NOCREATEDB, NOREPLICATION, NOBYPASSRLS, connection limit four,
with no object ownership, outgoing memberships, private-schema USAGE or raw
customer/Auth/Storage relation privileges. PostgreSQL 17's exact database-owner
ADMIN-only incoming creation edge may remain, with SET and INHERIT disabled.

Grant only the reviewed pool metadata/claim/renew/release/pending RPCs and that
slot's lane gateway. Home verification and Identity use separate fixed restricted
principals and one-use request capabilities issued through verified customer
PostgREST sessions. A customer-supplied owner ID or owner GUC is never authority.
Home byte observation remains a trusted verifier action. Identity preserves its
atomic prepare/commit and uncertain-commit recovery protocol.
Delegation metadata cascades when its actual Auth session is deleted. In-flight
requests hold the session lock through commit; logout can then invalidate both
consumed and outstanding capabilities. This cascade never deletes artifacts,
provider evidence, billing or Storage grant history.

The worker grant list is `shared_worker_pool_configuration()`,
`claim_shared_worker_slot(uuid,uuid,text,integer)`,
`renew_shared_worker_slot(jsonb,integer)`, `release_shared_worker_slot(jsonb)`,
`fence_shared_worker_slot(jsonb)` and
`read_shared_worker_execution_page(jsonb,uuid,integer)`, plus only its
`shared_strategy_worker_action(jsonb,jsonb,text,jsonb)`,
`shared_naming_worker_action(jsonb,jsonb,text,jsonb)` or
`shared_logo_worker_action(jsonb,jsonb,text,jsonb)` gateway. Strategy also needs
`list_shared_strategy_dispatches(jsonb,integer)`. The compatibility unpaged read
is bounded but is unnecessary for the new runtime. Qualification rejects extra
callable public SECURITY DEFINER functions, including a mistakenly granted
generic customer mutation. Register each exact role/OID; changing a slot's role
name/OID, lane, index or identifier in place is rejected.

The SQL slot claim binds an actual login/OID to a fresh process instance,
generation, lease token and expiration. A live slot requires its token to renew;
calling claim again cannot renew it. Every new execution derives owner, project,
operation, immutable input hash and policy from an admitted database job. Private
contexts are keyed by backend, transaction and actual session identity. Fixed
gateways create and remove them on one database connection, and a deferred
constraint rejects a successful commit that leaves a context behind.
An admission also freezes the account's eligibility epoch. Ban and unban change
that epoch; unban cannot silently revive a pre-ban job's dispatch capability.

Only one active execution occupies a slot. SQL also enforces active capacity per
owner and lane; unrelated tools may execute in parallel. The pool configuration
RPC proves the complete enabled slot set, its global concurrency bound and
`maxPerTenantPerLane`. Mixed enabled tenant limits fail qualification. These are
execution/connection limits, not monetary limits.
Production runs one Strategy slot, one Naming slot and six Logo slots, with a
per-person limit of six per lane, so the six jobs of one concept batch run at
once. Logo slot 1 handles every Logo and Identity operation; slots 2–6 handle
concepts and refinements only, so native vector and export work stays one at a
time. Each Logo slot has its own database role and Storage service user.
An engine journal or drain failure immediately fences its exact current lease,
expires admission and parks its active metadata as observation. This is an
admission withdrawal, not evidence that a remote provider request stopped. An old
process cannot fence a newer generation's slot.

## Restart, cancellation and evidence

An expired takeover increases the slot generation and moves its old executions
to observation. Their tokens, original job lease and immutable scope remain
unchanged. They consume no current slot or tenant admission capacity, so an
unknown outcome cannot stop every customer's unrelated projects. The same
unresolved job cannot be re-admitted. A lane may retire a never-dispatched
attempt only after its database state independently proves no provider dispatch.
The private park helper may also free current scheduling capacity after SQL
proves reconciliation, terminal unresolved work or inactive admission. It changes
only the execution's observation state, never a provider outcome. Local pending
promises still require normal engine drain. Recovery reads at most 25 records per
indexed cursor page; a first page is not a claim that all history was reconciled.

Observation permits only the fixed receipt, result, accounting, cancellation and
terminal-state actions allowed by that lane. It cannot authorize a provider
create, plan, claim or retry. Current Auth suspension, a slot takeover or lease
expiration closes new dispatch without discarding evidence from an already
issued request. A shared principal intentionally has authority over eligible
jobs across tenants; its compromise has a broader blast radius than a truly
isolated per-customer credential. Narrow gateways and job-scoped authority bound
that service trust, rather than claiming identical credential isolation.

Logo uses a fixed Storage Auth identity per slot and a real current Auth session.
Register the service-actor marker before confirming that identity so it cannot
become a customer. Object grants bind the session, slot generation, execution,
job lease, reservation and exact immutable path. Retained output observation does
not permit new uploads. Ordinary Home Storage continues to use the customer's
verified session.
The restrictive customer Storage fence also checks current customer eligibility,
issuer, token time and the actual live Auth session. A still-unexpired JWT cannot
read or write managed customer objects after a ban or session deletion. Fixed
Storage actors continue through their separate exact job/session predicates.

Full Identity generation requires explicit selection of one to four owned
references whose combined verified file size is at most 20 MiB. Uploading a
reference does not select it. External discovery stays unavailable until a real
source is configured. Each admitted batch freezes the selected references and
the project versions it uses. A durable authorization precedes each paid text
or image request; known outcomes can be read again without another create.
Uncertain requests retain their original keys and evidence. Closing an original
intent must obtain an atomic database witness that either stops the admitted
batch or blocks a late admission; a missing lookup alone is insufficient.

The vector-proposal editor uses the same rule for its exact original generation
intent. Its finite authenticated lookup resolves the actual admitted job and
proposal through their immutable quote, source and request bindings. Closing an
unused intent writes a durable rejection under the original admission locks;
closing an admitted request asks the actual job to stop without inventing a
provider outcome. Cold reload reads bounded pages of pending requests, including
ambiguous terminal jobs. Cursor ownership and every returned binding are checked;
missing or corrupted authority fails closed. Proposal application creates an
unapproved candidate with the existing native producer and no new AI request.

The shared slot is a trusted application service across eligible accounts. A
compromised lane credential could process or expose the eligible work it can
claim within that lane. It cannot choose an arbitrary owner, bypass Storage
policies, read raw customer tables, create roles or use a stale generation to
publish. Eight total execution slots and six active jobs per account per lane
bound concurrency; they are not a guarantee against deliberate abuse by a
compromised service. A stolen provider key can also be used outside these SQL
gates until revoked. Containment therefore includes separate restricted web
and worker credentials, fixed operation grants, narrow object grants, sensitive
project settings, protected worker deployment, and a stopped cutover with
credential rotation when compromise is suspected.

## Configuration and validation limits

Worker configuration uses `EMBEL_SHARED_WORKER_POOL_ENABLED`, server-only
`EMBEL_SHARED_WORKER_POOL_CONFIGURATION` and `EMBEL_SHARED_WORKER_POOL_SECRETS`.
The shared web boundary uses `EMBEL_SHARED_ACCOUNT_HTTP_ENABLED` and server-only
`EMBEL_SHARED_ACCOUNT_HTTP_CONFIG`. Web AI routing uses
`EMBEL_SHARED_WORKERS_ENABLED`; the separate Logo verifier uses server-only
`EMBEL_SHARED_LOGO_HTTP_CONFIG`. All defaults remain off. Fixed database,
application provider and Storage credentials belong in the selected project's
sensitive settings; web receives no provider, worker, CREATEROLE or Auth-admin
credential. No dynamic customer secret store or new Vault service is required.

Hosted validation targets the existing Vercel projects and Supabase database.
It requires separately approved fixed role/slot registrations and grants,
sensitive settings, exact source/artifact/runtime metadata, and supported
outbound Queue polling. No production change is authorized by this document.
The remaining hosting reads concern current worker commands, instance counts,
memory and region; Queue consumers and outstanding deliveries; automatic source
deployment; signup/email settings; and the available backup recovery window.
Working account connectors do not need reconnection. No new hosting or secret
service is a prerequisite.

Disposable tests emulate Auth/Storage schemas; they do not establish live Auth,
Storage HTTP or provider readiness. `scripts/verify-shared-worker-native.mjs`
uses an already-cached PostgreSQL 17 image with network disabled, no ports/mounts
and a NOSUPER installer. Its report identifies exact installed packet hashes and
the finite synthetic probe scope, and checks container removal. Actual two-user
provider acceptance remains separate. This cloud's application key binding and
direct factual-reference egress remain unresolved; an agent key is not a
substitute, and the source-reader's approved-host list is not a network allowlist.

The verifier generates `worker/shared-pool/authority-manifest.json` from the
catalog changes made by the shared packets, including private copies and the
legacy seams they modify. Workers check this source-owned body, owner, language,
security, search-path and broad EXECUTE metadata directly through `pg_catalog`
before calling proof RPCs. It covers the new authority graph; it does not pin
every historical function or fingerprint the policy catalog. Storage installation
separately checks the exact customer helper and restrictive policy, and the RLS
tests exercise their actual denials.
