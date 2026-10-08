# Fluid

Fluid is a brand-building workspace for moving from an idea to strategy, a name, a logo and usable identity files. This private source checkpoint combines the latest interface repairs with the existing application and a locally qualified, disabled vector-proposal backend. It is a development handoff, not a completed product or a production-release claim.

The GitHub repository name `emble` is a repository identifier. The product remains **Fluid**.

## Product and user journey

A user can begin with a complete brand, naming only, or visual identity only, and expand later without discarding known context.

- **Home, Ideas and Brands:** start from a freeform prompt, keep browser drafts, capture manual Ideas, save account work and explicitly turn useful material into a brand. Browser drafts and private account records remain separate.
- **Strategy:** develop the brief through a conversation with reviewable Competitors, Audience, Personality and Positioning content. Preserve sources and user choices; mark downstream work stale when its inputs change.
- **Naming:** explore names from saved context, keep favorites and history, choose a name and use deterministic Affixes, Tweaks, Blend and Swap controls. The approved initial project batch is 250 names with later 50-name batches; historical 100-name batches remain readable. Standalone Names also supports browser-based work and explicit continuation into a brand.
- **Logo and Visual Identity:** follow the logo-first workflow below. Existing legacy three-board Identity records stay readable and must not be reinterpreted as the new workflow.
- **Assets and Guidelines:** retain owned files, provenance and immutable versions, then deliver verified files matching the approved selection. The default Assets view includes liked, saved or used material; all generations is a separate view.
- **Domains, Handles and Trademarks:** maintain manual workspaces and screening preparation with explicit evidence limits. Provider contracts are present, but they do not establish live availability, reservation, ownership, legal clearance or filing.

### Approved logo-first scope

The [approved logo and visual identity specification](docs/superpowers/specs/2026-10-06-fluid-logo-visual-identity-approved.md) defines this workflow. The [bounded vector-refinement plan](docs/superpowers/plans/2026-10-08-vector-refinement.md) covers the narrower proposal increment.

Start from a standalone logo brief or reuse Strategy. Users choose one or more of seven logo types: **wordmarks, lettermarks/monograms, pictorial marks, abstract marks, combination marks, emblems and mascots**. Curated and uploaded references should support the same lettering, shape, composition and overall-feel preferences, with appropriate rights and attribution.

The first exploration contains **six total black-and-white concepts**, not six per type. Identify each concept's type and any unrepresented selected types. Retain partial successes and retry only failed concepts after explicit cost consent. Generation and refinement are separate actions; typing, navigation and manual editing must not dispatch paid work.

A selected concept becomes genuine vector geometry before detailed editing and delivery. Retain the original raster, compare conversion differences, and require explicit vector acceptance. Direct controls cover text/font, spacing, size, rotation, color and arrangement where the actual document supports them. Preserve component locks, exact approved spelling and immutable history. Font editing requires real editable text; replacing outlined lettering is a distinct explicit change. Anchor-point editing is outside the launch scope.

After logo approval, propose **three coordinated identity directions** for color, typography and supporting graphics. Allow compatible component mixing while protecting the selected logo and flagging stale downstream work. Track commercial-use and redistribution rights for free and uploaded fonts. Show RGB/HEX; disclose CMYK profile limitations; leave Pantone unavailable without a lawful matching source.

The intended default delivery includes appropriate primary/horizontal/stacked/symbol-only variants, black/white/color versions, SVG, genuine vector PDF, transparent PNG and a simple guidelines PDF. Social avatars and banners are optional. Downloads must contain verified bytes for the approved version. Exporting a file does not establish exclusive rights, uniqueness or trademark clearance.

## What this checkpoint establishes

### Live evidence

The first separately authorized live **Strategy reformulation** was completed and verified. This is a bounded acceptance result for that operation. It does not establish the entire Strategy journey, Naming, live logo generation, vector proposals, exports or a production-ready service. The private source handoff neither reruns that paid request nor enables additional generation.

### Previously accepted implementation

The source includes browser drafting and recovery, account/session fencing, saved-project revision handling, manual Ideas, Strategy conversation/review controls, Naming and its history, standalone manual tools, Assets/reference handling, legacy Identity editing/history, and logo-first creation/editor/directions/deliverables surfaces with their associated contracts and worker infrastructure. Acceptance and live availability vary by feature; a route or a passing fixture is not proof of a fully connected user journey.

The latest interface work improves app-wide framing and readability, keeps the Strategy composer visible, exposes latest activity, and preserves Home prompts through sign-in. Its follow-up correction also fences uncertain saves and retires successful-start recovery markers to avoid reopening an earlier project from a new prompt. See [UI repair notes](docs/ui-repair-20261008.md).

### Newly integrated but disabled vector proposals

The backend adds a separately priced durable text operation, `identity.logo_vector_propose`. It proposes exactly one supported command: size, rotation, color, arrangement, font or spacing. It cannot redraw arbitrary paths, invent components, unlock protected content, change spelling or silently split a multi-change request into paid jobs.

The locally exercised chain covers verified source/font bytes, trusted quote and admission, the real host/provider adapter composition with synthetic HTTP responses, durable proposal retention, authenticated candidate creation, provenance and replay recovery. Applying a retained proposal uses existing vector producers without another AI call. It creates a review-required immutable candidate; the approved logo remains unchanged until explicit acceptance. Paid uncertainty and cancellation retain evidence instead of automatically regenerating work.

**The proposal UI is not implemented. The operation remains disabled.** Its new SQL is unapplied, and no live provider, hosted Storage/RLS, real pooler concurrency or complete browser journey is established by the local qualification. See [vector-proposal integration](docs/logo-vector-feature-integration.md).

### Remaining product and release gaps

Finish the app-wide integration and full user journey rather than treating these component checkpoints as product completion. Important gaps include the proposal UI/recovery/comparison flow, logo runtime activation, approved reference ingestion, live provider qualification, trusted production persistence/storage capabilities, real export/download acceptance, and the remaining Identity, Guidelines and standalone-provider integrations. Preserve unavailable states until their real dependencies are ready. Arbitrary vector-source AI redraw and the earlier raster-to-vector refinement facade are not completed by the bounded proposal operation.

## Run the ordinary interface

Use Node.js matching `package.json`: `>=22.13.0 <23 || >=24`. Dependencies are pinned in `package-lock.json`.

```sh
npm ci
npm run dev
```

The development UI binds to `http://127.0.0.1:3105`. Browser-only drafting can be explored independently. Account data, AI, durable jobs and private files need separately configured services. Do not introduce demo success or substitute another provider when a capability is unavailable.

### Package scripts

These are the exact commands in `package.json`. Their presence is not an instruction to run validation or activate a service during this handoff.

| Script | Command |
| --- | --- |
| `local` | `node scripts/local.mjs` |
| `dev` | `next dev --hostname 127.0.0.1 --port 3105` |
| `build` | `next build --webpack` |
| `start` | `next start --hostname 127.0.0.1 --port 3105` |
| `lint` | `eslint .` |
| `typecheck` | `next typegen && tsc --noEmit` |
| `test` | `vitest run` |
| `test:watch` | `vitest` |
| `test:e2e` | `playwright test` |
| `test:live` | `vitest run --config vitest.live.config.ts` |
| `worker` | `node --conditions=react-server --import tsx worker/index.ts` |
| `check` | `npm run typecheck && npm run lint && npm test && npm run build` |
| `build:api-text-worker` | `node scripts/build-api-text-worker.mjs` |

## Runtime and configuration boundaries

- **Web application:** Next.js/React handles the UI, authenticated APIs and private download authorization. Core public configuration uses `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `APP_ORIGIN`. A publishable key is not a privileged service credential.
- **Supabase:** Auth, Postgres and private Storage provide authoritative ownership, revisions, jobs, cost reservations and file access. Browser fields never establish ownership. Schema files and activation templates in this repository are not proof that a target database has them installed.
- **Dedicated workers:** background work has separate process, identity, policy, budget, lease and readiness requirements. The ordinary `worker` command does not implicitly enable every logo operation. Local subscription mode, the hosted API-text worker and the dedicated logo host are distinct configurations; never share their credentials as a shortcut.
- **Local subscription mode:** `npm run local` requires an existing build and approved protected configuration. It launches the local web interface on port 3106 and its separate worker; connection consent remains locked unless explicitly enabled through the approved setup. It is not required for the ordinary browser-only UI.
- **Hosted API text:** `build:api-text-worker` prepares a separate deployment artifact. Building it does not deploy, provision credentials or authorize inference.

Keep credentials, tokens, environment files, user sessions and private runtime state outside Git. Use secure, separately authorized configuration flows. Privileged database, service-role and provider credentials must never enter browser bundles, screenshots, logs or exported files. Existing non-secret target allowlists and deployment preflight settings are intentional, target-specific constraints; review them before using another host rather than loosening them to make setup pass.

Do not automatically apply migrations, create roles/grants, enable paid policies, start generation, deploy, change protection or publish this source. A private source push is not approval for those actions. Historical approvals in decision records do not transfer authority to a new operator or environment.

### New vector SQL order

The following reviewed files in `supabase/candidates/` remain separate and unapplied, in this predecessor order:

1. `logo-vector-proposals.sql`
2. `logo-vector-proposal-quotes.sql`
3. `logo-vector-proposal-admission.sql`
4. `logo-vector-proposal-observations.sql` (accepted v2)
5. `logo-vector-proposal-completion.sql`
6. `logo-vector-proposal-materialization.sql`
7. `logo-vector-proposal-capabilities.sql`

Before any authorized rollout, reconcile the target's actual migration history, prerequisite schema and other pending candidates. Do not edit historical migrations, invent applied timestamps or run a blanket database push. See [migration order and rollout gates](docs/migration-order.md) and the integration document before packaging these files as forward migrations.

## Verification status and current stop

The user explicitly stopped further validation and requested the source checkpoint promptly for continuation with other agents. **Do not start another test, typecheck, lint or build merely to deliver this handoff.** Resume validation only within a subsequently authorized task.

Evidence must remain separated by source and scope:

- The combined focused vector run reported **891/892** passing. Its sole failure was an obsolete assertion rejecting the newly supported optional sixth capability. That test assertion was corrected after explicit approval; do not relabel the original run as an all-green result.
- The latest changed-focused checks passed **23/23**, with scoped TypeScript and lint passing.
- A later whole-project aggregate lost its process/result record. Its result is **unknown**, not a reported test failure or a successful completion.
- Full typecheck with a 1 GiB heap ended in out-of-memory failure, exit **134**. Full lint and build were not run for the combined checkpoint.
- Earlier UI checks and known base failures are documented separately in the UI repair notes. They are not a new full-candidate result. Synthetic database/browser/provider checks do not establish live integration, production output quality or hosted concurrency.

There is no fully green aggregate or full-product acceptance claim for this checkpoint.

## Source map and next steps

- `src/app`, `src/components`, `src/features`: routes, UI and feature implementations
- `src/domain`: shared contracts and validation
- `src/server`: server-only authentication, data, provider and runtime boundaries
- `worker`, `services/api-text-worker`: durable operation execution and separate hosted entrypoints
- `supabase/migrations`, `supabase/candidates`, `supabase/activation`: historical schema, pending candidates and gated setup material
- `tests`: local, database, adversarial, browser and opt-in live checks

Read `AGENTS.md`, [architecture](docs/architecture.md), [decisions](docs/decisions.md), [standalone workspace contracts](docs/standalone-workspace-contract.md) and [standalone provider contracts](docs/standalone-provider-contracts.md). These documents include historical milestones; reconcile them with this checkpoint and current source before acting.

Next implementation priorities:

1. Read the [approved specification](docs/superpowers/specs/2026-10-06-fluid-logo-visual-identity-approved.md), [bounded refinement plan](docs/superpowers/plans/2026-10-08-vector-refinement.md) and [migration order](docs/migration-order.md). Preserve all seven types, six total concepts and the three post-logo directions; do not replace the full product scope with only the newest backend increment.
2. Complete app-wide UI integration and the end-to-end Home/Idea → Brand → Strategy/Naming → Logo → Identity → Assets/Guidelines journey, including reload, account changes, interruption and error recovery.
3. Add cost-confirmed vector-proposal UI, owned proposal discovery, exact-command review, candidate comparison and explicit acceptance, keeping manual edits provider-free.
4. Reconcile migration prerequisites/order and prepare the smallest separately authorized logo/persistence/provider activation steps. Reuse existing durable evidence; never retry an uncertain paid request as a fresh inference.
5. Finish remaining features and establish final verification and live acceptance under a newly agreed scope. Functionality and reliable recovery precede aesthetic benchmarking and prompt tuning.

The original `.pen` design file and design bundle are absent from this checkpoint. [Design references](docs/references.md) retain provenance; obtain the original through an authorized transfer before claiming pixel-perfect comparison. Preserve the accepted Geist, neutral/magenta tokens and existing licensed third-party assets.

This source has not been prepared for public release. No open-source license is granted here; preserve applicable third-party font and fixture licenses.
