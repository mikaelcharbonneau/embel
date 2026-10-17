# Naming brain activation packet — 2026-10-16, updated 2026-10-17

**Preparation only; execution is not authorized or verified.** The implementation
approval covers local source and synthetic qualification. It does not authorize
hosted migrations, grants, credentials, provider access, funding, inference or a
new deployment. The user-approved pilot ceiling is US$25; it is not evidence that
an account has been funded or that a configured model is accessible. See
[naming engineering decisions](naming-brain-engineering-decisions-20261016.md).

## Revision and migration gate

The reviewed backend/runtime and R1–R3 QA safeguards are integrated at
`069b8be4efa7fc00d7267e064d102c6daa11dc1f`; that checkout was clean before this
documentation update. The earlier `3abfa6571087a518e013bb88b7d7acb4ab302064`
partial-source QA results remain historical evidence. D071's chat-first Naming
correction, remaining SQL recovery qualification and the final integrated matrix
are still separate work. This packet **must be bound to that final reviewed
commit before execution**; it does not declare the whole branch verified.

The dedicated Node graph is `worker/index.ts`, invoked by `npm run worker`
(`node --conditions=react-server --import tsx worker/index.ts`).
`build:api-text-worker` bundles only the existing hosted API-text / Strategy
entrypoints and does not establish Naming deployment or readiness. The existing
`npm run local` subscription launcher starts `worker/local-runtime.ts`, removes
`OPENAI_API_KEY` from its children and forces `FLUID_PAID_CALLS_APPROVED=false`;
it does not start this managed Naming graph.

| Item | Preparation status / required read-back |
| --- | --- |
| Additive migration | `supabase/migrations/20261016180000_naming_brain.sql` |
| Final reviewed migration SHA-256 | `b55c29851e1d11efdb00eb8d2831f256884e31501beab98c178c8b7220da1d8f`, recomputed at `069b8be4efa7fc00d7267e064d102c6daa11dc1f`. Recompute again at the final freeze. |
| Historical round-one candidate digest | `8759c191bcb20c56db56d763bb6370e523921c65d1944353bb84ba431bf61b1e`; superseded by the reviewed fixes, **not an activation digest**. |
| Final source commit and tree | Reviewed backend/runtime base is `069b8be4efa7fc00d7267e064d102c6daa11dc1f`; final D071 integration/freeze and complete verification matrix remain pending. |
| Database target / application origin / worker deployment | Unverified. Bind their exact identities to the approved source; do not infer them from a familiar service name. |
| Existing personal runtime login and role OID | Unverified. No login, grant or persistent credential was created for this task. |
| Model and managed API capability | Unverified. Pin the actual model in the reviewed policy; do not substitute another model. |

Before authorized installation, compare local `git rev-parse HEAD`, tracked tree,
clean worktree state and migration SHA-256 with the approved packet. Reconcile any
change through review first. Inspect the target migration ledger and dependencies;
this is one additive migration, not a reset or replay of previous Fluid code.
After installation, read back the exact ledger revision, function definitions /
ACLs and FORCE RLS state. Preserve the evidence without connection strings,
cookies, API keys or raw private payloads.

## Restricted runtime identity and grants

Use the **existing restricted personal login** only after its name, OID and
approved account owner are verified. Check `session_user`, `current_user`,
`pg_roles.oid`, `rolcanlogin`, `rolsuper`, `rolbypassrls`, inheritance and every role
membership using the real direct connection and the actual pooler path. Confirm
`api_text_restricted_role` accepts precisely this principal; a renamed/recreated
role with another OID must fail. Verify the exact deployment ID frozen into the
private pilot policy and run. No generic worker, table privilege, `service_role`,
admin fallback or role switching may satisfy these checks.

The reviewed restricted-worker EXECUTE packet must name **all nine signatures**
below, and only those Naming capabilities. The first seven are the scoped worker
lifecycle; the last two are the trusted preference-readiness seam. Apply no wildcard
`GRANT EXECUTE ON ALL FUNCTIONS` and no direct table grants. This migration does not
install a worker login or grant these private functions to browser principals.
All nine definitions were matched to the reviewed migration source; their live
OIDs, owners and ACLs remain unverified.

```sql
public.report_naming_brain_worker_ready(jsonb, text, text, integer)
public.claim_naming_brain_job(text, text, integer)
public.expire_naming_brain_leases(text, text)
public.naming_brain_worker_action(uuid, uuid, text, jsonb)
public.authorize_naming_brain_dispatch(uuid, uuid, jsonb)
public.record_naming_brain_provider_receipt(uuid, uuid, jsonb)
public.complete_naming_brain_stage(uuid, uuid, text, text, jsonb)
public.get_naming_brain_preference_work(integer)
public.attest_naming_brain_preferences(uuid, integer, text, jsonb, jsonb)
```

Before any grant, resolve each exact signature through `to_regprocedure` and inspect
its owner, security-definer setting, pinned search path and ACL. Compare actual
PUBLIC/anon/authenticated/service-role access and default ACLs with the reviewed
migration. No incidental broad membership may recreate revoked permissions. Record
only the verified login name/OID, function OIDs/signatures and nonsecret read-back.
Any necessary grant or role change requires its separate explicit authorization.

With two genuinely distinct owner accounts and native PostgreSQL sessions, verify
that foreign project/source/seed/candidate/run IDs fail; clients cannot forge
readiness or insert private work; wrong login/OID/deployment cannot claim or write;
generic claim and expiry cannot touch V2; stale leases/replayed dispatch cannot
execute; deletion/Stop can cancel and retain existing evidence without new work.
Run simultaneous native sessions for lock order, duplicate admission, Stop versus
ensure, index-writer coverage invalidation and held-budget exhaustion. PGlite's
synthetic session authorization and single embedded engine do not prove these
native process/pooler/concurrency properties.

## Trusted preferences and model gates

The worker obtains immutable owned preferences through
`get_naming_brain_preference_work(20)`, validates them with the pinned shared
JavaScript schema/normalizer and calls `getNamingPreferencesReadiness`. It submits
an exact version/hash/fingerprint/readiness attestation, not a browser readiness
flag or an echoed expected fingerprint. Saved drafts and free saved-output browsing
remain independent of paid readiness.

The reviewed normalizer source hash, recomputed at `069b8be4efa7fc00d7267e064d102c6daa11dc1f`, is
`7108319323898692a388fcf17cb542509583288b0d4b05d7384f8c5b707aeb01` for
`src/domain/naming-brain-preferences.ts`. Recompute it from the final source.
Fingerprint version 1 is:

```text
normalizer: naming-preferences-v1:nfc-lower-nfc
implementationHash: exact shared source SHA-256
nodeVersion: actual dedicated worker Node version
icuVersion: actual dedicated worker ICU version
unicodeVersion: actual dedicated worker Unicode version
```

The local runtime report records Node 22.22.2 / ICU 78.2 / Unicode 17.0. Those are
local observations, not values to copy into a different deployment. The private
pilot `readiness_fingerprint` must match the actual approved worker runtime. SQL
case conversion is not a substitute for the JavaScript normalization.

Bind the exact owner, role/OID, deployment, policy identity and verified model in
the private pilot configuration. The managed protocol remains primary. Research,
Director, independent Creators (maximum three concurrently), Curator and Verifier
retain their separate capabilities, the seven-stage manifest and immutable call
plans. Initial target is 150 raw / 100 published with a floor of five primary
credits per selected approach. One gap has a 75-cent envelope: direction 10,
creation 40, curation 5, verification 20; search maxima 0/0/0/8. Do not re-lend caps,
truncate review coverage, fall back to Responses or silently choose another model.

The exact dedicated worker configuration read by
`worker/naming-brain-configuration.ts` is:

| Environment key | Required meaning |
| --- | --- |
| `OPENAI_API_KEY` | API key with actual access to the exact managed Agents model; the parser requires 16–500 nonwhitespace characters. |
| `FLUID_NAMING_BRAIN_MODEL` | Exact approved model identifier, with no silent substitute. |
| `FLUID_OPENAI_VERIFIED_MODELS` | Comma-separated list containing that exact model. Configuration alone does not verify access. |
| `FLUID_NAMING_BRAIN_DATABASE_URL` | Dedicated PostgreSQL connection using the verified restricted personal login/OID. The generic Strategy connection is not a Naming substitute. |
| `FLUID_NAMING_BRAIN_DEPLOYMENT_ID` | Exact deployment binding, matching the private pilot and admitted run. |
| `FLUID_NAMING_BRAIN_ENABLED` | Literal `true` is required for paid dispatch. |
| `FLUID_PAID_CALLS_APPROVED` | Literal `true` is also required for paid dispatch. |

Both paid gates and SQL readiness must pass. SQL separately binds the owner,
restricted login/OID, deployment, exact policy and readiness fingerprint; its
pilot must be enabled and its heartbeat fresh. `worker/index.ts` receives these
keys from its invoking environment; it does not load a Naming credential file.
The exact secure action-time configuration destination remains unapproved and
must be recorded before configuration. The existing protected
`.local-fluid/worker.env` accepts only the historical subscription
`FLUID_WORKER_DATABASE_URL` and is not a Naming configuration destination.

Keep paid flags false during separately authorized attestation/startup validation.
Disabled paid flags do not make worker startup offline: it can attest preferences,
claim existing scoped work and observe known sessions. Initial setup failure closes
the pool and exits. A hosted Strategy build is not a readiness attestation for this
graph. The managed protocol pins `https://api.openai.com/v1`, disables SDK retries,
and has no Responses, alternate endpoint or alternate-model fallback.

The 2026-10-17 read-only local audit found all seven keys absent from the inherited
audit environment. None of the six standard `.env*` files or
`.local-fluid/worker.env` exists in the QA worktree. Main-checkout `.env.local`
exists with mode 0600 and contains the public web configuration key names and
`FLUID_PAID_CALLS_APPROVED`; it contains none of the other six worker keys. Only key
presence was inspected, never secret values. This does not describe any hosted or
running-process configuration and is not permission to copy private runtime files.

## Funding and known-session observation

Separately authorize any owner funding and its exact amount. Read back the account
balance and complete pilot commitment before enabling a new run. Every paid run
holds 5,000,000 micro-USD (US$5). Aggregate commitment is **confirmed final expense
plus every full unsettled hold**, at most 25,000,000 micro-USD (US$25); at most five
fully held unreconciled runs fit an otherwise empty pilot. Ordinary account
reservation rules apply as well. Completion does not release the hold. Estimates,
session caps and provisional spend counters cannot create expense or a refund.

Unknown create/dispatch identity, unresolved execution or observed overrun blocks
new work even when arithmetic headroom exists. Known-session recovery must use the
same admitted identity and allowance; it may observe with paid flags disabled.
Verify that scenario using an explicitly authorized known session: no create,
replacement turn, tool continuation or paid phase is allowed. The observation
window is bounded to 12 claims / one hour with persisted 30-second-to-five-minute
backoff. Re-enable paid work only under fresh exact readiness and the original
unissued plan/deadline. Explicit terminal Resume is a separate linked run and
allowance; ordinary scrolling cannot perform it. A proven no-dispatch cancellation
is the distinct zero-charge release case and needs its database proof.

## Guarded runner and read-back

`scripts/naming-brain-pilot.mjs` is opt-in preparation, not an activated service.
It refuses by default and accepts exactly one explicit admission operation. A
separately approved short-lived configuration must bind the owner/project, exact
HTTPS origin, final source revision, final migration digest, policy, full owner run
inventory, current aggregate commitment and stable ensure intent. `approval` fields
are operator attestations, **not self-verifying proof** of deployment or grants.
The operator must establish them through the read-backs above; no public endpoint
currently exposes a complete pilot-wide inventory or deployment revision.

The runner checks `/api/session`, the owned project and saved V2 choices, the named
existing run receipts and current feed/policy/revision. It sends the single exact
`/naming/feed/ensure` intent with expected-account fencing. It never creates a
project, edits choices, enables a provider, funds an account, grants access or
follows redirects. An ephemeral authenticated session may be supplied only through
the separately authorized secure action-time route, through the runner-only
`EMBEL_NAMING_PILOT_COOKIE` environment key. Never persist it or paste it into
source, command history, this document, screenshots or logs. The runner requires
an exact HTTPS origin; an ordinary HTTP loopback preview does not satisfy that
guard. A local browser pilot can use its separately authorized signed-in UI rather
than extracting a browser session for this runner.

Do not execute this command until all gates and separate execution authority exist:

```text
node --import tsx scripts/naming-brain-pilot.mjs --execute-approved-pilot <approved-short-lived-config.json>
```

The configuration schema is defined in the runner and exercised using only
synthetic `.invalid` origins and an inert fetch in
`tests/qa/naming-brain-pilot.test.ts`. No runnable live configuration is supplied.
On a lost acknowledgement, preserve the exact intent and idempotency key; do not
rerun with another key or infer failure/zero cost. Read the saved feed/run before
considering the same request's recovery. The database remains the atomic admission
and budget authority, including concurrent requests from other tabs.

After a separately authorized pilot, bind its run/job/batch IDs and receipts to the
approved source, compare equal **unique-name counts**, retain source text/hashes /
quote bindings, and distinguish creative interpretation from verified statements.
Keep sustainable-coffee and Namelix comparison answers outside model prompts.
Record output fulfillment separately from nullable final charges. Do not describe
local synthetic results as live generation, native database isolation or billing
qualification.

## Minimal path to the first local real-name test

1. Finish and review the D071 chat-left/results-right correction, remaining actual
   SQL recovery cases and final stable-source matrix in the verification record.
   Freeze one source revision and recompute the migration/normalizer digests.
2. Under separate explicit activation authority, install/read back that exact
   additive migration and the nine scoped EXECUTE grants on the identified
   development database; verify the existing restricted login/OID, owner, policy,
   runtime fingerprint and deployment. Configure the seven worker keys through the
   approved secure destination, verify exact managed-model access and available
   funding, then validate attestation/readiness before enabling paid admission.
   Any new credentials, grant change or additional funding needs its exact action
   authorization; the US$25 ceiling does not itself perform or approve those acts.
3. Use the same reviewed local web/Node source, sign into the intended account,
   save its Naming choices, and admit one explicitly approved initial run with a
   full US$5 hold inside the US$25 total. Review actual published names and retained
   evidence; keep final charges null and the full hold until verified settlement.

Source/doc fixes, inert tests, builds and the final packet can continue under the
existing local approval. None of those authorizes starting the connected worker,
applying database changes, supplying credentials or making the paid pilot call.
A public deployment is not required for a local browser test.

## Revision-bound pause and rollback

If identity, model, readiness, cost or evidence differs, disable new paid admissions
and both paid gates first; preserve exact known-session observation under its
original principal/deployment. Request owner-scoped Stop through the saved API for
active exploration and read back its advanced demand sequence/paused state. Do not
assume Stop means no charge or delete receipts, artifacts, leases or reservations.
Never resume by reverting to generic workers.

Prefer pausing the feature over a destructive down migration. Keep the additive
schema and immutable history. Revert application source only to a separately
reviewed compatible revision; record that commit and verify each receiving
checkout, dedicated worker and application deployment reports the same approved
revision. Restore grants/configuration only to their recorded prior state with
separate authority, then recheck ACLs/role OIDs. Retain unresolved holds until
verified reconciliation. Any corrective migration, credential change, new funding
or subsequent paid attempt is a new explicit action.
