import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createTestDatabase, resetFixture, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { applySharedImageModel } from "./shared-image-model-fixture";

export const sharedHttpOrigin = "https://fricsfwqibyhemknqgyf.supabase.co";
export const sharedHttpRoles = { home: "embel_shared_http_home_test", identity: "embel_shared_http_identity_test" } as const;
export async function createSharedAccountFixture(options: { selectedLogoBoards?: boolean } = {}) {
  const db = await createTestDatabase();
  await db.exec(`alter table auth.users add column if not exists email_confirmed_at timestamptz,
   add column if not exists is_anonymous boolean not null default false,add column if not exists banned_until timestamptz,add column if not exists deleted_at timestamptz;
   create table if not exists auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,not_after timestamptz);
   create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create role authenticator login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   grant authenticated to authenticator;
   grant execute on function auth.jwt() to authenticated;`);
  await db.exec(await readFile(new URL("../../supabase/candidates/identity_transactions.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/candidates/shared_worker_pool.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/candidates/shared_account_http.sql", import.meta.url), "utf8"));
  // Qualification now requires both customer and permanent legacy-actor
  // Storage fences. Install real reviewed prerequisites; never fabricate a
  // policy/helper response to make the fixed web login appear ready.
  for (const name of ["candidates/logo_worker_storage.sql", "candidates/logo_production_storage.sql", "activation/logo_production_storage.sql", "candidates/logo_generative_storage.sql", "activation/logo_generative_storage.sql", "candidates/logo_local_concepts.sql", "activation/logo_concepts_50_publication_adjudication.sql", "candidates/logo_local_refinements.sql", "candidates/shared_worker_logo.sql", "candidates/shared_storage_authority.sql"])
   await db.exec(await readFile(new URL("../../supabase/" + name, import.meta.url), "utf8"));
  // Web qualification must be tested against the final installed writers, not
  // only the earlier HTTP packet. Historical generation fixtures opt in later.
  if (options.selectedLogoBoards) for (const name of ["shared_logo_http.sql", "shared_logo_advanced.sql", "shared_identity_generation.sql", "shared_identity_selected_logo_boards.sql", "shared_identity_http_writer_permissions.sql"])
   await db.exec(await readFile(new URL("../../supabase/candidates/" + name, import.meta.url), "utf8"));
  if (options.selectedLogoBoards) await applySharedImageModel(db);
  await db.exec(`create role ${sharedHttpRoles.home} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create role ${sharedHttpRoles.identity} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   grant usage on schema public to ${sharedHttpRoles.home},${sharedHttpRoles.identity};
   grant execute on function public.shared_account_http_principal(),public.execute_shared_home_request(text,text,jsonb,jsonb) to ${sharedHttpRoles.home};
   grant execute on function public.shared_account_http_principal(),public.prepare_shared_identity_request(text,uuid,jsonb,boolean),public.commit_shared_identity_request(uuid,jsonb,jsonb),public.finish_shared_identity_request() to ${sharedHttpRoles.identity};
   insert into fluid_private.shared_http_principals(lane,role_name,role_oid,enabled) select case when rolname='${sharedHttpRoles.home}' then 'home' else 'identity' end,rolname,oid,true from pg_roles where rolname in('${sharedHttpRoles.home}','${sharedHttpRoles.identity}');
   insert into fluid_private.shared_http_target(mode,origin) values('hosted','${sharedHttpOrigin}');`);
  await resetFixture(db);
  await db.exec("update auth.users set email_confirmed_at=clock_timestamp(),is_anonymous=false");
  const sessions: Record<string, string> = { [OWNER_A]: randomUUID(), [OWNER_B]: randomUUID() };
  for (const [owner, session] of Object.entries(sessions)) await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [session, owner]);
  async function asSession<T>(role: string, callback: () => Promise<T>): Promise<T> {
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(role)) throw Error("Invalid fixture role");
    const nested = db.isInTransaction();
    if (nested) await db.exec("savepoint shared_fixture_role");
    await db.exec(`set session authorization ${role}`);
    try { return await callback(); }
    catch (error) { if (nested) await db.exec("rollback to savepoint shared_fixture_role"); throw error; }
    finally { await db.exec("reset role; set session authorization postgres"); if (nested) await db.exec("release savepoint shared_fixture_role"); }
  }
  async function asAuth<T>(owner: string, callback: () => Promise<T>, overrides: Record<string, unknown> = {}): Promise<T> {
    const claims = { sub: owner, role: "authenticated", aud: "authenticated", iss: `${sharedHttpOrigin}/auth/v1`,
      is_anonymous: false, session_id: sessions[owner], exp: Math.floor(Date.now() / 1000) + 3600, ...overrides };
    await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [owner, JSON.stringify(claims)]);
    try { return await asSession("authenticator", async () => { await db.exec("set role authenticated"); return callback(); }); }
    finally { await db.query("select set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claims','',false)"); }
  }
  async function issue(owner: string, lane: "home" | "identity", action: string, args: unknown[]) {
    return asAuth(owner, async () => (await db.query<{ value: { version: 1; token: string; ownerId: string; expiresAt: string } }>("select public.issue_shared_account_request($1,$2,$3::jsonb) value", [lane, action, JSON.stringify(args)])).rows[0]!.value);
  }
  async function home(owner: string, action: string, args: unknown[], observation: unknown = null) {
    const delegation = await issue(owner, "home", action, args);
    return asSession(sharedHttpRoles.home, async () => (await db.query<{ value: unknown }>("select public.execute_shared_home_request($1,$2,$3::jsonb,$4::jsonb) value", [delegation.token, action, JSON.stringify(args), observation === null ? null : JSON.stringify(observation)])).rows[0]!.value);
  }
  return { db, sessions, asSession, asAuth, issue, home };
}
export type SharedAccountFixture = Awaited<ReturnType<typeof createSharedAccountFixture>>;
export type { TestDatabase };
