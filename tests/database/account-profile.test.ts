import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asRole as asFixtureRole, createTestDatabase, OWNER_A as ownerA, OWNER_B as ownerB, resetFixture, type TestDatabase } from "./local-supabase";
let db: TestDatabase;
const asRole = <T>(role: "authenticated" | "anon" | "service_role", owner: string | null, work: () => Promise<T>) => asFixtureRole(db, role, owner, work);
beforeAll(async () => { db = await createTestDatabase(); await resetFixture(db); }, 60_000);
afterAll(async () => { await db?.close(); });

describe("profile PostgreSQL ownership and concurrency (local, not live Supabase)", () => {
  it("forces owner RLS and gives no other role a right on profiles", async () => {
    expect((await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.account_profiles'::regclass")).rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    for (const role of ["anon", "service_role", "fixture_subscription_worker_a"]) {
      expect((await db.query("select has_table_privilege($1,'public.account_profiles','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege($1,'public.account_profiles','SELECT,INSERT,UPDATE,REFERENCES') as permitted", [role])).rows).toEqual([{ permitted: false }]);
    }
    expect((await db.query("select prosecdef from pg_proc where oid='fluid_private.advance_account_profile_revision()'::regprocedure")).rows).toEqual([{ prosecdef: false }]);
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
