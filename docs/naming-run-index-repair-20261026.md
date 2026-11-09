> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Naming run lookup indexes — isolated phase one

> Historical: retired by the November 2026 Naming generation rebuild (docs/naming-generation-contract.md).

This change adds four nonunique indexes to the retained Naming evidence tables.
It changes no function, policy, grant, worker behavior, provider request, receipt
semantics, cancellation, accounting, spending control or historical data. Release
and generation remain on hold. Nothing in this record authorizes production SQL
or deployment.

Base: verified remote `main` at `56efd115c67baab57c478c60cb186e2bd7e321f6`
(PR149). Implementation branch: `review/naming-run-indexes-phase-one` in the
independent checkout `/tmp/embel-index-phase-one-20261026`. The initial Documents
checkout is preserved; macOS evicted some baseline files as `dataless` placeholders,
so final verification uses the byte-verified `/tmp` copy. Repository instructions
leave integration and commits to the lead; the handoff supplies an exact local
patch/hash manifest.

## Indexes and current callers

Migration: `supabase/migrations/20261026143000_naming_run_lookup_indexes.sql`.

| Index/table | Keys | Current reason |
| --- | --- | --- |
| `naming_brain_artifacts_run_stage_order` | `run_id, stage_key, id` | Stage artifact aggregation filters by run/stage and orders by artifact ID. Completion also checks artifacts by run/stage. |
| `naming_brain_stage_results_run_stage_order` | `run_id, stage_key, created_at, id` | Stage-result aggregation filters by run/stage and orders by creation/ID. |
| `naming_brain_feed_entries_run` | `run_id` | Progressive counts and preparation eligibility count entries for one run. |
| `naming_brain_receipts_call_latest` | `run_id, stage_key, call_key, created_at DESC, id DESC` | The receipt RPC reads the latest receipt for one exact call with `ORDER BY created_at DESC,id DESC LIMIT 1`. |

Relevant resolved functions originate in
`20261016180000_naming_brain.sql:415` (completion), `:753` (receipt writer),
and `20261017170000_local_progressive_naming.sql:257` (counts), `:289`
(progressive state). `20261017172000_local_expiry_maintenance.sql:42` places
the feed count early in preparation eligibility. Existing primary/unique replay
indexes remain in place; none of the additions includes large JSON payloads or
restricts itself to current job states. Historical and terminal rows benefit too.

The receipt specialist separately owns deduplication/counters. Integration must
recheck the final latest-receipt query shape before retaining the fourth index;
this branch does not rewrite that query or impose a new ordering contract.

## Installation and rollback semantics

The migration is an ordinary transactional index build with a three-second lock
timeout and thirty-second statement timeout. Ordinary `CREATE INDEX` holds table
write locks until commit. Readers can continue, but conflicting writers may wait;
this is **not** an online/concurrent-build deployment claim. No index is built
against production by this work.

All four additions commit together. A conflicting index name fails rather than
silently accepting a wrong definition through `IF NOT EXISTS`; rollback removes
earlier additions from the failed transaction. The migration ledger should prevent
normal duplicate application. A lost acknowledgement requires ledger/catalog
readback before any retry. Do not rename historical files or apply candidate SQL.

A separately approved release must choose a maintenance/build strategy based on
actual relation sizes and writers. If these bounded ordinary builds cannot fit
that window, prepare and qualify a distinct concurrent-build/operator procedure,
including invalid-index and partial-installation recovery. Do not remove timeouts
or run this migration blindly on a distressed database.

## Disposable correctness checks

`tests/database/naming-run-lookup-indexes.test.ts` rehearses the actual migration
on the pre-migration schema. It compares full-row digests for jobs, steps, usage,
requests, raw receipts/provider records, artifacts, results and publications, plus
function catalog, table ownership/ACL/RLS, policy and constraint fingerprints.

Cases include an empty installation; partial progressive publication and exact
replay; completed historical native-profile output with its held liability;
acknowledged queued cancellation; and deliberately unresolved synthetic evidence.
Other-owner feed/source RPCs remain rejected. A deliberate wrong final index name
proves transaction rollback does not leave the first three installed.

These fixtures use retained synthetic provider evidence. They do not create a
real provider session or establish the quality of generated names.

## Reproducible plan and overhead measurements

Run the offline comparison from the repository root:

```sh
node --import tsx scripts/benchmarks/naming-run-indexes.ts /absolute/output.json
```

The benchmark uses the exact pre-migration column/index catalog for four isolated
plan relations. Foreign keys and application triggers are intentionally absent;
the checked-RPC tests above verify application contracts separately. Deterministic
payloads and identifiers produce equal query results before/after. Target work is
fixed at 20 artifacts, 7 stage results, 100 feed entries and 5,000 receipts split
between two calls. Unrelated history grows through 1,000, 10,000 and 50,000 rows
per table, distributed across other synthetic runs/projects/owners. `ANALYZE`
runs after each batch. No planner flags force an index plan.

The comparison includes each actual lookup predicate, an absent run, and a
representative composed stage/count/latest-receipt projection. The composed query
is not a substitute for all authority/provider-proof branches of a claim RPC.
Plans retain actual rows, buffer counts and elapsed time. CI asserts bounded work
and unchanged results, not one exact small-table node choice. Index byte sizes,
batch insertion elapsed time and a populated transactional build rehearsal are
also retained. Batch timings are contextual local observations, not reliable
production throughput claims.

Final cached PGlite comparison with 50,000 unrelated rows showed:

| Lookup | Before buffers | After buffers |
| --- | ---: | ---: |
| Artifacts for populated run/stage | 8,337 | 7 |
| Ordered stage results | 8,335 | 5 |
| Run feed count | 1,066 | 5 |
| Latest receipt for exact call | 901 | 4 |
| Absent artifact run | 8,337 | 3 |
| Composed stage/count/latest projection | 18,639 | 21 |

All query results matched. Target lookups stayed bounded as unrelated history
grew: populated artifacts used 6→6→7 buffers, results 4→4→5, feed count 4→5→5,
latest receipt 3→4→4, absent run 2→2→3, and composed projection 17→19→21.
The four added indexes occupied 18,325,504 bytes at the final scale. Rebuilding
them on populated disposable relations succeeded with all indexes valid/ready;
one cached PGlite sample took about 215 ms. Additional index storage and write
maintenance are the tradeoff. These are logical cached-buffer/size observations,
not physical disk I/O or a promise about native/production build duration.

## Native adapter and recoverable fixture lifecycle

The independent reviewer owns the installed PostgreSQL 18 package, temporary
cluster, exclusive test slots, shutdown and recoverable data archival. This
branch's adapter neither installs nor starts/stops PostgreSQL. Invoke only after
the reviewer releases a qualified native slot:

```sh
node --import tsx scripts/benchmarks/naming-run-indexes-postgres.ts /private/config.json /absolute/output.json
```

The private file must declare `disposable:true`, `disposableCluster:true`,
`host:"127.0.0.1"`, an explicit port/user and `database:"postgres"`, with exact
`expectedDataDirectory` and `expectedClusterName`; password, run ID and bounded
connection-timeout metadata are supported. Nothing falls back to `DATABASE_URL`
or `PG*`. Before creating a uniquely named `embel_naming_indexes_*` database, the
adapter checks `host(inet_server_addr())`, PostgreSQL 18 and both cluster identity
settings. It checks available disk against the reviewer's 8 GiB stop floor.
The reviewer monitors the shared package/cluster 3 GiB incremental-disk ceiling.

The adapter runs the same query/data comparisons, retains a cluster-scoped WAL
LSN delta for the entire synthetic fixture operation, and tests independent-backend
installation contention. A writer lock on the last table must cause `55P03` and
rollback all four new indexes; after releasing it, the exact migration must build
four valid/ready indexes. This establishes installation behavior, not concurrent
application receipt/counter correctness or production performance.

The generated fixture database is **always retained**, including a failed run.
Connections close; there is no `DROP DATABASE` or irreversible data cleanup.
The reviewer retains the cluster directory recoverably after stopping the server.
The package remains installed under the user's approved cleanup scope. Config,
password and raw connection exceptions are not logged.

## Verification status and remaining gates

The final delivery includes exact check logs, source/file hashes and sanitized
benchmark JSON outside the repository. Typecheck, lint and all seven new tests
passed against the canonical `/tmp` source, as did the expanded PGlite benchmark.
Aggregate tests/build and the qualified native rerun are recorded in the delivery
evidence. No native success is inferred from the initial Documents-based attempt,
which created a retained fixture but stalled reading an evicted baseline SQL file
before plan-data creation. At source freeze, the native slot had been released to
the receipt specialist and a rerun awaited the reviewer's explicit next slot.

No production plan, relation-size, ACL/ledger readback, deployment, generation or
resource-recovery result is claimed. The whole-codebase review and separate
controlled-pause observations still do not establish Naming as the sole source of
the Supabase resource pressure. The combined receipt/index diff requires the
independent reviewer's acceptance before any later release decision.
