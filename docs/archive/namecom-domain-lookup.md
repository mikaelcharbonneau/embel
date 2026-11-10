> Archived November 10, 2026: describes the system before the generation engine.

# Optional Name.com domain lookup

Prepared 2026-10-15 against production source checkpoint `1fc26550225a70c2c5dbdd6880c91ee6069408ee`. This is a read-only availability/pricing addition. It creates no account, credential, environment setting, migration, purchase, reservation, renewal, transfer, webhook or deployment. The existing Vercel connection remains selected unless Name.com is explicitly enabled with valid production configuration.

## Contracts and behavior

- The authenticated, same-origin `/api/standalone-checks` interface and owner/session fences are unchanged. HTTP callers submit one exact domain; they cannot choose credentials, providers, destinations or pricing terms. The safe capability vocabulary adds `namecom`, without exposing configuration.
- When valid production Name.com configuration and its exact enable flag are present, selection is Name.com → configured Cloudflare → Vercel → RDAP → unavailable. When Name.com is disabled, missing, malformed or sandbox-configured, the existing Cloudflare → Vercel → RDAP order is unchanged. An enabled provider failure does not silently invoke another provider.
- The isolated server adapter sends `POST https://api.name.com/core/v1/domains:checkAvailability` with `domainNames`. The colon is literal. No purchase-type filter is sent, so aftermarket, expiring and backorder results can be distinguished from registration. The internal batch helper accepts 1–50 unique exact domains and maps unordered results to the original request order. Missing, duplicate, extra or mismatched domains fail closed. The public HTTP contract has not expanded to batch input.
- Only `purchasable: true` with explicit `purchaseType: registration` can produce registration availability, after successful matching-term pricing. Standard and registry-premium registrations both use `GET /core/v1/domains/{domainName}:getPricing?years=N`. Discovery pricing is never substituted for authoritative registration totals. Premium flags must agree across these observations.
- Terms are explicit: `.ai` requests two years, following the documented minimum; other domains request one year. Unsupported terms fail closed rather than automatically trying another term or inferring a default. A quote always describes that exact requested term. Registration and renewal are each returned totals, never multiplied or combined.
- A null registration price leaves availability Unknown and no quote. A null renewal price may accompany a valid registration quote, clearly labeled renewal unavailable for that term. Missing monetary fields never become invented free prices. Explicit zero is accepted. Negative, sub-cent, unsafe-integer or wrong-type prices fail closed. A Name.com-only raw JSON decoder rejects exponent notation and precision-losing numeric lexemes before JSON parsing can round them; harmless decimal formatting such as `12.90` and `0.00` is retained correctly. Existing providers keep the standard JSON decoder. USD and pre-tax semantics follow the official CORE SDK field documentation and pricing guide.
- Aftermarket variants, expiring and backorder offers remain Unknown for new registration, with their acquisition type and exact flat discovery fee in the evidence detail when supplied. There is no registration quote. The text discloses unverified registration length/renewal terms and possible third-party fulfillment delays or refusal. An omitted acquisition fee is reported unavailable, not zero. No acquisition purchase or renewal flow exists.
- Non-purchasable results and missing purchase types remain Unknown. No unavailable response is interpreted as proof of registration. DNS/Zone Check is never used as registrability evidence. Free-text provider reasons and error bodies are not displayed or persisted.
- Checks and matching quotes are transient, owner/generation-fenced and subject to Embel's one-minute recheck policy. This is not Name.com's TTL, a reservation or a price lock. Prices exclude tax, and future renewal rates may change. Existing save, shortlist, import, export, promotion and purchase restrictions are retained.

## Safety boundaries

Credentials are server-only HTTP Basic username/API-token values, sent only to the two fixed read endpoints. No browser credential, provider URL or caller-controlled header is accepted. Username colons and non-printable/whitespace credentials are rejected; tokens never enter query strings, application output, logs, saved drafts or client bundles. The adapter does not call Create Domain, renew, transfer, DNS, account-balance or account-management endpoints. The implementation does not establish that a Name.com token itself has read-only privileges; qualify its actual account scope separately.

Discovery and all pricing work share one 15-second deadline; response bodies are bounded to 262,144 bytes. At most four internal batch pricing reads run concurrently. Redirects, wrong final URLs, invalid UTF-8/JSON, unauthorized responses and transport errors fail closed. Abort fences publication even if an injected transport ignores cancellation. There are no automatic retries. A provider 429 retains only a transport/clock-scoped cooldown deadline and honors numeric or HTTP-date Retry-After across different domains. No credentials or completed results are retained by that cooldown. The existing process-local owner admission guard remains in place; these guards are not a distributed provider-account quota. A single successful registration lookup normally makes two provider reads.

Sandbox uses `https://api.dev.name.com` only through the isolated adapter helper and its separately supplied configuration. Its observations are labeled `namecom_core_sandbox`, remain Unknown and have no price. The app configuration loader rejects sandbox activation, so sandbox credentials/configuration cannot turn simulated results into live availability or replace the current Vercel provider.

## Secure setup and rollout gates

Server-only configuration names:

| Name | Purpose |
| --- | --- |
| `FLUID_NAMECOM_CHECKS_ENABLED` | Exact `true` opts in after qualification. Missing or any other value keeps Name.com disabled. |
| `FLUID_NAMECOM_USERNAME` | Existing production API username. No `NEXT_PUBLIC_` counterpart. |
| `FLUID_NAMECOM_API_TOKEN` | Approved API token stored through the user's secure hosting secret flow. Never send it in chat or a source file. |
| `FLUID_NAMECOM_ENVIRONMENT` | Optional `production`, also the default. `sandbox` is understood by the isolated helper but deliberately excluded from live app activation. Other values disable Name.com. |

No database migration or worker change is required. Merely adding credential values with the flag absent/false does not select Name.com. Do not change the currently working Vercel flags or credential configuration during preparation.

1. Use the existing Name.com account and official [authentication guide](https://docs.name.com/guides/authentication) to verify API access, token environment, terms, permissions and provider quotas. Any new token, persistent access, required agreement or security setting needs its own authorized secure flow. The account may also hold purchasing privileges: do not claim that this code removes those privileges.
2. Keep two-factor authentication enabled. The dedicated authentication guide describes an API Access toggle for 2FA accounts, while the overview still contains conflicting legacy language. Do not disable 2FA to resolve an error; verify current support guidance instead.
3. Enter approved production secrets only through the existing protected project's secure environment-variable interface. Keep the Name.com enable flag off. No `.env` file or credentials were read, created or changed for this implementation.
4. With explicit live-read authorization and approved secure access, qualify the two read-only endpoints using exact known targets and a small bounded request set. Verify a registration, an unavailable/unknown domain, `.ai`'s explicit two-year pricing, renewal/null handling and an acquisition-type result if available. Do not register domains to manufacture test fixtures. Sandbox observations are not production acceptance.
5. Publish only the verified source through the separately authorized release path, retain existing authentication protection, and enable Name.com only in the explicitly approved target environment after successful qualification. Confirm authenticated capabilities report `namecom`, returned receipts use `namecom_core`, the UI preserves exact terms and prices, and owner-switch/cancellation behavior remains intact.
6. Roll back selection by removing or setting the Name.com flag to false through the authorized configuration flow and refreshing the relevant deployment. Verify capabilities return the prior Cloudflare/Vercel/RDAP selection. Do not delete or alter unrelated provider settings.

## Verification record

The materialized checkout has no `.git` directory. Before edits, all 25 paths in the supplied cumulative production manifest matched their recorded SHA-256 values. The production commit identity above comes from that release receipt, not a fabricated local HEAD. A separate delta manifest and patch are prepared against pre-edit file copies.

All Name.com responses in the automated tests are synthetic, with ambient network access blocked. Coverage includes exact fixed routes/authentication, safe capabilities, disabled/invalid/sandbox configuration, 50-result unordered batches, request/response domain matching, premium and two-year terms, all five acquisition types, null/missing/zero/sub-cent values, privacy/error sanitization, transport/body/redirect bounds, whole-flow deadlines, cancellation, cooldowns, bound browser quotes and preserved existing providers. Final verification passed: 401 focused tests, the full available suite with 737 passed and 5 intentionally skipped disposable-PostgreSQL cases, full TypeScript checking, full ESLint and the production build. An initial concurrent lint/build run hit resource limits (lint exited 137); sequential reruns with a 2 GiB Node heap limit passed. Exact commands and logs are recorded in the release receipt. No authenticated live Name.com call or hosted acceptance has been performed by this implementation.

## Official references reviewed

- [CORE Check Availability](https://docs.name.com/api/v1/reference/domains/check-availability): exact 1–50 domain discovery, literal-colon endpoint, purchase-type filtering and unordered results.
- [Get Pricing For Domain](https://docs.name.com/api/v1/reference/domains/get-pricing-for-domain): explicit 1–10-year supported terms, `.ai` minimum, nullable totals and separation from acquisition pricing.
- [Domain purchase pricing](https://docs.name.com/guides/domain-pricing): registry-premium pricing, registration totals, flat acquisition fees, renewal and tax boundaries.
- [CORE overview](https://docs.name.com/api/v1/overview): production/sandbox separation, omitted default fields, account-wide quotas and errors. Its 2FA advice conflicts with the more focused authentication guide noted above.
- [CORE authentication](https://docs.name.com/guides/authentication): Basic username/token, environment-specific credentials and 2FA API access.
- [Official CORE PHP SDK reference](https://github.com/namedotcom/core-api-php/blob/main/reference.md): USD purchase and renewal field semantics. This app does not install or execute that SDK.
