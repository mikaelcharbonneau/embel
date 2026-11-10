> Archived November 10, 2026: describes the system before the generation engine.

# Moving between local development and Codex Cloud

Both environments use the same Git repository and development commands. Before
moving work, commit and push the changes you want in the other checkout. In the
receiving checkout, fetch and pull that branch, then install the lockfile:

```sh
git fetch origin
git switch YOUR_BRANCH
git pull --ff-only
npm ci
npm run dev:setup
```

If the branch has no local copy, `git switch --track origin/YOUR_BRANCH` creates
it. Branches and pull requests are available organizational tools, not a required
handoff procedure. Separate branches are useful for simultaneous work; sequential
local/cloud work can use the same branch.

`npm run dev:up` starts this checkout's local backend; `npm run dev` starts its
interface. With the dedicated development provider key configured,
`npm run dev:branding` starts the shared generation worker. `npm run dev:down`
stops the services and retains database, private files and queue state. See the
[portable setup guide](development-environment.md) for prerequisites and ports.

Only committed files travel through Git. `.embel-dev/`, `.env` files, downloaded
dependencies, Docker volumes, browser sessions, ignored reports and chat history
remain separate. Provider credentials use each environment's private configuration. If the
central Vercel Development binding is configured, authenticate and run
`npm run dev:secrets -- pull` in the receiving checkout to retrieve it. The
[source-of-truth guide](source-of-truth.md) explains which data lives where.
Database/Storage transfer is a separate export/import task, not part of Git pull.
Switching a development environment does not itself deploy the website.

## Historical reconciliation — October 10, 2026

## Historical reconciliation scope

The reconciliation workstream concerned preserving the local Wonder Domains design and useful cloud behavior, retaining reference provenance, and aligning a reviewed source revision across both checkouts and the protected preview. The evidence below records actual results; this document grants no new transfer, publication, merge or deployment authority. Runtime credentials, ignored files and service permissions do not transfer through Git.

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

The earlier reconciliation used a feature branch and PR. Current handoff steps
are at the top of this document, and current project instructions are in
[AGENTS.md](../../AGENTS.md).
