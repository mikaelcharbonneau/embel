-- REVIEW PACKET ONLY. Run only after independent source review and lead release.
-- No credentials, account funding, historical job change or provider call.
begin;
do $preflight$
declare p fluid_private.naming_brain_pilots; count integer;
begin
 if not exists(select 1 from pg_roles where rolname='fluid_naming_brain_worker' and oid=23033
  and fluid_private.api_text_restricted_role(rolname,oid)) then raise exception 'local_worker_identity_mismatch'; end if;
 select * into p from fluid_private.naming_brain_pilots where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42';
 if not found or p.role_name<>'fluid_naming_brain_worker' or p.role_oid<>23033
  or p.deployment_id<>'embel-naming-local-b2ff6ce8bbc2-20261017'
  or p.policy->>'model'<>'gpt-6.1-sol' or p.policy->>'reasoningEffort'<>'xhigh'
  or p.allowance_microusd<>25000000 or p.policy->>'runAllowanceMicrousd'<>'5000000' then raise exception 'local_naming_pilot_mismatch'; end if;
 if exists(select 1 from fluid_private.local_prototype_strategy_capabilities) then raise exception 'local_capabilities_already_present'; end if;
 select count(*) into count from fluid_private.strategy_runtime_policy
 where operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')
 and enabled and fluid_private.api_text_guided_policy(operation,policy) and policy->>'model'='gpt-6.1-sol';
 if count<>4 then raise exception 'local_guided_policies_mismatch'; end if;
 -- Keep the production Strategy worker's exact existing bindings unchanged.
 select count(*) into count from fluid_private.api_strategy_bindings b join fluid_private.strategy_runtime_policy runtime on runtime.operation=b.operation
 where b.owner_id=p.owner_id and b.role_oid=21484 and b.enabled
 and b.operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')
 and b.policy_identity=encode(sha256(convert_to(runtime.policy::text,'UTF8')),'hex');
 if count<>4 then raise exception 'hosted_strategy_bindings_changed'; end if;
 if exists(select 1 from fluid_private.local_prototype_jobs) or exists(select 1 from fluid_private.local_prototype_admission_context) then raise exception 'unexpected_local_job_state'; end if;
 if has_function_privilege('fluid_naming_brain_worker','public.heartbeat_job(uuid,uuid,integer)','EXECUTE')
 or has_function_privilege('fluid_naming_brain_worker','public.register_job_plan(uuid,uuid,jsonb)','EXECUTE')
 or has_function_privilege('fluid_naming_brain_worker','public.begin_job_step(uuid,uuid,text,text,bigint)','EXECUTE')
 or has_function_privilege('fluid_naming_brain_worker','public.complete_job_step(uuid,uuid,text,text,bigint,jsonb,text)','EXECUTE')
 or has_function_privilege('fluid_naming_brain_worker','public.finish_job(uuid,uuid,text,text)','EXECUTE') then raise exception 'unexpected_generic_naming_mutation_grant'; end if;
end $preflight$;

insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled)
select p.owner_id,runtime.operation,p.role_name,p.role_oid,p.deployment_id,runtime.policy,true
from fluid_private.naming_brain_pilots p cross join fluid_private.strategy_runtime_policy runtime
where p.owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
and runtime.operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality');

-- The existing login gains only the scoped Strategy lifecycle and metadata RPCs.
-- Every mutation/read checks the frozen local marker and exact role identity.
grant execute on function
 public.report_strategy_worker_ready(text,jsonb,integer),
 public.claim_job(text,integer),
 public.local_strategy_job_action(uuid,text,jsonb),
 public.expire_job_leases(),
 public.read_local_strategy_steps(uuid,uuid,uuid,text)
to fluid_naming_brain_worker;
commit;

-- Read-back must show four enabled capabilities with NULL heartbeat, no table
-- SELECT privilege, the same pilot/ledger/history, and exactly five added RPCs.
select operation,enabled,ready_until is null as awaiting_heartbeat,
 role_name='fluid_naming_brain_worker' and role_oid=23033 as exact_worker,
 policy->>'model' as model,policy->>'handlerVersion' as handler
from fluid_private.local_prototype_strategy_capabilities
where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42' order by operation;
select has_table_privilege('fluid_naming_brain_worker','public.job_steps','SELECT') as direct_steps_read,
 has_table_privilege('fluid_naming_brain_worker','fluid_private.local_prototype_jobs','SELECT') as direct_local_jobs_read;
