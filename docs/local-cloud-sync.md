# Local/cloud reconciliation — 2026-10-10

## Approved scope

D051 authorizes preserving both versions, reconciling the latest Wonder Domains design with useful cloud behavior, transferring current references, publishing and merging one verified PR, updating both checkouts to that merged revision, and deploying it to the existing protected Vercel preview. Runtime credentials, ignored files and service permissions do not transfer through Git.

## Preserved sources

- Shared starting revision: `fc27d6f4d120c7789b93426cd44fd464a6c28d89`.
- Local Guided Browser source: `84cc79905b565e14369f076379c22a57b46e5c11`, with an exact ignored local recovery snapshot.
- Cloud Advanced Search source: `a7ee07047db3ba5c7a183408a6f87bd3e389b8b7`, on `codex/cloud-domains-preserved-20261010`, with verified snapshot, hashes and recovery bundle retained in the cloud environment.
- Reconciliation branch: `codex/domains-guided-sync-20261010`. Both histories remain recoverable; source is reconciled without resetting either original implementation.

## Combined behavior

The A1/A2 Guided Browser design supersedes Advanced Search presentation. CSV export, local selection, select-visible and sequential bulk checks remain available under Result actions; individual selection lives inside row details. Selection resets for each search instance, including repeated identical preparation. Bounded reads settle after 15 seconds independently of adapter cancellation; a bulk sequence stops on timeout/cancellation, has a 60-second overall deadline and retains completed evidence. Late responses cannot publish into a newer search or account.

CSV export uses the selected rows, or visible rows when none are selected, and only current matching one-year quote prices. Default checks remain unavailable. Existing account save/import/recovery, evidence contracts, registration distinctions and promotion remain intact. Server, worker, database, domain contracts and dependency files are unchanged.

The cloud chat received the exact latest PNGs and reference-only markup under ignored `.references`. ZIP SHA-256: `4e174b7abd9e4b00508a904887176d57c6bad7c1cdb782a1111b3545e8ffa1fd`. Its independent receipt confirmed both PNG hashes and 1440 × 900 dimensions. No reference markup is imported as app code.

## Local verification

Fresh typecheck and lint passed; lint retains two pre-existing warnings in ignored earlier browser fixture output. The production build passed. Seven focused test files passed 113 checks, including the domain model/draft, bounded reads, CSV evidence, account workspaces and promotion editors. The dedicated headless domain checker passed 21 checks; its account counterpart passed 13. Six actual Next.js production-route checks passed across desktop/mobile, covering candidate preparation and CSV, owned saved-name import, session fencing and unsaved logout. All account/provider replies are explicit synthetic fixtures.

Production visual captures at 1440 × 900 and 390 × 844 show no horizontal overflow, browser errors or unexpected requests. Desktop search remains x=360/y=204, width 800; filter/results area remains x=256, width 1008; compact rows remain 61 px. These local captures do not establish authenticated hosted acceptance or live registrar behavior.

The Vercel dry run selected 593 application inputs through the existing allowlist. Every local file matched its manifest hash; no credentials, local runtime state, reference images or test output were selected. The canonical sorted upload manifest SHA-256 is `ac86f2c44ee6218a0957f0ba0a084c5b01a30beebe2ebcc7754abfeb0c2007f6`.

Independent Linux QA confirmed the candidate commit/tree and that same upload manifest, and passed typecheck, lint, 113 focused tests, 21 domain browser checks, production build and six production-route checks. Its account checker exposed a startup race: the replacement helper counted name chips before waiting for the editor. A diagnostic copy with an explicit input wait passed all 13 checks; that wait is now part of the committed test helper. This correction changes test synchronization only, leaving all application/deployment bytes unchanged. Cloud evidence and screenshots remain in ignored work storage; final PR verification records the qualified revision.

## Handoff rule

Future work starts by verifying `main`'s actual commit and worktree status. Preserve independent changes before updating, reconcile on a feature branch and publish the verified checkpoint through one PR. Report the merged commit and verify both receiving checkout and deployment against it. Ignored references/configuration require their separately authorized transfer; matching source does not imply identical runtime credentials or enabled providers.
