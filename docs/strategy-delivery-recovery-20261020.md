# Existing Strategy delivery recovery

## Observed failure and scope

The full branding-flow check on 2026-10-20 found an admitted competitor-research
job remaining queued after the protected worker handoff returned HTTP 503. Its
initial outbox had no publication receipt and the worker had not claimed it.
Ordinary status reads did not republish it, and the bound queued conversation
offered Stop but no delivery recovery. Queued alone is not evidence of a failed
handoff: a published request can legitimately still be waiting to start.

The repair adds an explicit **Retry delivery** action for the same saved request.
It never creates or reconstructs an admission, request key, accepted amount or
provider call. The original job, policy, dispatch identity, publication generation,
input revision, request identity, accounting and accepted limit remain unchanged.

## Boundary and exact access change

`20261020033500_strategy_delivery_recovery.sql` adds one read-only, stable,
`SECURITY DEFINER` function with an empty search path:

`public.get_strategy_job_deliveries(uuid, uuid[])`

Its sole non-owner grant is authenticated EXECUTE on that function. The migration
scrubs PUBLIC, anon and any inherited hostile default function grants. It changes
no existing function, role, table grant, private-schema grant, security setting,
quota, billing route, policy or data. Authenticated users still cannot select raw
job input or idempotency keys. The function derives the owner from `auth.uid()`
and binds the project and bounded job-ID list to that owner.

The returned descriptor is the same five-field immutable descriptor already
available to that owner from the original admission. It is available only for an
API-text job that is queued, has zero attempts, has no lease token or expiry, no
registered plan or step, no cancellation or deletion request, and belongs to the
current revision of an active project. Its initial publication generation must
still be zero and both publication receipt fields must be empty. Other queued
outboxes can report publication status but expose no retry descriptor. The
function does not evaluate the heavy worker policy graph or call any mutation.

## Web and worker behavior

GET status and overview reads attach only publication state and a retry
capability. They never publish. The descriptor never reaches the browser through
those reads. If the optional capability read is unavailable, saved job status is
still readable and no retry capability is inferred.

The new owner-authenticated POST delivery route requires same-origin mutation
validation, the expected-account header and an empty bounded JSON body. It reads
the current exact capability again and sends only that persisted descriptor to
the existing protected publisher. It cannot call enqueue, claim, redrive, broad
repair or provider execution. The worker independently re-reads its canonical
descriptor, validates the original policy/deployment, uses the existing
`api-text:{dispatchIdentity}:{publicationGeneration}` queue idempotency key, and
short-circuits an already recorded publication.

The read and publication are not one transaction. Concurrent claims, cancellation,
deletion and status changes remain subject to the existing worker/lease/provider
authorization fences. This is not a new atomic guarantee across the web and
worker or a promise of exactly-once external delivery. A fresh read after the
attempt preserves the actual current job state; an acknowledged stored receipt
wins over an uncertain HTTP reply.

The guided and standard Strategy views offer the action without depending on new
request availability. They still require the current saved revision, a verified
account, no dirty/conflicted edits, and no in-flight action or status-read error.
Reload, polling, Check status and automatic coordination do not invoke delivery.
Repeated clicks in the same mounted client are single-flight. An uncertain reply
says delivery is unconfirmed, retains the same job, and does not automatically
retry.

## Verification scope

Focused disposable-database tests exercise owner isolation, exact descriptor
identity, unchanged durable/allowance state, the sole grant delta, hostile
defaults, bounded inputs, published/terminal/claimed/stale/deleted requests,
retained steps, leases, plans, cancellation and nonzero generations. API tests
cover same-origin and expected-account fencing, caller-field rejection,
descriptor mismatch, read-only status, unavailable recovery infrastructure,
uncertain acknowledgement and concurrent state/receipt changes. Client tests
cover reload presentation, explicit action, single-flight, stale/terminal
capabilities and late responses after account expiry.

These are local synthetic tests, not evidence of a live migration, deployment,
queue receipt or provider result. The parent integration record must separately
record those steps and the exact recovered original request.

Local verification on 2026-10-20: the 17-test disposable database suite passed;
16 focused API/domain/client/publication suites passed 276 tests. Targeted lint
passed. Root integration owns the final whole-app typecheck/build and deployment.
The reviewed migration SHA-256 is
`518d3e61310360b8c586e2ac291a475b7995a769ad342a6fbd138fad9663aeda`.

Integration verification: root's final production build and TypeScript passed.
The exact reviewed migration was installed on 2026-10-20. Native readback confirms
only postgres and authenticated can execute it; anon cannot. A read-only check
under the actual owner role reports dispatch_pending, canRetryDelivery=true and
an exact descriptor/job match for the existing full-flow QA request. No recovery
publication or provider result is inferred from that read-only capability check.
