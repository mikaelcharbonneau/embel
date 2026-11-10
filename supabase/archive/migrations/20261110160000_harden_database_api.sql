-- Harden the database API surface (docs/architecture-review.md, step 2.3).
-- Grants and default privileges only: no table, function body or policy changes.
--
-- 1. Four worker helper functions were executable by PUBLIC, so anonymous
--    visitors could call them straight through the API. They exist for the
--    row-level-security policies on public.job_steps (subscription_worker_step_read
--    and api_text_worker_step_read, both "to public"). Those policy expressions
--    run as whichever role reads job_steps, so every such role needs EXECUTE:
--    the signed-in role, and the restricted worker logins that read seven
--    job_steps columns. The anonymous role has no privilege on job_steps at all
--    (foundation migration), so no anonymous query ever evaluates them.
--    PUBLIC is revoked, and the roles that held the access keep it explicitly.
--    authenticated and service_role stay explicit, which also keeps the
--    "broadExecute" proof in worker/shared-pool/authority-manifest.json true.
-- 2. public.set_project_deleted is not called by the app (src/, worker/ and
--    services/ use request_project_deletion and restore_project_deletion), so it
--    loses its client grant.
-- 3. Functions the postgres role creates from now on are not executable by
--    PUBLIC, anon or authenticated until a migration grants them explicitly.
--    PUBLIC's EXECUTE comes from PostgreSQL's built-in default, which a
--    per-schema "alter default privileges ... revoke" cannot remove, so that
--    one statement has no IN SCHEMA clause. It applies to functions postgres
--    creates in any schema, for example a future "create extension".
--
-- Rollback SQL is in the pull request description.

begin;

-- 1. The four worker helper functions.
revoke execute on function
  public.api_text_worker_owner(),
  public.api_text_worker_can_read_step(uuid, uuid),
  public.subscription_worker_owner(),
  public.subscription_worker_can_read_step(uuid, uuid)
  from public, anon;

grant execute on function
  public.api_text_worker_owner(),
  public.api_text_worker_can_read_step(uuid, uuid),
  public.subscription_worker_owner(),
  public.subscription_worker_can_read_step(uuid, uuid)
  to authenticated, service_role;

-- Every other existing role had this access through PUBLIC: the restricted
-- API-text, subscription and shared worker logins, the engine login, and
-- no-login owner roles whose definer functions read job_steps. Grant it by name
-- so none of them loses it; only anon and PUBLIC do. Superusers and BYPASSRLS
-- roles skip ACLs and policies, and Supabase's own service roles never call
-- these. Roles created after this migration are not covered: a new worker login
-- must be granted what it needs, the same as for any other function.
do $$
declare r record;
begin
  for r in select rolname from pg_catalog.pg_roles
    where not rolsuper and not rolbypassrls
      and rolname not in ('anon', 'authenticated', 'service_role', 'authenticator', 'pgbouncer', 'dashboard_user')
      and rolname !~ '^(pg_|supabase_|cli_login_)'
    order by rolname
  loop
    execute format($f$grant execute on function
      public.api_text_worker_owner(),
      public.api_text_worker_can_read_step(uuid, uuid),
      public.subscription_worker_owner(),
      public.subscription_worker_can_read_step(uuid, uuid) to %I$f$, r.rolname);
  end loop;
end $$;

-- 2. Unused client grant. The function stays for the owner and the lifecycle tests.
revoke execute on function public.set_project_deleted(uuid, integer, integer, boolean)
  from public, anon, authenticated;

-- 3. New functions are private until granted.
alter default privileges for role postgres in schema public, fluid_private
  revoke execute on functions from anon, authenticated;
alter default privileges for role postgres
  revoke execute on functions from public;

commit;
