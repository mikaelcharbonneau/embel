# Disabled vector proposal durability checkpoint

Historical component/integration documentation. See the [current checkpoint verification status](verification-status.md); machine-specific execution evidence is intentionally retained outside this source snapshot.

2026-10-08. This is preserved work in progress for Task 2 of the approved bounded-vector implementation plan. It is not a completed Task 2, deployable migration, live policy, or AI-refinement feature. The verified application baseline remains unchanged outside this isolated copy.

## Present source

- General job/activity recognition, strict quote and durable receipt recognition for `identity.logo_vector_propose` / `propose_vector_edit`.
- A separately versioned text policy and provisional record/usage contracts. The proposed local price card is fixed at the existing 2026-10-03 synthetic qualification card, with a maximum derived from the highest permitted input-token rate. Importing it enables no provider or budget. Future activation must requalify current prices and access.
- Strict known-charge accounting in retained records, including uncertain outcomes. Missing usage and wrong model/tier can be retained as unknown billing, never relabeled zero cost. A succeeded record must have complete response identity, supported/unsupported payload, exact known charge, and usage within the frozen limits.
- Owner-fenced DAL and bounded GET list/detail routes. Detail reads also run the frozen provisional payload validator. Every record explicitly reports `materialization: unavailable`.
- The new quote HTTP branch validates the request and then reports unavailable before any RPC. There is no verified quote producer composed here, and the existing image/Strategy quote path cannot be substituted.
- An unapplied SQL candidate with a FORCE-RLS private immutable evidence table and authenticated, owner-filtered readers. The table has no application insertion path or grants. Test rows are explicitly administratively seeded metadata, not accepted paid proposals.
- Exact predecessor-checked exclusion of the new identity from generic/API/subscription claim, lock and expiry paths, plus explicit denial in the legacy asset-membership helper. Existing function OIDs, owners, execution metadata and ACLs are preserved. The candidate is one transaction and refuses changed successor bodies.

## Deliberate integration boundary

The existing `logoOperationSchema` remains the five-operation host inventory. The broader general job schema and dispatch-receipt schema recognize the disabled new identity independently. Adding it to the active enumeration now would implicitly alter existing host/controller loops before their Task 6 owner can integrate the real handler. Existing five-operation capability responses are returned unchanged. An optional sixth entry can say only unavailable; a stale available advertisement is rejected.

The frozen Task 1 core is copied byte-for-byte as a dependency and is excluded from this task's delta. Its accepted payload is provisional metadata intent only. It does not prove actual font shaping, source ownership, geometry, occlusion, lock preservation, or candidate applicability.

## Required continuation before Task 2 can be complete

1. Implement the actual owner-authenticated verified vector/source/font quote producer and narrow owner-bound SQL quote helper. Recheck complete heads, current base/document/proof/locks, immutable source and font records, and derive context/policy hashes. The core's font record hash uses its own canonical serialization; do not compare that blindly to PostgreSQL JSONB text hashing. Freeze full exact font records privately alongside the AI-safe summary or define an explicitly qualified shared canonical contract.
2. Add an independently constrained `text_policy` to the SQL runtime policy and API-only job scope. Missing policy, Strategy/image configuration and stale readiness must not satisfy the new operation. Preserve the current shared paid-uncertainty pause.
3. Extend the exact current logo readiness/admission/claim/lease functions, one planned step and one provider attempt only, plus explicit budget/cap/quote/head checks and original-key durable rejection/replay semantics. Preserve all installed historical migrations.
4. Add private prepared evidence and a dedicated leased observation/completion branch. Persist exact provider receipt, observed identity/model/tier, usage, rate card, known bill, bounded partial/invalid output and uncertainty. No publication/asset ID may stand in for text evidence. Unknown acceptance/usage must retain its reservation and never trigger inference replay.
5. Bind the immutable proposal record to the completed owned job/quote/context/provider result in SQL and revalidate its actual strict payload. The current table is only a protected storage skeleton. It does not yet prove paid-result provenance or atomic completion.
6. Implement the exact owner-scoped proposal/candidate association together with Task 3's authenticated producer and trusted transaction. Keep this unavailable until real source bytes, current heads/locks/fonts, resulting geometry and non-target preservation are rechecked. Do not invoke a fake manual save or trace publication to invent provenance.
7. Extend read/reconciliation only as actually needed; current generic finish and request observation semantics were inspected but not changed. Perform actual restricted-login, OID-rebinding, stale/stolen lease, original-key replay, unknown billing/cancellation, paid invalid output and provider substitution tests on the completed wiring.
8. Independently review the final candidate before skill-guided forward migration creation. No migration file has been created for this checkpoint. No hosted migration, login, grant, policy enablement, credential, provider/network inference, deployment, commit or push is authorized by this packet.

## Verification scope

See the evidence directory for actual commands and results. The initial discriminant test failed on all three intended behaviors before implementation, then passed. Later test-first regressions exposed over-cap success, erased known charge in uncertain records, and stale sixth-capability acceptance; each was corrected. The first SQL RED invocation was blocked by review over npm network concerns. After authorization evidence and verification of local dependencies, its exact retry ran after the protected SQL skeleton had been written and passed. That is explicitly not a SQL RED-before-implementation claim. Subsequent commands set npm offline mode and disable its update notifier.

These tests establish local contract/read/ACL/isolation behavior only. They do not establish complete paid admission, durable provider completion, hosted PostgreSQL concurrency/pooling, real Storage, provider billing, actual rendering/shaping, UI acceptance or live artwork quality. No full project suite or production build is claimed for this partial packet.
