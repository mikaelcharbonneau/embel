import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingProviderReceiptSchema, type NamingProviderReceipt } from "../../src/domain/naming-brain";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { createTestDatabase, OWNER_B, type TestDatabase } from "./local-supabase";
import { brainWorker, installBrainFixture } from "./naming-brain-fixture";
import { progressiveRequest, seedProgressiveFixture } from "./naming-brain-progressive-fixture";

const filename = "20261026153000_naming_receipt_semantic_state.sql";
const migration = await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8");
type Fixture = Awaited<ReturnType<typeof seedProgressiveFixture>>;
async function authorizedReceipt(f: Fixture) {
  const request = progressiveRequest(f, "context.research", { role: "researcher", snapshot: f.input.snapshot });
  await brainWorker(f.db, () => f.store.saveProgressiveCallPlan(f.job, "context.research", [request]));
  await brainWorker(f.db, () => f.store.authorizeDispatch(f.job, request));
  return namingProviderReceiptSchema.parse({ version: 1, provider: "openai", billingMode: "openai_api", protocol: "openai_agents",
    budgetControl: "local_unlimited_v1", localPipelineVersion: 2, runId: f.input.runId, stageKey: "creation", role: "researcher",
    snapshotHash: f.input.snapshot.snapshotHash, providerCallKey: request.providerCallKey, assignmentKey: null,
    requestKey: request.requestKey, requestHash: request.requestHash, sessionLimitCents: request.policy.sessionLimitCents,
    dispatchState: "dispatched", requestId: null, sessionId: "sess_receipt_state", turnId: "turn_receipt_state", agentId: "agent_receipt_state", responseId: null,
    callIds: [], observedModel: f.input.policy.model, toolCalls: [], artifactItemIds: [], usageObservations: [], estimatedCostMicrousd: null,
    providerCostCounters: [], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-26T00:00:00Z" });
}
async function totals(db: TestDatabase, runId: string) {
  return (await db.query<{ receipt_count: number; receipt_bytes: number; actual_count: number; actual_bytes: number }>(`select
    t.receipt_count::integer,t.receipt_bytes::integer,
    (select count(*)::integer from fluid_private.naming_brain_receipts where run_id=$1) actual_count,
    (select coalesce(sum(octet_length(receipt::text)),0)::integer from fluid_private.naming_brain_receipts where run_id=$1) actual_bytes
    from fluid_private.naming_brain_receipt_totals t where run_id=$1`, [runId])).rows[0]!;
}
async function current(db: TestDatabase, runId: string) {
  return (await db.query<{ receipt: NamingProviderReceipt }>(`select q.receipt from fluid_private.naming_brain_receipt_current c
    join fluid_private.naming_brain_receipts q on q.id=c.receipt_id where c.run_id=$1`, [runId])).rows[0]!.receipt;
}
async function fillHistory(f: Fixture, count: number) {
  await f.db.query(`with base as(select * from fluid_private.naming_brain_receipts where run_id=$1 limit 1),
    numbered as(select base.*,base.receipt||jsonb_build_object('recordedAt',to_char(timestamptz '2026-10-20T00:00:00Z'+n*interval '1 millisecond','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) next
    from base cross join generate_series(2,$2::integer) n)
    insert into fluid_private.naming_brain_receipts(run_id,owner_id,project_id,stage_key,call_key,receipt,content_hash)
    select run_id,owner_id,project_id,stage_key,call_key,next,encode(sha256(convert_to(next::text,'UTF8')),'hex') from numbered`, [f.input.runId, count]);
}

describe("Naming receipt state over fully migrated restricted SQL", () => {
  let db: TestDatabase, f: Fixture, base: NamingProviderReceipt;
  beforeAll(async () => { db = await createTestDatabase(); await installBrainFixture(db); }, 60_000);
  beforeEach(async () => { f = await seedProgressiveFixture(db); base = await authorizedReceipt(f); }, 30_000);
  afterAll(async () => { await db?.close(); });
  const save = (value: NamingProviderReceipt, store?: NamingBrainJobStore) => brainWorker(db, () => (store ?? f.store).recordReceipt(f.job, value));

  it("returns the acknowledged timestamp for 1000 timestamp-only observations, including a fresh store", async () => {
    const first = await save(base), fresh = new NamingBrainJobStore(db, "fixture-deployment");
    await brainWorker(db, async () => {
      for (let i = 0; i < 1000; i++) expect(await fresh.recordReceipt(f.job,
        { ...base, recordedAt: new Date(Date.UTC(2026, 9, 26, 1, 0, 0, i)).toISOString() })).toEqual(first);
    });
    const measured = await totals(db, f.input.runId);
    expect(measured.receipt_count).toBe(1); expect(measured.receipt_count).toBe(measured.actual_count);
    expect(measured.receipt_bytes).toBe(measured.actual_bytes); expect(await current(db, f.input.runId)).toEqual(first);
  }, 30_000);

  it.each([
    ["request identity observation", { requestId: "req_é_🧪" }],
    ["dispatch state", { dispatchState: "unknown" }],
    ["call IDs", { callIds: ["call_one"] }],
    ["artifact IDs", { artifactItemIds: ["item_one"] }],
    ["tool state", { toolCalls: [{ callId: "tool_one", type: "web_search", providerItemId: "item_tool", status: "started" }] }],
    ["usage facts", { usageObservations: [{ scope: "session", scopeId: "sess_receipt_state", inputTokens: 2, outputTokens: 1, totalTokens: 3, observedAt: "2026-10-26T00:00:00Z" }] }],
    ["estimated usage", { estimatedCostMicrousd: 1 }],
    ["observed counters", { providerCostCounters: [{ scope: "session", scopeId: "sess_receipt_state", kind: "consumed_usd_cents", value: 1, observedAt: "2026-10-26T00:00:00Z" }] }],
  ])("retains changed %s even at the same observation timestamp", async (_label, change) => {
    await save(base); const changed = namingProviderReceiptSchema.parse({ ...base, ...change });
    expect(await save(changed)).toEqual(changed);
    expect(await current(db, f.input.runId)).toEqual(changed);
    const measured = await totals(db, f.input.runId);
    expect(measured.receipt_count).toBe(2); expect(measured.receipt_bytes).toBe(measured.actual_bytes);
  });

  it("uses insertion order after clock ties/regression and preserves an A -> B -> A dispatch transition", async () => {
    await save(base); const changed = { ...base, dispatchState: "unknown" as const, recordedAt: "2026-10-25T23:00:00Z" };
    // Emulate a backwards database clock on the new insertion only. Existing
    // immutable receipt rows are never updated, even in this fixture.
    await db.exec(`create function public.synthetic_receipt_clock() returns trigger language plpgsql as $$ begin NEW.created_at:='2026-10-20T00:00:00Z'; return NEW; end $$;
      create trigger synthetic_receipt_clock before insert on fluid_private.naming_brain_receipts for each row execute function public.synthetic_receipt_clock();`);
    try { await save(changed); }
    finally { await db.exec("drop trigger synthetic_receipt_clock on fluid_private.naming_brain_receipts; drop function public.synthetic_receipt_clock()"); }
    expect(await save({ ...changed, recordedAt: "2026-10-26T01:00:00Z" })).toEqual(changed);
    const restored = { ...base, recordedAt: "2026-10-26T02:00:00Z" };
    await save(restored); expect(await current(db, f.input.runId)).toEqual(restored);
    expect((await totals(db, f.input.runId)).receipt_count).toBe(3);
  });

  it("acknowledges exact old replay but rejects a newly timestamped snapshot that erases usage", async () => {
    await save(base);
    const changed = namingProviderReceiptSchema.parse({ ...base, usageObservations: [{ scope: "session", scopeId: base.sessionId,
      inputTokens: 2, outputTokens: 1, totalTokens: 3, observedAt: base.recordedAt }] });
    await save(changed); expect(await save(base)).toEqual(base);
    await expect(save({ ...base, recordedAt: "2026-10-26T02:00:00Z" })).rejects.toThrow("receipt_observation_regressed");
    expect(await current(db, f.input.runId)).toEqual(changed);
    expect((await totals(db, f.input.runId)).receipt_count).toBe(2);
  });

  it("preserves completed tool facts while accepting started -> completed", async () => {
    const started = namingProviderReceiptSchema.parse({ ...base, toolCalls: [{ callId: "tool", type: "web_search", providerItemId: "item", status: "started" }] });
    await save(started);
    const completed = namingProviderReceiptSchema.parse({ ...started, toolCalls: [{ ...started.toolCalls[0], status: "completed" }] });
    await save(completed);
    await expect(save({ ...started, recordedAt: "2026-10-26T02:00:00Z" })).rejects.toThrow("receipt_observation_regressed");
    expect(await current(db, f.input.runId)).toEqual(completed);
  });

  it("retries an uncertain committed acknowledgment in a fresh store without another insert", async () => {
    let lose = true;
    const uncertain = new NamingBrainJobStore({ query: async (sql, values) => {
      const response = await db.query<Record<string, unknown>>(sql, values);
      if (lose && sql.includes("record_naming_brain_provider_receipt")) { lose = false; throw Object.assign(new Error("synthetic lost acknowledgement"), { code: "08006" }); }
      return response;
    } }, "fixture-deployment");
    await expect(save(base, uncertain)).rejects.toThrow("synthetic lost acknowledgement");
    const fresh = new NamingBrainJobStore(db, "fixture-deployment");
    expect(await save({ ...base, recordedAt: "2026-10-26T02:00:00Z" }, fresh)).toEqual(base);
    expect((await totals(db, f.input.runId)).receipt_count).toBe(1);
  });

  it("rolls back receipt, totals and current projection when an after-insert failure occurs", async () => {
    await save(base); const before = await totals(db, f.input.runId);
    await db.exec(`create function public.synthetic_receipt_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic_after_insert'; end $$;
      create trigger zzz_synthetic_receipt_failure after insert on fluid_private.naming_brain_receipts for each row execute function public.synthetic_receipt_failure();`);
    try { await expect(save({ ...base, estimatedCostMicrousd: 1 })).rejects.toThrow("synthetic_after_insert"); }
    finally { await db.exec("drop trigger zzz_synthetic_receipt_failure on fluid_private.naming_brain_receipts; drop function public.synthetic_receipt_failure()"); }
    expect(await totals(db, f.input.runId)).toEqual(before); expect(await current(db, f.input.runId)).toEqual(base);
    await save({ ...base, estimatedCostMicrousd: 1 }); expect((await totals(db, f.input.runId)).receipt_count).toBe(2);
  });

  it("keeps queued PGlite calls/capacity exact; this is not a native concurrent-backend test", async () => {
    await save(base); await fillHistory(f, 4999);
    const results = await brainWorker(db, () => Promise.allSettled([
      f.store.recordReceipt(f.job, { ...base, estimatedCostMicrousd: 1 }),
      f.store.recordReceipt(f.job, { ...base, estimatedCostMicrousd: 2 }),
    ]));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const measured = await totals(db, f.input.runId);
    expect(measured.receipt_count).toBe(5000); expect(measured.receipt_count).toBe(measured.actual_count);
    expect(measured.receipt_bytes).toBe(measured.actual_bytes);
    const canonical = await current(db, f.input.runId);
    expect(await save({ ...canonical, recordedAt: "2026-10-26T02:00:00Z" })).toEqual(canonical);
  }, 30_000);

  it("does not grant worker access to counters or bypass lease/owner/request binding", async () => {
    await save(base);
    await expect(brainWorker(db, () => db.query("select * from fluid_private.naming_brain_receipt_totals"))).rejects.toThrow();
    await expect(brainWorker(db, () => db.query("select fluid_private.ensure_naming_brain_receipt_totals($1)", [f.input.runId]))).rejects.toThrow();
    await expect(brainWorker(db, () => f.store.recordReceipt({ ...f.job, leaseToken: crypto.randomUUID() }, base))).rejects.toThrow("lease_lost");
    await expect(brainWorker(db, () => f.store.recordReceipt(f.job, base), OWNER_B)).rejects.toThrow();
    await expect(save({ ...base, requestHash: "f".repeat(64) })).rejects.toThrow("receipt_mismatch");
    expect((await totals(db, f.input.runId)).receipt_count).toBe(1);
  });
});

it("lazily backfills historical retained bytes without changing rows, hashes or public function security", async () => {
  const db = await createTestDatabase({ before: filename });
  try {
    await installBrainFixture(db); const f = await seedProgressiveFixture(db), receipt = await authorizedReceipt(f);
    await brainWorker(db, () => f.store.recordReceipt(f.job, receipt)); await fillHistory(f, 20);
    const digest = async () => (await db.query(`select md5(jsonb_agg(to_jsonb(q) order by q.id)::text) digest from fluid_private.naming_brain_receipts q where run_id=$1`, [f.input.runId])).rows;
    const security = async () => (await db.query(`select oid,proowner,proacl::text,prosecdef,provolatile,proconfig,proleakproof from pg_proc where oid='public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)'::regprocedure`)).rows;
    const before = await digest(), metadata = await security(); await db.exec(migration);
    expect(await digest()).toEqual(before); expect(await security()).toEqual(metadata);
    expect((await db.query("select * from fluid_private.naming_brain_receipt_totals")).rows).toHaveLength(0);
    await brainWorker(db, () => f.store.recordReceipt(f.job, { ...receipt, estimatedCostMicrousd: 1 }));
    const measured = await totals(db, f.input.runId);
    expect(measured.receipt_count).toBe(21); expect(measured.receipt_count).toBe(measured.actual_count);
    expect(measured.receipt_bytes).toBe(measured.actual_bytes);
  } finally { await db.close(); }
}, 60_000);

it("removes hostile default privileges from every new private projection/helper", async () => {
  const db = await createTestDatabase({ beforeMigration: async (database, sql) => {
    if (!sql.includes("unexpected_naming_receipt_state_predecessor")) return;
    await database.exec(`create role receipt_hostile_fixture nologin;
      alter default privileges in schema fluid_private grant all on tables to receipt_hostile_fixture;
      alter default privileges in schema fluid_private grant execute on functions to receipt_hostile_fixture;`);
  } });
  try {
    for (const table of ["naming_brain_receipt_totals", "naming_brain_receipt_current"]) {
      const result = await db.query<{ denied: boolean; rls: boolean; forced: boolean }>(`select not has_table_privilege('receipt_hostile_fixture',c.oid,'select,insert,update,delete') denied,
        c.relrowsecurity rls,c.relforcerowsecurity forced from pg_class c where c.oid=$1::regclass`, [`fluid_private.${table}`]);
      expect(result.rows).toEqual([{ denied: true, rls: true, forced: true }]);
    }
    for (const signature of ["ensure_naming_brain_receipt_totals(uuid)", "track_naming_brain_receipt_totals()", "latest_naming_brain_receipt(uuid,text,text)"]) {
      expect((await db.query("select has_function_privilege('receipt_hostile_fixture',$1,'execute') allowed", [`fluid_private.${signature}`])).rows).toEqual([{ allowed: false }]);
    }
  } finally { await db.close(); }
}, 60_000);

it("rejects predecessor drift transactionally before installing any new projection", async () => {
  const db = await createTestDatabase({ before: filename });
  try {
    await db.exec(`create or replace function public.record_naming_brain_provider_receipt(p_job_id uuid,p_lease_token uuid,p_receipt jsonb) returns jsonb language sql security definer set search_path='' as $$ select null::jsonb $$`);
    await expect(db.exec(migration)).rejects.toThrow("unexpected_naming_receipt_state_predecessor");
    await db.exec("rollback");
    expect((await db.query("select to_regclass('fluid_private.naming_brain_receipt_totals') totals,to_regclass('fluid_private.naming_brain_receipt_current') current")).rows).toEqual([{ totals: null, current: null }]);
  } finally { await db.close(); }
}, 60_000);
