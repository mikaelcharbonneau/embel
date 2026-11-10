> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Native Naming restoration — 2026-10-25

> Historical: retired by the November 2026 Naming generation rebuild (docs/naming-generation-contract.md).

## Current requirement and implementation

The user's October 25 correction explicitly rejects monetary limits. The prior
US$5 requirement in the delegation was obsolete. It is not a release gate, and
no provider spending guarantee or narrowed research mode is required to restore
the approved flow. This supersedes the cost decision in the original PR146
prototype documents. No new paid test or production action was authorized.

This implementation uses the **existing native Agents pipeline**, preserving
the configured `gpt-6-luna` / `xhigh`, live `web_search`, retained
`read_reference` evidence, independent Creators, factual verification, curated
progressive publication and the 100-name target. It does not replace broad
research with eight known-URL fetches or switch to Responses.

The change starts from deployed main
`0260f7ac482a9c3a77d0198adc21e6ba2797e9a5` and incorporates PR146 at
`9638c700f460ef7c8ae4c90450d4ff684af3074f`. Its useful inactive adapter/ledger
recovery work remains separately documented and tested. The Responses ledger
candidate is **not part of native activation** and must not be installed for
this repair. Its expired qualification is historical, not a blocker for native
uncapped execution.

## Concrete integration

- The authenticated Naming data layer no longer overrides new work or saved
  feeds with `provider_budget_control_unavailable`. Real saved preferences,
  ownership, current project revisions, deployment capability and worker
  availability still determine admission.
- The native SDK factory no longer refuses creation or tool-result continuation
  based on a hard-coded spending-support function. Future hosted requests retain
  `local_unlimited_v1`, pipeline 2 and contract 3 compatibility identifiers and
  omit both `spend_control` and provider-cap metadata. The existing worker's
  database-derived execution authority selects that profile; a caller flag
  cannot manufacture a hosted claim.
- The additive migration
  `20261025232300_naming_uncapped_hosted_execution.sql` marks **new** hosted jobs
  with `providerBudgetVersion: 2`. This legacy field's version 2 means uncapped
  execution. Its strict hosted/pipeline/timing witness is validated in SQL and
  TypeScript. Existing version-1 jobs retain their exact frozen capped requests
  and recovery evidence; no stored request is rewritten.
- The SQL cap helper contributes zero to the old cap accumulator for a valid
  uncapped request. Zero here is an exemption from that historical calculation,
  never a zero-cost observation or settlement. New plans and dispatch can exceed
  the obsolete nominal limit. Observed usage remains retained information and
  cannot pause future uncapped work merely because it exceeds that number.
- The existing `createNamingBrainHandlers` and progressive handler perform the
  complete native workflow and publish genuine Agents artifacts to the owned
  feed. No new orchestration or fabricated Responses provenance is introduced.
  The worker source allowlist drops only the now-unused cost-availability module.
- Historical nonretryable errors remain visible. They must not permanently
  disable a newly available uncapped generation path. Current server admission
  and explicit saved-run capabilities govern the controls. A retained
  nonretryable rejection requires the explicit Resume action; it does not receive
  a server capability for scroll-triggered Resume. An unavailable or malformed
  failure-classification read also withholds that scroll capability while
  preserving saved reads, current availability and manual Resume.

Historical policy fields and bookkeeping reservations retain their original
values for schema/request/accounting compatibility. They do not enforce a
monetary limit on the exact unmetered hosted execution authority. Existing holds,
unknown outcomes and NULL actual costs are preserved; no synthetic refund,
estimated final charge or zero-cost settlement is introduced.

Cancellation, deadlines, duplicate prevention, immutable requests, one-shot
authorization, owner/project/role/lease fences, factual source validation and
unknown-create recovery remain enforced. Removing monetary limits does not
authorize replaying an uncertain request or resuming a frozen historical capped
request as if it were uncapped.

## Verification and its limits

The draft PR records final commands, counts and source SHA. Mocked acceptance
uses the actual OpenAI SDK, native transport, durable migrated SQL store,
restricted worker, publication transactions and ordinary server feed/run/batch
readers. It exercises 100 unique persisted names, early publication, exact-plan
crash/reclaim/recovery, reload, idempotency, Stop/saved continuation, optional
Director failure and an unknown Director outcome. Future hosted cases assert
version 2, absent spend limits, unchanged model/effort and live research tools.
Large synthetic usage observations do not become a spending stop or final bill.
Existing reference/verification suites retain genuine-shaped required-action,
source hash, excerpt and quotation validation.

Disposable database tests also exercise new uncapped admission, plans exceeding
the former nominal limit, cap-smuggling rejection, tenant and Stop fences,
historical version-1 preservation and unchanged accounting/privileges. PGlite
does not establish real PostgreSQL concurrent-session or pooler behavior.

No authenticated provider or count request, paid acceptance, live database
mutation, credential/access change, deployment, remote PR merge or worker
scaling occurred. Live service health and creative quality are unverified here;
they are operational acceptance limits, not a reason to restore monetary gates.

## Exact coordinated release and activation sequence

These are parent-owned future release steps, not actions executed by this coding
task. A successful web build alone does not activate a worker.

No-paid readiness checks are separate from generation acceptance. In the
qualified release environment, `node services/naming-worker/dist/index.js
--preflight` verifies the exact runtime, restricted database role and TLS inside
a read-only transaction, then exits. `--standby` performs the same check, closes
its database pool and waits for shutdown. Neither mode claims jobs, publishes a
readiness heartbeat, calls a provider or writes job state. Require the emitted
`jobMutations: false` and `providerCalls: false` facts. The offline deployment
receipt verifier below and authenticated saved-feed/hosted-availability reads
also require no inference. Do not start normal run mode as a readiness probe;
it can claim and execute work.

1. Review and merge the native repair, then pin that clean main SHA for the web
   and dedicated Naming artifact. Run `npm run typecheck`, `npm run lint`, the
   relevant mocked/database suites, `npm run build` and
   `npm run build:naming-worker`. Build/package from the same clean SHA; the
   manifest must bind its revision, dedicated project, digest and reviewed source
   graph. Preserve protected deployment access and existing secrets.
2. Under the coordinated release authorization, close new hosted admission and
   drain/freeze the current publisher using the existing owner-bound capability
   and no-overlap procedure in [cloud Naming worker](cloud-naming-worker-20261019.md).
   Keep historical observation/recovery available. Do not run old and new
   readiness publishers concurrently.
3. Deploy the compatible web and worker code with the worker stopped or in its
   existing preflight/standby mode. Both versions must understand new marker 2
   before the migration can admit such jobs. Preserve old marker-1 recovery.
4. Inventory actual migration history and the exact predecessor function bodies.
   Rehearse, then separately install only
   `20261025232300_naming_uncapped_hosted_execution.sql`. It checks predecessor
   body hashes, owner/security properties and exact replacement fragments and
   fails atomically on a mismatch. It changes future hosted admission, the cap
   compatibility helper and summary projection; it creates no roles/grants and
   rewrites no jobs, requests, receipts or holds. Reconcile any intervening
   migration before applying; never bypass its predecessor checks. **Do not
   install `supabase/candidates/naming-responses-ledger.sql`.**
5. Build the new image for the exact release SHA and verify its deployment
   receipt using `scripts/verify-naming-deployment.mjs`. Confirm the real
   dedicated Vercel project, main revision, bundle digest, `iad1`, Node 22.22.2 /
   ICU 78.2 / Unicode 17.0, restricted database role/OID/TLS, existing deployment
   policy binding and configured Luna model. Keep the original reasoning/tier
   selection. No cap-enforcement capability or new cost-limit flag is needed.
6. Monitoring/scaling remains a separate task. Existing deployment
   `dpl_H11vHnuBsHkMcRM6dbJw5PTN1hFx` may be zero-scaled and has not been changed.
   Do not assume rescaling that older artifact installs this code. Establish the
   new verified image's standby readiness, stop the old publisher, then activate
   exactly one new instance through the existing release controls. The committed
   daemon manifest remains at zero instances until that separate activation.
7. Enable the existing scoped hosted capability only after the new worker's
   heartbeat and database identity qualify. Preserve the existing paid-dispatch
   authorization controls; the no-cost-limits correction is not permission for
   an autonomous paid coding test. Read authenticated hosted availability and
   confirm that it reflects worker readiness, not the removed budget error.
8. On a separately authorized real run, submit one explicit generation intent
   from saved account preferences. Verify the new job has marker 2, its actual
   provider requests omit `spend_control`, original research/model behavior is
   retained, 100 validated names persist across reload, and Stop/recovery work.
   Record real usage as observations and leave final charges unknown until
   authoritative billing evidence exists. Do not automatically retry a lost
   create or convert old rejected history into a new request. For a known old
   capped rejection, use the existing explicit Resume action: it creates a new
   linked uncapped run with the source run/revision witness. A fresh initial key
   alone deliberately reuses the old demand; it is not an automatic upgrade.

Rollback closes new admission and stops new dispatch through those same scoped
controls while preserving issued work, reads and recovery. Keep code capable of
reading marker 2 once any such job exists; do not revert its jobs to marker 1 or
drop evidence. No live activation is claimed by this source checkpoint.
