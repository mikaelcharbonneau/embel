import { readFile, statfs, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import { createTestDatabase } from "../../tests/database/local-supabase";
import { benchmarkNamingRunIndexes, namingRunIndexMigration, type NamingLookupDatabase } from "../../tests/database/naming-run-lookup-benchmark";

const configSchema = z.strictObject({ disposable: z.literal(true), disposableCluster: z.literal(true), host: z.literal("127.0.0.1"),
  port: z.number().int().min(1024).max(65535), user: z.string().regex(/^[a-zA-Z_][a-zA-Z_0-9-]{0,62}$/u),
  database: z.literal("postgres"), password: z.string().optional(),
  expectedDataDirectory: z.string().startsWith("/"), expectedClusterName: z.string().min(1),
  runId: z.string().optional(), connectionTimeoutMillis: z.number().int().min(1).max(10_000).optional() });
const tables = ["naming_brain_artifacts", "naming_brain_stage_results", "naming_brain_feed_entries", "naming_brain_receipts"];
const indexNames = ["naming_brain_artifacts_run_stage_order", "naming_brain_stage_results_run_stage_order", "naming_brain_feed_entries_run", "naming_brain_receipts_call_latest"];

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error("usage_requires_private_config_and_output_paths");
  // No PG*/DATABASE_URL fallback and no connection-string CLI argument. The
  // reviewer supplies a private file only after qualifying its disposable cluster.
  const parsed = configSchema.safeParse(JSON.parse(await readFile(args[0]!, "utf8")));
  if (!parsed.success) throw new Error("explicit_disposable_loopback_config_required");
  const { disposable: _disposable, disposableCluster: _cluster, expectedDataDirectory, expectedClusterName,
    runId: _run, connectionTimeoutMillis: _timeout, ...connection } = parsed.data;
  void _disposable; void _cluster; void _run; void _timeout;
  const disk = await statfs(expectedDataDirectory);
  if (disk.bavail * disk.bsize < 8 * 1024 ** 3) throw new Error("native_fixture_free_disk_below_8gib");
  const admin = new Client({ ...connection, connectionTimeoutMillis: 5_000, statement_timeout: 30_000 });
  const database = `embel_naming_indexes_${process.pid}_${Date.now()}`;
  let setup: Client | undefined;
  try {
    await admin.connect();
    const server = (await admin.query<{ address: string; version: string; directory: string; cluster: string }>("select host(inet_server_addr()) address,current_setting('server_version') version,current_setting('data_directory') directory,current_setting('cluster_name') cluster")).rows[0]!;
    if (server.address !== "127.0.0.1" || !server.version.startsWith("18.")
      || server.directory !== expectedDataDirectory || server.cluster !== expectedClusterName) throw new Error("native_postgres18_task_cluster_required");
    console.info(JSON.stringify({ event: "native_naming_index_fixture_planned", database, preserveFixture: true }));
    const walBefore = (await admin.query<{ lsn: string }>("select pg_current_wal_insert_lsn()::text lsn")).rows[0]!.lsn;
    await admin.query(`create database ${database}`);
    setup = new Client({ ...connection, database, connectionTimeoutMillis: 5_000, statement_timeout: 30_000 });
    await setup.connect();
    // Bootstrap only plan relations from the exact pre-migration schema's
    // primitive column/index catalog. No cluster roles, application data,
    // functions, provider capabilities or credentials are installed here.
    const source = await createTestDatabase({ before: namingRunIndexMigration });
    try {
      const columns = (await source.query<{ name: string; columns: string }>(`select c.relname name,string_agg(quote_ident(a.attname)||' '||format_type(a.atttypid,a.atttypmod)||case when a.attnotnull then ' not null' else '' end,',' order by a.attnum) columns
        from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
        where n.nspname='fluid_private' and c.relname=any($1::text[]) group by c.relname`, [tables])).rows;
      const indexes = (await source.query<{ indexdef: string }>("select indexdef from pg_indexes where schemaname='fluid_private' and tablename=any($1::text[]) order by indexname", [tables])).rows;
      await setup.query("create schema fluid_private");
      for (const table of columns) await setup.query(`create table fluid_private.${table.name} (${table.columns})`);
      for (const index of indexes) await setup.query(index.indexdef);
    } finally { await source.close(); }
    const client = setup;
    const adapter: NamingLookupDatabase = {
      query: async <T>(sql: string, values?: unknown[]) => ({ rows: (await client.query(sql, values)).rows as T[] }),
      exec: sql => client.query(sql), close: async () => {},
    };
    const evidence = await benchmarkNamingRunIndexes(undefined, { database: adapter, engine: `Native PostgreSQL ${server.version}; synthetic disposable data, not production I/O` });
    const migration = await readFile(new URL(`../../supabase/migrations/${namingRunIndexMigration}`, import.meta.url), "utf8");
    const writer = new Client({ ...connection, database, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
    let lockCode: string | undefined;
    const lockStarted = performance.now();
    try {
      await writer.connect();
      await writer.query("begin");
      // Receipt is the last CREATE INDEX. A competing writer must roll back
      // the first three additions too, rather than leave a partial installation.
      await writer.query("lock table fluid_private.naming_brain_receipts in row exclusive mode");
      try { await setup.query(migration); }
      catch (error) { lockCode = (error as { code?: string }).code; await setup.query("rollback"); }
      if (lockCode !== "55P03") throw new Error("native_index_build_did_not_fail_closed_on_writer_lock");
    } finally { await writer.query("rollback").catch(() => {}); await writer.end(); }
    const lockMilliseconds = performance.now() - lockStarted;
    const partialIndexes = (await setup.query<{ n: number }>("select count(*)::int n from pg_indexes where schemaname='fluid_private' and indexname=any($1::text[])", [indexNames])).rows[0]!.n;
    if (partialIndexes !== 0) throw new Error("native_index_build_partially_committed");
    await setup.query(migration);
    const installed = (await setup.query<{ n: number; valid: boolean }>(`select count(*)::int n,bool_and(i.indisvalid and i.indisready) valid from pg_index i
      join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='fluid_private' and c.relname=any($1::text[])`, [indexNames])).rows[0]!;
    if (installed.n !== 4 || !installed.valid) throw new Error("native_index_rebuild_invalid");
    const wal = (await admin.query<{ bytes: string }>("select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn)::text bytes", [walBefore])).rows[0]!.bytes;
    const result = { ...evidence, fixtureDatabase: database, fixturePreserved: true, clusterIdentityVerified: true,
      nativeWal: { bytes: Number(wal), scope: "Entire disposable setup, synthetic inserts, index builds and lock rollback; cluster-wide LSN delta may include background maintenance. Not per-request or production WAL." },
      installationConcurrency: { lockCode, lockMilliseconds, partialIndexesAfterRollback: partialIndexes, installedAfterWriterReleased: installed },
      limits: "Plan-only relations omit foreign keys/application triggers. No full native application/RLS, provider or production qualification is claimed. No cluster roles or service settings changed." };
    await writeFile(args[1]!, JSON.stringify(result, null, 2));
    console.info(JSON.stringify({ engine: result.engine, fixtureDatabase: database, fixturePreserved: true, queries: Object.keys(result.samples), installationConcurrency: result.installationConcurrency }));
  } finally {
    await setup?.end();
    // The reviewer owns cluster shutdown and recoverable archival. Keep even a
    // failed run's uniquely named DB; never DROP DATABASE or remove data here.
    await admin.end();
  }
}

main().catch(error => {
  // Never print private connection configuration or a raw connection exception.
  const safeReasons = ["usage_requires_private_config_and_output_paths", "explicit_disposable_loopback_config_required", "native_fixture_free_disk_below_8gib", "native_postgres18_task_cluster_required",
    "native_index_build_did_not_fail_closed_on_writer_lock", "native_index_build_partially_committed", "native_index_rebuild_invalid"];
  console.error(JSON.stringify({ event: "native_naming_index_benchmark_failed", code: typeof error?.code === "string" ? error.code : "fixture_validation_failed",
    reason: safeReasons.includes(error?.message) ? error.message : undefined }));
  process.exitCode = 1;
});
