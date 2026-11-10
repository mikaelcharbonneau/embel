-- REVIEWED LOCALLY ONLY. Execute after explicit approval of the new restricted
-- worker login and local credential persistence for fricsfwqibyhemknqgyf.
-- Before execution set embel.logo_owner_id and embel.logo_project_id to the
-- verified signed-in account and one of its saved projects, on this connection.
-- No passwords, provider calls, readiness, policies or allowance changes here.
begin;
do $setup$
declare
  v_owner uuid := nullif(current_setting('embel.logo_owner_id',true),'')::uuid;
  v_project uuid := nullif(current_setting('embel.logo_project_id',true),'')::uuid;
begin
  if current_database()<>'postgres' or v_owner is null or v_project is null
    or not exists(select 1 from public.projects p where p.id=v_project and p.owner_id=v_owner)
    then raise exception 'verified_logo_owner_project_required'; end if;
  if exists(select 1 from pg_roles where rolname='fluid_logo_worker')
    or exists(select 1 from fluid_private.logo_worker_principals p where p.owner_id=v_owner)
    then raise exception 'logo_principal_collision_stop'; end if;
  -- No PASSWORD clause. Credentials are set afterwards using native psql's
  -- hidden password prompts; this script cannot authenticate the login.
  create role fluid_logo_worker login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id)
    select rolname,oid,v_owner from pg_roles where rolname='fluid_logo_worker';
end $setup$;
grant connect on database postgres to fluid_logo_worker;
grant usage on schema public,fluid_private to fluid_logo_worker;
-- The worker gets exactly the durable concept runner and asset publication
-- operations. No relation access, memberships, generic jobs, vector or export.
grant execute on function
  fluid_private.logo_worker_owner(),
  public.report_logo_worker_ready(text,jsonb,integer),
  public.claim_logo_job(text,integer),
  public.heartbeat_logo_job(uuid,uuid,integer),
  public.register_logo_job_plan(uuid,uuid,jsonb),
  public.begin_logo_job_step(uuid,uuid,text,text,bigint),
  public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),
  public.finish_logo_job(uuid,uuid,text),
  public.expire_logo_job_leases(),
  public.read_leased_logo_record(uuid,uuid,text,jsonb),
  public.record_logo_provider_response(uuid,uuid,jsonb),
  fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),
  fluid_private.read_logo_asset_publication(uuid,jsonb,uuid,uuid),
  fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid)
to fluid_logo_worker;
select rolname,oid::bigint as role_oid,rolcanlogin,rolinherit,rolsuper,rolbypassrls,
  rolcreatedb,rolcreaterole,rolreplication from pg_roles where rolname='fluid_logo_worker';
commit;
