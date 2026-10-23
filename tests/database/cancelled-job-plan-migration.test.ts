import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./local-supabase";

const migration = "20261023154915_cancelled_job_plan_replay.sql";
describe("cancelled-plan replay migration scope", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase({ before: migration }); }, 60_000);
  afterAll(async () => { await db?.close(); });
  it("preserves function identity, owner, privileges and every other database function", async () => {
    const catalog = () => db.query<{ oid: number; proname: string; proowner: number; proacl: unknown; prosecdef: boolean; proconfig: unknown; definition: string }>("select p.oid,p.proname,p.proowner,p.proacl,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','fluid_private') and p.prokind='f' order by p.oid");
    const before = (await catalog()).rows;
    const sql = await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8");
    await db.exec(sql);
    const after = (await catalog()).rows;
    expect(after).toHaveLength(before.length);
    const changed = after.filter((row, index) => row.definition !== before[index]!.definition);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.proname).toBe("register_job_plan");
    for (let i = 0; i < before.length; i++) {
      expect({ ...after[i], definition: null }).toEqual({ ...before[i], definition: null });
    }
    // A changed predecessor must not silently receive a partial/textual patch.
    await expect(db.exec(sql)).rejects.toThrow(/register_job_plan_definition_changed/);
    expect((await catalog()).rows).toEqual(after);
  });
});
