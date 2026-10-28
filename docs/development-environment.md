# Isolated development environment

This checkout can opt into a separate loopback development target. It does not
reuse the Mac launchers or impersonate a hosted Vercel deployment. Production
defaults and target checks remain in place. Configuration and passing fixture
tests do not establish live provider acceptance.

## Web and local services

Use Node 24 and `npm ci`. The cloud onboarding setup keeps Supabase CLI tooling,
configuration and staged migrations outside the checkout in
`/workspace/embel-onboarding`. The provider stack requires PostgreSQL, Auth,
PostgREST, private Storage, Kong and local email capture. Studio AI, analytics,
edge execution and realtime are unnecessary for this workflow.

Stage the 85 baseline migrations byte-for-byte, sorting after removing only the
optional leading `local` from copied filenames. Preserve the original SQL and
do not blanket-apply candidates or activation templates. The saved install
instructions perform this staging and record hashes.

The standard database image exceeds this cloud machine's disk budget with its
VFS Docker driver. CLI 2.122.0 supports `SUPABASE_USE_SLIM_IMAGES=true`, which
selects the official catalog-pinned images. Keep checksum and TLS validation
enabled. Follow the saved setup instructions for any local healthcheck image
overrides; never ignore failing health checks to claim readiness.

The web process needs these non-secret settings and its genuine local public
key, obtained from the running CLI stack without printing private keys:

```text
EMBEL_DEVELOPMENT_ENABLED=true
APP_ORIGIN=http://127.0.0.1:3105
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local public publishable key>
FLUID_PAID_CALLS_APPROVED=false
NEXT_TELEMETRY_DISABLED=1
```

Run `npm run dev`. Both service origins must be distinct canonical
`http://127.0.0.1:<port>` URLs with ports above 1023. The gate accepts only
development/test mode and rejects every `VERCEL` runtime marker. Do not use
`npm run start` for loopback HTTP Supabase. Do not put a service-role credential
or any worker/provider credential in the web process.

With the gate enabled, Strategy and Naming admission use the existing local
SQL routes and polling workers. SQL still decides owner authority, policy and
worker readiness; enabling the gate cannot grant an account inference access.
Default and hosted routing are unchanged.

## Restricted services

Home attachments require a separately supplied owner-bound restricted login:

```text
EMBEL_DEVELOPMENT_ATTACHMENTS_DATABASE_URL
EMBEL_DEVELOPMENT_ATTACHMENTS_OWNER_ID
EMBEL_DEVELOPMENT_ATTACHMENTS_ROLE_NAME
EMBEL_DEVELOPMENT_ATTACHMENTS_ROLE_OID
```

Its role must be named `embel_dev_attachments_*`. The resolver checks the actual
login, OID, owner mapping, role restrictions and private helper privileges.
Storage uses the verified account's session token and the existing create-only
private bucket policies. It reads and verifies real bytes before acknowledging
the immutable receipt. No service-role fallback or public verification helper
is introduced. PDF support remains unavailable.

Identity selections and refinements use a separate restricted
`embel_dev_identity_*` login and the `EMBEL_DEVELOPMENT_IDENTITY_*` settings.
See [Identity transaction setup](development-identity-transactions.md). The
resolver pins the trusted helper implementation and verifies owner binding in
a bounded rollback-only probe. Baseline placeholder SQL is never advertised as
working persistence. Genuine saved source records remain necessary.

These server capabilities are configured separately from workers. This change
does not create logins, passwords, grants, owner bindings or account data.
Each supplied binding is limited to its verified owner; a different signed-in
account remains unavailable rather than borrowing that connection.

## Workers

`npm run dev:worker -- --lane strategy` and `--lane naming` default to read-only
preflight. The `logo` lane likewise checks its actual local database identity
before any execution. The command selects development mode and loads the optional
ignored public development settings; inherited explicit values take precedence.
It uses these additional worker settings:

```text
EMBEL_DEVELOPMENT_WORKER_DATABASE_URL
EMBEL_DEVELOPMENT_WORKER_OWNER_ID
EMBEL_DEVELOPMENT_WORKER_DEPLOYMENT_ID
```

The database must be `postgres` at literal `127.0.0.1` on a separate explicit
port. Text lanes share the restricted `embel_development_text_worker` role;
Logo has its separate restricted role. Deployment IDs begin `embel-dev-`.
The actual SQL principal/capability binding and required RPC permissions must
also be qualified. Preflight never installs them or calls a provider.

The source-only [worker proof helper](../supabase/development/worker-preflight.sql)
must be reviewed and installed on the isolated local database, then granted only
to the dedicated development logins. It returns only their own validated binding;
it does not expose private tables. This file is not part of the 85 baseline
migrations and is not automatically installed or granted by setup.

Text execution requires `--run`, a dedicated
`EMBEL_DEVELOPMENT_PROVIDER_API_KEY`, `EMBEL_DEVELOPMENT_MODEL`,
`EMBEL_DEVELOPMENT_VERIFIED_MODELS`, and both
`EMBEL_DEVELOPMENT_DISPATCH_APPROVED=true` and `FLUID_PAID_CALLS_APPROVED=true`.
These settings are a separate operator action; they are not enabled by setup.
The worker never falls back to the platform agent's `OPENAI_API_KEY`.
Existing leases, duplicate protection, cancellation, evidence and recovery
remain authoritative. No monetary cap is introduced by this development entry.

Logo run mode additionally requires a stable
`EMBEL_DEVELOPMENT_LOGO_WORKER_ID`, separate
`EMBEL_DEVELOPMENT_LOGO_STORAGE_USER_ID` and short-lived
`EMBEL_DEVELOPMENT_LOGO_STORAGE_ACCESS_TOKEN`, and reviewed operation descriptors
in `EMBEL_DEVELOPMENT_LOGO_OPERATIONS`. Supported development lanes are concepts,
saved-preview refinements, vectorization and exports. Image lanes additionally
require the dedicated provider settings, both dispatch approvals and
`EMBEL_DEVELOPMENT_IMAGE_RATE_VERSION`; its accepted value is checked against
the existing pricing binding. Deterministic vector/export lanes do not borrow
an AI key. The local session expires normally; this entrypoint does not discover,
persist, refresh or create credentials.

The web's local Logo RPC and Storage capability SQL also need separate local
qualification. They are not implied by the baseline schema. In particular,
`supabase/candidates/logo_local_concepts.sql` and its refinement companion are
separate reviewed candidates, not instructions to apply every candidate. The
existing disabled directions/proposal features are outside this environment
support change.

## Validation and limits

Run typecheck, lint, relevant server/database/worker tests and production builds.
Stop only your own development server before building or running production
browser tests. The cloud's ignored Playwright override selects system Chromium.
Keep actual Auth/Storage/account and provider results separate from fixture
results. No paid generation, remote migration, deployment or production access
is authorized by ordinary development setup.

Read the current environment's saved startup instructions and readiness report
for service state, qualified checks and outstanding operator configuration.
Do not label the full app ready until its actual required integrations pass.
