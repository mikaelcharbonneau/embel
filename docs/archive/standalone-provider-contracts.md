> Archived November 10, 2026: describes the system before the generation engine.

# Standalone provider contracts: local acceptance packet

## Scope and status

P6 implements **injected, server-only contracts**, not enabled integrations. There is no runtime registration, API route, database writer, UI import, environment lookup, credential use, real provider request, purchasing operation, account creation or trademark filing in this package.

The existing manual Domains, Handles and Trademarks codecs and UI remain unchanged. Provider observations do not enter `StandaloneWorkspace.payload`. Existing draft/mutation byte limits are unchanged. No dependency, migration, deployment, commit or push is included.

The shared envelope and target types come exclusively from `src/domain/standalone-provider-evidence.ts`. This package consumes that implementation and creates no competing envelope schema.

## Implemented files

- `src/server/standalone-providers/contracts.ts`: strict feature schemas, constructor inputs, reviewed trademark source port and bounded shared helpers
- `src/server/standalone-providers/bounded-request.ts`: injected fetch, allowlisted requests, deadline/body bounds and sanitized failures
- `src/server/standalone-providers/registrar-check.ts`: registrar eligibility exemplar
- `src/server/standalone-providers/social-profile.ts`: YouTube profile observation exemplar
- `src/server/standalone-providers/trademark-search.ts`: unbound research-source port and bounded aggregation
- `src/server/standalone-providers/projections.ts`: read-only compatibility projections, with no consumers registered
- `tests/server/standalone-providers/{bounded-request,registrar-check,social-profile,trademark-search,projections}.test.ts`
- `tests/server/standalone-providers/fixtures.ts`: deterministic synthetic responses; never imported by production

All six production modules begin with `import "server-only"`.

## Request boundary

The only request discriminants are:

- `cloudflare_check`: POST to the fixed Cloudflare account registrar check path, a validated 32-hex account identifier and one canonical ASCII domain
- `youtube_channels`: GET to the fixed YouTube channels endpoint, `part=id` and a validated exact handle

There is no arbitrary request URL, authentication/header input, default/global fetch, redirect acceptance, retry or environment configuration. The caller must supply the transport and clock. An eventual authenticated transport remains a separate reviewed dependency.

Each request uses `redirect: error`, `cache: no-store` and `credentials: omit`. The entire dispatch and decoded body read is fenced by a 15-second deadline and caller cancellation. Work that ignores abort cannot publish a late result. Cancellation also prevents the scheduled transport from beginning if it has not dispatched yet. Reader cancellation/release and timer/listener cleanup are tested.

Decoded response streams are limited to 262,144 bytes regardless of Content-Length. JSON content type, valid UTF-8, a successful HTTP status and valid JSON are required. Responses are SHA-256 hashed from the bounded bytes. Only a bounded `cf-ray` identifier can be retained for the registrar; YouTube retains no response header identifier. Failure results contain fixed codes and bounded Retry-After integers, never raw error messages, headers, response bodies or credentials.

401/403 map to `not_authorized`; 429 to `rate_limited`; server/network errors to `transport`; returned redirect responses and malformed/non-JSON/oversize responses to `invalid_response`. Native fetch may reject a redirect under `redirect: error` before returning a response; that opaque rejection remains `transport`. Error-message text is never inspected to guess the cause. Both forms fail closed without a redirected request or a positive observation. Integer Retry-After is capped at 86,400 seconds; date strings and malformed values become null. Invalid target/configuration values throw fixed-message TypeErrors before dispatch. Nonfinite/unrepresentable or backwards measured clocks throw a fixed-message RangeError rather than manufacturing timestamps.

## Registrar: eligibility only

The contract uses the documented Cloudflare wire shape as an **exemplar**, not a selected or enabled product provider. The [official Check endpoint documentation](https://developers.cloudflare.com/api/resources/registrar/methods/check/) was inspected on 2026-10-07 solely to verify wire semantics.

The returned domain field is `name`. Successful eligibility omits `reason`; this is normalized to `{ eligibility: "eligible", reason: "eligible" }`. An ineligible result must retain one of the five documented restriction reasons. Unknown reasons, contradictory eligibility, missing/wrong/extra/duplicate domains, provider-envelope additions or unsuccessful envelopes fail closed. Optional documented pricing/tier fields are accepted within explicit bounds and discarded.

The observed timestamp is measured local lookup completion, not an upstream publication date. Operational freshness is 60 seconds, with equality at expiry stale. Ineligibility is not translated into “Taken”; it can describe a reserved domain, premium restriction or unsupported extension. Eligibility is no guarantee of reservation, price, registration, exclusivity or ownership. The adapter exposes only `check`.

## Handles: profile observations only

The YouTube exemplar accepts only a bounded `youtube#channelListResponse` containing zero or one `youtube#channel` ID. Pagination, malformed IDs/resources, extra resources and error envelopes fail closed. Only the ID is retained; no person/profile metadata is saved.

A found profile and an empty successful lookup both preserve `availability: unknown`, `reservation: unverified`, `ownership: unverified`. A 404 response does not establish profile absence or handle availability. HTML login/CAPTCHA responses, redirects, blocked and rate-limited lookups remain failures. The other four existing platforms return `unsupported_target` without dispatch. No public profile HTML is fetched.

Freshness is a 3,600-second operational display policy. Actual account access, quota and terms were not tested. The [official channels.list documentation](https://developers.google.com/youtube/v3/docs/channels/list) is the wire reference, not proof of any handle-reservation or ownership capability.

## Trademarks: unbound source with explicit research coverage

No real `ReviewedTrademarkSource` is shipped. A null source returns `unavailable`. A future source must supply reviewed provider/version, documentation URL, terms reference, exact record hosts, jurisdiction identifiers, Nice edition and a source-specific readPage implementation. This port does not select or license a search dataset. Case-status access is not repurposed into keyword search, and no registry portal is scraped.

A search uses at most five sequential pages, 100 hits per page, 500 retained hits, 262,144 compact UTF-8 bytes per page payload and a single 15-second total deadline. There are no retries. The effective query intersects requested jurisdictions with reviewed source coverage; no overlap returns `unsupported_target` without calling the source. The outer request and original accent/class intent remain unchanged.

Every page must match the effective exact-word query and reviewed source identity/version/URL. Page rights basis must agree across receipts. Declared coverage must be within that query; record jurisdictions must belong to the page. Duplicate record IDs within a jurisdiction, repeated cursors, query drift, future timestamps, incompatible page completeness and over-bounds pages fail closed. Record URLs require exact allowed public HTTPS DNS hosts, without credentials, query, fragment or a nonstandard port. They are retained as evidence and never fetched.

Successful earlier pages/hits survive later timeout, cancellation, rate limit or malformed pages. A safe failure receipt records the interruption. Late pages are never published. Missing coverage, page limits, stale or unknown page freshness and stale or unknown dataset dates all produce `partial`. `coverage.searched` is added only after a validated page; `coverage.missing` retains every requested jurisdiction not actually covered. A complete final page alone cannot claim unsearched territories.

Aggregate provenance hashes the ordered normalized successful page receipts. It uses the exact reviewed provider/version/source, agreed page rights basis, minimum known check/expiry timestamps, measured completion time and no aggregate provider request ID. Missing check/expiry times stay unknown; expiry is null if any retained page has unknown expiry or the earliest expiry is at/before completion. Otherwise it is capped at 24 hours after completion. Historical page timestamps stay unchanged.

`legalClearance` is always `not_assessed`, and `filing` is always `not_submitted`. Complete empty research means only no returned matches for the exact query and documented coverage. It makes no global no-match, similarity-screening, legal clearance, registrability, filing or registration claim.

## Compatibility and persistence fences

Both projection boundaries reparse targets, provenance and feature payloads. They require the exact exemplar provider/version/documentation/rights tuple and bounded freshness:

- A fresh exact eligible domain observation may project to the legacy `DomainCheck` available value. Digest supplies both check identity and evidence reference. Ineligible observations project to unknown; stale, future, invalid and wrong-target observations project to null. A shared-valid sub-millisecond receipt that cannot satisfy the legacy millisecond check schema also returns null instead of throwing or rounding into a positive claim.
- A fresh found profile projects to unknown; an empty successful profile lookup projects to `profile_missing`. Failed/stale/invalid/wrong-target observations produce unknown with no confirmed check timestamp or asserted authority.

Neither helper creates `taken`, `confirmed_available`, `accountCreated`, an order, quote or trademark review marker. Legacy `handleStatus` lacks independent evidence expiry; this package does not silently redefine that behavior. A trusted owner-bound immutable evidence persistence writer does not exist here. Therefore these helpers must not be wired around the manual codecs as a shortcut.

Existing manual-codec rejection and trademark preview rebuilding are tested directly: provider envelopes cannot be saved through a manual draft, any nonempty Handle evidence array is rejected, and a forged research claim is rebuilt to the existing unavailable manual preview.

## Local verification evidence

All tests use synthetic `.test` targets and injected responses/ports. Every test file stubs global fetch to throw on unexpected ambient use. No provider credentials, live accounts, paid access, real mark searches or registrations were involved.

Executed 2026-10-07 in the supplied dot-cloud source snapshot:

- Each new adapter/test group was run before its module existed and failed for the expected missing-module condition.
- Two final regressions were observed failing before fixes: abort between scheduling and dispatch still invoked the transport; an extended-year clock produced a timestamp outside the shared ISO schema. Both were fixed and retested.
- `npm test -- tests/server/standalone-providers --maxWorkers=1`: **5 files, 62 tests passed**.
- `npx eslint src/server/standalone-providers tests/server/standalone-providers`: **exit 0**, no lint findings.
- Independent-review regression: a shared-valid `.000000Z` check with `.000001Z` expiry reproduced a legacy projection exception. The projection now uses `safeParse` and returns null for that unrepresentable receipt. The regression failed before the fix and passed afterward. An additional test pins opaque fetch redirect rejection to sanitized `transport`; returned redirect responses remain `invalid_response`.

The environment printed an npm `http-proxy` configuration deprecation warning. It did not change or fail the tests. The source snapshot has no `.git` metadata; no commit/diff claim is made.

The parent integration owner retains aggregate typecheck, full regression suites and production build ownership. These scoped results are not evidence of live provider behavior, hosted persistence or UI activation. No browser or hosted acceptance was claimed.

## Required decisions before real-service activation

1. Chosen registrar, actual check access/cost, account scope and least-privilege authenticated transport.
2. Social API credentials/terms/quota, and capability per platform. Profile lookup alone remains insufficient for reservability or account ownership.
3. Trademark searchable API/license, jurisdictions, Nice edition, dataset freshness/retention and reviewed provider-specific wire decoder.
4. Owner-bound immutable observation storage, enforced RLS/CAS/replay and response/session cancellation fences.
5. Explicit UI action, bounded rate/cost admission, secure credential setup and any exact hosted permission changes.

These are withheld bindings, not successful real-service checks. Purchases, payments, domain registration, account reservation/creation, legal clearance and trademark filing require their own reviewed contracts and approval.
