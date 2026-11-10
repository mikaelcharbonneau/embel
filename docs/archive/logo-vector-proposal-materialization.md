> Archived November 10, 2026: describes the system before the generation engine.

# Disabled zero-AI proposal application

Historical component/integration documentation. See the [current checkpoint verification status](verification-status.md); machine-specific execution evidence is intentionally retained outside this source snapshot.

Task 3 local source increment, based on the frozen Task 2 completion candidate. Nothing here applies SQL, enables a provider, provisions a credential or grants production access. Task 5 frontend controls and Task 6 worker integration remain separate work.

## Three distinct actions

1. Paid, explicitly consented text generation retains an immutable provisional command or unsupported result.
2. Explicit authenticated apply creates one review-required candidate using the saved six-control command. This step has no AI/provider dependency or charge.
3. Existing vector acceptance separately approves a candidate. Applying never replaces approval or refreshes exports.

The historical proposal record and its `materialization: unavailable` field remain immutable. A separate read projection returns current eligibility and the immutable association, if any. An old `succeeded` record alone is insufficient: it can predate job settlement or survive cancellation.

## Interfaces

- Feature-local `applyLogoVectorProposal` command body: `requestKey`, `expected`, `baseVectorRevisionId`, `proposalId`. No supplied edit or producer evidence.
- `GET /api/projects/{projectId}/logo/vector-proposals/{proposalId}/apply`: owned current application projection. It performs no application or replay.
- `POST` at the same path: request-scoped authenticated producer and existing trusted transaction service.
- Existing `/logo/edits/requests/{requestKey}` read and `/cancel` routes now also understand the distinct apply command, preserving all historical manual forms.
- `createLogoVectorProposalApplicationClient` holds a separate immutable per-account/session apply intent. `recover(false)` is read-only. Only explicit `recover(true)` retries the original body when no committed or cancelled proof exists. The client returns the historical receipt with separately read current heads, so replay does not visually replace newer work. It is not wired into redesigned UI here.

`createLogoServices(null)` stays unavailable. The optional existing server composition supplies the exact owned storage, restricted connections, vector readers, brief/source readers and font resolver. No environment discovery, credentials or fallback provider is added.

## Source and artwork checks

The producer first reads the owned authoritative application projection, then verifies the canonical saved document, SVG and original raster bytes against exact immutable hashes. It rebuilds and compares the complete frozen context from current base, brief, locks and fonts. Each advertised permitted font is re-resolved from actual authenticated bytes and rights; changed/withdrawn rights cannot be inferred from a font name. Existing HarfBuzz shaping is used only for genuine editable text. Preserved approved brand spelling includes exact Unicode bytes. Outlined custom lettering is not silently converted.

One existing manual/text edit is computed. Independent preservation checks forbid root changes, inserted/deleted/renamed components, unrelated geometry/paint/text, and no-change results. Actual locked component geometry/appearance/placement/overlap checks run after shaping. Both document and portable outlined SVG use deterministic request-member keys and are staged outside the database transaction.

Manual producers only share the minimal candidate validation/staging helper. They keep their original supported commands, source checks, acceptance and restore logic. No fabricated manual-save or trace receipt is created for proposal provenance.

## Transaction and billing

Original-body receipt recovery runs before producer I/O. A second request key for the same proposal conflicts before source/font work, with the original association available through the read projection. Successful association, vector revision, refinements stage and request receipt commit atomically under owner/project/CAS locks.

The candidate SQL independently checks exact original job, step, dispatch, prepared result, provider observation, quote, input and policy identity. Only authoritative successful job/step settlement and matching settled reservation/captured/accounting data qualify. Unknown, partial, over-limit, reconciliation-only or cancelled/late outcomes do not. It makes no financial writes and does not require a still-enabled paid policy to apply an already settled result.

The final commit repeats current source, brief, expected heads, inherited locks, font records and two exact staged publication bindings. Immutable cancellation tombstones serialize with commit. Lost COMMIT acknowledgement remains uncertain and is recovered using the exact original command, without redoing geometry or staging after committed success.

## Verification boundary

See the evidence directory and final manifest for actual commands and results. Tests are local synthetic owner/provider metadata; source and font tests use real pinned font/shaping bytes. PGlite cannot establish real Postgres session pooling, concurrent lock scheduling, hosted RLS/storage or live paid quality. No provider, hosted SQL, credentials, deployment or public publication is included.
