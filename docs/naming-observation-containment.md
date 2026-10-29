# Brainstorm observation failure containment

A known stored Responses ID permits GET-only observation. In6181, a bounded
provider read failure or locally rejected response escaped the observer, and the
shared Naming engine classified it as an unconfirmed drain. A parked unknown
could therefore repeatedly retire its lane/process without granting new paid
work. The loop does not establish the cause of the original stream failure.

This worker-only correction contains two narrow, settled outcomes:

- Sanitized `NamingBrainstormProviderError` from `retrieve` leaves that call unknown.
- Module-local typed response validation failures leave the response unaccepted.

Model equality, response identity and byte limits remain enforced. The observer's
provider type exposes only `retrieve`; it never creates, cancels, publishes,
finishes or re-adjudicates work. A later call in the bounded state may still be
observed. No provider result, cost or success is invented.

Gateway/state/authority failures and completion-write acknowledgement failures
still propagate through the unchanged shared Naming engine and controller. They
are not converted into a successful drain. The existing recovery RPC continues
its observe-only run revision/timestamp bookkeeping; immutable call/request/event
bytes, job/accounting/lease/publication/execution fields are otherwise preserved
for contained failures. Historical generation profiles use their unchanged path.

The active dispatch catch now records a closed typed `errorCode` in the existing
immutable event JSON. Only fixed literals derived from module-owned validation,
the sanitized provider error enum, abort state or a generic fallback are stored.
No exception message/stack/cause, provider error text, prompt or credential is
copied. Existing terminal precedence and lost-ACK behavior remain authoritative.
No schema, SQL body, constraint, grant, RLS policy, call budget or timeout changes.

Qualification uses the actual shared lane engine and restricted SQL fixture with
synthetic Auth/provider ports, plus actual SDK/fake HTTP and unchanged controller
failure tests. The 44-case group and separate one-case SQL diagnostic test give45
distinct passing cases. No live provider, production or native image test is
claimed. Initial reproduction failures and fixture expectation corrections are
retained separately. Typecheck, targeted lint, official worker build and inert
`--describe` pass on cached LinuxNode22.22.2. The review build is uncommitted and
sourceClean:false; it is not a production artifact. Native children differ only
in cached dependency path labels, proven by exact path-only normalization.

For the live unknown response, inspect the already-delivered fixed-ID GET probe
first. No dated-model alias is accepted by this change. The original response
must not be replayed, rewritten, or treated as new paid work. Observation alone
still cannot publish/settle a parked brainstorm under current SQL. Any completion
requires a separately reviewed exact-evidence continuation after actual response
inspection. A successor deployment cannot silently adopt the old immutable job:
the existing Naming observer filters deployment identity. Preserve that fence,
old admissions, original nine uncertainties and prior successful100-name witness.
