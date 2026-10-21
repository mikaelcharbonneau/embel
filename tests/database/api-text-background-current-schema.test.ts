import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createTestDatabase } from "./local-supabase";

it("installs disabled on the complete migration chain without changing existing permissions", async () => {
  const db = await createTestDatabase({before:"20261021190000_api_text_background_recovery.sql"});
  try {
    const before = (await db.query("select oid,proowner,proacl,prosecdef,proconfig from pg_proc where oid in ('public.api_text_dispatch_action(jsonb,text,jsonb)'::regprocedure,'public.expire_api_text_job(uuid)'::regprocedure) order by oid")).rows;
    await db.exec(await readFile(new URL("../../supabase/candidates/api_text_background_journal.sql", import.meta.url), "utf8"));
    expect((await db.query("select enabled from fluid_private.api_text_background_rollout")).rows).toEqual([{ enabled: false }]);
    expect((await db.query("select count(*)::integer count from fluid_private.api_text_background_profiles")).rows).toEqual([{ count: 0 }]);
    expect((await db.query("select oid,proowner,proacl,prosecdef,proconfig from pg_proc where oid in ('public.api_text_dispatch_action(jsonb,text,jsonb)'::regprocedure,'public.expire_api_text_job(uuid)'::regprocedure) order by oid")).rows).toEqual(before);
  } finally { await db.close(); }
}, 300000);

it("keeps the reviewed candidate identical to the versioned migration", async () => {
 const candidate=await readFile(new URL("../../supabase/candidates/api_text_background_journal.sql",import.meta.url),"utf8");
 const migration=await readFile(new URL("../../supabase/migrations/20261021190000_api_text_background_recovery.sql",import.meta.url),"utf8");
 expect(migration).toBe(candidate);
});
