import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";

const candidateUrl = new URL("../../supabase/candidates/logo_worker_storage.sql", import.meta.url);
const variantUrl = new URL("../../supabase/development/logo-storage-local-issuer.sql", import.meta.url);
const localIssuer = "http://127.0.0.1:54321/auth/v1", hostedIssuer = "https://fricsfwqibyhemknqgyf.supabase.co/auth/v1";
const role = "embel_development_logo_worker", actor = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
async function storageDatabase() {
  const db = await createTestDatabase();
  await db.exec(`alter table auth.users add column is_anonymous boolean not null default false;
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    grant execute on function auth.jwt() to authenticated;`);
  await db.exec(await readFile(candidateUrl, "utf8"));
  return db;
}
async function apply(db: TestDatabase) {
  try { await db.exec(await readFile(variantUrl, "utf8")); }
  catch (error) { await db.exec("rollback"); throw error; }
}
const metadata = async (db: TestDatabase) => (await db.query<{ metadata: Record<string, unknown> }>(
  "select to_jsonb(p) metadata from pg_proc p where oid='fluid_private.logo_storage_context()'::regprocedure")).rows[0]!.metadata;

describe("local Logo issuer installation guards (disposable SQL only)", () => {
  let db: TestDatabase, definition: string, original: Record<string, unknown>;
  beforeAll(async () => {
    db = await storageDatabase(); original = await metadata(db);
    definition = (await db.query<{ definition: string }>("select pg_get_functiondef('fluid_private.logo_storage_context()'::regprocedure) definition")).rows[0]!.definition;
  }, 60_000);
  beforeEach(async () => {
    await db.exec(definition);
    await db.exec("alter database postgres reset embel.development_target; alter role postgres in database postgres reset embel.development_target");
    await db.query("select set_config('embel.development_target','',false)");
  });
  afterAll(async () => { await db?.close(); });

  it("leaves the production candidate byte-identical and hosted-pinned", async () => {
    const bytes = await readFile(candidateUrl);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("b9aed06d6c96ca1d09c32542058f67d11d34d0dff27b5949103d4595d0f4b092");
    expect(bytes.toString()).toContain(hostedIssuer); expect(bytes.toString()).not.toContain(localIssuer);
  });

  it("rejects absent or wrong database markers, session spoofing and role-scoped markers without changing the function", async () => {
    await expect(apply(db)).rejects.toMatchObject({ code: "55000", message: "isolated_development_target_not_confirmed" });
    await db.exec("alter database postgres set embel.development_target='hosted-project'");
    await expect(apply(db)).rejects.toMatchObject({ code: "55000", message: "isolated_development_target_not_confirmed" });
    await db.exec("alter database postgres reset embel.development_target");
    await db.query("select set_config('embel.development_target','embel-local-dev',false)");
    await expect(apply(db)).rejects.toMatchObject({ code: "55000", message: "isolated_development_target_not_confirmed" });
    await db.exec("alter role postgres in database postgres set embel.development_target='embel-local-dev'");
    await expect(apply(db)).rejects.toMatchObject({ code: "55000", message: "isolated_development_target_not_confirmed" });
    expect(await metadata(db)).toEqual(original);
  });

  it.each(["body", "security", "volatility", "search_path", "acl"])("rejects a drifted reviewed predecessor: %s", async change => {
    await db.exec("alter database postgres set embel.development_target='embel-local-dev'");
    if (change === "body") await db.exec(definition.replace("declare claims jsonb", "-- unreviewed change\ndeclare claims jsonb"));
    if (change === "security") await db.exec("alter function fluid_private.logo_storage_context() security invoker");
    if (change === "volatility") await db.exec("alter function fluid_private.logo_storage_context() stable");
    if (change === "search_path") await db.exec("alter function fluid_private.logo_storage_context() set search_path=public");
    if (change === "acl") await db.exec("grant execute on function fluid_private.logo_storage_context() to authenticated");
    const changed = await metadata(db);
    await expect(apply(db)).rejects.toMatchObject({ code: "55000", message: "unexpected_logo_storage_context_predecessor" });
    expect(await metadata(db)).toEqual(changed);
    if (change === "acl") await db.exec("revoke execute on function fluid_private.logo_storage_context() from authenticated");
  });

  it("changes only the issuer body literal, preserving every function attribute, ACL, policy and default privilege", async () => {
    const defaults = (await db.query("select * from pg_default_acl order by oid")).rows;
    const policies = (await db.query("select * from pg_policies order by schemaname,tablename,policyname")).rows;
    const before = await metadata(db);
    await db.exec("alter database postgres set embel.development_target='embel-local-dev'"); await apply(db);
    const after = await metadata(db), { prosrc: beforeSource, ...beforeAttributes } = before, { prosrc: afterSource, ...afterAttributes } = after;
    expect(afterSource).toBe(String(beforeSource).replace(hostedIssuer, localIssuer)); expect(afterAttributes).toEqual(beforeAttributes);
    expect((await db.query("select * from pg_default_acl order by oid")).rows).toEqual(defaults);
    expect((await db.query("select * from pg_policies order by schemaname,tablename,policyname")).rows).toEqual(policies);
    await expect(apply(db)).rejects.toMatchObject({ code: "55000", message: "unexpected_logo_storage_context_predecessor" });
  });
});

describe("exact local Logo issuer with unchanged session/owner/role fences (disposable SQL)", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await storageDatabase();
    await db.exec("alter database postgres set embel.development_target='embel-local-dev'"); await apply(db);
    await db.exec(`create role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create role fixture_local_logo_extra nologin;`);
  }, 60_000);
  beforeEach(async () => {
    await db.exec("truncate auth.users cascade");
    await db.query("insert into auth.users(id) values($1),($2),($3)", [OWNER_A, OWNER_B, actor]);
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [sid, actor]);
    await db.query("insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname=$2", [OWNER_A, role]);
    await db.query(`insert into fluid_private.logo_storage_principals(auth_user_id,owner_id,role_name,role_oid,worker_id,enabled)
      select $1,$2,rolname,oid,'embel-dev-logo-fixture',true from pg_roles where rolname=$3`, [actor, OWNER_A, role]);
  });
  afterAll(async () => { await db?.close(); });
  async function session(overrides: Record<string, unknown> = {}, user = actor) {
    const claims = { sub: user, session_id: sid, role: "authenticated", aud: "authenticated", iss: localIssuer,
      exp: Math.floor(Date.now() / 1000) + 3600, is_anonymous: false, ...overrides };
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claims)]);
    try { return await asRole(db, "authenticated", user, async () => (await db.query<{ context: unknown }>("select public.logo_storage_session() context")).rows[0]!.context); }
    finally { await db.query("select set_config('request.jwt.claims','',false)"); }
  }

  it("accepts the exact local issuer only with a real bound nonanonymous session and restricted-role OID", async () => {
    expect(await session()).toMatchObject({ ownerId: OWNER_A, authUserId: actor, sessionId: sid, workerRoleName: role, workerId: "embel-dev-logo-fixture" });
    expect((await db.query("select count(*)::integer count from fluid_private.logo_storage_grants")).rows).toEqual([{ count: 0 }]);
  });

  it.each([hostedIssuer, "http://localhost:54321/auth/v1", "http://127.1:54321/auth/v1", "http://127.0.0.1:54322/auth/v1",
    "https://127.0.0.1:54321/auth/v1", `${localIssuer}/`])("rejects hosted, alias, wrong-port and trailing issuers: %s", async iss => {
    await expect(session({ iss })).rejects.toMatchObject({ code: "42501" });
  });

  it.each([{ exp: 0 }, { session_id: OWNER_B }, { sub: OWNER_A }, { role: "service_role" }, { aud: "wrong" }, { is_anonymous: true }])("rejects expired, forged and anonymous claim contexts: %j", async claims => {
    await expect(session(claims)).rejects.toMatchObject({ code: "42501" });
  });

  it.each(["disabled", "session", "timebox", "oid", "owner", "membership", "anonymous_user"])("rejects revoked or mismatched server-side authority: %s", async revoked => {
    if (revoked === "disabled") await db.exec("update fluid_private.logo_storage_principals set enabled=false");
    if (revoked === "session") await db.exec("delete from auth.sessions");
    if (revoked === "timebox") await db.exec("update auth.sessions set not_after=clock_timestamp()-interval '1 second'");
    if (revoked === "oid") await db.exec("update fluid_private.logo_storage_principals set role_oid=0");
    if (revoked === "owner") await db.query("update fluid_private.logo_storage_principals set owner_id=$1", [OWNER_B]);
    if (revoked === "membership") await db.exec(`grant fixture_local_logo_extra to ${role}`);
    if (revoked === "anonymous_user") await db.query("update auth.users set is_anonymous=true where id=$1", [actor]);
    try { await expect(session()).rejects.toMatchObject({ code: "42501" }); }
    finally { if (revoked === "membership") await db.exec(`revoke fixture_local_logo_extra from ${role}`); }
  });
});
