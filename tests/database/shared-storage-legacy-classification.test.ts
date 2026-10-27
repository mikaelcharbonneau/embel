import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedStorageFixture, OWNER_A, OWNER_B, SHARED_STORAGE_ACTOR } from "./shared-storage-fixture";
import { generativeStorageFixture, authUser, sessionId, conceptCapability } from "./logo-generative-storage-fixture";

// Actual disposable SQL/RLS; all Auth sessions, image/provider evidence and
// private object rows are synthetic. No network, credentials or live target.
describe("permanent legacy service-actor classification", () => {
 let shared: Awaited<ReturnType<typeof createSharedStorageFixture>>;
 let legacy: Awaited<ReturnType<typeof generativeStorageFixture>>;
 beforeAll(async () => {
  shared = await createSharedStorageFixture();
  await shared.db.query("insert into public.usage_accounts(owner_id,limit_microusd) values($1,100000)", [OWNER_A]);
  legacy = await generativeStorageFixture(shared.db);
  await shared.db.query("update auth.users set email_confirmed_at=clock_timestamp() where id=$1", [authUser]);
  await shared.db.exec("update fluid_private.shared_http_target set mode='hosted',origin='https://fricsfwqibyhemknqgyf.supabase.co'");
 }, 90_000);
 afterAll(async () => { await shared?.close(); });
 beforeEach(async () => { await shared.db.exec("begin"); });
 afterEach(async () => { await shared.db.exec("rollback; set session authorization postgres"); });
 const classify = () => shared.db.query("insert into fluid_private.shared_service_actors values($1,'legacy_logo_storage')", [authUser]);
 const eligible = async () => (await shared.db.query<{ ok: boolean }>("select fluid_private.shared_account_customer_active($1) ok", [authUser])).rows[0]!.ok;

 it("grants no direct classification-trigger execution to customers, fixed slots or hostile default grantees", async () => {
  for (const role of ["anon", "authenticated", "service_role", shared.roleName, "fixture_production_acl_probe"])
   expect((await shared.db.query<{ ok: boolean }>("select has_function_privilege($1,'fluid_private.shared_service_actor_classification()','EXECUTE') ok", [role])).rows[0]!.ok).toBe(false);
 });

 it("derives legacy classification from actual old bindings and retains it through Auth changes/unban", async () => {
  expect(await eligible()).toBe(true); await classify(); expect(await eligible()).toBe(false);
  await shared.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1", [authUser]);
  await shared.db.query("update auth.users set banned_until=null,email_confirmed_at=clock_timestamp() where id=$1", [authUser]);
  await shared.db.query("update fluid_private.logo_storage_principals set enabled=false where auth_user_id=$1", [authUser]);
  expect(await eligible()).toBe(false);
  expect((await shared.db.query<{ purpose: string }>("select purpose from fluid_private.shared_service_actors where auth_user_id=$1", [authUser])).rows[0]!.purpose).toBe("legacy_logo_storage");
 });
 it("rejects arbitrary customers without a legacy service binding", async () => {
  await expect(shared.db.query("insert into fluid_private.shared_service_actors values($1,'legacy_logo_storage')", [OWNER_B])).rejects.toMatchObject({ code: "42501" });
 });
 it("rejects a legacy registry row whose role/OID no longer matches the actual worker binding", async () => {
  await shared.db.query("update fluid_private.logo_storage_principals set role_oid=(select oid from pg_roles where rolname='authenticated') where auth_user_id=$1", [authUser]);
  await expect(classify()).rejects.toMatchObject({ code: "42501" });
 });
 it("cannot classify a known legacy actor as a new shared actor", async () => {
  await expect(shared.db.query("insert into fluid_private.shared_service_actors values($1,'logo_storage')", [authUser])).rejects.toMatchObject({ code: "42501" });
 });
 it("cannot remove or change the permanent classification", async () => {
  await classify();
  await expect(shared.db.query("delete from fluid_private.shared_service_actors where auth_user_id=$1", [authUser])).rejects.toMatchObject({ code: "42501" });
 });
 it("refuses a changed kind even for the installer", async () => {
  await classify();
  await expect(shared.db.query("update fluid_private.shared_service_actors set purpose='logo_storage' where auth_user_id=$1", [authUser])).rejects.toMatchObject({ code: "42501" });
 });
 it("retains actual legacy issued Storage reads while denying the shared grant surface", async () => {
  const p = await legacy.prepareConcept(0), output = await legacy.reserve(p.job);
  await legacy.enable(conceptCapability); await legacy.authorize(p.job, output.reservation, "write"); await legacy.insert(output.reservation);
  expect(await legacy.read(output.reservation)).toHaveLength(1);
  await classify(); expect(await legacy.read(output.reservation)).toHaveLength(1);
  await expect(shared.auth(() => shared.db.query("select public.shared_logo_storage_session()"), { sub: authUser, session_id: sessionId, iss: "https://fricsfwqibyhemknqgyf.supabase.co/auth/v1" })).rejects.toMatchObject({ code: "42501" });
 });
 it("does not permit a shared actor to change into the historical policy class", async () => {
  await expect(shared.db.query("update fluid_private.shared_service_actors set purpose='legacy_logo_storage' where auth_user_id=$1", [SHARED_STORAGE_ACTOR])).rejects.toMatchObject({ code: "42501" });
 });
 it("denies ordinary Home fallback forever after removal of a legacy registry row", async () => {
  await classify(); const id = randomUUID(), version = randomUUID(), path = `${authUser}/home/${id}/${version}`;
  await shared.db.query("insert into public.home_attachments(id,owner_id,request_key,input,blob_version_id,name,mime_type,content_hash,byte_length,verified) values($1,$2,$3,'{}',$4,'legacy.txt','text/plain',$5,12,false)", [id, authUser, randomUUID(), version, "a".repeat(64)]);
  await shared.db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [path, authUser]);
  const read = async () => { await shared.db.query("select set_config('storage.operation','object.get_authenticated',false)"); return legacy.auth(async () => (await shared.db.query("select name from storage.objects where name=$1", [path])).rows); };
  expect(await read()).toEqual([]); await shared.db.query("delete from fluid_private.logo_storage_principals where auth_user_id=$1", [authUser]);
  expect(await read()).toEqual([]); expect(await eligible()).toBe(false);
 });
});
