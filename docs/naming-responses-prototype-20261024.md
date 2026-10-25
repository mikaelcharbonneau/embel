# Inactive durable Naming Responses components — 2026-10-24

## Status and decision

This draft is a tested **inactive adapter/ledger foundation**, not a complete
runnable Naming replacement. It starts at merged main
`16b2298bdf3f11bd29bde1e0256d18c6638eea99` in the verified private repository
`mikaelcharbonneau/embel` (ID `1410624483`). It preserves `gpt-6-luna`, `xhigh`,
required research, the 100-name target, historical Agents work and manual Naming.
No live provider call, pricing/count probe, production mutation, rollout,
credential, account or production permission change was performed.

[Primary-source cost evidence and the application-controlled research option](naming-responses-cost-evidence-20261024.md)
explain the blocker. Responses bounds generated tokens and built-in tool calls,
but the reviewed sources do not publish a cumulative billable-input ceiling for
hosted search's internal passes. The initial prompt count and a pointwise search
context window do not prove that ceiling. The code does not invent a multiplier.

The smallest user decision is whether to approve **reference-fetch discovery**
using the existing approved reference sites instead of open-ended hosted search.
That preserves real fetched evidence but changes discovery and cannot be called
search-equivalent. If search-equivalent discovery must remain, a separately
approved source with qualified search prices and input limits, or a provider
hosted-search guarantee, is still needed. No new paid service was selected or
implemented. A twenty-one-call text-only proposal retains the fifteen initial
Creator assignments and is an admission ceiling, not proof
that every selected-approach/100-name configuration can complete within it.

## What is implemented

### Explicit new contract and source-backed arithmetic

New jobs have input version 3, handler `naming-responses-v1` and protocol
`openai_responses`. Frozen dispatch requests have their own version 1 and a SHA256
of canonical JSON covering the complete wire body and quote. Existing Agents
request versions, hashes, model policies, receipts and recovery adapters remain
unchanged. Shared role instructions/output schemas are reused without rewriting
old requests or pretending that Responses evidence is an Agents artifact.

The new wire pins model, `xhigh`/standard reasoning, default processing tier,
explicit caching with no breakpoints, stored background execution, disabled
truncation, output schema and generated-token/tool ceilings. It rejects image/file
inputs, extra tools, cache breakpoints, implicit conversation, compaction and
`previous_response_id`. Function results require an explicitly frozen and newly
reserved request; the adapter never submits an automatic model continuation.

For text-only responses without hosted tools, the provisional source card reserves
the full 1,050,000-token context at the more expensive long-context Standard rate:
200 nanodollars/input token plus 750/generated token, including reasoning. With
32,768 generated tokens that is 234,576,000 nanodollars. BigInt arithmetic avoids
floating USD and never treats this maximum as an actual expense. The source card
expires at `2026-10-25T00:00:00Z`; expiry is an application review policy, not a
provider price guarantee or account-access qualification. No real token-count
endpoint is called or assumed free. Required hosted research has a null input
ceiling and remains unqualified.

### Atomic durable dispatch and accounting

The additive SQL candidate separates immutable run binding, frozen dispatch requests,
monotonic attempt state and append-only observations. SQL independently checks
canonical hashes, exact scoped identities, source-card qualification, caps and
maximum cost. Under the owned job/run lock, the sum of **all** frozen maxima may
never exceed 5,000,000,000 nanodollars. Successful output, lower observed usage,
rejection and cancellation never replenish that allocation.

A separate `reserved -> dispatching` compare-and-set grants create exactly once.
A duplicate begin returns false. If its acknowledgement is lost, the runtime does
not create. An uncertain create without a response ID remains quarantined and
is not replayed. A known handle grants retrieval and explicit cancellation only.
The execution and observation deadlines are fixed at reservation, 15 and 30
minutes respectively; recovery never resets them.

SDK retries/redirects/logging are disabled. Streams, JSON and stored observations
have byte/count limits. An identity-bound unsafe response is retained before
policy/cost interpretation. A later smaller usage snapshot cannot erase it:
further reserve/begin actions stay blocked. Oversize and conflicting-terminal
observations retain bounded immutable violation witnesses rather than overwriting
old terminal evidence. Observation and cancellation never certify final billing.
No settlement implementation is included; the historical holds stay untouched.

Every worker action is bound to the restricted existing principal, owned job and
project, exact new input marker, current lease and immutable run. Generic workers
and generic lease expiry exclude even malformed new-version Naming jobs. Generic
settlement cannot settle them from default `actual=0`. Tests install privileges
only in disposable SQL fixtures. The candidate grants no production worker access
to the new mutation RPC.

### Fail-closed activation boundary

The default SDK adapter refuses real creation before reservation. The new owned
admission RPC always returns a safe blocked response before inserting a job or
reservation. Neither an environment flag nor a synthetic qualification row opens
that admission. Existing production availability stays unchanged from the merged
safe-failure patch. No worker registry, deployment source allowlist, scheduler or
web route is switched to the prototype.

The ledger SQL is `supabase/candidates/naming-responses-ledger.sql`, explicitly
installed only by the new disposable fixtures. It is not an automatic migration.
Its generic claim/expiry and settlement guards are tested against the exact base
above; promotion needs a reviewed forward migration and compatibility with any
other candidate subsequently promoted. It must not silently bypass another
candidate's predecessor/body checks.

Full execution/publication integration is intentionally unfinished while research
is unqualified. The old progressive publication/terminal proofs require Agents
session/turn provenance; Responses must receive a genuine responseId-specific
branch, not fabricated Agents IDs. New response results are therefore retained
only in their own private ledger. The 100-record synthetic test demonstrates
adapter/store/SQL plumbing and schema-valid creator data, not live creative
quality, factual research, public feed publication or full application readiness.

## Validation

Focused tests cover exact arithmetic, request hashes/versioning, source-card
expiry, unsupported tools/tier/cache/context, aggregate maximum, one-shot begin,
unknown create/no replay, lost acknowledgements, duplicate keys/leases,
streaming/background recovery, explicit cancellation versus terminal GET proof,
monotonic unsafe evidence, ownership/direct-table denial and old Agents/accounting
compatibility. The SQL+SDK composition includes required synthetic research and
100 unique schema-valid creator records, lost streaming tail recovery, exact
frozen caps, no repeat create on reopening, held accounting and no old-feed writes.
Synthetic qualifications are labeled test-only and do not qualify hosted billing.

Final command results and commit are recorded in the draft PR. The known
pre-existing Strategy unit failure from the prior task remains outside this
change; no unrelated Strategy fix is included.
