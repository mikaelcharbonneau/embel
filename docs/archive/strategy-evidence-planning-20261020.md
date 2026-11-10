> Archived November 10, 2026: describes the system before the generation engine.

> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../architecture-review.md).

# Strategy evidence-check planning

## Observed failure and limits

After the deleted-request quarantine was installed, a live authenticated
availability request timed out in PostgreSQL while starting
`research_operator_adjudication_matches`. Its call stack passed through the
scoped allowance pause and per-operation availability aggregation. The pending
research job had no recorded worker attempt before the user cancelled it.
This proves an availability timeout, not the precise reason that the worker
never claimed that job. No provider success or resolved billing is inferred.

The relevant live relations are small: 123 jobs, 147 steps, 27 allowance
admissions, 26 testing admissions and 94 reservations. Their job/owner key
indexes are present. JIT is off. The expensive historical matcher joins eight
relations and the quarantine matcher joins seven, with exact receipt and ledger
checks. Exhaustive join-order planning is costly even with no matching rows.

An isolated disposable PostgreSQL replay of the identical historical matcher
SELECT took 371 ms cold / 91 ms warm to plan with the default join-collapse limit
of eight, versus roughly 3 ms with a limit of one. Execution was below 1 ms.
The quarantine SELECT's planning fell from 16–19 ms to roughly 2 ms.
These are diagnostic measurements, not a production service-level guarantee.

A separate live read-only transaction with a session-local limit of one reduced
the five-operation allowance-helper scan from 1,122 ms to 169 ms, and a testing
job-authority helper from 706 ms to 420 ms. That transaction was rolled back.
Its setting covered all nested functions, so those gains are not a measured
guarantee for the narrower two-function migration below.

## Narrow change

`20261020031000_strategy_evidence_join_planning.sql` adds only the
function-local `join_collapse_limit=1` setting to:

- `fluid_private.research_operator_adjudication_matches(uuid)`
- `fluid_private.api_text_deleted_strategy_quarantined(uuid,text,uuid,uuid)`

PostgreSQL then follows each function's existing explicit join order instead of
enumerating all equivalent orders. Each query begins at its exact primary-key
receipt/job identity and follows unique owned rows. Every existing join,
predicate, row hash, reservation sum and global pause remains unchanged.
The setting is restored when the function returns; no database-wide, role,
session, timeout, permission or security setting is relaxed.

The migration pins both predecessor body hashes and security properties, rejects
unexpected execute grants, and verifies that all `pg_proc` fields except the
intended configuration delta are byte-equivalent. It writes no application or
accounting rows and does not retry any request.

## Verification and release boundary

The full 52-case quarantine boundary suite runs with both original and bounded
planning. It covers actual authenticated admission and restricted-worker
gateways, new-request settlement, Restore, wrong owners, malformed evidence,
remaining leases, overruns, raw runtime and unchanged retained history.
Additional tests check the exact catalog delta, hostile predecessors,
caller-setting restoration and relative planning cost. The existing synthetic
historical-receipt fixture compares matched legacy/current receipts and changed
evidence under both settings without weakening its matcher.

The focused run passed all 128 cases in three files: 104 original/tuned
quarantine cases, nine migration/catalog/planning cases and 15 historical
recovery cases. The three changed test files passed ESLint. Independent review
confirmed the two live predecessor hashes/security attributes and separately
passed the nine migration cases. A complete ordered disposable migration replay
also passed and retained both original body hashes with only the intended
function-local configuration additions. The reviewed migration SHA-256 is
`17761dba01715c7b171370e5272d583a28a01a80e37cd476472abfc04aeed396`.

No hosted DDL or provider request is part of this implementation. Any later live
installation/verification must be recorded separately. A successful availability
check alone does not prove a completed AI request.

References:
[PostgreSQL explicit join planning](https://www.postgresql.org/docs/17/explicit-joins.html)
and [function-local configuration](https://www.postgresql.org/docs/17/sql-createfunction.html).

## Production verification, 2026-10-20

The exact independently reviewed migration was installed at approximately 03:13 UTC. Readback confirmed both original function-body hashes unchanged and only the intended local planner settings added. With the caller's default join-collapse limit still eight, the same native read-only availability-helper measurement fell from 1,122.322 ms to 490.411 ms; testing-job validation fell from 706.118 ms to 76.878 ms. These are single observations under live load/cache, not controlled medians or a latency guarantee.

The owner separately approved exactly one fresh competitor-research acceptance test, capped at USD 15.90, and expressly approved a local browser task on their connected Mac. The normal authenticated UI created the QA project and admitted a fresh request; no cancelled request was retried. It was admitted at 03:11:24 UTC, published at 03:11:31, began its one provider step at 03:14:42, and succeeded at 03:14:52. A provider receipt and output were persisted, and its reservation settled at an actual USD 0.034817. No second request was started.

At 03:15:57 UTC the browser showed Saved project · v3. The AI's response asked which city and neighborhood the coffee shop would serve, and it survived reload. This verifies a complete persisted AI exchange, not a finished competitor comparison or the full branding workflow. The roughly three-minute pre-execution wait is distinct from the roughly ten-second provider step. Its precise cause and the migration's causal role in the later claim remain unproven.
