import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createTestDatabase, installApiTextRuntimeCandidate, type TestDatabase } from "./local-supabase";

/** Local fixture installation only; no hosted migration is executed. */
describe("reviewed API candidate fixture installation", () => {
  let db: TestDatabase;
  let candidate: string;
  let hostileSetupCount = 0;
  beforeAll(async () => {
    candidate = await readFile(new URL("../../supabase/candidates/restricted_api_text_runtime.sql", import.meta.url), "utf8");
    db = await createTestDatabase({ additionalMigrations: [candidate], beforeMigration: async (fixture, sql) => {
      if (sql !== candidate) return;
      expect((await fixture.query("select to_regclass('fluid_private.api_text_worker_principals') as existing")).rows[0]).toEqual({ existing: null });
      await fixture.exec("create role fixture_hostile_default nologin; alter default privileges grant execute on functions to fixture_hostile_default; alter default privileges grant all on tables to fixture_hostile_default");
      hostileSetupCount++;
    } });
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  it("installs hostile defaults before migrated candidate SQL rather than skipping the challenge", async () => {
    expect(hostileSetupCount).toBe(1);
    await expect(installApiTextRuntimeCandidate(db)).resolves.toBeUndefined();
    expect(hostileSetupCount).toBe(1);
    expect((await db.query("select has_table_privilege('fixture_hostile_default','fluid_private.api_text_worker_principals','SELECT') as allowed")).rows[0]).toEqual({ allowed: false });
  });
  it("recognizes an actually applied byte-identical migration and validates installed security definitions", async () => {
    await expect(installApiTextRuntimeCandidate(db)).resolves.toBeUndefined();
    await expect(installApiTextRuntimeCandidate(db)).resolves.toBeUndefined();
  });
  it("rejects a candidate that differs from the actual applied migration", async () => {
    await expect(installApiTextRuntimeCandidate(db, candidate + "\n-- changed candidate\n")).rejects.toThrow("candidate_migration_mismatch");
  });
  it("does not silently skip changed function bodies or security settings", async () => {
    const original = (await db.query<{ definition: string }>("select pg_get_functiondef('public.check_api_text_runtime(text,jsonb,text)'::regprocedure) as definition")).rows[0]!.definition;
    await db.exec("create or replace function public.check_api_text_runtime(p_operation text,p_policy jsonb,p_deployment_id text) returns boolean language sql security definer set search_path='' as $$ select true $$");
    await expect(installApiTextRuntimeCandidate(db)).rejects.toThrow("candidate_schema_mismatch");
    await db.exec(original);
    await db.exec("alter function public.check_api_text_runtime(text,jsonb,text) security invoker");
    await expect(installApiTextRuntimeCandidate(db)).rejects.toThrow("candidate_schema_mismatch");
    await db.exec(original);
  });
  it("refuses a missing FORCE-RLS boundary despite matching migration bytes", async () => {
    await db.exec("alter table fluid_private.api_strategy_bindings no force row level security");
    await expect(installApiTextRuntimeCandidate(db)).rejects.toThrow("candidate_schema_mismatch");
    await db.exec("alter table fluid_private.api_strategy_bindings force row level security");
  });
});
