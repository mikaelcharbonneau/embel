-- Owner-requested deletion may quarantine an abandoned, unleased Strategy
-- request from a DIFFERENT active project's existing testing lane. Unknown
-- provider outcomes and every original reservation remain unresolved/intact.
-- This does not enable an account, resume the old job, or settle any spending.
begin;
create temporary table strategy_quarantine_original_functions on commit drop as
 select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof from pg_proc
 where oid in (
  'fluid_private.api_text_strategy_paused(uuid,text,uuid)'::regprocedure,
  'fluid_private.api_text_project_allowance_available(uuid,text,uuid)'::regprocedure,
  'public.get_api_strategy_availability(uuid)'::regprocedure,
  'public.check_api_text_runtime(text,jsonb,text)'::regprocedure,
  'fluid_private.api_text_allowance_paused()'::regprocedure,
  'fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)'::regprocedure,
  'fluid_private.api_text_testing_job_allowed(uuid)'::regprocedure,
  'fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)'::regprocedure,
  'fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint)'::regprocedure,
  'public.api_text_multi_account_readiness(jsonb,text)'::regprocedure);
do $guard$
declare signature text; expected text; definer boolean; volatility text;
begin
 for signature,expected,definer,volatility in values
  ('fluid_private.api_text_strategy_paused(uuid,text,uuid)','f92b3f29beeb66f21fb122dc33e24b4c',false,'s'),
  ('fluid_private.api_text_project_allowance_available(uuid,text,uuid)','91eb81789b182ae9a0966069b41bcaa0',false,'s'),
  ('public.get_api_strategy_availability(uuid)','9f686404b6cac300b451b40c63257e69',true,'v'),
  ('public.check_api_text_runtime(text,jsonb,text)','72bf2cb40d78bdf5e00f54caa0990f1f',true,'v'),
  ('fluid_private.api_text_allowance_paused()','e0721ff6199194ef1a29c4d7fe34b2de',false,'s'),
  ('fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)','39c9fff5707f512c9a9eca7197797bfe',false,'s'),
  ('fluid_private.api_text_testing_job_allowed(uuid)','ee43c916b17c63f46de2da6f7b0eb1b9',false,'s'),
  ('fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)','f3be3bad42a551002b8bca6a7349ed8d',false,'s'),
  ('fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint)','b2aefa8afede9cff5493e0c86b1f0232',true,'v'),
  ('public.api_text_multi_account_readiness(jsonb,text)','6396e0129680873d1d5e20945f7cc421',true,'v') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure
   and md5(p.prosrc)=expected and p.prosecdef=definer and p.provolatile::text=volatility
   and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.proowner=(select oid from pg_roles where rolname=current_user)) then
   raise exception 'unexpected_strategy_quarantine_predecessor: %',signature;
  end if;
 end loop;
end $guard$;

-- A read-only quarantine decision, NOT proof of cancellation, non-dispatch or
-- settled provider billing. Restore immediately removes the exception. A
-- retained lease, even expired, must first follow normal expiry/recovery.
create function fluid_private.api_text_deleted_strategy_quarantined(
 p_owner uuid,p_operation text,p_project uuid,p_job uuid)
returns boolean language sql stable set search_path='' as $$
 select coalesce(fluid_private.api_text_testing_project_scope(p_owner,p_operation,p_project)
  and exists(select 1 from public.projects target
   where target.id=p_project and target.owner_id=p_owner
    and target.deleted_at is null and target.deletion_requested_at is null)
  and exists(select 1 from public.jobs j
   join public.projects old on old.id=j.project_id and old.owner_id=j.owner_id
   join fluid_private.api_text_testing_admissions marker on marker.job_id=j.id
   join fluid_private.api_text_allowance_admissions admission on admission.job_id=j.id and admission.owner_id=j.owner_id
   join fluid_private.api_text_dispatches dispatch on dispatch.job_id=j.id
    and dispatch.owner_id=j.owner_id and dispatch.project_id=j.project_id
   join public.usage_reservations reservation on reservation.job_id=j.id
    and reservation.owner_id=j.owner_id and reservation.project_id=j.project_id
   join public.usage_accounts ledger on ledger.owner_id=j.owner_id
   where j.id=p_job and j.owner_id=p_owner and j.project_id<>p_project
    and j.billing_mode='openai_api' and fluid_private.api_text_operation(j.operation)
    and old.deletion_requested_at is not null and j.cancel_requested_at is not null
    and j.state='needs_reconciliation' and j.lease_token is null and j.lease_expires_at is null
    and j.actual_cost_microusd<=j.reserved_cost_microusd
    and coalesce(j.error_code,'') not in ('cost_overrun','provider_cost_exceeded')
    and reservation.state='active' and reservation.reserved_microusd=j.reserved_cost_microusd
    and reservation.reserved_microusd=admission.maximum_cost_microusd
    and reservation.actual_microusd=j.actual_cost_microusd
    and reservation.captured_microusd=least(reservation.reserved_microusd,reservation.actual_microusd)
    and ledger.reserved_microusd>=greatest(reservation.reserved_microusd-reservation.actual_microusd,0)
    and ledger.reserved_microusd=(select coalesce(sum(greatest(held.reserved_microusd-held.actual_microusd,0)),0)
     from public.usage_reservations held where held.owner_id=j.owner_id and held.state='active')),false);
$$;

-- Preserve the rollout-wide scan, including every other owner's uncertainty
-- and every admitted overrun. Only this target's exact quarantine may differ.
-- The original global helper is deliberately not modified.
create function fluid_private.api_text_project_allowance_paused(p_owner uuid,p_operation text,p_project uuid)
returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.api_text_allowance_admissions a join public.jobs j on j.id=a.job_id
  where j.actual_cost_microusd>a.maximum_cost_microusd or
   ((j.state='needs_reconciliation' or exists(select 1 from public.job_steps s where s.job_id=j.id and s.state='ambiguous'))
    and not fluid_private.research_operator_adjudication_matches(j.id)
    and not fluid_private.api_text_deleted_strategy_quarantined(p_owner,p_operation,p_project,j.id)));
$$;

-- The pinned policy predecessor's complete body, with ONLY its pause lookup
-- replaced by the scoped scan. No role, route, policy, entitlement, cohort,
-- deployment, expiry or legacy branch is removed. Ordinary/null scope is exact.
create function fluid_private.api_text_project_policy_allowed(
 p_owner uuid,p_operation text,p_policy jsonb,p_deployment text,p_project uuid,p_role oid default null)
returns boolean language sql stable set search_path='' as $$
 select (not exists(select 1 from fluid_private.api_text_owner_entitlements where owner_id=p_owner)
  and fluid_private.api_text_legacy_policy_allowed(p_owner,p_operation,p_policy,p_deployment,p_role))
 or coalesce(not fluid_private.api_text_project_allowance_paused(p_owner,p_operation,p_project) and fluid_private.api_text_request_policy(p_owner,p_operation,p_policy) and exists(
  select 1 from fluid_private.api_text_owner_entitlements e
  join fluid_private.api_text_allowance_cohorts c on c.id=e.cohort_id
  join fluid_private.api_text_allowance_rollout r on r.singleton
  join fluid_private.api_strategy_bindings b on b.owner_id=e.owner_id and b.operation=p_operation
  join fluid_private.strategy_runtime_policy p on p.operation=p_operation
  join fluid_private.strategy_billing_routes route on route.owner_id=e.owner_id
  where e.owner_id=p_owner and e.enabled and c.enabled and r.enabled
   and ((e.expires_at>clock_timestamp() and c.expires_at>clock_timestamp())
    or fluid_private.api_text_testing_enabled(p_owner,p_operation))
   and p_operation=any(c.operations) and p.enabled and p.policy=p_policy and b.enabled
   and b.role_oid=c.role_oid and (p_role is null or p_role=c.role_oid)
   and fluid_private.api_text_restricted_role(c.role_name,c.role_oid)
   and b.deployment_id=p_deployment and c.deployment_id=p_deployment
   and b.policy_identity=encode(sha256(convert_to(p_policy::text,'UTF8')),'hex')
   and route.billing_mode='openai_api'),false);
$$;

create function fluid_private.api_text_testing_gateway_project(
 p_owner uuid,p_operation text,p_policy jsonb,p_deployment text)
returns uuid language sql stable set search_path='' as $$
 select target.project_id from fluid_private.api_text_gateway_context context
  join public.jobs target on target.id=context.job_id and target.owner_id=context.owner_id
  join fluid_private.api_text_dispatches dispatch on dispatch.job_id=target.id
   and dispatch.owner_id=target.owner_id and dispatch.project_id=target.project_id
  where context.backend_pid=pg_backend_pid() and context.transaction_id=txid_current()
   and context.role_name=session_user and fluid_private.api_text_restricted_role(context.role_name,context.role_oid)
   and context.owner_id=p_owner and target.operation=p_operation and target.input->'policy'=p_policy
   and dispatch.deployment_id=p_deployment
   and fluid_private.api_text_testing_gateway_matches(p_owner,p_operation,p_policy,p_deployment,target.id);
$$;

-- No caller-provided project may exempt a runtime request. The existing exact
-- gateway and immutable testing admission derive the target and authority.
create function fluid_private.api_text_deleted_strategy_runtime_quarantined(
 p_owner uuid,p_operation text,p_policy jsonb,p_deployment text,p_job uuid)
returns boolean language sql stable set search_path='' as $$
 select fluid_private.api_text_deleted_strategy_quarantined(p_owner,p_operation,
  fluid_private.api_text_testing_gateway_project(p_owner,p_operation,p_policy,p_deployment),p_job);
$$;

-- Operational readiness only, not admission or dispatch authority. The existing
-- readiness branch is retained. An additional witness exists only for this
-- exact restricted worker/policy/deployment and a current testing owner with an
-- active target plus an actually quarantined old request. Raw runtime without
-- a trusted gateway still uses the original global pause and remains refused.
create function fluid_private.api_text_quarantine_worker_ready(
 p_operation text,p_policy jsonb,p_deployment text,p_role oid)
returns boolean language sql stable set search_path='' as $$
 select coalesce(p_role=(select oid from pg_catalog.pg_roles where rolname=session_user)
  and fluid_private.api_text_restricted_role(session_user,p_role)
  and exists(select 1 from fluid_private.api_text_testing_access testing
   join public.projects target on target.owner_id=testing.owner_id
   where testing.operation=p_operation and fluid_private.api_text_testing_enabled(testing.owner_id,p_operation)
    and target.deleted_at is null and target.deletion_requested_at is null
    and fluid_private.api_text_project_policy_allowed(testing.owner_id,p_operation,p_policy,p_deployment,target.id,p_role)
    and not fluid_private.api_text_strategy_paused(testing.owner_id,p_operation,target.id)
    and exists(select 1 from public.jobs old where old.owner_id=testing.owner_id
     and fluid_private.api_text_deleted_strategy_quarantined(testing.owner_id,p_operation,target.id,old.id))),false);
$$;

-- One predicate at the uncertainty, active-slot and same-operation runtime
-- gates. Owner-wide actual/observed overruns remain outside the exception.
-- Original ordinary-account, null-project, policy and permission gates remain.
do $patch$
declare signature text; original text; replacement text; definition text;
begin
 for signature,original,replacement in values
  ('fluid_private.api_text_project_allowance_available(uuid,text,uuid)',
   $old$fluid_private.api_text_allowance_paused()$old$,
   $new$fluid_private.api_text_project_allowance_paused(p_owner,p_operation,p_project)$new$),
  ('fluid_private.api_text_project_allowance_available(uuid,text,uuid)',
   $old$fluid_private.api_text_policy_allowed(p_owner,p_operation,
    (select policy from fluid_private.strategy_runtime_policy where operation=p_operation),c.deployment_id,c.role_oid)$old$,
   $new$fluid_private.api_text_project_policy_allowed(p_owner,p_operation,
    (select policy from fluid_private.strategy_runtime_policy where operation=p_operation),c.deployment_id,p_project,c.role_oid)$new$),
  ('fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint)',
   $old$fluid_private.api_text_policy_allowed(v_owner,p_operation,v_policy.policy,v_binding.deployment_id)$old$,
   $new$fluid_private.api_text_project_policy_allowed(v_owner,p_operation,v_policy.policy,v_binding.deployment_id,p_project_id)$new$),
  ('fluid_private.api_text_testing_job_allowed(uuid)',
   $old$fluid_private.api_text_policy_allowed(j.owner_id,j.operation,j.input->'policy',d.deployment_id,a.role_oid)$old$,
   $new$fluid_private.api_text_project_policy_allowed(j.owner_id,j.operation,j.input->'policy',d.deployment_id,j.project_id,a.role_oid)$new$),
  ('fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)',
   $old$fluid_private.api_text_policy_allowed(p_job.owner_id,p_job.operation,p_job.input->'policy',p_dispatch.deployment_id,(select oid from pg_catalog.pg_roles where rolname=session_user))$old$,
   $new$fluid_private.api_text_project_policy_allowed(p_job.owner_id,p_job.operation,p_job.input->'policy',p_dispatch.deployment_id,
    case when exists(select 1 from fluid_private.api_text_testing_admissions where job_id=p_job.id) then p_job.project_id else null end,
    (select oid from pg_catalog.pg_roles where rolname=session_user))$new$),
  ('public.check_api_text_runtime(text,jsonb,text)',
   $old$fluid_private.api_text_policy_allowed(v_owner,p_operation,p_policy,p_deployment_id,(select oid from pg_catalog.pg_roles where rolname=session_user))$old$,
   $new$fluid_private.api_text_project_policy_allowed(v_owner,p_operation,p_policy,p_deployment_id,
  fluid_private.api_text_testing_gateway_project(v_owner,p_operation,p_policy,p_deployment_id),
  (select oid from pg_catalog.pg_roles where rolname=session_user))$new$),
  ('public.api_text_multi_account_readiness(jsonb,text)',
   $old$and c.deployment_id=p_deployment and candidate->>'operation'=any(c.operations) and p.enabled and p.policy=candidate->'policy'));$old$,
   $new$and c.deployment_id=p_deployment and candidate->>'operation'=any(c.operations) and p.enabled and p.policy=candidate->'policy'));
  ready:=ready or fluid_private.api_text_quarantine_worker_ready(operation,candidate->'policy',p_deployment,v_role);$new$),
  ('fluid_private.api_text_strategy_paused(uuid,text,uuid)',
   $old$and not fluid_private.api_text_strategy_outcome_resolved(j.id))))$old$,
   $new$and not fluid_private.api_text_strategy_outcome_resolved(j.id)
     and not fluid_private.api_text_deleted_strategy_quarantined(p_owner,p_operation,p_project,j.id))))$new$),
  ('fluid_private.api_text_project_allowance_available(uuid,text,uuid)',
   $old$or fluid_private.api_text_operation(operation) or project_id=p_project);$old$,
   $new$or fluid_private.api_text_operation(operation) or project_id=p_project)
  and not fluid_private.api_text_deleted_strategy_quarantined(p_owner,p_operation,p_project,id);$new$),
  ('public.get_api_strategy_availability(uuid)',
   $old$or fluid_private.api_text_operation(j.operation) or j.project_id=p_project_id))) then$old$,
   $new$or fluid_private.api_text_operation(j.operation) or j.project_id=p_project_id)
    and not fluid_private.api_text_deleted_strategy_quarantined(v_owner,t.operation,p_project_id,j.id))) then$new$),
  ('public.check_api_text_runtime(text,jsonb,text)',
   $old$and not fluid_private.api_text_testing_gateway_matches(v_owner,p_operation,p_policy,p_deployment_id,testing_job.id))$old$,
   $new$and not fluid_private.api_text_testing_gateway_matches(v_owner,p_operation,p_policy,p_deployment_id,testing_job.id)
   and not fluid_private.api_text_deleted_strategy_runtime_quarantined(v_owner,p_operation,p_policy,p_deployment_id,testing_job.id))$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
   raise exception 'unexpected_strategy_quarantine_fragment: %',signature;
  end if;
  execute replace(definition,original,replacement);
 end loop;
end $patch$;

-- Preserve every existing signature/OID/security descriptor and revoke even
-- hostile default privileges from the new private, non-definer helpers.
do $acl$
declare object_id oid; recipient record;
begin
 foreach object_id in array array[
  'fluid_private.api_text_deleted_strategy_quarantined(uuid,text,uuid,uuid)'::regprocedure,
  'fluid_private.api_text_project_allowance_paused(uuid,text,uuid)'::regprocedure,
  'fluid_private.api_text_project_policy_allowed(uuid,text,jsonb,text,uuid,oid)'::regprocedure,
  'fluid_private.api_text_testing_gateway_project(uuid,text,jsonb,text)'::regprocedure,
  'fluid_private.api_text_deleted_strategy_runtime_quarantined(uuid,text,jsonb,text,uuid)'::regprocedure,
  'fluid_private.api_text_quarantine_worker_ready(text,jsonb,text,oid)'::regprocedure] loop
  for recipient in select distinct a.grantee from pg_proc p,
   lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,
    case when recipient.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(recipient.grantee)) end);
  end loop;
 end loop;
 if exists(select 1 from strategy_quarantine_original_functions old left join pg_proc p on p.oid=old.oid
  where p.oid is null or (p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proleakproof)
   is distinct from (old.proowner,old.proacl,old.prosecdef,old.provolatile,old.proconfig,old.proleakproof)) then
  raise exception 'strategy_quarantine_security_changed';
 end if;
 if md5((select prosrc from pg_proc where oid='fluid_private.api_text_allowance_paused()'::regprocedure))<>'e0721ff6199194ef1a29c4d7fe34b2de'
  or md5((select prosrc from pg_proc where oid='fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)'::regprocedure))<>'39c9fff5707f512c9a9eca7197797bfe' then
  raise exception 'strategy_quarantine_global_guard_changed';
 end if;
end $acl$;
commit;
