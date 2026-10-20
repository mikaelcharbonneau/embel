import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./local-supabase";

const migration = "20261020031000_strategy_evidence_join_planning.sql";
const signatures = [
  "fluid_private.research_operator_adjudication_matches(uuid)",
  "fluid_private.api_text_deleted_strategy_quarantined(uuid,text,uuid,uuid)",
] as const;
const noTransaction = (sql: string) => sql.replace(/^begin;$/m, "").replace(/^commit;$/m, "");
type CatalogRow = { oid: number; descriptor: Record<string, unknown>; proconfig: string[] };
type Plan = { "Planning Time": number; "Execution Time": number };

/** Fully migrated disposable PostgreSQL only; no provider or hosted connection.
 * Behavioral matched/Restore/overrun/foreign cases run in the complete quarantine
 * suite in both modes. Genuine synthetic historical receipts run in the research
 * recovery suite. Here we verify the narrow catalog delta and planning cost. */
describe("function-local Strategy evidence join planning", () => {
  let db: TestDatabase, sql: string;
  const catalog = async () => (await db.query<CatalogRow>(
    "select oid,to_jsonb(p)-'proconfig' descriptor,proconfig from pg_proc p where pronamespace in ('public'::regnamespace,'fluid_private'::regnamespace) order by oid",
  )).rows;
  const data = async () => {
    const tables = (await db.query<{ relation: string }>("select oid::regclass::text relation from pg_class where relnamespace in ('public'::regnamespace,'fluid_private'::regnamespace) and relkind='r' order by 1")).rows;
    const values: Record<string, unknown> = {};
    for (const { relation } of tables)
      values[relation] = (await db.query(`select count(*)::integer count,md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by to_jsonb(t)::text),'')) digest from ${relation} t`)).rows;
    return values;
  };
  beforeAll(async () => {
    db = await createTestDatabase({ before: migration });
    sql = await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8");
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  it("changes only the two function-local planner settings, retaining all bytes, identities, privileges and data", async () => {
    const before = await catalog(), rows = await data();
    const selected = (await db.query<{ oid: number }>("select unnest($1::regprocedure[])::oid oid", [signatures])).rows.map(row => row.oid);
    await db.exec("begin; set local join_collapse_limit=6");
    try {
      await db.exec(noTransaction(sql));
      const after = await catalog();
      expect(after).toEqual(before.map(row => selected.includes(row.oid)
        ? { ...row, proconfig: ['search_path=""', "join_collapse_limit=1"] } : row));
      expect(await data()).toEqual(rows);
      expect((await db.query("show join_collapse_limit")).rows).toEqual([{ join_collapse_limit: "6" }]);
      expect((await db.query(`select fluid_private.research_operator_adjudication_matches(null) research,
        fluid_private.api_text_deleted_strategy_quarantined(null,null,null,null) quarantine`)).rows)
        .toEqual([{ research: false, quarantine: false }]);
      expect((await db.query("show join_collapse_limit")).rows).toEqual([{ join_collapse_limit: "6" }]);
      for (const signature of signatures)
        for (const role of ["anon", "authenticated", "service_role"])
          expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows).toEqual([{ allowed: false }]);
    } finally { await db.exec("rollback"); }
    expect(await catalog()).toEqual(before);
  });

  it.each([
    ["source", "create or replace function fluid_private.research_operator_adjudication_matches(p_job uuid) returns boolean language sql stable set search_path='' as $$select false$$"],
    ["security mode", `alter function ${signatures[0]} security definer`],
    ["search path", `alter function ${signatures[0]} set search_path=public`],
    ["volatility", `alter function ${signatures[0]} volatile`],
    ["permission", `grant execute on function ${signatures[0]} to authenticated`],
    ["owner", `alter function ${signatures[0]} owner to service_role`],
    ["second helper configuration", `alter function ${signatures[1]} set join_collapse_limit=2`],
  ])("rejects unexpected predecessor %s atomically", async (_name, change) => {
    const before = await catalog();
    await db.exec("begin");
    try {
      await db.exec(change);
      await expect(db.exec(noTransaction(sql))).rejects.toThrow("unexpected_strategy_evidence_planning_predecessor");
    } finally { await db.exec("rollback"); }
    expect(await catalog()).toEqual(before);
  });

  it("substantially bounds exhaustive cold planning without hiding execution work", async () => {
    // Measure identical unmodified SELECT bodies under both planner settings,
    // not replacement predicates or fabricated timing. Empty relations isolate
    // the join-order startup cost; matched fixtures are covered separately.
    for (const signature of signatures) {
      const source = (await db.query<{ body: string }>("select prosrc body from pg_proc where oid=$1::regprocedure", [signature])).rows[0]!.body;
      const body = source.replaceAll("p_owner", "'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid")
        .replaceAll("p_project", "'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid")
        .replaceAll("p_job", "'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid")
        .replaceAll("p_operation", "'strategy.competitors'::text");
      const timings = new Map<number, number[]>([[8, []], [1, []]]);
      await db.exec("begin");
      try {
        for (const setting of [8, 1, 8, 1, 8, 1]) {
          await db.exec(`set local join_collapse_limit=${setting}`);
          const result = await db.query<{ "QUERY PLAN": Plan[] }>(`explain (analyze,format json,timing false) ${body}`);
          timings.get(setting)!.push(result.rows[0]!["QUERY PLAN"][0]!["Planning Time"]);
        }
      } finally { await db.exec("rollback"); }
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[1]!;
      // Relative medians avoid a machine-speed SLA and reject only a missing
      // structural gain. Production latency still needs separate verification.
      expect(median(timings.get(1)!), signature).toBeLessThan(median(timings.get(8)!) / 2);
    }
  }, 60_000);
});
