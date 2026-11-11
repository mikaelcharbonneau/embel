# Embel working agreement

User-confirmed preferences, updated November 11, 2026. Embel helps people turn product
ideas into usable branding. It has no customers yet. Prioritize a reliable,
complete branding journey and a professional interface.

## Current authority

Follow the user's latest instructions and this agreement. Current documentation
is indexed in `docs/README.md`; start with `docs/architecture.md` and
`docs/generation-engine.md`. Older records live in `docs/archive/` and preserve
history only: they carry no authority, and their approval limits and stopping
instructions are superseded. Read relevant documentation as needed. Validate
technical dependencies when changing them.

## Standing permissions

- Within requested work, fix, refactor and remove obsolete code. While there are
  no customers, integrate and publish bug fixes to the existing app
  without asking again. Necessary routine configuration and compatible database
  updates may use existing authorized access. Keep a rollback path and report
  what went live.
- Releases: production deploys are made by the release lead from a clean clone of
  `main` (`vercel deploy --prod --scope embel`); skew protection is on. Database
  changes are applied by the release lead (by hand, or with the Release database
  workflow in `docs/database-release.md` once its secrets exist), and checked
  against the migration file after applying. Report what went live.
- Use existing application services, credentials and AI credits for focused
  verification. Report tests, results and observed usage; distinguish estimated
  costs from confirmed charges.
- Choose, test and explain application AI models on already connected services.
  Current logo images: `gpt-image-2.6-sunburst` at low quality and low complexity
  on a transparent background (Creative direction boards: medium quality, opaque).
- Follow the November 6 redesign: a floating pill navigation, rounder corners
  and a neutral ink accent. Do not use magenta. Improve the layout, labels and
  interaction flow as needed; old references and pixel specifications do not
  freeze those details. The plan is in
  `docs/brand-journey-redesign-plan-20261106.md`.
- All existing projects and generated outputs inside Embel are disposable test
  data. Reset or
  remove them when useful for requested cleanup and report the scope. This
  excludes accounts, service configuration, unrelated files and future customer
  work.
- Prioritize the main branding journey.
- Ask when product intent is unclear; resolve ordinary technical choices.
  Existing permission remains valid within its scope. Continue independent
  authorized work while waiting on a blocked part. Communicate concisely in
  terms a nontechnical user understands.

## Agreed app behavior

- The brand journey has four steps: Strategy (Competitors, Audience,
  Positioning), Voice (Personality, Name, Slogan, which is optional), Identity
  (Inspiration, Logo, Creative direction) and Assets (Brand images, Brand
  guidelines, Design system). Competitor research starts automatically after
  the first message on Home, with no extra start click.
- The Logo step is for raster concepts. After choosing a concept, the next step
  presents three distinct raster visual identity directions using that exact
  chosen logo. Vector editing is optional, not a prerequisite for directions.
  Replace the old component-mixing directions screen; do not confuse this with
  removing visual identity generation from the product.
  Each direction shows the logo, colors, typography and example uses. Choosing
  a direction leads to the final brand board and downloadable logo files, color
  palette, font links, social profile images, post templates and banners.
- All AI work runs on the generation engine: Vercel Workflow inside the web app
  (`docs/generation-engine.md`). The old worker, its daemon, the API-text worker
  and ChatGPT-plan mode no longer exist; do not add separate workers or job
  systems.
- Generation is limited in `start_generation`, where every path meets: monthly
  plan credits, a per-kind daily limit per account, one active run per project
  and kind, and a global daily cost cap. Show remaining credits (never dollar
  estimates) and prevent accidental duplicate requests; retain normal
  cancellation and timeouts.
- Plans (November 10): Free / Pro / Studio at $0 / $7.99 / $27.99 USD a month with
  30 / 150 / 500 monthly credits, sold through Stripe Managed Payments (Stripe is
  the merchant of record; `docs/payments.md`). Credit prices per step live in
  `fluid_private.generation_kinds`.
- Do not show cost estimates anywhere in the app (November 6). One deliberate
  click starts the request; no extra confirmation screen is required. Server
  admission, duplicate prevention and recorded usage stay in place.
- Implement and verify these requirements in the app. Editing instructions alone
  does not change runtime limits, dialogs or model bindings.

## Reliability and protection

- Enforce account ownership and private file access on the server. Keep secrets
  out of source, browser bundles, screenshots, logs and exports.
- Save meaningful account edits automatically. Show Saved only after confirmation
  and provide recovery after failures. Never invent successful AI output,
  availability, legal clearance, real vectors or usable downloads.
- Long AI work runs as engine workflows, which provide cancellation, bounded
  retries and retained partial results. Recover uncertain outcomes using the
  original request or response id; never blindly repeat possibly completed paid
  work. Provide useful recovery instead of indefinite blocking.
- Stop switches: one kind with `fluid_private.generation_kinds.enabled`, all
  generation with `fluid_private.engine_settings.paused`
  (`docs/emergency-stop.md`).
- Abuse protections are standing requirements: BotID on routes that start paid AI
  work, WAF rate limits on those routes, the Turnstile CAPTCHA on sign-up (off
  until a Cloudflare key is set), and new database functions private by default
  with explicit grants (`docs/security-rate-limits.md`).
- Preserve truthful request/billing evidence during active work. Deliberate
  test-data cleanup is allowed; fabricated success or refunds are not.
- Retire old implementations after handling their callers and data dependencies.
  Old identifiers and formats are migration concerns, not permanent retention
  requirements for unused code. The old worker's code and database objects are
  gone.

## Implementation and verification

Prefer standard framework/provider patterns and straightforward code. Use the
existing TypeScript/Next.js/Supabase/Node structure, keeping privileged code out
of UI modules. Consult relevant official guidance and skills for the change.

Check current main. Use coordinated parallel agents when useful, with disjoint
ownership and lead integration. Identify the revision actually deployed and
align the working checkout with it.

Required checks before merging: typecheck, lint, format check, unit and
integration tests, the "Database migrations" job (the database is built from
`supabase/migrations`) and the full-journey browser test (`npm run test:journey`).
New AI features go through the generation engine.

Report material failures or untested limits.
Use isolated browser sessions. Preserve external reference provenance.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
