import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createTestDatabase, OWNER_B, type TestDatabase } from "./local-supabase";
import { brainAction, brainRpc, brainWorker, initialIntent, installBrainFixture, prepareBrainFixture, seedBrainFixture } from "./naming-brain-fixture";
import { saveProgressivePart, saveProgressiveResearch, seedProgressiveFixture } from "./naming-brain-progressive-fixture";
import { benchmarkNamingRunIndexes, lookupBuffers, lookupNodes, namingRunIndexMigration } from "./naming-run-lookup-benchmark";

const expectedIndexes = [
  "naming_brain_artifacts_run_stage_order",
  "naming_brain_feed_entries_run",
  "naming_brain_receipts_call_latest",
  "naming_brain_stage_results_run_stage_order",
];
const historyTables = ["public.jobs", "public.job_steps", "public.usage_reservations", "public.usage_accounts", "public.name_candidates", "public.naming_batches",
  "fluid_private.naming_brain_runs", "fluid_private.naming_brain_pilots", "fluid_private.naming_brain_calls", "fluid_private.naming_brain_call_plans",
  "fluid_private.naming_brain_receipts", "fluid_private.naming_brain_provider_records", "fluid_private.naming_brain_artifacts", "fluid_private.naming_brain_stage_results",
  "fluid_private.naming_brain_prepared_sets", "fluid_private.naming_brain_feed_entries", "fluid_private.naming_brain_microbatches", "fluid_private.naming_brain_progressive_plans"];

describe("additive Naming run lookup indexes (disposable SQL)", () => {
  let db: TestDatabase, migration: string;
  beforeAll(async () => { migration = await readFile(new URL(`../../supabase/migrations/${namingRunIndexMigration}`, import.meta.url), "utf8"); });
  beforeEach(async () => { db = await createTestDatabase({ before: namingRunIndexMigration }); await installBrainFixture(db); }, 30_000);
  afterEach(async () => { await db?.close(); });

  async function preserved() {
    const history: Record<string, unknown> = {};
    for (const table of historyTables) history[table] = (await db.query(`select md5(coalesce(jsonb_agg(to_jsonb(row) order by to_jsonb(row)::text)::text,'[]')) digest from ${table} row`)).rows[0];
    const catalog = (await db.query(`select
      (select md5(jsonb_agg(to_jsonb(p) order by p.oid)::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','fluid_private')) functions,
      (select md5(jsonb_agg(jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'file',c.relfilenode) order by c.oid)::text) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in('public','fluid_private')) tables,
      (select md5(jsonb_agg(to_jsonb(p) order by p.oid)::text) from pg_policy p) policies,
      (select md5(jsonb_agg(to_jsonb(c) order by c.oid)::text) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in('public','fluid_private')) constraints`)).rows;
    return { history, catalog };
  }
  async function applyWithoutChangingEvidence() {
    const before = await preserved();
    await db.exec(migration);
    expect(await preserved()).toEqual(before);
    const indexes = (await db.query<{ indexname: string; indexdef: string; valid: boolean; ready: boolean }>(`select i.indexname,i.indexdef,x.indisvalid valid,x.indisready ready from pg_indexes i
      join pg_namespace n on n.nspname=i.schemaname join pg_class c on c.relnamespace=n.oid and c.relname=i.indexname join pg_index x on x.indexrelid=c.oid
      where i.schemaname='fluid_private' and i.indexname=any($1::text[]) order by i.indexname`, [expectedIndexes])).rows;
    expect(indexes.map(row => row.indexname)).toEqual(expectedIndexes);
    expect(indexes.every(row => row.valid && row.ready && !row.indexdef.includes("INCLUDE") && !row.indexdef.includes("WHERE"))).toBe(true);
    expect(indexes.map(row => row.indexdef)).toEqual([
      expect.stringContaining("naming_brain_artifacts USING btree (run_id, stage_key, id)"),
      expect.stringContaining("naming_brain_feed_entries USING btree (run_id)"),
      expect.stringContaining("naming_brain_receipts USING btree (run_id, stage_key, call_key, created_at DESC, id DESC)"),
      expect.stringContaining("naming_brain_stage_results USING btree (run_id, stage_key, created_at, id)"),
    ]);
  }

  it("preserves the empty schema's functions, ownership, ACLs, constraints and RLS", async () => {
    await applyWithoutChangingEvidence();
    // A conflicting name cannot silently masquerade as the intended index.
    await expect(db.exec(migration)).rejects.toMatchObject({ code: "42P07" });
    await db.exec("rollback");
    expect((await db.query("select count(*)::int n from pg_indexes where indexname=any($1::text[])", [expectedIndexes])).rows).toEqual([{ n: 4 }]);
  });

  it("rolls back the entire addition if the last index name already has a different definition", async () => {
    await db.exec("create index naming_brain_receipts_call_latest on fluid_private.naming_brain_receipts(run_id)");
    const before = await preserved();
    await expect(db.exec(migration)).rejects.toMatchObject({ code: "42P07" });
    await db.exec("rollback");
    expect(await preserved()).toEqual(before);
    expect((await db.query("select indexname,indexdef from pg_indexes where schemaname='fluid_private' and indexname=any($1::text[])", [expectedIndexes])).rows).toEqual([
      { indexname: "naming_brain_receipts_call_latest", indexdef: "CREATE INDEX naming_brain_receipts_call_latest ON fluid_private.naming_brain_receipts USING btree (run_id)" },
    ]);
  });

  it("preserves partial progressive publication, exact replay and other-owner rejection", async () => {
    const fixture = await seedProgressiveFixture(db);
    await saveProgressiveResearch(fixture);
    const part = await saveProgressivePart(fixture, 0, 6);
    const publish = () => brainWorker(db, () => fixture.store.publishMicrobatch(fixture.job, part.publication!, new AbortController().signal));
    const original = await publish();
    const feed = await brainRpc(db, "get_naming_feed", [fixture.project, {}]);
    const sources = await brainRpc(db, "get_naming_brain_candidate_sources", [fixture.project, original.candidateIds]);
    await applyWithoutChangingEvidence();
    expect(await publish()).toEqual(original);
    expect(await brainRpc(db, "get_naming_feed", [fixture.project, {}])).toEqual(feed);
    expect(await brainRpc(db, "get_naming_brain_candidate_sources", [fixture.project, original.candidateIds])).toEqual(sources);
    await expect(brainRpc(db, "get_naming_feed", [fixture.project, {}], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(brainRpc(db, "get_naming_brain_candidate_source", [fixture.project, original.candidateIds[0]], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  });

  it("retains completed historical native artifacts, published names and their financial hold", async () => {
    const project = await seedBrainFixture(db), prepared = await prepareBrainFixture(db, project);
    await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'prepare','succeeded','{\"artifactIds\":[]}')", [prepared.job.id, prepared.job.lease_token]));
    await brainAction(db, prepared.job, "finish", { state: "succeeded", errorCode: null });
    const original = await brainRpc(db, "append_prepared_naming_set", [project, prepared.preparedSetId]);
    const accounting = await brainRpc(db, "get_naming_brain_job_accounting", [prepared.job.id]);
    await applyWithoutChangingEvidence();
    expect(await brainRpc(db, "append_prepared_naming_set", [project, prepared.preparedSetId])).toEqual(original);
    expect(await brainRpc(db, "get_naming_brain_job_accounting", [prepared.job.id])).toEqual(accounting);
    expect((await db.query("select state from public.jobs where id=$1", [prepared.job.id])).rows).toEqual([{ state: "succeeded" }]);
  });

  it("leaves acknowledged cancellation and the original request replay unchanged", async () => {
    const project = await seedBrainFixture(db), intent = initialIntent("synthetic-index-cancelled");
    await brainRpc(db, "ensure_naming_brain_run", [project, intent]);
    const job = (await db.query<{ id: string }>("select id from public.jobs where project_id=$1", [project])).rows[0]!;
    await brainRpc(db, "request_job_cancel", [job.id]);
    const replay = await brainRpc(db, "ensure_naming_brain_run", [project, intent]);
    await applyWithoutChangingEvidence();
    expect(await brainRpc(db, "ensure_naming_brain_run", [project, intent])).toEqual(replay);
    expect((await db.query("select state,lease_token from public.jobs where id=$1", [job.id])).rows).toEqual([{ state: "cancelled", lease_token: null }]);
  });

  it("preserves ambiguous observation evidence without settling or re-enabling it", async () => {
    const fixture = await seedProgressiveFixture(db);
    await saveProgressiveResearch(fixture);
    // A synthetic unresolved stage is deliberately retained, never adjudicated
    // by an index operation or mistaken for a production provider outcome.
    await brainWorker(db, () => db.query("select public.complete_naming_brain_stage($1,$2,'creation','ambiguous','{\"artifactIds\":[],\"errorCode\":\"synthetic_unknown\"}')", [fixture.job.id, fixture.job.leaseToken]));
    const accounting = await brainRpc(db, "get_naming_brain_job_accounting", [fixture.job.id]);
    await applyWithoutChangingEvidence();
    expect(await brainRpc(db, "get_naming_brain_job_accounting", [fixture.job.id])).toEqual(accounting);
    expect((await db.query("select state,lease_token from public.jobs where id=$1", [fixture.job.id])).rows).toEqual([{ state: "needs_reconciliation", lease_token: null }]);
  });
});

describe("Naming lookup work as unrelated history grows (disposable plans)", () => {
  it("keeps target buffer work bounded for all four current lookup shapes", async () => {
    const result = await benchmarkNamingRunIndexes([1_000, 10_000]);
    for (const samples of Object.values(result.samples)) {
      for (const sample of samples) {
        const nodes = lookupNodes(sample.after.Plan);
        expect(sample.equalResults).toBe(true);
        expect(nodes.some(node => node["Node Type"].includes("Index"))).toBe(true);
        expect(nodes.some(node => node["Node Type"] === "Seq Scan")).toBe(false);
        expect(lookupBuffers(sample.after.Plan)).toBeLessThanOrEqual(32);
      }
      expect(lookupBuffers(samples.at(-1)!.after.Plan)).toBeLessThanOrEqual(lookupBuffers(samples[0]!.after.Plan) + 8);
      expect(lookupBuffers(samples.at(-1)!.before.Plan)).toBeGreaterThan(lookupBuffers(samples.at(-1)!.after.Plan) * 3);
    }
  }, 60_000);
});
