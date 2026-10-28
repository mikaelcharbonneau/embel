# Fixed-slot engine adapters

These adapters run the existing Strategy runner/handlers, native Naming Agents SDK/store, and Logo image handlers. A process owns a configured finite slot pool; customers do not acquire LOGIN roles, credentials, Auth actors, resident processes or Vault records. Importing a factory performs no I/O.

`shared-pool/runtime.ts` supplies the explicitly configured restricted database connection, current slot lease and finite provider/Storage secrets. Each turn creates a fresh query facade. Unknown SQL is rejected; fixed lane gateways independently select an immutable admitted job and derive owner, project, policy, epoch, generation and lease authority from Postgres. Returned claims and Strategy shared authority are compared with the execution capability. No tenant context is cached on the connection or Storage actor.

Strategy and Naming retain their explicit uncapped admission profiles and accounting. Logo retains existing immutable quotes, per-operation execution guards and dispatch counts; the new lane adds no owner aggregate allowance. Historical owner-specific runtimes are unchanged. New shared Naming owners have logical policy membership; existing legacy pilot bindings require an explicit cutover rather than automatic retargeting.

A runner timeout is not a drain acknowledgment. Actual issued handler/SDK futures remain tracked until they settle. Strategy independently journals actual parsed outcomes even after the runner writes an ambiguous result. Failed evidence persistence produces an explicit unhealthy engine fault. Unknown provider work is retained rather than recreated or refunded.

Bounded recovery never replays a handler or creates a model request:

- Strategy retrieves only SQL-proven saved `resp_*` identifiers through the existing GET transport and appends terminal raw response evidence. Header request IDs cannot authorize retrieval. Ambiguous historical outcomes and accounting remain unchanged.
- Naming resumes only saved SDK session handles with forced observation mode; create, continuation, planning, publication and finalization are unavailable. Saved requests, receipts, items, turns and completed artifacts retain their original scope. Unknown sessions stay unsupported.
- Logo reads only an exact previously issued output reservation through the fixed slot's normal Auth session. Hash, MIME and byte length must match before SQL records readback evidence. This cannot manufacture a provider response or publish a new selection. Missing image bytes remain unknown. SQL may acknowledge an already known terminal result; an unknown result cannot become a fabricated completion.

The candidates are unapplied. Installation/configuration and live model access remain separate prerequisites. Tests in `tests/worker/shared-lanes-*.test.ts` use real disposable SQL/store/engine boundaries with explicitly synthetic Auth, provider, reference-page and Storage transports. They establish source behavior, not live provider quality, hosted availability or a production release.
