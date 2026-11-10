> Archived November 10, 2026: describes the system before the generation engine.

# Bounded vector proposal core

Historical component/integration documentation. See the [current checkpoint verification status](verification-status.md); machine-specific execution evidence is intentionally retained outside this source snapshot.

This source increment defines and validates one provisional whole-component edit against exact saved vector metadata. It is intentionally disconnected. It does not add operation admission, an AI/provider adapter, durable proposal records, SQL, API routes, candidate persistence, UI, a storage capability or runtime configuration. Legacy raster refinement is unchanged.

## Authority and input preparation

The server context builder accepts a revision, canonical document, exact brief, owned font records and actual target component IDs. Its caller must already have authenticated and verified immutable owned reads, including the canonical JSON/SVG and original raster/source lineage. The builder independently binds the canonical document hash, derived SVG/proof, current saved lock digests, one exact brief input revision, font asset hashes and rights evidence. It does not authenticate a supplied object or read storage.

The context preserves component identity/order, role and actual editing kind, transforms, painted bounds, paint eligibility, saved text/source controls and permitted font metadata. It never infers semantic components from a logo-type label. A whole-artwork mascot remains whole artwork; outlined custom lettering remains outlined. Brand spelling is preserved exactly. Initials are the already-saved source text, never inferred from the full name.

The entire detached context is frozen and capped at 65,536 JSONB bytes. It includes no paths, SVG, raster/font bytes, storage paths, credential material or rights-source URLs. An oversized source/context fails closed rather than truncating the component or font catalog.

## One command

Only existing size, rotation, color, arrangement, font and spacing command branches are admitted. A single arrangement can place/order several selected existing components atomically. Every other branch, extra field and multi-command batch is rejected. An explicit unsupported/no-change response is a first-class result; no candidate follows from it.

Recoloring requires uniform channel presence and colors across the target. Existing null channels, path opacity and stroke attributes stay unchanged. Text shaping additionally requires uniform complete paint, actual editable lettering and an exact permitted current font binding. Font selection is confined to the frozen rights-qualified catalog. Line-height changes and joining-script letter spacing remain unavailable.

## Provisional intent, not candidate safety

A validated `proposed` result is neither a materialized vector nor a declaration that a candidate is safe/applicable. Direct locked targets and known structural/order conflicts are rejected. Bounding-box overlap uses the existing lock policy’s conservative rejection semantics; it is not proof that exact painted shapes collide. Font/spacing on unlocked text with unrelated locks remains provisional because metadata cannot establish new glyph extents.

The later authenticated materializer must recheck:

1. Exact owned immutable base and current heads
2. Current saved lock set
3. Exact font rights, bytes and real shaping when required
4. Resulting canonical geometry, viewBox and lock/occlusion checks
5. Preservation of every non-target component and non-target geometry

A schema cannot prove whether a single returned command fully answers the natural-language instruction. Combined-request fidelity remains a later provider/UI contract and test obligation; this core does not use a heuristic language parser.

The exported checklist documents this boundary. It does not enforce a future producer by itself. No candidate-producing API exists in this increment. Existing manual application, source-byte verification and exact lock validators remain the required implementation path for that later task.

## Verification boundary

New tests use synthetic metadata and canonical geometry, with no provider, font download, database, storage, credential or deployed service calls. Evidence is recorded under `docs/evidence/logo-vector-proposal-core/`. Focused source verification is not live acceptance and is not full AI vector refinement completion.
