import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { asRole, OWNER_A, OWNER_B } from "./local-supabase";
import { createNaming250Database } from "./naming-250-fixture";

const migrationUrl = new URL("../../supabase/migrations/20261006010000_standalone_workspaces.sql", import.meta.url);
const privateSignatures = [
  "fluid_private.standalone_keys(jsonb,text[])", "fluid_private.standalone_text(jsonb,integer,integer)",
  "fluid_private.standalone_timestamp(jsonb)", "fluid_private.standalone_domain(text)",
  "fluid_private.standalone_compact(jsonb)", "fluid_private.standalone_payload(text,jsonb)",
  "fluid_private.standalone_current_import(uuid,uuid)", "fluid_private.standalone_record(uuid,uuid)",
];
const rpcSignatures = [
  "public.get_standalone_workspace(text)", "public.get_standalone_import(uuid)",
  "public.save_standalone_workspace(text,integer,uuid,jsonb,jsonb)",
];
const unrelatedSignatures = [
  "fluid_private.standalone_acl_sentinel()", "fluid_private.standalonexacl_sentinel()",
  "fluid_private.standalone_text(text)", "public.get_standalone_workspace(text,boolean)",
];

describe("standalone migration exact ACL scope and transactional collision rejection", () => {
  let db: Awaited<ReturnType<typeof createNaming250Database>>;
  let migration: string;
  beforeEach(async () => {
    // Existing Naming fixture plus Ideas are the complete dependencies needed by
    // this migration. No existing fixture helper or historical SQL is modified.
    db = await createNaming250Database();
    await db.exec(await readFile(new URL("../../supabase/migrations/20261005221000_manual_ideas.sql", import.meta.url), "utf8"));
    migration = await readFile(migrationUrl, "utf8");
  }, 30_000);
  afterEach(async () => { await db?.close(); });
  const functionSnapshot = async (signatures: string[]) => {
    const rows = [];
    for (const signature of signatures) {
      rows.push(...(await db.query("select oid,proacl::text as acl,pg_get_functiondef(oid) as definition from pg_proc where oid=$1::regprocedure", [signature])).rows);
    }
    return rows;
  };

  it("ACL scope regression: preserves matching names and overloads while stripping only reviewed defaults", async () => {
    await db.exec(`
      create role fixture_standalone_acl_worker nologin;
      create function fluid_private.standalone_acl_sentinel() returns text language sql as $$ select 'prefix untouched'::text $$;
      create function fluid_private.standalonexacl_sentinel() returns text language sql as $$ select 'underscore wildcard untouched'::text $$;
      create function fluid_private.standalone_text(text) returns text language sql as $$ select $1 $$;
      create function public.get_standalone_workspace(text,boolean) returns text language sql as $$ select $1 $$;
      revoke all on function public.get_standalone_workspace(text,boolean) from public;
      grant execute on function fluid_private.standalone_acl_sentinel(),fluid_private.standalonexacl_sentinel(),
        fluid_private.standalone_text(text),public.get_standalone_workspace(text,boolean) to anon,service_role,fixture_standalone_acl_worker;
      alter default privileges in schema public grant all on tables to public,anon,authenticated,service_role,fixture_standalone_acl_worker;
      alter default privileges in schema public grant all on functions to public,anon,authenticated,service_role,fixture_standalone_acl_worker;
      alter default privileges in schema fluid_private grant all on functions to public,anon,authenticated,service_role,fixture_standalone_acl_worker;
    `);
    const before = await functionSnapshot(unrelatedSignatures);
    const defaultsBefore = (await db.query("select oid,defaclacl::text as acl from pg_default_acl order by oid")).rows;
    await db.exec(migration);
    expect(await functionSnapshot(unrelatedSignatures)).toEqual(before);
    expect((await db.query("select oid,defaclacl::text as acl from pg_default_acl order by oid")).rows).toEqual(defaultsBefore);

    for (const signature of [...privateSignatures, ...rpcSignatures]) {
      for (const role of ["anon", "authenticated", "service_role", "fixture_standalone_acl_worker"]) {
        const allowed = (await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'execute') as allowed", [role, signature])).rows[0]!.allowed;
        expect(allowed, `${role} EXECUTE ${signature}`).toBe(role === "authenticated" && rpcSignatures.includes(signature));
      }
    }
    for (const table of ["public.standalone_workspaces", "public.standalone_workspace_revisions"]) {
      for (const role of ["anon", "authenticated", "service_role", "fixture_standalone_acl_worker"]) {
        const rights = (await db.query("select has_table_privilege($1,$2,'select') as read,has_table_privilege($1,$2,'insert,update,delete,truncate,references,trigger') as write", [role, table])).rows;
        expect(rights, `${role} ${table}`).toEqual([{ read: role === "authenticated", write: false }]);
      }
    }
    const policies = (await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid in ('public.standalone_workspaces'::regclass,'public.standalone_workspace_revisions'::regclass) order by oid")).rows;
    expect(policies).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }, { relrowsecurity: true, relforcerowsecurity: true }]);
    await db.query("insert into auth.users values($1),($2)", [OWNER_A, OWNER_B]);
    const payload = { version: 1, input: "Cedar", extensions: ["com"], candidates: ["cedar.com"] };
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.save_standalone_workspace('domains',0,'dddddddd-dddd-4ddd-8ddd-dddddddddddd',$1::jsonb,'[]'::jsonb)", [JSON.stringify(payload)]));
    expect((await asRole(db, "authenticated", OWNER_B, () => db.query("select id from public.standalone_workspaces"))).rows).toEqual([]);
    await expect(asRole(db, "authenticated", OWNER_A, () => db.query("update public.standalone_workspaces set current_revision=2"))).rejects.toMatchObject({ code: "42501" });
  });

  it.each([
    { label: "second table", code: "42P07", signature: null,
      setup: "create table public.standalone_workspace_revisions(marker text); insert into public.standalone_workspace_revisions values('preserve this row'); grant select on public.standalone_workspace_revisions to anon" },
    { label: "private helper exact signature", code: "42723", signature: privateSignatures[0]!,
      setup: "create function fluid_private.standalone_keys(jsonb,text[]) returns boolean language sql as $$ select true $$; grant execute on function fluid_private.standalone_keys(jsonb,text[]) to anon,service_role" },
    { label: "last RPC exact signature", code: "42723", signature: rpcSignatures[2]!,
      setup: "create function public.save_standalone_workspace(text,integer,uuid,jsonb,jsonb) returns jsonb language sql as $$ select '{\"fixture\":\"preserve\"}'::jsonb $$; grant execute on function public.save_standalone_workspace(text,integer,uuid,jsonb,jsonb) to anon,service_role" },
  ])("rejects $label collision and rolls back every newly created object", async ({ code, signature, setup }) => {
    await db.exec(setup);
    const tableSnapshot = async () => ({
      definition: (await db.query("select oid,relacl::text as acl from pg_class where oid='public.standalone_workspace_revisions'::regclass")).rows,
      rows: (await db.query("select * from public.standalone_workspace_revisions")).rows,
    });
    const before = signature ? await functionSnapshot([signature]) : await tableSnapshot();
    await expect(db.exec(migration)).rejects.toMatchObject({ code });
    await db.exec("rollback");
    expect(signature ? await functionSnapshot([signature]) : await tableSnapshot()).toEqual(before);
    for (const candidate of [...privateSignatures, ...rpcSignatures]) {
      const exists = (await db.query<{ present: boolean }>("select to_regprocedure($1) is not null as present", [candidate])).rows[0]!.present;
      expect(exists, candidate).toBe(candidate === signature);
    }
    for (const table of ["public.standalone_workspaces", "public.standalone_workspace_revisions"]) {
      const exists = (await db.query<{ present: boolean }>("select to_regclass($1) is not null as present", [table])).rows[0]!.present;
      expect(exists, table).toBe(signature === null && table === "public.standalone_workspace_revisions");
    }
  });
});
