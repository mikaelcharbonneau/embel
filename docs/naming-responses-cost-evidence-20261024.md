# Responses cost qualification — 2026-10-24

> Historical: retired by the November 2026 Naming generation rebuild (docs/naming-generation-contract.md).

Historical investigation only: the user's October 25 correction rejects monetary
limits. [Native Naming restoration](naming-native-restoration-20261025.md) uses
the existing uncapped Agents flow. The qualification and research-mode decision
below are not requirements for that release.

## Conclusion

The reviewed public sources support bounded generated tokens and built-in tool
counts for `gpt-6-luna` with `xhigh`. They do **not** establish a numeric upper
bound for cumulative billable input/search-content tokens across hosted research
inside one Responses request. Therefore the complete Naming research envelope is
**unqualified**, and real dispatch must remain disabled. A correct integer ledger
cannot turn an unproved input quantity into a guaranteed US$5 limit.

This investigation fetched public primary documentation and inspected installed
OpenAI Node 7.35.0. It made no authenticated provider request, model call,
production mutation or credential change. Account access is untested.

## Published rate facts

[Pricing](https://developers.openai.com/api/docs/pricing), fetched October 24,
lists these USD prices per million Luna tokens:

| Processing | Uncached input | Output | Cache read | 30-minute write | 12-hour write |
| --- | ---: | ---: | ---: | ---: | ---: |
| Standard | 0.10 | 0.50 | 0.01 | 0.125 | 0.25 |
| Flex/Batch | 0.05 | 0.25 | 0.005 | 0.0625 | 0.125 |
| Fast/priority | 0.20 | 1.00 | 0.02 | 0.25 | 0.50 |

The same page prices web-search calls at US$10 per thousand, plus content tokens
at the selected model's input rates. Its fixed 8,000-token search-content rule
applies to named older mini models, not Luna. Regional/FedRAMP premiums are 10%;
they are outside a global-endpoint Standard-only qualification.

The [Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna)
states 1,050,000 context tokens, 128,000 maximum output tokens and `xhigh` support.
Requests above 272,000 input tokens use twice the input/cache rates and 1.5 times
the output rate for the whole request. It supports Responses web search and
structured output. The page names `gpt-6-luna` rather than a separate dated
snapshot, so a reviewed rate/capability validity policy is still needed. Preserving
this model does not establish access for the account.

The [prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
explains that write prices replace ordinary input prices for those tokens; they
are not additional surcharges. Default implicit caching can create write charges.
An explicit-only request without breakpoints creates no cache writes or reads.
Thus a deliberately frozen `prompt_cache_options: { mode: "explicit", ttl:
"30m" }` and no content breakpoints can avoid relying on cache discounts. The
guide supports 12-hour writes, while the current API reference/SDK comments still
call 30 minutes the only supported TTL. Do not use the conflicting TTL to justify
a smaller reserve; retain both published write rates as evidence.

## Exact arithmetic, conditional on complete quantities

Use integer nanodollars internally. Standard short-context rates are 100
nanodollars per uncached input token, 500 per output token, 10 per cached token,
125 per 30-minute-write token and 250 per 12-hour-write token. A search-call fee
is 10,000,000 nanodollars. US$5 is 5,000,000,000 nanodollars.

For an explicit no-cache request with qualified bounds `N` on **all billable
input**, `O` on all generated tokens and `K` on billable search actions:

```text
maximum_microusd = ceil((100*N + 500*O + 10_000_000*K) / 1_000)
```

Use the long-context rates when the total input can cross 272,000; do not apply
the short rate to a large hidden search transcript. Round each reservation up,
lock the run before adding it, and never replenish from estimated/unknown usage.
The formula is **not a qualified hosted-research envelope** because `N` remains
unproved. An exact initial prompt count does not bound subsequent internal input.

## What the API actually bounds

The [Responses create reference](https://developers.openai.com/api/reference/python/resources/responses/methods/create)
and installed SDK `src/resources/responses/responses.ts` specify a total
`max_output_tokens` ceiling including reasoning, and a total `max_tool_calls`
ceiling across built-in tools. Excess built-in calls are ignored. The
[reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)
also includes non-visible formatting in the generated-token ceiling. A function
result sent by the application is a separate explicit request, not free implicit
continuation. Set `service_tier: "default"` explicitly; omitting it selects
project-controlled `auto`. Fast is also requested with `priority`.

The [web-search guide](https://developers.openai.com/api/docs/guides/tools-web-search)
describes agentic search, `search`/`open_page`/`find_in_page` actions and a 128K
search context window. Search actions incur tool charges; reserving a search fee
for every permitted built-in call is conservative for that fee. However:

- `search_context_size` is qualitative (`low`/`medium`/`high`), not a token cap.
- `return_token_budget` accepts `default` or `unlimited`; numeric values are
  rejected, and the default token quantity is not published.
- The context window limits available context at a point in execution. It does
  not, in the reviewed sources, cap cumulative billed input across internal model
  passes or guarantee that a maximum of `K` tools means exactly `K+1` billed
  passes. Such a multiplier would be an inference requiring provider confirmation.

Neither `initial_count + K*128000` nor `(K+1)*1050000` is documented as the total
billable-input ceiling. Do not silently promote either expression into proof.

## Counting and qualification limits

The [token-counting guide](https://developers.openai.com/api/docs/guides/token-counting)
says the endpoint counts the exact request format, including structural framing
that local tokenizers may omit. Installed SDK `responses/input-tokens.ts` accepts
instructions, tools, structured text config, reasoning and prior-response context.
Freeze the same model/input/configuration when using a count witness. The count
does not predict future hosted-search content. No reviewed pricing or counting
page explicitly establishes this endpoint as free; do not assume zero cost or
send real count calls under the present no-provider-call boundary.

The official [per-run controller cookbook](https://developers.openai.com/cookbook/articles/per_run_spending_controller_responses_api)
illustrates exact reservation arithmetic and retaining unknown-call holds, but
its sample excludes hosted-tool charges, streaming/background, cache writes,
regional/nondefault tiers and server-managed Agents. Its sample rates are not a
substitute for a qualified production tariff or completed billing evidence.

## Decision needed before enabling required research

Obtain provider-supported guarantees for (1) cumulative billable input, including
hosted search and any internal reprocessing, and (2) its relationship to the
enforced tool/output caps. Alternatively, separately approve a research design
whose search execution and every model continuation are application-controlled
and have independently proven prices and input bounds. Replacing research with
no search, changing models, lowering the 100-name target, or relying on prompt
instructions is not an authorized substitute. Price/capability expiry or an
unknown tariff, tool or tier must fail closed before dispatch. Mocked success
and usage observations never qualify prices or settle historical holds.

## Existing research integrations inspected before proposing a replacement

This inventory is limited to tracked source/documentation at merged main
`16b2298bdf3f11bd29bde1e0256d18c6638eea99`. No environment files, credentials or
live services were inspected. An implementation is not itself evidence of live
account access or approval for a different purpose.

| Existing component | What the tracked implementation establishes | Research limitation |
| --- | --- | --- |
| Naming `prompts.ts`, `protocol.ts` and `progressive-research-instructions.ts` | OpenAI-hosted `web_search` discovers references; `read_reference` retains actual text for facts and verification. Instructions require source keys and truthful gaps for selected factual approaches. | This is the hosted search whose cumulative-input cost remains unqualified above. |
| Naming `source-reader.ts` and `reference-invocation.ts` | A bounded HTTPS reader for reviewed reference hosts/paths, tied to a real session/turn/item observation or the existing trusted local invocation witness. | It fetches a known URL; it is neither a general search index nor currently an application-only discovery tool. |
| `standalone-providers/live-runtime.ts` and its adapters | Domain/registrar/RDAP checks, YouTube handle lookup and EUIPO trademark lookup have separate narrow contracts. | None is a general web-search source for Naming. Their existence does not authorize repurposing or prove a Naming search price. |
| `inspiration.ts`, `inspiration-catalog.json`, `data/inspiration.ts`, `docs/inspiration-workspace.md` | A curated visual-artwork catalog, text/tag filtering and owner-scoped saved reactions. | It is visual guidance, not live discovery or factual/linguistic Naming research. |
| `identity/reference-source.ts` | The default external reference feed explicitly returns `reference_source_unconfigured`. | It supplies no search results and cannot fill this gap. |

No tracked general-search adapter or approved standalone general-search provider
was found. Source URL attribution, a prepared manual search brief and a plausible
model-generated URL are not retrieved evidence. Historical provider recommendations
in `docs/standalone-manual-tools.md` do not activate a general research source.

## Concrete application-controlled option — proposal only

The following option reuses the narrow reference-fetch capability and owned
evidence rather than adding a paid provider. It changes how sources are found,
so it requires an explicit research-mode decision before implementation or
qualification. It cannot currently be represented as equivalent to hosted search.

1. **Freeze a bounded source plan.** On the frozen brief and selected factual
   approaches, use supplied owned reference URLs and/or one explicitly reserved
   text-only model request to propose at most eight allowed reference URLs. A
   proposed URL is only a fetch request, never a search result or a fact. Return
   strict JSON such as `version`, `requests[{requestKey,url,approach,purpose}]`,
   `unsupportedApproaches` and `uncertainties`; reject unknown fields and paths.
   Retain `gpt-6-luna`, `xhigh` and the final 100-name requirement.
2. **Execute reads in the application.** A proposed run-wide ceiling is eight
   total HTTP attempts across initial research and verification, including failed
   reads. No redirects, retries, link crawling, alternate hosts or credentialed
   search API is added. Persist a truthful new application-fetch witness bound to
   owner/project/run, source-plan hash, request key and exact URL before I/O. The
   current reader's Agents session/turn/item witness must not be fabricated or
   repurposed; a new immutable research/witness version needs its own review.
3. **Supply bounded evidence explicitly.** After reads, make a separate reserved
   text-only response to synthesize territories/facts and later explicit requests
   for Director, Creator, Curator and Verifier work. Each tool-return or evidence
   continuation consumes another model-dispatch slot and its full maximum
   reservation. There is no hosted `web_search`, implicit paid loop, hidden
   continuation, `previous_response_id` or shared mutable conversation. Output
   schemas retain the existing separation of facts, interpretations and unknowns;
   verification requires actual source IDs and exact nonempty UTF-16 quote offsets
   into retained excerpts. An unavailable source cannot support a factual route.

The existing per-read limits are concrete: 262,144 response bytes, at most 2,048
chunks, 15 seconds, and a retained excerpt of at most 16,384 UTF-8 bytes and 8,000
UTF-16 code units. Eight attempts imply at most 2,097,152 raw response bytes and
131,072 retained excerpt bytes. Existing DNS validation allows at most sixteen
public addresses and pins the connection address while retaining the exact TLS
hostname/Host. It rejects compression, non-UTF-8/nontext responses and redirects.
The approved URL forms remain:

| Exact host | Existing permitted path |
| --- | --- |
| `www.merriam-webster.com` | `/dictionary/<single-entry>` |
| `dictionary.cambridge.org` | `/dictionary/<language>/<single-entry>` |
| `en.wiktionary.org`, `en.wikipedia.org` | `/wiki/<entry>`, without a namespace colon |
| `www.britannica.com` | One entry under the existing topic/science/animal/plant/place/biography/art/event/technology/sports categories |
| `www.perseus.tufts.edu` | `/hopper/text`, with required `doc` and only the existing optional `lang`/`highlight` parameters |
| `logeion.uchicago.edu` | One path segment |
| `www.cnrtl.fr` | One entry under `/definition`, `/etymologie` or `/lexicographie` |

Other than Perseus, only the reader's numeric `oldid` query is permitted. No new
path or domain is proposed. A source record keeps canonical URL, actual title and
excerpt, extraction version, response/content hashes, truncation flag, original
retrieval time and the new request witness. A versioned ID derived from canonical
URL/content hash/extractor can identify the same retained content without inventing
provider provenance. Reusing an accessible owned immutable source record can avoid
a new read, but must retain its original timestamp and origin; it is not fresh
search evidence and cannot import another owner's private context. Such an owned
cache is a proposal, not an implemented cross-run capability.

The excerpt total is not an entitlement to exceed a model-request byte limit.
The existing Naming wire policy is 131,072 bytes including the brief, schema,
metadata and attached evidence. Each proposed request must fit its complete
reviewed wire bound or stop before dispatch; mandatory evidence/approach context
must not be silently discarded to make it fit. A different wire limit requires an
explicit versioned contract, not an oversized continuation.

### Concrete model-only ceiling for this option

For each fresh text-only request with no hosted tools or implicit continuation,
reserve against the entire documented 1,050,000-token context, not an estimated
byte/token conversion or a presumed-free token-count call. Freeze Standard
`service_tier: "default"`, explicit caching without breakpoints, the global
endpoint, `gpt-6-luna`, `xhigh` and `max_output_tokens: 32768`. Applying the
documented long-context rates to the full input is conservative even for smaller
requests:

```text
1_050_000 * 200 + 32_768 * 750 = 234_576_000 nanodollars per model dispatch
21 * 234_576_000 = 4_926_096_000 nanodollars = US$4.926096
US$5 - US$4.926096 = US$0.073904 unallocated
```

The proposed hard ceiling is twenty-one model dispatches: one source plan, one
research synthesis, one Director, the existing fifteen independent Creators, one
Curator, one verification plan and one verification synthesis. The eight HTTP
attempts are shared across research and verification. Every evidence/tool-return
continuation consumes its named slot; there is no spare repair or model-call slot.
Atomically reserve the complete maximum before each dispatch, never re-lend an
unknown or estimated charge, and do not use the unallocated difference to create
unplanned calls. The existing public reference reader does not invoke a priced
search API; that is not a claim that arbitrary external services or infrastructure
are free. Any separately priced source would need its own approved maximum inside
the same aggregate budget before use.

This arithmetic bounds the proposed model-only requests under the documented
rate/capability assumptions. It does **not** prove that all existing approach
coverage, real research and 100 approved names can finish within those fixed slots.
The fifteen initial Creator assignments are retained, not collapsed to fit the
budget. That fit remains a reviewed orchestration/evaluation
requirement; exhausting slots or unsupported factual routes must produce honest
incomplete/unavailable work, not fewer promised names, fabricated sourcing, model
changes or extra budget. Production qualification also retains explicit expiry
and fail-closed rules for unreviewed rates/capabilities.

### Minimum decision, without provisioning anything now

Choose whether to approve this **reference-fetch research mode**, accepting
bounded source proposals/owned evidence instead of an open-ended search index,
or retain hosted-search-equivalent discovery as a requirement. The former needs
new truthful app-fetch provenance and a separately reviewed orchestration; the
latter needs provider-supported hosted-input bounds or a separately approved
bounded search source with published per-call/result limits, price and terms.
No such standalone source is currently approved in the inspected repository, so
no equivalence or concrete search-provider price can be claimed. A later source
proposal would freeze query count, maximum results/pages, response bytes, excerpt
bounds, per-query maximum charge and source provenance before any integration.
No provider selection, paid provisioning, credential change, implementation or
real fetch is part of this proposal.
