> Archived November 10, 2026: describes the system before the generation engine.

# Domains live prices and saved shortlist

## Approved scope and source checkpoint

On 2026-10-15 the user assigned the implementation of live domain availability, registration/renewal pricing and saved shortlists. Purchases are excluded. This candidate extends the current-production PR 11 source at `52b85b8f70f5a01445e4d2a6f8f640196fd5af2b` (`codex/standalone-manual-tools-20261012`); repository `main` is an older checkpoint. It is a separate delta for review, not authorization to merge PR 11, apply hosted SQL, change deployment configuration or publish this candidate.

The existing Guided Browser layout, account session lifecycle, imports, manual source promotion, CSV export and purchase-evidence library are preserved.

## Live lookup

The existing authenticated, same-origin `/api/standalone-checks` API uses Vercel's public read-only domain-search endpoint by default. No provider account, token or new persistent access is required. A configured Cloudflare connection retains precedence; `FLUID_VERCEL_DOMAIN_CHECKS_ENABLED=false` explicitly disables Vercel and retains the existing RDAP fallback when enabled. The existing saved-project Naming screening route uses this same domain runtime, retaining its owner authorization and before/after saved-basis rechecks. Handles and Trademarks configuration is unchanged.

Only the exact canonical domain name is sent to Vercel. No account ID, search prompt, project context, shortlist content or credentials are attached. App responses remain private/no-store. The adapter has no purchase, reservation or management endpoint.

Vercel's response is validated against the exact domain and strict boolean/number fields. Its `available: false` means unavailable **or unconfirmed**, so the UI retains Unknown and explains the reason. Missing, mismatched, malformed, cancelled or failed responses establish no availability or price. Premium is retained as provider detail without changing that meaning.

USD is documented by the endpoint. Registration and renewal are totals for the returned term, including two-year `.ai` quotes. No annualization, exchange rate, estimated amount or hardcoded price is used. Renewal means today's quoted renewal total, not a future guarantee. Taxes and final checkout totals are unverified. The one-minute check/price freshness window is an Embel recheck policy, not a registrar promise or reservation.

The existing bounded response reader, 15-second provider deadline, exact-target fencing, one-active-lookup/30-per-minute owner guard and 120-per-minute process guard remain. Only simultaneous exact reads are deduplicated; completed provider observations are not cached. A provider 429 establishes a transport-scoped cooldown honoring numeric or standard HTTP-date Retry-After (60 seconds if missing/invalid). No automatic retries occur. This process-local guard is not a distributed provider quota.

Search prepares exact candidates as before. The prominent **Check availability & prices** action runs bounded sequential checks and displays returned prices together immediately. A timeout, cancellation, transport failure or limit stops the sequence with completed evidence retained. **Continue remaining checks** resumes the unchecked tail, including the failed row, rather than restarting the first 30. A visible countdown disables bulk retry during the returned cooldown. Exact per-row rechecks remain available and the server enforces the upstream cooldown independently.

## Shortlist and persistence

The new Shortlist view contains manual saved domain choices. The existing Library still contains only registrar-confirmed Embel purchases. Nothing in a shortlist implies a reservation, purchase or registration.

The version-1 manual draft gains an optional `shortlistedDomains` array. Old four-key payloads are read without adding a default field or changing their replay identity. New choices must be canonical unique domains, at most 200, within the existing 24,000-byte complete-draft limit. Search changes and saved-name imports preserve choices. Only domain names persist; checks, prices, provider evidence and order state never enter account drafts. Reopening the account workspace requires fresh checks.

Adding/removing a choice updates the owner-fenced draft. The existing explicit **Save draft** action persists it with the same owner-derived API, CAS revision and original request-key recovery. No direct browser storage, new table, RPC, role or grant is introduced. Unsaved changes participate in the existing account-switch/sign-out/recovery behavior.

A shortlist-only domain cannot bypass saved-result promotion membership. Its Create brand action is disabled until the user explicitly uses it in the current search and saves through the existing flow.

The additive migration `20261015180500_domain_shortlists.sql` narrowly updates the Domains branch of `fluid_private.standalone_payload(text,jsonb)`. It guards the exact prior body, accepts legacy and optional-shortlist shapes, independently validates bounds/syntax/duplicates, preserves installed function metadata/owner/ACL, and fails on an unexpected definition. No historical row is rewritten.

## Activation and rollback requirements

1. Review this source delta against the pinned production revision; preserve unrelated PR 11 functionality. Complete normal source publication approval separately.
2. Obtain approval to apply the new migration to the intended existing database. Inspect its current validator and rehearse the forward migration against the actual installed history. This candidate has not changed hosted SQL.
3. Deploy a separate protected preview after the migration succeeds, without replacing the current live application. The additive validator does not rewrite any legacy payload. However, old strict application readers cannot read a newly saved fifth-key payload: **do not Save draft with a shortlist using any owner who still uses the old production app.**
4. Default preview acceptance is live lookup plus in-memory shortlist editing only. Search a known registered domain and a fresh candidate, inspect term/renewal semantics, and check a batch exceeding 30 candidates with tail continuation after cooldown. Hosted shortlist save/reload, conflict and owner-isolation acceptance may run only under a specifically authorized preview-only test owner; do not create an account implicitly or reuse an existing production-used owner. Otherwise defer those hosted writes until coordinated live reader rollout. Synthetic persistence tests already cover the local contract but do not substitute for hosted acceptance.
5. After separate live-rollout approval, deploy updated readers/writers together and finish authorized save/reload acceptance. Do not route active users back to old readers once shortlists have been saved; retain the updated codec in any rollback. Do not remove the validator extension or drop saved selections as a rollback shortcut. No hosting protection, provider credential, account, paid service or purchase change is part of this read-only integration.

## Verification boundaries

Local provider, API, client/DOM, codec and real-migration PGlite tests cover strict negative results, exact matching, pricing terms/precision, cancellation, limits/cooldown, a 33-domain resume, save/reload/legacy replay, CAS/idempotency, owner isolation and evidence-injection rejection. Fixtures are explicitly synthetic. PGlite does not prove hosted database role/pooler/concurrency behavior.

The public Vercel contract was independently checked with an unauthenticated read-only call on 2026-10-15: a registered domain returned false, a fresh `.com` candidate returned a one-year quote, and `.ai` returned a two-year total. These were transient test observations, not application seed data or durable prices. Application production-origin acceptance remains separate.

The dedicated headless Chromium regression harness bundled successfully but this cloud executor refused Chromium's required local IPC socket (`EPERM`), including the approved elevated launch. No browser assertions or visual acceptance are claimed. Browser checks and responsive screenshots remain for the separately approved protected preview. Final source qualification passed full application typecheck, lint and the production webpack build against 1,038 hash-verified source/build inputs. The materialized focused suite passed 648 tests with five separately gated PostgreSQL tests skipped; an independent review reran 214 focused tests and found no remaining actionable defects. The wider repository test suite was not fully materialized. Exact receipts accompany the delivery packet.

## Official provider sources

- [Domain availability and pricing](https://vercel.com/docs/rest-api/domains-registrar/get-domain-availability-and-pricing)
- [Unauthenticated domain-search launch](https://vercel.com/changelog/search-domains-without-authentication)
- [Vercel OpenAPI](https://vercel.com/openapi.json), `searchDomains` strict available/unavailable response union
- [Domain term pricing](https://vercel.com/docs/rest-api/domains-registrar/get-price-data-for-a-domain)
- [TLD pricing period definition](https://vercel.com/docs/rest-api/domains-registrar/get-tld-price-data)
