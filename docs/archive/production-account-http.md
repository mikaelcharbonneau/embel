> Archived November 10, 2026: describes the system before the generation engine.

# Operator-configured account HTTP capabilities

> Historical per-customer candidate. The current shared design is documented in
> [shared-worker-pool.md](shared-worker-pool.md). Keep this packet as review and
> compatibility evidence; use the shared configuration for new deployment planning.

Home attachment and Identity persistence now have a separate server composition
for the existing hosted Supabase project. This path does not enable the
development gate, provision access, or activate AI. With no explicit registry,
the existing unavailable defaults remain in place.

## Configuration contract

A trusted operator supplies `EMBEL_ACCOUNT_HTTP_ENABLED=true` and
`EMBEL_ACCOUNT_HTTP_BINDINGS` to the server process through its approved secure
runtime configuration. The latter is a JSON array with this structure:

```text
[
  {
    "ownerId": "<confirmed Auth user UUID>",
    "identity": {
      "roleName": "embel_identity_web_<unique suffix>",
      "roleOid": <actual numeric database role OID>,
      "databaseUrl": "<dedicated restricted Identity login URL>"
    },
    "attachments": {
      "roleName": "embel_home_web_<different unique suffix>",
      "roleOid": <actual numeric database role OID>,
      "databaseUrl": "<dedicated restricted Home login URL>"
    }
  }
]
```

Each entry requires at least one capability. The registry accepts at most 100
owners and rejects duplicate owner UUIDs, login names or OIDs, including shared
logins between capabilities. Every database URL must identify the same approved
Supabase project as `NEXT_PUBLIC_SUPABASE_URL`, use its existing direct or session
pooler hostname, explicit port 5432, database `postgres`, and exactly
`sslmode=verify-full`. A pooler login includes that project's exact suffix. Other
query options, targets, administrator/service-role/worker names and local
development roles are rejected. Public configuration must use a publishable key.

The credential-bearing JSON is server-only. Never put it in `NEXT_PUBLIC_*`, a
repository file, a browser response or a diagnostic/environment dump. This code
does not introduce a credential vault or read arbitrary secret files. Parsed
passwords are non-enumerable and forwarded only through pool password callbacks;
errors never return supplied URLs or driver details. Changing the registry
requires restarting the server process.

This bounded registry is an interim operator-configured capability for separately
enrolled accounts. It is **not automatic signup enrollment**, a claim that every
new user can run the service, or evidence of successful multi-user production
acceptance. Adding an account still requires its reviewed restricted principals
and immutable administrative owner bindings.

## Access prerequisites

Before activating a capability, separately review and qualify its actual target:

- Each account must be a confirmed, nonanonymous Auth user.
- Home requires a dedicated restricted login, exact name/OID/owner mapping in
  `fluid_private.home_attachment_principals`, schema usage and only the five
  reviewed private helper EXECUTE permissions. The login must own no objects,
  have no role memberships, bypass/create capabilities, or direct application,
  Auth or Storage relation privileges. Home's public final-project RPCs remain
  authorized through the verified user's ordinary Auth client.
- Identity requires its separate login and exact
  `fluid_private.identity_web_principals` binding, the reviewed trusted
  preparation/commit helpers, nonlogin helper owner, narrow helper table/function
  ACLs and RLS policies, and appropriate temporary-table capability. Historical
  baseline placeholder helpers are insufficient. The standalone unapplied production installer is [identity_transactions.sql](../../supabase/candidates/identity_transactions.sql); it creates only the qualified NOLOGIN helper, exact bodies and fixed ACL/RLS, with no login or owner binding. Its fresh-boundary/predecessor guards must pass on the selected target. The retained local SQL fixtures
  document and test that contract; this change does not automatically promote or
  install them on a hosted database.
- Private `fluid-assets` bucket ownership policies and provider Storage operation
  functions must be qualified. No public object URL or privileged Storage key is
  used. PDF staging remains unavailable because its decoded-memory bound has not
  been qualified.
- Genuine owned Identity source records and immutable provenance are required for
  real selection/refinement acceptance. The composition creates no generated
  results and never substitutes synthetic source data in the application.

No credentials, logins, users, SQL, grants, owner mappings or remote configuration
are installed by the source factories or instrumentation.

## Runtime behavior and readiness

Node instrumentation installs immutable per-owner lazy pools through the existing
multi-owner connection factory. Explicit JavaScript clients, fixed connection
parameters, verified TLS and the pinned existing public CA prevent native-client,
ambient `PG*`, worker-credential or unverified-TLS fallbacks. An unknown account
returns unavailable before any pool checkout or token retrieval.

Installation is not readiness. Each Identity resolution checks actual restricted
login/OID, ownership/membership restrictions, exact trusted helper bodies and
security metadata, then proves the independent administrative owner binding in
a bounded rollback-only probe. Each Home resolution pins all five helper bodies
and security metadata, checks the actual restricted principal and proves its own
owner mapping in a read-only transaction. Cancellation and failed qualification
leave the capability unavailable; connections are rolled back and released or
discarded. Neither readiness observations nor acquired connections are cached.

Home Storage selects the current verified account's token and revalidates that
exact token with Auth, including confirmed user/owner agreement. The transport
lives only for the request, accepts only that owner's `home` UUID paths at the
existing fixed hosted endpoint, and preserves create-only uploads, bounded reads,
redirect rejection and cancellation. It does not retry, switch principals or use
a worker/service key. The unchanged Home service verifies real hashes, lengths
and MIME types before acknowledging immutable receipts.

Identity continues to use the existing single-connection trusted transaction
service. Ownership, source replay, revision conflicts, acknowledged COMMIT and
uncertain-commit recovery remain authoritative. Cross-owner lookup cannot borrow
another account's pool or its source records.

Tests exercise two independent account registries, actual restricted SQL helpers
in disposable PGlite, immutable byte transports with synthetic HTTP replies,
foreign mappings, missing grants and token mismatch/expiry. These are source and
fixture qualifications, not native pooler concurrency, actual hosted Storage or
live multi-user production acceptance. Deployment, helper installation, runtime
credentials and real two-user acceptance require their separate approved steps.

## Optional automatic-enrollment publication source

The dynamic source replaces the bounded static owner registry when a trusted
operator explicitly injects `EMBEL_ACCOUNT_HTTP_SOURCE_ENABLED=true`. Supply
`EMBEL_ACCOUNT_HTTP_SOURCE_CONFIG` as server-only JSON with this shape:

```text
{
  "vault": {
    "origin": "<approved HTTPS Vault origin>",
    "mount": "<approved KV-v2 mount>",
    "token": "<separate read-only web token>"
  },
  "publicationPrefix": "<approved HTTP publication path prefix>",
  "credentialPrefix": "<approved per-operation credential path prefix>"
}
```

There is no default Vault, token, path, file lookup or provisioning action. The
operator must review the backend and narrowly authorize this separate web token
to read only HTTP publication records and their HTTP credential records. It must
not be a provisioning, worker, provider, launcher or service-role credential.
Neither configuration nor credentials belong in public environment variables,
source files, HTTP responses or environment/error dumps. The same fixed hosted
Supabase URL, public key, CA pin and verified database TLS restrictions apply.
Invalid or unavailable dynamic configuration leaves the capability unavailable;
it never falls back to a static registry or a development principal.

Each request first invokes the read-only, zero-argument
`get_account_service_enrollment_binding()` RPC through the verified user's Auth
client. This SQL contract derives the current confirmed owner, enrollment
generation/revision, per-lane operation/publication receipt and ready state.
Only then may the read-only source load that owner's published binding. Exact
owner, generation, revision, operation, receipt, capability and managed principal
metadata must agree. SQL authority is checked again after source lookup and
before pool construction/checkout or Home token selection. Foreign, withdrawn,
stale, pending or malformed evidence leaves the capability unavailable.

Managed version 2 qualification is explicit. It independently checks the actual
session's owner, role name/OID, enrollment generation/revision/operation and
manager name/OID through the pinned SQL proof. Only the exact reviewed manager
incoming ADMIN edge, with INHERIT and SET disabled, is permitted. Legacy and
development bindings keep their existing strict membership rules. A publication
or successful configuration parse alone never advertises availability.

The process cache holds at most 100 prepared runtime entries, including entries
still held by requests. This limits concurrent cached pools, not the number of
enrolled customers. Every acquisition repeats current Auth/publication evidence
and actual-session qualification. Idle least-recently-used entries may be
closed; rejected authority/publication evidence retires the owner's old entries.
Home and Identity callers release their request lease in `finally`. Retirement
and shutdown wait for normal request/client release before closing a pool; they
never terminate a backend or cancel another request. This allows independent
SQL revocation checks to observe actual connection drain. Auth contexts, tokens,
Storage transports, checked-out clients and readiness results are not cached.

The source requires the reviewed enrollment migration, confirmed-user enrollment
provisioner, durable credential reservation and monotonic HTTP publication
adapters to be installed and configured separately. Missing worker adapters keep
full enrollment pending even when HTTP capabilities qualify. Tests include
actual owner-derived SQL and managed restricted-session qualification for two
owners in disposable PGlite, plus cache/release/revocation rejection cases; they
are not live Vault, Auth, Storage, pooler or production acceptance.
