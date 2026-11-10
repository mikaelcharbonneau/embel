-- LOCAL REVIEW ONLY. Uses an independently created, explicitly approved
-- non-anonymous Auth identity, distinct from the brand owner. No password,
-- access/refresh token or session is accepted by SQL or emitted in results.
-- Set these non-secret connection settings from the reviewed setup record:
-- embel.logo_owner_id, embel.logo_storage_user_id, embel.logo_worker_id,
-- embel.logo_policy_identity, embel.logo_reservation_microusd.
-- This prepares DISABLED records only. Reservation is the existing per-call
-- accounting contract, not an account-allowance increase or a funding action.
begin;
do $setup$
declare
  v_owner_id uuid := nullif(current_setting('embel.logo_owner_id',true),'')::uuid;
  v_storage_user uuid := nullif(current_setting('embel.logo_storage_user_id',true),'')::uuid;
  v_worker_id text := nullif(current_setting('embel.logo_worker_id',true),'');
  v_policy_identity text := nullif(current_setting('embel.logo_policy_identity',true),'');
  v_reservation bigint := nullif(current_setting('embel.logo_reservation_microusd',true),'')::bigint;
  v_binding fluid_private.logo_worker_principals;
begin
  if v_owner_id is null or v_storage_user is null or v_owner_id=v_storage_user
    or v_worker_id is null or v_worker_id!~'^[A-Za-z0-9._:-]{1,200}$'
    or v_policy_identity is null or v_policy_identity!~'^[a-f0-9]{64}$'
    or v_reservation is null or v_reservation<1 or v_reservation>1501199875790165
    or not exists(select 1 from auth.users u where u.id=v_storage_user and not u.is_anonymous)
    then raise exception 'reviewed_logo_storage_binding_required'; end if;
  select p.* into v_binding from fluid_private.logo_worker_principals p join pg_roles r on r.oid=p.role_oid and r.rolname=p.role_name
    where p.role_name='fluid_logo_worker' and p.owner_id=v_owner_id and r.rolcanlogin and not r.rolinherit
    and not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
    and not exists(select 1 from pg_auth_members m where m.member=r.oid);
  if not found then raise exception 'reviewed_logo_worker_required'; end if;
  insert into fluid_private.logo_storage_principals(auth_user_id,owner_id,role_name,role_oid,worker_id,enabled)
    values(v_storage_user,v_owner_id,v_binding.role_name,v_binding.role_oid,v_worker_id,false);
  insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,engine,max_cost_microusd,enabled)
    values(v_owner_id,'identity.logo_concept',v_policy_identity,'logo-image-v1','openai','gpt-image-2.5-sunburst-2026-09-08',null,v_reservation,false);
  insert into fluid_private.logo_generative_storage_capabilities(auth_user_id,operation,policy_identity,enabled)
    values(v_storage_user,'identity.logo_concept',v_policy_identity,false);
  insert into fluid_private.logo_local_capabilities(owner_id,role_name,role_oid,worker_id,policy_identity,enabled)
    values(v_owner_id,v_binding.role_name,v_binding.role_oid,v_worker_id,v_policy_identity,false);
end $setup$;
commit;
