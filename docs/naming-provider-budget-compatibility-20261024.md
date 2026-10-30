# Naming provider budget compatibility — 2026-10-24

> Historical investigation. The fixed cap, model restriction and task-specific approval holds below are superseded by the [current project rules](../AGENTS.md). The [October 25 correction](naming-native-restoration-20261025.md) removed the US$5 release gate; [fast-first Naming](naming-fast-first.md) describes the newer initial generation flow. The provider findings remain dated technical evidence, not requirements to restore the old spending limits.

## Historical finding and task boundary

No drop-in, enforceable US$5 managed-Agents execution path is established for
the existing account. Keep new capped generation unavailable until that changes.
Do not strip `spend_control`, fall back to the historical unlimited profile,
switch models, or replay an uncertain create. Local mocks establish application
behavior, not provider support or billing settlement.

This investigation used repository/installed SDK source and public primary
documentation only. It made no authenticated provider request, paid call,
production mutation, credential change or permission change. The production
observations below were supplied in the authorized handoff, not independently
queried here.

## Exact request and version

At base main `75df99a920149b9c63a70625ba62b8594e9b5a27`:

- `package.json`, lockfile and the Mac's installed package identify OpenAI Node
  **7.35.0**. This is the OpenAI API client (`openai`), not the separate local
  Agents SDK runner/session-memory library.
- `src/server/ai/naming-brain/protocol.ts` pins the base URL to
  `https://api.openai.com/v1`, disables SDK retries at client and method level,
  sets organization/project to null, disables logging and rejects redirects.
  The fetch boundary accepts only that origin and `/v1/agents/sessions` paths.
- Installed `openai/src/resources/beta/agents/sessions/sessions.ts` calls
  `POST /agents/sessions`, adding `OpenAI-Beta: agents=v1`. Thus the full target
  is `POST https://api.openai.com/v1/agents/sessions`. The [official quickstart](https://developers.openai.com/api/docs/guides/agents-api/quickstart)
  specifies this same beta header. No alternative cap-capable beta/API version
  was found in the reviewed sources.
- SDK client defaults include Accept/Content-Type, Bearer authentication,
  OpenAI Node/platform identification, retry count and optional timeout headers.
  Embel specifies no additional default headers or dated API-version header.
  SDK 7.35.0 can also read `OPENAI_CUSTOM_HEADERS`; deployed environment contents
  were not inspected, so absence of extra deployment headers is not claimed.
- `prompts.ts` serializes the immutable `providerSpendCapCents` as
  `spend_control.limit`, matching its metadata, policy and hash. It requests the
  original model, `xhigh`, no subagents, no execution environment, low verbosity
  and streaming. Hosted configuration binds `gpt-6-luna` and its default tier.

## Documentation versus runtime evidence

The installed SDK's `SessionCreateParams.SpendControl` describes a positive limit
in USD cents; omission/null means unlimited. `AgentSession.SpendControl.consumed`
is best-effort, floored to whole cents, nullable evidence. Those descriptions do
not establish final invoice cost.

The [official Python session-create reference](https://developers.openai.com/api/reference/python/resources/beta/subresources/agents/subresources/sessions/methods/create)
also exposes `spend_control` and those unlimited-omission semantics. The
[generic HTTP reference](https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/methods/create)
fetched on the same date omits that field. This discrepancy is relevant evidence;
neither reference proves this account's backend accepts or enforces the field.

The supplied Oct 24 evidence records four HTTP 400 `unknown_parameter`
rejections for caps 25/10/10/10 cents, parameter `spend_control`, for job
`e48548f5-628a-47a2-9466-d49d0780e6c9`, run
`e416e2e3-8c4f-47e1-9973-bbca1db1be12`. Receipts retain no session ID and
`not_dispatched`; the job ends `naming_incomplete`, with no AI names. The held
US$5 and null final cost remain unresolved accounting evidence. Actual/captured
zero is not settlement proof. Do not alter those records or infer refunds.

## Historical options under the retired US$5 requirement

1. **Provider-qualified native limit.** Obtain provider confirmation of exact
   endpoint/header/account support and strict limit semantics, including in-flight
   model/tool charges. Retain the immutable cap and conservative cumulative
   allocation (at most 500 cents), exact acknowledgement and no-replay recovery.
   Documentation alone cannot qualify this route; live qualification is outside
   this task's no-paid-call authorization.
2. **New Responses execution contract.** The [Luna model reference](https://developers.openai.com/api/docs/models/gpt-6-luna)
   supports the original model, `xhigh`, structured output and web search through
   Responses. The [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)
   documents `max_output_tokens` including reasoning; the [Responses reference](https://developers.openai.com/api/reference/python/resources/beta/subresources/responses/methods/create)
   documents the built-in tool-call ceiling. These are useful primitives, not an
   automatic dollar cap. A new durable adapter would have to prove a worst-case
   token/tool/cache/tier price bound, freeze it per immutable request, reserve
   each dispatch atomically within US$5, preserve unknown-call holds and prohibit
   replay. Account ownership, cancellation and completed-response recovery would
   need their own validation. Historical Agents requests must remain unchanged.
   This is an architecture change, not a safe one-line replacement.
3. **Remain unavailable.** The current safe choice while either path is unproven.
   Retain manual Naming and saved choices; surface an actionable configuration
   error without offering a generation retry.

The native route needs a provider/account capability decision and separately
authorized qualification; an account-access change is outside this task. The
Responses route needs an architecture decision to replace managed execution,
including research/tool orchestration, immutable admission and recovery. It can
retain `gpt-6-luna` and `xhigh`; a model substitution is neither required by this
proposal nor authorized here. If the required output and research cannot fit a
proved US$5 envelope, changing quality/coverage, model or allowance is a separate
product decision. No such change is silently included in this patch.

## Historical implementation

Web admission checks the known incompatibility before calling an admission RPC,
so blocked starts create neither a job nor a new reservation. An exact
server-qualified saved-membership resume may still reuse saved results; SQL
rechecks its current head/revision. New real session creation and tool-result
submissions that could resume paid work are blocked independently in the
provider adapter. The injected HTTP fixture seam remains for hermetic tests.
Reading/streaming known sessions and cancellation remain available. Existing
immutable requests, allocations, uncertain calls and unsettled holds are retained.

Fixed safe configuration classifications persist in existing stage evidence and
are projected through owner/project/job-checked reads. The UI shows the blocker
after reload and offers a status check instead of generation Retry. This is
safer failure handling, **not restored AI generation**. Re-enablement requires a
reviewed code change with demonstrated enforcement; there is no environment
toggle that strips the cap or enables an unlimited fallback.

OpenAI's [per-run Responses spending-controller cookbook](https://developers.openai.com/cookbook/articles/per_run_spending_controller_responses_api)
illustrates pre-reserving a conservative maximum with exact arithmetic and
retaining unknown-charge holds. Its sample uses invented rates and excludes
hosted-tool charges, streaming/background and server-managed Agents execution;
it is not a ready-made proof for Embel. Any Responses proposal must address
those gaps, including research search charges, before enabling dispatch.

[Organization/project spend limits](https://developers.openai.com/api/docs/guides/spend-limits)
are useful defense in depth, but enforcement can lag and allow overshoot. They
cannot prove this run's exact US$5 ceiling and would require out-of-scope account
configuration. Timeouts, prompt instructions, cost estimates and eventual
cancellation likewise do not prove a monetary bound or settle actual charges.
