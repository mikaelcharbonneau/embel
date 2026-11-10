> Archived November 10, 2026: describes the system before the generation engine.

# Trusted vector-proposal quotes, source-only continuation

Historical component/integration documentation. See the [current checkpoint verification status](verification-status.md); machine-specific execution evidence is intentionally retained outside this source snapshot.

2026-10-08. This increment builds on the preserved partial Task 2 packet. It implements verified quote preparation and quote persistence; it does not complete paid admission, provider execution/completion, proposal applicability or candidate creation.

## Real quote path

The `propose_vector_edit` HTTP branch resolves fresh authenticated project services. Those services provide the existing owner-bound storage/connection capabilities and actual workspace/current-vector, vector-detail, brief and font readers. No privileged service is used to establish ordinary account ownership. Missing configuration remains unavailable.

`createLogoVectorProposalQuoteService` verifies current saved heads and current base, reads the actual canonical document, SVG and original raster bytes, reruns the existing byte/proof validators, and compares the document against the owned detail. It loads the original brief and exact owned font records. Eligible font records must pass the existing actual font/license resolver; the returned record/content hash/bytes/purpose must match exactly. It then builds the frozen Task 1 metadata context and rechecks heads/base before acquiring a restricted connection. The producer has only asset-read capability and performs no storage write, candidate mutation, provider request or charge.

One fixed private SQL call uses the actual `session_user` name/OID and owner binding. The new helper independently checks project ownership, current heads/base, the exact immutable base/brief/font records and context bindings. It requires the separate text policy, matching fresh worker readiness, shared paid-uncertainty gate and available budget. It inserts one immutable cost quote containing the frozen context, full private source/font records, SQL-derived context/input hashes and exact text policy. It creates no job and no usage reservation. Lost acknowledgments are not retried automatically; an unused quote cannot dispatch anything by itself.

## Bounds and disabled state

The proposed synthetic policy is independently versioned for `identity.logo_vector_propose` and cannot inherit Strategy/image configuration. Its maximum is derived from the fixed token/rate limits of the existing qualification card, including the highest permitted input rate. This is not live pricing/access qualification or spending authorization.

The known AI-safe `{context,instruction}` envelope is counted in UTF-8 JSONB bytes and must fit the policy without truncation before quote insertion. This is only the known payload bound. The later provider adapter must still enforce exact final prompt/schema overhead, input-token counting, output limits, model/tier access, last-dispatch readiness and actual billing evidence.

The SQL candidate adds a nullable `text_policy` with an operation-specific constraint and no seed. It adjusts three existing functions through exact predecessor checks: policy descriptor, readiness reporter and legacy quote hash serialization. Old descriptors and quote hashes remain unchanged. No helper grant, principal, credential, host handler, active host enumeration, policy enablement or paid operation is installed. The current SQL admission branch still rejects this operation, and the UI capability remains unavailable.

The route passes ordinary quote operations down their original path. Construction of all composed services remains zero-I/O. Source-dependent quote work starts only after an explicit new quote request.

## Corrections carried from the first partial review

- A proposal dispatch receipt now requires exactly one durable job ID; existing concept receipt cardinality is unchanged.
- The asset-denial regression now constructs an otherwise-readable owned quote/raster membership and proves the old helper returns true when only the new guard is removed inside a disposable DB. Restoring the guard proves denial. The original frozen WIP test did not establish that counterfactual; its source guard itself was correct.
- The original WIP comment overstated a Task 3 dependency. Quote preparation uses existing verified readers and belongs to Task 2. Actual candidate application/provenance association remains Task 3.
- The verified tar is the canonical full packet because a unified text patch omits newly created zero-byte evidence logs.

## Verification and remaining work

Actual commands/results are in `docs/evidence/logo-vector-proposal-quote/`. Tests use real local PostgreSQL roles/ACLs and actual pinned font/canonical vector/raster bytes with explicitly synthetic owner/provider/storage fixtures. They do not prove hosted concurrency, live permissions, provider access, paid accounting, end-to-end sixth-lane execution or artwork quality.

The remaining Task 2 map is separately preserved at `[local task path omitted]`. Paid admission must still gain exact new-policy/source/cap checks, one immutable job/step/attempt, original-key durable recovery, leased provider accounting/evidence, uncertain-output retention and atomic proposal completion. Those changes must preserve the existing requirement that API jobs keep the subscription-only `public.jobs.policy_identity` column null and bind the proposal policy through the immutable input/quote instead. Task 3 then adds actual candidate validation and association; Task 6 owns host integration. No complete Task 2 or activation claim is made here.
