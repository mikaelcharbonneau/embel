# Guided interview runtime, 2026-10-14

The guided interview uses the existing five-operation strategy API. Its four
new policies are opt-in, private testing policies. Installing
[`20261014170000_guided_strategy_runtime.sql`](../supabase/migrations/20261014170000_guided_strategy_runtime.sql)
does not enable an account, operation, cohort, deployment, credential or provider
request. Existing API v1 and subscription results remain readable.

| Operation | Guided purpose | Input ceiling | Output ceiling | Built-in calls | Reservation, microUSD |
| --- | --- | ---: | ---: | ---: | ---: |
| `strategy.competitors` | Research and competitor proposals | 3,150,000 | 8,192 | 2 | 15,892,880 |
| `strategy.audience` | Audience proposals | 32,768 | 4,096 | 0 | 122,880 |
| `strategy.personality` | Personality proposals | 32,768 | 4,096 | 0 | 122,880 |
| `strategy.reformulate` | Interpret a real message on the current stage | 32,768 | 4,096 | 0 | 122,880 |

All four use `version:2`, `handlerVersion:strategy-openai-guided-v1`,
`pricingVersion:2026-10-14`, `model:gpt-6.1-sol`, the default service tier and the
exact JSON price card produced by `guidedStrategyPolicy`. Positioning remains
legacy; it is not part of guided readiness. Legacy research remains unavailable
in the hosted worker. Operation names alone do not imply guided capability.
Owner-scoped availability includes `interviewVersion:1` only for an exact guided
policy that passes all runtime and testing gates.

## Research reservation argument

Official documentation was read on 2026-10-14:

- [Model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
  specifies a 1,050,000-token context window and web-search support.
- [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
  specifies that `max_tool_calls` bounds the total built-in calls in a response,
  with further attempts ignored, and that `max_output_tokens` includes reasoning.
- [Search documentation](https://developers.openai.com/api/docs/guides/tools-web-search)
  documents search context limits and the `default`/`unlimited` return budget.
  Neither `search_context_size:low` nor `return_token_budget:default` is used as
  a numerical spending control.
- [Pricing](https://developers.openai.com/api/docs/pricing) specifies short-context
  input/cache-read/cache-write/output rates of $2/$0.10/$2.50/$10 per million,
  long-context rates of $4/$0.20/$5/$15, and $0.01 per search call.

The request permits only web search, at most two built-in calls, no parallel
tool calls, and no inherited conversation or previous response. The initial
model turn plus at most one continuation per tool call gives at most three
model turns. Reserve every turn at the full 1,050,000-token context ceiling,
including any retrieved content: 3,150,000 aggregate input tokens. Charge the
whole allowance at the highest long-context input rate, $5 per million, and
all 8,192 output tokens at $15 per million, plus two search fees:

`3,150,000 × $5 / 1,000,000 + 8,192 × $15 / 1,000,000 + 2 × $0.01 = $15.89288`.

This is a reservation ceiling, not an estimated typical price. The existing
initial token-count request still refuses more than 32,768 initial tokens.
The fixed-origin transport does not retry inference. Truncation is disabled;
model, tier, aggregate usage and observed tools are checked after the response.
Missing or inconsistent usage, unknown outcome, excessive usage or malformed
paid output retains the reservation for reconciliation and does not redispatch.
Only successfully reconciled actual costs settle it. A lower research ceiling
requires a separately supported provider bound and a new exact policy.

### Rejected response evidence

The provider's `max_tool_calls` limits processed built-in calls; the official
reference says further attempts are ignored. A completed response can include
an additional `searching` search entry after two completed web actions. The
adapter treats that narrow pattern separately from an actually completed third
call. It does not assert that the unfinished search completed, and does not use
its sources or answer-only citations to substantiate competitors. It retains
the attempted search in conservative fee accounting and still enforces the
search-fee, token and reservation ceilings.

Only an otherwise valid answer supported by completed tool evidence can
succeed. An otherwise well-formed answer that depends on the unfinished search
is a terminal unusable result, with private evidence retained and bounded usage
settled. It publishes no proposal and performs no automatic retry; the user can
explicitly retry research. Unknown outcomes, malformed accounting, other
unfinished-tool patterns and actual limit overruns still require reconciliation.

A completed provider response can still fail output validation. The retained
assistant text alone does not prove that every tool completed, the cited sources
were observed, or all billable activity was accounted for. Such a request stays
reserved and is not replayed. Refreshing its status reads the same durable job;
it cannot perform provider-specific reconciliation.

Rejected responses now retain bounded diagnostic codes for the exact validation
branches, output/tool/source counts, and validated observed source metadata with
explicit truncation markers. Diagnostics exclude reasoning, arbitrary provider
error strings and unknown type/status values. This evidence does not change
acceptance rules, settlement, permissions or retry behavior. Historical partials
without that evidence are not backfilled from model-authored text. Recovering
them requires the original provider response or equivalent verified provider
records; missing evidence must not be treated as a successful result.

An operator can separately abandon the single reviewed terminal-but-unusable
response described in [the incident recovery](proposals/terminal-research-abandonment.md).
That exact-record exception retains the original ambiguous step and complete
financial hold. It restores explicit new work without declaring billing settled
or accepting the rejected answer. It is not a general reconciliation or retry
capability; every other ambiguous outcome remains blocking.

## Immutable input and answers

An HTTP acknowledgement is separate from durable execution. After an interrupted
acknowledgement, the client retains the attempted operation, input revision,
billing allowance and local mutation generation. A later validated owned status
read dismisses that old confirmation warning only for one matching saved
operation. It sends no replacement request and makes no claim of provider
success; the job's actual state remains authoritative. Ambiguous matches,
conflicts and newer client actions retain their recovery state.

The existing enqueue RPC still accepts only project, expected revision,
operation, idempotency key and accepted maximum cost. For guided policies it
freezes API input v2 from the owned current revision, plus at most five completed
owned results / 32,768 bytes of assistant history. The browser cannot submit
assistant history. Each history entry binds owner, project, job, step, prior
input revision, completion time and output. SQL checks successful source rows,
provider response/model/operation/billing identities and excludes later or
unrelated results. The final input remains bounded by the existing 131,072-byte
job limit. Both the enqueue fingerprint and durable step fingerprint include
the full v2 input. Idempotent replay reuses the frozen input.

`intake.guidedInterview` is optional versioned user metadata, capped at 32,768
bytes, 48 increasing turns and three stage answers. Its latest turn must match
the saved revision and current stage; a message requires `strategy.reformulate`,
while research/propose requires the stage operation. Research is competitor-only.
Every non-null message reference must name an actual validated conversation
`user_message`; research/message require one, while propose may use one or null.
Worker validation repeats these checks before registering a provider step.

Provider guidance is saved in the immutable result and bound to the exact turn.
Selections/custom answers are saved as ordinary user context revisions, without
rewriting provider results. Guided readiness requires completed competitor
review, selected and reviewed audience and reviewed personality. A follow-up
question does not revoke those saved facts; an explicit revisit clears the
relevant review fields. Readiness does not depend on the conversational stage.
It does not fabricate reformulation or positioning approval. The
material-context canonicalizer validates guided metadata; historical contexts
without it retain their original readiness behavior.

## Access and settlement

The testing-access primary key becomes `(owner_id, operation)`; every additional
operation requires a separate explicit row. Guided policy qualification requires
that operation's testing grant plus the existing enabled entitlement, cohort,
global switch, exact policy, exact restricted role OID and deployment binding.
Ordinary signup allowance counters and ceilings remain unchanged. Testing retains
no aggregate cap or expiry and one active request across operations; uncertain
work still blocks further requests except for the exact operator-adjudicated
terminal abandonment above. No new SQL function receives client,
service-role or worker EXECUTE, including installations with permissive default
privileges. Existing function OIDs, owners, security attributes and ACLs are
preserved. The private dispatch action gateway and prompt-free queue message are
unchanged.

Each admission freezes its exact cost and role. The last-boundary dispatch check
requires the leased in-flight step reservation to equal the job and exact policy
maximum. Withdrawal prevents another dispatch while preserving result recording
and settlement of a request already sent. Historical v1 results and dispatches
are not rewritten.

## Activation sequence and resources

This records the historical activation procedure, not current permission to execute it. Requalify the actual target, operation policies and required authorization before any new configuration, credential, migration or paid action.
The known project IDs are web `prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt`, worker
`prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk`, and Supabase project `fricsfwqibyhemknqgyf`.
The existing worker login is `fluid_api_text_worker`; resolve and compare its
current OID and restricted-role attributes, not just its name. Existing Vercel
Authentication, publisher OIDC restrictions, private queue and repair cron remain
in place. The previous local receipt names test owner
`6840f4c2-15a6-45a7-97be-41e7e5e37f42`, cohort `embel-first-response-20261013`;
fresh read-back is required before using those identities.

1. Finish source tests and builds. Record the source revision/tree manifest and
   migration SHA-256. Freshly inspect exact role/OID, policy/binding/cohort/testing
   rows and all queued/running/uncertain API work. The migration checks predecessor
   `pg_proc.prosrc` MD5 values for eleven named functions, definer/invoker status,
   volatility, empty search path, non-leakproof status and the current migration role's ownership. Any mismatch
   aborts the transaction. Read their current definitions and compare before
   applying; do not remove or weaken the guards. The predecessor is the unlimited
   testing migration (hosted receipt version `20261014145143`, source filename
   `20261014142522_api_text_unlimited_testing.sql`).
2. Drain or explicitly resolve old work before changing an operation's policy
   or worker deployment. Configuration holds one policy per operation. A v2
   worker must not attempt a queued v1 request, and an immutable old descriptor
   cannot be retargeted to a new deployment. Uncertain work must remain reserved
   and be reconciled, not made retryable. Historical terminal results stay readable.
3. Apply the forward migration while the newly guided operations remain disabled.
   Capture actual hosted migration version, source digest and post-migration
   security/row comparisons. Preserve existing usage and allowance counters.
4. Build the worker using `npm run build:api-text-worker`. The script emits a fresh
   `.tmp/api-text-worker-*` directory containing only four bundled entrypoint
   graphs, `package.json`, `vercel.json` and `.vercelignore`. Record SHA-256 for
   every emitted file and a sorted manifest digest; verify and deploy that exact
   directory to the existing worker project. Do not deploy the repository root,
   modify a hashed artifact after review or include environment files. Preserve
   protected production settings and obtain the new immutable deployment ID.
5. Worker qualification checks `FLUID_GUIDED_INTERVIEW_ENABLED`, the four
   operation-specific `FLUID_TEXT_MODEL_REFORMULATE`, `FLUID_TEXT_MODEL_COMPETITORS`,
   `FLUID_TEXT_MODEL_AUDIENCE` and `FLUID_TEXT_MODEL_PERSONALITY` values, verified
   model membership in `FLUID_OPENAI_VERIFIED_MODELS`, and the independent
   `FLUID_PAID_CALLS_APPROVED` / `FLUID_API_TEXT_MULTI_ACCOUNT_ENABLED` gates against
   the actual versioned policy. Provider/database credentials and publisher OIDC
   configuration remain separate protected configuration; this document does not
   select a model or authorize changing those settings. Do not use the broad `FLUID_TEXT_MODEL_STRATEGY`
   fallback to add unrelated operations. There is no guided policy for positioning.
6. In one guarded operator transaction, compare the old policy hashes, role/OID,
   bindings and cohort deployment; update the four exact policy JSON values and
   owner/operation bindings to the new policy hashes/deployment, add the three
   missing testing grants, and extend only that cohort's operation list. Preserve
   the enabled existing testing entitlement, counters, one-active-request fence
   and `signup_cohort:null`. Do not create default signup access or enable another
   owner. Roll back on a failed comparison or newly appeared active work.
7. Point the web project's existing `FLUID_API_TEXT_WORKER_ORIGIN` at the intended
   protected worker origin if necessary and deploy the reviewed web artifact.
   Web does not need the provider credential or guided model flag. Verify the
   signed readiness endpoint, exact new deployment, all four operations, and
   owner availability with `interviewVersion:1`. Other accounts must remain
   unavailable. Read back immutable policies/bindings/grants and unchanged old
   accounting into a release receipt before any paid verification call.

The worker bundle must be rebuilt after any shared domain/provider/runtime source
change; an earlier build can silently contain an older guided output schema.
Synthetic tests and protected no-dispatch readiness do not prove live provider
success. A real test request is a separate, recorded activation step.

## Receipt compatibility after project deletion — 2026-10-16

The stop-and-delete migration added nullable `jobs.project_deletion_requested_at`.
Existing operator receipts hashed the complete job row, so even its new null
value invalidated the two historical receipts. Both the account and global pause
checks then blocked new requests; Home presented this as exhausted AI access.
The existing private testing grants were still enabled.

`20261016002628_research_receipt_deletion_compat.sql` preserves current-shape
receipt matching and accepts the historical row shape only when the added marker
is null. It retains every original evidence, identity, terminal-state, lease and
ledger check. It does not rewrite receipts, change jobs, release reservations or
grant access. A non-null deletion marker or changed original evidence still
invalidates a historical receipt. Regression coverage reproduces the schema
upgrade with existing receipts and checks access restoration, isolation, evidence
changes and unchanged privileges/accounting. Future schema additions must be
checked against full-row evidence digests before rollout.

Applied to production as hosted migration `20261016003046` on 2026-10-16.
Both original receipts match again; account/global pauses are cleared and all
four existing guided operations are available in SQL. Before/after digests of
jobs, steps, receipts, reservations and usage are identical; all 31,629,696
microdollars of unresolved holds remain reserved. No provider request was made.
The existing web/worker deployments require no rebuild for this database fix.
The non-secret rollout receipt is in
`/workspace/scratch/embel-research-availability-20261016/`.

A second configuration mismatch remained after the database repair: the web
project's production/preview worker origin still targeted the old
`dpl_EvNfhx8TRXzniVd4AwvpgFymRvKN` worker, while the qualified database bindings
pointed to `dpl_DyFpKiQWg3kGoRJnqarxR286CDXY`. Updating the existing worker-origin
setting requires a new web deployment to take effect. Worker deployment changes
must update the database qualification and the web destination together, followed
by a signed readiness check; SQL availability alone does not prove connectivity.
