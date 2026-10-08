# Bounded Vector AI Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans when implementation is assigned. Use the already authorized staffing and execution method. This deliverable is source-only planning; it does not start implementation or activation.

**Goal:** Add natural-language proposals for supported whole-component vector controls while preserving exact geometry, locks, immutable history, cost consent and owner/CAS provenance.

**Architecture:** A separately priced, durable text job proposes exactly one allowlisted edit against a verified, frozen summary of an existing vector. An explicit, zero-AI-cost “Create candidate” action applies the persisted proposal through the existing authenticated vector producer and trusted transaction. The existing explicit vector-acceptance flow remains the only approval step. The text worker receives no vector/font storage capability.

**Tech Stack:** Existing TypeScript, Zod, Vitest/PGlite, React/Playwright, dedicated logo worker, OpenAI Responses transport, canonical vector validators, HarfBuzz and private owner storage. No new package or rendering engine is required.

**Spec:** `docs/superpowers/specs/2026-10-06-fluid-logo-visual-identity-approved.md`; approved Packages 1–3 and their shared contracts. Read `AGENTS.md`, `docs/decisions.md`, `docs/architecture.md`, and the latest integrated host documentation before implementation.

**Investigated baseline:** `[local task path omitted]`, read on 2026-10-08. This transfer is not a Git checkout; its name is not proof of a current commit. Rebase the plan on the integration owner's final source manifest before edits. No source file was changed, no test/build was run, and no provider or hosted service was called for this plan.

## Conclusion and scope decision

The proposed path can implement useful vector-source AI refinement without asking AI to regenerate artwork: AI selects a constrained command; existing code computes and validates the candidate. It can preserve locked components because it never accepts replacement geometry from the model. A new image/vector-generation contract is not essential for this bounded increment.

A **new operation/admission and proposal-provenance contract is essential**. The current `identity.logo_refine` is tied to paid image generation, a raster revision, image storage and `logo-image-v1`; the current API text worker admits Strategy operations. Neither may be silently reused for a differently billed logo task.

This is an implementation proposal within the approved functional direction, not evidence that the complete approved AI-refinement scope has shipped. Arbitrary drawing changes still need a separately qualified generation path. The prior approved P3 raster-to-vector refinement facade remains unimplemented and is not fulfilled by renaming this increment.

### What is approved, and what is proposed

Approved requirements include natural-language revision, direct text/font/spacing/size/rotation/color/arrangement controls, effective component locks, explicit cost consent before AI, exact spelling, preserved originals, immutable versions, explicit restore, honest unsupported operations and durable uncertain/partial outcomes. All seven logo types remain in scope; supported controls depend on actual document structure, not the type label.

The proposed bounded increment is:

- One natural-language request produces **exactly one command** or an explicit unsupported/no-change result.
- Allow commands: `size`, `rotation`, `color`, `arrangement`, `font`, `spacing`.
- `size`, `rotation`, `color` target an existing, explicitly identified component. `arrangement` may atomically place/order multiple existing components, using its existing single-command semantics.
- Font and spacing apply only to existing `editable_text` lettering, actual owned permitted fonts and the existing shaping limits. Font recommendations are constrained to the frozen, rights-qualified catalog; no inferred or downloaded font.
- Color initially requires a uniform fill/stroke presence and color per target component. Preserve existing null channels, path paint opacity and stroke attributes. Refuse ambiguous multi-paint recoloring rather than flattening a mascot's palette.
- No `locks`, `group_components`, `text`, `replace_outlined_lettering`, raw SVG, path/glyph arrays, insertion, deletion, path cutting, viewBox changes or new component IDs in AI output. Existing manual controls remain available for their valid explicit workflows.
- Preserve the exact existing brand name or approved initials. Changing spelling belongs to the brief/source workflow. Replacing outlined lettering is still an explicit manual conversion, visibly distinct from editing a font.
- A request for “make the symbol smaller and change the font” is unsupported as a combined request in this version. Do not silently choose half of it, split it into multiple charged jobs or save several candidate revisions. The user may explicitly request those separately.

### Atomicity: why one command is the minimum

`src/domain/logo-workspace.ts::saveLogoEditInputSchema` contains one `edit: logoManualEditSchema`. `createLogoVectorMutationProducers().saveLogoEdit` computes one candidate, stages two files, then commits one immutable revision. `applyLogoTextEdit` additionally verifies the document hash against the original immutable revision. Sequentially calling it on an already-modified in-memory document would fail that binding or require a deliberate redesign.

An `arrangement` already represents a single atomic layout edit. There is no existing atomic color-plus-font batch. This plan does not add one. A later batch version must have one separately versioned command envelope, a pure verified-source text-shaping seam, final lock validation of the whole result and one CAS/provenance commit; it cannot be implemented by looping HTTP manual saves.

## Global constraints

- “Manual editing does not itself dispatch an AI request or create an AI charge.” Creating/applying a retained proposal and accepting/restoring a vector dispatch zero AI calls.
- “Font controls apply to actual editable text. Outlined custom lettering must not be presented as editable font text.”
- “A restored version becomes a new current selection; historical records remain intact.”
- “An uncertain provider outcome stays pending reconciliation rather than being assumed failed and retried.”
- “Do not silently replace an unavailable configured provider or model with another paid route.”
- Preserve the original preview, original canonical geometry and all prior revisions. Non-text edits preserve every path ID and `d`; text changes create qualified new glyph geometry only for the explicit editable-text target.
- Saved locks come from the actual owned base and current selection. Model/client lock omissions, unlock requests, or prompt assurances are never authority. Preserve the six existing lock digests and conservative occlusion checks.
- Preserve existing 32,768-byte commands, 8,388,608-byte canonical geometry, 64 components, 20,000 paths and 200,000 commands. New proposal/context limits below are independent; never enlarge general request ceilings.
- No source files owned by the ongoing host integration are edited before that work is integrated. Host registration is the last, lead-owned step.
- No live policy enablement, credentials, permission changes, migrations, paid calls, deployment, commits or pushes are authorized by this planning deliverable. Synthetic local implementation may be assigned under the existing implementation approval.

## Review focus

1. A flattened or multi-paint logo must not become invented semantic components/font text; unsupported operations leave the original intact (Tasks 1, 3, 5).
2. A valid-looking proposal must not unlock, delete, reorder, occlude or indirectly change protected content (Tasks 1, 3, 4).
3. Paid output, known expense or unknown billing must survive cancellation, persistence failure and lost acknowledgement without automatic inference retry (Tasks 2, 4, 6).
4. A proposal generated for an earlier base/account/brief/font must not apply to newer work or expose another owner's data (Tasks 2–5).
5. The new route must not become available from image readiness, Strategy reformulation configuration, stale advertisements or a second host runtime (Tasks 2, 4, 6).

## Source-grounded reuse and non-reuse map

- `src/domain/logo-vector.ts`: canonical documents, component roles/editing kinds, lock structure, bounded manual command union. Reuse the allowed branches, not the whole union as AI authority.
- `src/features/logo-vector/model/edits.ts::applyLogoManualEdit`: pure one-command geometry/paint/layout computation. It deliberately refuses text/font/spacing without the shaping service and does not enforce saved locks itself.
- `model/components.ts::groupLogoComponents`: explicit whole-path rectangle partitioning. It is not semantic detection. AI output cannot call it.
- `model/locks.ts::assertLogoComponentLocks`: canonical geometry, paint, transforms, text, order and effective identity; checks canvas changes and changed overlapping components. Reuse unchanged. Its `getVectorRefinementCapability` refers specifically to raw raster refinement; do not change it to claim all locks are supported globally.
- `server/text-edits.ts::applyLogoTextEdit`: exact owned brief/source/font, correct editing kind, approved spelling, shaping and locks. Reuse via the authenticated producer, without fabricated worker authentication.
- `server/revisions.ts::verifyLogoVectorRevision`, `validateLogoVectorCandidate`, `canonicalLogoDocumentBytes`: actual document/SVG/source verification and independently derived proof.
- `server/mutations.ts::createLogoVectorMutationProducers`: verified reads, text dependencies, staging, locks, acceptance/restoration checks. Extract its candidate preparation into a shared internal helper if necessary; preserve the public manual behavior.
- `src/server/data/logo-transaction.ts::createLogoTransactionService`: exact original-body recovery before producer work, verified role binding, out-of-transaction file work, same-connection COMMIT, uncertain-COMMIT retention.
- `src/server/runtime/logo-services.ts`: existing authenticated font resolver, vector producer and owner storage composition. This is the correct candidate-materialization boundary.
- `creation-controller.ts`, `cost-confirmation.tsx`, `account-logo-client.ts`: quote→explicit confirm→durable request and owner/session fencing. Extend these contracts; never dispatch on typing, mount, polling or retrying a read.
- `src/server/ai/openai-transport.ts`: fixed Responses origin, bounded body, no redirect/retry. Can be reused as an injected transport. `strategy-response.ts` supplies useful accounting/last-dispatch-check patterns, but its Strategy schemas/configuration are not a logo adapter.
- `worker/logo-job-store.ts`, `worker/runner.ts`, `worker/logo-readiness.ts`: durable plans, leases, cancellation, reconciliation and explicit manifest. They need operation-specific extensions, not a parallel ad hoc runner.
- `worker/handlers/logo-refinements.ts:19–24`, `worker/logo-image-runtime-adapter.ts::snapshot`, generative storage and SQL quote routing all currently reject vector-source refinement. Removing only the handler guard would not implement it safely.
- `server/publication.ts::publishLogoVectorResult` and SQL `stage_logo_vector_publication`/`logo_commit_vector_publication` currently require `identity.logo_vectorize` and VTracer evidence. Do not pass a deterministic text edit off as a trace result.

### Prior P3 facade and the distinct redraw gap

`docs/superpowers/plans/2026-10-06-03-vector-editor.md`, Task 5 specifies `worker/logo-vector/refinement.ts::produceLogoRefinementCandidate` (file absent). Package 2, Task 6 specifies `generate-refinement` followed by zero-provider-cost `convert-refinement`: retain the paid raster, load the immutable original vector, check its hash/locks, trace the returned raster and publish a review-required candidate.

This flow is deliberately unavailable with any locks. A raster producer cannot prove that a component stayed unchanged, and tracing the result cannot restore that proof. Completing it also needs admission/source/read/storage/publication integration: the present SQL has a `convert-refinement` output branch but its vector publication helpers still allow only `identity.logo_vectorize`. That branch alone is not implementation evidence.

For future redraws, finish that already-planned unlocked flow with an explicit separately priced image action, or qualify a component-preserving generation adapter. Keep it separate from “AI-assisted controls.” Do not automatically rasterize/trace after an unsupported edit or failed text response. For locked artwork, a future component-return provider still must pass actual digest/occlusion validation; a promise in its prompt is insufficient.

## Target contracts and flow

### New independent identities

- Job operation: `identity.logo_vector_propose`.
- Quote request discriminator: `propose_vector_edit`.
- Handler version: `logo-vector-propose-v1`.
- API adapter/policy version: `logo-vector-propose-api-v1`.
- One durable step: `propose-vector-edit`; one inference maximum per admitted job. A step manifest/policy identity binds the handler/schema revision and cost bounds.
- Paid mode is OpenAI API, with an independently frozen `textPolicy`. Do not reuse the directions `policy`/`chatgpt_subscription` fields or classify this as an image operation.
- Proposed model is the selected API text route's `gpt-6.1-sol`, only through a new explicit configuration and qualified policy for this operation. No inheritance from `FLUID_TEXT_MODEL_REFORMULATE` or an image key/approval flag that automatically enables execution.
- Leave the current `worker/api-text-runtime.ts`, Strategy queue descriptors/handlers and directions provider unchanged. Execute through the logo runtime only after its final integration owner accepts the new explicit adapter. Reusing the Responses transport is not widening the current reformulation dispatcher's permissions.

### Domain module

Create `src/domain/logo-vector-proposals.ts` (shared-contract owner). Define:

- `LogoVectorProposalRequest`: `{operation:"propose_vector_edit", expected:LogoExpectedHeads, baseVectorRevisionId, instruction, targetComponentIds}`. Instruction 1–4,000 characters; targets 1–64 unique existing IDs. No client document/hash/locks/font rights/provider/model.
- `LogoVectorProposalContext`: version 1, exact owner/project/base ID/document hash/saved locks/input revisions/approved spelling; up to 64 explicit component summaries; up to 100 owned, permitted font summaries; target IDs; allowed operations. Component summaries contain existing role/editingKind/transform, painted bounds, uniform paint eligibility/current paint and actual text-source controls when applicable. **No paths, original image bytes, font bytes, storage paths or credentials are sent to AI.** Maximum context JSONB bytes: 65,536. If too large, fail closed before quote; never truncate or invent omitted components/fonts.
- `LogoVectorProposalTextPolicy`: exact model, handler/adapter/schema identities, price-card version, input/output token bounds, bytes/deadline, zero tools, and independently derived maximum cost. Local fixtures may use the current non-research Strategy card (32,768 input, 4,096 output, maximum 122,880 micro-USD); this is a proposed upper bound, not approval or proof of future live pricing. Requalify rates/model access at activation.
- `LogoVectorProposalPayload`: strict union `{version:1,status:"proposed",edit:<one of six allowed LogoManualEdit branches>,explanation}` or `{version:1,status:"unsupported",code,explanation}`. Explanation at most 1,000 characters; entire output at most 32,768 JSONB bytes. Reject extra keys, arrays of edits, no-op commands and unsupported transformations. Runtime validation remains mandatory even with JSON-schema structured output.
- `LogoVectorProposalRecord`: immutable owner/project/job/request/quote IDs, base/context hash, input revisions, payload, exact provider response receipt, text usage/rate-card/accounting evidence and created timestamp. A successful unsupported answer is recorded honestly; it creates no vector candidate. Incomplete/unknown records remain non-applicable evidence.
- `ApplyLogoVectorProposalInput`: `{requestKey, expected, baseVectorRevisionId, proposalId}`. It contains no editable command or proof. Add `applyLogoVectorProposal` to the trusted mutation union and recover its exact original body.
- `LogoVectorProposalPage`: owner-scoped, bounded keyset discovery, default 20/max 50, with details read separately. This is necessary after a full reload loses in-memory request keys.

Wire new exports into `logo-jobs.ts` quote/operation/receipt schemas, `providers.ts` general operation recognition, `logo-workspace.ts` mutation union, and `logo-capabilities.ts` ephemeral availability. Recognition must not enable generic model routing. Keep old schemas/history readable; retain `LogoVectorRevision.source` as the original raster lineage.

### End-to-end sequence

1. User selects current saved component(s), writes a request and asks for a quote. A request-scoped authenticated service verifies the canonical vector and source, resolves rights-qualified owned font metadata and builds the context. Font bytes remain local; the existing font resolver qualifies available choices and application rechecks the exact rights/bytes later. Client summaries are never accepted.
2. A **trusted owner-bound web helper**, `fluid_private.quote_logo_vector_proposal`, stores the prepared context into the immutable quote sources after rechecking full heads, current base/hash/locks and exact source/font record bindings in its transaction. It computes input/policy hashes and checks enabled exact readiness/budget; it never performs inference. This helper is not directly executable by `authenticated`; it uses the existing reviewed trusted-connection pattern. No browser-provided attestation replaces its producer.
3. Cost UI names this text operation and exact base/targets. The explicit confirmation admits a single job via the existing request-key machinery. SQL independently verifies the context, quote expiry, current heads, user cap, shared budget, enabled operation and fresh readiness.
4. The logo worker reads only the frozen context and exact text policy under its lease. It counts bounded input tokens, repeats readiness/host-stop/cancellation checks at the final dispatch boundary, and makes at most one request with no tools and no fallback. It retains provider evidence before publishing a proposal result.
5. The user sees the command/explanation and applicability state. They may click “Create candidate.” This authenticated call loads the immutable completed proposal; rechecks its base, current heads/locks and live font rights; computes one candidate using existing manual/text functions; validates locks/geometry; stages document and SVG outside the DB transaction.
6. The trusted mutation commits the exact proposal→base→candidate link and a new immutable vector/refinements-stage revision atomically with both file receipts. Candidate `parentRevisionId` is the exact base; `source`, `sourcePreview`, saved locks and input basis are retained. `reviewStatus` remains `review_required`; the original approved logo does not change.
7. Existing comparison/readback, explicit acceptance, restore and downstream-stale logic apply. Present saved-vector-before vs candidate for AI edits, as well as the retained original raster, so the requested change is visible. Neither creating nor accepting the candidate calls AI again.

## File ownership and implementation tasks

Use three disjoint ownership areas: shared contracts/SQL (C), vector producer/UI (V), text adapter/worker (W). The integration lead (L) alone merges cross-cutting runtime changes after the current host integration. Assign actual people/workers when implementation starts; no worker commits or pushes independently. Each task uses red→minimal implementation→green→review; commands below are future verification, not tests run by this investigation.

### Task 1 — Define and validate the bounded proposal (C + V)

**Create (C):** `src/domain/logo-vector-proposals.ts`; `tests/domain/logo-vector-proposals.test.ts`.

**Modify (C):** `src/domain/logo-jobs.ts`, `src/domain/logo-workspace.ts`, `src/domain/logo-capabilities.ts`, `src/domain/providers.ts` only for the specific new discriminants/contracts.

**Create (V):** `src/features/logo-vector/model/proposal.ts`; `src/features/logo-vector/server/proposal-context.ts`; `tests/features/logo-vector/proposal.test.ts`; `tests/features/logo-vector/proposal-context.test.ts`.

**Interfaces:**

- `buildLogoVectorProposalContext(input: {revision:LogoVectorRevision; document:LogoVectorDocument; brief:LogoBriefRevision; fonts:readonly FontRecord[]; targetComponentIds:readonly string[]}):LogoVectorProposalContext`; caller must first perform verified owned reads; this function verifies bindings and summarizes only actual data.
- `validateLogoVectorProposal(payload:unknown, context:LogoVectorProposalContext):LogoVectorProposalPayload`; enforces one allowlisted command and targets/structure/paint/font/spacing limits, never evaluates code or accepts model geometry.

**Implementation clarification, 2026-10-08:** A validated `proposed` payload is provisional edit intent, never safe/applicable artwork or a materialized candidate. Font/spacing on an unlocked target may be proposed while unrelated components are locked. Metadata cannot prove the new glyph extents; Task 3 must recheck exact owned base/current heads, current saved locks, actual font rights/bytes and shaping, resulting geometry/occlusion, and non-target preservation through the existing validators. A declaration of these checks in Task 1 does not implement or enforce Task 3. This first source increment remains disconnected from operation admission, runtime routing and persistence.

- [ ] Write negative tests for extra geometry/URL fields, two edits, unlock/group/replacement/text commands, foreign or missing IDs, renamed/missing components, new font IDs, outlined/fused lettering, nonuniform paint, absent-channel creation/removal, line-height changes, locked direct targets, unsupported joining-script spacing, oversized context/output and no-op proposals.
- [ ] Write positive tests for each of six commands and single-command multi-component arrangement. Assert every permitted document summary is grounded in the exact source and contains no path/font bytes or private paths. A whole-artwork mascot supports size/rotation but cannot acquire an inferred “face” component.
- [ ] Run `npm test -- tests/domain/logo-vector-proposals.test.ts tests/features/logo-vector/proposal.test.ts tests/features/logo-vector/proposal-context.test.ts --maxWorkers=1` and observe the intended missing behavior.
- [ ] Implement strict bounded contracts and pure validation. For ambiguous/multi-control requests, the output schema requires an honest unsupported result; the UI also states the one-command limit before purchase.
- [ ] Repeat the focused command. Review all command branches against `logoManualEditSchema`; do not copy an unrestricted union into the provider schema.

### Task 2 — Add disabled admission, durable evidence and owned recovery (C)

**Create:** `src/server/data/logo-vector-proposals.ts`; `supabase/candidates/logo-vector-proposals.sql`; `tests/database/logo-vector-proposals.test.ts`; `tests/database/logo-vector-proposals-security.test.ts`; `tests/server/logo-vector-proposals.test.ts`.

**Create migration only after integration baseline is frozen:** `supabase/migrations/20261008100000_logo_vector_proposals.sql` if that identifier is still unused; otherwise the lead assigns a new unique forward timestamp. Never edit installed/historical migrations. Candidate and final migration must be byte-identical and independently reviewed.

**Modify:** `src/server/data/logo-jobs.ts`/`logo-workspace.ts` for exact result and owned proposal reads; `src/app/api/projects/[projectId]/logo/quotes/route.ts` to route only the new discriminator to verified services. Existing quote routes retain their old path.

**Create routes:** `src/app/api/projects/[projectId]/logo/vector-proposals/route.ts` (bounded GET list); `src/app/api/projects/[projectId]/logo/vector-proposals/[proposalId]/route.ts` (owned GET detail). No provider work in these routes.

**Persistence:** Add private prepared-proposal/result evidence and owner-scoped immutable proposal records, plus an immutable proposal→candidate association (candidate vector ID unique; one materialization per proposal). Store frozen context in the existing quote's source inputs, not as client state. No enablement seed, login or broad ACL grant.

**Explicit SQL delta inventory:** extend `logo_runtime_policies` operation constraint, `logo_subscription_job_scope` API-only branch for the new operation, and new exact text-policy constraint; `logo_policy_descriptor`, `logo_job_policy_matches`, `logo_operation_ready`, `report_logo_worker_ready` (six operations instead of five); `admit_logo_operation`, `claim_logo_job`, `logo_lock_job`, `read_leased_logo_record`, `record_logo_provider_response`, `complete_logo_job_step`, `finish_logo_job`, `expire_logo_job_leases`, request observation/read/reconciliation and `read_logo_capabilities`. Implement new private trusted quote helper and owned list/detail readers. Add the new operation to exclusions in generic `lock_leased_job`, generic/API `claim_job`, generic `expire_job_leases`, subscription claim/read-step functions and every equivalent control-plane isolation list in the integrated source. Inventory lists individually: inclusion in job control must not add this operation to storage permissions. Preserve all unrelated ACLs, function metadata and successor fixes. Use exact-body/predecessor checks where current candidate-migration conventions require them.

The new operation does not need asset read/publication privileges: `logo_job_can_read_asset`, `logo_asset_job`, asset reservation/publication helpers and storage adapters must explicitly reject it. Do not widen those allowlists when updating job-control lists. A text proposal success is typed durable proposal data, not an image/vector asset. Extend `complete_logo_job_step` with its own evidence branch; do not fake `publicationId`, image hashes or a vector trace engine. Add explicit API text usage evidence to provider observations, bound only to this operation and exact policy.

**Interfaces:** `quoteLogoVectorProposal(auth,projectId,request,signal):Promise<LogoCostQuote>` using verified producer + trusted helper; `readLogoVectorProposal(auth,projectId,id,signal):Promise<LogoVectorProposalRecord>`; `listLogoVectorProposals(auth,projectId,query,signal):Promise<LogoVectorProposalPage>`; leased context/result functions take actual `ClaimedJob`, never fabricated `AuthenticatedContext`.

- [ ] Write tests proving disabled/missing policy or readiness causes zero job admission; Strategy/image readiness does not satisfy this operation; stale quote/heads/base/locks/font/context/source hash, cap overrun and unresolved paid uncertainty reject before dispatch.
- [ ] Cover original-key lost admission, changed-body conflict, owned reload discovery, foreign access, session-user role/OID rebinding, expired/stolen lease, provider receipt substitution and unlisted asset reads. Replaying completion cannot duplicate a proposal or change its immutable contents.
- [ ] Cover completed unsupported result, known paid invalid result, valid retained output with unknown usage, interrupted provider response and missing receipt. Only a fully committed, reconciled, supported proposal is applicable. Known billed failure is not reported as free; unknown outcome retains reservation and forbids inference retry.
- [ ] Run `npm test -- tests/database/logo-vector-proposals.test.ts tests/database/logo-vector-proposals-security.test.ts tests/server/logo-vector-proposals.test.ts --maxWorkers=1` against disposable databases, implement only the required local SQL/DAL, then repeat.
- [ ] Review restricted-principal and generic-claim exclusion tests. No live grant, migration or activation follows from local green tests.

### Task 3 — Materialize one proposal with existing authenticated producers (V + C)

**Create (V):** `src/features/logo-vector/server/proposal-mutations.ts`; `src/features/logo-vector/server/prepare-edit.ts` if extracting shared preparation; `tests/features/logo-vector/proposal-mutations.test.ts`.

**Modify (V):** `server/mutations.ts` only to share verified candidate preparation without changing existing manual semantics; `src/server/runtime/logo-services.ts` after the integration owner releases it, composing proposal quote/application with actual owner/font dependencies.

**Modify (C):** trusted command routing/constraints in Task 2's forward SQL; `src/server/data/logo-workspace.ts`; `src/server/data/logo-transaction.ts` only if needed by the extended union. Add `fluid_private.commit_logo_vector_proposal` as a separate branch reusing factored private vector-commit validation where safe, rather than invoking a fake manual command that loses provenance.

**Create route:** `src/app/api/projects/[projectId]/logo/vector-proposals/[proposalId]/apply/route.ts`.

**Interface:** `createLogoVectorProposalMutationProducer(deps):LogoMutationProducer` handles only `applyLogoVectorProposal`. Dependencies reuse authenticated verified vector, workspace/current base, source/font and asset-store readers plus an owned persisted-proposal reader. The command includes no edit; load the exact immutable command from the proposal.

**Required behavior:**

- Recheck proposal is completed, supported, billing-settled and tied to the exact base/hash/targets/context. Current base, heads and saved lock basis must match. An intervening unlock is a new base: it does not authorize applying an old proposal automatically.
- Run `applyLogoManualEdit` or `applyLogoTextEdit` once. Text shaping uses the genuine existing auth and rights readers; no provider call, no inferred font and no worker access.
- Run `validateLogoVectorCandidate` using retained original source bytes and saved locks. Also assert non-target components/path geometry unchanged for the chosen command. For text changes, only the selected editable-text component may change paths.
- Stage immutable document/SVG using deterministic member keys derived from the apply request. Keep I/O outside database locks.
- Commit proposal association and vector revision in the same owner-bound CAS transaction; exact proposal, evidence, base, locks, input revisions and two owned publication receipts are checked again. Current approval stays intact; candidate enters refinements as review-required.
- One proposal materializes once. An exact original-key replay returns its original receipt before computation. A second key cannot silently create a second candidate from the same paid result; return a conflict plus separately readable existing materialization.
- Reuse exact-body uncertain-COMMIT recovery. Extend cancellation/recovery to this method explicitly, including the cancellation SQL's current `saveLogoEdit`-only checks. Do not claim existing edit cancellation automatically covers a new method.

**Cancellation files (V):** `src/features/logo-vector/model/cancellation.ts`, `client/cancellation.ts`, `server/cancellation.ts`, `client/recovery.ts`; existing cancellation routes/client methods as necessary. Keep legacy input forms readable.

- [ ] Write tests for genuine source-byte/hash verification, all six commands, unchanged original geometry, correct text rights, visible new outlines only for actual editable text, inherited locks and provenance link.
- [ ] Attack locks through order, root mapping, overlap, deletion, target aliases and changed neighboring ink; reject without candidate/selection changes. Exercise newer heads, current-base mismatch, changed font rights, foreign proposal, paid unknown outcome, replay/new-key duplicate, cancel-before/after staging and uncertain COMMIT.
- [ ] Run `npm test -- tests/features/logo-vector/proposal-mutations.test.ts tests/features/logo-vector/mutations.test.ts tests/features/logo-vector/text-mutations.test.ts tests/features/logo-vector/locks.test.ts tests/database/logo-vector-edit-cancellation.test.ts tests/database/logo-vector-edit-cancellation-security.test.ts --maxWorkers=1`; implement; rerun.
- [ ] Review actual DB CAS/cancellation/proposal-link assertions, not just producer spies. Existing acceptance/restore tests must still preserve currently saved locks and earlier-basis acknowledgement.

### Task 4 — Implement the separately configured text producer and durable handler (W)

**Create:** `src/features/logo-vector/server/proposal-provider.ts`; `src/features/logo-vector/server/proposal-policy.ts`; `worker/handlers/logo-vector-proposals.ts`; `worker/logo-vector/proposal-runtime-adapter.ts`; `tests/server/logo-vector-proposal-provider.test.ts`; `tests/worker/logo-vector-proposals.test.ts`; `tests/worker/logo-vector-proposal-runtime-adapter.test.ts`.

**Interfaces:**

- `LogoVectorProposalProvider.propose(context, instruction, policy, signal, dispatch):Promise<{outcome:StepOutcome; observation:LogoVectorProposalProviderObservation}>`.
- `createLogoVectorProposalHandler({loadInput,provider,assertReady,recordResponse,publishProposal}):JobHandler`.
- `createLogoVectorProposalRuntimeAdapter(input|null):{capability,proposals}|null`, explicit injection only, no I/O/config discovery/timers during construction and no storage field.

The prompt lists only actual component IDs/roles, editing kind, allowed controls and existing font IDs. It explains the one-command boundary and forbids partial execution of multi-control requests. Structured output is treated as untrusted. No tools, raw SVG or visual-part inference. The UI checks geometry later; prompt claims never establish a lock guarantee.

Count input tokens before inference, using exact same final request/policy. Repeat runtime/policy/cancellation checks after counting and immediately before the actual network invocation, including injected transports. Reuse the source project's last-dispatch fencing pattern so a host stop during preflight causes zero billable requests. Evidence retention after an already dispatched request must not be blocked merely because the host stopped accepting new work.

Retain the response envelope identity/hash, observed model/tier, token counts, exact price card, actual bill and bounded partial payload. Wrong model/tier, missing usage or uncertain provider acceptance does not become a zero-cost failure. No retries or provider substitution. Known unsupported output is a valid terminal answer with its real charge and no candidate. A lost proposal-publication acknowledgement stays pending reconciliation; it never regenerates the text.

- [ ] Write exact-policy/configuration tests: absent new operation config yields null; generic paid flag, reformulation approval or image adapter does not enable it; missing policy/runtime and multi-control/untrusted output cannot dispatch/apply through a fallback.
- [ ] Exercise final-dispatch stop, cancellation before/after count, provider refusal, malformed/oversized output, known usage on invalid output, unknown usage, wrong model, response-record failure, proposal-publish uncertainty, lost lease and late output. Assert exactly one or zero transport requests as appropriate and zero asset/font/image calls.
- [ ] Run `npm test -- tests/server/logo-vector-proposal-provider.test.ts tests/worker/logo-vector-proposals.test.ts tests/worker/logo-vector-proposal-runtime-adapter.test.ts tests/worker/runner.test.ts --maxWorkers=1`; implement and repeat.
- [ ] Retain the source's independent pricing semantics. If extracting a reusable pure text-usage calculator is necessary, give that file to L and run all existing Strategy accounting tests; do not repurpose Strategy handlers or expand their policy maps.

### Task 5 — Add cost-confirmed UI, proposal recovery and actual comparison (V)

**Create:** `src/features/logo-vector/components/ai-proposal-controls.tsx`; `src/features/logo-vector/client/proposals.ts`; `tests/features/logo-vector/proposal-ui.test.ts`; `tests/client/logo-vector-proposals.test.ts`; `tests/e2e/logo-vector-ai-proposals.spec.ts`; `tests/features/logo-vector/proposals-playwright.config.ts` with a separate fixture server port.

**Modify:** `components/logo-editor-workspace.tsx`; `components/conversion-review.tsx` for an explicit saved-vector-before comparison; `src/components/identity/account-logo-client.ts`; `logo-draft-memory.ts` and its existing persistence/fencing tests for bounded in-memory instruction/pending apply; `src/components/logo-creation/creation-controller.ts`, `cost-confirmation.tsx` for the new discriminator; current capability hook/schema fixtures as needed. Keep manually authored edits/provider-free controls unchanged.

- [ ] Show “AI-assisted controls,” exact current selected component(s), one-change limit, supported operations and locked/unavailable reasons. Outlined lettering exposes its honest manual replacement route; fused artwork gets no invented symbol/wordmark targeting.
- [ ] Require new operation readiness, saved clean current base and no unresolved request/conflict. Typing, slider changes, quote preparation, navigation and reload dispatch zero inference. Display separately priced text estimate/cap and billing uncertainty before the explicit request click.
- [ ] Preserve instruction and request identities through interruption; owner/session-generation fences hide former-account results and abort obsolete reads. Recover generation and apply requests independently. Full reload lists owned proposals, including unapplied/unsupported/uncertain ones, without guessing the newest.
- [ ] Show the exact proposed command/explanation and state. “Create candidate” is available only for an applicable paid proposal; label it as no additional AI request. Never claim a text/font preview is updated before the server returns shaped geometry. Render the resulting candidate against the original saved vector and retain access to the original raster.
- [ ] Retain existing “Accept this vector”/history/restore controls, earlier-input acknowledgement and stale downstream warnings. Applying a proposal never silently approves it or refreshes exports.
- [ ] Test double-clicks, Back/Forward, cost-dialog Escape/cancel, expired quote, account switch, request uncertainty, font invalidation, historical-base inspection, unsupported multi-control wording, current-base conflict and cancelled local application on desktop/mobile/keyboard.
- [ ] Run `npm test -- tests/features/logo-vector/proposal-ui.test.ts tests/client/logo-vector-proposals.test.ts --maxWorkers=1` and `npm run test:e2e -- --config tests/features/logo-vector/proposals-playwright.config.ts --project=desktop --project=mobile`; fixtures are explicitly synthetic with no external network. Capture geometry/lock before-and-after and outlined/unsupported/recovery states.

### Task 6 — Integrate after the current host and qualify locally (L)

**Wait for integration ownership release. Modify only then:** `worker/logo-operation-composition.ts`, `worker/logo-runtime.ts`, `worker/logo-readiness.ts`, `worker/logo-job-store.ts`, `worker/logo-production-host.ts`, `worker/logo-production-startup.ts`, `worker/logo-dedicated-config.ts`, `worker/logo-dedicated-launcher.ts`, and actual final host/entrypoint files if integration renamed them. Re-read their current manifests first. Add the optional explicit text-proposal dependency/configuration without changing directions/image/vector/export descriptors.

**Tests:** extend `tests/worker/logo-operation-composition.test.ts`, `logo-runtime.test.ts`, `logo-readiness.test.ts`, `logo-production-host.test.ts`, `logo-dedicated-config.test.ts`; add `tests/database/logo-vector-proposal-host.test.ts` and `tests/worker/logo-vector-proposal-host.test.ts`.

- [ ] Ensure one combined runtime, one readiness owner, one bounded manifest and no duplicate polling loop/connection discovery. Increase the explicit manifest operation limit only from 5 to 6, in TS and SQL, with exact new-op validation.
- [ ] Keep image `identity.logo_refine` and directions unchanged. Neither `vectorRefinement:null` nor the raw-raster lock guard is removed. New text operation needs an exact new policy/config; absent qualification, capability remains unavailable at quote, admission, handler and final dispatch.
- [ ] Verify text proposals have no generative/production/directions storage adapter capability. Existing manual application remains owner-authenticated. Test old+new operation claim isolation against current generic/API/subscription workers, without broadening the hosted reformulation service.
- [ ] Run all new focused tests, existing vector/manual text/locks/cancellation/history, logo job/security/readiness/capability/host tests, API text runtime/activation tests and directions/image regression tests. Then run `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=1`, `npm run build`, and the specific desktop/mobile E2E fixture configs. Run these serially under current resource constraints; do not overlap the host owner's checks.
- [ ] Record exact source manifest/hashes, commands, actual results and synthetic evidence in `docs/evidence/logo-vector-proposals/`. Independent review checks financial replay, ownership, source→proposal→candidate provenance, locks, schema compatibility, cancellation, generic-worker exclusion and final-dispatch fencing.
- [ ] Publish only the local completion claim supported by those checks. Live provider, live Postgres session/pooler concurrency, hosted storage and actual paid acceptance remain explicitly untested until separately authorized and executed.

## Activation boundary and stopping condition

`docs/superpowers/plans/2026-10-08-api-worker-approval.md` approves setup of the API text worker and **one reformulation** as its first paid acceptance, capped at US$0.122880 within the shared US$5 ceiling. It does not enable `identity.logo_vector_propose`, grant it a budget, or switch `identity.logo_directions` to API billing. This new route remains disabled after local integration.

When local implementation is reviewed, the lead may prepare the exact activation request: operation/model/rate card and cap; number of paid test requests; existing shared budget consumption; destination worker; precise new helper permissions/policy changes; no broad credentials; and whether a hosted acceptance trial is wanted. Do not ask product questions now or imply that the existing setup approval covered this new paid use. Do not run a “small test call” under the reformulation allowance.

Planning is complete when this file is delivered. Local implementation is complete only when all assigned local checks pass and the new path stays unavailable without its explicit policy. Product reporting must say “bounded AI-assisted vector controls” and enumerate unsupported redraw/multi-command/outlined-text cases; it must not say arbitrary vector-source AI refinement or the original P3 candidate facade is complete.

## Self-review

- Approved functional controls are reused; this bounded proposal layer adds no anchor/path editor or arbitrary geometry generator.
- Multi-control atomicity is explicit: one command per proposal, one candidate per application; arrangement is the sole existing multi-component command.
- AI generation, deterministic application and logo approval are three distinct durable identities/actions, with retained provenance and independent uncertainty handling.
- All five review-focus items have named negative tests. Unknown billing/output never enables candidate creation or a paid retry.
- Historical vector/raster schemas remain intact. New records link the text operation and materialization rather than fabricating a new raster source or VTracer result.
- The present worker/image/storage/SQL gap and the prior unimplemented P3 facade are documented rather than hidden behind a UI label.
- No new library, host, credentials, paid permission or directions-provider switch is required merely to implement and test this plan locally.
