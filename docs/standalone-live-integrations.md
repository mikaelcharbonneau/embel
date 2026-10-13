# Standalone live integrations

Implemented for the functional-prototype workstream on 2026-10-13, America/Toronto. Existing approved screens, account schemas, imports, selection resets, CSV exports and purchase restrictions remain intact. No credentials, provider accounts, migrations, remote settings or deployments were created or changed.

## Working paths

Authenticated Domains, Handles and Trademarks read safe configuration capabilities from `GET /api/standalone-checks`. Explicit checks use its bounded `POST` route. Ownership comes only from verified Supabase authentication; the response owner must match the active browser owner/generation. No owner, credential, provider URL or provider header is accepted in request JSON. Responses are private/no-store, and POST requires the configured same-origin guard.

| Tool | Implemented provider | Exact result meaning |
| --- | --- | --- |
| Domains | Public authoritative registry RDAP, enabled by default | A matching registration object means Taken for 60 seconds. An HTTP 404, including an empty 404 body, stays Unknown. No price or ownership is inferred. |
| Domains | Cloudflare Registrar, separately enabled and credential gated | Current registration eligibility may mean Available for 60 seconds. Restrictions, reservations, premium exclusions and unsupported extensions remain Unknown with the supplied reason. Exact supported annual prices may be inspected separately. |
| Handles | YouTube Data API, separately enabled and credential gated | A found channel or an empty successful lookup records a profile observation. Both leave availability, reservation and ownership unknown. Other platforms keep manual profile links. |
| Trademarks | EUIPO Trademark Search 1.1.0, separately enabled and credential gated | Exact verbal-name research for European Union marks only. Returned records are possible conflicts to review; national registers and similar names are not searched. Results are always partial because dataset freshness is not supplied. |

RDAP uses fixed IANA-reviewed service URLs for `.com`, `.net`, `.org`, `.app`, `.dev`, `.ca`, `.ai` and `.uk`. Only direct two-label names, plus `.co.uk`, `.org.uk` and `.me.uk` shapes, are dispatched. Other extensions and subdomain shapes return unsupported. The client does not fetch candidate websites or follow registry redirects/links. Contact/person data in registry responses is discarded.

Cloudflare prices are captured in the same authoritative check response and retained only in that adapter instance. The existing quote control displays this matching provider price while both check and price remain current. It does not make a second registration request. Decimal conversion supports USD, CAD, EUR and GBP without rounding; unsupported exponents or malformed prices remain Not quoted. Quotes expire after 60 seconds, bind the exact domain/provider/check, and state that registry rates, taxes and final checkout terms require confirmation. Purchases remain disabled.

EUIPO uses production endpoints only, with a request-local client-credentials token and the official Search API. The RSQL query escapes quoted literals, rejects wildcard intent and requests only exact names, EU trademark records and requested Nice classes. The present UI deliberately searches all classes: free-text goods and classification notes are not guessed into filters. Records must match the exact normalized name and requested classes; page counts, cursors, identities and response bounds are validated. Up to five sequential pages retain at most 500 records. A later failure retains earlier validated pages. Dataset date and Nice edition remain unknown; legal clearance is always `not_assessed` and filing is `not_submitted`. Canadian, US, EU and WIPO manual registry links remain available.

## Persistence and execution boundaries

Provider evidence is transient and separate from manual account drafts. Domain checks/prices disappear on a new search or owner/session remount. Handle comparison checks remain visible, but saving a bundle copies choices without provider observations; existing strict codecs continue to reject forged check history. Trademark results reset with research criteria or account generation and are not included in dossier save/export/review. No immutable provider-evidence persistence is claimed or introduced.

Every provider response has a 15-second deadline, a 262,144-byte decoded body ceiling, no automatic retry, redirect refusal and sanitized failures. EUIPO's token and all pages share the existing 15-second research deadline. Browser requests have their own bounded response reader and 20-second deadline; existing Domain/Handle per-check and bulk sequencing limits still apply. Cancellation and owner/generation fencing prevent late publication even if transport ignores abort.

The read-only API adds a process-local guard: one active lookup and 30 admitted lookups per minute per owner, with 120 per minute for that process. This is an abuse guard, not a distributed billing quota; separate server instances can have separate counters. Credentialed providers require dedicated explicit enable flags. Production operator qualification must confirm provider access/quota/terms before enabling them. No background job, purchase, reservation or filing runs through this route.

## Exact remaining settings

Names only were inspected in process configuration and `.env.local`; none of the credentialed provider settings below were present. No secret value was read or emitted.

| Provider | Server-only settings | Required preparation |
| --- | --- | --- |
| RDAP | None. Optional `FLUID_RDAP_CHECKS_ENABLED=false` disables it. | Hosting must be able to reach the allowlisted public registries. |
| Cloudflare | `FLUID_CLOUDFLARE_CHECKS_ENABLED=true`, `FLUID_CLOUDFLARE_ACCOUNT_ID`, `FLUID_CLOUDFLARE_API_TOKEN` | Existing selected account plus an account-scoped token authorized for the read-only domain-check endpoint. Qualify actual permission/access/terms before setting the flag. Do not enable registration or purchase. |
| YouTube | `FLUID_YOUTUBE_CHECKS_ENABLED=true`, `FLUID_YOUTUBE_API_KEY` | An approved Google project with YouTube Data API v3 enabled and a suitably restricted server key. The key is sent in `X-Goog-Api-Key`, never a URL. |
| EUIPO | `FLUID_EUIPO_CHECKS_ENABLED=true`, `FLUID_EUIPO_CLIENT_ID`, `FLUID_EUIPO_CLIENT_SECRET` | Approved production Trademark Search 1.1.0 subscription. EUIPO documents free API access, sandbox qualification and production subscriber review; no signup or identity documentation was submitted here. Sandbox credentials must not be used as live evidence. |

Cloudflare remains the recommended registrar connection; YouTube is the first supported social lookup. EUIPO is a concrete official automated trademark source for EU coverage only. A Canadian/US automated keyword source is not selected. USPTO TSDR case retrieval is not keyword screening; WIPO explicitly disallows automated portal queries. No scraper or bot-protection workaround was implemented.

## Verification

191 focused tests passed across provider/API/client/UI and preserved Domain/Handle/account-promotion regressions. Tests cover owner/target mismatches, same-origin/body boundaries, redirect/error/empty-404 responses, ignored cancellation/deadlines, quota admission, quote precision/expiry, missing social profiles, exact EUIPO queries/coverage, partial page retention and manual bundle persistence after checks. All credentialed provider replies in these tests are synthetic. Scoped ESLint and the focused TypeScript check passed. Root owns the integrated application checks.

The real credential-free RDAP smoke used verified TLS and Node's documented environment-proxy support: `example.com` returned an exact registration record and Taken; the unique negative probe returned HTTP 404 and Unknown. Native fetch without the required cloud environment proxy failed safely. The final sanitized live receipt is `/workspace/scratch/fluid-functional-workstreams-20261013/standalone-integrations/rdap-live-smoke-final.json`. No contact records were saved. This validates the adapter/network path, not hosted signed-in browser acceptance. Cloudflare, YouTube and EUIPO credentialed live acceptance remain unrun until configured.

No shared Next build or full application suite was started by this workstream. Root owns aggregate build, deployment and hosted acceptance. Sources and the official downloaded EUIPO specification are in the same scratch evidence directory.

## Official sources reviewed

- [IANA domain RDAP bootstrap](https://data.iana.org/rdap/dns.json), publication `2026-09-30T23:00:03Z`; [RDAP HTTP negative answers, RFC 7480 §5.3](https://www.rfc-editor.org/rfc/rfc7480.html#section-5.3).
- [Cloudflare Registrar domain check](https://developers.cloudflare.com/api/resources/registrar/methods/check/): authoritative read-only eligibility and annual price fields; no registration is performed.
- [YouTube channels.list](https://developers.google.com/youtube/v3/docs/channels/list), `forHandle`, one quota unit per lookup; [Google API system parameters](https://docs.cloud.google.com/apis/docs/system-parameters) for header-based API keys.
- [EUIPO Trademark Search 1.1.0](https://dev.euipo.europa.eu/product/trademark-search_110/api/trademark-search), [official production specification](https://dev.euipo.europa.eu/product/28099/download-specs), [security](https://dev.euipo.europa.eu/index.php/security), [onboarding](https://dev.euipo.europa.eu/getting-started), [access/cost and production review FAQ](https://dev.euipo.europa.eu/faq). Production OpenAPI SHA-256: `3165880fae2b2a6491523af5c82632f3f3478052e5e90fa46c9e6e473e4104e4`. Its exact production token URL is `https://euipo.europa.eu/cas-server-webapp/oidc/accessToken`; the generic guide's sandbox hostname is not reused.
- [WIPO Global Brand Database FAQ](https://www.wipo.int/en/web/global-brand-database/faqs_branddb), [USPTO trademark bulk-data access](https://www.uspto.gov/trademarks/apply/check-status-view-documents/trademark-bulk-data), [Canadian trademark database](https://ised-isde.canada.ca/cipo/trademark-search/srch?lang=eng).
