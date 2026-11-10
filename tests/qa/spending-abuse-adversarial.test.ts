import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";

// Pre-launch abuse test (docs/architecture-review.md, M3 "Before launch: an abuse test").
// User A is a script holding only its own login, calling the database functions and tables
// the way PostgREST would. Every attempt to spend beyond A's credits, limits or the global
// cap, or to touch user B, must be refused, and the ledgers must not move.
//
// Real greenfield migrations in PGlite with emulated Auth claims. One connection: the
// parallel races run against real Postgres in tests/qa/abuse-local-stack.test.ts.

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.exec("insert into storage.buckets(id, name) values('fluid-assets','fluid-assets') on conflict do nothing");
}, 180_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await resetFixture(db);
  await db.exec("truncate fluid_private.deleted_account_usage, fluid_private.account_deletion_receipts, fluid_private.account_export_requests, public.credit_entries, public.credit_accounts cascade");
  await db.exec("update fluid_private.engine_settings set paused = false, global_daily_cost_cap_microusd = 50000000");
  await db.exec("delete from fluid_private.generation_kinds where kind like 'test.%'");
  // Free plan: 30 credits a month.
  await db.exec(`insert into fluid_private.generation_kinds (kind, credits, enabled, max_per_day) values
    ('test.seven', 7, true, 50), ('test.twice', 0, true, 2), ('test.loop', 7, true, 3), ('test.free', 0, true, 50)`);
});

type Failure = { message: string; code?: string };
async function failure(run: () => Promise<unknown>): Promise<Failure> {
  try { await run(); } catch (error) { return error as Failure; }
  throw new Error("Expected a failure");
}
type Run = { id: string; owner_id: string; project_id: string; kind: string; status: string; credits: number };
const key = (label: string) => `abuse-${label}-${randomUUID()}`;
const as = <T>(owner: string | null, run: () => Promise<T>) => asRole(db, "authenticated", owner, run);
const start = (owner: string, project: string, kind: string, idempotencyKey = key(kind), input: unknown = {}) => as(owner, async () =>
  (await db.query<Run>("select * from public.start_generation($1, $2, $3, $4::jsonb)", [project, kind, idempotencyKey, JSON.stringify(input)])).rows[0]!);
const cancel = (owner: string, run: string) => as(owner, async () => (await db.query<Run>("select * from public.cancel_generation($1)", [run])).rows[0]!);
/** The ledger as the database owner sees it, not as the attacker would like it. */
async function ledger(owner: string) {
  const { rows } = await db.query<{ balance: number; charges: number; refunds: number; grants: number }>(`
    select coalesce(sum(delta), 0)::int as balance, count(*) filter (where kind = 'charge')::int as charges,
           count(*) filter (where kind = 'refund')::int as refunds, count(*) filter (where kind in ('grant', 'adjustment'))::int as grants
      from public.credit_entries where owner_id = $1`, [owner]);
  return rows[0]!;
}
async function runCount(owner?: string) {
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.generation_runs where $1::uuid is null or owner_id = $1", [owner ?? null]);
  return rows[0]!.n;
}
async function spend() {
  return (await db.query<{ n: string }>("select coalesce(sum(cost_microusd), 0)::text as n from public.generation_outputs")).rows[0]!.n;
}
/** What the engine login does for a paid run: claim it, record provider cost, finish it. */
async function engineSpend(run: string, cost: number) {
  await db.query("select fluid_private.engine_claim($1, $2)", [run, `wrun_${run.slice(0, 8)}`]);
  await db.query("select fluid_private.engine_save_output($1, 'echo', '{\"ok\":true}'::jsonb, null, $2)", [run, cost]);
  await db.query("select fluid_private.engine_finish($1, 'succeeded', null)", [run]);
}
async function projects(owner: string, count: number) {
  const ids: string[] = [];
  for (let n = 0; n < count; n++) ids.push((await seedProject(db, owner)).id);
  return ids;
}

describe("a script with its own login cannot spend beyond its credits and limits", () => {
  it("stops at the credit balance and never lets the balance go below zero", async () => {
    const own = await projects(OWNER_A, 6);
    const admitted: Run[] = [], refused: Failure[] = [];
    for (const project of own) {
      try { admitted.push(await start(OWNER_A, project, "test.seven")); } catch (error) { refused.push(error as Failure); }
    }
    expect(admitted).toHaveLength(4);
    expect(refused.map(error => [error.message, error.code])).toEqual([["insufficient_credits", "PT402"], ["insufficient_credits", "PT402"]]);
    expect(await ledger(OWNER_A)).toEqual({ balance: 2, charges: 4, refunds: 0, grants: 1 });
    expect(await runCount(OWNER_A)).toBe(4);
  });

  it("charges a replayed idempotency key once and refuses a replay that changes the project or kind", async () => {
    const [first, second] = await projects(OWNER_A, 2);
    const k = key("replay");
    const runs = [];
    for (let n = 0; n < 5; n++) runs.push(await start(OWNER_A, first!, "test.seven", k));
    expect(new Set(runs.map(run => run.id)).size).toBe(1);
    expect((await failure(() => start(OWNER_A, second!, "test.seven", k))).message).toBe("idempotency_conflict");
    expect((await failure(() => start(OWNER_A, first!, "test.free", k))).message).toBe("idempotency_conflict");
    expect(await ledger(OWNER_A)).toMatchObject({ balance: 23, charges: 1 });
    // B choosing the same key gets its own run; A's is untouched.
    const [theirs] = await projects(OWNER_B, 1);
    expect((await start(OWNER_B, theirs!, "test.seven", k)).owner_id).toBe(OWNER_B);
    expect(await ledger(OWNER_A)).toMatchObject({ balance: 23, charges: 1 });
  });

  it("counts cancelled and refunded admissions toward the daily limit, and refunds each run once", async () => {
    const [project] = await projects(OWNER_A, 1);
    for (let n = 0; n < 3; n++) {
      const run = await start(OWNER_A, project!, "test.loop");
      expect((await cancel(OWNER_A, run.id)).status).toBe("cancelled");
      // A second Stop changes nothing and refunds nothing.
      expect((await cancel(OWNER_A, run.id)).status).toBe("cancelled");
    }
    expect(await failure(() => start(OWNER_A, project!, "test.loop"))).toMatchObject({ message: "daily_limit", code: "PT429" });
    expect(await ledger(OWNER_A)).toEqual({ balance: 30, charges: 3, refunds: 3, grants: 1 });
    // A zero-credit kind is held by its daily limit alone, across projects.
    const others = await projects(OWNER_A, 3);
    await start(OWNER_A, others[0]!, "test.twice");
    await start(OWNER_A, others[1]!, "test.twice");
    expect(await failure(() => start(OWNER_A, others[2]!, "test.twice"))).toMatchObject({ message: "daily_limit", code: "PT429" });
  });

  it("refuses forged, negative and oversized parameters before charging anything", async () => {
    const [project] = await projects(OWNER_A, 1);
    const attempts: [string, unknown[], string][] = [
      ["input over 64 KiB", [project, "test.seven", key("big"), JSON.stringify({ text: "x".repeat(70_000) })], "invalid_input"],
      ["input that is an array", [project, "test.seven", key("array"), "[]"], "invalid_input"],
      ["input that is a number", [project, "test.seven", key("number"), "-1"], "invalid_input"],
      ["null input", [project, "test.seven", key("null"), null], "invalid_input"],
      ["short key", [project, "test.seven", "short", "{}"], "invalid_input"],
      ["oversized key", [project, "test.seven", "k".repeat(129), "{}"], "invalid_input"],
      ["key with SQL", [project, "test.seven", "x'); delete from public.credit_entries; --", "{}"], "invalid_input"],
      ["null key", [project, "test.seven", null, "{}"], "invalid_input"],
      ["null project", [null, "test.seven", key("noproject"), "{}"], "invalid_input"],
      ["unknown project", [randomUUID(), "test.seven", key("unknown"), "{}"], "not_found"],
      ["unknown kind", [project, "test.unknown", key("kind"), "{}"], "generation_unavailable"],
      ["kind in other case", [project, "TEST.SEVEN", key("case"), "{}"], "generation_unavailable"],
      ["empty kind", [project, "", key("empty"), "{}"], "generation_unavailable"],
      ["null kind", [project, null, key("nullkind"), "{}"], "invalid_input"],
      ["switched-off kind", [project, "strategy.audience", key("off"), "{}"], "generation_unavailable"],
    ];
    for (const [label, params, message] of attempts) {
      const error = await failure(() => as(OWNER_A, () => db.query("select public.start_generation($1, $2, $3, $4::jsonb)", params)));
      expect(error.message, label).toBe(message);
    }
    // There is no price, owner or plan parameter to forge: PostgREST would find no function.
    for (const extra of ["p_credits => -100", `p_owner => '${OWNER_B}'::uuid`, "p_cost => 0", "p_plan => 'studio'"]) {
      const error = await failure(() => as(OWNER_A, () => db.query(
        `select public.start_generation(p_project_id => $1, p_kind => 'test.seven', p_idempotency_key => $2, p_input => '{}'::jsonb, ${extra})`, [project, key("extra")])));
      expect(error.code, extra).toBe("42883");
    }
    expect(await runCount()).toBe(0);
    expect((await ledger(OWNER_A)).charges).toBe(0);
    // Prices and owners written into the input are just input: the run is still A's, at full price.
    const forged = await start(OWNER_A, project!, "test.seven", key("forged"), { credits: -100, ownerId: OWNER_B, costMicrousd: 0, plan: "studio" });
    expect(forged).toMatchObject({ owner_id: OWNER_A, credits: 7 });
    expect(await ledger(OWNER_A)).toMatchObject({ balance: 23, charges: 1 });
    expect(await ledger(OWNER_B)).toEqual({ balance: 0, charges: 0, refunds: 0, grants: 0 });
  });

  it("refuses another owner's project and the caller's own project once deletion was requested", async () => {
    const [theirs] = await projects(OWNER_B, 1);
    expect((await failure(() => start(OWNER_A, theirs!, "test.seven"))).message).toBe("not_found");
    const [mine] = await projects(OWNER_A, 1);
    const p = (await db.query<{ current_revision: number; lifecycle_version: number }>("select current_revision, lifecycle_version from public.projects where id = $1", [mine])).rows[0]!;
    await as(OWNER_A, () => db.query("select public.request_project_deletion($1, $2, $3)", [mine, p.current_revision, p.lifecycle_version]));
    expect((await failure(() => start(OWNER_A, mine!, "test.seven"))).message).toBe("not_found");
    expect(await runCount()).toBe(0);
    expect(await ledger(OWNER_B)).toMatchObject({ charges: 0 });
  });

  it("stops new work while the engine is paused or the global daily cost cap is reached", async () => {
    const [mine] = await projects(OWNER_A, 1), [theirs] = await projects(OWNER_B, 1);
    await db.exec("update fluid_private.engine_settings set paused = true");
    expect((await failure(() => start(OWNER_A, mine!, "test.free"))).message).toBe("generation_paused");
    await db.exec("update fluid_private.engine_settings set paused = false, global_daily_cost_cap_microusd = 1000");
    // B's spend counts toward the cap A is held by.
    await engineSpend((await start(OWNER_B, theirs!, "test.seven")).id, 1500);
    expect((await failure(() => start(OWNER_A, mine!, "test.seven"))).message).toBe("generation_paused");
    expect(await ledger(OWNER_A)).toMatchObject({ charges: 0 });
  });

  // The hole this test found (supabase/migrations/20261110210000_global_cap_counts_deleted_accounts.sql):
  // deleting an account removed its outputs, and with them its spend, from the global cap.
  it("keeps counting a deleted account's spend toward the global daily cost cap", async () => {
    await db.exec("update fluid_private.engine_settings set global_daily_cost_cap_microusd = 1000");
    const [theirs] = await projects(OWNER_B, 1), [mine] = await projects(OWNER_A, 1);
    await engineSpend((await start(OWNER_B, theirs!, "test.seven")).id, 1500);
    await asRole(db, "service_role", null, async () => {
      await db.query("select public.account_deletion_begin($1)", [OWNER_B]);
      await db.query("select public.account_deletion_purge($1)", [OWNER_B]);
    });
    expect(await spend()).toBe("0");
    expect((await db.query("select sum(cost_microusd)::int as n from fluid_private.deleted_account_usage where source = 'generation_run'")).rows).toEqual([{ n: 1500 }]);
    expect((await failure(() => start(OWNER_A, mine!, "test.seven"))).message).toBe("generation_paused");
    // A day later the deleted account's spend no longer counts, like anyone else's.
    await db.exec("update fluid_private.deleted_account_usage set occurred_at = occurred_at - interval '25 hours'");
    expect(await start(OWNER_A, mine!, "test.seven")).toMatchObject({ owner_id: OWNER_A, credits: 7 });
  });

  it("cannot cancel another owner's run, so it cannot trigger their refund", async () => {
    const [theirs] = await projects(OWNER_B, 1);
    const run = await start(OWNER_B, theirs!, "test.seven");
    expect(await failure(() => cancel(OWNER_A, run.id))).toMatchObject({ message: "not_found", code: "P0002" });
    expect(await ledger(OWNER_B)).toEqual({ balance: 23, charges: 1, refunds: 0, grants: 1 });
    expect((await db.query("select status, cancel_requested_at from public.generation_runs where id = $1", [run.id])).rows).toEqual([{ status: "queued", cancel_requested_at: null }]);
  });
});

describe("a script cannot reach the engine, credit or deletion functions", () => {
  it("is refused every engine and credit function, whatever its arguments", async () => {
    const [theirs] = await projects(OWNER_B, 1);
    const run = await start(OWNER_B, theirs!, "test.seven");
    const before = { a: await ledger(OWNER_A), b: await ledger(OWNER_B), spend: await spend() };
    const privateFunctions = (await db.query<{ signature: string; nargs: number; types: string }>(`
      select p.oid::regprocedure::text as signature, p.pronargs as nargs, oidvectortypes(p.proargtypes) as types
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'fluid_private' and p.prokind = 'f'
         and (p.proname like 'engine\\_%' or p.proname in ('finish_generation_run', 'expire_overdue_generation_runs', 'ensure_credit_period', 'credit_balance'))
       order by 1`)).rows;
    expect(privateFunctions.map(f => f.signature)).toEqual(expect.arrayContaining([
      "fluid_private.engine_claim(uuid,text)", "fluid_private.engine_finish(uuid,text,text)", "fluid_private.engine_save_output(uuid,text,jsonb,text,bigint)",
      "fluid_private.finish_generation_run(uuid,text,text)", "fluid_private.ensure_credit_period(uuid)", "fluid_private.credit_balance(uuid)",
    ]));
    // Arguments aimed at B's run and account: the run id for uuids, a plausible value elsewhere.
    const argument = (type: string) => type === "uuid" ? `'${run.id}'::uuid` : type === "text" ? "'succeeded'" : type === "jsonb" ? "'{}'::jsonb"
      : type === "bigint" || type === "integer" ? "-1000000" : type === "boolean" ? "true" : `null::${type}`;
    for (const role of ["authenticated", "anon"] as const) {
      await asRole(db, role, role === "authenticated" ? OWNER_A : null, async () => {
        for (const fn of privateFunctions) {
          const args = fn.types ? fn.types.split(", ").map(argument).join(", ") : "";
          const name = fn.signature.slice(0, fn.signature.indexOf("("));
          expect(await failure(() => db.query(`select ${name}(${args})`)), `${role} ${fn.signature}`).toMatchObject({ code: "42501" });
        }
        for (const sql of [
          `select public.account_deletion_begin('${OWNER_B}')`, `select public.account_deletion_purge('${OWNER_B}')`,
          `select * from public.account_storage_objects('${OWNER_B}', null, 1000)`, `select public.account_deletion_files_removed('${OWNER_B}', -5)`,
          `select public.account_deletion_complete('${OWNER_B}')`, "select * from public.account_deletions_pending('0 seconds', 100)",
          "select * from public.orphaned_storage_objects(null, 1000)",
        ]) expect(await failure(() => db.query(sql)), `${role} ${sql}`).toMatchObject({ code: "42501" });
      });
    }
    expect({ a: await ledger(OWNER_A), b: await ledger(OWNER_B), spend: await spend() }).toEqual(before);
    expect((await db.query("select status from public.generation_runs where id = $1", [run.id])).rows).toEqual([{ status: "queued" }]);
    expect((await db.query("select count(*)::int as n from fluid_private.account_deletion_receipts")).rows).toEqual([{ n: 0 }]);
  });

  it("cannot write credits, runs, outputs, plans or limits directly, nor touch B's projects", async () => {
    const [mine] = await projects(OWNER_A, 1), [theirs] = await projects(OWNER_B, 1);
    const ownRun = await start(OWNER_A, mine!, "test.seven");
    const theirRun = await start(OWNER_B, theirs!, "test.seven");
    await engineSpend(ownRun.id, 900);
    const before = { a: await ledger(OWNER_A), b: await ledger(OWNER_B), spend: await spend() };
    const writes = [
      `insert into public.credit_entries (owner_id, delta, kind, note) values ('${OWNER_A}', 1000, 'grant', 'free money')`,
      `insert into public.credit_entries (owner_id, delta, kind, run_id) values ('${OWNER_A}', 7, 'refund', '${ownRun.id}')`,
      "update public.credit_entries set delta = 1000",
      "delete from public.credit_entries",
      `insert into public.credit_accounts (owner_id, plan_id, period_start, period_end) values ('${OWNER_A}', 'studio', now(), now() + interval '1 year')`,
      "update public.credit_accounts set plan_id = 'studio', granted_period_start = null",
      "delete from public.credit_accounts",
      `insert into public.generation_runs (owner_id, project_id, kind, idempotency_key, input, credits, status) values ('${OWNER_A}', '${mine}', 'test.seven', '${key("raw")}', '{}', 0, 'queued')`,
      "update public.generation_runs set credits = 0, status = 'failed'",
      "delete from public.generation_runs",
      `insert into public.generation_outputs (run_id, owner_id, output_key, output, cost_microusd) values ('${ownRun.id}', '${OWNER_A}', 'forged', '{}', 0)`,
      "update public.generation_outputs set cost_microusd = 0",
      "delete from public.generation_outputs",
      "update fluid_private.generation_kinds set credits = 0, max_per_day = 1000000",
      "update fluid_private.engine_settings set paused = false, global_daily_cost_cap_microusd = 9000000000000",
      "update fluid_private.plans set monthly_credits = 1000000",
      `update public.projects set title = 'taken' where id = '${theirs}'`,
      `delete from public.projects where id = '${theirs}'`,
      `insert into public.projects (owner_id, scope, title) values ('${OWNER_B}', 'complete_brand', 'planted')`,
    ];
    for (const sql of writes) expect(await failure(() => as(OWNER_A, () => db.query(sql))), sql).toMatchObject({ code: "42501" });
    for (const sql of writes) expect(await failure(() => asRole(db, "anon", null, () => db.query(sql))), `anon ${sql}`).toMatchObject({ code: "42501" });
    for (const table of ["fluid_private.generation_kinds", "fluid_private.engine_settings", "fluid_private.plans"]) {
      expect(await failure(() => as(OWNER_A, () => db.query(`select * from ${table}`))), table).toMatchObject({ code: "42501" });
    }
    // Reads stop at A's own rows.
    await as(OWNER_A, async () => {
      for (const table of ["credit_entries", "credit_accounts", "generation_runs", "generation_outputs", "projects"]) {
        const owners = (await db.query<{ owner_id: string }>(`select distinct owner_id from public.${table}`)).rows.map(row => row.owner_id);
        expect(owners, table).toEqual([OWNER_A]);
      }
      expect((await db.query("select id from public.generation_runs where id = $1", [theirRun.id])).rows).toEqual([]);
    });
    expect({ a: await ledger(OWNER_A), b: await ledger(OWNER_B), spend: await spend() }).toEqual(before);
    expect(before.spend).toBe("900");
  });
});

describe("account export and deletion limits", () => {
  it("allows three exports a day per account, refuses the fourth, and the counter can't be reset by the caller", async () => {
    const admit = (owner: string) => as(owner, async () => (await db.query<{ r: { remainingToday: number } }>("select public.admit_account_export() as r")).rows[0]!.r);
    expect([await admit(OWNER_A), await admit(OWNER_A), await admit(OWNER_A)]).toEqual([{ remainingToday: 2 }, { remainingToday: 1 }, { remainingToday: 0 }]);
    for (let n = 0; n < 5; n++) expect(await failure(() => admit(OWNER_A))).toMatchObject({ message: "export_rate_limited", code: "PT429" });
    for (const sql of ["delete from fluid_private.account_export_requests", "update fluid_private.account_export_requests set requested_at = now() - interval '2 days'",
      "select * from fluid_private.account_export_requests"]) {
      expect(await failure(() => as(OWNER_A, () => db.query(sql))), sql).toMatchObject({ code: "42501" });
    }
    expect(await failure(() => asRole(db, "anon", null, () => db.query("select public.admit_account_export()")))).toMatchObject({ code: "42501" });
    expect(await failure(() => as(null, () => db.query("select public.admit_account_export()")))).toMatchObject({ message: "unauthenticated" });
    // A's limit is A's alone.
    expect(await admit(OWNER_B)).toEqual({ remainingToday: 2 });
    // The window is a day.
    await db.exec("update fluid_private.account_export_requests set requested_at = requested_at - interval '25 hours'");
    expect(await admit(OWNER_A)).toEqual({ remainingToday: 2 });
  });

  it("gives no signed-in or anonymous caller any account deletion function", async () => {
    const signatures = ["public.account_deletion_begin(uuid)", "public.account_deletion_purge(uuid)", "public.account_storage_objects(uuid,text,integer)",
      "public.account_deletion_files_removed(uuid,integer)", "public.account_deletion_complete(uuid)", "public.account_deletions_pending(interval,integer)",
      "public.orphaned_storage_objects(text,integer)"];
    for (const signature of signatures) {
      for (const role of ["anon", "authenticated"]) {
        const { rows } = await db.query<{ allowed: boolean }>("select has_function_privilege($1, $2, 'EXECUTE') as allowed", [role, signature]);
        expect(rows[0]!.allowed, `${role} ${signature}`).toBe(false);
      }
    }
  });
});
