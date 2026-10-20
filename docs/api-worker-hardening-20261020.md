# API worker hardening candidate, 2026-10-20

This is source and hermetic-test evidence, not a production repair or activation.
The isolated API worker has not been deployed, rebound, or used to publish live
work by this workstream. Existing immutable dispatch/deployment identities,
leases, provider retry rules, outbox generations, grants, policies, credentials,
limits, and the daily repair schedule are unchanged.

## Pool lifetime (#45)

`workerDatabase()` first qualifies the existing worker identity and restricted
TLS connection. The newly created module-scoped `pg.Pool` is attached exactly
once using pinned `@vercel/functions` lifecycle support, then reused. Idle-client
errors emit only a fixed diagnostic event; an error object or attached client
never reaches the logger. An idle event does not abort unrelated deliveries, and
logger failure is contained. Actual query failures retain existing delivery and
lease behavior.

This follows [Vercel's pool lifecycle guidance](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#attachdatabasepool),
which calls for attaching a pool immediately after creation so idle connections
can be released before Fluid suspension. [The pg Pool reference](https://node-postgres.com/apis/pool#error)
explains that the idle client associated with an error event is removed
and terminated by the pool. Neither source establishes that this lifecycle gap
caused the previously observed enqueue 503.

## Safe Embel diagnostics (#46)

The `api_text_stage` event contains exactly `event`, `phase`, `outcome`,
`durationMs`, and `errorClass`. Phase/outcome/class values have runtime allowlists;
elapsed time is a finite bounded integer. Messages, stack traces, nested causes,
SQL, requests, headers, prompts, owners, provider payloads, response IDs and
attached clients are not serialized. Database classification examines only a
small allowlist of own data-property codes; it does not evaluate getters.

Publication separates descriptor read, queue send and receipt write. Delivery
separates descriptor/expiry, claim, handler plan, persisted plan, heartbeat,
step boundaries, policy/dispatch checks, token counting and provider request/
execution. Failure to parse a descriptor is no longer reported as a database
transport failure. Every diagnostic sink call is isolated from business behavior.

Queue labels are deliberately `terminal_ack_requested`, `retry_requested`, and
`transport_success`/`transport_failure`. They do not claim that the broker
acknowledged a message or that a job completed solely because the HTTP response
was 200. Neither logging nor HTTP status changes retry, lease or outbox semantics.

Important dependency limitation: pinned Queue 0.8.0 contains its own existing
`console.warn/error` calls that can include raw SDK errors and receipt handles.
The new Embel logger does not intercept, replace or globally patch those calls.
Hermetic tests preserve and document SDK reschedule/finalization failure
warnings. An end-to-end guarantee that *all dependency logs* are sanitized would
require a separately reviewed SDK/upstream logging change; it is not claimed by
this patch.

## Real Queue wire contract (#51)

Tests execute the actual installed `@vercel/queue` 0.8.0 `QueueClient`, including
CloudEvent parsing, multipart receive, lifecycle and follow-up HTTP calls. The
global fetch seam accepts only `https://broker.invalid`, uses a synthetic token,
and never contacts a broker or provider. Both package and installed versions are
asserted so an SDK upgrade requires deliberate contract review.

- A nonterminal delivery produces PATCH visibility-change and zero DELETE ACKs,
  although the SDK returns HTTP 200.
- A terminal delivery produces one DELETE ACK per delivery. The composed actual
  Embel runtime receives a duplicate and invokes the synthetic provider once.
- Failed ACK enters the existing retry path. Failed rescheduling can still yield
  HTTP 200 with zero ACKs. Finalization failures are swallowed by the pinned SDK
  after warning; these are tested facts, not successful business outcomes.
- A late receive cannot start business work after the outer invocation deadline;
  a separate invocation retains its own abort state.

[Vercel's retry documentation](https://vercel.com/docs/queues/sdk#custom-retry-behavior)
distinguishes `afterSeconds` from explicit acknowledgement. The stronger claims
above are established by tests against the repository's exact SDK, not inferred
from HTTP status or from a fake `handleCallback` implementation.

## Request stream cleanup (#53)

Invalid declared body headers, malformed UTF-8, oversize data, stalled reads and
request abortion cancel the rejected reader once. A rejecting or never-settling
cancel cannot replace or delay the bounded invalid-input response. Valid input
is consumed normally. The request abort signal is restricted to body intake;
client disconnect after full validation does not imply an already-issued
publication was rolled back. No request bytes or authorization headers are logged.

## Additive artifact provenance (#52)

`npm run build:api-text-worker -- --source-revision=<reviewed 40-character Git SHA>`
produces the four-entrypoint worker and a deterministic `build-manifest.json`.
The revision must be supplied from verified release provenance. Omitting it
records `sourceRevision: null`; the builder does not read credentials, infer Git
state from runtime environment variables, or label a modified snapshot as clean
main. A revision label alone is not proof of a clean source checkout.

The manifest records source/dependency fingerprints and hashes of every emitted
deployable file except itself. Input hashing includes the bundled source graph,
build scripts, configuration, package manifest and lockfile. Names are relative;
no temporary output path or timestamp is hashed. Protected/outside inputs are
rejected. The builder checks that source inputs did not change during compilation.

A successful authenticated readiness response adds
`x-embel-worker-fingerprint` and, when supplied, `x-embel-worker-source-revision`.
The JSON response and all existing qualification checks remain unchanged. Failed
or unauthenticated readiness has no provenance header. Metadata is not a new
runtime gate and does not disqualify historical deployments.

### Read-only release checklist

1. Review the final clean source/lockfile and record its exact Git SHA. Build the
   isolated artifact with that SHA and retain the manifest beside release evidence.
2. Independently hash the listed output files and compare their contents with the
   manifest. Rebuilding the same inputs in another temporary directory must agree.
3. Record the immutable worker deployment ID and URL selected for the release.
   Compare a successful existing protected readiness fingerprint and revision
   with the retained artifact. Do not use enqueue, repair or inference as probes.
4. Review existing pending, active and unknown outcomes under their original
   immutable bindings. A candidate artifact is not authority to rebind them.
5. Follow the existing separately reviewed qualification/cutover procedure in
   [production AI dispatch](production-ai-dispatch.md). No broader repair cadence,
   credential change, policy activation, SQL grant or historical row rewrite is
   authorized by this metadata.

## Verification scope

Focused tests are in `tests/worker/api-text-pool-lifecycle.test.ts`,
`api-text-diagnostics.test.ts`, `api-text-queue-sdk-contract.test.ts`,
`api-text-build-manifest.test.ts`, and the existing hosting/HTTP/runtime suites.
All database, Queue and provider outcomes in these tests are synthetic. The
integration lead owns whole-application typecheck/build, independent review,
release qualification and any later live change.
