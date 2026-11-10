> Archived November 10, 2026: describes the system before the generation engine.

# Production deployment

The current application origin is **https://www.embel.xyz**. The existing Vercel
web project is `embel` (`prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt`) in the Embel team.
The [visual identity release record](visual-identity-release-20261030.md) records
the released web/worker revisions, compatible database changes and rollback
targets. Check current deployment metadata and `/api/health` before updating a
release; a historical record alone does not establish today's aliases.

Follow [AGENTS.md](../../AGENTS.md) for authorization and the current product scope.
Within requested work, fixes and necessary compatible configuration or database
updates are authorized. Keep a rollback path and record what actually went live.

Production builds need the production application origin; previews use their
own immutable origin. Validate the exact Vercel upload allowlist as well as the
full checkout. A successful build does not validate private Storage, provider
credentials or database authority. Publish coordinated shared-worker changes
using [the packaging instructions](../services/shared-worker/README.md) and
[the authority installation sequence](shared-worker-pool.md). Drain the affected
shared execution lanes before changing their SQL authority, retain outstanding
request evidence, and confirm compatible readiness afterward.

## Historical production promotion — October 13, 2026

The remaining paragraphs describe the earlier Fluid promotion. Its hostname,
source scope and access settings are historical and are not current deployment
instructions.

The user requested promoting the repaired Fluid deployment to Production after transferring the existing `fluid-platform-preview` project to Embel (2026-10-13 UTC). Vercel Authentication remains enabled for all deployments. Production is a deployment target, not approval to remove protection, activate providers, add credentials or publish unrelated development work.

The canonical production origin is `https://fluid-platform-preview.vercel.app`, the existing verified production domain. Its existing `APP_ORIGIN` already matches. Production builds and runtime configuration require an explicit canonical HTTPS origin; mutation handlers continue to compare the exact request Origin before authentication or parsing credentials. Preview builds remain bound to their immutable deployment hostname. Do not promote a preview build without rebuilding with Production environment variables: its origin binding would otherwise remain the preview URL.

Production sign-in and sign-up page navigation from deployment aliases redirects to the configured canonical site before rendering credential fields. The redirect is temporary, uncached, and limited to GET/HEAD; it forwards only recognized confirmation status and clears inherited fragments. API requests still enforce their exact Origin, and authentication callbacks keep their existing PKCE handling. Browser draft pages remain accessible at their original address; drafts and pending prompts are origin-local and are not migrated by signing in on the canonical site. Share the canonical URL for normal application use, not the immutable release URL.

This release starts from the deployed `4c6adabef2b47fe643147834bc9497834208b46c` snapshot and changes only `scripts/preview-preflight.mjs`, `src/server/config.ts`, and the implementation/declaration of `src/server/preview-origin.mjs`. Newer Projects and standalone manual-tool development is excluded. The same fix is retained in the active checkout with regression tests. Non-secret deployment manifests and validation evidence are stored outside the checkout under `/workspace/scratch/fluid-production-promotion-20261013/`.

## November 2 review fixes

The next coordinated web/worker update adds retained Naming delivery recovery,
autosave, bounded acknowledgements and multilingual final assets. Follow the
[guarded rollout procedure](review-fixes-rollout-20261102.md) and
[Naming recovery/rollback notes](naming-delivery-recovery.md). Historical
reconciliation jobs keep their original accounting; deployment alone does not
prove that an old job has recoverable output.
