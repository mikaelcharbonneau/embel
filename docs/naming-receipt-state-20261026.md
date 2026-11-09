# Naming receipt state repair — source only, 2026-10-26

> Historical: retired by the November 2026 Naming generation rebuild (docs/naming-generation-contract.md).

## Scope and release boundary

Phase one changes receipt persistence and its acknowledgment/recovery readers,
starting at verified main `56efd115c67baab57c478c60cb186e2bd7e321f6` (PR149).
This branch is isolated and local. Naming remains paused. There is no production
SQL execution, migration, deployment, worker resume, service change or paid call.
The database specialist owns the independent run/latest-receipt indexes.
Readiness leadership, lock scope, scheduling, policy/model selection, spending
controls and financial settlement are outside this change.

## Receipt contract

Only the top-level `recordedAt` is excluded from semantic equality. Every other
field, nested observation timestamp, array element and array ordering remains
substantive. Unchanged current observations return the actual retained receipt
including its original timestamp. No historical row, content hash, raw provider
item, artifact binding or accounting evidence is rewritten or removed.

SQL still enforces the restricted owner/job/lease/call/request/profile binding.
Exact full-JSON replay returns the original immutable row even after a newer
observation; it does not move the current pointer. A newly timestamped regression
cannot erase acknowledged call IDs, artifact IDs, usage/cost observations or
terminal tool facts. These cumulative sets must retain prior evidence. Started
tools may complete, and a missing tool item ID may become known. Valid dispatch
state transitions, including unknown -> dispatched, remain durable.

`NamingBrainJobStore.recordReceipt` returns the acknowledged receipt and rejects
any substantive mismatch. The native transport keeps that exact acknowledgment,
uses it in final output artifacts, and suppresses repeated acknowledged current
states before sending another RPC. A failed callback never populates the cache.
Legacy inert adapters may return void; the actual database adapter always returns
the stored receipt. Error/cancellation paths use the same acknowledgment logic.
Repeated old in-progress tool events cannot erase an acknowledged terminal fact.

## Current state and history ordering

`naming_brain_receipt_current` records the actual last physical append per call.
It does not manufacture or rewrite timestamps when clocks tie or move backwards.
Existing history without a pointer retains its prior deterministic
`created_at,id` ordering until initialization; the migration cannot invent an
unknown historical insertion order.

The existing authorized stage/progressive-state RPC adds `currentReceipts`, while
leaving the historical receipt array unchanged. The store verifies every current
receipt occurs in that retained history. All three TypeScript latest-receipt
readers use the shared selector, and SQL rejected/no-dispatch completion proof
uses the same latest-receipt helper. Thus recovery does not accidentally choose
an older no-identity receipt merely because its database timestamp sorts later.
No new public RPC/grant or read-lock scope is introduced.

## Exact capacity without repeated history serialization

`naming_brain_receipt_totals` holds exact physical row count and
`sum(octet_length(receipt::text))`, using PostgreSQL JSONB/UTF-8 serialization,
not JavaScript byte estimates. Historical timestamp duplicates count in full.
The existing 500/8-MiB legacy and 5,000/64-MiB progressive envelopes stay intact.
These are evidence-size limits, not monetary controls.

No global backfill runs during migration. A missing totals row means
uninitialized, never zero usage. Before the first genuinely new append for a run,
the existing owner/job/run locks protect one exact aggregate initialization. An
AFTER INSERT trigger then increments totals and updates current state in the same
transaction as the physical receipt row. It also covers compatible/raw fixture
append paths. Existing immutable-history triggers continue prohibiting updates
and deletes. A statement/transaction rollback rolls back receipt, totals and
current pointer together. Duplicate replay returns before consuming capacity.

Counters/projections have forced RLS and no worker/browser/service-role privileges.
New private helper ACLs are explicitly stripped, including hostile defaults.
Public function OIDs, ownership and existing ACLs are preserved. Exact predecessor
guards reject unexpected function drift transactionally.

## Rehearsal and mandatory stopped cutover

This is **not a rolling compatibility claim**. An old worker's strict stage parser
rejects the additive `currentReceipts` field. A new worker accepts old SQL's absent
projection and exact acknowledgment, retaining historical fallback behavior, but
old SQL cannot provide the new ordering/capacity guarantees. Both the new SQL and
the matching worker must be qualified before any separately authorized resume.

1. Keep Naming paused and verify no old/new writer overlap through the existing
   release process. Inventory exact source, schema/ACL/function predecessors and
   the real migration-ledger mapping. Folder order alone is not that mapping.
2. Rehearse on a disposable/restored database. Index and receipt migrations are
   independent; check both supported orders in the combined review. The receipt
   migration is transactional DDL, takes installation locks and is not claimed to
   be a zero-lock live rollout. Use bounded lock/statement timeouts and inspect
   predecessor mismatch before approving any production action.
3. Optional warming is one run at a time under the existing lock order. The
   candidate `supabase/candidates/naming_receipt_totals_rehearsal.sql` verifies
   exact totals and rolls back. Do not change it to a broad live scan or automatic
   global backfill. A commit-capable warmup requires separate operational review.
4. Verify original receipt IDs/hashes, artifact links, unknown outcomes and
   reservations unchanged; check counters against a full sum in the rehearsal.
   An existing inconsistent counter is reported, not silently repaired.
5. Build/qualify the matching immutable worker. Only a separately authorized
   held-release procedure may apply SQL, deploy or resume production. Keep the
   existing no-overlap rule. No provider call is a qualification shortcut.

An already applied migration is identified by its ledger; blindly reexecuting the
file fails the predecessor guard. A lost migration acknowledgment requires catalog
and ledger readback, not retrying a destructive bootstrap. No down migration that
deletes evidence is supplied. Rolling back the worker alone while new SQL remains
installed is unsupported; keep writers stopped and review recovery instead.

## Verification and measurement

Focused tests exercise 1,000 timestamp-only observations; field/state changes at
equal clocks; original timestamps and historical replay; cumulative usage/tool
regression; lost acknowledgment followed by a fresh store; after-insert failure
and rollback; counters over historical duplicates; capacity in both profiles;
hostile defaults; drift rejection; and exact SQL artifact/completion bindings.

The actual SDK/transport/store/SQL progressive cases force SQL to acknowledge an
older stored timestamp, then persist and read genuine-shaped synthetic 100-name
outputs. The composed clock cases retain a later-sorting no-identity receipt,
insert a known Verifier identity with an earlier database timestamp, and require
actual recovery to GET that saved session without another create. Completed and
cancelled terminal outcomes remain distinct; original history hashes stay exact.

Native tests require `EMBEL_RECEIPT_NATIVE_CONFIG` pointing to a user-owned private
configuration from the independent reviewer, plus an explicit sequential slot.
They verify the exact loopback cluster/data-directory identity, PostgreSQL18 and
durability settings before creating fixtures. Two independent backend PIDs and
advisory-lock waits establish the concurrency barrier. Cases cover duplicate and
near-capacity races (the loser must be SQL22023/receipt_capacity), rollback,
backfill-versus-writer and committed acknowledgment replay. Fixture databases and
roles are preserved; connections close and names/durability are recorded. This
harness neither installs nor starts/stops the server.

`scripts/bench-naming-receipts.mts` runs locally with PGlite, or with `--native`
only against the qualified cluster. It measures timestamp-only and genuinely
changing observations at 100/1,000/5,000, medians/p95, retained JSON bytes, exact
counters and native WAL. It compares separate complete predecessor/repaired
schemas, each with its actual triggers; it is not a deployed before/after.
Intervals may include checkpoint/full-page-image/background WAL, which is not
attributed solely to the changed function. Native append EXPLAIN/buffer/WAL evidence
uses a rolled-back fixture probe, never production. It preserves an 8-GiB free
disk reserve and bounds its own database to 256 MiB.

Executed logs/metrics, frozen source manifest and final aggregate results are
retained in the task evidence directory. PGlite tests do not establish native
concurrency/WAL; native synthetic results do not establish production recovery,
actual provider quality, live migration parity or the cause of the NANO incident.
