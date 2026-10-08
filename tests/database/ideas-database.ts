import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

export const IDEA_OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const IDEA_OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const ideaKey = (n: number) => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, "0")}`;
export const ideaContent = (title = "Local fixture", state = "to_explore") => ({ title, description: "User-authored local fixture", theme: "", state,
  details: { problem: "", audience: "", solution: "", differentiation: "", revenueHypotheses: "", validationSteps: "", notes: "" } });

export async function readIdeasFoundationAcls(db: PGlite) {
  return (await db.query(`select 'table' as kind,c.relname as name,c.relacl::text as acl,c.relrowsecurity::text as detail,c.relforcerowsecurity::text as extra
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('projects','project_revisions')
    union all select 'function',p.proname,p.proacl::text,pg_get_functiondef(p.oid),p.proconfig::text
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname='create_project')
        or (n.nspname='fluid_private' and p.proname='prevent_history_change')
    union all select 'policy',polname,null,pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid)
      from pg_policy where polrelid in ('public.projects'::regclass,'public.project_revisions'::regclass)
    order by kind,name`)).rows;
}
export const ideasFoundationAcls = new WeakMap<PGlite, unknown[]>();

/** Disposable foundation-only PostgreSQL fixture. No live connections or Identity helpers. */
export async function createIdeasDatabase() {
  const db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create role fluid_local_worker nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated,service_role,fluid_local_worker;
    grant execute on function auth.uid() to anon,authenticated,service_role,fluid_local_worker;
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner_id text);
    grant usage on schema storage to authenticated,service_role;
    grant select,insert,update,delete on storage.objects to authenticated,service_role;`);
  await db.exec(await readFile(new URL("../../supabase/migrations/20261002003028_foundation.sql", import.meta.url), "utf8"));
  ideasFoundationAcls.set(db, await readIdeasFoundationAcls(db));
  // Hostile fixture-only defaults prove the migration removes all inherited rights
  // from each NEW object without changing the existing foundation ACLs.
  await db.exec(`alter default privileges in schema public grant all on tables to public,anon,authenticated,service_role,fluid_local_worker;
    alter default privileges in schema public grant all on functions to public,anon,authenticated,service_role,fluid_local_worker;
    alter default privileges in schema fluid_private grant all on functions to public,anon,authenticated,service_role,fluid_local_worker;`);
  // During the first red run, absence of the new migration leaves the real RPC boundary missing.
  const migration = await readFile(new URL("../../supabase/migrations/20261005221000_manual_ideas.sql", import.meta.url), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  if (migration) await db.exec(migration);
  await db.query("insert into auth.users values($1),($2)", [IDEA_OWNER_A, IDEA_OWNER_B]);
  return db;
}

export async function asIdeaRole<T>(db: PGlite, role: "authenticated" | "anon" | "service_role" | "fluid_local_worker", owner: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner ?? ""]);
  await db.exec(`set role ${role}`);
  try { return await run(); }
  finally { await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub','',false)"); }
}

export async function ideaRpc<T = Record<string, unknown>>(db: PGlite, name: string, values: unknown[] = [], owner = IDEA_OWNER_A) {
  const signatures: Record<string, string> = { create_idea: "$1::uuid,$2::jsonb", update_idea: "$1::uuid,$2::integer,$3::uuid,$4::jsonb",
    get_idea: "$1::uuid", list_ideas: "$1::timestamptz,$2::uuid,$3::integer,$4::text,$5::text",
    create_idea_brand: "$1::uuid,$2::integer,$3::uuid,$4::jsonb,$5::text", get_project_idea_source: "$1::uuid" };
  if (!Object.hasOwn(signatures, name)) throw new Error("Unknown local fixture RPC");
  return asIdeaRole(db, "authenticated", owner, async () => (await db.query<{ value: T }>(`select public.${name}(${signatures[name]}) as value`, values)).rows[0]!.value);
}
