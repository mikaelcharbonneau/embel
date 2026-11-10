> Archived November 10, 2026: describes the system before the generation engine.

> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../architecture-review.md).

# Logo evidence-check planning candidate

Production timeout diagnostics included a Strategy availability call stack entering
`api_text_strategy_outcome_resolved`, which dynamically invokes the existing Logo
publication evidence matcher. This establishes where one statement was cancelled;
it does not establish which part consumed the statement timeout. Naming failures
also occurred in other functions. Neither the delivery deadline nor those Naming
failures have been reproduced by this local SQL replay.

Read-only hosted catalog inspection on 2026-10-23 confirmed these exact SQL stable,
security-invoker, postgres-owned, postgres-only EXECUTE helpers:

| Helper | Body MD5 | Function configuration |
| --- | --- | --- |
| `logo_publication_failure_adjudication_matches(uuid)` | `3aefd0303d54cd31382fb7debbaf90e3` | empty search path, UTC |
| `logo_absent_publication_adjudication_matches(uuid)` | `b35222e467ee7e74be8b74d91aea1c4b` | empty search path, UTC |

The parent matcher's uploaded-publication branch joins eight relations. The
absence branch joins six. A disposable PGlite PostgreSQL replay installed the
ordinary migration chain and the existing Logo candidate definitions, then ran
the identical live-hash SELECT bodies with `EXPLAIN (ANALYZE, FORMAT JSON,
TIMING FALSE)`. No hosted query plan, application row, provider or credential was
used. Empty relations isolate planning work; alternating settings reduce order
and warmup bias.

| Body | Planning at limit 8, ms | Planning at limit 1, ms | Median reduction |
| --- | --- | --- | --- |
| Parent matcher | 13.209, 9.412, 9.267 | 0.631, 0.497, 0.471 | about 19× |
| Absence matcher | 2.728, 2.734, 3.086 | 0.396, 0.402, 0.473 | about 6.8× |

Parent SELECT execution was 3.062–4.531 ms at eight and 0.546–0.654 ms at one;
that includes starting the nested SQL absence function. These are local
measurements, not hosted latency guarantees or proof that this planning cost
caused the production timeouts. PGlite does not reproduce hosted pooler, session,
concurrency or service-load behavior.

`supabase/candidates/logo_publication_evidence_join_planning.sql` is an unapplied
forward candidate. It sets `join_collapse_limit=1` only on the parent matcher.
The nested absence helper inherits the setting. The explicit order starts at the
exact adjudication/job identity and follows its evidence rows. Every join,
retained-row equality, ownership witness, reservation and absence predicate
remains byte-identical. The caller's setting is restored on return. The candidate
does not change timeouts, function bodies, permissions, roles, billing, data,
provider execution or request state.

Both predecessor body hashes and catalog security properties are pinned. The
candidate verifies the entire parent `pg_proc` row except the intended
configuration delta. The absence helper is checked and left unchanged. This file
belongs with the activation candidates because its predecessor helpers are not
installed by the ordinary migration chain. Existing cloud cutover packets pin
the original configuration and will deliberately fail closed after this candidate;
their later use requires a separately reviewed successor packet.

Verification: all 52 cases in
`tests/database/logo-absent-publication-adjudication.test.ts` passed. The complete
existing witness suite runs with original and candidate planning, covering the
uploaded-publication branch, exact absence witness, tampering, extra ambiguous
steps, foreign owners, Strategy scoping, late Storage/publication evidence,
immutability, leases and retained accounting. Ten additional checks verify only
the intended catalog delta, unchanged fixture data, caller-setting restoration,
hostile predecessor rejection and a relative planning improvement on the unchanged
live-hash body. A combined regression run with the original publication
adjudication and prior Strategy planning suites passed all 78 cases in three
files. ESLint and `git diff --check` passed for the changed test file.

No hosted DDL was attempted. A production cause and end-to-end improvement remain
unverified; do not describe this candidate as a confirmed fix for the 503s.

The planner behavior and function-local restoration follow PostgreSQL's
[explicit join documentation](https://www.postgresql.org/docs/current/explicit-joins.html)
and [function configuration documentation](https://www.postgresql.org/docs/current/sql-createfunction.html).
