import { readFile } from "node:fs/promises";
import { createTestDatabase } from "./local-supabase";

export const namingRunIndexMigration = "20261026143000_naming_run_lookup_indexes.sql";
const run = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tables = ["naming_brain_artifacts", "naming_brain_stage_results", "naming_brain_feed_entries", "naming_brain_receipts"] as const;
export type LookupPlan = {
  "Node Type": string;
  "Index Name"?: string;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Actual Rows"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: LookupPlan[];
};
type Explain = { Plan: LookupPlan; "Execution Time": number };
export type NamingLookupDatabase = {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<unknown>;
};
export type NamingLookupSample = { unrelatedRowsPerTable: number; query: string; before: Explain; after: Explain; equalResults: boolean };
export const lookupBuffers = (plan: LookupPlan) => (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0);
export function lookupNodes(plan: LookupPlan): LookupPlan[] { return [plan, ...(plan.Plans ?? []).flatMap(lookupNodes)]; }

/** Disposable plan relations retain the real pre-migration columns/indexes.
 * Foreign keys and application triggers are intentionally absent: generated
 * rows measure lookup work and never claim real provider/ownership evidence.
 * Separate checked-RPC migration tests verify the actual application contracts. */
export async function benchmarkNamingRunIndexes(scales: readonly number[] = [1_000, 10_000, 50_000], options: { database?: NamingLookupDatabase; engine?: string } = {}) {
  if (!scales.length || scales.some((size, index) => !Number.isSafeInteger(size) || size < 1 || size > 100_000 || index > 0 && size <= scales[index - 1]!)) throw new Error("invalid_disposable_benchmark_scales");
  const db: NamingLookupDatabase = options.database ?? await createTestDatabase({ before: namingRunIndexMigration });
  const samples: Record<string, NamingLookupSample[]> = Object.fromEntries([...tables, "absent_artifact_run", "composed_stage_projection"].map(table => [table, []]));
  const overhead: { unrelatedRowsPerTable: number; insertionMilliseconds: Record<string, number>; addedIndexBytes: { name: string; bytes: number }[] }[] = [];
  try {
    for (const schema of ["naming_lookup_before", "naming_lookup_after"]) {
      await db.exec(`create schema ${schema}`);
      for (const table of tables) await db.exec(`create table ${schema}.${table} (like fluid_private.${table} including indexes)`);
    }
    const migration = await readFile(new URL(`../../supabase/migrations/${namingRunIndexMigration}`, import.meta.url), "utf8");
    const afterMigration = migration.replaceAll("fluid_private.", "naming_lookup_after.");
    await db.exec(afterMigration);
    async function insertRows(schema: string, first: number, last: number, target: boolean) {
      const runId = target ? `'${run}'::uuid` : "md5('unrelated-run-'||(i/100)::text)::uuid";
      const owner = target ? `'${run}'::uuid` : "md5('unrelated-owner-'||(i/1000)::text)::uuid";
      const project = target ? `'${run}'::uuid` : "md5('unrelated-project-'||(i/100)::text)::uuid";
      const generated = `from generate_series(${first},${last}) i`;
      const payload = "jsonb_build_object('synthetic',repeat(md5(i::text),32))";
      // Keep target cardinality fixed while unrelated history grows.
      if (!target || first === 1) {
        const range = target ? "from generate_series(1,20) i" : generated;
        await db.exec(`insert into ${schema}.naming_brain_artifacts(id,run_id,owner_id,project_id,stage_key,artifact,receipt_id)
          select md5('artifact-'||(${runId})::text||i::text)::uuid,${runId},${owner},${project},'creation',${payload},gen_random_uuid() ${range}`);
        await db.exec(`insert into ${schema}.naming_brain_stage_results(id,run_id,owner_id,project_id,stage_key,state,output,created_at)
          select md5('result-'||(${runId})::text||i::text)::uuid,${runId},${owner},${project},'creation','succeeded',${payload},timestamptz '2026-10-01'+i*interval '1 millisecond' ${target ? "from generate_series(1,7) i" : generated}`);
        await db.exec(`insert into ${schema}.naming_brain_feed_entries(id,run_id,owner_id,project_id,candidate_id,position,steering_revision,metadata)
          select gen_random_uuid(),${runId},${owner},${project},gen_random_uuid(),i,0,jsonb_build_object('primaryApproach','real_words') ${target ? "from generate_series(1,100) i" : generated}`);
        await db.exec(`insert into ${schema}.naming_brain_receipts(id,run_id,owner_id,project_id,stage_key,call_key,receipt,content_hash,created_at)
          select gen_random_uuid(),${runId},${owner},${project},'creation',case when i%2=0 then 'wanted-call' else 'other-call' end,
          ${payload},md5(i::text),timestamptz '2026-10-01'+i*interval '1 millisecond' ${target ? "from generate_series(1,5000) i" : generated}`);
      }
    }
    for (const schema of ["naming_lookup_before", "naming_lookup_after"]) await insertRows(schema, 1, 1, true);
    let prior = 0;
    for (const size of scales) {
      const insertionMilliseconds: Record<string, number> = {};
      for (const schema of ["naming_lookup_before", "naming_lookup_after"]) {
        const started = performance.now();
        await insertRows(schema, prior + 1, size, false);
        insertionMilliseconds[schema] = performance.now() - started;
        for (const table of tables) await db.exec(`analyze ${schema}.${table}`);
      }
      const queries: Record<string, string> = {};
      for (const table of tables) {
        const suffix = table === "naming_brain_feed_entries" ? ""
          : table === "naming_brain_receipts" ? " and stage_key='creation' and call_key='wanted-call' order by created_at desc,id desc limit 1"
          : table === "naming_brain_artifacts" ? " and stage_key='creation' order by id" : " and stage_key='creation' order by created_at,id";
        queries[table] = `select ${table === "naming_brain_feed_entries" ? "count(*)" : table === "naming_brain_receipts" ? "receipt" : table === "naming_brain_artifacts" ? "artifact" : "output"} from SCHEMA.${table} where run_id='${run}'${suffix}`;
      }
      queries.absent_artifact_run = "select artifact from SCHEMA.naming_brain_artifacts where run_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' and stage_key='creation' order by id";
      // Composes the actual stage aggregate/count/latest predicates. It is a
      // representative read projection, not an EXPLAIN of a live claim RPC or
      // a benchmark of all authority/provider-proof branches in that function.
      queries.composed_stage_projection = `select jsonb_build_object(
        'artifacts',(select jsonb_agg(artifact order by id) from SCHEMA.naming_brain_artifacts where run_id='${run}' and stage_key='creation'),
        'stageResults',(select jsonb_agg(output order by created_at,id) from SCHEMA.naming_brain_stage_results where run_id='${run}' and stage_key='creation'),
        'publishedCount',(select count(*) from SCHEMA.naming_brain_feed_entries where run_id='${run}'),
        'latestReceipt',(select receipt from SCHEMA.naming_brain_receipts where run_id='${run}' and stage_key='creation' and call_key='wanted-call' order by created_at desc,id desc limit 1)) projection`;
      for (const [name, query] of Object.entries(queries)) {
        const sql = (schema: string) => query.replaceAll("SCHEMA", schema);
        const explain = async (schema: string) => (await db.query<{ "QUERY PLAN": Explain[] }>(`explain (analyze,buffers,format json) ${sql(schema)}`)).rows[0]!["QUERY PLAN"][0]!;
        const before = await explain("naming_lookup_before"), after = await explain("naming_lookup_after");
        const equalResults = JSON.stringify((await db.query(sql("naming_lookup_before"))).rows) === JSON.stringify((await db.query(sql("naming_lookup_after"))).rows);
        if (!equalResults) throw new Error(`disposable_benchmark_result_changed:${name}`);
        samples[name]!.push({ unrelatedRowsPerTable: size, query, before, after, equalResults });
      }
      const addedIndexBytes = (await db.query<{ name: string; bytes: number }>(`select c.relname name,pg_relation_size(c.oid)::int bytes from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='naming_lookup_after' and c.relkind='i' and c.relname in('naming_brain_artifacts_run_stage_order','naming_brain_stage_results_run_stage_order','naming_brain_feed_entries_run','naming_brain_receipts_call_latest') order by c.relname`)).rows;
      overhead.push({ unrelatedRowsPerTable: size, insertionMilliseconds, addedIndexBytes });
      prior = size;
    }
    // Also rehearse the exact addition on the populated disposable relations.
    // Dropping only these disposable indexes leaves all benchmark rows intact.
    for (const index of overhead.at(-1)!.addedIndexBytes) await db.exec(`drop index naming_lookup_after.${index.name}`);
    const buildStarted = performance.now();
    await db.exec(afterMigration);
    const buildMilliseconds = performance.now() - buildStarted;
    const validity = (await db.query<{ valid: boolean }>(`select bool_and(i.indisvalid and i.indisready) valid from pg_index i join pg_class c on c.oid=i.indexrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='naming_lookup_after' and c.relname=any($1::text[])`, [overhead.at(-1)!.addedIndexBytes.map(index => index.name)])).rows[0]!.valid;
    if (!validity) throw new Error("disposable_populated_index_build_invalid");
    return { engine: options.engine ?? "PGlite 0.5.8 / embedded PostgreSQL; cached synthetic data, not native or production I/O", targetRows: { artifacts: 20, stageResults: 7, feedEntries: 100, receipts: 5_000 }, samples, overhead,
      populatedMigrationRehearsal: { unrelatedRowsPerTable: scales.at(-1), buildMilliseconds, allIndexesValid: validity } };
  } finally { await db.close(); }
}
