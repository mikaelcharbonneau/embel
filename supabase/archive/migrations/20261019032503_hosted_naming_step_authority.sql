-- Hosted Naming uses the same immutable execution profile at the shared step
-- boundary. No activation, data rewrite, new RPC grant or provider request.
begin;

do $guard$
begin
 if not exists(select 1 from pg_proc p where p.oid='public.begin_job_step(uuid,uuid,text,text,bigint)'::regprocedure
  and md5(p.prosrc)='1cedc3022407e1e083320413a75130a9' and p.prosecdef and p.provolatile='v'
  and p.proconfig=array['search_path=""'] and not p.proleakproof
  and p.proowner=(select oid from pg_roles where rolname=current_user)) then
  raise exception 'unexpected_hosted_naming_step_predecessor';
 end if;
end $guard$;

-- The restricted login and exact immutable admission must both match. This is
-- independent of current enablement so saved, zero-cost preparation can finish.
-- The Naming begin/authorize wrappers still require current capability/readiness
-- for creation and every new paid dispatch. Unknown work on this project blocks.
create function fluid_private.hosted_naming_step_authority(p_job uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.jobs j
 join fluid_private.naming_brain_runs r on r.job_id=j.id and r.owner_id=j.owner_id and r.project_id=j.project_id
 where j.id=p_job and fluid_private.naming_brain_execution_authority(j.id)='hosted_owner_v1'
 and fluid_private.naming_brain_run_worker(r)
 and not fluid_private.naming_brain_paid_paused(r.owner_id,r.project_id,r.job_id));
$$;

do $patch$
declare definition text; original text; replacement text;
begin
 definition:=pg_get_functiondef('public.begin_job_step(uuid,uuid,text,text,bigint)'::regprocedure);
 for original,replacement in values
 ($old$if fluid_private.api_text_paid_paused(v_job.owner_id) and not fluid_private.local_prototype_job_worker(v_job.id) then$old$,
  $new$if fluid_private.api_text_paid_paused(v_job.owner_id) and not fluid_private.local_prototype_job_worker(v_job.id)
  and not fluid_private.hosted_naming_step_authority(v_job.id) then$new$),
 ($old$and not fluid_private.api_text_testing_job_allowed(v_job.id) and not fluid_private.local_prototype_unlimited_job(v_job.id) then$old$,
  $new$and not fluid_private.api_text_testing_job_allowed(v_job.id) and not fluid_private.local_prototype_unlimited_job(v_job.id)
    and not fluid_private.hosted_naming_step_authority(v_job.id) then$new$),
 ($old$(p_max_cost_microusd > v_job.reserved_cost_microusd - v_job.actual_cost_microusd - v_pending and not fluid_private.local_prototype_unlimited_job(v_job.id)) then$old$,
  $new$(p_max_cost_microusd > v_job.reserved_cost_microusd - v_job.actual_cost_microusd - v_pending and not fluid_private.local_prototype_unlimited_job(v_job.id)
    and not fluid_private.hosted_naming_step_authority(v_job.id)) then$new$) loop
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
   raise exception 'unexpected_hosted_naming_step_fragment';
  end if;
  definition:=replace(definition,original,replacement);
 end loop;
 execute definition;
end $patch$;

-- Strip every default grant. Only existing definer-owned worker gateways call
-- this private helper; the worker cannot call the generic step RPC directly.
do $deny$
declare privilege record;
begin
 for privilege in select distinct a.grantee from pg_proc p,
  lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where p.oid='fluid_private.hosted_naming_step_authority(uuid)'::regprocedure and a.grantee<>p.proowner loop
  execute format('revoke all on function fluid_private.hosted_naming_step_authority(uuid) from %s cascade',
   case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
 end loop;
end $deny$;

commit;
