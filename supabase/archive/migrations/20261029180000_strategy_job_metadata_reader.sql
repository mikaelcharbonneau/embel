-- Owner-scoped read projection. Raw immutable input and worker fencing fields
-- remain unreadable to authenticated clients, including through JSON paths.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create function public.get_strategy_job_summaries(p_project_id uuid,p_job_id uuid default null)
returns setof jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then
  raise exception 'not_found' using errcode='P0002';end if;
 return query
 select jsonb_build_object(
  'id',j.id,'owner_id',j.owner_id,'project_id',j.project_id,'operation',j.operation,
  'input_revision',j.input_revision,'input_version',j.input->'version',
  'input_spend_control',j.input->>'spendControl','input_policy_identity',j.input->>'policyIdentity',
  'state',j.state,'progress',j.progress,'billing_mode',j.billing_mode,'policy_identity',j.policy_identity,
  'reserved_cost_microusd',j.reserved_cost_microusd,'actual_cost_microusd',j.actual_cost_microusd,
  'cancel_requested_at',j.cancel_requested_at,'error_code',j.error_code,
  'created_at',j.created_at,'finished_at',j.finished_at)
 from public.jobs j
 where j.owner_id=v_owner and j.project_id=p_project_id and (p_job_id is null or j.id=p_job_id)
  and j.operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')
 order by j.created_at desc,j.id desc limit 64;
end $$;
alter function public.get_strategy_job_summaries(uuid,uuid) owner to postgres;

-- Remove inherited default EXECUTE grants before granting this single facade.
do $acl$
declare recipient record;
begin
 for recipient in select distinct a.grantee from pg_catalog.pg_proc p,
  lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
  where p.oid='public.get_strategy_job_summaries(uuid,uuid)'::regprocedure and a.grantee<>p.proowner
 loop
  if recipient.grantee=0 then
   revoke all on function public.get_strategy_job_summaries(uuid,uuid) from public;
  else
   execute format('revoke all on function public.get_strategy_job_summaries(uuid,uuid) from %I',pg_catalog.pg_get_userbyid(recipient.grantee));
  end if;
 end loop;
end $acl$;
grant execute on function public.get_strategy_job_summaries(uuid,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
