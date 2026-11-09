> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Naming factual generation contract — 2026-10-27

> Historical: retired by the November 2026 Naming generation rebuild (docs/naming-generation-contract.md).

This source-only correction addresses two concrete contract gaps behind the
reported 85/100-name acceptance failure. The report included factual Director
directions without source keys and 110/200 proposals without required primary
claims. Those counts are supplied production evidence; no live generation or
production database inspection was repeated for this change.

The subsequent [contract 5 evidence-planning change](naming-evidence-planning-20261027.md)
supersedes the future-request selector described below and implements the
explicit supported/unavailable partition. Contract 4 rendering remains exact.

## Reproduced gap and future requests

The synthetic regression reproduces contract 3 accepting a factual Creator set
with `claims: []`. Its retained output then correctly loses every candidate to
`unsupported_primary_claim`. The old output and request hashes stay exact.

New uncapped progressive requests select `progressiveContractVersion: 4`.
For `other_languages`, `classical_roots`, `people_places` and `stories_culture`,
the provider output schema now requires at least one claim per candidate, with
`requirement: primary_approach` and a nonempty list of the assignment's retrieved
source keys. All claims in that factual assignment are required route claims;
the instructions explicitly omit unrelated optional factual asides rather than
relabeling them. A claim remains unverified. Only independent verification can
establish its source support and primary credit.

The schema uses ordinary array bounds, literal values and enums, without tuple
or array-contains features. It permits a smaller result, including an empty
candidate list. It never manufactures candidates, claims, sources or coverage.
Claim-free creative routes retain their existing behavior. Rendering a factual
Creator request with no retrieved assignment source fails before dispatch.

Contract 4 Director instructions require explicit retrieved keys for supported
factual directions and honest empty keys for conditional unsupported directions.
Application assignment selection skips factual templates whose keys are empty,
missing or unretrieved, so an unsupported direction cannot hide a usable sourced
sibling. The retained Director artifact is never edited or rebalanced.

Saved version 2/3 requests retain their original rendering and hashes. An
already frozen unissued version 3 request is reused exactly. Historical capped
jobs retain their version 3 compatibility branch; future uncapped jobs gain no
`spend_control` or monetary gate. No database migration or historical rewrite is
part of this correction.

## Limits and remaining planner work

Retrieved source membership alone does not prove that a passage supports the
specific proposed attribution. Independent claim verification remains mandatory.
When research supplies no useful evidence for a selected factual route, that
route remains unavailable, its coverage deficit remains real, and the run may
finish partially. This change does not prove the next live exploration will
reach 100 accepted names.

The current Director artifact still represents fifteen directions of ten raw
targets and requires representation of every selected approach. A first-class
partition of supported and unavailable approaches would require a separately
versioned output/artifact contract, explicit unavailability reasons, revised
plan semantic validation and scheduler/recovery handling. Its persistence and
completion proofs would need corresponding review and regression coverage;
silently adding fields to immutable historical artifacts is unsuitable.

The 200-raw-proposal and 40-part ceilings are unchanged. Improving claim shape
does not guarantee sufficient usable factual proposals within those bounds.

## Offline validation

Focused contract, Director allocation, assignment selection, protocol and
worker tests exercise the old hole, all four factual routes, missing/optional/
foreign-source/self-certified claims, honest empty output, retrieved-source
selection, future version selection and exact saved-request reuse. The protocol
tests use an inert installed-SDK transport and make no provider request.

The broader SDK/migrated-SQL suite also exposed an existing concurrent
publication failure: `identity_coverage_incomplete` after identity refresh but
before microbatch publication. A controlled selector-3 baseline reproduces the
same failure, so it is separate from contract 4. The worker store now serializes
identity refresh plus publication for each job, with no provider work or open
database transaction in that queue. SQL guard failures propagate without a
blind retry; cancellation is checked after the wait and again after indexing.
Other jobs can continue independently. The actual SQL regression verifies
sibling publication and stale-lease rejection; the installed-SDK suite exercises
the repaired concurrent flow through normal recovery and completion. Existing
generation, Stop, ownership and duplicate-publication guards remain enforced.
This record does not claim full-app or live Naming readiness from fixtures.
