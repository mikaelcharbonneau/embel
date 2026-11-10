> Archived November 10, 2026: describes the system before the generation engine.

# Application health and release evidence

`GET /api/health` is a process liveness check. It preserves the `fluid-web` service
identifier and returns `status: ok`, `readiness: not_checked`, and a validated
40-character source revision from `VERCEL_GIT_COMMIT_SHA` or
`EMBEL_SOURCE_REVISION`. Missing or malformed revision metadata is `unknown`; a
local build with uncommitted work must not advertise its base commit as the
deployed source. This endpoint does no upstream work.

`GET /api/health/ready` checks **core connectivity** only. It returns 200 when
Auth, database and Storage respond as expected, or 503 otherwise. Its response
explicitly leaves worker, provider and enrollment readiness `not_checked`.
Neither endpoint establishes complete branding, model quality, account
enrollment, private-file access, queue health, or production release readiness.

The readiness handler makes three parallel, read-only requests to the configured
Supabase origin using only its public publishable key. Auth must return a valid
health response. The database probe selects zero project rows and recognizes the
actual SQL42501 anonymous permission response, or a successful empty result.
Storage's status endpoint may return an empty200 response. No private account
session, privileged key, model, worker claim or paid call is used.

Each probe has a two-second deadline, bounded4096-byte response, redirect rejection
and cancellation. Simultaneous polls share work; observations expire after two
seconds and configuration changes invalidate the cache. Responses use
`Cache-Control: no-store`. Raw upstream bodies, error messages, target URLs,
tokens and configuration values never enter the diagnostic response.

Local validation exercised the real Auth/PostgREST/Storage endpoints and returned
200 for core connectivity. Unit checks cover missing configuration, SQL denial,
unexpected data/errors, malformed/oversized responses, timeout, caching and
diagnostic redaction. This evidence does not qualify the hosted environment.

Before production release, separately record the exact source SHA, web and worker
deployment identities, migration receipts, confirmed-account enrollment metadata
and the enabled fixed principal/slot bindings,
worker heartbeats and queue age, genuine two-account persistence/private-file
isolation, provider receipts/usage, and cancellation/reconciliation behavior.
Configure redacted operational alerts and verify backup/restore and rollback.
Production grants, provisioning, configuration changes and deployment require
their applicable approval; these source endpoints perform none of them.
