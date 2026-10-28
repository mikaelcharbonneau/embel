-- UNAPPLIED. Fixed-slot Strategy bridge after shared_worker_pool.sql and the
-- existing migrations. No per-customer roles, secrets, grants or monetary caps.
-- Legacy jobs retain their exact contracts. New admissions have a private,
-- immutable shared sidecar; a client label alone never grants uncapped work.
begin;
create table fluid_private.shared_strategy_admission_context (
 backend_pid integer not null,transaction_id bigint not null,owner_id uuid not null,
 project_id uuid not null,operation text not null,input_revision integer not null,
 input_hash text not null,input jsonb not null,idempotency_key text not null,maximum_microusd bigint not null,
 primary key(backend_pid,transaction_id)
);
-- An actual handler future can settle after its runner recorded an ambiguous
-- timeout. Retain that observed outcome separately; never rewrite the original
-- immutable step, synthesize success or charge the same result a second time.
create table fluid_private.shared_strategy_observed_outcomes (
 execution_id uuid not null references fluid_private.shared_worker_executions(execution_id),
 job_id uuid not null references public.jobs(id),step_id uuid not null references public.job_steps(id),
 step_key text not null,request_key text not null,outcome jsonb not null,outcome_hash text not null,
 observed_at timestamptz not null default clock_timestamp(),primary key(execution_id,step_key)
);
create trigger shared_strategy_observed_outcome_immutable before update or delete on fluid_private.shared_strategy_observed_outcomes
 for each row execute function fluid_private.shared_job_admission_immutable();
create table fluid_private.shared_strategy_observed_responses (
 execution_id uuid not null references fluid_private.shared_worker_executions(execution_id),
 job_id uuid not null references public.jobs(id),step_id uuid not null references public.job_steps(id),
 step_key text not null,response_id text not null,response jsonb not null,response_hash text not null,
 observed_at timestamptz not null default clock_timestamp(),primary key(execution_id,step_key,response_id)
);
create trigger shared_strategy_observed_response_immutable before update or delete on fluid_private.shared_strategy_observed_responses
 for each row execute function fluid_private.shared_job_admission_immutable();

create function fluid_private.shared_strategy_job(p_job uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from fluid_private.shared_job_admissions a join public.jobs j
  on (j.id,j.owner_id,j.project_id,j.operation,j.input_hash)=(a.job_id,a.owner_id,a.project_id,a.operation,a.input_hash)
  join fluid_private.api_text_dispatches d on (d.job_id,d.owner_id,d.project_id)=(j.id,j.owner_id,j.project_id)
  where a.job_id=p_job and a.lane='strategy' and j.billing_mode='openai_api'
  and j.operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')
  and j.input->'version'='3'::jsonb and j.input->>'spendControl'='uncapped'
  and j.input->>'policyIdentity'=a.policy_identity and j.input->'policy'=a.policy
  and (d.policy_identity,d.deployment_id)=(a.policy_identity,a.deployment_id)
  and a.policy_identity=encode(sha256(convert_to(a.policy::text,'UTF8')),'hex')
  and j.input_hash=encode(sha256(convert_to(j.input::text,'UTF8')),'hex'));
$$;
create function fluid_private.shared_strategy_policy_available(p_owner uuid,p_project uuid,p_operation text,p_policy jsonb,p_deployment text)
returns boolean language sql stable security definer set search_path='' as $$
 select fluid_private.shared_account_customer_active(p_owner)
  and exists(select 1 from public.projects where id=p_project and owner_id=p_owner and deleted_at is null and deletion_requested_at is null)
  and fluid_private.api_text_guided_policy(p_operation,p_policy) and p_policy->>'model'='gpt-6.1-sol'
  and exists(select 1 from fluid_private.shared_worker_slots s join fluid_private.shared_worker_policies p using(slot_id)
   where s.lane='strategy' and s.enabled and s.lease_token is not null and s.expires_at>clock_timestamp()
   and s.deployment_id=p_deployment and p.operation=p_operation and p.policy=p_policy
   and p.policy_identity=encode(sha256(convert_to(p_policy::text,'UTF8')),'hex')
   and fluid_private.shared_worker_role_safe(s.role_name,s.role_oid));
$$;
create function fluid_private.shared_strategy_uncapped_context(p_owner uuid,p_project uuid,p_operation text,p_revision integer,
 p_hash text,p_input jsonb,p_key text,p_maximum bigint,p_attempts integer) returns boolean
language sql stable set search_path='' as $$
 select p_attempts=3 and p_input->'version'='3'::jsonb and p_input->>'spendControl'='uncapped'
  and p_hash=encode(sha256(convert_to(p_input::text,'UTF8')),'hex')
  and p_input->>'policyIdentity'=encode(sha256(convert_to((p_input->'policy')::text,'UTF8')),'hex')
  and p_maximum=(p_input#>>'{policy,maximumCostMicrousd}')::bigint
  and exists(select 1 from fluid_private.shared_strategy_admission_context c
   where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current()
   and (c.owner_id,c.project_id,c.operation,c.input_revision,c.input_hash,c.input,c.idempotency_key,c.maximum_microusd)
    is not distinct from(p_owner,p_project,p_operation,p_revision,p_hash,p_input,p_key,p_maximum));
$$;

-- Copy exact reviewed predecessors before adding shared branches. Existing
-- function OIDs/ACLs and the legacy implementation remain intact.
do $copies$
declare signature text; expected text; target text; source_name text; definition text;
begin
 for signature,expected,target,source_name in values
  ('public.api_text_worker_owner()','93b39417918c0dedbe60331922e3b2184ff55fe91fb3f16ce692ea92334a8f73','shared_strategy_legacy_owner','public.api_text_worker_owner'),
  ('public.check_api_text_runtime(text,jsonb,text)','7e79d7ebf237be624448219dc73f303e7560f7ff1b502c6e8ad29088bf41371c','shared_strategy_legacy_runtime','public.check_api_text_runtime'),
  ('fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)','29f493416b99237d4887bb2a7fdcc955c46c39ee36695ec6090a7176afef669d','shared_strategy_legacy_descriptor','fluid_private.api_text_descriptor'),
  ('fluid_private.strategy_job_summary(public.jobs)','04da0817ed1e7ebb31f473d68db9046f9107b2ec3f295cb27e56c038375b666f','shared_strategy_legacy_summary','fluid_private.strategy_job_summary') loop
  if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(signature)
   and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=expected and p.proowner=to_regrole('postgres')::oid
   and p.proconfig=array['search_path=""'] and not p.proleakproof and p.provolatile in('s','v')) then
   raise exception 'unexpected_shared_strategy_predecessor: %',signature; end if;
  definition:=pg_get_functiondef(to_regprocedure(signature));
  if position('CREATE OR REPLACE FUNCTION '||source_name||'(' in definition)<>1 then raise exception 'shared_strategy_copy_denied';end if;
  execute replace(definition,'CREATE OR REPLACE FUNCTION '||source_name||'(','CREATE FUNCTION fluid_private.'||target||'(');
 end loop;
end $copies$;
create or replace function public.api_text_worker_owner() returns uuid
language sql stable security definer set search_path='' as $$
 select coalesce(fluid_private.shared_worker_context_owner('strategy'),fluid_private.shared_strategy_legacy_owner());
$$;
create or replace function public.check_api_text_runtime(p_operation text,p_policy jsonb,p_deployment_id text) returns boolean
language plpgsql security definer set search_path='' as $$
declare jid uuid:=fluid_private.shared_worker_context_job('strategy');j public.jobs;
begin
 if jid is null then return fluid_private.shared_strategy_legacy_runtime(p_operation,p_policy,p_deployment_id);end if;
 select * into strict j from public.jobs where id=jid;
 return fluid_private.shared_worker_context_mode('strategy') in('claim','active')
  and (j.operation,j.input->'policy')=(p_operation,p_policy)
  and fluid_private.shared_strategy_job(j.id)
  and fluid_private.shared_strategy_policy_available(j.owner_id,j.project_id,p_operation,p_policy,p_deployment_id);
end $$;
create function fluid_private.shared_strategy_descriptor(p_job public.jobs,p_dispatch fluid_private.api_text_dispatches) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('version',1,'jobId',p_job.id,'operation',p_job.operation,'policyIdentity',p_dispatch.policy_identity,
  'deploymentId',p_dispatch.deployment_id,'dispatchIdentity',p_dispatch.dispatch_identity,'state',p_job.state,
  'retryable',p_job.state='queued' and p_job.cancel_requested_at is null and p_job.attempts<p_job.max_attempts
   and not exists(select 1 from public.job_steps where job_id=p_job.id)
   and fluid_private.shared_strategy_policy_available(p_job.owner_id,p_job.project_id,p_job.operation,p_job.input->'policy',p_dispatch.deployment_id),
  'publicationGeneration',p_dispatch.publication_generation,'publishedMessageId',p_dispatch.published_message_id,'publishedAt',p_dispatch.published_at);
$$;
create or replace function fluid_private.api_text_descriptor(p_job public.jobs,p_dispatch fluid_private.api_text_dispatches) returns jsonb
language sql stable set search_path='' as $$
 select case when fluid_private.shared_strategy_job(p_job.id) then fluid_private.shared_strategy_descriptor(p_job,p_dispatch)
  else fluid_private.shared_strategy_legacy_descriptor(p_job,p_dispatch) end;
$$;
create or replace function fluid_private.strategy_job_summary(p_job public.jobs) returns jsonb
language sql stable set search_path='' as $$
 select fluid_private.shared_strategy_legacy_summary(p_job)
  ||case when fluid_private.shared_strategy_job(p_job.id) then jsonb_build_object('billingMode','openai_api','spendControl','uncapped','policyIdentity',p_job.input->>'policyIdentity') else '{}'::jsonb end;
$$;

-- Extend only exact reviewed monetary guards for separately witnessed new
-- shared admissions. Amounts remain recorded estimates, never new spend caps.
do $patch$
declare signature text;expected text;old text;new text;definition text;
begin
 for signature,expected in values
  ('public.enqueue_job(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)','a10932b2678c9eeb5606a9efe0dadf3ea7bc7b8520ebca00ea1d2705b5cf8361'),
  ('public.begin_job_step(uuid,uuid,text,text,bigint)','18f7b41e833b9e3773ac7e3f7bffbde2809a37e79d9d6455d251ab7803ae39cd'),
  ('fluid_private.complete_job_step_core(uuid,uuid,text,text,bigint,jsonb,text)','31ddc6556cd98acdbc3049e092f947728559288260f6382705f56257848d09da'),
  ('public.register_job_plan(uuid,uuid,jsonb)','b8ac98daadd575d935304000fe5ffee46e0ad0c795c6c50287dad5b9d34829b7') loop
  if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(signature) and p.proowner=to_regrole('postgres')::oid
   and p.prosecdef and p.proconfig=array['search_path=""'] and not p.proleakproof
   and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=expected) then raise exception 'unexpected_shared_strategy_core: %',signature;end if;
 end loop;
 for signature,old,new in values
  ('public.enqueue_job(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)',$old$and not (fluid_private.local_prototype_unlimited_context$old$,$new$and not fluid_private.shared_strategy_uncapped_context(p_owner_id,p_project_id,p_operation,p_input_revision,p_input_hash,p_input,p_idempotency_key,p_max_cost_microusd,p_max_attempts)
    and not (fluid_private.local_prototype_unlimited_context$new$),
  ('public.begin_job_step(uuid,uuid,text,text,bigint)',$old$and not fluid_private.hosted_naming_step_authority(v_job.id)
  and not fluid_private.api_text_testing_gateway_matches$old$,$new$and not fluid_private.hosted_naming_step_authority(v_job.id)
  and not fluid_private.shared_strategy_job(v_job.id)
  and not fluid_private.api_text_testing_gateway_matches$new$),
  ('public.begin_job_step(uuid,uuid,text,text,bigint)',$old$and not fluid_private.api_text_testing_job_allowed(v_job.id) and not fluid_private.local_prototype_unlimited_job(v_job.id)$old$,$new$and not fluid_private.api_text_testing_job_allowed(v_job.id) and not fluid_private.local_prototype_unlimited_job(v_job.id) and not fluid_private.shared_strategy_job(v_job.id)$new$),
  ('public.begin_job_step(uuid,uuid,text,text,bigint)',$old$p_max_cost_microusd > v_job.reserved_cost_microusd - v_job.actual_cost_microusd - v_pending and not fluid_private.local_prototype_unlimited_job(v_job.id)$old$,$new$p_max_cost_microusd > v_job.reserved_cost_microusd - v_job.actual_cost_microusd - v_pending and not fluid_private.local_prototype_unlimited_job(v_job.id) and not fluid_private.shared_strategy_job(v_job.id)$new$),
  ('fluid_private.complete_job_step_core(uuid,uuid,text,text,bigint,jsonb,text)',$old$p_actual_cost_microusd > v_step.reserved_cost_microusd and not fluid_private.local_prototype_unlimited_job(p_job_id)$old$,$new$p_actual_cost_microusd > v_step.reserved_cost_microusd and not fluid_private.local_prototype_unlimited_job(p_job_id) and not fluid_private.shared_strategy_job(p_job_id)$new$),
  ('public.register_job_plan(uuid,uuid,jsonb)',$old$if v_total > v_job.reserved_cost_microusd then$old$,$new$if v_total > v_job.reserved_cost_microusd and not fluid_private.shared_strategy_job(v_job.id) then$new$) loop
  definition:=pg_get_functiondef(to_regprocedure(signature));
  if (length(definition)-length(replace(definition,old,'')))/length(old)<>1 then raise exception 'unexpected_shared_strategy_fragment: %',signature;end if;
  execute replace(definition,old,new);
 end loop;
end $patch$;

create function public.get_shared_strategy_availability(p_project_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid();ops jsonb;
begin
 if o is null or not fluid_private.shared_account_customer_active(o) then raise exception 'account_required' using errcode='42501';end if;
 if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and owner_id=o and deleted_at is null and deletion_requested_at is null) then raise exception 'not_found' using errcode='P0002';end if;
 select coalesce(jsonb_agg(x.item order by x.operation),'[]'::jsonb) into ops from(
  select distinct p.operation,jsonb_build_object('operation',p.operation,'billingMode','openai_api','spendControl','uncapped','policyIdentity',p.policy_identity,'interviewVersion',1) item
  from fluid_private.shared_worker_slots s join fluid_private.shared_worker_policies p using(slot_id)
  where s.lane='strategy' and s.enabled and s.expires_at>clock_timestamp()
   and fluid_private.shared_worker_role_safe(s.role_name,s.role_oid)
   and p.operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')
   and fluid_private.api_text_guided_policy(p.operation,p.policy) and p.policy->>'model'='gpt-6.1-sol'
   and p.policy_identity=encode(sha256(convert_to(p.policy::text,'UTF8')),'hex')) x;
 return case when jsonb_array_length(ops)>0 then jsonb_build_object('status','available','operations',ops)
  else jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','worker_unavailable') end;
end $$;
create function public.enqueue_shared_strategy_job(p_project_id uuid,p_expected_revision integer,p_operation text,p_idempotency_key text,p_accepted_policy_identity text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid();project public.projects;j public.jobs;d fluid_private.api_text_dispatches;policy jsonb;dep text;input jsonb;hash text;maximum bigint;
begin
 if o is null or not fluid_private.shared_account_customer_active(o) then raise exception 'account_required' using errcode='42501';end if;
 if p_expected_revision is null or p_expected_revision<1 or p_operation is null or p_operation not in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')
  or p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9._:-]{16,128}$' or p_accepted_policy_identity is null or p_accepted_policy_identity!~'^[a-f0-9]{64}$'
  then raise exception 'invalid_input' using errcode='22023';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=o) then raise exception 'not_found' using errcode='P0002';end if;
 perform fluid_private.lock_strategy_owner(o);
 select * into j from public.jobs where owner_id=o and idempotency_key=p_idempotency_key;
 if found then
  if not fluid_private.shared_strategy_job(j.id) or (j.project_id,j.operation,j.input_revision,j.input->>'policyIdentity')
   is distinct from(p_project_id,p_operation,p_expected_revision,p_accepted_policy_identity) then raise exception 'idempotency_conflict' using errcode='23505';end if;
 else
  select * into project from public.projects where id=p_project_id and owner_id=o and deleted_at is null and deletion_requested_at is null for share;
  if not found then raise exception 'not_found' using errcode='P0002';end if;
  if project.current_revision<>p_expected_revision then raise exception 'revision_conflict' using errcode='PT409';end if;
  -- Unknown outcomes block their own project, never unrelated customer work.
  if exists(select 1 from public.jobs a where a.owner_id=o and a.project_id=p_project_id and fluid_private.api_text_operation(a.operation)
   and (a.state in('queued','running','cancel_requested') or a.state='needs_reconciliation'
    and (a.error_code is null or a.error_code not in('cost_overrun','provider_cost_exceeded'))
    and not fluid_private.research_operator_adjudication_matches(a.id))) then raise exception 'active_strategy_request' using errcode='PT409';end if;
  select p.policy,s.deployment_id into policy,dep from fluid_private.shared_worker_slots s join fluid_private.shared_worker_policies p using(slot_id)
   where s.lane='strategy' and s.enabled and s.expires_at>clock_timestamp() and p.operation=p_operation and p.policy_identity=p_accepted_policy_identity
   and fluid_private.shared_strategy_policy_available(o,p_project_id,p_operation,p.policy,s.deployment_id)
   order by s.slot_index limit 1;
  if not found then raise exception 'runtime_unavailable' using errcode='55000';end if;
  maximum:=(policy->>'maximumCostMicrousd')::bigint;
  input:=(fluid_private.guided_api_strategy_input(o,p_project_id,p_expected_revision,p_operation,policy,maximum)-'acceptedMaxCostMicrousd')
   ||jsonb_build_object('version',3,'spendControl','uncapped','policyIdentity',p_accepted_policy_identity);
  hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
  insert into public.usage_accounts(owner_id,limit_microusd) values(o,0) on conflict(owner_id) do nothing;
  insert into fluid_private.shared_strategy_admission_context values(pg_backend_pid(),txid_current(),o,p_project_id,p_operation,p_expected_revision,hash,input,p_idempotency_key,maximum);
  select * into j from public.enqueue_job(o,p_project_id,p_operation,p_expected_revision,hash,input,p_idempotency_key,maximum,3);
  delete from fluid_private.shared_strategy_admission_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
  insert into fluid_private.api_text_dispatches(job_id,owner_id,project_id,policy_identity,deployment_id,dispatch_identity)
   values(j.id,o,p_project_id,p_accepted_policy_identity,dep,encode(sha256(convert_to(j.id::text||':'||p_accepted_policy_identity||':'||dep,'UTF8')),'hex')) returning * into d;
  if exists(select 1 from fluid_private.api_text_background_profiles where job_id=j.id) then
   raise exception 'shared_background_profile_conflict' using errcode='55000';end if;
  perform fluid_private.admit_shared_worker_job(j.id,'strategy',p_accepted_policy_identity,dep,policy);
 end if;
 select * into strict d from fluid_private.api_text_dispatches where job_id=j.id;
 return fluid_private.strategy_job_summary(j)||jsonb_build_object('billingMode','openai_api','spendControl','uncapped','policyIdentity',p_accepted_policy_identity,
  'dispatch',jsonb_build_object('version',1,'jobId',j.id,'policyIdentity',d.policy_identity,'deploymentId',d.deployment_id,'dispatchIdentity',d.dispatch_identity));
end $$;

create function public.list_shared_strategy_dispatches(p_slot jsonb,p_limit integer default 25) returns setof jsonb
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots;
begin
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'invalid_limit' using errcode='22023';end if;
 s:=fluid_private.lock_shared_worker_slot(p_slot,true);
 if s.lane<>'strategy' then raise exception 'shared_lane_denied' using errcode='42501';end if;
 return query select fluid_private.shared_strategy_descriptor(j,d) from public.jobs j
  join fluid_private.api_text_dispatches d on d.job_id=j.id
  join fluid_private.shared_job_admissions a on a.job_id=j.id and a.lane='strategy'
  join fluid_private.shared_worker_policies p on p.slot_id=s.slot_id and p.operation=j.operation and p.policy_identity=d.policy_identity and p.policy=j.input->'policy'
  where d.deployment_id=s.deployment_id and j.state='queued' and d.published_at is null
   and fluid_private.shared_strategy_job(j.id) and fluid_private.shared_account_customer_active(j.owner_id)
   and j.cancel_requested_at is null and j.attempts<j.max_attempts
  order by j.created_at,j.id limit p_limit;
end $$;

create function public.shared_strategy_worker_action(p_slot jsonb,p_execution jsonb,p_action text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots;e fluid_private.shared_worker_executions;j public.jobs;d fluid_private.api_text_dispatches;
 step public.job_steps;observed fluid_private.shared_strategy_observed_outcomes;response fluid_private.shared_strategy_observed_responses;o jsonb;h text;
 m jsonb;v jsonb;n integer;r jsonb;mode text;has_context boolean:=false;ex jsonb:=p_execution;
begin
 if jsonb_typeof(p_args) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_args))<>2 or not p_args?&array['message','values'] then raise exception 'invalid_shared_strategy_action' using errcode='22023';end if;
 m:=p_args->'message';v:=p_args->'values';
 n:=case p_action when 'descriptor' then 0 when 'expire' then 0 when 'claim' then 2 when 'runtime' then 2 when 'authorize' then 2 when 'heartbeat' then 2 when 'plan' then 2 when 'begin' then 4 when 'complete' then 6 when 'finish' then 3 when 'step' then 3 when 'has_results' then 2 when 'observe_status' then 1 when 'observe_outcome' then 3 when 'recovery' then 0 when 'observe_response' then 4 when 'published' then 2 when 'redrive' then 1 else null end;
 if n is null or jsonb_typeof(v) is distinct from 'array' or jsonb_array_length(v)<>n then raise exception 'invalid_shared_strategy_action' using errcode='22023';end if;
 if m is null or m='null'::jsonb then
  if p_execution is null or p_action not in('recovery','observe_response') then raise exception 'invalid_shared_strategy_action' using errcode='22023';end if;
 elsif jsonb_typeof(m) is distinct from 'object' or (select count(*) from jsonb_object_keys(m))<>5
  or not m?&array['version','jobId','policyIdentity','deploymentId','dispatchIdentity'] or m->'version'<>'1'::jsonb then raise exception 'invalid_shared_strategy_action' using errcode='22023';end if;
 -- Observation keeps the frozen old slot capability; new paid work requires a
 -- fresh slot generation and actual job lease on every action.
 mode:=case when p_action in('complete','finish','step','has_results','observe_status','observe_outcome','recovery','observe_response') then 'observe' else 'active' end;
 if p_execution is null then s:=fluid_private.lock_shared_worker_slot(p_slot,true);
 else
  e:=fluid_private.shared_worker_execution(p_slot,p_execution,mode);
  select * into strict s from fluid_private.shared_worker_slots where slot_id=e.slot_id;
 end if;
 if s.lane<>'strategy' then raise exception 'shared_lane_denied' using errcode='42501';end if;
 if m is null or m='null'::jsonb then
  -- Restart recovery has an independently validated frozen execution, not a
  -- client-selected owner or fabricated active claim. Derive the descriptor
  -- only after observation qualification, and only for GET-only recovery.
  select * into d from fluid_private.api_text_dispatches where job_id=e.job_id;
  if not found then raise exception 'shared_dispatch_denied' using errcode='42501';end if;
  m:=jsonb_build_object('version',1,'jobId',e.job_id,'policyIdentity',d.policy_identity,'deploymentId',d.deployment_id,'dispatchIdentity',d.dispatch_identity);
 end if;
 select * into j from public.jobs where id=(m->>'jobId')::uuid;
 select * into d from fluid_private.api_text_dispatches where job_id=j.id;
 if j.id is null or d.job_id is null or not fluid_private.shared_strategy_job(j.id)
  or (d.policy_identity,d.deployment_id,d.dispatch_identity) is distinct from(m->>'policyIdentity',m->>'deploymentId',m->>'dispatchIdentity')
  or d.deployment_id<>s.deployment_id
  or not exists(select 1 from fluid_private.shared_worker_policies p where p.slot_id=s.slot_id and p.operation=j.operation and p.policy_identity=d.policy_identity and p.policy=j.input->'policy')
  or p_execution is not null and (e.job_id,e.owner_id,e.project_id) is distinct from(j.id,j.owner_id,j.project_id)
  then raise exception 'shared_dispatch_denied' using errcode='42501';end if;
 if p_execution is null then
  if p_action not in('descriptor','expire','claim','runtime','published','redrive') then raise exception 'shared_execution_required' using errcode='42501';end if;
  if p_action='descriptor' then r:=fluid_private.shared_strategy_descriptor(j,d);
  elsif p_action='runtime' then
   if (j.operation,j.input->'policy') is distinct from(v->>0,v->1) then raise exception 'dispatch_policy_mismatch' using errcode='42501';end if;
   r:=to_jsonb(fluid_private.shared_strategy_policy_available(j.owner_id,j.project_id,j.operation,j.input->'policy',d.deployment_id));
  elsif p_action='published' then
   if v->>1 is null or length(v->>1) not between 1 and 300 then raise exception 'invalid_message_id' using errcode='22023';end if;
   if d.published_at is not null then r:=to_jsonb(d.publication_generation=(v->>0)::integer and d.published_message_id=v->>1);
   else
    update fluid_private.api_text_dispatches set published_message_id=v->>1,published_at=clock_timestamp()
     where job_id=j.id and publication_generation=(v->>0)::integer and published_at is null;
    r:=to_jsonb(found);
   end if;
  elsif p_action='redrive' then
   -- Queue redelivery never resets an issued/unknown request or generation.
   r:=case when j.state='queued' and j.attempts<j.max_attempts and not exists(select 1 from public.job_steps where job_id=j.id)
    and d.publication_generation=(v->>0)::integer then fluid_private.shared_strategy_descriptor(j,d) else null end;
  elsif p_action='expire' then
   perform pg_advisory_xact_lock(hashtextextended('embel-shared:strategy:'||j.owner_id::text,0));
   select * into strict j from public.jobs where id=j.id for update;
   if j.state in('running','cancel_requested') and j.lease_expires_at<=clock_timestamp() then
    if not exists(select 1 from public.job_steps where job_id=j.id)
     and not exists(select 1 from fluid_private.api_text_background_profiles where job_id=j.id)
     and not exists(select 1 from fluid_private.api_text_background_responses where job_id=j.id) then
     -- The actual engine must commit begin_job_step before provider dispatch.
     -- No step/journal proves this attempt never acquired dispatch authority.
     -- The expired job lease fences even a delayed old handler; keep attempts
     -- and immutable inputs, and permit only the normal predispatch retry.
     update fluid_private.shared_worker_executions set state='closed',closed_at=clock_timestamp()
      where job_id=j.id and lease_token=j.lease_token and state<>'closed';
     if j.cancel_requested_at is not null or j.attempts>=j.max_attempts then
      update public.jobs set state=case when cancel_requested_at is not null then 'cancelled' else 'failed' end,
       lease_token=null,lease_expires_at=null,error_code='lease_expired',finished_at=clock_timestamp() where id=j.id returning * into j;
      perform fluid_private.settle_reservation(j.id);
      r:=jsonb_build_object('disposition','terminal','state',j.state);
     else
      update public.jobs set state='queued',lease_token=null,lease_expires_at=null where id=j.id returning * into j;
      r:=jsonb_build_object('disposition','available','state',j.state);
     end if;
    else
     -- An issued/unknown attempt is never reset or recreated. Keep its frozen
     -- lease and step receipts for observation-only reconciliation.
     select * into e from fluid_private.shared_worker_executions where job_id=j.id and slot_id=s.slot_id and lease_token=j.lease_token and state='active' for update;
     update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=coalesce(error_code,'lease_expired') where id=j.id returning * into j;
     if e.execution_id is not null then perform fluid_private.park_shared_worker_execution(p_slot,fluid_private.shared_worker_execution_json(e));end if;
     r:=jsonb_build_object('disposition','terminal','state',j.state);
    end if;
   else r:=jsonb_build_object('disposition',case when j.state='queued' then 'available' when j.state in('running','cancel_requested') then 'busy' else 'terminal' end,'state',j.state);end if;
  elsif p_action='claim' then
   if j.state not in('queued','running','cancel_requested') then r:=jsonb_build_object('disposition','terminal','state',j.state);
   elsif j.state<>'queued' then r:=jsonb_build_object('disposition','busy','state',j.state);
   elsif j.cancel_requested_at is not null or j.attempts>=j.max_attempts or exists(select 1 from public.job_steps where job_id=j.id) then r:=jsonb_build_object('disposition','unavailable','state',j.state);
   else
    if v->>0 is null or length(v->>0) not between 1 and 100 or (v->>1)::integer not between 5 and 300 then raise exception 'invalid_lease' using errcode='22023';end if;
    perform fluid_private.enter_shared_worker_claim_context(p_slot,j.id);has_context:=true;
    update public.jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>(v->>1)::integer),worker_id=v->>0,attempts=attempts+1 where id=j.id returning * into j;
    e:=fluid_private.bind_shared_worker_execution(p_slot,j.id);ex:=fluid_private.shared_worker_execution_json(e);
    r:=jsonb_build_object('disposition','claimed','state',j.state,'job',to_jsonb(j),'executionAuthority',jsonb_build_object(
     'version',1,'contract','hosted_strategy_shared_uncapped_v1','jobId',j.id,'ownerId',j.owner_id,'projectId',j.project_id,'leaseToken',j.lease_token,
     'inputHash',j.input_hash,'policyIdentity',d.policy_identity,'roleOid',s.role_oid::bigint,'generation',e.generation,'slotId',e.slot_id,
     'instanceId',e.instance_id,'executionId',e.execution_id,'executionToken',e.execution_token));
   end if;
  end if;
 else
  if p_action in('claim','expire','published','redrive') then raise exception 'shared_action_closed' using errcode='42501';end if;
  perform fluid_private.enter_shared_worker_context(p_slot,p_execution,mode);has_context:=true;
  case p_action
  when 'descriptor' then r:=fluid_private.shared_strategy_descriptor(j,d);
  when 'runtime' then
   if (j.operation,j.input->'policy') is distinct from(v->>0,v->1) then raise exception 'dispatch_policy_mismatch' using errcode='42501';end if;
   r:=to_jsonb(public.check_api_text_runtime(v->>0,v->1,d.deployment_id));
  when 'authorize' then r:=to_jsonb(public.authorize_api_text_dispatch(j.id,(v->>0)::uuid,v->>1,d.policy_identity,d.deployment_id));
  when 'heartbeat' then r:=to_jsonb(public.heartbeat_job(j.id,(v->>0)::uuid,(v->>1)::integer));
  when 'plan' then r:=to_jsonb(public.register_job_plan(j.id,(v->>0)::uuid,v->1));
  when 'begin' then r:=to_jsonb(public.begin_job_step(j.id,(v->>0)::uuid,v->>1,v->>2,(v->>3)::bigint));
  when 'complete' then r:=to_jsonb(public.complete_job_step(j.id,(v->>0)::uuid,v->>1,v->>2,(v->>3)::bigint,v->4,v->>5));
  when 'finish' then r:=to_jsonb(public.finish_job(j.id,(v->>0)::uuid,v->>1,v->>2));
  when 'observe_status' then
   if (v->>0)::uuid is distinct from e.lease_token then raise exception 'shared_observation_lease_mismatch' using errcode='42501';end if;
   r:=to_jsonb(j);
  when 'observe_outcome' then
   if (v->>0)::uuid is distinct from e.lease_token then raise exception 'shared_observation_lease_mismatch' using errcode='42501';end if;
   o:=v->2;
   if jsonb_typeof(o) is distinct from 'object' or octet_length(o::text)>1050000 or not o?&array['status','costMicrousd','providerRequestId']
    or exists(select 1 from jsonb_object_keys(o) k where k not in('status','result','code','costMicrousd','providerRequestId'))
    or o->>'status' not in('succeeded','failed','needs_reconciliation') or jsonb_typeof(o->'status') is distinct from 'string'
    or jsonb_typeof(o->'costMicrousd') is distinct from 'number' or (o->>'costMicrousd')::numeric not between 0 and 9007199254740991
    or (o->>'costMicrousd')::numeric<>trunc((o->>'costMicrousd')::numeric)
    or o->'providerRequestId'<>'null'::jsonb and (jsonb_typeof(o->'providerRequestId') is distinct from 'string' or length(o->>'providerRequestId')>200)
    or o->>'status'='succeeded' and (not o?'result' or o?'code')
    or o->>'status'<>'succeeded' and (jsonb_typeof(o->'code') is distinct from 'string' or length(o->>'code')>100)
    then raise exception 'invalid_shared_observed_outcome' using errcode='22023';end if;
   select * into step from public.job_steps where job_id=j.id and owner_id=j.owner_id and step_key=v->>1 for update;
   if not found or step.request_key<>encode(sha256(convert_to(j.id::text||':'||step.step_key,'UTF8')),'hex') then raise exception 'shared_issued_step_required' using errcode='42501';end if;
   h:=encode(sha256(convert_to(o::text,'UTF8')),'hex');
   select * into observed from fluid_private.shared_strategy_observed_outcomes where execution_id=e.execution_id and step_key=step.step_key;
   if found then
    if (observed.job_id,observed.step_id,observed.request_key,observed.outcome_hash,observed.outcome) is distinct from(j.id,step.id,step.request_key,h,o) then raise exception 'shared_observed_outcome_immutable' using errcode='55000';end if;
   else
    insert into fluid_private.shared_strategy_observed_outcomes(execution_id,job_id,step_id,step_key,request_key,outcome,outcome_hash)
     values(e.execution_id,j.id,step.id,step.step_key,step.request_key,o,h);
   end if;
   r:='true'::jsonb;
  when 'recovery' then
   select coalesce(jsonb_agg(jsonb_build_object('stepKey',x.step_key,'responseId',x.response_id)),'[]'::jsonb) into r from(
    select distinct st.step_key,proof.response_id from public.job_steps st
    cross join lateral(select st.provider_request_id response_id union select actual.outcome->>'providerRequestId'
     from fluid_private.shared_strategy_observed_outcomes actual where actual.execution_id=e.execution_id and actual.step_id=st.id) proof
    where st.job_id=j.id and st.owner_id=j.owner_id and proof.response_id~'^resp_[A-Za-z0-9_-]{1,180}$'
     and not exists(select 1 from fluid_private.shared_strategy_observed_responses done where done.execution_id=e.execution_id and done.step_id=st.id and done.response_id=proof.response_id)
    order by st.step_key,proof.response_id limit 25) x;
  when 'observe_response' then
   if (v->>0)::uuid is distinct from e.lease_token then raise exception 'shared_observation_lease_mismatch' using errcode='42501';end if;
   select * into step from public.job_steps where job_id=j.id and owner_id=j.owner_id and step_key=v->>1 for update;
   if not found or v->>2 !~'^resp_[A-Za-z0-9_-]{1,180}$' or not coalesce((
    step.provider_request_id=v->>2 or exists(select 1 from fluid_private.shared_strategy_observed_outcomes actual
     where actual.execution_id=e.execution_id and actual.step_id=step.id and actual.outcome->>'providerRequestId'=v->>2)),false) then
    raise exception 'shared_response_identity_unproven' using errcode='42501';end if;
   o:=v->3;
   if jsonb_typeof(o) is distinct from 'object' or (select count(*) from jsonb_object_keys(o))<>2 or not o?&array['body','requestId']
    or octet_length(o::text)>1050000 or jsonb_typeof(o->'body') is distinct from 'object' or o#>>'{body,id}' is distinct from v->>2
    or o#>>'{body,status}' not in('queued','in_progress','completed','failed','cancelled','incomplete')
    or jsonb_typeof(o#>'{body,status}') is distinct from 'string'
    or o->'requestId'<>'null'::jsonb and (jsonb_typeof(o->'requestId') is distinct from 'string' or length(o->>'requestId')>200)
    then raise exception 'invalid_shared_observed_response' using errcode='22023';end if;
   if o#>>'{body,status}' in('queued','in_progress') then r:='false'::jsonb;
   else
    h:=encode(sha256(convert_to((o->'body')::text,'UTF8')),'hex');
    select * into response from fluid_private.shared_strategy_observed_responses where execution_id=e.execution_id and step_key=step.step_key and response_id=v->>2;
    if found then
     if (response.job_id,response.step_id,response.response_hash,response.response->'body') is distinct from(j.id,step.id,h,o->'body') then raise exception 'shared_observed_response_immutable' using errcode='55000';end if;
    else
     insert into fluid_private.shared_strategy_observed_responses(execution_id,job_id,step_id,step_key,response_id,response,response_hash)
      values(e.execution_id,j.id,step.id,step.step_key,v->>2,o,h);
    end if;
    r:='true'::jsonb;
   end if;
  when 'step' then
   if ((v->>0)::uuid,(v->>1)::uuid) is distinct from(j.owner_id,j.project_id) then raise exception 'shared_owner_denied' using errcode='42501';end if;
   select coalesce(jsonb_agg(jsonb_build_object('state',state,'request_key',request_key,'reserved_cost_microusd',reserved_cost_microusd)),'[]'::jsonb) into r
    from public.job_steps where job_id=j.id and owner_id=j.owner_id and step_key=v->>2;
  when 'has_results' then
   if ((v->>0)::uuid,(v->>1)::uuid) is distinct from(j.owner_id,j.project_id) then raise exception 'shared_owner_denied' using errcode='42501';end if;
   select to_jsonb(exists(select 1 from public.job_steps where job_id=j.id and owner_id=j.owner_id and state='succeeded')) into r;
  else raise exception 'shared_action_denied' using errcode='42501';
  end case;
 end if;
 if has_context then perform fluid_private.leave_shared_worker_context();end if;
 if p_execution is not null and p_action in('complete','finish') and exists(select 1 from public.jobs where id=j.id and state='needs_reconciliation') then
  perform fluid_private.park_shared_worker_execution(p_slot,p_execution);end if;
 if p_execution is not null and p_action='finish' and exists(select 1 from public.jobs where id=j.id and state in('succeeded','failed','partial','cancelled'))
  and not exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then perform fluid_private.close_shared_worker_execution(p_slot,p_execution);end if;
 return jsonb_build_object('execution',ex,'result',r);
end $$;

do $deny$
declare f oid;g record;t regclass;
begin
 foreach t in array array['fluid_private.shared_strategy_admission_context'::regclass,'fluid_private.shared_strategy_observed_outcomes'::regclass,'fluid_private.shared_strategy_observed_responses'::regclass] loop
  execute format('alter table %s enable row level security',t);execute format('alter table %s force row level security',t);
  for g in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=t and a.grantee<>c.relowner loop
   execute format('revoke all on %s from %s cascade',t,case when g.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(g.grantee)) end);end loop;
 end loop;
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='fluid_private' and p.proname like 'shared_strategy_%'
  or n.nspname='public' and p.proname in('get_shared_strategy_availability','enqueue_shared_strategy_job','shared_strategy_worker_action','list_shared_strategy_dispatches') loop
  for g in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=f and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',f::regprocedure,case when g.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(g.grantee)) end);end loop;
 end loop;
end $deny$;
grant execute on function public.get_shared_strategy_availability(uuid),public.enqueue_shared_strategy_job(uuid,integer,text,text,text) to authenticated;
-- Fixed slot gateway grants remain a separately reviewed operator action.
commit;
