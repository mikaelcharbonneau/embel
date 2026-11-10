-- Existing operator-granted Strategy testing only: unrelated Naming/Logo work
-- cannot consume its lane. No job, accounting, grant, policy or runtime changes.
-- Ordinary accounts and null-project inspection keep the original global guards.
begin;
create temporary table strategy_isolation_original_functions on commit drop as
 select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof from pg_proc
 where oid in (
  'public.begin_job_step(uuid,uuid,text,text,bigint)'::regprocedure,
  'public.get_api_strategy_availability(uuid)'::regprocedure,
  'public.enqueue_strategy_job(uuid,integer,text,text,bigint)'::regprocedure,
  'public.check_api_text_runtime(text,jsonb,text)'::regprocedure,
  'fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)'::regprocedure,
  'fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint)'::regprocedure,
  'fluid_private.api_text_allowance_available(uuid,text)'::regprocedure,
  'fluid_private.api_text_testing_job_allowed(uuid)'::regprocedure);
do $guard$
declare signature text; expected text; definer boolean; volatility text;
begin
 for signature,expected,definer,volatility in values
  ('public.begin_job_step(uuid,uuid,text,text,bigint)','a49d9f2659f50e0a35e0163e1f53bb2c',true,'v'),
  ('public.get_api_strategy_availability(uuid)','556ffc9f1984204778afeca0f3c01ece',true,'v'),
  ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)','65f189cf589402ccd44d81877eceae58',true,'v'),
  ('public.check_api_text_runtime(text,jsonb,text)','23e8a4cb4da22eaefc52bd1865d31311',true,'v'),
  ('fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)','4088dd24e5da50e3b9d46e9ba4388a9f',false,'s'),
  ('fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint)','91d7479009ddfca13244f80df20b0c67',true,'v'),
  ('fluid_private.api_text_allowance_available(uuid,text)','58696d2134cb0de73c5b996c82dcdd2c',false,'s'),
  ('fluid_private.api_text_testing_job_allowed(uuid)','2b15d8885e3b51d3955fdcd46149228f',false,'s') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure
   and md5(p.prosrc)=expected and p.prosecdef=definer and p.provolatile::text=volatility
   and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.proowner=(select oid from pg_roles where rolname=current_user)) then
   raise exception 'unexpected_strategy_isolation_predecessor: %',signature;
  end if;
 end loop;
end $guard$;

-- Optional Logo activation owns this witness. Absence never proves resolution.
-- Use only its exact private function; do not broaden research adjudication or
-- rewrite the immutable ambiguous step merely to admit another operation.
create function fluid_private.api_text_strategy_outcome_resolved(p_job uuid)
returns boolean language plpgsql stable set search_path='' as $$
declare resolved boolean;
begin
 if fluid_private.research_operator_adjudication_matches(p_job) then return true; end if;
 if to_regprocedure('fluid_private.logo_publication_failure_adjudication_matches(uuid)') is null then return false; end if;
 execute 'select fluid_private.logo_publication_failure_adjudication_matches($1)' into resolved using p_job;
 return coalesce(resolved,false);
end $$;

create function fluid_private.api_text_testing_project_scope(p_owner uuid,p_operation text,p_project uuid)
returns boolean language sql stable set search_path='' as $$
 select coalesce(p_project is not null and fluid_private.api_text_operation(p_operation)
  and fluid_private.api_text_testing_enabled(p_owner,p_operation)
  and exists(select 1 from public.projects where id=p_project and owner_id=p_owner),false);
$$;

create function fluid_private.api_text_strategy_paused(p_owner uuid,p_operation text,p_project uuid)
returns boolean language sql stable set search_path='' as $$
 select case when fluid_private.api_text_testing_project_scope(p_owner,p_operation,p_project) then
  exists(select 1 from public.jobs j where j.owner_id=p_owner and j.billing_mode='openai_api'
   and (j.actual_cost_microusd>j.reserved_cost_microusd
    or (j.state='needs_reconciliation' and j.error_code in ('cost_overrun','provider_cost_exceeded'))
    or ((fluid_private.api_text_operation(j.operation) or j.project_id=p_project)
     and (j.state='needs_reconciliation' or exists(select 1 from public.job_steps s where s.job_id=j.id and s.state='ambiguous'))
     and not fluid_private.api_text_strategy_outcome_resolved(j.id))))
  or exists(select 1 from fluid_private.naming_brain_runs r where r.owner_id=p_owner and r.observed_overrun)
 else fluid_private.api_text_paid_paused(p_owner) end;
$$;

-- Only the existing private gateway may provide the target of paid execution.
-- Direct readiness without that exact context retains the original global check.
create function fluid_private.api_text_strategy_runtime_paused(p_owner uuid,p_operation text,p_policy jsonb,p_deployment text)
returns boolean language sql stable set search_path='' as $$
 select fluid_private.api_text_strategy_paused(p_owner,p_operation,(
  select j.project_id from fluid_private.api_text_gateway_context c
  join public.jobs j on j.id=c.job_id and j.owner_id=c.owner_id
  join fluid_private.api_text_dispatches d on d.job_id=j.id and d.owner_id=j.owner_id and d.project_id=j.project_id
  join fluid_private.api_text_testing_admissions marker on marker.job_id=j.id
  where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current()
   and c.role_name=session_user and fluid_private.api_text_restricted_role(c.role_name,c.role_oid)
   and c.owner_id=p_owner and j.operation=p_operation and j.input->'policy'=p_policy and d.deployment_id=p_deployment));
$$;

-- Preserve the old two-argument helper for conservative callers. The new private
-- helper receives the owned project from the existing authenticated facade.
CREATE FUNCTION fluid_private.api_text_project_allowance_available(p_owner uuid, p_operation text, p_project uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare r fluid_private.api_text_allowance_rollout; c fluid_private.api_text_allowance_cohorts;
 e fluid_private.api_text_owner_entitlements; a public.usage_accounts; v_new boolean; v_active bigint; v_testing boolean;
begin
 select * into r from fluid_private.api_text_allowance_rollout where singleton;
 if not r.enabled or fluid_private.api_text_allowance_paused() then return null; end if;
 select * into e from fluid_private.api_text_owner_entitlements where owner_id=p_owner;
 v_new:=not found;
 v_testing:=not v_new and fluid_private.api_text_testing_enabled(p_owner,p_operation);
 select * into c from fluid_private.api_text_allowance_cohorts where id=case when v_new then r.signup_cohort else e.cohort_id end;
 if not found or not c.enabled or (not v_testing and c.expires_at<=clock_timestamp()) or p_operation<>all(c.operations)
  or not fluid_private.api_text_restricted_role(c.role_name,c.role_oid)
  or not exists(select 1 from fluid_private.strategy_runtime_policy p where p.operation=p_operation and p.enabled and fluid_private.api_text_request_policy(p_owner,p_operation,p.policy))
  or fluid_private.api_text_strategy_paused(p_owner,p_operation,p_project) then return null; end if;
 if not exists(select 1 from auth.users u where u.id=p_owner and to_jsonb(u)->>'email_confirmed_at' is not null
  and (not v_new or (to_jsonb(u)->>'created_at')::timestamptz between c.signup_after and c.signup_before)) then return null; end if;
 if exists(select 1 from fluid_private.strategy_billing_routes where owner_id=p_owner and billing_mode<>'openai_api')
  or (not exists(select 1 from fluid_private.strategy_billing_routes where owner_id=p_owner)
    and exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=p_owner and operation<>'naming.generate')) then return null; end if;
 if not v_testing and (r.attempts_used>=r.attempt_limit or r.cost_committed>r.cost_limit-122880
  or c.attempts_used>=c.attempt_limit or c.cost_committed>c.cost_limit-122880) then return null; end if;
 select * into a from public.usage_accounts where owner_id=p_owner;
 if v_new then
  if r.accounts_used>=r.account_limit or c.accounts_used>=c.account_limit or c.owner_cost_limit<122880
   or exists(select 1 from fluid_private.api_strategy_bindings where owner_id=p_owner)
   or (a.owner_id is not null and (a.limit_microusd<>0 or a.spent_microusd<>0 or a.provider_actual_microusd<>0 or a.reserved_microusd<>0)) then return null; end if;
 else
  if not e.enabled or a.owner_id is null or a.limit_microusd>5000000
   or (not v_testing and (e.expires_at<=clock_timestamp() or e.attempts_used>=e.attempt_limit
    or e.cost_committed>e.cost_limit-122880
    or a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd)-a.reserved_microusd<122880))
   or not fluid_private.api_text_policy_allowed(p_owner,p_operation,
    (select policy from fluid_private.strategy_runtime_policy where operation=p_operation),c.deployment_id,c.role_oid) then return null; end if;
 end if;
 select count(*) into v_active from public.jobs where owner_id=p_owner and billing_mode='openai_api'
  and state not in ('succeeded','failed','partial','cancelled')
  and (not fluid_private.api_text_testing_project_scope(p_owner,p_operation,p_project)
   or fluid_private.api_text_operation(operation) or project_id=p_project);
 if v_active>=(case when v_testing then 1 when v_new then c.owner_active_limit else e.active_limit end) then return null; end if;
 return c.id;
end $function$
;

-- Exact substitutions preserve function OIDs, ACLs and every surrounding
-- ownership, role, policy, lease, idempotency and last-dispatch check.
do $patch$
declare signature text; original text; replacement text; occurrences integer; definition text;
begin
 for signature,original,replacement,occurrences in values
  ('public.get_api_strategy_availability(uuid)',$old$fluid_private.api_text_allowance_available(v_owner,operation)$old$,$new$fluid_private.api_text_project_allowance_available(v_owner,operation,p_project_id)$new$,1),
  ('public.get_api_strategy_availability(uuid)',$old$if exists(select 1 from fluid_private.api_text_owner_entitlements where owner_id=v_owner) then
  return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','budget_unavailable');$old$,$new$if exists(select 1 from fluid_private.api_text_owner_entitlements where owner_id=v_owner) then
  if exists(select 1 from fluid_private.api_text_testing_access t where t.owner_id=v_owner
   and fluid_private.api_text_testing_enabled(v_owner,t.operation)
   and fluid_private.api_text_strategy_paused(v_owner,t.operation,p_project_id)) then
   return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','request_unresolved');
  end if;
  if exists(select 1 from fluid_private.api_text_testing_access t where t.owner_id=v_owner
   and fluid_private.api_text_testing_enabled(v_owner,t.operation)
   and exists(select 1 from public.jobs j where j.owner_id=v_owner and j.billing_mode='openai_api'
    and j.state not in ('succeeded','failed','partial','cancelled')
    and (not fluid_private.api_text_testing_project_scope(v_owner,t.operation,p_project_id)
     or fluid_private.api_text_operation(j.operation) or j.project_id=p_project_id))) then
   return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','request_active');
  end if;
  return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','budget_unavailable');$new$,1),
  ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)',$old$fluid_private.api_text_allowance_available(v_owner,p_operation)$old$,$new$fluid_private.api_text_project_allowance_available(v_owner,p_operation,p_project_id)$new$,2),
  ('fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint)',$old$fluid_private.api_text_paid_paused(v_owner)$old$,$new$fluid_private.api_text_strategy_paused(v_owner,p_operation,p_project_id)$new$,1),
  ('fluid_private.api_text_testing_job_allowed(uuid)',$old$fluid_private.api_text_paid_paused(j.owner_id)$old$,$new$fluid_private.api_text_strategy_paused(j.owner_id,j.operation,j.project_id)$new$,1),
  ('fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)',$old$fluid_private.api_text_paid_paused(p_job.owner_id)$old$,$new$fluid_private.api_text_strategy_paused(p_job.owner_id,p_job.operation,p_job.project_id)$new$,1),
  ('public.check_api_text_runtime(text,jsonb,text)',$old$fluid_private.api_text_paid_paused(v_owner)$old$,$new$fluid_private.api_text_strategy_runtime_paused(v_owner,p_operation,p_policy,p_deployment_id)$new$,1),
  ('public.begin_job_step(uuid,uuid,text,text,bigint)',$old$and not fluid_private.hosted_naming_step_authority(v_job.id) then raise exception 'paid_outcome_unresolved'$old$,$new$and not fluid_private.hosted_naming_step_authority(v_job.id)
  and not fluid_private.api_text_testing_gateway_matches(v_job.owner_id,v_job.operation,v_job.input->'policy',
   (select deployment_id from fluid_private.api_text_dispatches where job_id=v_job.id),v_job.id)
  then raise exception 'paid_outcome_unresolved'$new$,1) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if(length(definition)-length(replace(definition,original,'')))/length(original)<>occurrences then
   raise exception 'unexpected_strategy_isolation_fragment: %',signature;
  end if;
  execute replace(definition,original,replacement);
 end loop;
end $patch$;

-- No new client, service or worker privilege, including permissive defaults.
do $acl$
declare object_id oid; recipient record;
begin
 foreach object_id in array array[
  'fluid_private.api_text_strategy_outcome_resolved(uuid)'::regprocedure,
  'fluid_private.api_text_testing_project_scope(uuid,text,uuid)'::regprocedure,
  'fluid_private.api_text_strategy_paused(uuid,text,uuid)'::regprocedure,
  'fluid_private.api_text_strategy_runtime_paused(uuid,text,jsonb,text)'::regprocedure,
  'fluid_private.api_text_project_allowance_available(uuid,text,uuid)'::regprocedure] loop
  for recipient in select distinct a.grantee from pg_proc p,
   lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,
    case when recipient.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(recipient.grantee)) end);
  end loop;
 end loop;
 if exists(select 1 from strategy_isolation_original_functions old left join pg_proc p on p.oid=old.oid
  where p.oid is null or (p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proleakproof)
   is distinct from (old.proowner,old.proacl,old.prosecdef,old.provolatile,old.proconfig,old.proleakproof)) then
  raise exception 'strategy_isolation_security_changed';
 end if;
end $acl$;
commit;
