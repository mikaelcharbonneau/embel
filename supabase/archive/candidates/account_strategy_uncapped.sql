-- UNAPPLIED. Apply after the reviewed account_service_enrollment.sql and
-- account_worker_enrollment.sql packets. Installation creates no account, role, credit,
-- approval or operator grant. Historical bounded, subscription and local jobs
-- keep their original admission contracts and immutable inputs.
begin;

create table fluid_private.managed_strategy_admission_context (
 backend_pid integer not null, transaction_id bigint not null, owner_id uuid not null,
 project_id uuid not null, operation text not null, input_revision integer not null,
 input_hash text not null, input jsonb not null, idempotency_key text not null,
 maximum_microusd bigint not null, primary key(backend_pid,transaction_id)
);
create table fluid_private.managed_strategy_uncapped_jobs (
 job_id uuid primary key references public.jobs(id), owner_id uuid not null, project_id uuid not null,
 role_name name not null, role_oid oid not null, generation integer not null, revision bigint not null,
 operation_key uuid not null, profile_id text not null, deployment_id text not null,
 policy_identity text not null, input_hash text not null
);
create trigger managed_strategy_job_immutable before update or delete on fluid_private.managed_strategy_uncapped_jobs
 for each row execute function fluid_private.account_worker_immutable();

-- A recorded price estimate continues to support the historical ledger. It
-- does not become a spend ceiling for this separately approved contract.
create function fluid_private.managed_strategy_uncapped_binding(p_owner uuid)
returns fluid_private.account_worker_bindings language sql stable set search_path='' as $$
 select b from fluid_private.account_worker_bindings b
 join fluid_private.account_worker_profile_approvals a on a.profile_id=b.profile_id and a.capability='strategy'
 where b.owner_id=p_owner and b.capability='strategy'
 and a.profile->>'admissionContract'='hosted_strategy_owner_uncapped_v1' and a.profile->>'spendControl'='uncapped'
 and fluid_private.account_worker_managed_role(b.role_name,b.role_oid)
 and exists(select 1 from fluid_private.strategy_billing_routes where owner_id=p_owner and billing_mode='openai_api');
$$;
create function fluid_private.managed_strategy_uncapped_job(p_job uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.managed_strategy_uncapped_jobs m
 join public.jobs j on j.id=m.job_id and j.owner_id=m.owner_id and j.project_id=m.project_id and j.input_hash=m.input_hash
 join fluid_private.account_worker_bindings b on b.owner_id=m.owner_id and b.capability='strategy'
  and b.role_name=m.role_name and b.role_oid=m.role_oid and b.generation=m.generation and b.revision=m.revision
  and b.operation_key=m.operation_key and b.profile_id=m.profile_id and b.deployment_id=m.deployment_id
 join fluid_private.account_worker_profile_approvals a on a.profile_id=m.profile_id and a.capability='strategy'
 join fluid_private.api_text_dispatches d on d.job_id=j.id and d.owner_id=j.owner_id and d.project_id=j.project_id
  and d.policy_identity=m.policy_identity and d.deployment_id=m.deployment_id
 where m.job_id=p_job and j.billing_mode='openai_api' and j.input->'version'='3'::jsonb
 and j.input->>'spendControl'='uncapped' and j.input->>'policyIdentity'=m.policy_identity
 and m.policy_identity=encode(sha256(convert_to((j.input->'policy')::text,'UTF8')),'hex')
 and j.input_hash=encode(sha256(convert_to(j.input::text,'UTF8')),'hex')
 and a.profile->>'admissionContract'='hosted_strategy_owner_uncapped_v1' and a.profile->>'spendControl'='uncapped');
$$;
create function fluid_private.managed_strategy_unresolved(p_owner uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.jobs j where j.owner_id=p_owner and j.billing_mode='openai_api'
 and (exists(select 1 from public.job_steps s where s.job_id=j.id and s.state='ambiguous')
  or (j.state='needs_reconciliation' and (j.error_code is null or j.error_code not in('cost_overrun','provider_cost_exceeded'))))
 and not fluid_private.research_operator_adjudication_matches(j.id));
$$;
create function fluid_private.managed_strategy_policy_allowed(p_owner uuid,p_operation text,p_policy jsonb,p_deployment text,p_role oid default null)
returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.managed_strategy_uncapped_binding(p_owner) b
 join fluid_private.account_worker_profile_approvals a on a.profile_id=b.profile_id
 join fluid_private.api_strategy_bindings binding on binding.owner_id=b.owner_id and binding.operation=p_operation
 join fluid_private.strategy_runtime_policy p on p.operation=p_operation
 where b.owner_id is not null and binding.enabled and p.enabled and p.policy=p_policy
 and fluid_private.api_text_guided_policy(p_operation,p_policy) and p_policy->>'model'='gpt-6.1-sol'
 and a.policies->p_operation=p_policy and a.profile#>>array['policyIdentities',p_operation]=binding.policy_identity
 and binding.role_oid=b.role_oid and (p_role is null or p_role=b.role_oid)
 and binding.deployment_id=b.deployment_id and b.deployment_id=p_deployment
 and binding.policy_identity=encode(sha256(convert_to(p_policy::text,'UTF8')),'hex')
 and not fluid_private.managed_strategy_unresolved(p_owner));
$$;
create function fluid_private.managed_strategy_uncapped_context(p_owner uuid,p_project uuid,p_operation text,p_revision integer,
 p_hash text,p_input jsonb,p_key text,p_maximum bigint,p_attempts integer) returns boolean
language sql stable set search_path='' as $$
 select p_attempts=3 and p_input->'version'='3'::jsonb and p_input->>'spendControl'='uncapped'
 and p_hash=encode(sha256(convert_to(p_input::text,'UTF8')),'hex')
 and exists(select 1 from fluid_private.managed_strategy_admission_context c
  where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current()
  and (c.owner_id,c.project_id,c.operation,c.input_revision,c.input_hash,c.input,c.idempotency_key,c.maximum_microusd)
   is not distinct from (p_owner,p_project,p_operation,p_revision,p_hash,p_input,p_key,p_maximum))
 and exists(select 1 from fluid_private.managed_strategy_uncapped_binding(p_owner) b where b.owner_id is not null
  and fluid_private.managed_strategy_policy_allowed(p_owner,p_operation,p_input->'policy',b.deployment_id,b.role_oid)
  and p_input->>'policyIdentity'=encode(sha256(convert_to((p_input->'policy')::text,'UTF8')),'hex')
  and p_maximum=(p_input#>>'{policy,maximumCostMicrousd}')::bigint);
$$;
create function fluid_private.managed_strategy_claim_authority(p_job public.jobs) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('version',1,'contract','hosted_strategy_owner_uncapped_v1','jobId',p_job.id,'ownerId',p_job.owner_id,
  'projectId',p_job.project_id,'leaseToken',p_job.lease_token,'inputHash',p_job.input_hash,'policyIdentity',m.policy_identity,
  'roleOid',m.role_oid::bigint,'generation',m.generation,'revision',m.revision)
 from fluid_private.managed_strategy_uncapped_jobs m where m.job_id=p_job.id
 and m.role_name=session_user and m.role_oid=to_regrole(session_user)::oid
 and fluid_private.managed_strategy_uncapped_job(p_job.id)
 and fluid_private.account_worker_managed_role(m.role_name,m.role_oid)
 and fluid_private.account_worker_dispatch_ready();
$$;

create function public.get_managed_strategy_availability(p_project_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); b fluid_private.account_worker_bindings; operations jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'not_found' using errcode='P0002'; end if;
 b:=fluid_private.managed_strategy_uncapped_binding(owner);
 if b.owner_id is null or not fluid_private.account_worker_owner_ready(owner,'strategy')
  or not exists(select 1 from fluid_private.account_worker_heartbeats h where h.owner_id=owner and h.capability='strategy'
   and h.role_oid=b.role_oid and h.generation=b.generation and h.revision=b.revision and h.operation_key=b.operation_key and h.expires_at>clock_timestamp())
 then return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','worker_unavailable'); end if;
 if fluid_private.managed_strategy_unresolved(owner) then return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','request_unresolved'); end if;
 select coalesce(jsonb_agg(jsonb_build_object('operation',p.operation,'billingMode','openai_api','spendControl','uncapped',
  'policyIdentity',encode(sha256(convert_to(p.policy::text,'UTF8')),'hex'),'interviewVersion',1) order by p.operation),'[]'::jsonb)
 into operations from fluid_private.strategy_runtime_policy p
 where fluid_private.managed_strategy_policy_allowed(owner,p.operation,p.policy,b.deployment_id,b.role_oid);
 return case when jsonb_array_length(operations)>0 then jsonb_build_object('status','available','operations',operations)
 else jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','runtime_disabled') end;
end $$;

create function public.enqueue_managed_strategy_job(p_project_id uuid,p_expected_revision integer,p_operation text,
 p_idempotency_key text,p_accepted_policy_identity text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); project public.projects; b fluid_private.account_worker_bindings; policy jsonb; input jsonb; hash text;
 j public.jobs; d fluid_private.api_text_dispatches; maximum bigint; availability jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_expected_revision is null or p_expected_revision<1 or p_operation is null or p_operation not in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')
  or p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9._:-]{16,128}$'
  or p_accepted_policy_identity is null or p_accepted_policy_identity!~'^[a-f0-9]{64}$' then raise exception 'invalid_input' using errcode='22023'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'not_found' using errcode='P0002'; end if;
 perform fluid_private.lock_strategy_owner(owner);
 select * into j from public.jobs where owner_id=owner and idempotency_key=p_idempotency_key;
 if found then
  if not fluid_private.managed_strategy_uncapped_job(j.id) or (j.project_id,j.operation,j.input_revision,j.input->>'policyIdentity')
   is distinct from (p_project_id,p_operation,p_expected_revision,p_accepted_policy_identity) then raise exception 'idempotency_conflict' using errcode='23505'; end if;
 else
  select * into project from public.projects where id=p_project_id and owner_id=owner and deleted_at is null and deletion_requested_at is null for share;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if project.current_revision<>p_expected_revision then raise exception 'revision_conflict' using errcode='PT409'; end if;
  if exists(select 1 from public.jobs active where active.owner_id=owner and active.project_id=p_project_id
   and fluid_private.api_text_operation(active.operation) and active.state in('queued','running','cancel_requested','needs_reconciliation')) then raise exception 'active_strategy_request' using errcode='PT409'; end if;
  availability:=public.get_managed_strategy_availability(p_project_id);
  if not exists(select 1 from jsonb_array_elements(availability->'operations') op where op->>'operation'=p_operation and op->>'policyIdentity'=p_accepted_policy_identity)
   then raise exception 'runtime_unavailable' using errcode='55000'; end if;
  b:=fluid_private.managed_strategy_uncapped_binding(owner);
  select p.policy into strict policy from fluid_private.strategy_runtime_policy p where p.operation=p_operation and p.enabled for share;
  maximum:=(policy->>'maximumCostMicrousd')::bigint;
  -- Reuse the exact existing guided-turn/history proof, then freeze a separate
  -- version. No historical v1/v2 input or hash is rewritten.
  input:=(fluid_private.guided_api_strategy_input(owner,p_project_id,p_expected_revision,p_operation,policy,maximum)-'acceptedMaxCostMicrousd')
   ||jsonb_build_object('version',3,'spendControl','uncapped','policyIdentity',p_accepted_policy_identity);
  hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
  -- Owner-locked bookkeeping only, after managed profile/owner qualification.
  -- Zero is neither an allowance nor permission for any bounded contract.
  -- Never fund or change an existing ledger; normal reservation/settlement
  -- below continues to record actual obligations and provider observations.
  insert into public.usage_accounts(owner_id,limit_microusd) values(owner,0) on conflict(owner_id) do nothing;
  insert into fluid_private.managed_strategy_admission_context values(pg_backend_pid(),txid_current(),owner,p_project_id,p_operation,p_expected_revision,hash,input,p_idempotency_key,maximum);
  select * into j from public.enqueue_job(owner,p_project_id,p_operation,p_expected_revision,hash,input,p_idempotency_key,maximum,3);
  delete from fluid_private.managed_strategy_admission_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
  insert into fluid_private.api_text_dispatches(job_id,owner_id,project_id,policy_identity,deployment_id,dispatch_identity)
   values(j.id,owner,p_project_id,p_accepted_policy_identity,b.deployment_id,encode(sha256(convert_to(j.id::text||':'||p_accepted_policy_identity||':'||b.deployment_id,'UTF8')),'hex')) returning * into d;
  insert into fluid_private.managed_strategy_uncapped_jobs values(j.id,owner,p_project_id,b.role_name,b.role_oid,b.generation,b.revision,b.operation_key,b.profile_id,b.deployment_id,p_accepted_policy_identity,hash);
 end if;
 select * into strict d from fluid_private.api_text_dispatches where job_id=j.id;
 return fluid_private.strategy_job_summary(j)||jsonb_build_object('billingMode','openai_api','spendControl','uncapped','policyIdentity',p_accepted_policy_identity,
  'dispatch',jsonb_build_object('version',1,'jobId',j.id,'policyIdentity',d.policy_identity,'deploymentId',d.deployment_id,'dispatchIdentity',d.dispatch_identity));
end $$;

-- Fail closed if any reviewed predecessor body/metadata has changed.
do $guard$
declare signature text; expected text;
begin
 for signature,expected in values
 ('public.enqueue_job(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)','a10932b2678c9eeb5606a9efe0dadf3ea7bc7b8520ebca00ea1d2705b5cf8361'),
 ('public.begin_job_step(uuid,uuid,text,text,bigint)','a192964035f777bf86e9e9dbb5340c1e59ad51bec0feb0a3d8660418d8ed0e43'),
 ('fluid_private.complete_job_step_core(uuid,uuid,text,text,bigint,jsonb,text)','31ddc6556cd98acdbc3049e092f947728559288260f6382705f56257848d09da'),
 ('public.register_job_plan(uuid,uuid,jsonb)','b8ac98daadd575d935304000fe5ffee46e0ad0c795c6c50287dad5b9d34829b7'),
 ('public.check_api_text_runtime(text,jsonb,text)','7e79d7ebf237be624448219dc73f303e7560f7ff1b502c6e8ad29088bf41371c'),
 ('public.claim_api_text_job(uuid,text,integer,text,text)','707771e026ba9d4f2604893c3c67dac0dc18ad39e782476804ff8996d8b6a0c2'),
 ('public.get_strategy_availability(uuid)','81f27df775c746ca011a0f83d53a55fb83fbd66ec9a8617f85f944bef25ca1da'),
 ('fluid_private.api_text_descriptor(jobs,fluid_private.api_text_dispatches)','29f493416b99237d4887bb2a7fdcc955c46c39ee36695ec6090a7176afef669d'),
 ('fluid_private.strategy_job_summary(jobs)','04da0817ed1e7ebb31f473d68db9046f9107b2ec3f295cb27e56c038375b666f')
 loop
 if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(signature) and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=expected
  and p.proowner=to_regrole('postgres')::oid and p.proconfig=array['search_path=""'] and not p.proleakproof
  and p.prolang=(select oid from pg_language where lanname=case when signature like 'fluid_private.api_text_descriptor%' or signature like 'fluid_private.strategy_job_summary%' then 'sql' else 'plpgsql' end)
  and (p.prosecdef=(signature like 'public.%' or signature like 'fluid_private.complete_job_step_core%'))
  and p.provolatile=case when signature like 'fluid_private.api_text_descriptor%' or signature like 'fluid_private.strategy_job_summary%' then 's'::"char" else 'v'::"char" end)
 then raise exception 'unexpected_managed_strategy_predecessor: %',signature; end if;
 end loop;
end $guard$;

do $patch$
declare signature text; original text; replacement text; definition text;
begin
 for signature,original,replacement in values
 ('public.enqueue_job(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)',$old$and not (fluid_private.local_prototype_unlimited_context$old$,$new$and not fluid_private.managed_strategy_uncapped_context(p_owner_id,p_project_id,p_operation,p_input_revision,p_input_hash,p_input,p_idempotency_key,p_max_cost_microusd,p_max_attempts)
    and not (fluid_private.local_prototype_unlimited_context$new$),
 ('public.begin_job_step(uuid,uuid,text,text,bigint)',$old$and not fluid_private.hosted_naming_step_authority(v_job.id)
  and not fluid_private.api_text_testing_gateway_matches$old$,$new$and not fluid_private.hosted_naming_step_authority(v_job.id)
  and not fluid_private.managed_strategy_uncapped_job(v_job.id)
  and not fluid_private.api_text_testing_gateway_matches$new$),
 ('public.begin_job_step(uuid,uuid,text,text,bigint)',$old$and not fluid_private.api_text_testing_job_allowed(v_job.id) and not fluid_private.local_prototype_unlimited_job(v_job.id)$old$,$new$and not fluid_private.api_text_testing_job_allowed(v_job.id) and not fluid_private.local_prototype_unlimited_job(v_job.id) and not fluid_private.managed_strategy_uncapped_job(v_job.id)$new$),
 ('public.begin_job_step(uuid,uuid,text,text,bigint)',$old$p_max_cost_microusd > v_job.reserved_cost_microusd - v_job.actual_cost_microusd - v_pending and not fluid_private.local_prototype_unlimited_job(v_job.id)$old$,$new$p_max_cost_microusd > v_job.reserved_cost_microusd - v_job.actual_cost_microusd - v_pending and not fluid_private.local_prototype_unlimited_job(v_job.id) and not fluid_private.managed_strategy_uncapped_job(v_job.id)$new$),
 ('fluid_private.complete_job_step_core(uuid,uuid,text,text,bigint,jsonb,text)',$old$p_actual_cost_microusd > v_step.reserved_cost_microusd and not fluid_private.local_prototype_unlimited_job(p_job_id)$old$,$new$p_actual_cost_microusd > v_step.reserved_cost_microusd and not fluid_private.local_prototype_unlimited_job(p_job_id) and not fluid_private.managed_strategy_uncapped_job(p_job_id)$new$),
 ('public.register_job_plan(uuid,uuid,jsonb)',$old$if v_total > v_job.reserved_cost_microusd then$old$,$new$if v_total > v_job.reserved_cost_microusd and not fluid_private.managed_strategy_uncapped_job(v_job.id) then$new$),
 ('public.check_api_text_runtime(text,jsonb,text)',$old$perform fluid_private.lock_strategy_owner(v_owner);$old$,$new$perform fluid_private.lock_strategy_owner(v_owner);
 if exists(select 1 from fluid_private.account_worker_bindings b join fluid_private.account_worker_profile_approvals a on a.profile_id=b.profile_id
  where b.owner_id=v_owner and b.capability='strategy' and a.profile->>'admissionContract'='hosted_strategy_owner_uncapped_v1') then
  return fluid_private.managed_strategy_policy_allowed(v_owner,p_operation,p_policy,p_deployment_id,to_regrole(session_user)::oid);
 end if;$new$),
 ('public.claim_api_text_job(uuid,text,integer,text,text)',$old$if j.state<>'queued' then$old$,$new$if exists(select 1 from fluid_private.account_worker_bindings b join fluid_private.account_worker_profile_approvals a on a.profile_id=b.profile_id
  where b.owner_id=v_owner and b.capability='strategy' and a.profile->>'admissionContract'='hosted_strategy_owner_uncapped_v1')
  and not fluid_private.managed_strategy_uncapped_job(j.id) then return jsonb_build_object('disposition','unavailable','state',j.state); end if;
 if j.state<>'queued' then$new$),
 ('public.claim_api_text_job(uuid,text,integer,text,text)',$old$return jsonb_build_object('disposition','claimed','state',j.state,'job',to_jsonb(j));$old$,$new$return jsonb_build_object('disposition','claimed','state',j.state,'job',to_jsonb(j))
 ||case when fluid_private.managed_strategy_uncapped_job(j.id) then jsonb_build_object('executionAuthority',fluid_private.managed_strategy_claim_authority(j)) else '{}'::jsonb end;$new$),
 ('public.get_strategy_availability(uuid)',$old$if exists(select 1 from fluid_private.strategy_billing_routes where owner_id=v_owner and billing_mode='openai_api')$old$,$new$if exists(select 1 from fluid_private.account_worker_bindings b join fluid_private.account_worker_profile_approvals a on a.profile_id=b.profile_id
  where b.owner_id=v_owner and b.capability='strategy' and a.profile->>'admissionContract'='hosted_strategy_owner_uncapped_v1') then return public.get_managed_strategy_availability(p_project_id); end if;
  if exists(select 1 from fluid_private.strategy_billing_routes where owner_id=v_owner and billing_mode='openai_api')$new$),
 ('fluid_private.api_text_descriptor(jobs,fluid_private.api_text_dispatches)',$old$select jsonb_build_object('version',1,'jobId',p_job.id,'operation',p_job.operation,'policyIdentity',p_dispatch.policy_identity,
 'deploymentId',p_dispatch.deployment_id,'dispatchIdentity',p_dispatch.dispatch_identity,'state',p_job.state,
 'retryable',p_job.state='queued' and p_job.attempts<p_job.max_attempts and not exists(select 1 from public.job_steps where job_id=p_job.id)
   and fluid_private.api_text_project_policy_allowed(p_job.owner_id,p_job.operation,p_job.input->'policy',p_dispatch.deployment_id,
    case when exists(select 1 from fluid_private.api_text_testing_admissions where job_id=p_job.id) then p_job.project_id else null end,
    (select oid from pg_catalog.pg_roles where rolname=session_user))
   and not fluid_private.api_text_strategy_paused(p_job.owner_id,p_job.operation,p_job.project_id)
   and (not exists(select 1 from fluid_private.api_text_testing_admissions where job_id=p_job.id)
    or fluid_private.api_text_testing_job_allowed(p_job.id))
   and exists(select 1 from public.usage_accounts where owner_id=p_job.owner_id and (limit_microusd<=5000000 or fluid_private.api_text_testing_job_allowed(p_job.id))
     and (reserved_microusd<=limit_microusd-greatest(spent_microusd,provider_actual_microusd)
      or fluid_private.api_text_testing_job_allowed(p_job.id))),
 'publicationGeneration',p_dispatch.publication_generation,'publishedMessageId',p_dispatch.published_message_id,'publishedAt',p_dispatch.published_at);$old$,$new$select case when fluid_private.managed_strategy_uncapped_job(p_job.id) then
 jsonb_build_object('version',1,'jobId',p_job.id,'operation',p_job.operation,'policyIdentity',p_dispatch.policy_identity,
 'deploymentId',p_dispatch.deployment_id,'dispatchIdentity',p_dispatch.dispatch_identity,'state',p_job.state,
 'retryable',p_job.state='queued' and p_job.cancel_requested_at is null and p_job.attempts<p_job.max_attempts
  and not exists(select 1 from public.job_steps where job_id=p_job.id)
  and fluid_private.account_worker_owner_ready(p_job.owner_id,'strategy')
  and fluid_private.managed_strategy_policy_allowed(p_job.owner_id,p_job.operation,p_job.input->'policy',p_dispatch.deployment_id)
  and exists(select 1 from fluid_private.account_worker_heartbeats h join fluid_private.managed_strategy_uncapped_jobs m
   on m.job_id=p_job.id and h.owner_id=m.owner_id and h.capability='strategy' and h.role_oid=m.role_oid
    and h.generation=m.generation and h.revision=m.revision and h.operation_key=m.operation_key and h.expires_at>clock_timestamp()),
 'publicationGeneration',p_dispatch.publication_generation,'publishedMessageId',p_dispatch.published_message_id,'publishedAt',p_dispatch.published_at)
 else (select jsonb_build_object('version',1,'jobId',p_job.id,'operation',p_job.operation,'policyIdentity',p_dispatch.policy_identity,
 'deploymentId',p_dispatch.deployment_id,'dispatchIdentity',p_dispatch.dispatch_identity,'state',p_job.state,
 'retryable',p_job.state='queued' and p_job.attempts<p_job.max_attempts and not exists(select 1 from public.job_steps where job_id=p_job.id)
   and fluid_private.api_text_project_policy_allowed(p_job.owner_id,p_job.operation,p_job.input->'policy',p_dispatch.deployment_id,
    case when exists(select 1 from fluid_private.api_text_testing_admissions where job_id=p_job.id) then p_job.project_id else null end,
    (select oid from pg_catalog.pg_roles where rolname=session_user))
   and not fluid_private.api_text_strategy_paused(p_job.owner_id,p_job.operation,p_job.project_id)
   and (not exists(select 1 from fluid_private.api_text_testing_admissions where job_id=p_job.id)
    or fluid_private.api_text_testing_job_allowed(p_job.id))
   and exists(select 1 from public.usage_accounts where owner_id=p_job.owner_id and (limit_microusd<=5000000 or fluid_private.api_text_testing_job_allowed(p_job.id))
     and (reserved_microusd<=limit_microusd-greatest(spent_microusd,provider_actual_microusd)
      or fluid_private.api_text_testing_job_allowed(p_job.id))),
 'publicationGeneration',p_dispatch.publication_generation,'publishedMessageId',p_dispatch.published_message_id,'publishedAt',p_dispatch.published_at)) end;$new$),
 ('fluid_private.strategy_job_summary(jobs)',$old$select jsonb_build_object('id',p_job.id,'owner_id',p_job.owner_id,'project_id',p_job.project_id,'operation',p_job.operation,
   'input_revision',p_job.input_revision,'state',p_job.state,'progress',p_job.progress,'cancel_requested_at',p_job.cancel_requested_at,
   'error_code',p_job.error_code,'created_at',p_job.created_at,'finished_at',p_job.finished_at)
   || case when p_job.billing_mode='chatgpt_subscription' then jsonb_build_object('billingMode','chatgpt_subscription','policyIdentity',p_job.policy_identity)
     else jsonb_build_object('reserved_cost_microusd',p_job.reserved_cost_microusd,'actual_cost_microusd',p_job.actual_cost_microusd) end;$old$,$new$select jsonb_build_object('id',p_job.id,'owner_id',p_job.owner_id,'project_id',p_job.project_id,'operation',p_job.operation,
   'input_revision',p_job.input_revision,'state',p_job.state,'progress',p_job.progress,'cancel_requested_at',p_job.cancel_requested_at,
   'error_code',p_job.error_code,'created_at',p_job.created_at,'finished_at',p_job.finished_at)
   || case when p_job.billing_mode='chatgpt_subscription' then jsonb_build_object('billingMode','chatgpt_subscription','policyIdentity',p_job.policy_identity)
     else jsonb_build_object('reserved_cost_microusd',p_job.reserved_cost_microusd,'actual_cost_microusd',p_job.actual_cost_microusd) end
 ||case when fluid_private.managed_strategy_uncapped_job(p_job.id) then jsonb_build_object('billingMode','openai_api','spendControl','uncapped','policyIdentity',p_job.input->>'policyIdentity') else '{}'::jsonb end;$new$)
 loop
 definition:=pg_get_functiondef(signature::regprocedure);
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_managed_strategy_fragment: %',signature; end if;
 execute replace(definition,original,replacement);
 end loop;
end $patch$;

-- Remove hostile/default ACLs. Only the two authenticated owner facades get
-- grants; private witnesses are never callable/writeable by customers/workers.
do $deny$
declare object_id oid; entry record; t text;
begin
 foreach t in array array['managed_strategy_admission_context','managed_strategy_uncapped_jobs'] loop
  execute format('alter table fluid_private.%I enable row level security',t);
  execute format('revoke all on fluid_private.%I from PUBLIC,anon,authenticated,service_role',t);
  for entry in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   where c.oid=to_regclass('fluid_private.'||t) and a.grantee<>c.relowner loop
   execute format('revoke all on fluid_private.%I from %s cascade',t,case when entry.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(entry.grantee)) end);
  end loop;
 end loop;
 for object_id in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='fluid_private' and p.proname like 'managed_strategy_%' or n.nspname='public' and p.proname in('get_managed_strategy_availability','enqueue_managed_strategy_job') loop
  for entry in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,case when entry.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(entry.grantee)) end);
  end loop;
 end loop;
end $deny$;
grant execute on function public.get_managed_strategy_availability(uuid),public.enqueue_managed_strategy_job(uuid,integer,text,text,text) to authenticated;
commit;
