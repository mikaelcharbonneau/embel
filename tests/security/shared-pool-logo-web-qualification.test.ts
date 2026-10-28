import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedLogoFixture, type SharedLogoFixture } from "../database/shared-account-logo-fixture";
import { OWNER_A } from "../database/local-supabase";
import { sharedLogoAdvancedHelperSignatures, sharedLogoHttpHelperHashes } from "../../src/server/shared-account/logo-qualification";

const gateway = "public.execute_shared_logo_request(text,text,jsonb,jsonb)";
const currentGatewayHash = "24f89a8859e6c06fc92f15375c80347576b5ee1715ede9ac202c89520d92d851";
const previousGatewayHash = "d94c05dc32745c93c52a41023bed385cd73216c50b48feaa12e9d8bf10fa96a5";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
beforeAll(() => {
 vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fricsfwqibyhemknqgyf.supabase.co");
 vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_inertfixture");
});
afterAll(() => { vi.unstubAllEnvs(); });

describe("Logo web qualification composes actual installed SQL", () => {
 it("qualifies baseline-only uploads with the exact current gateway and no advanced delegates", async () => {
  const f = await createSharedLogoFixture(), runtime = f.runtime();
  try {
   expect(sharedLogoHttpHelperHashes[gateway]).toEqual([currentGatewayHash]);
   expect(sharedLogoHttpHelperHashes[gateway]).not.toContain(previousGatewayHash);
   for (const signature of sharedLogoAdvancedHelperSignatures) {
    expect((await f.db.query<{ present: boolean }>("select to_regprocedure($1) is not null present", [signature])).rows[0]!.present).toBe(false);
   }
   const workspace = await f.start(OWNER_A);
   expect(await runtime.resolve(f.auth(OWNER_A), workspace.projectId)).toMatchObject({ ownerId: OWNER_A, projectId: workspace.projectId });
   expect(f.calls).toHaveLength(0);
  } finally { await runtime.close(); await f.db.close(); }
 }, 90_000);
});

describe("advanced Logo web direct-delegate drift fails before proof or Storage (actual disposable SQL)", () => {
 let f: SharedLogoFixture, projectId: string;
 beforeAll(async () => {
  f = await createSharedLogoFixture();
  await f.db.exec(await readFile(new URL("../../supabase/candidates/shared_logo_advanced.sql", import.meta.url), "utf8"));
  projectId = (await f.start(OWNER_A)).projectId;
  // The web path must qualify independently of a live/ready worker. This is
  // synthetic expired authority metadata, not an active engine or provider.
  await f.db.exec("create role embel_shared_logo_qualifier_worker login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4");
  const slot = randomUUID(), instance = randomUUID(), token = randomUUID();
  await f.db.query(`insert into fluid_private.shared_worker_slots(slot_id,lane,slot_index,role_name,role_oid,deployment_id,enabled,instance_id,generation,lease_token,expires_at)
   select $1,'logo',1,rolname,oid,'dpl_expired_qualification',true,$2,1,$3,clock_timestamp()-interval '1 minute' from pg_roles where rolname='embel_shared_logo_qualifier_worker'`, [slot, instance, token]);
  await f.db.query("insert into fluid_private.shared_logo_slot_runtime_readiness values($1,$2,1,$3,'[]',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '2 minutes')", [slot, instance, token]);
  expect((await f.db.query<{ ready: boolean }>("select fluid_private.shared_logo_slot_runtime_ready($1) ready", [slot])).rows[0]!.ready).toBe(false);
 }, 90_000);
 afterAll(async () => { await f?.db.close(); });

 async function assertUnchangedGateway() {
  const body = (await f.db.query<{ body: string }>("select prosrc body from pg_proc where oid=to_regprocedure($1)", [gateway])).rows[0]!.body;
  expect(sha(body)).toBe(currentGatewayHash);
 }
 async function refusesBeforeIo(change: () => Promise<unknown>) {
  await f.db.exec("begin");
  const runtime = f.runtime(), before = f.calls.length;
  try {
   await change(); await assertUnchangedGateway();
   const queries = vi.spyOn(f.db, "query");
   try {
    await expect(runtime.resolve(f.auth(OWNER_A), projectId)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(f.calls).toHaveLength(before);
    expect(queries.mock.calls.some(call => String(call[0]).includes("SELECT public.shared_logo_http_principal()"))).toBe(false);
   } finally { queries.mockRestore(); }
  } finally {
   await runtime.close(); await f.db.exec("rollback;set session authorization postgres");
  }
 }
 it("qualifies the full actual advanced group, preserving INVOKER read/apply and DEFINER quote metadata", async () => {
  for (const [index, signature] of sharedLogoAdvancedHelperSignatures.entries()) {
   const row = (await f.db.query<{ body: string; definer: boolean }>("select prosrc body,prosecdef definer from pg_proc where oid=to_regprocedure($1)", [signature])).rows[0]!;
   expect(sharedLogoHttpHelperHashes[signature]).toEqual([sha(row.body)]);
   expect(row.definer).toBe(index === 2);
  }
  const runtime = f.runtime();
  try { expect(await runtime.resolve(f.auth(OWNER_A), projectId)).toMatchObject({ ownerId: OWNER_A, projectId }); }
  finally { await runtime.close(); }
 });
 it.each(sharedLogoAdvancedHelperSignatures)("rejects changed direct body %s without relying on worker readiness", async signature => {
  await refusesBeforeIo(async () => {
   const row = (await f.db.query<{ definition: string; body: string }>("select pg_get_functiondef(oid) definition,prosrc body from pg_proc where oid=to_regprocedure($1)", [signature])).rows[0]!;
   expect(row.definition.split(row.body)).toHaveLength(2);
   await f.db.exec(row.definition.replace(row.body, () => `${row.body}\n-- unexpected installed delegate body\n`));
  });
 });
 it.each(sharedLogoAdvancedHelperSignatures)("rejects changed SECURITY mode %s", async signature => {
  const expectedInvoker = sharedLogoAdvancedHelperSignatures.indexOf(signature) < 2;
  await refusesBeforeIo(() => f.db.exec(`alter function ${signature} security ${expectedInvoker ? "definer" : "invoker"}`));
 });
 it.each(sharedLogoAdvancedHelperSignatures)("rejects changed search path %s", async signature => {
  await refusesBeforeIo(() => f.db.exec(`alter function ${signature} set search_path='public'`));
 });
 it.each(sharedLogoAdvancedHelperSignatures)("rejects a partial advanced group missing %s", async signature => {
  await refusesBeforeIo(() => f.db.exec(`drop function ${signature}`));
 });
 it.each(sharedLogoAdvancedHelperSignatures)("rejects unexpected PUBLIC execute %s", async signature => {
  await refusesBeforeIo(() => f.db.exec(`grant execute on function ${signature} to public`));
 });
});
