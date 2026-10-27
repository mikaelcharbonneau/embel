# Shared web request authority

This source replaces per-customer web LOGIN/password publication with at most
two fixed restricted service logins. It does not create roles, configure secrets,
install SQL or enable itself. Ordinary signup creates no web credential.

Install the reviewed `identity_transactions.sql`, `shared_worker_pool.sql`, then
`shared_account_http.sql` candidates on the selected isolated target. The last
candidate requires exact predecessor Home/Identity owner-helper bodies and adds
a private request-context branch; the complete legacy bodies remain its suffix.
Identity prepare/commit SQL and TypeScript provenance validation remain intact.
Old helper hash qualification intentionally fails closed after this authority
migration; do not run old and shared web runtime flags together.

The installer creates an empty `shared_http_principals` registry and empty
`shared_http_target`. A separately approved operator registers the actual fixed
login names/OIDs and enables only those qualified lanes. Each login must be
NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS,
own no objects, have no outgoing memberships or direct customer/Auth/Storage
relation privileges. The only tolerated incoming edge is the actual postgres
creator's ADMIN edge with INHERIT and SET both false. Grant public schema USAGE
and only the exact lane functions listed at the end of the candidate. Private
schema USAGE, unexpected public SECURITY DEFINER EXEC grants, sequence rights,
database CREATE and function ownership fail qualification. Identity
also needs database TEMP (normally inherited from PUBLIC); its temporary
preparation is created and owned by the existing NOLOGIN helper.

Supply `EMBEL_SHARED_ACCOUNT_HTTP_ENABLED=true` and server-only
`EMBEL_SHARED_ACCOUNT_HTTP_CONFIG`, containing optional `identity` and
`homeVerifier` entries, each `{roleName, roleOid, databaseUrl}`. Names have the
fixed `embel_shared_http_identity_` or `embel_shared_http_home_` prefix. URLs must
select the same project as `NEXT_PUBLIC_SUPABASE_URL`, explicit port 5432 and
`sslmode=verify-full`; the existing public pinned Supabase CA remains required.
These are finite project-sensitive service credentials, never NEXT_PUBLIC
secrets, a customer registry, service-role/Auth-admin credentials or a KV API.

An isolated hosted target uses mode `hosted` and its exact HTTPS Supabase origin.
The existing development gate additionally supports only API
`http://127.0.0.1:54321` and DB `127.0.0.1:54322` with `sslmode=disable`, mode
`development`, development/test NODE_ENV, explicit EMBEL_DEVELOPMENT_ENABLED and
no Vercel metadata. There is no arbitrary HTTP host or implicit PG fallback.
The SQL target registry checks the actual verified JWT issuer against that
origin; merely changing a web environment variable cannot supply DB authority.

Each operation asks the normal Auth client's PostgREST RPC for an opaque
short-lived ownership delegation. SQL derives owner from the verified JWT,
requires a matching live Auth session and current confirmed customer
eligibility, and binds lane, fixed login OID, action, JSONB-canonical arguments
hash, customer eligibility epoch and expiry. SQL stores only the token hash.
Ban/unban cannot revive an old delegation. The fixed restricted login
redeems it once inside its actual backend/transaction. An owner GUC alone is
never authority. Real Auth/session locks fence ban/delete races; eligibility
epoch and DB-clock expiry are checked again through the private context at commit.

Home uses the customer's ordinary verified token for private immutable Storage
IO. The issuer's `readback` scope contains only attachment identity: no byte
digest, MIME, length or observation action. Only the registered fixed server
verifier may submit observation after the existing service validates actual
readback bytes. No observation gateway is granted to authenticated customers.

Identity obtains exact project/request/refinement delegation, retains the
original atomic preparation, TypeScript provenance replay and immutable commit,
and deletes private authority before COMMIT. A deferred SQL constraint rejects
transactions that omit this cleanup. Rollback restores unconsumed delegation;
lost acknowledged-state reads require a new Auth delegation and the existing
immutable intent/replay rules. A lost COMMIT ACK remains uncertain success,
never an automatic write retry.

The runtime uses bounded shared pools and repeats exact helper metadata and
actual-login proof checks on acquisition. Configuration or unavailable authority
fails closed. No Auth context, token, checked-out client or tenant readiness
result is cached globally. `close()` waits for checked-out clients to drain.

Current qualification uses actual restricted SQL with synthetic PostgREST/Auth
session fixtures and inert byte transports. It does not prove hosted Auth,
Storage, pooler concurrency, configured credentials or production readiness.

## Separate shared Logo web verifier

`shared_logo_http.sql` is a separate unapplied candidate after the shared web
packet. It has its own empty fixed-principal registry, intent issuer, token
hashes and transaction contexts. It does not widen the Home or Identity issuer.
Register one approved `embel_shared_http_logo_<suffix>` login and grant only
public schema USAGE plus `shared_logo_http_principal()` and
`execute_shared_logo_request(text,text,jsonb,jsonb)`. The same role, epoch,
Auth/session, exact request hash, expiry and privilege checks apply.

When the shared account HTTP or worker routing flag is selected, the separate
server-only `EMBEL_SHARED_LOGO_HTTP_CONFIG` is `{roleName, roleOid, databaseUrl}`.
It uses the same explicitly selected target/TLS/development rules and finite
static secret mechanism. Absence or invalid configuration must leave shared
Logo services unavailable, with no old owner-login or worker credential fallback.
`createSharedLogoHttpRuntime` exports a fresh account/project resolver and drains
its two-connection pool on close. No account, JWT or checked-out client enters
the singleton state.

The resolver composes the existing Logo services and verified customer-JWT
Storage. Its narrow SQL adapter accepts exactly asset prepare/readback,
command read/apply, input prepare/commit and the existing proposal-quote call.
The issuer receives only owned project plus public intent; actual byte
observations, vector materialization, font evidence and quote context remain
server-attested gateway arguments. Existing upload validation, geometry/source
verification, source fences, immutable receipts and uncertain-COMMIT behavior
remain authoritative. The complete legacy Logo owner statements remain intact
after the inserted shared-context branch.

Baseline and proposal-materialization command helpers are accepted only as their
two exact reviewed source pairs. The optional proposal-quote helper must match
its exact candidate body when installed. This does not install/activate that
helper's provider, quote policy, worker lane or aggregate allowance. Unsupported
AI lanes remain unavailable rather than borrowing concept/refinement authority.

SQL fixtures exercise two owners through normal composed reference uploads,
actual PNG inspection/readback, canonical vector/SVG/geometry verification,
vector acceptance, exact replay and lost real SQL COMMIT acknowledgment. The
completed vector source metadata and object HTTP transport are explicitly
synthetic. This is no claim of live generation, hosted object access or actual
deployed multi-user acceptance.
