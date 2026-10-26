import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Client } from "pg";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { installBrainFixture } from "./naming-brain-fixture";
import { seedProgressiveFixture, saveProgressiveResearch } from "./naming-brain-progressive-fixture";
import { createReceiptNativeFixture, receiptNativeConfigPath } from "./naming-receipt-native-fixture";

describe.skipIf(!receiptNativeConfigPath)("receipt counters on explicit disposable native PostgreSQL18", () => {
  let native: Awaited<ReturnType<typeof createReceiptNativeFixture>>, left: Client, right: Client;
  let f: Awaited<ReturnType<typeof seedProgressiveFixture>>, base: Awaited<ReturnType<typeof saveProgressiveResearch>>["providerReceipt"];
  let walStart: string;
  let backendPids: number[];
  const measurements: { test: string; walBytes: number }[] = [];
  beforeAll(async () => {
    native = await createReceiptNativeFixture(); await installBrainFixture(native.db);
    left = await native.connectWorker(); right = await native.connectWorker();
    backendPids = await Promise.all([left, right].map(async client => (await client.query("select pg_backend_pid() pid")).rows[0].pid));
    expect(new Set(backendPids).size).toBe(2);
  }, 120_000);
  beforeEach(async () => {
    f = await seedProgressiveFixture(native.db); base = (await saveProgressiveResearch(f)).providerReceipt;
    walStart = (await native.setup.query("select pg_current_wal_insert_lsn()::text lsn")).rows[0].lsn;
  }, 30_000);
  afterEach(async context => {
    if (!native) return;
    await Promise.all([native.setup.query("rollback"), left?.query("rollback"), right?.query("rollback")]);
    if (walStart) measurements.push({ test: context.task.name,
      walBytes: Number((await native.setup.query("select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn)::text bytes", [walStart])).rows[0].bytes) });
    await mkdir(new URL("../../.tmp/", import.meta.url), { recursive: true });
    await writeFile(new URL(`../../.tmp/native-receipt-metrics-${native.database}.json`, import.meta.url), JSON.stringify({ engine: "native PostgreSQL18", version: native.version, backendPids, measurements }, null, 2));
  });
  afterAll(async () => { await native?.close(); }, 30_000);
  const check = async (count: number) => {
    const result = (await native.setup.query(`select t.receipt_count::integer count,t.receipt_bytes::bigint bytes,
      (select count(*)::integer from fluid_private.naming_brain_receipts where run_id=$1) actual_count,
      (select sum(octet_length(receipt::text))::bigint from fluid_private.naming_brain_receipts where run_id=$1) actual_bytes
      from fluid_private.naming_brain_receipt_totals t where run_id=$1`, [f.input.runId])).rows[0];
    expect(result.count).toBe(count); expect(result.actual_count).toBe(count); expect(result.bytes).toBe(result.actual_bytes);
  };
  const save = (client: Client, estimate: number) => new NamingBrainJobStore(client, "fixture-deployment")
    .recordReceipt(f.job, { ...base, estimatedCostMicrousd: estimate, recordedAt: "2026-10-26T01:00:00Z" });
  const blocked = async (pending: Promise<unknown>) => expect(await Promise.race([
    pending.then(() => "settled", () => "rejected"), new Promise<string>(resolve => setTimeout(() => resolve("blocked"), 75)),
  ])).toBe("blocked");
  const advisoryWaiters = async () => {
    const waiting = (await native.setup.query("select pid,wait_event_type,wait_event from pg_stat_activity where pid=any($1::integer[]) order by pid", [backendPids])).rows;
    expect(waiting).toHaveLength(2);
    for (const row of waiting) expect(row).toMatchObject({ wait_event_type: "Lock", wait_event: "advisory" });
  };

  it("concurrent identical receipts retain one new row and one increment", async () => {
    await native.setup.query("begin"); await native.setup.query("select fluid_private.lock_strategy_owner($1)", [f.job.ownerId]);
    const one = save(left, 1), two = save(right, 1);
    await blocked(one); await blocked(two); await advisoryWaiters(); await native.setup.query("commit");
    const [a, b] = await Promise.all([one, two]); expect(a).toEqual(b); await check(2);
  });

  it("distinct concurrent near-capacity receipts cannot exceed5000", async () => {
    await native.setup.query(`with base as(select * from fluid_private.naming_brain_receipts where run_id=$1 limit 1),
      numbered as(select base.*,base.receipt||jsonb_build_object('recordedAt',to_char(timestamptz '2026-10-20T00:00:00Z'+n*interval '1 millisecond','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) next
      from base cross join generate_series(2,4999) n)
      insert into fluid_private.naming_brain_receipts(run_id,owner_id,project_id,stage_key,call_key,receipt,content_hash)
      select run_id,owner_id,project_id,stage_key,call_key,next,encode(sha256(convert_to(next::text,'UTF8')),'hex') from numbered`, [f.input.runId]);
    await native.setup.query("begin"); await native.setup.query("select fluid_private.lock_strategy_owner($1)", [f.job.ownerId]);
    const one = save(left, 1), two = save(right, 2);
    const settled = Promise.allSettled([one, two]); await blocked(one); await blocked(two); await advisoryWaiters(); await native.setup.query("commit");
    const results = await settled; expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")?.reason).toMatchObject({ code: "22023", message: "receipt_capacity" });
    await check(5000);
  });

  it("a rollback releases capacity and the current pointer for another backend", async () => {
    await left.query("begin"); await save(left, 1);
    const pending = save(right, 2); await blocked(pending); await left.query("rollback");
    await pending; await check(2);
    const saved = (await native.setup.query(`select q.receipt from fluid_private.naming_brain_receipt_current c
      join fluid_private.naming_brain_receipts q on q.id=c.receipt_id where c.run_id=$1`, [f.input.runId])).rows[0].receipt;
    expect(saved.estimatedCostMicrousd).toBe(2);
  });

  it("locked lazy backfill and a waiting writer count all retained history exactly once", async () => {
    await native.setup.query("delete from fluid_private.naming_brain_receipt_totals where run_id=$1", [f.input.runId]);
    await native.setup.query("begin"); await native.setup.query("select fluid_private.lock_strategy_owner($1)", [f.job.ownerId]);
    await native.setup.query("select id from fluid_private.naming_brain_runs where id=$1 for update", [f.input.runId]);
    await native.setup.query("select fluid_private.ensure_naming_brain_receipt_totals($1)", [f.input.runId]);
    const pending = save(left, 1); await blocked(pending); await native.setup.query("commit");
    await pending; await check(2);
  });

  it("a lost committed acknowledgement retried by another backend adds no row", async () => {
    const first = await save(left, 1); // Deliberately discard the transport acknowledgement.
    const retry = await new NamingBrainJobStore(right, "fixture-deployment").recordReceipt(f.job,
      { ...first, recordedAt: "2026-10-26T02:00:00Z" });
    expect(retry).toEqual(first); await check(2);
  });
});
