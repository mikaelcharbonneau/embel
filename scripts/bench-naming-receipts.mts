/** Disposable evidence only. Native mode requires an explicit reviewer slot. */
import { mkdir, statfs, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createTestDatabase, type TestDatabase } from "../tests/database/local-supabase.ts";
import { brainWorker, installBrainFixture } from "../tests/database/naming-brain-fixture.ts";
import { saveProgressiveResearch, seedProgressiveFixture } from "../tests/database/naming-brain-progressive-fixture.ts";
import { createReceiptNativeFixture } from "../tests/database/naming-receipt-native-fixture.ts";

const args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && args[0] !== "--native") throw new Error("receipt_benchmark_arguments_invalid");
const nativeMode = args[0] === "--native", cutoff = "20261026153000_naming_receipt_semantic_state.sql";
const output = { engine: nativeMode ? "native PostgreSQL18" : "PGlite/WASM", comparison: "separate complete predecessor and repaired schemas, each with its own actual triggers",
  limits: "Synthetic, local, one run; no production gain/causality inference. WAL includes locks/projections/checkpoint/full-page-image/background activity in each interval. No reset or forced checkpoint. Whole-RPC plans include nested statement work.",
  fixtures: [] as Record<string, unknown>[], rows: [] as Record<string, unknown>[] };
const directory = new URL("../.tmp/", import.meta.url); await mkdir(directory, { recursive: true });
const outputPath = new URL(`receipt-benchmark-${nativeMode ? "native" : "pglite"}-${Date.now()}.json`, directory);
const summary = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { sampleCount: sorted.length,
  p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)], meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length }; };

for (const mode of ["predecessor", "repair"] as const) {
  const options = mode === "predecessor" ? { before: cutoff } : {};
  const native = nativeMode ? await createReceiptNativeFixture(options) : undefined;
  const db: TestDatabase = native?.db ?? await createTestDatabase(options);
  try {
    await installBrainFixture(db);
    output.fixtures.push({ mode, database: native?.database ?? "in_memory", version: native?.version });
    const wal = async () => native ? (await native.setup.query("select pg_current_wal_insert_lsn()::text lsn")).rows[0].lsn : undefined;
    for (const pattern of ["timestamp_only", "meaningful_change"] as const) {
      const f = await seedProgressiveFixture(db), base = (await saveProgressiveResearch(f)).providerReceipt;
      let previous = 1;
      for (const target of [100, 1000, 5000]) {
        const space = await statfs(process.cwd());
        if (space.bavail * space.bsize < 8 * 1024 ** 3) throw new Error("receipt_benchmark_disk_reserve_reached");
        if (native && Number((await native.setup.query("select pg_database_size(current_database()) bytes")).rows[0].bytes) > 256 * 1024 ** 2) throw new Error("receipt_benchmark_fixture_budget_reached");
        const beginWal = await wal(), samples: number[] = [];
        await brainWorker(db, async () => {
          for (let index = previous; index < target; index++) {
            const incoming = { ...base, ...(pattern === "meaningful_change" ? { estimatedCostMicrousd: index } : {}),
              recordedAt: new Date(Date.UTC(2026, 9, 26, 1, 0, 0, index)).toISOString() };
            const start = performance.now(); await f.store.recordReceipt(f.job, incoming); samples.push(performance.now() - start);
            if (index % 500 === 0) { await f.store.reportReady(f.input.policy, "fixture-worker"); await f.store.heartbeat(f.job, 120); }
          }
        });
        const actual = (await db.query(`select count(*)::integer retained_rows,sum(octet_length(receipt::text))::bigint retained_bytes
          from fluid_private.naming_brain_receipts where run_id=$1`, [f.input.runId])).rows[0]!;
        if (mode === "repair") {
          const totals = (await db.query("select receipt_count::integer count,receipt_bytes::bigint bytes from fluid_private.naming_brain_receipt_totals where run_id=$1", [f.input.runId])).rows[0]!;
          if (String(totals.count) !== String(actual.retained_rows) || String(totals.bytes) !== String(actual.retained_bytes)) throw new Error("receipt_benchmark_counter_drift");
        }
        const row: Record<string, unknown> = { mode, pattern, observations: target, ...summary(samples), ...actual, counterConsistency: mode === "repair" ? "exact" : "not_applicable" };
        if (native) row.walBytes = Number((await native.setup.query("select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn)::text bytes", [beginWal])).rows[0].bytes);
        if (native && pattern === "meaningful_change" && target === 1000) {
          await brainWorker(db, async () => {
            await db.exec("begin");
            try { row.appendPlan = (await db.query("explain (analyze,buffers,wal,format json) select public.record_naming_brain_provider_receipt($1,$2,$3::jsonb)",
              [f.job.id, f.job.leaseToken, JSON.stringify({ ...base, estimatedCostMicrousd: 1_000_000, recordedAt: "2026-10-26T02:00:00Z" })])).rows[0]; }
            finally { await db.exec("rollback"); }
          });
        }
        output.rows.push(row); await writeFile(outputPath, JSON.stringify(output, null, 2));
        console.log(JSON.stringify({ mode, pattern, observations: target, retainedRows: actual.retained_rows, p50Ms: row.p50Ms, p95Ms: row.p95Ms }));
        previous = target;
      }
    }
  } finally { if (native) await native.close(); else await db.close(); }
}
