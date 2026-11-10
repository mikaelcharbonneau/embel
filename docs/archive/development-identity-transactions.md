> Archived November 10, 2026: describes the system before the generation engine.

# Local Identity transaction capability

The default production Identity transaction service remains unavailable. The
separate [operator-configured hosted registry](production-account-http.md) can
compose qualified per-owner capabilities after its own activation. A
separate development resolver can use the existing transaction service only
when the shared `EMBEL_DEVELOPMENT_ENABLED=true` gate accepts development/test
mode, exact loopback application/Supabase URLs and no Vercel runtime markers.

The server-only configuration names are:

- `EMBEL_DEVELOPMENT_IDENTITY_DATABASE_URL`: a direct loopback PostgreSQL URL,
  literal `127.0.0.1`, an explicit nonprivileged port distinct from the web and
  Supabase HTTP ports, database `postgres`, no query options or fragment. Numeric
  host aliases, control bytes and oversized URLs are rejected.
- `EMBEL_DEVELOPMENT_IDENTITY_OWNER_ID`: one verified local Auth user's UUID.
- `EMBEL_DEVELOPMENT_IDENTITY_ROLE_NAME`: a dedicated `embel_dev_identity_*`
  login, matching the database URL's user.
- `EMBEL_DEVELOPMENT_IDENTITY_ROLE_OID`: that exact local login's OID.

Supply the dedicated login securely to the server process. Do not put it in
`NEXT_PUBLIC_*`, reuse an administrator/service-role/worker credential, or point
these variables at a hosted database. There is no worker or `PG*` fallback.
The pool selects the JavaScript PostgreSQL client explicitly, fixes its target
and connection options, and ignores ambient native-client selection.
Changing the configured principal requires restarting the web process.

Configuration alone does not make saves available. A local operator must first
provide reviewed trusted Identity helpers, their narrow table/function ACLs and
RLS policies, the nonlogin `fluid_identity_writer_definer_v1` helper owner, and an
administrative `identity_web_principals` binding for the dedicated login's exact
name/OID and Auth owner. The existing `tests/database/identity-trusted-replacement.sql`
and its roles fixture document and exercise that local contract; they are test
fixtures, not an automatically installed application migration. Do not execute
their synthetic users/roles as application provisioning. Baseline migrations
contain unavailable placeholders, so a fresh baseline alone is insufficient.

On each request the resolver checks actual restricted login metadata and pins
all three trusted helper bodies, ownership, search paths, execution modes and
PUBLIC ACLs. Its bounded readiness transaction sets the verified owner claim,
submits a deliberately invalid request to the pinned preparation helper, and
always rolls back. The expected rejection occurs after independent login/owner
verification and before any temporary table, lock, project read or mutation.
Missing helpers, placeholder bodies, foreign bindings, cancellation and cleanup
failures keep save availability unavailable. Readiness results are not cached.

Successful qualification exposes the existing single-connection transaction
service. Its project ownership, immutable provenance, revision checks, commit
acknowledgement and uncertain-commit recovery are unchanged. This configuration
does not enable generation, create source Identity results, grant privileges,
apply SQL, create roles or provision persistent credentials. Full local Identity
save acceptance still requires a separately qualified local principal/helper
installation and genuine saved Identity source data.
