import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let db: PGlite;
async function asRole<T>(role: "authenticated" | "anon" | "service_role" | "fixture_worker", owner: string | null, work: () => Promise<T>) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner ?? ""]);
  await db.exec(`set role ${role}`);
  try { return await work(); } finally { await db.exec("reset role"); }
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role fixture_worker nologin;
    create schema auth; create schema fluid_private; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role,fixture_worker;
    create table public.profile_test_unrelated(id uuid primary key); grant select on public.profile_test_unrelated to authenticated;
    alter default privileges in schema public grant all on tables to public,anon,authenticated,service_role,fixture_worker;
    alter default privileges in schema fluid_private grant all on functions to public,anon,authenticated,service_role,fixture_worker;`);
  await db.exec(await readFile(new URL("../../supabase/migrations/20261013035222_account_profiles.sql", import.meta.url), "utf8"));
  await db.query("insert into auth.users values($1),($2)", [ownerA, ownerB]);
}, 30_000);
afterAll(async () => { await db?.close(); });

describe("profile PostgreSQL ownership and concurrency (local, not live Supabase)", () => {
  it("forces owner RLS, removes hostile inherited ACLs from only new objects, and creates no signup trigger", async () => {
    expect((await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.account_profiles'::regclass")).rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    for (const role of ["anon", "service_role", "fixture_worker"]) {
      expect((await db.query("select has_table_privilege($1,'public.account_profiles','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege($1,'public.account_profiles','SELECT,INSERT,UPDATE,REFERENCES') as permitted", [role])).rows).toEqual([{ permitted: false }]);
    }
    expect((await db.query("select has_table_privilege('authenticated','public.profile_test_unrelated','SELECT') as permitted")).rows).toEqual([{ permitted: true }]);
    expect((await db.query("select prosecdef from pg_proc where oid='fluid_private.advance_account_profile_revision()'::regprocedure")).rows).toEqual([{ prosecdef: false }]);
    expect((await db.query("select tgname from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal")).rows).toEqual([]);
    expect((await db.query("select owner_id from public.account_profiles")).rows).toEqual([]);
  });
  it("inserts and restores only the caller's profile, with immutable owner and server-controlled version", async () => {
    await asRole("authenticated", ownerA, async () => {
      expect((await db.query("insert into public.account_profiles(owner_id,full_name,time_zone,date_format) values($1,'Owner A','America/Toronto','friendly') returning revision", [ownerA])).rows).toEqual([{ revision: 1 }]);
      await expect(db.query("insert into public.account_profiles(owner_id,full_name) values($1,'Forged')", [ownerB])).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("update public.account_profiles set owner_id=$1", [ownerB])).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("update public.account_profiles set revision=99")).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("delete from public.account_profiles")).rejects.toMatchObject({ code: "42501" });
    });
    await asRole("authenticated", ownerB, async () => {
      expect((await db.query("select * from public.account_profiles")).rows).toEqual([]);
      expect((await db.query("update public.account_profiles set full_name='Other owner' where owner_id=$1 returning owner_id", [ownerA])).rows).toEqual([]);
      await db.query("insert into public.account_profiles(owner_id,full_name) values($1,'Owner B')", [ownerB]);
      expect((await db.query("select owner_id,full_name from public.account_profiles")).rows).toEqual([{ owner_id: ownerB, full_name: "Owner B" }]);
    });
    await asRole("authenticated", null, async () => {
      expect((await db.query("select * from public.account_profiles")).rows).toEqual([]);
      await expect(db.query("insert into public.account_profiles(owner_id) values($1)", [ownerA])).rejects.toMatchObject({ code: "42501" });
    });
  });
  it("compares the expected version atomically and rejects duplicate first saves", async () => {
    await asRole("authenticated", ownerA, async () => {
      expect((await db.query("update public.account_profiles set full_name='Updated A',time_zone='Asia/Tokyo',date_format='iso' where owner_id=$1 and revision=1 returning revision,full_name,time_zone,date_format", [ownerA])).rows).toEqual([{ revision: 2, full_name: "Updated A", time_zone: "Asia/Tokyo", date_format: "iso" }]);
      expect((await db.query("update public.account_profiles set full_name='Stale' where owner_id=$1 and revision=1 returning revision", [ownerA])).rows).toEqual([]);
      await expect(db.query("insert into public.account_profiles(owner_id) values($1)", [ownerA])).rejects.toMatchObject({ code: "23505" });
      expect((await db.query("select full_name,revision from public.account_profiles")).rows).toEqual([{ full_name: "Updated A", revision: 2 }]);
    });
  });
  it("enforces supported field limits at the direct database boundary", async () => {
    await asRole("authenticated", ownerA, async () => {
      for (const sql of ["update public.account_profiles set full_name=repeat('x',101)", "update public.account_profiles set full_name=E'A\\nB'", "update public.account_profiles set time_zone='Not/AZone'", "update public.account_profiles set date_format='arbitrary'"]) {
        await expect(db.query(sql)).rejects.toMatchObject({ code: "23514" });
      }
    });
  });
});
