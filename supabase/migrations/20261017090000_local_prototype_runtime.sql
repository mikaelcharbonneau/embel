-- Additive, disabled-by-default local capability seam. This migration changes
-- no existing job, receipt, reservation, account allowance, policy or worker ACL.
-- A separately reviewed operator packet must bind and enable one existing role.
begin;

do $guard$
declare signature text; expected text; definer boolean; volatility text;
begin
 for signature,expected,definer,volatility in values
 ('public.report_strategy_worker_ready(text,jsonb,integer)','2c722a819b9942fc43474c0e65ba23f1',true,'v'),
 ('public.claim_job(text,integer)','48e560e83701bb9f7ba7a009d3bdab19',true,'v'),
 ('public.expire_job_leases()','d04502bd2571ff066dca962cde98f044',true,'v'),
 ('fluid_private.lock_leased_job(uuid,uuid)','0328f6164af1d668434f25ce30fe0c28',false,'v'),
 ('public.begin_job_step(uuid,uuid,text,text,bigint)','e514725d6f0e323495788024bfa40ac9',true,'v'),
 ('fluid_private.naming_brain_paid_resume(fluid_private.naming_brain_runs)','10961b25301369e10f7d3abd0c0f7931',false,'s'),
 ('public.claim_naming_brain_job(text,text,integer)','19429c3d77f6a88eaa73b9480c26a30b',true,'v'),
 ('public.ensure_naming_brain_run(uuid,jsonb)','418c0de01a8ef9108753eb560d3b8eb6',true,'v'),
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)','6e78f6979b1cf7779ed6b6c9ed92f7ab',true,'v'),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)','b0cc743c36ec280e3da8b72186098bdb',true,'v') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.prosecdef=definer and p.provolatile::text=volatility and p.proconfig=array['search_path=""']
   and not p.proleakproof and p.proowner=(select oid from pg_roles where rolname=current_user)) then raise exception 'unexpected_local_runtime_predecessor: %',signature; end if;
 end loop;
end $guard$;

create table fluid_private.local_prototype_strategy_capabilities (
 owner_id uuid not null references auth.users(id),
 operation text not null references fluid_private.strategy_runtime_policy(operation)
  check(operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')),
 role_name name not null, role_oid oid not null,
 deployment_id text not null check(deployment_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
 policy jsonb not null check(fluid_private.api_text_guided_policy(operation,policy)),
 enabled boolean not null default false,
 ready_until timestamptz,
 primary key(owner_id,operation)
);
create table fluid_private.local_prototype_jobs (
 job_id uuid primary key,
 owner_id uuid not null, project_id uuid not null,
 role_name name not null, role_oid oid not null,
 deployment_id text not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
create trigger local_prototype_job_immutable before update or delete on fluid_private.local_prototype_jobs
 for each row execute function fluid_private.api_text_admission_immutable();
create function fluid_private.local_prototype_invalidate_readiness() returns trigger language plpgsql set search_path='' as $$
begin
 if (new.owner_id,new.operation,new.role_name,new.role_oid,new.deployment_id,new.policy,new.enabled) is distinct from
 (old.owner_id,old.operation,old.role_name,old.role_oid,old.deployment_id,old.policy,old.enabled) then new.ready_until:=null; end if;
 return new;
end $$;
create trigger local_prototype_readiness before update on fluid_private.local_prototype_strategy_capabilities
 for each row execute function fluid_private.local_prototype_invalidate_readiness();
-- This context exists only while the authenticated local Naming wrapper runs.
-- A transaction-bound private row cannot be forged through a session GUC.
create table fluid_private.local_prototype_admission_context (
 backend_pid integer not null, transaction_id bigint not null,
 owner_id uuid not null, project_id uuid not null,
 primary key(backend_pid,transaction_id)
);

create function fluid_private.local_prototype_owner_enabled(p_owner uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.local_prototype_strategy_capabilities c
  join fluid_private.naming_brain_pilots p on p.owner_id=c.owner_id and p.role_name=c.role_name and p.role_oid=c.role_oid
  where c.owner_id=p_owner and c.enabled and fluid_private.api_text_restricted_role(c.role_name,c.role_oid));
$$;
create function fluid_private.local_strategy_worker_owner() returns uuid
language sql stable set search_path='' as $$
 select case when count(distinct c.owner_id)=1 then min(c.owner_id::text)::uuid else null end
 from fluid_private.local_prototype_strategy_capabilities c
 join fluid_private.naming_brain_pilots p on p.owner_id=c.owner_id and p.role_name=c.role_name and p.role_oid=c.role_oid
 where c.role_name=session_user and fluid_private.api_text_restricted_role(c.role_name,c.role_oid);
$$;
create function fluid_private.local_prototype_job_worker(p_job uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.local_prototype_jobs j
  where j.job_id=p_job and j.role_name=session_user and fluid_private.api_text_restricted_role(j.role_name,j.role_oid));
$$;
create function fluid_private.local_prototype_project_paused(p_owner uuid,p_project uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.jobs j where j.owner_id=p_owner and j.project_id=p_project and j.billing_mode='openai_api'
 and (j.actual_cost_microusd>j.reserved_cost_microusd or ((j.state='needs_reconciliation'
  or exists(select 1 from public.job_steps s where s.job_id=j.id and s.state='ambiguous'))
  and not fluid_private.research_operator_adjudication_matches(j.id))));
$$;
create function fluid_private.local_prototype_paid_paused(p_owner uuid,p_project uuid,p_job uuid default null) returns boolean
language sql stable set search_path='' as $$
 select case when fluid_private.local_prototype_owner_enabled(p_owner) and (
  exists(select 1 from fluid_private.local_prototype_jobs local_job where local_job.job_id=p_job and local_job.owner_id=p_owner and local_job.project_id=p_project)
  or exists(select 1 from fluid_private.local_prototype_admission_context c where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.owner_id=p_owner and c.project_id=p_project))
 then fluid_private.local_prototype_project_paused(p_owner,p_project)
 else fluid_private.api_text_paid_paused(p_owner) end;
$$;
create function fluid_private.local_strategy_job_ready(p_job uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.jobs j join fluid_private.local_prototype_jobs marker on marker.job_id=j.id
 join fluid_private.local_prototype_strategy_capabilities c on c.owner_id=j.owner_id and c.operation=j.operation
  and c.role_name=marker.role_name and c.role_oid=marker.role_oid and c.deployment_id=marker.deployment_id
 join fluid_private.strategy_runtime_policy p on p.operation=c.operation and p.policy=c.policy and p.enabled
 where j.id=p_job and c.enabled and c.ready_until>clock_timestamp() and c.policy=j.input->'policy'
 and fluid_private.local_prototype_job_worker(j.id) and not fluid_private.local_prototype_project_paused(j.owner_id,j.project_id));
$$;

create function public.get_local_strategy_availability(p_project_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid(); operations jsonb;
begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and owner_id=o and deleted_at is null and deletion_requested_at is null) then raise exception 'not_found' using errcode='P0002'; end if;
 if not fluid_private.local_prototype_owner_enabled(o) then return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','runtime_disabled'); end if;
 select coalesce(jsonb_agg(jsonb_build_object('operation',c.operation,'maximumCostMicrousd',(c.policy->>'maximumCostMicrousd')::bigint,'interviewVersion',1) order by c.operation),'[]')
 into operations from fluid_private.local_prototype_strategy_capabilities c
 join fluid_private.strategy_runtime_policy p on p.operation=c.operation and p.enabled and p.policy=c.policy
 join public.usage_accounts a on a.owner_id=c.owner_id
 where c.owner_id=o and c.enabled and c.ready_until>clock_timestamp()
 and fluid_private.api_text_restricted_role(c.role_name,c.role_oid)
 and (c.policy->>'maximumCostMicrousd')::bigint<=a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd)-a.reserved_microusd
 and (p_project_id is null or not fluid_private.local_prototype_project_paused(o,p_project_id))
 and (p_project_id is null or not exists(select 1 from public.jobs j
  where j.owner_id=o and j.project_id=p_project_id and fluid_private.api_text_operation(j.operation) and j.state in('queued','running','cancel_requested','needs_reconciliation')));
 return case when jsonb_array_length(operations)>0 then jsonb_build_object('status','available','operations',operations)
 else jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','worker_unavailable') end;
end $$;

create function public.enqueue_local_strategy_job(p_project_id uuid,p_expected_revision integer,p_operation text,p_idempotency_key text,p_accepted_max_cost_microusd bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid(); p public.projects; c fluid_private.local_prototype_strategy_capabilities;
 j public.jobs; input jsonb; input_hash text; maximum bigint;
begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_expected_revision is null or p_expected_revision<1 or p_operation is null or p_operation not in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')
 or p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9._:-]{16,128}$'
 or p_accepted_max_cost_microusd is null or p_accepted_max_cost_microusd not between 0 and 9007199254740991 then raise exception 'invalid_input' using errcode='22023'; end if;
 perform fluid_private.lock_strategy_owner(o);
 select * into p from public.projects where id=p_project_id and owner_id=o and deleted_at is null and deletion_requested_at is null for share;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select job.* into j from public.jobs job join fluid_private.local_prototype_jobs local_job on local_job.job_id=job.id where job.owner_id=o and job.idempotency_key=p_idempotency_key;
 if found then
  if (j.project_id,j.operation,j.input_revision,(j.input->>'acceptedMaxCostMicrousd')::bigint) is distinct from(p_project_id,p_operation,p_expected_revision,p_accepted_max_cost_microusd) then raise exception 'idempotency_conflict' using errcode='23505'; end if;
  return fluid_private.strategy_job_summary(j);
 end if;
 if exists(select 1 from public.jobs where owner_id=o and idempotency_key=p_idempotency_key) then raise exception 'idempotency_conflict' using errcode='23505'; end if;
 if p.current_revision<>p_expected_revision then raise exception 'revision_conflict' using errcode='PT409'; end if;
 select cap.* into c from fluid_private.local_prototype_strategy_capabilities cap
 join fluid_private.strategy_runtime_policy runtime on runtime.operation=cap.operation and runtime.enabled and runtime.policy=cap.policy
 where cap.owner_id=o and cap.operation=p_operation and cap.enabled and cap.ready_until>clock_timestamp()
 and fluid_private.api_text_restricted_role(cap.role_name,cap.role_oid) for share of cap;
 if not found or not fluid_private.local_prototype_owner_enabled(o) then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
 if fluid_private.local_prototype_project_paused(o,p_project_id) then raise exception 'paid_outcome_unresolved' using errcode='P0001'; end if;
 if exists(select 1 from public.jobs running where running.owner_id=o and running.project_id=p_project_id and fluid_private.api_text_operation(running.operation) and running.state in('queued','running','cancel_requested','needs_reconciliation')) then raise exception 'active_strategy_request' using errcode='PT409'; end if;
 maximum:=(c.policy->>'maximumCostMicrousd')::bigint;
 if p_accepted_max_cost_microusd<maximum then raise exception 'accepted_cap_exceeded' using errcode='22023'; end if;
 input:=fluid_private.guided_api_strategy_input(o,p_project_id,p_expected_revision,p_operation,c.policy,p_accepted_max_cost_microusd);
 input_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into j from public.enqueue_job(o,p_project_id,p_operation,p_expected_revision,input_hash,input,p_idempotency_key,maximum,3);
 insert into fluid_private.local_prototype_jobs(job_id,owner_id,project_id,role_name,role_oid,deployment_id) values(j.id,o,p_project_id,c.role_name,c.role_oid,c.deployment_id);
 return fluid_private.strategy_job_summary(j);
end $$;

create function fluid_private.report_local_strategy_ready(p_operation text,p_policy jsonb,p_seconds integer) returns boolean
language plpgsql set search_path='' as $$
begin
 if p_seconds is null or p_seconds not between 1 and 90 then raise exception 'invalid_readiness_window' using errcode='22023'; end if;
 update fluid_private.local_prototype_strategy_capabilities c set ready_until=clock_timestamp()+make_interval(secs=>p_seconds)
 from fluid_private.strategy_runtime_policy p where c.owner_id=fluid_private.local_strategy_worker_owner() and c.operation=p_operation
 and c.role_name=session_user and c.enabled and c.policy=p_policy and p.operation=c.operation and p.enabled and p.policy=c.policy
 and fluid_private.api_text_restricted_role(c.role_name,c.role_oid);
 return found;
end $$;
create function fluid_private.claim_local_strategy_job(p_worker text,p_seconds integer) returns setof public.jobs
language plpgsql set search_path='' as $$
declare j public.jobs; o uuid:=fluid_private.local_strategy_worker_owner();
begin
 if o is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_worker is null or length(p_worker) not between 1 and 100 or p_seconds is null or p_seconds not between 5 and 300 then raise exception 'invalid_lease' using errcode='22023'; end if;
 perform fluid_private.lock_strategy_owner(o);
 select candidate.* into j from public.jobs candidate join fluid_private.local_prototype_jobs marker on marker.job_id=candidate.id
 join fluid_private.local_prototype_strategy_capabilities c on c.owner_id=candidate.owner_id and c.operation=candidate.operation and c.role_name=marker.role_name and c.role_oid=marker.role_oid
 join fluid_private.strategy_runtime_policy p on p.operation=c.operation and p.policy=c.policy and p.enabled
 join public.usage_accounts a on a.owner_id=candidate.owner_id
 where candidate.owner_id=o and marker.role_name=session_user and fluid_private.local_prototype_job_worker(candidate.id)
 and candidate.input->'policy'=c.policy and c.enabled and c.ready_until>clock_timestamp()
 and candidate.billing_mode='openai_api' and fluid_private.api_text_operation(candidate.operation) and candidate.state='queued' and candidate.attempts<candidate.max_attempts
 and not fluid_private.local_prototype_project_paused(candidate.owner_id,candidate.project_id)
 and not exists(select 1 from public.jobs busy join fluid_private.local_prototype_jobs local_job on local_job.job_id=busy.id
  where busy.owner_id=o and fluid_private.api_text_operation(busy.operation) and busy.state in('running','cancel_requested'))
 and a.reserved_microusd<=a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd)
 order by candidate.created_at,candidate.id for update of candidate skip locked limit 1;
 if not found then return; end if;
 return query update public.jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_seconds),worker_id=p_worker,attempts=attempts+1 where id=j.id returning *;
end $$;
create function fluid_private.lock_local_strategy_job(p_job uuid,p_token uuid) returns public.jobs
language plpgsql set search_path='' as $$
declare j public.jobs;
begin
 if not fluid_private.local_prototype_job_worker(p_job) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 select * into j from public.jobs where id=p_job;
 if not found or not fluid_private.api_text_operation(j.operation) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 perform fluid_private.lock_strategy_owner(j.owner_id);
 select * into j from public.jobs where id=p_job for update;
 if p_token is null or j.lease_token is distinct from p_token or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() or j.state not in('running','cancel_requested') then raise exception 'lease_lost' using errcode='PT409'; end if;
 return j;
end $$;
create function fluid_private.expire_local_strategy_leases() returns integer
language plpgsql set search_path='' as $$
declare j public.jobs; next_state text; count integer:=0; o uuid:=fluid_private.local_strategy_worker_owner();
begin
 if o is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 perform fluid_private.lock_strategy_owner(o);
 for j in select candidate.* from public.jobs candidate join fluid_private.local_prototype_jobs marker on marker.job_id=candidate.id
 where candidate.owner_id=o and fluid_private.api_text_operation(candidate.operation) and fluid_private.local_prototype_job_worker(candidate.id)
 and candidate.state in('running','cancel_requested') and candidate.lease_expires_at<=clock_timestamp() for update of candidate skip locked loop
  if exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then next_state:='needs_reconciliation';
  elsif j.state='cancel_requested' then next_state:='cancelled';
  elsif j.attempts<j.max_attempts then next_state:='queued';
  elsif exists(select 1 from public.job_steps where job_id=j.id and state='succeeded') then next_state:='partial'; else next_state:='failed'; end if;
  if next_state in('cancelled','partial','failed') then perform fluid_private.settle_reservation(j.id); end if;
  update public.jobs set state=next_state,lease_token=null,lease_expires_at=null,error_code=case when next_state='needs_reconciliation' then 'lease_expired_with_unresolved_step' else 'lease_expired' end,finished_at=case when next_state in('cancelled','partial','failed') then clock_timestamp() else null end where id=j.id;
  count:=count+1;
 end loop;
 return count;
end $$;
create function public.read_local_strategy_steps(p_job_id uuid,p_owner_id uuid,p_project_id uuid,p_step_key text default null)
returns table(state text,request_key text,reserved_cost_microusd bigint)
language plpgsql stable security definer set search_path='' as $$
begin
 if not fluid_private.local_prototype_job_worker(p_job_id) or not exists(select 1 from public.jobs j join fluid_private.local_prototype_jobs marker on marker.job_id=j.id
 where j.id=p_job_id and j.owner_id=p_owner_id and j.project_id=p_project_id and fluid_private.api_text_operation(j.operation)) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_step_key is not null and length(p_step_key) not between 1 and 200 then raise exception 'invalid_input' using errcode='22023'; end if;
 return query select s.state,s.request_key,s.reserved_cost_microusd from public.job_steps s
 where s.job_id=p_job_id and s.owner_id=p_owner_id and s.project_id=p_project_id and (p_step_key is null or s.step_key=p_step_key);
end $$;

-- The Naming login must not receive generic mutation EXECUTE: those APIs also
-- support managed Naming, whose richer stage validation lives in its own RPCs.
create function public.local_strategy_job_action(p_job_id uuid,p_action text,p_arguments jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs; count integer;
begin
 if not fluid_private.local_prototype_job_worker(p_job_id) or not exists(select 1 from public.jobs job
  where job.id=p_job_id and fluid_private.api_text_operation(job.operation)) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_action is null or jsonb_typeof(p_arguments) is distinct from 'array' or octet_length(p_arguments::text)>1048576 then raise exception 'invalid_input' using errcode='22023'; end if;
 count:=jsonb_array_length(p_arguments);
 case
 when p_action='heartbeat' and count=2 then
  return to_jsonb(public.heartbeat_job(p_job_id,(p_arguments->>0)::uuid,(p_arguments->>1)::integer));
 when p_action='plan' and count=2 then
  return to_jsonb(public.register_job_plan(p_job_id,(p_arguments->>0)::uuid,p_arguments->1));
 when p_action='begin' and count=4 then
  return to_jsonb(public.begin_job_step(p_job_id,(p_arguments->>0)::uuid,p_arguments->>1,p_arguments->>2,(p_arguments->>3)::bigint));
 when p_action='complete' and count=6 then
  return to_jsonb(public.complete_job_step(p_job_id,(p_arguments->>0)::uuid,p_arguments->>1,p_arguments->>2,(p_arguments->>3)::bigint,p_arguments->4,p_arguments->>5));
 when p_action='finish' and count=3 then
  return to_jsonb(public.finish_job(p_job_id,(p_arguments->>0)::uuid,p_arguments->>1,p_arguments->>2));
 else raise exception 'invalid_input' using errcode='22023'; end case;
end $$;

create function public.ensure_local_naming_brain_run(p_project_id uuid,p_intent jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid(); result jsonb; r fluid_private.naming_brain_runs; p fluid_private.naming_brain_pilots;
begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=o and deleted_at is null and deletion_requested_at is null) then raise exception 'not_found' using errcode='P0002'; end if;
 if not fluid_private.local_prototype_owner_enabled(o) then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
 perform fluid_private.lock_strategy_owner(o);
 insert into fluid_private.local_prototype_admission_context values(pg_backend_pid(),txid_current(),o,p_project_id);
 result:=public.ensure_naming_brain_run(p_project_id,p_intent);
 select run.* into r from fluid_private.naming_brain_runs run join fluid_private.naming_brain_intents intent on intent.run_id=run.id
 where intent.owner_id=o and intent.project_id=p_project_id and intent.request_key=p_intent->>'idempotencyKey'
 and run.owner_id=o and run.project_id=p_project_id;
 -- Only this exact invocation's newly admitted run may gain local authority.
 -- A replay, historical quarantine or saved result is never relabelled.
 if found and r.created_at>=statement_timestamp() and not exists(select 1 from fluid_private.local_prototype_jobs where job_id=r.job_id) then
  select * into strict p from fluid_private.naming_brain_pilots where id=r.pilot_id and owner_id=o;
  insert into fluid_private.local_prototype_jobs(job_id,owner_id,project_id,role_name,role_oid,deployment_id) values(r.job_id,o,p_project_id,p.role_name,p.role_oid,p.deployment_id);
 end if;
 delete from fluid_private.local_prototype_admission_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
 return result;
end $$;

-- Existing worker APIs retain their signatures and ACLs. Their hosted bodies
-- remain the fallback; local authority can touch only immutable marked jobs.
do $patch$
declare signature text; original text; replacement text; definition text;
begin
 for signature,original,replacement in values
 ('public.report_strategy_worker_ready(text,jsonb,integer)',$old$begin$old$,$new$begin
  if fluid_private.local_strategy_worker_owner() is not null then return fluid_private.report_local_strategy_ready(p_operation,p_policy,p_ready_seconds); end if;
  if session_user<>'postgres' and session_user<>'service_role' and coalesce(pg_catalog.current_setting('role',true),'')<>'service_role' then return false; end if;$new$),
 ('public.claim_job(text,integer)',$old$begin$old$,$new$begin
  if fluid_private.local_strategy_worker_owner() is not null then return query select * from fluid_private.claim_local_strategy_job(p_worker_id,p_lease_seconds); return; end if;$new$),
 ('public.expire_job_leases()',$old$begin$old$,$new$begin
  if fluid_private.local_strategy_worker_owner() is not null then return fluid_private.expire_local_strategy_leases(); end if;$new$),
 ('fluid_private.lock_leased_job(uuid,uuid)',$old$if not fluid_private.naming_brain_is_job(j) then$old$,$new$if fluid_private.api_text_operation(j.operation) and exists(select 1 from fluid_private.local_prototype_jobs where job_id=j.id) then return fluid_private.lock_local_strategy_job(p_job_id,p_lease_token); end if;
 if not fluid_private.naming_brain_is_job(j) then$new$),
 ('public.begin_job_step(uuid,uuid,text,text,bigint)',$old$if fluid_private.api_text_paid_paused(v_job.owner_id) then$old$,$new$if fluid_private.api_text_paid_paused(v_job.owner_id) and not fluid_private.local_prototype_job_worker(v_job.id) then$new$),
 ('public.begin_job_step(uuid,uuid,text,text,bigint)',$old$  if v_job.state <> 'running' then$old$,$new$  if fluid_private.api_text_operation(v_job.operation) and exists(select 1 from fluid_private.local_prototype_jobs where job_id=v_job.id) and not fluid_private.local_strategy_job_ready(v_job.id) then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
  if v_job.state <> 'running' then$new$),
 ('fluid_private.naming_brain_paid_resume(fluid_private.naming_brain_runs)',$old$fluid_private.api_text_paid_paused(r.owner_id)$old$,$new$fluid_private.local_prototype_paid_paused(r.owner_id,r.project_id,r.job_id)$new$),
 ('public.claim_naming_brain_job(text,text,integer)',$old$fluid_private.api_text_paid_paused(o)$old$,$new$fluid_private.local_prototype_paid_paused(o,r0.project_id,r0.job_id)$new$),
 ('public.ensure_naming_brain_run(uuid,jsonb)',$old$fluid_private.api_text_paid_paused(o)$old$,$new$fluid_private.local_prototype_paid_paused(o,p.id)$new$),
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)',$old$fluid_private.api_text_paid_paused(r.owner_id)$old$,$new$fluid_private.local_prototype_paid_paused(r.owner_id,r.project_id,r.job_id)$new$),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)',
 $old$other.owner_id=r.owner_id and other.billing_mode='openai_api'$old$,
 $new$other.owner_id=r.owner_id and other.billing_mode='openai_api'
 and (not exists(select 1 from fluid_private.local_prototype_jobs marker where marker.job_id=r.job_id) or other.project_id=r.project_id)$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_local_runtime_fragment: %',signature; end if;
  execute replace(definition,original,replacement);
 end loop;
end $patch$;

-- New functions/tables deny hostile default grants. Existing ACLs are unchanged;
-- only the three authenticated local wrappers are callable until explicit grants.
do $deny$
declare object_id oid; privilege record;
begin
 for object_id in select oid from pg_class where relnamespace='fluid_private'::regnamespace and relkind='r' and relname like 'local_prototype_%' loop
  execute format('alter table %s enable row level security',object_id::regclass);
  execute format('alter table %s force row level security',object_id::regclass);
  for privilege in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=object_id and a.grantee<>c.relowner loop
   execute format('revoke all on table %s from %s cascade',object_id::regclass,case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
  end loop;
 end loop;
 for object_id in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='fluid_private' and p.proname in('local_prototype_invalidate_readiness','local_prototype_owner_enabled','local_strategy_worker_owner','local_prototype_job_worker','local_prototype_project_paused','local_prototype_paid_paused','local_strategy_job_ready','report_local_strategy_ready','claim_local_strategy_job','lock_local_strategy_job','expire_local_strategy_leases'))
 or (n.nspname='public' and p.proname in('get_local_strategy_availability','enqueue_local_strategy_job','read_local_strategy_steps','local_strategy_job_action','ensure_local_naming_brain_run')) loop
  for privilege in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
  end loop;
 end loop;
end $deny$;
grant execute on function public.get_local_strategy_availability(uuid),public.enqueue_local_strategy_job(uuid,integer,text,text,bigint),public.ensure_local_naming_brain_run(uuid,jsonb) to authenticated;
commit;
