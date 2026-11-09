> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Brand creation UX refinement — 2026-10-20

## Approved scope

The user requested a live review of Embel's brand creation interactivity, speed and animations, then asked for the reported improvements to be implemented directly. The reviewed scope is consistent entry layouts, editable briefs during read-only readiness checks, earlier navigation after acknowledged project creation, truthful stable loading states, durable Naming onboarding progress and restrained accessible motion.

The verified repository is `mikaelcharbonneau/embel`; the baseline is `ba238f6219befff3b677e0138f06aa9edd342f0d`. Existing account ownership, exact request identity, ambiguous-outcome recovery, saved work and provider policies must remain intact. This work does not authorize provider calls, new credentials or changes to worker authority.

## Production domain configuration

The user explicitly approved Standard Protection instead of Vercel Authentication for all deployments. Production domains are reachable without a Vercel login; preview and generated deployment URLs remain protected.

The user separately approved the exact canonical origin `https://www.embel.xyz` and redeployment of the existing production code. Production `APP_ORIGIN` was split from the unchanged preview variable. Deployment `dpl_3DafaCqbzEpSnFXmQUR6YRX52Z9i` reached READY with the unchanged baseline commit. Native sign-in and sign-up pages stayed on the new domain; a subsequent real sign-in reached the owner's Projects page. Confirmation-email delivery has not been tested.

Follow-up code inspection found two hosted-runtime guards still pinned to the former production domain. They must use the newly approved exact canonical origin while preserving every existing project, environment, opt-in and ownership boundary. Historical URLs and production-alias denylists are not an instruction to migrate unrelated identifiers.

## Verification boundaries

The initial live review created one clearly described QA Naming brief without starting generation. Prompt editing, scope selection, saving, Naming choices and transitions were exercised. Reloading after accepting defaults returned to the language question, demonstrating the progress defect. Competitor readiness reported unavailable; no end-to-end generation timing or animation frame-rate measurement was claimed.

Implementation verification and deployment receipts will be recorded after the relevant checks finish. Any additive production database migration remains separate from writing and testing migration source.

## Naming checkpoint database rollout

After the user approved the small account-progress database update and focused tests passed, `20261020010000_naming_chat_progress.sql` was applied to the existing Supabase project. It replaces only `public.save_naming_view` to accept bounded optional UI progress with existing owner locking and optimistic revision checks. It does not rewrite saved preferences, jobs or generated results. Read-back confirmed the new checkpoint validator exists, authenticated execution remains enabled and anonymous execution remains disabled.

## Integrated source verification

- Whole-project TypeScript checking passed with an explicit 6 GiB Node heap; the first attempt exceeded the environment's default 2 GiB heap.
- Whole-project lint and final changed-flow lint passed.
- Integrated regression run: 141 suites, 1,669 tests passed, including all client suites and affected hosted runtime, authentication-origin and database-checkpoint checks.
- Optimized production build passed compilation, TypeScript, static page generation and tracing.
- Focused checks additionally covered late readiness responses during save, terminal navigation per mount, consent owner/project/revision binding, unknown admission recovery, exact canonical origin rejection, retained default answers and unchanged database execution privileges.

Browser and live deployment checks are recorded separately below when complete; fixture tests do not establish live provider generation or email-confirmation delivery.

## Browser test environment limitation

The planned 92-case isolated Playwright desktop/mobile run could not launch Chromium: the default execution sandbox denied its singleton Unix socket. A narrowly requested escalated run failed before execution because the tool environment could not mount a read-only internal directory. No security settings or protected files were changed. These are launch failures, not app assertions; the 92 cases and screenshots are **not** reported as passed. Supported cloud-browser live smoke checks remain the release verification route.
