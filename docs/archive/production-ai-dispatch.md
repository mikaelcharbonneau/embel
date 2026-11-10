> Archived November 10, 2026: describes the system before the generation engine.

# API-text production dispatch repair — 2026-10-13

The confirmed account's one-response trial was replaced by the private testing mode documented in [account AI testing](account-ai-testing.md). Its 2026-10-14 activation and verification supersede the trial-limit snapshot below for that account. This historical record does not grant spending or activation permission.

## Implemented behavior

The approved web project `prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt` can publish existing API-text dispatch descriptors from `preview` and `production`. An explicit `VERCEL_TARGET_ENV` must match `VERCEL_ENV`. Development, custom environments, another project, and malformed worker origins remain unavailable. The transport still carries only the five immutable dispatch fields, uses request-context OIDC, refuses redirects, and returns `dispatch_pending` on timeout or any unconfirmed response.

Strategy availability first reads caller-specific SQL availability, then intersects eligible API operations with the protected `getApiTextWorkerReadiness()` response. Missing publisher configuration, a null probe or an empty qualified operation list hides API operations only; available subscription operations and database refusal reasons are preserved. A successful probe establishes current protected reachability and exact runtime qualification, not that a future provider call will succeed. API admission and exact replay still go through the existing owner-scoped SQL; a committed job remains queued and repairable after a publication failure. Reading, cancelling, applying or replaying an existing job does not depend on the readiness probe.

The worker also provides a protected, body-free `GET /api/readiness`. Its server caller, `getApiTextWorkerReadiness()`, uses the same request-context OIDC and validated origin, refuses redirects, limits the reply to 1 KiB and bounds the whole read to 12 seconds. The endpoint verifies the exact publisher before running one bounded qualification statement: the existing `check_api_text_runtime` by default, or the separately granted `api_text_multi_account_readiness` after explicit adapter opt-in. Its only success fields are `version: 1`, the immutable `deploymentId`, and the subset of reformulation/audience/personality/positioning approved by the worker's existing configuration and database binding. It never accepts an owner or prompt and never enqueues, repairs, sends a queue message, contacts a provider or creates readiness. Research and Naming are excluded. A null helper result means qualification was not established; an empty operation list means the protected worker was reached but no configured operation qualified. The web must still read caller-specific SQL availability first; the probe cannot confer an owner's eligibility or prove a future provider call will succeed.

The worker verifies RS256 signature, token age/expiry, the exact Embel issuer and audience, immutable team/project IDs, and the exact subject for either approved web environment. Team-specific JWKS are fetched from the fixed approved issuer. The old team, another project, development/custom environments, a mismatched subject, and multiple/wrong audiences are rejected. Deployment protection remains an independent boundary.

## Confirmed deployment inventory

Read-only inventory relayed by the integration lead on 2026-10-13:

| Item | Observed value |
| --- | --- |
| Web project | `fluid-platform-preview`, `prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt` |
| Current web team | `embel`, `team_0Koie5796IDOraQkDFg6J0AF` |
| Web production origin | `https://fluid-platform-preview.vercel.app` |
| Worker project | `fluid-api-text-worker`, `prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk` |
| Worker team | `mikael-charbonneaus-projects`, `team_f2xtDdokmMW21ByVgpJzIDDV` |
| Existing worker production deployment | `dpl_4o41tTKg5g91nmYugM67boqJ8Aeb` |
| Existing preview web worker origin | `https://fluid-api-text-worker-axjv1wuh0-mikael-charbonneaus-projects.vercel.app` |
| Web production worker origin | Missing |
| Database project | `fricsfwqibyhemknqgyf` |
| API bindings | Two, both pinned to the existing worker deployment; only reformulation enabled |
| Existing API dispatches | Two succeeded; no nonterminal API jobs at inspection |
| Protection | Vercel Authentication / All Deployments on both projects |

The worker's existing `FLUID_WEB_OIDC_ISSUER` and `FLUID_WEB_OIDC_AUDIENCE` still name the old team. The project metadata connector did not expose issuer mode or Trusted Sources rules. Confirm the web project uses Team issuer mode and inspect existing protection rules before updating them. No obsolete publisher trust is retained in this patch.

## Exact configuration for the repaired path

The existing worker's production configuration must use:

- `FLUID_WEB_OIDC_ISSUER=https://oidc.vercel.com/embel`
- `FLUID_WEB_OIDC_AUDIENCE=https://vercel.com/embel`
- Its existing restricted database credential, OpenAI configuration, paid-call approval, verified model, and Cron secret, unchanged.

The web's `FLUID_API_TEXT_WORKER_ORIGIN` in production and preview must point to the same newly qualified immutable worker deployment origin. The worker deployment ID used by SQL must be that deployment's actual `dpl_...` ID, not the web deployment ID or an alias. The web does not require an OpenAI key or `FLUID_PAID_CALLS_APPROVED=true`; these execution gates belong to the worker and database.

For cross-team protected access, inspect and preserve existing worker Trusted Sources rules. Use the official External Services / Vercel OIDC (external team) facility for these exact web workloads, targeting the worker's production environment:

| Claim | Exact accepted value |
| --- | --- |
| Issuer | `https://oidc.vercel.com/embel` |
| Audience | `https://vercel.com/embel` |
| `owner_id` | `team_0Koie5796IDOraQkDFg6J0AF` |
| `project_id` | `prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt` |
| Production `sub` | `owner:embel:project:fluid-platform-preview:environment:production` |
| Preview `sub` | `owner:embel:project:fluid-platform-preview:environment:preview` |

The current edge rule editor accepts a comma-separated list of exact values per claim, so both subjects can share one rule targeting worker production. Confirm or edit the issuer URL: the external-team template defaults to the global `https://oidc.vercel.com`, while this worker deliberately accepts the exact team issuer above. If the editor cannot express that issuer, use Custom provider with the exact issuer, audience and subject, retaining the owner/project claim restrictions. The independent worker signature/claim verification remains mandatory even after edge admission. Neither disabling deployment protection nor issuing a static bypass token is part of this repair.

Fresh read-only inspection on 2026-10-13 reconfirmed the inventory above. Native `get_project` and `get_deployment` still omit `oidcTokenConfig` and `trustedSources`; their omission is not evidence that either setting is absent. The native update schema accepts `trustedSources` as an untyped value, which is not sufficient to reconstruct existing rules. The alternate Rube connection requires reauthentication and cannot provide the missing raw state. Read existing rules and issuer mode through the authorized dashboard or a restored read-capable connection before making a preserving update.

## New-account eligibility and proposed first-response allowance

The current API worker is deliberately bound to one Embel owner. `api_text_worker_principals.role_name` is a primary key and `role_oid` is unique; `api_text_worker_owner()` derives that single owner from the real restricted database login. API admission additionally requires an enabled binding for the same owner, operation, role OID, exact policy digest and immutable deployment, plus the owner's API billing route and budget. An email-confirmed signup does not satisfy those runtime boundaries. Giving a new account a budget alone cannot make its first response work.

Fresh live reads found one API worker principal, two reformulation bindings (only the principal's matching binding enabled), two API billing routes, one $5 usage account and one $0 usage account. Only the reformulation runtime policy exists. Both API jobs are historical successful reformulations; there are no nonterminal API strategy jobs at this observation. This is a read-only snapshot, not a lock or authorization to reuse it for rollout.

The two recorded provider costs are **2,540 and 2,462 microdollars** ($0.002540 and $0.002462). They establish actual historical cost for these two short requests, not a general cost forecast. Each current request must reserve **122,880 microdollars** ($0.122880), which covers the pinned maximum of 32,768 input tokens charged at the policy's worst input rate ($2.50/million) plus 4,096 output tokens ($10/million). A low average cost must not replace that reservation bound.

Historical initial trial design, **not an authorization or a current funding instruction**:

- One first reformulation per explicitly approved, email-confirmed account, with a lifetime allowance of 122,880 microdollars, one active request, and no automatic replenishment. Use a separate consumed-attempt counter as well as the dollar ledger: refunding unused reservations must not turn a one-response allowance into dozens of responses.
- Limit the first cohort to 100 approved accounts and an aggregate reservation ceiling of 12,288,000 microdollars ($12.288). Hosting, queues, email and taxes are separate from this model-cost ceiling. No public automatic signup credits until the cohort and abuse controls are qualified.
- Require a server-recorded approval/entitlement, verified email, signup protection and bounded account/network admission. A browser-provided flag, `user_metadata`, or possession of a project ID must never confer eligibility. Settle count, cohort reservation and owner reservation atomically under the admission lock. This implementation never restores a consumed attempt automatically, including cancellation and known predispatch refusal. An uncertain provider outcome retains its reservation and blocks replacement until reconciliation.
- The original first-reformulation policy bound an exact model and input/output cap, zero web tools, no paid provider retry, cancellation, owner isolation and immutable job/outbox rules. It did not cover research, audience/personality/positioning, Naming, Identity or images. This history does not select the model or fund a new request.

The forward candidate [api_text_multi_account.sql](../../supabase/candidates/api_text_multi_account.sql) now implements owner entitlements, atomic allowance admission and descriptor-bound worker execution. It seeds one disabled rollout row with zero limits, creates no cohort or allowance, and grants no worker capability. The lead applied its byte-identical versioned migration on 2026-10-13; [hosted verification](database-rollout-20261013.md) confirmed these disabled defaults and preserved existing bindings. The existing principal mapping, owner budget and direct single-owner worker path remain available when rollout is disabled. The worker adapter requires the exact separate opt-in `FLUID_API_TEXT_MULTI_ACCOUNT_ENABLED=true`; its default retains existing queries.

### Multi-account execution boundary

Untrusted callers can submit project IDs, operation names, accepted costs, idempotency keys and queue descriptors. None can choose an owner, set execution context, mutate entitlements or supply SQL to the worker gateway. Authentication establishes the web owner. Cohort eligibility additionally requires a confirmed email and an operator-configured signup window, expiry, exact restricted role name/OID, immutable deployment and enabled bounded operation policy. Existing nonzero budgets, conflicting subscription routes or preexisting API bindings are not silently repurposed for signup enrollment.

Admission locks the global rollout, cohort, owner, project and usage account in that order. It creates the entitlement, configured budget/bindings, ordinary ledger reservation, immutable outbox and immutable allowance receipt in one transaction. Each admission permanently commits one attempt and the whole 122,880-microdollar maximum against per-account, cohort and global lifetime ceilings. Exact replay is checked again immediately after waiting on the global lock, so the final allowed request can still replay concurrently. Failed admission rolls back enrollment and every counter. Reads never fund an account. Cancellation releases the existing financial reservation while consumed attempts and allowance capacity remain consumed. Any admitted ambiguous outcome or envelope overrun pauses additional allowance admission and dispatch globally until reviewed reconciliation; the original ledger continues to record actual provider usage.

`api_text_dispatch_action(descriptor, action, arguments)` verifies all five immutable descriptor fields against the admitted outbox and derives the owner from that row. It permits either the original login-bound owner or a frozen allowance admission naming the current restricted `session_user` and its exact OID. It rejects privileged flags, role membership, role-owned objects, caller-supplied owners and unrecognized actions. The only permitted actions are `descriptor`, `expire`, `claim`, `published`, `redrive`, `runtime`, `authorize`, `heartbeat`, `plan`, `begin`, `complete`, `finish`, `step` and `has_results`, each with a fixed argument count. `runtime` checks the exact admitted operation/policy; recovery reads check the admitted owner/project. No action accepts an alternative job ID.

The gateway reuses the reviewed lease, step, cancellation and usage functions through a private context row keyed by backend PID, transaction ID and actual restricted role name/OID. This avoids copying the existing state machine into many independently drifting functions. The context exists only during one fixed call: return deletes it, error rolls back its insertion, and nested invocation is rejected. There is no caller-writable session setting or persistent pooled-connection authorization. Outside the gateway, `api_text_worker_owner()` retains the original login mapping. Table RLS is forced and all newly created helper/table ACLs, including hostile default grants, are scrubbed. The migration refuses unexpected original function bodies or security metadata before preserving the exact legacy implementations.

Current entitlement/cohort/rollout enablement is required for a new claim and final paid-dispatch authorization. Historical completion, cancellation, lease expiry and usage settlement use the frozen admission after withdrawal, avoiding stranded charged work. Repair enumerates only eligible queued work and expired leases authorized to this exact role. Worker readiness is quota-independent; caller-specific SQL remains responsible for the account's remaining allowance. Research, Naming, subscription work, images and Identity are outside this API extension.

The future worker grant packet contains exactly these additional signatures, reviewed against the actual existing restricted login/OID:

| Function | Capability |
| --- | --- |
| `public.api_text_dispatch_action(jsonb,text,jsonb)` | One fixed action on one immutable admitted descriptor |
| `public.list_api_text_dispatches_v2(integer)` | Up to 25 authorized pending descriptors; no raw jobs or prompts |
| `public.api_text_multi_account_readiness(jsonb,text)` | Up to four exact bounded operation policies for one deployment |

The candidate does not execute that grant packet. It grants no table read/write, private-schema usage, generic claim, role membership, administrator connection or provider access. The existing authenticated enqueue/availability facades keep their existing ACLs and signatures. Subscription quota SQL and worker hooks are unchanged.

### Activation dependencies

1. Finish the protected worker/web transport and exact deployment requalification described below, preserving All Deployments Vercel Authentication and existing trusted-source rules.
2. Database installation is complete after the pinned restricted-runtime and budget-status migrations. Hosted verification confirmed the disabled zero-limit state; local PostgreSQL verified compatibility with the original owner's workflow. Verify hosted worker readiness before any allowance configuration.
3. Review the three exact grants for the actual restricted login/OID and deploy the descriptor adapter with its explicit opt-in. Prove signed readiness and actual hosted connection/session behavior without admission or inference.
4. Explicitly approve and configure the model-cost funding, signup cohort/window, expiry, per-owner attempt/lifetime/active limits, cohort account/attempt/cost ceilings and global ceilings. Existing operation policies must already be approved; this code never enables them. Signup abuse protection is an activation requirement; confirmed email and monetary ceilings alone do not establish a unique human.
5. Enable only the reviewed rollout/cohort and verify owned admission plus a separately authorized provider response. No paid acceptance run is part of local qualification.

To withdraw access, disable rollout/cohort or entitlement while preserving the gateway and grants for already-admitted settlement. Do not turn the worker flag off or remove this schema while new-owner jobs remain nonterminal: the old direct single-owner path cannot settle them. No automatic counter reset, credit refill, owner rebinding or outbox rewrite is provided.

## Binding requalification

Build the isolated worker with `npm run build:api-text-worker`. Qualify the protected worker's code, environment, immutable URL and deployment ID before changing SQL or web publication configuration. The new `/api/readiness` probe permits a real signed workload check without paid inference; before binding requalification a new deployment is expected to return an empty operation list. After the exact binding is requalified, the existing approved operation can appear. Do not invoke enqueue, repair or inference as an unaudited smoke check: those endpoints can publish or execute real admitted work. Negative authentication requests and inspection of deployment/protection metadata do not establish a successful signed workload call.

Changing a binding's deployment ID affects future admissions. Existing outbox deployment/dispatch identities are immutable and must never be rewritten. Re-read nonterminal jobs while holding the existing owner coordination lock; if any appear, leave the binding unchanged and resolve them through their original deployment or existing cancellation/reconciliation flow.

The following review template has not been applied remotely. It changes only the already-enabled reformulation binding. Fill its four placeholders from a fresh, reviewed inventory and the qualified worker deployment. It leaves the disabled binding, owner mapping, operation, role, policy, budget, billing route, jobs and outbox unchanged. It grants no permission and creates no credential.

```sql
begin;
set local lock_timeout = '3s';
set local statement_timeout = '10s';
do $requalify$
declare
  v_expected_role oid := 'REPLACE_OBSERVED_ROLE_OID'::oid;
  v_expected_route_revision integer := 'REPLACE_OBSERVED_ROUTE_REVISION'::integer;
  v_expected_policy text := 'REPLACE_OBSERVED_64_HEX_POLICY_IDENTITY';
  v_old_deployment text := 'dpl_4o41tTKg5g91nmYugM67boqJ8Aeb';
  v_new_deployment text := 'REPLACE_QUALIFIED_IMMUTABLE_WORKER_DEPLOYMENT_ID';
  v_owner uuid;
  v_before fluid_private.api_strategy_bindings;
  v_after fluid_private.api_strategy_bindings;
  v_policy jsonb;
  v_changed integer;
begin
  if current_database() <> 'postgres'
     or v_new_deployment !~ '^dpl_[A-Za-z0-9_-]{1,196}$'
     or v_new_deployment = v_old_deployment
     or v_expected_policy !~ '^[0-9a-f]{64}$' then
    raise exception 'qualified_redeployment_evidence_required';
  end if;
  select owner_id into strict v_owner
  from fluid_private.api_text_worker_principals
  where role_name = 'fluid_api_text_worker' and role_oid = v_expected_role;
  perform fluid_private.lock_strategy_owner(v_owner);
  if not exists (
    select 1 from fluid_private.strategy_billing_routes
    where owner_id = v_owner and billing_mode = 'openai_api'
      and revision = v_expected_route_revision
  ) then raise exception 'billing_route_changed'; end if;
  select * into strict v_before from fluid_private.api_strategy_bindings
  where owner_id = v_owner and operation = 'strategy.reformulate' for update;
  select policy into strict v_policy from fluid_private.strategy_runtime_policy
  where operation = 'strategy.reformulate' for share;
  if v_before.role_oid <> v_expected_role or not v_before.enabled
     or v_before.policy_identity <> v_expected_policy
     or v_before.deployment_id <> v_old_deployment
     or not fluid_private.api_text_policy_allowed(
       v_owner, 'strategy.reformulate', v_policy, v_old_deployment, v_expected_role
     ) then raise exception 'existing_binding_changed'; end if;
  if exists (
    select 1 from public.jobs
    where owner_id = v_owner and billing_mode = 'openai_api'
      and fluid_private.api_text_operation(operation)
      and (state not in ('succeeded', 'failed', 'partial', 'cancelled')
        or lease_expires_at > clock_timestamp())
  ) or fluid_private.api_text_paid_paused(v_owner) then
    raise exception 'existing_api_work_requires_resolution';
  end if;
  update fluid_private.api_strategy_bindings
  set deployment_id = v_new_deployment
  where owner_id = v_owner and operation = 'strategy.reformulate'
    and role_oid = v_expected_role and policy_identity = v_expected_policy
    and deployment_id = v_old_deployment and enabled;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then raise exception 'binding_compare_and_swap_failed'; end if;
  select * into strict v_after from fluid_private.api_strategy_bindings
  where owner_id = v_owner and operation = 'strategy.reformulate';
  if (to_jsonb(v_before) - 'deployment_id') is distinct from
       (to_jsonb(v_after) - 'deployment_id')
     or not fluid_private.api_text_policy_allowed(
       v_owner, 'strategy.reformulate', v_policy, v_new_deployment, v_expected_role
     ) then raise exception 'requalified_binding_mismatch'; end if;
end $requalify$;
commit;
```

After the binding change, deploy the web with the matching worker origin and verify authenticated readiness plus the unchanged owner/policy/budget and historical outbox. A successful paid generation is a separate validation step requiring its existing applicable spending authorization; it was not run for this patch. Rollback uses the same lock, zero-active-work check and exact compare-and-swap in reverse. Restoring the old worker also restores its old publisher limitation.

## Evidence and boundaries

Focused tests cover production/preview publication, exact signed workload claims, safe pending responses, late token resolution, owner-scoped admission, cancellation before publication, exact replay, outbox generations, database lease/usage fences, and blocked research operations. All provider responses in these tests are synthetic. No remote configuration, SQL, deployment, inference, credential or permission changes were performed by the implementation agent. Whole-app verification and protected deployment are integration-lead steps.

Verification completed on 2026-10-13:

- `npx vitest run tests/server/api-text-publication.test.ts tests/api/strategy-jobs.test.ts tests/api/subscription-strategy.test.ts tests/worker/api-text-*.test.ts tests/database/api-text-*.test.ts --reporter=dot --maxWorkers=2`: 15 files, 289 tests passed.
- ESLint passed for all eight changed TypeScript files.
- `npm run build:api-text-worker` produced the isolated worker bundle successfully; no shared Next.js build was run by this agent.
- The SQL block above was extracted and executed with synthetic values in disposable PGlite. The success case changed only the enabled binding's deployment ID and preserved the disabled binding, historical outbox, billing route and usage state. Seven refusal cases preserved all rows after rollback: wrong role OID, route revision, policy identity, malformed new deployment, a pending job, a disabled binding and a superseded old deployment. This local check does not establish live pooler behavior or multi-session locking.

Additional first-response qualification verification on 2026-10-13:

- 82 focused tests passed across the new web/worker readiness, protected authentication, HTTP, configuration, package and disposable PostgreSQL suites. They cover late tokens, stalled streams/queries, duplicate or expanded operation claims, signed wire composition, exact deployment binding and the funded-but-unbound new-owner refusal.
- The real narrow qualification statement executed successfully under the existing disposable restricted-worker grants. Ledger, jobs, steps, outbox, principals, bindings, billing routes and policies were byte-for-byte unchanged by the probe. PGlite does not establish live pooler or multi-session locking behavior.
- Scoped TypeScript and ESLint passed. The four-entrypoint isolated worker package built successfully; no shared Next.js build or deployment was performed by this workstream.
- The fresh read-only live inventory and source-document snapshots are retained outside the checkout at `/workspace/scratch/fluid-functional-workstreams-20261013/first-ai`. No live provider request, policy/budget activation, deployment, credential or protection mutation was performed.

Multi-account candidate qualification on 2026-10-13:

- The candidate was applied against the complete migration baseline in a disposable loopback PostgreSQL 17 database. Eighteen distinct assertions passed across the full run (17 passed; one fixture-reset statement timeout) and a focused rerun of that remaining case (1 passed). Both logs are retained; this is not reported as one uninterrupted green run.
- Independent connections verified concurrent global exhaustion, exact replay of the final allowance, and backend/transaction context isolation. Tests also verified default-disabled zero funding, the original owner's complete direct-worker flow, read-without-credit, failed-admission rollback, each configured allowance ceiling, nested-call rollback, raw-table denial, foreign descriptor/lease rejection, and settlement after entitlement withdrawal.
- Real gateway publication/repair and worker delivery used only injected synthetic queue/provider transports. One completed response recorded exactly 691 microdollars in the existing ledger; duplicate delivery made no second provider request. An unknown response retained the reservation, paused further allowance admission and remained non-retryable.
- Evidence is at `/workspace/scratch/fluid-integration-20261013/first-ai`. The added 19-case PGlite suite, adapter/readiness unit checks, combined TypeScript/lint and final worker package build remain integration-lead checks; they are not counted as passed in this candidate receipt. The initial PGlite attempt timed out during setup before reaching assertions.

Official sources checked 2026-10-13:

- [Vercel OIDC API](https://vercel.com/docs/oidc/api)
- [Vercel OIDC reference](https://vercel.com/docs/oidc/reference)
- [Deployment protection Trusted Sources](https://vercel.com/docs/security/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources)
- [Vercel deployment guidance skill](skill://plugin_connector_690a90ec05c881918afb6a55dc9bbaa1/deployments-cicd/SKILL.md)
