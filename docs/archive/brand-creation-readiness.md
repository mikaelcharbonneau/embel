> Archived November 10, 2026: describes the system before the generation engine.

# Brand creation readiness — 2026-10-13

This records the integrated account and project workflow, not a claim that every production generator is enabled. The existing designs, manual standalone tools and delivered specialist work are preserved.

The account repair and subsequent combined integration have been qualified locally. The existing production deployment still contains the earlier production-origin repair; this checkpoint is being published through a pull request and a protected preview. SMTP/redirect configuration and the worker's cross-team deployment-protection rules could not be verified through the available connectors; their documented rollout steps remain outstanding. New source and SQL definitions do not establish live availability.

## Implemented in this increment

- Email/password signup, email confirmation, resend recovery and the existing sign-in/session safeguards. See [account creation](../account-creation.md).
- Production/preview dispatch and exact Embel workload authentication, with existing durable job, cancellation and budget rules. See [production AI dispatch](production-ai-dispatch.md) for the outstanding hosted configuration.
- Thirty-second bounds for project/strategy HTTP acknowledgements. A timeout never retries a write or cancels a durable job. Late replies cannot overwrite a newer account, revision or request.
- Manual browser-to-account copy now verifies the session immediately before creating a project, blocks simultaneous submissions and shares Home's owner-scoped create receipts. An uncertain save cannot be repeated blindly; a known copy opens its existing account project. Receipt persistence remains tab-scoped and best-effort when browser storage is unavailable; in-memory guards remain active in that tab.
- Saved project decisions now drive the continuation through Strategy, Naming and Inspiration. Navigation never approves a stage. Newer saved project revisions require a recheck instead of overwriting unsaved edits or asserting that unrelated content is stale.
- Inspiration choices can be explicitly reviewed into visual guidance for the existing post-logo identity generator. Jobs freeze the reviewed inputs; changed guidance retains previous results without making them current. Initial logo concepts still use their saved logo brief and uploaded references.
- Logo candidates support comparison, retained refinement history, reload recovery, explicit selection and vector review. Cost confirmation retains the operation's original request and source checks.
- Account preferences, standalone AI Names and project-linked screening research are integrated. Private draft memories participate in account switching and sign-out recovery; screening records remain user-recorded, unverified research.

## Remaining workflow boundaries

| Step | Actual readiness |
| --- | --- |
| Create and save a manual project | Implemented after verified authentication; no profile or AI-budget bootstrap is needed. |
| Confirm a new account | Implemented; Supabase email delivery, Site URL and callback allowlist must be verified before live acceptance. |
| First AI response | Implemented for an eligible owner; production worker configuration and the existing deployment binding need coordinated rollout. New accounts do not automatically receive AI budgets. |
| Audience, personality, positioning | Bounded API handlers exist; each operation requires its enabled owner/runtime policy. Only reformulation was enabled in the inspected API inventory. |
| Competitor research | Excluded from the current API worker because the research cost/input bound is unresolved. Requires a separately qualified research route or a ready subscription worker. Response-only consent does not start research. |
| Project Naming | Uses the subscription runtime and needs its owner policy, ready worker and reviewed strategy for a complete brand. Manual standalone Names remains independent. |
| Inspiration and reviewed visual direction | Implemented with immutable history and owner/revision checks; their additive migrations have not been applied to the hosted database. Reviewed guidance feeds the existing post-logo generator, not initial logo concepts. |
| Whole-system Identity | The `identity.image` producer is still explicitly unimplemented. Trusted Identity saving also needs its approved production connection. These are further implementation/configuration tasks. |
| Logo generation and refinement | Separate implemented pipelines retain their own owner, capability, provider and spending gates; account creation does not activate them. |
| Standalone AI Names | Implemented through the existing bounded text runtime, with explicit cost review, retained results and recovery. Its SQL candidate and runtime capability require coordinated hosted activation. |
| Project-linked screening | Implemented as transient live checks plus explicitly recorded unverified research. Persistent records require the reviewed SQL candidate; live adapters retain their individual provider configuration. |
| Account preferences | Implemented with owner-scoped persistence and conflict recovery; the additive profile migration has not been applied live. |

The current task does not silently enable policies, create credentials, change budgets or invoke paid providers. Fixture success must not be presented as a successful live brand generation.

## Verification of the earlier account repair

The final integrated run passed 348 tests in 26 files, TypeScript checking, ESLint and the production build. Dedicated Chromium verification covered 78 distinct passing desktop/mobile cases; two intentionally unconfigured-build cases were skipped in the configured build. Older browser selectors were updated for the existing project disclosures and mobile account menu, and affected cases were rerun. Initial failures and the reconciled results remain in the evidence directory.

At that checkpoint, independent review found no outstanding defect. The workflow specialist's 87 checks and dispatch specialist's 289 checks overlap its integrated coverage and are not added to its total. The recorded runtime hashes matched that build, and 23 unrelated standalone-tool files matched their preserved checkpoint. Evidence, browser captures and the non-secret receipt are outside the checkout in `/workspace/scratch/fluid-account-workflow-20261013/`. No live account, confirmation email or paid generation was created by those tests.

## Combined integration qualification

The current integration extends that checkpoint. Its preserved starting source, per-workstream hashes, actual test logs and reconciled final receipt are recorded outside the checkout in `/workspace/scratch/fluid-integration-20261013/`. Historical passing counts above describe the earlier account repair; they are not a passing count for all subsequently added code.

- The lead's selected regression checks passed 299 distinct tests across 29 files after reconciling an isolated test-worker startup failure. These cover account creation and recovery, owner boundaries, project handoffs, worker readiness, screening and standalone Names integration.
- All 42 selected production-build browser checks passed across desktop and mobile. Coverage includes signup prompt preservation, account switching and session recovery, Strategy review and explicit AI acceptance, response-only consent, Naming stage gates, dirty-draft preservation and Inspiration persistence. Earlier failed and interrupted runs remain in the receipt: outdated disclosure/library selectors and fixture response synchronization were corrected, and affected cases were rerun. This is not an uninterrupted first-run pass or live-provider acceptance.
- Specialist qualification adds scoped evidence for logo comparison/refinement/reload and vector review, reviewed visual direction at three viewport widths, native PostgreSQL ownership/concurrency, and the standalone Names UI/API/SQL/synthetic-worker path. Overlapping specialist counts are not added to the lead's regression total.
- Global TypeScript and ESLint checks, the web production build and the API text worker package passed. The protected preview uses the same 901 application inputs as the verified build. Their bytewise-sorted deployment-input manifest SHA-256 is `4d6491ad27d8f4a9ce4fd77a9066549eafca04a981d725186b85a8d7c4b6bbe2`.

Hosted provider acceptance, email delivery and database rollout remain distinct from local synthetic verification. No live account, confirmation email, paid generation, funding or SQL activation was performed during qualification. Export and the whole-system `identity.image` producer remain separate unfinished implementation work.
