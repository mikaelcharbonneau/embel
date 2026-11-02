# Embel

Embel is an account-based workspace for turning a product idea into strategy, a
name, a logo, visual directions and usable brand assets. It uses Next.js, React,
TypeScript, Supabase Auth/Postgres/private Storage, and durable background workers.

[AGENTS.md](AGENTS.md) records the current working agreement and product decisions.
This README describes the current source. Dated specifications and release
records preserve history; they do not override that agreement or prove that a
new source change is deployed.

## Product journey

Users can start a complete brand, Naming only, or visual identity only, and expand
a saved project without discarding its context.

1. **Home, Ideas and Projects:** capture a prompt or idea, sign in, and save an
   account project. Browser copies support recovery; they are not the ordinary
   source of account data.
2. **Strategy:** develop the brief through Competitors, Target audience and Brand
   personality. Preserve the actual conversation, sources and explicit choices.
3. **Naming:** explore unchecked creative proposals, keep favorites and history,
   try deterministic transformations, and choose a name. The current initial
   brainstorm targets 100 names. Generation does not establish availability,
   uniqueness or legal clearance. See [fast-first Naming](docs/naming-fast-first.md).
4. **Logo concepts:** generate six total black-and-white raster concepts across
   the chosen logo types. Keep partial successes and retry only failed work.
   Choose one exact concept to continue. Optional vector conversion and editing
   preserve the original raster and require explicit acceptance of a vector.
5. **Visual directions:** generate three distinct raster brand boards using the
   exact chosen logo. Each direction combines colors, typography, graphics and
   example uses. Vector approval is not a prerequisite, and the retired
   component-mixing screen is not part of this journey.
6. **Brand assets:** choose a direction, then prepare a final board, original logo,
   palette files, font links, social profile image, post templates and banners.
   The standard package has 16 files; a verified saved SVG logo is optional.
   Editable social SVGs can embed the original raster and are not vector logos.

Project context, Naming choices, and existing Logo brief/reference edits save
automatically, with confirmation
before showing Saved and explicit recovery after failures. Project creation,
AI generation, selection and final acceptance remain deliberate actions. An
estimate appears beside Generate when a verified estimate is available. One
click starts generation; there is no extra cost-confirmation screen or fixed
monetary generation ceiling. Usage and uncertain billing remain visible.

Domains, Handles and Trademarks retain their manual workspaces and screening
tools. A provider interface or configured route is not proof of live
availability, reservation, ownership, legal clearance or filing. External
reference discovery remains unavailable unless a real source is configured.

## Reliability and privacy

- Server-side sessions and database ownership checks govern account access.
  Private files use immutable versions and verified bytes; browser-supplied
  owner IDs never grant access.
- Writes retain their original request identity through lost acknowledgements.
  Conflicting revisions and account changes cannot silently overwrite another
  draft or expose another account's work.
- Long AI operations use durable jobs, cancellation, bounded retries and retained
  partial results. An uncertain paid request must not be repeated automatically.
  Recovery can make verified completed output usable while its provider outcome
  or financial accounting still needs reconciliation.
- Vector geometry, font rights, usable downloads, successful saves and provider
  results must be real. Exporting branding does not establish exclusive rights
  or trademark clearance.

See [product reliability](docs/product-health.md) for remaining work and evidence
limits. The [October 30 visual identity release record](docs/visual-identity-release-20261030.md)
records signed-in selection and package download confirmed by the owner. It does
not establish every failure scenario, every supported language or production
capacity for thousands of concurrent users.

## Local development

Use a Node.js version supported by the complete toolchain:
`^22.22.2 || ^24.15.0 || >=26.0.0`. The development default in `.nvmrc` is Node 24;
the packaged shared worker pins Node 22.22.2. Dependencies are pinned in
`package-lock.json`.

```sh
npm ci
npm run dev
```

The ordinary development interface is at `http://127.0.0.1:3105`. Copy the public
settings documented in [.env.example](.env.example) when configuring account
access. Saving, AI, background jobs and private files require their real services;
unconfigured features remain unavailable.

For the isolated local Auth, Postgres, Storage and restricted worker setup, use
[the development environment guide](docs/development-environment.md). The
separate `npm run local` subscription-mode launcher is not needed for the normal
web interface.

## Verification

```sh
npm run typecheck
npm run lint
npm test -- --maxWorkers=2 --reporter=verbose
npm run build
npm run test:e2e
```

`npm run check` runs typecheck, lint, the repository test suite and the production
build. Browser tests use a completed production build. Tests in `tests/live`
with the `.live.ts` suffix run only through the separately configured
`npm run test:live`; the ordinary test suite uses local fixtures. Passing fixture
tests do not establish live provider, account or Storage acceptance.

Use focused tests while developing, then verify the affected desktop/mobile
journey and failure recovery. Worker changes also require their isolated build,
native packaging checks and database authority tests. Do not sum overlapping
test groups or describe an interrupted aggregate as passing.

## Runtime and deployment

- **Web:** Next.js handles the interface, authenticated APIs and private download
  authorization. Production uses `https://www.embel.xyz`; public Supabase
  configuration and the exact application origin are validated at deployment.
- **Supabase:** Auth, Postgres and private Storage retain authoritative ownership,
  revisions, jobs, provider evidence and files. A SQL filename is not evidence
  that a database has that change installed.
- **Shared worker:** one Vercel Daemon contains fixed Strategy, Naming and Logo
  lanes. Identity generation uses the Logo lane. Restricted service principals,
  immutable job scope and compiled SQL authority checks govern execution.
- **Historical runtimes:** separate API-text, dedicated Naming/Logo and local
  subscription entrypoints remain for their existing callers and data formats.
  Their existence does not enable them or make their older contracts current.

See [production deployment](docs/production-deployment.md),
[shared worker authority](docs/shared-worker-pool.md), and
[worker packaging](services/shared-worker/README.md). Keep credentials and private
runtime state outside Git and browser bundles. Use the actual upload file set
when verifying a Vercel source deployment, not only the full checkout.

Database changes must reconcile the target's migration history and installed
function bodies. Historical SQL stays immutable. Use a reviewed forward packet
with exact predecessor guards, and coordinate the compatible worker when its
authority changes. Files in `supabase/candidates` can already be deployed; do not
blanket-apply them or infer installation status from that directory name.
[Migration history](docs/migration-order.md) explains the older handoff and links
the current installation authority.

## Source map and historical records

| Location | Purpose |
| --- | --- |
| `src/app`, `src/components`, `src/features` | Routes, interface and feature implementations |
| `src/domain` | Shared contracts and validation |
| `src/server` | Authentication, persistence, providers and runtime boundaries |
| `worker`, `services` | Durable execution and deployment entrypoints |
| `supabase` | Historical migrations, guarded forward packets and setup material |
| `tests` | Unit, database, security, browser and opt-in live checks |

The product was renamed from Fluid to Embel on October 13, 2026. Existing
`FLUID_*` configuration names and historical identifiers can remain for
compatibility; see [the branding record](docs/embel-branding.md). The repository
is private and grants no open-source license. Preserve all third-party font and
fixture licenses and [external reference provenance](docs/references.md).

[Architecture](docs/architecture.md), [workspace contracts](docs/standalone-workspace-contract.md)
and [provider contracts](docs/standalone-provider-contracts.md) explain technical
boundaries. Earlier source-transfer verification is preserved in
[the October 15 regression record](docs/regression-verification-20261015.md) and
[the October 16 reconnection record](docs/repository-reconnection-20261016.md).
Those dated results are not current full-product acceptance claims.

## Multilingual brand assets

Finished brand assets use bundled, licensed font files with inspected character
coverage. The catalog includes Latin, Greek, Cyrillic, Japanese, simplified and
traditional Chinese, Korean, Arabic, Hebrew, Devanagari, Bengali, Gurmukhi,
Gujarati, Tamil, Telugu, Kannada, Malayalam, Sinhala, Thai, Lao, Myanmar, Khmer,
Armenian, Georgian and Ethiopic. Font choice is limited to faces that cover the
complete saved name; right-to-left names retain their direction in PNG and SVG.
PNG preparation loads only the chosen, verified fonts. Editable SVGs retain the
selected family and Unicode text; install the linked fonts before opening or
editing them. Font binaries are not embedded in SVGs or the ZIP.

This is broad script coverage, not every Unicode character or language. Emoji,
rare characters and some combinations of scripts may have no supported face.
The app identifies unsupported names before new generation. Drafts and historical
results remain readable; it never silently substitutes missing glyphs. Font
sources, licenses, hashes and coverage are recorded in
[font provenance](public/fonts/brand/provenance.json).
