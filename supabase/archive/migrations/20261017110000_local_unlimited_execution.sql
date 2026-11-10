-- Explicit local prototype authorization removes monetary admission/execution
-- ceilings. Existing ledger values, immutable calls and historical holds remain.
-- Hosted and unmarked work retain their current monetary policy.
begin;
do $guard$
declare signature text; expected text; definer boolean; volatility text;
begin
 for signature,expected,definer,volatility in values
 ('public.enqueue_job(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)','070c1bf2896a8003a9243e148e76fc92',true,'v'),
 ('public.enqueue_local_strategy_job(uuid,integer,text,text,bigint)','bb0d21cb93f114c955dfe7fd16177abd',true,'v'),
 ('public.get_local_strategy_availability(uuid)','19f7d3a4668d618bfe91388caeab0563',true,'v'),
 ('fluid_private.claim_local_strategy_job(text,integer)','07d8c5d84585c35e5eaab4e5e1410012',false,'v'),
 ('fluid_private.local_prototype_project_paused(uuid,uuid)','3b9359e233da928a7c77645a56408b74',false,'s'),
 ('public.begin_job_step(uuid,uuid,text,text,bigint)','f149d0c1876ba4baeaf4ea8449240171',true,'v'),
 ('fluid_private.complete_job_step_core(uuid,uuid,text,text,bigint,jsonb,text)','82007fa0cda14154f3537a62a8d49bab',true,'v'),
 ('fluid_private.naming_brain_paid_resume(fluid_private.naming_brain_runs)','876ca8aedda127ffe7f3abc897c6cb9b',false,'s'),
 ('fluid_private.naming_brain_saved_usable(fluid_private.naming_brain_runs)','673988819abafb7a0945098ff2b60cd7',false,'s'),
 ('fluid_private.naming_brain_preparation_pending(fluid_private.naming_brain_runs)','7ea2099f43f0e262a0e6ac034b8ac7d5',false,'s'),
 ('public.claim_naming_brain_job(text,text,integer)','9dfa7be5d6708919613708eed87a34c6',true,'v'),
 ('public.expire_naming_brain_leases(text,text)','4d9f3b49222bda432e37dd65014a88d5',true,'v'),
 ('public.ensure_naming_brain_run(uuid,jsonb)','bb0dbaf91c81daf5366767f47904e6f0',true,'v'),
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)','bee903b84279b1231fe60e4aee08fc8f',true,'v'),
 ('public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)','226003506625321f0680bca517fb596b',true,'v'),
 ('public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb)','feec2c371105d525be50aab27742a4d8',true,'v'),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)','40a1ddc9305133bf3c577d37798e3d4d',true,'v'),
 ('public.append_prepared_naming_set(uuid,uuid)','d9c58873b8816a0078379ae004af3752',true,'v') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.prosecdef=definer and p.provolatile::text=volatility and p.proconfig=array['search_path=""']
   and not p.proleakproof and p.proowner=(select oid from pg_roles where rolname=current_user)) then raise exception 'unexpected_local_unlimited_predecessor: %',signature; end if;
 end loop;
end $guard$;

-- Reuse the existing private transaction witness and immutable local-job marker.
-- Neither a client JSON property nor a session setting grants this authority.
create function fluid_private.local_prototype_unlimited_context(p_owner uuid,p_project uuid) returns boolean
language sql stable set search_path='' as $$
 select fluid_private.local_prototype_owner_enabled(p_owner) and exists(
  select 1 from fluid_private.local_prototype_admission_context c
  where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.owner_id=p_owner and c.project_id=p_project);
$$;
create function fluid_private.local_prototype_unlimited_job(p_job uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.local_prototype_jobs marker join public.jobs j on j.id=marker.job_id and j.owner_id=marker.owner_id and j.project_id=marker.project_id
 where marker.job_id=p_job and fluid_private.local_prototype_owner_enabled(marker.owner_id)
 and fluid_private.api_text_restricted_role(marker.role_name,marker.role_oid)
 and (exists(select 1 from fluid_private.local_prototype_strategy_capabilities c where c.owner_id=marker.owner_id and c.operation=j.operation
  and c.role_name=marker.role_name and c.role_oid=marker.role_oid and c.deployment_id=marker.deployment_id)
 or exists(select 1 from fluid_private.naming_brain_runs r where r.job_id=j.id and r.owner_id=marker.owner_id and r.project_id=marker.project_id
  and r.admitted_role_name=marker.role_name and r.admitted_role_oid=marker.role_oid and r.deployment_id=marker.deployment_id)));
$$;

do $patch$
declare signature text; original text; replacement text; definition text;
begin
 for signature,original,replacement in values
 -- Strategy keeps its conventional durable reservation bookkeeping.
 ('public.enqueue_local_strategy_job(uuid,integer,text,text,bigint)',
 $old$ select * into j from public.enqueue_job(o,p_project_id,p_operation,p_expected_revision,input_hash,input,p_idempotency_key,maximum,3);$old$,
 $new$ insert into fluid_private.local_prototype_admission_context values(pg_backend_pid(),txid_current(),o,p_project_id);
 select * into j from public.enqueue_job(o,p_project_id,p_operation,p_expected_revision,input_hash,input,p_idempotency_key,maximum,3);
 delete from fluid_private.local_prototype_admission_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();$new$),
 ('public.enqueue_job(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)',
 $old$and not fluid_private.api_text_testing_enqueue_matches(p_owner_id,p_project_id,p_operation,p_input_revision,p_input_hash,p_input,p_idempotency_key,p_max_cost_microusd,p_max_attempts))$old$,
 $new$and not fluid_private.api_text_testing_enqueue_matches(p_owner_id,p_project_id,p_operation,p_input_revision,p_input_hash,p_input,p_idempotency_key,p_max_cost_microusd,p_max_attempts)
    and not (fluid_private.local_prototype_unlimited_context(p_owner_id,p_project_id) and fluid_private.api_text_guided_policy(p_operation,p_input->'policy')
     and p_max_cost_microusd=(p_input#>>'{policy,maximumCostMicrousd}')::bigint and p_max_attempts=3))$new$),
 ('public.get_local_strategy_availability(uuid)',
 $old$ and (c.policy->>'maximumCostMicrousd')::bigint<=a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd)-a.reserved_microusd$old$,$new$$new$),
 ('fluid_private.claim_local_strategy_job(text,integer)',
 $old$ and a.reserved_microusd<=a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd)$old$,$new$$new$),
 ('fluid_private.local_prototype_project_paused(uuid,uuid)',
 $old$(j.actual_cost_microusd>j.reserved_cost_microusd or ((j.state='needs_reconciliation'$old$,
 $new$(((j.state='needs_reconciliation' and j.error_code is distinct from 'cost_overrun' and j.error_code is distinct from 'provider_cost_exceeded'$new$),
 ('public.begin_job_step(uuid,uuid,text,text,bigint)',
 $old$and not fluid_private.api_text_testing_job_allowed(v_job.id) then$old$,
 $new$and not fluid_private.api_text_testing_job_allowed(v_job.id) and not fluid_private.local_prototype_unlimited_job(v_job.id) then$new$),
 ('public.begin_job_step(uuid,uuid,text,text,bigint)',
 $old$or p_max_cost_microusd > v_job.reserved_cost_microusd - v_job.actual_cost_microusd - v_pending then$old$,
 $new$or (p_max_cost_microusd > v_job.reserved_cost_microusd - v_job.actual_cost_microusd - v_pending and not fluid_private.local_prototype_unlimited_job(v_job.id)) then$new$),
 ('fluid_private.complete_job_step_core(uuid,uuid,text,text,bigint,jsonb,text)',
 $old$or p_actual_cost_microusd > v_step.reserved_cost_microusd then$old$,
 $new$or (p_actual_cost_microusd > v_step.reserved_cost_microusd and not fluid_private.local_prototype_unlimited_job(p_job_id)) then$new$),
 -- Naming admission is local only inside its authenticated wrapper transaction.
 ('public.ensure_naming_brain_run(uuid,jsonb)',
 $old$or exists(select 1 from fluid_private.naming_brain_runs where owner_id=o and observed_overrun) then$old$,
 $new$or (not fluid_private.local_prototype_unlimited_context(o,p.id) and exists(select 1 from fluid_private.naming_brain_runs where owner_id=o and observed_overrun)) then$new$),
 ('public.ensure_naming_brain_run(uuid,jsonb)',
 $old$if allowance+5000000>pilot.allowance_microusd then$old$,
 $new$if allowance+5000000>pilot.allowance_microusd and not fluid_private.local_prototype_unlimited_context(o,p.id) then$new$),
 ('public.ensure_naming_brain_run(uuid,jsonb)',
 $old$if not found or account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)-account.reserved_microusd<5000000 then$old$,
 $new$if not found or (account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)-account.reserved_microusd<5000000 and not fluid_private.local_prototype_unlimited_context(o,p.id)) then$new$),
 ('fluid_private.naming_brain_paid_resume(fluid_private.naming_brain_runs)',
 $old$and not exists(select 1 from fluid_private.naming_brain_runs bad where bad.owner_id=r.owner_id and bad.observed_overrun)$old$,
 $new$and (fluid_private.local_prototype_unlimited_job(r.job_id) or not exists(select 1 from fluid_private.naming_brain_runs bad where bad.owner_id=r.owner_id and bad.observed_overrun))$new$),
 ('fluid_private.naming_brain_paid_resume(fluid_private.naming_brain_runs)',
 $old$and (select coalesce(sum(coalesce(actual_cost_microusd,5000000)),0) from fluid_private.naming_brain_runs where pilot_id=pilot.id)+5000000<=pilot.allowance_microusd
 and account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)-account.reserved_microusd>=5000000$old$,
 $new$and (fluid_private.local_prototype_unlimited_job(r.job_id) or (
 (select coalesce(sum(coalesce(actual_cost_microusd,5000000)),0) from fluid_private.naming_brain_runs where pilot_id=pilot.id)+5000000<=pilot.allowance_microusd
 and account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)-account.reserved_microusd>=5000000))$new$),
 ('public.claim_naming_brain_job(text,text,integer)',
 $old$and not exists(select 1 from fluid_private.naming_brain_runs overrun where overrun.owner_id=o and overrun.observed_overrun)$old$,
 $new$and (fluid_private.local_prototype_unlimited_job(r0.job_id) or not exists(select 1 from fluid_private.naming_brain_runs overrun where overrun.owner_id=o and overrun.observed_overrun))$new$),
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)',
 $old$or exists(select 1 from fluid_private.naming_brain_runs where owner_id=r.owner_id and observed_overrun)$old$,
 $new$or (not fluid_private.local_prototype_unlimited_job(r.job_id) and exists(select 1 from fluid_private.naming_brain_runs where owner_id=r.owner_id and observed_overrun))$new$),
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)',
 $old$ phase:=case when stage<>'gap'$old$,
 $new$ if p_request#>'{policy,budgetControl}' is not null and (p_request#>>'{policy,budgetControl}' is distinct from 'local_unlimited_v1'
 or not fluid_private.local_prototype_unlimited_job(r.job_id)) then raise exception 'invalid_local_execution_mode' using errcode='22023'; end if;
 phase:=case when stage<>'gap'$new$),
 ('public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)',
 $old$or p_receipt->'sessionLimitCents' is distinct from c.request#>'{policy,sessionLimitCents}'$old$,
 $new$or p_receipt->'sessionLimitCents' is distinct from c.request#>'{policy,sessionLimitCents}'
 or p_receipt->'budgetControl' is distinct from c.request#>'{policy,budgetControl}'$new$),
 ('public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)',
 $old$ if exists(select 1 from jsonb_array_elements(coalesce(p_receipt->'providerCostCounters','[]'))$old$,
 $new$ if not fluid_private.local_prototype_unlimited_job(r.job_id) and exists(select 1 from jsonb_array_elements(coalesce(p_receipt->'providerCostCounters','[]'))$new$),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)',
 $old$or exists(select 1 from fluid_private.naming_brain_runs bad where bad.owner_id=r.owner_id and bad.observed_overrun)$old$,
 $new$or (not fluid_private.local_prototype_unlimited_job(r.job_id) and exists(select 1 from fluid_private.naming_brain_runs bad where bad.owner_id=r.owner_id and bad.observed_overrun))$new$),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)',
 $old$(other.actual_cost_microusd>other.reserved_cost_microusd or ((other.id<>j.id and other.state='needs_reconciliation')$old$,
 $new$((other.actual_cost_microusd>other.reserved_cost_microusd and not fluid_private.local_prototype_unlimited_job(r.job_id)) or ((other.id<>j.id and other.state='needs_reconciliation'
 and (not fluid_private.local_prototype_unlimited_job(r.job_id) or other.error_code is distinct from 'cost_overrun' and other.error_code is distinct from 'provider_cost_exceeded'))$new$),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)',
 $old$and account.reserved_microusd<=account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)) then$old$,
 $new$and (fluid_private.local_prototype_unlimited_job(r.job_id) or account.reserved_microusd<=account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd))) then$new$),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)',
 $old$or (x->>'sessionLimitCents')::integer not between 1 and 150$old$,
 $new$or (x->>'sessionLimitCents')::integer<1 or ((x->>'sessionLimitCents')::integer>150 and not fluid_private.local_prototype_unlimited_job(r.job_id))$new$),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)',
 $old$if (select sum((x->>'sessionLimitCents')::integer)*10000 from jsonb_array_elements(p_payload->'calls') x)>phase_cap*10000$old$,
 $new$if ((select sum((x->>'sessionLimitCents')::integer)*10000 from jsonb_array_elements(p_payload->'calls') x)>phase_cap*10000 and not fluid_private.local_prototype_unlimited_job(r.job_id))$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_local_unlimited_fragment: %',signature; end if;
  execute replace(definition,original,replacement);
 end loop;

 -- Keep recorded overrun observations immutable, while they cease to be local
 -- execution gates. Unknown provider calls and leases remain independently fenced.
 for signature in select unnest(array[
 'fluid_private.naming_brain_paid_resume(fluid_private.naming_brain_runs)',
 'fluid_private.naming_brain_saved_usable(fluid_private.naming_brain_runs)',
 'fluid_private.naming_brain_preparation_pending(fluid_private.naming_brain_runs)',
 'public.expire_naming_brain_leases(text,text)',
 'public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)',
 'public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb)',
 'public.naming_brain_worker_action(uuid,uuid,text,jsonb)',
 'public.append_prepared_naming_set(uuid,uuid)']) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if position('r.observed_overrun' in definition)=0 then raise exception 'unexpected_local_overrun_fragment: %',signature; end if;
  execute replace(definition,'r.observed_overrun','(r.observed_overrun and not fluid_private.local_prototype_unlimited_job(r.job_id))');
 end loop;
 definition:=pg_get_functiondef('public.claim_naming_brain_job(text,text,integer)'::regprocedure);
 if position('r0.observed_overrun' in definition)=0 then raise exception 'unexpected_local_claim_overrun_fragment'; end if;
 execute replace(definition,'r0.observed_overrun','(r0.observed_overrun and not fluid_private.local_prototype_unlimited_job(r0.job_id))');
end $patch$;

do $deny$
declare object_id oid; privilege record;
begin
 for object_id in select unnest(array['fluid_private.local_prototype_unlimited_context(uuid,uuid)'::regprocedure,'fluid_private.local_prototype_unlimited_job(uuid)'::regprocedure]) loop
  for privilege in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
  end loop;
 end loop;
end $deny$;
commit;
