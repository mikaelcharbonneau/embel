import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { brainPolicy } from "./naming-brain-fixture";
import { guidedStrategyPolicy } from "../../src/server/ai/config";

let db: TestDatabase;
const text = "embel_development_text_worker", logo = "embel_development_logo_worker", deployment = "embel-dev-fixture";
const operations = ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality"] as const;
async function asLogin<T>(role: string, run: () => Promise<T>) {
  await db.exec(`set session authorization ${role}`);
  try { return await run(); } finally { await db.exec("set session authorization postgres"); }
}
const proof = async (lane = "naming", owner = OWNER_A, target = deployment) =>
  (await db.query<{ owner: string | null }>("select public.check_development_worker_binding($1,$2,$3)::text owner", [lane, owner, target])).rows[0]!.owner;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.exec(await readFile(new URL("../../supabase/development/worker-preflight.sql", import.meta.url), "utf8"));
  await db.exec(`create role ${text} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role ${logo} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    grant usage on schema public to ${text},${logo};`);
  await db.query("insert into auth.users(id) values($1),($2)", [OWNER_A, OWNER_B]);
  await db.query(`insert into fluid_private.naming_brain_pilots(owner_id,role_name,role_oid,deployment_id,policy,enabled)
    select $1,rolname,oid,$2,$3::jsonb,false from pg_roles where rolname=$4`, [OWNER_A, deployment, JSON.stringify(brainPolicy), text]);
  for (const operation of operations) {
    const policy = guidedStrategyPolicy(operation, "gpt-6-luna");
    await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values($1,false,$2)", [operation, policy]);
    await db.query(`insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled)
      select $1,$2,rolname,oid,$3,$4,false from pg_roles where rolname=$5`, [OWNER_A, operation, deployment, policy, text]);
  }
  await db.query("insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname=$2", [OWNER_A, logo]);
}, 60_000);
afterAll(async () => { await db?.close(); });

it("installs a stable fixed-search-path definer without default execute grants or provisioning", async () => {
  const metadata = (await db.query<{ prosecdef: boolean; provolatile: string; proconfig: string[] }>("select prosecdef,provolatile,proconfig from pg_proc where oid='public.check_development_worker_binding(text,uuid,text)'::regprocedure")).rows[0]!;
  expect(metadata).toEqual({ prosecdef: true, provolatile: "s", proconfig: ['search_path=""'] });
  for (const role of ["anon", "authenticated", "service_role", text, logo])
    expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.check_development_worker_binding(text,uuid,text)','EXECUTE') allowed", [role])).rows[0]!.allowed).toBe(false);
  await expect(asLogin(text, () => proof())).rejects.toMatchObject({ code: "42501" });
});

it("proves the actual restricted login in a read-only transaction without granting private reads or enabling policies", async () => {
  await db.exec(`grant execute on function public.check_development_worker_binding(text,uuid,text) to ${text},${logo}`);
  const before = (await db.query("select to_jsonb(p) row from fluid_private.naming_brain_pilots p")).rows;
  await asLogin(text, async () => {
    await db.exec("begin read only");
    try { expect(await proof()).toBe(OWNER_A); expect(await proof("strategy")).toBe(OWNER_A); }
    finally { await db.exec("rollback"); }
    await expect(db.query("select * from fluid_private.local_prototype_strategy_capabilities")).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("select fluid_private.local_strategy_worker_owner()")).rejects.toMatchObject({ code: "42501" });
  });
  expect((await db.query("select to_jsonb(p) row from fluid_private.naming_brain_pilots p")).rows).toEqual(before);
  expect((await db.query("select count(*)::integer count from fluid_private.local_prototype_strategy_capabilities where enabled or ready_until is not null")).rows).toEqual([{ count: 0 }]);
});

it("rejects foreign owners, deployments, lane switching and stale role-OID bindings", async () => {
  await asLogin(text, async () => {
    expect(await proof("naming", OWNER_B)).toBeNull(); expect(await proof("naming", OWNER_A, "embel-dev-other")).toBeNull();
    expect(await proof("naming", OWNER_A, "production")).toBeNull(); expect(await proof("logo")).toBeNull();
  });
  await db.query("update fluid_private.naming_brain_pilots set role_oid=(role_oid::bigint+1)::oid where owner_id=$1", [OWNER_A]);
  try { expect(await asLogin(text, () => proof())).toBeNull(); }
  finally { await db.query("update fluid_private.naming_brain_pilots set role_oid=(select oid from pg_roles where rolname=$1) where owner_id=$2", [text, OWNER_A]); }
  expect(await asLogin(logo, () => proof("logo"))).toBe(OWNER_A);
  expect(await asLogin(logo, () => proof("strategy"))).toBeNull();
});

it("withdraws proof for membership, new object ownership or an incomplete capability set", async () => {
  await db.exec(`create role fixture_development_extra nologin; grant fixture_development_extra to ${text}`);
  try { expect(await asLogin(text, () => proof())).toBeNull(); }
  finally { await db.exec(`revoke fixture_development_extra from ${text}`); }
  await db.exec(`create table public.fixture_development_owned(id integer); alter table public.fixture_development_owned owner to ${text}`);
  try { expect(await asLogin(text, () => proof())).toBeNull(); }
  finally { await db.exec("drop table public.fixture_development_owned"); }
  await db.query("update fluid_private.local_prototype_strategy_capabilities set deployment_id='embel-dev-other' where operation='strategy.personality'");
  try { expect(await asLogin(text, () => proof())).toBeNull(); }
  finally { await db.query("update fluid_private.local_prototype_strategy_capabilities set deployment_id=$1", [deployment]); }
});
