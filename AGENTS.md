# Embel working agreement

User-confirmed preferences, October 29–30, 2026. Embel helps people turn product
ideas into usable branding. It has no customers yet. Prioritize a reliable,
complete branding journey and a professional interface.

## Current authority

Follow the user's latest instructions and this agreement. Dated decisions,
plans, specifications and handoffs preserve history; their old approval limits,
mandatory skills, design freezes and stopping instructions are superseded where
conflicting. Read relevant documentation as needed. Validate technical
dependencies when changing them.

## Standing permissions

- Within requested work, fix, refactor and remove obsolete code. While there are
  no customers, integrate and publish tested bug fixes to the existing app
  without asking again. Necessary routine configuration and compatible database
  updates may use existing authorized access. Keep a rollback path and report
  what went live.
- Use existing application services, credentials and AI credits for focused
  verification. Report tests, results and observed usage; distinguish estimated
  costs from confirmed charges.
- Choose, test and explain application AI models on already connected services.
- Keep the current visual style while improving clarity and consistency (latest
  preference, October 30). Improve the layout, labels and interaction flow as
  needed; old references and pixel specifications do not freeze those details.
- All existing projects and generated outputs inside Embel are disposable test
  data. Reset or
  remove them when useful for requested cleanup and report the scope. This
  excludes accounts, service configuration, unrelated files and future customer
  work.
- Prioritize the main branding journey. Ask before removing features, adding
  paid services/plans, materially expanding access, or destructive changes beyond
  the agreed test-data scope.
- Ask when product intent is unclear; resolve ordinary technical choices.
  Existing permission remains valid within its scope. Continue independent
  authorized work while waiting on a blocked part. Communicate concisely in
  terms a nontechnical user understands.

## Agreed app behavior

- The Logo step is for raster concepts. After choosing a concept, the next step
  presents three distinct raster visual identity directions using that exact
  chosen logo. Vector editing is optional, not a prerequisite for directions.
  Replace the old component-mixing directions screen; do not confuse this with
  removing visual identity generation from the product.
  Each direction shows the logo, colors, typography and example uses. Choosing
  a direction leads to the final brand board and downloadable logo files, color
  palette, font links, social profile images, post templates and banners.
- No fixed monetary caps that stop generation. Show usage and prevent accidental
  duplicate requests; retain normal cancellation and timeouts.
- Show expected cost beside Generate; one deliberate click starts the request.
  No extra confirmation screen is required. Never invent an unavailable estimate.
- Implement and verify these requirements in the app. Editing instructions alone
  does not change runtime limits, dialogs or model bindings.

## Reliability and protection

- Enforce account ownership and private file access on the server. Keep secrets
  out of source, browser bundles, screenshots, logs and exports.
- Save meaningful account edits automatically. Show Saved only after confirmation
  and provide recovery after failures. Never invent successful AI output,
  availability, legal clearance, real vectors or usable downloads.
- Use durable background jobs for long AI work, with cancellation, bounded retries
  and retained partial results. Recover uncertain outcomes using the original
  request identity; never blindly repeat possibly completed paid work. Provide
  useful recovery instead of indefinite blocking.
- Preserve truthful request/billing evidence during active work. Deliberate
  test-data cleanup is allowed; fabricated success or refunds are not.
- Retire old implementations after handling their callers and data dependencies.
  Old identifiers and formats are migration concerns, not permanent retention
  requirements for unused code.

## Implementation and verification

Prefer standard framework/provider patterns and straightforward code. Use the
existing TypeScript/Next.js/Supabase/Node structure, keeping privileged code out
of UI modules. Consult relevant official guidance and skills for the change.

Check current main and preserve unrelated work. Use an isolated branch and a
pull request for a coherent change. Use coordinated parallel agents when useful,
with disjoint ownership and lead integration. Identify the revision actually
deployed and align the working checkout with it.

Runtime changes need typecheck, lint, relevant tests and a production build
before publishing. Verify affected user journeys, desktop/mobile behavior and
failure recovery where relevant, including focused live tests under the standing
permission above. Text-only edits need consistency/link checks. Distinguish local
mocks from live acceptance and report material failures or untested limits.
Use isolated browser sessions. Preserve external reference provenance.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
