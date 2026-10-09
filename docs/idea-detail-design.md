# Idea Detail design and functionality

## Approved reference — 2026-10-09

The user requested a functional Ideas flow, implementation of **Page - Idea Detail** from Wonder, and a Vercel deployment for testing.

- [Wonder Workspace](https://app.wonder.so/fluid/files/01a11dfe-6aa3-7091-98fe-2fad32cf9fc0/branches/main/pages/01a11ed5-9795-737b-b0ba-404021959e88), artboard `hod`.
- Match the shared concept 22 shell and the 1440 × 900 reference: content starts at x=256/y=116, the form and sidebar start at y=212, with 656/328 px columns and a 24 px gap.
- Save lives in the header. Title, description, state, theme, problem, solution, and audience are directly editable. The brand action and real saved version appear in the sidebar.
- The bottom fade is decorative, permits pointer interaction, and clears when scrolling reaches the end.

## Functional behavior

- Manual idea capture, account persistence, search, filters, pagination, reload, updates, brand creation, source links, and attachment to existing brands use the existing verified account APIs.
- This update changes presentation; it preserves immutable revisions, request-key replay, conflict handling, owner/generation fencing, and retained-edit recovery.
- Additional existing fields remain available under More details. Textareas grow with their content and available width.
- Save is disabled when nothing has changed; Create brand is disabled while unsaved changes or unresolved conditions require attention.
- The header breadcrumb reads only the verified account's current-generation idea memory. It clears when that account becomes unavailable or changes.
- The reference's sample idea is used only in isolated browser fixtures, never inserted into production.
- AI idea generation is not part of the manual Ideas feature.

## Deployment and live verification boundaries

- Existing target: `fluid-platform-preview`, project `prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt`, under the user's existing Vercel team.
- Existing Supabase target: `fluid-platform-dev` (`fricsfwqibyhemknqgyf`), active and healthy. The live manual Ideas migration is installed; all three Ideas tables enforce RLS, and the six manual Ideas RPCs allow authenticated execution and deny anonymous execution.
- The previous deployment's session endpoint returned the application's expected unauthenticated response, confirming configured Auth rather than an unavailable integration.
- No new database, account, paid inference, schema change, or persistent credentials were needed.
- A Vercel CLI protected-preview read automatically created an automation-bypass token. It was revoked, and temporary credential-bearing files were removed. Vercel Authentication remains required for all deployments.
- `.vercelignore` now allowlists application inputs, excluding local references, QA files, test output, and credentials from upload.
- Local browser acceptance uses explicitly intercepted fixtures; it does not claim an authenticated live-user mutation test.

## Local verification

- Production build and TypeScript checks passed. The lint check has no source errors; a local Playwright fixture script emits an unused-expression warning because the CLI consumes it as a function expression.
- 196 focused tests passed across domain, API, server, database, and client suites.
- 50 existing Ideas/Home browser checks passed across desktop and mobile, including capture, search, pagination, save/reload, conflicts, retained request retries, brand conversion, and account changes.
- Visual checks: 1440 × 900 and 390 × 844, no horizontal overflow. Desktop first form panel: x=256/y=212, 656 × 366; brand panel: x=936/y=212, 328 × 274. Growing fields adapt to mobile width.
- Evidence: `output/playwright/idea-detail/desktop.png`, `mobile.png`, and `regression/` (synthetic fixtures only).
- The first remote build identified one excluded worker helper. The upload list now includes that module and its declaration; a TypeScript dependency scan found no omitted local imports.

## Vercel preview — READY

- [Open Ideas](https://fluid-platform-preview-frezb8u4n-mikael-charbonneaus-projects.vercel.app/ideas)
- Deployment: `dpl_Dnrh7ynmBUTBpx5GhQTsdgEUXvbB`; target: preview; remote state: `READY`, confirmed by the Vercel API.
- Vercel Authentication remains enabled for all deployments. Open the immutable preview URL above, authenticate with Vercel when prompted, and use an existing Fluid account for saved Ideas.
- The app uses the existing live Supabase configuration. No demonstration ideas or new user accounts were created.
- The earlier failed build `dpl_BaUAZZt3mZFig4KbzavXqDstBEhb` is superseded by this successful deployment.
