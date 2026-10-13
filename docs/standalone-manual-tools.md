# Standalone manual tools

On 2026-10-12 the user requested functional standalone Ideas, Names, Domains, Handles and Trademarks, then chose to complete manual tools before AI generation and asked for provider recommendations. Deployment is paused. This increment adds no provider activation, paid request, credential, migration or deployment.

## Available workflows

| Tool | Manual workflow | Storage |
| --- | --- | --- |
| Ideas | Capture, edit details, search/filter, paginate, and explicitly create or attach a project | Verified account; revision and response-loss recovery |
| Names | Deterministic Affix/Tweaks/Blend/Swap workshop, saved words, favorites, library and history; export and restore a JSON workspace | This browser; account Naming remains a separate project workflow |
| Domains | Copy a browser name or explicitly import an owned project's saved name, prepare name/extension candidates, select and export CSV | Signed-out tab; explicit account draft save when signed in |
| Handles | Copy browser names, prepare platform comparisons, inspect exact profile links, save bundles/favorites/selections, record user-declared accounts, export comparison or library CSV | Signed-out tab; explicit account draft save for bundles/declarations when signed in. Unfinished searches remain temporary |
| Trademarks | Copy a browser name, prepare a manual search brief, open official registries, record findings, complete six-section intake, review exact content and export a JSON draft preview | Signed-out tab; explicit account draft save when signed in. One current draft, not a multi-record library |

Browser-name imports copy text only and retain the original Names entry. Replacing an existing Domain/Trademark name requires an explicit confirmation. These copies do not invent verified project provenance. Existing owned project imports retain their server-resolved source references. Changes continue to invalidate prepared checks or exact-content review where applicable.

Names backup import reads at most 4 MB, validates the full workspace schema and transformation history, previews counts, then requires explicit replacement. Consent is bound to the exact current immutable workspace, including across resets that reuse a revision. Invalid files, intervening edits, other-tab writes and storage failures preserve current work. Account/private data is never imported through this browser-only backup route.

Handles profile links use fixed platform hosts and validated handle syntax; LinkedIn links explicitly refer to company profiles. CSV exports include recorded availability, check date, profile URL and separately labeled user-declared account URL. Formula-leading cells are neutralized in addition to CSV quoting. Account exports check the active owner/session binding at download time.

Trademarks prepares criteria for the user to enter in the linked registry; it does not submit a remote search. User notes remain unsourced. No profile link, empty registry screen or prepared brief proves availability, ownership, registrability or legal clearance. Domains remain Unknown / Not quoted and Handles remain Unknown until an appropriately supported live integration produces evidence.

## Recommended providers — not activated

- **Domains: Cloudflare Registrar.** Its [domain-check endpoint](https://developers.cloudflare.com/api/resources/registrar/methods/check/) reports registration eligibility and supported pricing fields without purchasing or reserving. An ineligible name can be reserved, premium-restricted or unsupported, so it must not automatically become “Taken.” Existing server-only contracts already model this distinction. Account access, API permissions, supported TLDs and any applicable costs still need qualification before activation; registration and purchase are separate work.
- **Handles: official platform APIs where supported, starting with YouTube.** [YouTube channels.list](https://developers.google.com/youtube/v3/docs/channels/list) supports `forHandle` and currently documents one quota unit per lookup. It can establish a found profile, not that an absent handle can be claimed. Keep other platforms manual until their exact lookup permissions and semantics are reviewed. Do not promise a universal authoritative handle-availability API or infer availability from public-profile HTTP status codes.
- **Trademarks: WIPO Global Brand Database and USPTO for manual research now.** Use [WIPO](https://branddb.wipo.int/en/), its [coverage list](https://branddb.wipo.int/en/coverage), and the [USPTO search portal](https://www.uspto.gov/trademarks/search). WIPO's [FAQ](https://www.wipo.int/en/web/global-brand-database/faqs_branddb) limits public portal automation; do not scrape it as an API. Automated search needs a licensed, jurisdiction-specific source with reviewed coverage, usage terms and cost. No automated trademark provider is selected by this recommendation.

The official documentation above was reviewed read-only for this increment. No access, quota, paid plan or live provider result was tested. Existing [provider contracts](standalone-provider-contracts.md) remain unbound server-only implementations.

## Persistence evidence and verification limits

A fresh read-only catalog inspection of the approved Supabase development project found the Ideas and standalone workspace migrations installed, including the standalone conflict-code migration. `ideas`, `idea_revisions`, `standalone_workspaces` and `standalone_workspace_revisions` have RLS and FORCE RLS. The inspected public Ideas/workspace RPCs permit authenticated execution and deny anonymous execution. This supersedes the original implementation document's historical “not activated” schema status; it does not establish fresh real-account browser acceptance or change any grant.

This checkout was missing its public Supabase connection settings. The existing approved project's URL and active publishable key were reused in ignored `.env.local` with mode 0600; no key was created or rotated, and other environment settings were preserved. A bounded, verified-TLS read of its Auth health endpoint returned HTTP 200. This confirms service reachability, not a signed-in save/reload acceptance test.

Verification uses unit tests and dedicated desktop/mobile browsers with intercepted synthetic account responses. New checks cover browser-name transfer, replacement confirmation, actual CSV downloads, manual registry briefs, validated backup restoration and reload. Existing Ideas and standalone account tests cover ownership, conflict recovery and uncertain writes. No application user data, live provider request or hosted write is needed for these checks. Non-secret logs, screenshots and the final receipt are kept outside the checkout in `/workspace/scratch/fluid-standalone-functional-20261012/`.

Final validation: 446 focused tests in 32 files, typecheck, lint and production build passed. All 98 distinct desktop/mobile checks passed across the final run and a two-test Handles follow-up: the follow-up corrected obsolete test navigation to use Edit search and Library, without changing application behavior. A separate 320 px manual-research check found no horizontal overflow. With the restored public settings, all five anonymous account endpoints returned 401 and `Cache-Control: private, no-store`. Real signed-in hosted CRUD and live registrar/platform/trademark checks remain unvalidated.
