> Archived November 10, 2026: describes the system before the generation engine.

> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../architecture-review.md).

# Hosted Naming activation — 2026-10-18

> Historical: retired by the November 2026 Naming generation rebuild (docs/naming-generation-contract.md).

## Historical implementation scope

The hosted Naming workstream added production routing for the existing owner's
flow, retaining the managed Agents protocol, saved choices and progressive
publication used locally. This record does not authorize activation or select a
model for future work. The source baseline was main
`e9498743439a7c8350bb7cc68882d1001ccabbfd`.

The canonical application is `https://fluid-platform-preview.vercel.app`, Vercel
project `prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt` in team Embel. Its existing Supabase
project is `fricsfwqibyhemknqgyf` (`fluid-platform-dev`). The approved account is
`6840f4c2-15a6-45a7-97be-41e7e5e37f42`, matching the saved project and sole Naming
pilot. Production authentication stays enabled.

## Implementation choices

- The production web explicitly opts into hosted Naming routing. Database
  capabilities independently bind one owner, pilot, exact policy, restricted
  role and worker deployment.
- Newly admitted hosted work receives its own immutable execution authority.
  Historical local and ordinary jobs retain their identities, requests and
  hashes. Existing wire identifiers remain compatible.
- The worker derives Naming execution permission from each trusted claim.
  A process setting alone cannot give an ordinary job the account exception.
- Progressive publications, real factual-source requirements, finite execution
  windows, cancellation, lease fencing and uncertain-outcome handling retain
  their existing enforcement.
- Hosted scroll continuation requires a fresh database capability plus the
  current owned, resumable or completed run. Saved names remain readable while
  new generation is unavailable.
- The existing Mac worker keeps provider and database credentials on this Mac.
  Live generation depends on that worker running and this Mac remaining online.
  `npm run worker:naming` launches only Naming through the existing protected
  configuration reader. A user LaunchAgent can supervise this command separately
  from the web preview, with no credentials in its configuration.

## Initial inventory

The restricted `fluid_naming_brain_worker` retains OID `23033`, LOGIN,
NOINHERIT, NOSUPERUSER, NOBYPASSRLS and a four-connection limit. The inspected pilot policy
recorded `gpt-6-luna` and was enabled, with an expired heartbeat. There were zero
active leases. Existing unfinished requests, including a historical Sol
reconciliation and an expired Luna progressive run, remain recovery evidence.

## Verification and release

Type generation, whole-project TypeScript, full ESLint, production build and
whitespace checks passed. The affected Naming, worker, domain, client, API and
database matrix passed **1,061 tests in 78 files**. Independent review passed
**69 checks**, including hosted SQL, installed-SDK integration and adversarial
execution-authority cases. These use disposable databases and synthetic provider
responses.

The reviewed migration SHA-256 is
`3af216a7eee47d94767bf71ce6b6242548cb41ff09c3f4921c050204c6db9fe3`.
Installation is recorded as `20261019030915_hosted_naming_execution`. The first
connector request expired; read-back confirmed zero installation and unchanged
data before the identical retry succeeded. Native PostgreSQL read-back matched
all **26** expected function bodies and metadata, FORCE RLS/private ACLs, and
the unchanged count/digest baseline across **34 tables / 7,975 rows**. All new
capability, context and marker tables were empty at installation.

Release qualification proceeds through the associated pull request: deploy the
verified main revision, supervise the Naming-only Mac worker, exercise actual
PostgreSQL owner/foreign/anonymous boundaries in a rolled-back transaction,
apply the exact owner activation packet, and verify genuine generation and
reload in the authorized live-app tab. Real-provider and deployment evidence
is recorded in that release record separately from the fixture results above.

The first production canary admitted the hosted job but exposed a remaining
local-only exception in the shared step gate. No provider request was issued.
The additive `20261019032503_hosted_naming_step_authority.sql` migration repairs
that boundary for the exact restricted worker and immutable hosted admission.
Same-project unknown outcomes and fresh capability checks still block paid
dispatch. Historical holds, requests, attempts and prior migrations remain
intact. Its SHA-256 is
`9b72e08837a35a72608ca3ee767fac70589923f991507c79f8ed2fabe526b341`.
Independent behavioral and catalog checks reproduce the failure, reach genuine
dispatch authorization after the repair, preserve existing function permissions
and saved rows, and cover disablement, saved preparation and ordinary job limits.
Native installation is recorded as `20261019033024_hosted_naming_step_authority`;
both installed function bodies match the full disposable migration replay and
the 34-table data baseline is unchanged by this migration.

Local evidence files are `/private/tmp/embel-hosted-naming-baseline-20261019.json`,
`/private/tmp/embel-hosted-naming-tests-20261019.log` and
`/private/tmp/embel-hosted-naming-build-20261019.log`. They contain no credentials.
