import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createNaming250Database } from "./naming-250-fixture";
const rpcSignatures = ["public.attach_idea_to_project(jsonb)", "public.read_idea_project_attachment_request(uuid)", "public.get_project_idea_attachments(uuid,uuid,integer)", "public.promote_standalone_workspace(jsonb)", "public.read_standalone_promotion_request(uuid)", "public.get_standalone_promotion_source(uuid)", "public.get_standalone_promotion_snapshot(uuid)"];
const privateSignatures = ["fluid_private.lifecycle_uuid(jsonb)", "fluid_private.lifecycle_revision(jsonb)"];
const unrelatedSignatures = ["fluid_private.lifecycle_acl_sentinel()", "fluid_private.lifecycle_uuid(text)", "public.promote_standalone_workspace(text)"];
describe("Home lifecycle migration exact ACL scope (disposable local fixture)", () => {
 let db: Awaited<ReturnType<typeof createNaming250Database>>;
 beforeEach(async () => {
  db = await createNaming250Database();
  for (const file of ["20261005221000_manual_ideas.sql", "20261006010000_standalone_workspaces.sql"]) await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8"));
 }, 30_000);
 afterEach(async () => db?.close());
 const functionSnapshot = async () => {
  const snapshots = [];
  for (const signature of unrelatedSignatures) snapshots.push(...(await db.query("select oid,proacl::text as acl,pg_get_functiondef(oid) as definition from pg_proc where oid=$1::regprocedure", [signature])).rows);
  return snapshots;
 };
 it("strips nonowner table, column and exact-function defaults without touching unrelated objects or defaults", async () => {
  await db.exec(`
   create role fixture_lifecycle_acl_worker nologin;
   create function fluid_private.lifecycle_acl_sentinel() returns text language sql as $$ select 'untouched'::text $$;
   create function fluid_private.lifecycle_uuid(text) returns text language sql as $$ select $1 $$;
   create function public.promote_standalone_workspace(text) returns text language sql as $$ select $1 $$;
   grant execute on function fluid_private.lifecycle_acl_sentinel(),fluid_private.lifecycle_uuid(text),public.promote_standalone_workspace(text) to anon,service_role,fixture_lifecycle_acl_worker with grant option;
   create table public.lifecycle_acl_sentinel(marker text); insert into public.lifecycle_acl_sentinel values('keep this row');
   grant all on table public.lifecycle_acl_sentinel to fixture_lifecycle_acl_worker with grant option;
   alter default privileges in schema public grant all on tables to public;
   alter default privileges in schema public grant all on functions to public;
   alter default privileges in schema fluid_private grant all on functions to public;
   alter default privileges in schema public grant all on tables to anon,authenticated,service_role,fixture_lifecycle_acl_worker with grant option;
   alter default privileges in schema public grant all on functions to anon,authenticated,service_role,fixture_lifecycle_acl_worker with grant option;
   alter default privileges in schema fluid_private grant all on functions to anon,authenticated,service_role,fixture_lifecycle_acl_worker with grant option;
  `);
  const beforeFunctions = await functionSnapshot(), defaultsBefore = (await db.query("select oid,defaclacl::text as acl from pg_default_acl order by oid")).rows;
  const tableBefore = (await db.query("select oid,relacl::text as acl from pg_class where oid='public.lifecycle_acl_sentinel'::regclass")).rows;
  let migration = await readFile(new URL("../../supabase/migrations/local20261007014000_home_lifecycle.sql", import.meta.url), "utf8");
  // Simulate an extension hook granting a column between creation and the exact ACL reset.
  migration = migration.replace("do $$ declare", () => "grant update(receipt),select(receipt) on public.standalone_promotions to fixture_lifecycle_acl_worker with grant option;\ngrant select(receipt) on public.idea_project_attachments to public;\ndo $$ declare");
  await db.exec(migration);
  expect(await functionSnapshot()).toEqual(beforeFunctions);
  expect((await db.query("select oid,defaclacl::text as acl from pg_default_acl order by oid")).rows).toEqual(defaultsBefore);
  expect((await db.query("select oid,relacl::text as acl from pg_class where oid='public.lifecycle_acl_sentinel'::regclass")).rows).toEqual(tableBefore);
  expect((await db.query("select * from public.lifecycle_acl_sentinel")).rows).toEqual([{ marker: "keep this row" }]);
  for (const signature of [...privateSignatures, ...rpcSignatures]) for (const role of ["anon", "authenticated", "service_role", "fixture_lifecycle_acl_worker"]) {
   const result = (await db.query<{ execute: boolean; delegate: boolean }>("select has_function_privilege($1,$2,'execute') as execute,has_function_privilege($1,$2,'execute with grant option') as delegate", [role, signature])).rows[0]!;
   expect(result, `${role}: ${signature}`).toEqual({ execute: role === "authenticated" && rpcSignatures.includes(signature), delegate: false });
  }
  for (const table of ["public.idea_project_attachments", "public.idea_project_attachment_requests", "public.standalone_promotions"]) for (const role of ["anon", "authenticated", "service_role", "fixture_lifecycle_acl_worker"]) {
   const rights = (await db.query("select has_table_privilege($1,$2,'select') as read,has_table_privilege($1,$2,'insert,update,delete,truncate,references,trigger') as write,has_column_privilege($1,$2,'receipt','update') as column_write,has_column_privilege($1,$2,'receipt','select') as column_read,has_table_privilege($1,$2,'select with grant option') as delegate", [role, table])).rows;
   expect(rights, `${role}: ${table}`).toEqual([{ read: role === "authenticated", write: false, column_write: false, column_read: role === "authenticated", delegate: false }]);
  }
 });
});
