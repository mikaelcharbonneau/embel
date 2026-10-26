# Naming quote binding — 2026-10-26

## Confirmed failure and scope

One authorized real 100-name test on release `a54cf24102687ce6d00f659001e8bee6f9963368` ended at 90 unique persisted names after 12m28s. The provider accepted Luna/xhigh and the uncapped native Agents flow. Research performed native searches and reference reads. A completed Verifier response for People & Places contained four findings with inaccurate source quote offsets; strict validation correctly rejected them. All issued calls drained. The 90 names, original response, failed job and unknown actual cost remain retained.

The first repeated quote had 36 UTF-16 units but declared start265/end300 (35 units); its sole literal occurrence began at266. Two further quotes also had incorrect starts. This fix addresses that mechanical binding defect. It does not claim that real generation now fulfills 100 names or that the factual interpretation, research breadth or creative quality is adequate.

No paid call, live SQL, deployment, merge, permission or credential change is part of this source task. The original `/Users/mikael/embel` checkout remains untouched.

## Exact source binding

Provider wire JSON schema, prompts, request hashes, model, reasoning and research tools remain byte-compatible. A separate worker intake retains all verifier fields, integer/range/order limits, findings and claim/source requirements, but defers the arithmetic relation between quote length and declared positions until source binding. It does not trim or normalize raw provider values.

For each quote, the worker resolves only the owned immutable dependency closure or the current call's actually retained reference. The existing source hash, receipt, provenance and source-collision checks remain authoritative.

An already exact declared span is preserved, including an explicitly located repeated passage. An inaccurate span can be replaced only by the quote's sole literal occurrence in that exact source. Missing, repeated or overlapping candidate matches fail closed. No whitespace, punctuation, case, accent or Unicode normalization, fuzzy matching, source substitution, dropped finding or invented quote is allowed. Every other finding field remains exact. The final artifact still passes the original strict quote/verification schemas.

Positions use JavaScript UTF-16 code units. Supplementary characters occupy two units; combining marks, CRLF and ZWJ sequences remain literal. See the [ECMAScript String definition](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-ecmascript-language-types-string-type). PostgreSQL string positions count characters, so the SQL proof explicitly maps codepoints to UTF-16 units; see [PostgreSQL string functions](https://www.postgresql.org/docs/current/functions-string.html). Unpaired surrogates cannot qualify for a corrected binding.

Only a corrected artifact carries `quoteBinding: { version: 1, itemId, itemContentHash }`. This identifies the exact retained raw final item and SHA-256 of its original text. Raw provider records and receipts are never rewritten or copied into a synthetic provider response. Existing valid artifacts remain unchanged, with no new metadata.

## Database completion proof

The guarded forward migration is `supabase/migrations/20261026033000_naming_quote_bindings.sql`.

It adds one private immutable helper and changes only the final-output comparison in `fluid_private.naming_brain_call_completed(fluid_private.naming_brain_calls)`. The predecessor must have exact `prosrc` MD5 `fcdbf12f1495f52b75bbbc7b4b99f4cd`, the expected owner and execution metadata, and exactly one comparison fragment. Unexpected state aborts the transaction.

Absent binding metadata preserves the original raw JSON equality path. Present metadata must bind the actual final item ID and exact raw-text hash. SQL parses that retained raw output, independently computes the same per-quote source projection, and compares the entire projected JSON to the artifact. This proves that only source positions changed. Missing, malformed, forged or unnecessary metadata fails closed. Provider session/turn/request identity, actual completed terminal Turn, source closure, actual source observations, ownership, leases, cancellation and immutable-history gates remain in place.

Existing function owner, OID, ACL, security mode and configuration are preserved. The new helper has no PUBLIC/anon/authenticated/service-role EXECUTE grant. No historical row, receipt, hold, balance, cost settlement, credential or access grant is changed. The helper is invoked through the existing trusted database execution path.

## Validation and remaining limits

Focused tests cover a sanitized four-finding reproduction, exact historical spans, per-quote mixed valid/repeated and corrected spans, astral/combining/CRLF/ZWJ text, absent and overlapping matches, normalization differences, raw item/hash/receipt forgery, source hashes and closure. Mocked installed-SDK recovery rebuilds the binding using GET requests only and preserves the exact original provider item.

Disposable SQL tests independently verify Unicode offsets, whole-output equality, strict source/item/hash binding, restricted worker completion, malformed records, metadata/ACL preservation, history hashes, predecessor rejection and unchanged legacy completion. Existing progressive SDK/SQL tests continue to exercise complete synthetic 100-name publication and recovery.

These checks do not authorize or substitute for another real generation. A model may still return an absent/ambiguous quote, unsupported factual claim, invalid other field or insufficient approach coverage; those outcomes remain failures. Semantic interpretation is still the verifier's responsibility under strict claim evidence.

## Coordinated forward release plan — not executed

1. Review the final PR head and obtain separate production release approval. Rebase/integrate other approved main changes, then validate the exact clean release SHA. Build web and the project-pinned isolated Naming worker from that same SHA; the worker allowlist includes only the added Naming quote-binding module.
2. Inventory live migration history and read back the actual predecessor function body, owner, ACL and configuration. Rehearse the exact migration against those definitions in disposable SQL. If ledger/body differ, stop and reconcile; do not bypass guards or reapply a renamed ledger entry.
3. Inventory active, queued, leased and unknown Naming work. Drain/freeze the existing scoped admission/readiness publisher using the established release procedure. Preserve Stop/read/cancel/recovery and all saved results; an unconfirmed provider outcome is not a settled cancellation. This is execution cutover, not a monetary cap.
4. Apply only the reviewed guarded quote-binding migration, then read back the helper and exact patched comparison, function metadata and existing historical-data digests. Do not install inactive Responses candidate SQL or any unrelated migration. The SQL must precede a worker that can publish corrected artifacts; old exact artifacts still work with the additive helper.
5. Qualify the exact new worker image with the existing preflight/standby modes, which perform no provider call or job mutation. Verify its digest, runtime fingerprint, restricted identity and source SHA. Stop the former publisher and verify actual zero instances before activating exactly one replacement. Never overlap old/new publishers.
6. Release the matching web build and verify canonical aliases. Enable the existing scoped readiness only after the new worker's actual heartbeat is verified. Query authenticated availability and saved feed/provenance through ordinary reads. Do not press Generate/Resume as a readiness probe.
7. Report exact migration ledger receipt, web/worker deployment IDs, source SHA, bundle/image digests and heartbeat. A further real 100-name acceptance requires its own authorization. Do not automatically retry or alter the failed 90-name test.

## Rollback / fail closed

If migration guards reject, the transaction aborts and existing code/history stay unchanged. If qualification or activation fails, leave new admission unavailable through the existing scoped readiness mechanism, preserve all saved reads and evidence, and keep one or zero verified publishers.

After corrected artifacts exist, retain the additive SQL proof: removing it would make those historical completed calls appear unproven. Do not delete artifacts or rewrite their provider output to make an older worker accept them. Drain/pause before any code rollback, inventory jobs that require the new binding, and keep a compatible reader/recovery worker for them. Reverting the original `spend_control` defect or adding spending limits is not a rollback procedure.
