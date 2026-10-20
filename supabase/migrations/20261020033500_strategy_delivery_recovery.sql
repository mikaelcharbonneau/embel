-- Read-only recovery of an existing owner's initial API-text handoff.
-- This exposes the same immutable descriptor already returned by admission,
-- never a new admission, request key, prompt, policy body or worker authority.
begin;

create function public.get_strategy_job_deliveries(p_project_id uuid,p_job_ids uuid[])
returns setof jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); r record; v_retry boolean;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_job_ids is null or coalesce(array_length(p_job_ids,1),0) not between 1 and 64
  or array_ndims(p_job_ids)<>1 or array_position(p_job_ids,null) is not null then
  raise exception 'invalid_input' using errcode='22023'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then
  raise exception 'not_found' using errcode='P0002'; end if;
 for r in
  select j as job,d as dispatch,p.current_revision,p.deleted_at,p.deletion_requested_at
  from public.jobs j join public.projects p on p.id=j.project_id and p.owner_id=j.owner_id
  join fluid_private.api_text_dispatches d on d.job_id=j.id and d.owner_id=j.owner_id and d.project_id=j.project_id
  where j.id=any(p_job_ids) and j.owner_id=v_owner and j.project_id=p_project_id
   and j.billing_mode='openai_api' and fluid_private.api_text_operation(j.operation) and j.state='queued'
 loop
  v_retry := (r.job).attempts=0 and (r.job).cancel_requested_at is null
   and (r.job).project_deletion_requested_at is null and (r.job).finished_at is null
   and (r.job).lease_token is null and (r.job).lease_expires_at is null and (r.job).plan_registered_at is null
   and (r.job).input_revision=r.current_revision and r.deleted_at is null and r.deletion_requested_at is null
   and (r.dispatch).publication_generation=0 and (r.dispatch).published_at is null
   and (r.dispatch).published_message_id is null
   and not exists(select 1 from public.job_steps where job_id=(r.job).id);
  return next jsonb_build_object(
   'job',fluid_private.strategy_job_summary(r.job),
   'dispatchState',case when (r.dispatch).published_at is not null and (r.dispatch).published_message_id is not null
    then 'published' else 'dispatch_pending' end,
   'canRetryDelivery',v_retry,
   'dispatch',case when v_retry then jsonb_build_object('version',1,'jobId',(r.job).id,
    'policyIdentity',(r.dispatch).policy_identity,'deploymentId',(r.dispatch).deployment_id,
    'dispatchIdentity',(r.dispatch).dispatch_identity) else null end);
 end loop;
end $$;

-- Scrub even hostile default function grants; the sole non-owner capability is
-- authenticated EXECUTE on this read-only, explicitly owner-scoped function.
do $acl$
declare recipient record;
begin
 for recipient in select distinct a.grantee from pg_catalog.pg_proc p,
  lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
  where p.oid='public.get_strategy_job_deliveries(uuid,uuid[])'::regprocedure and a.grantee<>p.proowner
 loop
  if recipient.grantee=0 then
   revoke all on function public.get_strategy_job_deliveries(uuid,uuid[]) from public;
  else
   execute format('revoke all on function public.get_strategy_job_deliveries(uuid,uuid[]) from %I',
    pg_catalog.pg_get_userbyid(recipient.grantee));
  end if;
 end loop;
end $acl$;
grant execute on function public.get_strategy_job_deliveries(uuid,uuid[]) to authenticated;
commit;
