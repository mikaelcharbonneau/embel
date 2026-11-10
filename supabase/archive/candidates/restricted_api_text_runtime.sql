-- REVIEW CANDIDATE ONLY. No login, credentials, owner binding, policy enabling,
-- worker grant, hosted migration or provider call is performed by this file.
begin;
create table fluid_private.api_text_worker_principals (
 role_name name primary key, role_oid oid not null unique,
 owner_id uuid not null references auth.users(id) on delete cascade
);
alter table fluid_private.api_text_worker_principals enable row level security;
alter table fluid_private.api_text_worker_principals force row level security;
revoke all on fluid_private.api_text_worker_principals from public,anon,authenticated,service_role;

create function public.api_text_worker_owner() returns uuid
language sql stable security definer set search_path='' as $$
 select p.owner_id from fluid_private.api_text_worker_principals p
 join pg_catalog.pg_roles r on r.oid=p.role_oid and r.rolname=p.role_name
 where p.role_name=session_user and r.rolcanlogin and not r.rolinherit
 and not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb
 and not r.rolcreaterole and not r.rolreplication
 and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid)
 and not exists(select 1 from pg_catalog.pg_shdepend d where d.refclassid='pg_catalog.pg_authid'::regclass and d.refobjid=r.oid and d.deptype='o');
$$;
revoke all on function public.api_text_worker_owner() from public,anon,authenticated,service_role;
grant execute on function public.api_text_worker_owner() to public;

create function fluid_private.api_text_operation(p_operation text) returns boolean language sql immutable set search_path='' as $$
 select p_operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning');
$$;
create table fluid_private.strategy_billing_routes (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 billing_mode text not null check(billing_mode in ('openai_api','chatgpt_subscription')),
 revision integer not null check(revision>0)
);
create table fluid_private.api_strategy_bindings (
 owner_id uuid not null references auth.users(id) on delete cascade,
 operation text not null check(fluid_private.api_text_operation(operation)),
 role_oid oid not null, policy_identity text not null check(policy_identity ~ '^[0-9a-f]{64}$'),
 deployment_id text not null check(deployment_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
 enabled boolean not null default false, primary key(owner_id,operation)
);
create table fluid_private.api_text_dispatches (
 job_id uuid primary key references public.jobs(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,
 project_id uuid not null,
 policy_identity text not null check(policy_identity ~ '^[0-9a-f]{64}$'),
 deployment_id text not null check(deployment_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
 dispatch_identity text not null unique check(dispatch_identity ~ '^[0-9a-f]{64}$'),
 publication_generation integer not null default 0 check(publication_generation>=0),
 generation_started_at timestamptz not null default clock_timestamp(),
 published_message_id text check(length(published_message_id) between 1 and 300),
 published_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 check((published_message_id is null)=(published_at is null)),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
create index api_text_dispatch_pending on fluid_private.api_text_dispatches(owner_id,published_at,created_at);
alter table fluid_private.strategy_billing_routes enable row level security;
alter table fluid_private.strategy_billing_routes force row level security;
alter table fluid_private.api_strategy_bindings enable row level security;
alter table fluid_private.api_strategy_bindings force row level security;
alter table fluid_private.api_text_dispatches enable row level security;
alter table fluid_private.api_text_dispatches force row level security;
revoke all on fluid_private.strategy_billing_routes,fluid_private.api_strategy_bindings,fluid_private.api_text_dispatches from public,anon,authenticated,service_role;

create function fluid_private.protect_api_text_dispatch() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'immutable_dispatch' using errcode='55000'; end if;
 if (new.job_id,new.owner_id,new.project_id,new.policy_identity,new.deployment_id,new.dispatch_identity,new.created_at)
    is distinct from (old.job_id,old.owner_id,old.project_id,old.policy_identity,old.deployment_id,old.dispatch_identity,old.created_at)
    or new.publication_generation not in (old.publication_generation,old.publication_generation+1)
    or (new.publication_generation=old.publication_generation and new.generation_started_at is distinct from old.generation_started_at)
    or (new.publication_generation=old.publication_generation and old.published_at is not null and
       (new.published_at,new.published_message_id) is distinct from (old.published_at,old.published_message_id))
    or (new.publication_generation=old.publication_generation+1 and
       (new.generation_started_at<=old.generation_started_at or new.published_at is not null or new.published_message_id is not null)) then
   raise exception 'immutable_dispatch' using errcode='55000';
 end if;
 return new;
end $$;
create trigger api_text_dispatch_immutable before update or delete on fluid_private.api_text_dispatches
 for each row execute function fluid_private.protect_api_text_dispatch();

-- Coordinate owner advisory + route first. Admission then locks project before
-- account; leased mutations lock job/step before account, matching logo settlement.
-- Never lock account inside this helper: legacy logo completion is project ->
-- job -> account. Account -> project/job would introduce a cross-runtime cycle.
create function fluid_private.lock_strategy_owner(p_owner uuid) returns void language plpgsql set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,723902));
 perform 1 from fluid_private.strategy_billing_routes where owner_id=p_owner for update;
end $$;
create function fluid_private.subscription_strategy_route(p_owner uuid,p_operation text) returns boolean language sql stable set search_path='' as $$
 select not fluid_private.api_text_operation(p_operation) or not exists(
  select 1 from fluid_private.strategy_billing_routes where owner_id=p_owner and billing_mode<>'chatgpt_subscription');
$$;
create function fluid_private.api_text_paid_paused(p_owner uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.jobs j where j.owner_id=p_owner and j.billing_mode='openai_api'
 and (j.state='needs_reconciliation' or j.actual_cost_microusd>j.reserved_cost_microusd
   or exists(select 1 from public.job_steps s where s.job_id=j.id and s.state='ambiguous')));
$$;

-- Administrative-only CAS. Call in the same reviewed transaction as approved
-- binding changes. Never rewrites jobs, subscription policies or ledger counters.
create function fluid_private.set_strategy_billing_route(p_owner uuid,p_expected_revision integer,p_mode text) returns integer
language plpgsql set search_path='' as $$
declare v_revision integer;
begin
 if p_owner is null or p_expected_revision is null or p_expected_revision<0 or p_mode is null or p_mode not in ('openai_api','chatgpt_subscription') then raise exception 'invalid_route' using errcode='22023'; end if;
 perform fluid_private.lock_strategy_owner(p_owner);
 perform 1 from public.usage_accounts where owner_id=p_owner for update;
 select revision into v_revision from fluid_private.strategy_billing_routes where owner_id=p_owner;
 if coalesce(v_revision,0)<>p_expected_revision then raise exception 'route_revision_conflict' using errcode='PT409'; end if;
 if exists(select 1 from public.jobs where owner_id=p_owner and fluid_private.api_text_operation(operation)
   and (state in ('running','cancel_requested') or lease_expires_at>clock_timestamp())) then raise exception 'strategy_work_active' using errcode='55000'; end if;
 -- Subscription uncertainty is deliberately preserved, never retried or rewritten.
 if exists(select 1 from public.jobs where owner_id=p_owner and billing_mode='chatgpt_subscription' and state='needs_reconciliation'
   and (reserved_cost_microusd<>0 or actual_cost_microusd<>0 or max_attempts<>1 or lease_token is not null or lease_expires_at is not null)) then
   raise exception 'subscription_history_not_zero_cost' using errcode='55000'; end if;
 if fluid_private.api_text_paid_paused(p_owner) then raise exception 'paid_outcome_unresolved' using errcode='55000'; end if;
 if p_mode='openai_api' and not exists(select 1 from public.usage_accounts where owner_id=p_owner and limit_microusd<=5000000
   and reserved_microusd<=limit_microusd-greatest(spent_microusd,provider_actual_microusd)) then raise exception 'budget_unavailable' using errcode='55000'; end if;
 -- Rollback must explicitly review/drain queued API and preserved subscription work.
 if p_mode='chatgpt_subscription' and exists(select 1 from public.jobs where owner_id=p_owner and fluid_private.api_text_operation(operation) and state='queued') then
   raise exception 'queued_strategy_review_required' using errcode='55000'; end if;
 insert into fluid_private.strategy_billing_routes values(p_owner,p_mode,coalesce(v_revision,0)+1)
 on conflict(owner_id) do update set billing_mode=excluded.billing_mode,revision=excluded.revision;
 return coalesce(v_revision,0)+1;
end $$;

create function fluid_private.api_text_policy_allowed(p_owner uuid,p_operation text,p_policy jsonb,p_deployment text,p_role oid default null)
returns boolean language sql stable set search_path='' as $$
 select coalesce(p_operation in ('strategy.reformulate','strategy.audience','strategy.personality','strategy.positioning')
 and p_policy->'version'='1'::jsonb and p_policy->>'pricingVersion'='2026-10-03'
 and p_policy->'webSearchMicrousdPerCall'='10000'::jsonb
 and p_policy->>'model'='gpt-6.1-sol' and p_policy->>'handlerVersion'='strategy-openai-v1'
 and p_policy->'maxInputTokens'='32768'::jsonb and p_policy->'maxOutputTokens'='4096'::jsonb
 and p_policy->'maxWebSearchCalls'='0'::jsonb and p_policy->'maximumCostMicrousd'='122880'::jsonb
 and p_policy->'inputMicrousdPerMillionTokens'='2000000'::jsonb
 and p_policy->'cachedInputMicrousdPerMillionTokens'='100000'::jsonb
 and p_policy->'cacheWriteMicrousdPerMillionTokens'='2500000'::jsonb
 and p_policy->'outputMicrousdPerMillionTokens'='10000000'::jsonb
 and exists(select 1 from fluid_private.strategy_billing_routes where owner_id=p_owner and billing_mode='openai_api')
 and exists(select 1 from fluid_private.api_strategy_bindings b
 join fluid_private.api_text_worker_principals w on w.owner_id=b.owner_id and w.role_oid=b.role_oid
 join pg_catalog.pg_roles r on r.oid=w.role_oid and r.rolname=w.role_name
 join fluid_private.strategy_runtime_policy p on p.operation=b.operation
 where b.owner_id=p_owner and b.operation=p_operation and b.enabled and p.enabled and p.policy=p_policy
 and b.policy_identity=encode(sha256(convert_to(p_policy::text,'UTF8')),'hex') and b.deployment_id=p_deployment
 and (p_role is null or b.role_oid=p_role) and r.rolcanlogin and not r.rolinherit and not r.rolsuper and not r.rolbypassrls
 and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
 and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid)
 and not exists(select 1 from pg_catalog.pg_shdepend d where d.refclassid='pg_catalog.pg_authid'::regclass and d.refobjid=r.oid and d.deptype='o')),false);
$$;
create function public.check_api_text_runtime(p_operation text,p_policy jsonb,p_deployment_id text) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=public.api_text_worker_owner();
begin
 if v_owner is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 perform fluid_private.lock_strategy_owner(v_owner);
 perform 1 from public.usage_accounts where owner_id=v_owner for share;
 return fluid_private.api_text_policy_allowed(v_owner,p_operation,p_policy,p_deployment_id,(select oid from pg_catalog.pg_roles where rolname=session_user))
 and not fluid_private.api_text_paid_paused(v_owner)
 and exists(select 1 from public.usage_accounts where owner_id=v_owner and limit_microusd<=5000000
 and reserved_microusd<=limit_microusd-greatest(spent_microusd,provider_actual_microusd));
end $$;
create function public.api_text_worker_can_read_step(p_job_id uuid,p_owner_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select p_owner_id=public.api_text_worker_owner() and exists(select 1 from public.jobs j join fluid_private.api_text_dispatches d on d.job_id=j.id
 where j.id=p_job_id and j.owner_id=p_owner_id and j.billing_mode='openai_api' and fluid_private.api_text_operation(j.operation));
$$;
create policy api_text_worker_step_read on public.job_steps for select to public using(public.api_text_worker_can_read_step(job_id,owner_id));

create function fluid_private.api_text_descriptor(p_job public.jobs,p_dispatch fluid_private.api_text_dispatches) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('version',1,'jobId',p_job.id,'operation',p_job.operation,'policyIdentity',p_dispatch.policy_identity,
 'deploymentId',p_dispatch.deployment_id,'dispatchIdentity',p_dispatch.dispatch_identity,'state',p_job.state,
 'retryable',p_job.state='queued' and p_job.attempts<p_job.max_attempts and not exists(select 1 from public.job_steps where job_id=p_job.id)
   and fluid_private.api_text_policy_allowed(p_job.owner_id,p_job.operation,p_job.input->'policy',p_dispatch.deployment_id,(select oid from pg_catalog.pg_roles where rolname=session_user))
   and not fluid_private.api_text_paid_paused(p_job.owner_id)
   and exists(select 1 from public.usage_accounts where owner_id=p_job.owner_id and limit_microusd<=5000000
     and reserved_microusd<=limit_microusd-greatest(spent_microusd,provider_actual_microusd)),
 'publicationGeneration',p_dispatch.publication_generation,'publishedMessageId',p_dispatch.published_message_id,'publishedAt',p_dispatch.published_at);
$$;
create function public.get_api_text_dispatch(p_job_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=public.api_text_worker_owner(); v_result jsonb;
begin
 if v_owner is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 select fluid_private.api_text_descriptor(j,d) into v_result from public.jobs j join fluid_private.api_text_dispatches d on d.job_id=j.id
 where j.id=p_job_id and j.owner_id=v_owner and d.owner_id=v_owner and j.billing_mode='openai_api' and fluid_private.api_text_operation(j.operation);
 return v_result;
end $$;
create function public.list_pending_api_text_dispatches(p_limit integer) returns setof jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=public.api_text_worker_owner();
begin
 if v_owner is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'invalid_limit' using errcode='22023'; end if;
 return query select fluid_private.api_text_descriptor(j,d) from public.jobs j join fluid_private.api_text_dispatches d on d.job_id=j.id
 where j.owner_id=v_owner and d.owner_id=v_owner and j.billing_mode='openai_api' and fluid_private.api_text_operation(j.operation)
 and ((j.state='queued' and fluid_private.api_text_descriptor(j,d)->'retryable'='true'::jsonb)
   or (j.state in ('running','cancel_requested') and (j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp()))) order by coalesce(d.published_at,d.created_at),j.id limit p_limit;
end $$;
create function public.mark_api_text_published(p_job_id uuid,p_dispatch_identity text,p_generation integer,p_message_id text) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=public.api_text_worker_owner(); d fluid_private.api_text_dispatches;
begin
 if v_owner is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_message_id is null or length(p_message_id) not between 1 and 300 then raise exception 'invalid_message_id' using errcode='22023'; end if;
 select * into d from fluid_private.api_text_dispatches where job_id=p_job_id and owner_id=v_owner for update;
 if not found or d.dispatch_identity is distinct from p_dispatch_identity or d.publication_generation is distinct from p_generation then return false; end if;
 if d.published_at is not null then return d.published_message_id=p_message_id; end if;
 update fluid_private.api_text_dispatches set published_message_id=p_message_id,published_at=clock_timestamp() where job_id=p_job_id;
 return true;
end $$;

create or replace function fluid_private.lock_leased_job(p_job_id uuid,p_lease_token uuid)
returns public.jobs language plpgsql set search_path='' as $$
declare j public.jobs; s_owner uuid:=public.subscription_worker_owner(); a_owner uuid:=public.api_text_worker_owner();
 v_service boolean:=(session_user='service_role' or pg_catalog.current_setting('role',true)='service_role');
begin
 select * into j from public.jobs where id=p_job_id;
 if not found then raise exception 'lease_lost' using errcode='PT409'; end if;
 if j.operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') then raise exception 'logo_worker_required' using errcode='42501'; end if;
 if (j.billing_mode='chatgpt_subscription' and (s_owner is null or j.owner_id is distinct from s_owner))
 or (j.billing_mode='openai_api' and not (
   (a_owner is not null and j.owner_id=a_owner and fluid_private.api_text_operation(j.operation) and exists(select 1 from fluid_private.api_text_dispatches where job_id=j.id and owner_id=a_owner))
   or (s_owner is null and a_owner is null and v_service and not exists(select 1 from fluid_private.api_text_dispatches where job_id=j.id)))) then
   raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 perform fluid_private.lock_strategy_owner(j.owner_id);
 select * into j from public.jobs where id=p_job_id for update;
 if p_lease_token is null or j.lease_token is distinct from p_lease_token or j.lease_expires_at is null
 or j.lease_expires_at<=clock_timestamp() or j.state not in ('running','cancel_requested') then raise exception 'lease_lost' using errcode='PT409'; end if;
 -- Settlement deliberately does not depend on a still-enabled admission policy.
 return j;
end $$;
create function public.expire_api_text_job(p_job_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=public.api_text_worker_owner(); j public.jobs; v_next text;
begin
 if v_owner is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 perform fluid_private.lock_strategy_owner(v_owner);
 select j0.* into j from public.jobs j0 join fluid_private.api_text_dispatches d on d.job_id=j0.id
 where j0.id=p_job_id and j0.owner_id=v_owner and d.owner_id=v_owner and j0.billing_mode='openai_api' and fluid_private.api_text_operation(j0.operation) for update of j0;
 if not found then return jsonb_build_object('disposition','not_found','state','not_found'); end if;
 if j.state not in ('queued','running','cancel_requested') then return jsonb_build_object('disposition','terminal','state',j.state); end if;
 if j.state='queued' then return jsonb_build_object('disposition','available','state',j.state); end if;
 if j.lease_expires_at>clock_timestamp() then return jsonb_build_object('disposition','busy','state',j.state); end if;
 if exists(select 1 from public.job_steps where job_id=j.id and state in ('in_flight','ambiguous')) then v_next:='needs_reconciliation';
 elsif j.state='cancel_requested' then v_next:='cancelled';
 elsif j.attempts<j.max_attempts and not exists(select 1 from public.job_steps where job_id=j.id) then v_next:='queued';
 elsif exists(select 1 from public.job_steps where job_id=j.id and state='succeeded') then v_next:='partial';
 else v_next:='failed'; end if;
 if v_next in ('cancelled','partial','failed') then perform fluid_private.settle_reservation(j.id); end if;
 update public.jobs set state=v_next,lease_token=null,lease_expires_at=null,
 error_code=case when v_next='needs_reconciliation' then 'lease_expired_with_unresolved_step' else 'lease_expired' end,
 finished_at=case when v_next in ('cancelled','partial','failed') then clock_timestamp() else null end where id=j.id;
 return jsonb_build_object('disposition',case when v_next='queued' then 'available' else 'terminal' end,'state',v_next);
end $$;
create function public.claim_api_text_job(p_job_id uuid,p_worker_id text,p_lease_seconds integer,p_policy_identity text,p_deployment_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=public.api_text_worker_owner(); j public.jobs; d fluid_private.api_text_dispatches;
begin
 if v_owner is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_worker_id is null or length(p_worker_id) not between 1 and 100 or p_lease_seconds is null or p_lease_seconds not between 5 and 300 then raise exception 'invalid_lease' using errcode='22023'; end if;
 perform fluid_private.lock_strategy_owner(v_owner);
 select j0.* into j from public.jobs j0 join fluid_private.api_text_dispatches d0 on d0.job_id=j0.id
 where j0.id=p_job_id and j0.owner_id=v_owner and d0.owner_id=v_owner and j0.billing_mode='openai_api' and fluid_private.api_text_operation(j0.operation) for update of j0;
 if not found then return jsonb_build_object('disposition','not_found','state','not_found'); end if;
 if j.state not in ('queued','running','cancel_requested') then return jsonb_build_object('disposition','terminal','state',j.state); end if;
 select * into strict d from fluid_private.api_text_dispatches where job_id=j.id;
 if d.policy_identity is distinct from p_policy_identity or d.deployment_id is distinct from p_deployment_id
 or not public.check_api_text_runtime(j.operation,j.input->'policy',p_deployment_id) then return jsonb_build_object('disposition','unavailable','state',j.state); end if;
 if j.state<>'queued' then return jsonb_build_object('disposition','busy','state',j.state); end if;
 if j.attempts>=j.max_attempts or exists(select 1 from public.job_steps where job_id=j.id) then return jsonb_build_object('disposition','unavailable','state',j.state); end if;
 -- At most three claims for predispatch recovery. The immutable step forbids
 -- any second paid request once a step begins. Attempts only increase.
 update public.jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
 worker_id=p_worker_id,attempts=attempts+1 where id=j.id returning * into j;
 return jsonb_build_object('disposition','claimed','state',j.state,'job',to_jsonb(j));
end $$;
create function public.authorize_api_text_dispatch(p_job_id uuid,p_lease_token uuid,p_step_key text,p_policy_identity text,p_deployment_id text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=public.api_text_worker_owner(); j public.jobs;
begin
 if v_owner is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 j:=fluid_private.lock_leased_job(p_job_id,p_lease_token);
 if j.owner_id is distinct from v_owner or j.billing_mode<>'openai_api' or not fluid_private.api_text_operation(j.operation) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 return j.state='running' and j.cancel_requested_at is null
 and exists(select 1 from fluid_private.api_text_dispatches where job_id=j.id and owner_id=v_owner and policy_identity=p_policy_identity and deployment_id=p_deployment_id)
 and exists(select 1 from public.job_steps where job_id=j.id and step_key=p_step_key and state='in_flight' and reserved_cost_microusd=122880)
 and public.check_api_text_runtime(j.operation,j.input->'policy',p_deployment_id);
end $$;
create function public.prepare_api_text_redrive(p_job_id uuid,p_dispatch_identity text,p_expected_generation integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=public.api_text_worker_owner(); j public.jobs; d fluid_private.api_text_dispatches; v_descriptor jsonb;
begin
 if v_owner is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 perform fluid_private.lock_strategy_owner(v_owner);
 select * into j from public.jobs where id=p_job_id and owner_id=v_owner and billing_mode='openai_api' and fluid_private.api_text_operation(operation) for update;
 if not found then return null; end if;
 select * into d from fluid_private.api_text_dispatches where job_id=p_job_id and owner_id=v_owner for update;
 if not found or d.dispatch_identity is distinct from p_dispatch_identity or d.publication_generation is distinct from p_expected_generation then return null; end if;
 v_descriptor:=fluid_private.api_text_descriptor(j,d);
 if v_descriptor->'retryable' is distinct from 'true'::jsonb or d.generation_started_at>clock_timestamp()-interval '30 minutes' then return null; end if;
 update fluid_private.api_text_dispatches set publication_generation=publication_generation+1,generation_started_at=clock_timestamp(),published_at=null,published_message_id=null where job_id=j.id returning * into d;
 return fluid_private.api_text_descriptor(j,d);
end $$;

create or replace function public.enqueue_strategy_job(p_project_id uuid, p_expected_revision integer, p_operation text,
  p_idempotency_key text, p_accepted_max_cost_microusd bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_project public.projects; v_revision public.project_revisions;
  v_policy fluid_private.strategy_runtime_policy; v_job public.jobs; v_account public.usage_accounts; v_maximum bigint; v_binding fluid_private.api_strategy_bindings; v_dispatch fluid_private.api_text_dispatches;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_expected_revision is null or p_expected_revision < 1
    or p_operation is null or p_operation not in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')
    or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or p_accepted_max_cost_microusd is null or p_accepted_max_cost_microusd not between 0 and 9007199254740991 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if not exists(select 1 from public.projects where id = p_project_id and owner_id = v_owner) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform fluid_private.lock_strategy_owner(v_owner);
  -- Read existence for historical replay without taking the account row lock.
  -- New admission locks the project before the shared ledger below.
  select * into v_account from public.usage_accounts where owner_id = v_owner;
  if not found then raise exception 'budget_unavailable' using errcode = 'P0001'; end if;
  select * into v_job from public.jobs where owner_id = v_owner and idempotency_key = p_idempotency_key;
  if found then
    if (v_job.billing_mode, v_job.project_id, v_job.operation, v_job.input_revision, (v_job.input->>'acceptedMaxCostMicrousd')::bigint)
      is distinct from ('openai_api', p_project_id, p_operation, p_expected_revision, p_accepted_max_cost_microusd) then
      raise exception 'idempotency_conflict' using errcode = '23505';
    end if;
    -- Replaying the same request is stable even after edits, policy changes or outage.
    select * into v_dispatch from fluid_private.api_text_dispatches where job_id=v_job.id;
    return fluid_private.strategy_job_summary(v_job) || case when v_dispatch.job_id is null then '{}'::jsonb else jsonb_build_object('dispatch',jsonb_build_object('version',1,'jobId',v_job.id,'policyIdentity',v_dispatch.policy_identity,'deploymentId',v_dispatch.deployment_id,'dispatchIdentity',v_dispatch.dispatch_identity)) end;
  end if;
  if exists(select 1 from fluid_private.strategy_billing_routes where owner_id=v_owner and billing_mode<>'openai_api')
    or (not exists(select 1 from fluid_private.strategy_billing_routes where owner_id=v_owner) and exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation<>'naming.generate')) then
    raise exception 'billing_mode_conflict' using errcode='PT409';
  end if;
  select * into v_project from public.projects where id = p_project_id and owner_id = v_owner for share;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_project.current_revision <> p_expected_revision then raise exception 'revision_conflict' using errcode = 'PT409'; end if;
  select * into v_account from public.usage_accounts where owner_id = v_owner for update;
  if not found then raise exception 'budget_unavailable' using errcode='P0001'; end if;
  if fluid_private.api_text_paid_paused(v_owner) then raise exception 'paid_outcome_unresolved' using errcode='P0001'; end if;
  select * into v_policy from fluid_private.strategy_runtime_policy where operation = p_operation and enabled for share;
  select * into v_binding from fluid_private.api_strategy_bindings where owner_id=v_owner and operation=p_operation;
  if not found or not fluid_private.api_text_policy_allowed(v_owner,p_operation,v_policy.policy,v_binding.deployment_id) then
    raise exception 'runtime_unavailable' using errcode = 'P0001';
  end if;
  if v_account.limit_microusd>5000000 then raise exception 'budget_unavailable' using errcode='P0001'; end if;
  v_maximum := (v_policy.policy->>'maximumCostMicrousd')::bigint;
  if p_accepted_max_cost_microusd < v_maximum then raise exception 'accepted_cap_exceeded' using errcode = '22023'; end if;
  select * into strict v_revision from public.project_revisions
    where project_id = p_project_id and owner_id = v_owner and revision = p_expected_revision;
  select * into v_job from public.enqueue_job(v_owner, p_project_id, p_operation, p_expected_revision, v_revision.input_hash,
    jsonb_build_object('version',1,'context',v_revision.context,'policy',v_policy.policy,'acceptedMaxCostMicrousd',p_accepted_max_cost_microusd),
    p_idempotency_key, v_maximum, 3);
  insert into fluid_private.api_text_dispatches(job_id,owner_id,project_id,policy_identity,deployment_id,dispatch_identity) values(v_job.id,v_owner,p_project_id,v_binding.policy_identity,v_binding.deployment_id,encode(sha256(convert_to(v_job.id::text||':'||v_binding.policy_identity||':'||v_binding.deployment_id,'UTF8')),'hex')) returning * into v_dispatch;
  return fluid_private.strategy_job_summary(v_job) || jsonb_build_object('dispatch',jsonb_build_object('version',1,'jobId',v_job.id,'policyIdentity',v_dispatch.policy_identity,'deploymentId',v_dispatch.deployment_id,'dispatchIdentity',v_dispatch.dispatch_identity));
end $$;

create or replace function public.enqueue_subscription_strategy_job(p_project_id uuid,p_expected_revision integer,p_operation text,p_idempotency_key text,p_accepted_policy_identity text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_project public.projects; v_revision public.project_revisions; v_policy fluid_private.subscription_runtime_policy; v_job public.jobs; v_input jsonb;
 v_history jsonb := '{"entries":[],"truncated":false}'::jsonb; v_candidate jsonb; v_entry jsonb; v_source record;
 v_frozen_at timestamptz;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_expected_revision is null or p_expected_revision<1 or p_operation is null or p_operation not in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')
   or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
   or p_accepted_policy_identity is null or p_accepted_policy_identity !~ '^[0-9a-f]{64}$' then raise exception 'invalid_input' using errcode='22023'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 -- Serialize all operations/registrations for this owner, without a USD account.
 perform fluid_private.lock_strategy_owner(v_owner);
 select * into v_job from public.jobs where owner_id=v_owner and idempotency_key=p_idempotency_key;
 if found then
   if (v_job.project_id,v_job.operation,v_job.input_revision,v_job.billing_mode) is distinct from (p_project_id,p_operation,p_expected_revision,'chatgpt_subscription') then raise exception 'idempotency_conflict' using errcode='23505'; end if;
   if v_job.policy_identity<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='PT409'; end if;
   return fluid_private.strategy_job_summary(v_job);
 end if;
 select * into v_job from public.jobs where owner_id=v_owner and project_id=p_project_id and input_revision=p_expected_revision and operation=p_operation and billing_mode='chatgpt_subscription';
 if found then
   if v_job.policy_identity<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='PT409'; end if;
   return fluid_private.strategy_job_summary(v_job);
 end if;
 if not fluid_private.subscription_strategy_route(v_owner,p_operation) then raise exception 'billing_mode_conflict' using errcode='PT409'; end if;
 select * into v_project from public.projects where id=p_project_id and owner_id=v_owner for share;
 if v_project.current_revision<>p_expected_revision then raise exception 'revision_conflict' using errcode='PT409'; end if;
 select * into v_policy from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation=p_operation and enabled for share;
 if not found or v_policy.worker_ready_until is null or v_policy.worker_ready_until<=clock_timestamp() then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
 if encode(sha256(convert_to(v_policy.policy::text,'UTF8')),'hex')<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='PT409'; end if;
 if (select count(*) from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and created_at>clock_timestamp()-interval '1 hour') >= (v_policy.policy->'limits'->>'maxRequestsPerHour')::integer
   or (select count(*) from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and state in ('queued','running','cancel_requested')) >= (v_policy.policy->'limits'->>'maxQueuedJobs')::integer then raise exception 'quota_unavailable' using errcode='P0001'; end if;
 select * into strict v_revision from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=p_expected_revision;
 v_input:=jsonb_build_object('version',2,'billingMode','chatgpt_subscription','context',v_revision.context,'policy',v_policy.policy,'assistantHistory',v_history);
 -- Freeze one database snapshot of completed, bound sources. Never read partial
 -- text, provider reasoning, browser-authored assistant events or another tenant.
 -- Provider context/history are JSON strings inside the request. Budget their
 -- escaped serialization as well as raw history, with room for instructions and
 -- output schema. Whole-entry omission never raises the selected input limit.
 v_frozen_at:=clock_timestamp();
 for v_source in
   select j.id as job_id,j.owner_id,j.project_id,j.input_revision,s.step_key,s.completed_at,s.output
   from public.jobs j join public.job_steps s on s.job_id=j.id and s.owner_id=j.owner_id and s.project_id=j.project_id
   where j.owner_id=v_owner and j.project_id=p_project_id and j.input_revision<=p_expected_revision
     and j.state='succeeded' and j.finished_at<=v_frozen_at and s.state='succeeded' and s.completed_at<=v_frozen_at
     and j.operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')
     and s.output->'version'='1'::jsonb and s.output->>'provider'='openai'
     and s.output->>'operation'=j.operation and s.output->>'model'=j.input->'policy'->>'model'
     and coalesce(s.output->>'billingMode','openai_api')=j.billing_mode
     and s.provider_request_id=s.output->>'responseId'
     and jsonb_typeof(s.output->'proposal')='object'
     and s.output-array['version','provider','billingMode','operation','model','responseId','requestId','generatedAt','usage','proposal']='{}'::jsonb
   order by s.completed_at desc,j.id desc,s.step_key desc limit 6
 loop
   if jsonb_array_length(v_history->'entries')>=5 then
     v_history:=jsonb_set(v_history,'{truncated}','true'::jsonb); exit;
   end if;
   v_entry:=jsonb_build_object('jobId',v_source.job_id,'ownerId',v_source.owner_id,'projectId',v_source.project_id,
     'inputRevision',v_source.input_revision,'stepKey',v_source.step_key,'completedAt',v_source.completed_at,'output',v_source.output);
   v_candidate:=jsonb_set(v_history,'{entries}',(v_history->'entries')||jsonb_build_array(v_entry));
   if octet_length(v_candidate::text)<=32768
     and octet_length(to_jsonb(jsonb_set(v_input,'{assistantHistory}',v_candidate)::text)::text)+8192
       <=(v_policy.policy->'limits'->>'maxInputBytes')::integer then v_history:=v_candidate;
   else v_history:=jsonb_set(v_history,'{truncated}','true'::jsonb); end if;
 end loop;
 v_input:=jsonb_set(v_input,'{assistantHistory}',v_history);
 if octet_length(v_input::text)>(v_policy.policy->'limits'->>'maxInputBytes')::integer then raise exception 'input_too_large' using errcode='22023'; end if;
 insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,billing_mode,policy_identity)
   values(v_owner,p_project_id,p_operation,p_expected_revision,encode(sha256(convert_to(v_input::text,'UTF8')),'hex'),v_input,p_idempotency_key,0,1,'chatgpt_subscription',p_accepted_policy_identity) returning * into v_job;
 return fluid_private.strategy_job_summary(v_job);
end $$;

create or replace function public.claim_subscription_job(p_worker_id text,p_owner_id uuid,p_registration_id text,p_lease_seconds integer default 60)
returns setof public.jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_owner uuid:=public.subscription_worker_owner();
begin
 if v_owner is null or p_owner_id is distinct from v_owner then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_worker_id is null or length(p_worker_id) not between 1 and 100 or p_lease_seconds is null or p_lease_seconds not between 5 and 300 then raise exception 'invalid_lease' using errcode='22023'; end if;
 perform fluid_private.lock_strategy_owner(v_owner);
 select j.* into v_job from public.jobs j join fluid_private.subscription_runtime_policy p on p.owner_id=j.owner_id and p.operation=j.operation
   where j.operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') and j.billing_mode='chatgpt_subscription' and j.state='queued' and j.attempts<j.max_attempts and j.owner_id=p_owner_id
     and fluid_private.subscription_strategy_route(v_owner,j.operation) and p.registration_id=p_registration_id and p.enabled and p.worker_ready_until>clock_timestamp() and p.policy=j.input->'policy'
   order by j.created_at,j.id for update of j skip locked limit 1;
 if not found then return; end if;
 return query update public.jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
   worker_id=p_worker_id,attempts=attempts+1 where id=v_job.id returning *;
end $$;

create or replace function public.report_subscription_worker_ready(p_owner_id uuid,p_registration_id text,p_operation text,p_policy jsonb,p_ready_seconds integer default 60)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=public.subscription_worker_owner();
begin
  if v_owner is null or p_owner_id is distinct from v_owner then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
  if p_ready_seconds is null or p_ready_seconds not between 1 and 90 then raise exception 'invalid_readiness_window' using errcode='22023'; end if;
  perform fluid_private.lock_strategy_owner(v_owner);
  if not fluid_private.subscription_strategy_route(v_owner,p_operation) then return false; end if;
  update fluid_private.subscription_runtime_policy set worker_ready_until=clock_timestamp()+make_interval(secs=>p_ready_seconds)
    where owner_id=p_owner_id and registration_id=p_registration_id and operation=p_operation and enabled and policy=p_policy;
  return found;
end $$;

create or replace function public.begin_job_step(p_job_id uuid, p_lease_token uuid, p_step_key text, p_request_key text, p_max_cost_microusd bigint)
returns public.job_steps language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_step public.job_steps; v_pending bigint; v_account public.usage_accounts;
begin
  v_job := fluid_private.lock_leased_job(p_job_id, p_lease_token);
  if v_job.billing_mode='chatgpt_subscription' and not fluid_private.subscription_strategy_route(v_job.owner_id,v_job.operation) then raise exception 'billing_mode_conflict' using errcode='PT409'; end if;
  if exists(select 1 from fluid_private.api_text_dispatches where job_id=v_job.id) and not public.check_api_text_runtime(v_job.operation,v_job.input->'policy',(select deployment_id from fluid_private.api_text_dispatches where job_id=v_job.id)) then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
  if v_job.state <> 'running' then raise exception 'cancel_requested' using errcode = '55000'; end if;
  if v_job.billing_mode = 'openai_api' then
  if fluid_private.api_text_paid_paused(v_job.owner_id) then raise exception 'paid_outcome_unresolved' using errcode='P0001'; end if;
  select * into strict v_account from public.usage_accounts where owner_id = v_job.owner_id for share;
  if v_account.reserved_microusd > v_account.limit_microusd - greatest(v_account.spent_microusd, v_account.provider_actual_microusd) then
    raise exception 'budget_exceeded' using errcode = 'P0001';
  end if;
  else
    if p_max_cost_microusd is distinct from 0 then raise exception 'invalid_subscription_cost' using errcode='22023'; end if;
    if not exists(select 1 from fluid_private.subscription_runtime_policy p where p.owner_id=v_job.owner_id and p.operation=v_job.operation and p.enabled and p.worker_ready_until>clock_timestamp() and p.policy=v_job.input->'policy') then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
  end if;
  if v_job.plan_manifest is null then raise exception 'plan_required' using errcode = '55000'; end if;
  if not exists(select 1 from jsonb_array_elements(v_job.plan_manifest) planned(step)
      where planned.step->>'key' = p_step_key and (planned.step->>'maximumCostMicrousd')::numeric = p_max_cost_microusd) then
    raise exception 'plan_step_mismatch' using errcode = '22023';
  end if;
  select * into v_step from public.job_steps where job_id = p_job_id and step_key = p_step_key;
  if found then
    if (v_step.request_key, v_step.reserved_cost_microusd) is distinct from (p_request_key, p_max_cost_microusd) then
      raise exception 'idempotency_conflict' using errcode = '23505';
    end if;
    -- Returning an existing in-flight row must NOT authorize another provider call.
    raise exception 'step_already_started' using errcode = '55000';
  end if;
  select coalesce(sum(reserved_cost_microusd),0) into v_pending from public.job_steps where job_id = p_job_id and state in ('in_flight','ambiguous');
  if p_max_cost_microusd is null or p_max_cost_microusd < 0 or p_max_cost_microusd > v_job.reserved_cost_microusd - v_job.actual_cost_microusd - v_pending then
    raise exception 'budget_exceeded' using errcode = 'P0001';
  end if;
  insert into public.job_steps(job_id, owner_id, project_id, step_key, request_key, state, reserved_cost_microusd)
    values(v_job.id, v_job.owner_id, v_job.project_id, p_step_key, p_request_key, 'in_flight', p_max_cost_microusd) returning * into v_step;
  return v_step;
end $$;

create or replace function public.claim_job(p_worker_id text, p_lease_seconds integer default 60)
returns setof public.jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs;
begin
  if public.subscription_worker_owner() is not null or
    not (session_user='service_role' or pg_catalog.current_setting('role',true)='service_role') then
    raise exception 'worker_owner_mismatch' using errcode='42501';
  end if;
  if p_worker_id is null or length(p_worker_id) not between 1 and 100 or p_lease_seconds is null or p_lease_seconds not between 5 and 300 then
    raise exception 'invalid_lease' using errcode = '22023';
  end if;
  select j.* into v_job from public.jobs j join public.usage_accounts a on a.owner_id = j.owner_id
    where not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=j.id) and j.operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') and j.billing_mode = 'openai_api' and j.state = 'queued' and j.attempts < j.max_attempts
      and not fluid_private.api_text_paid_paused(j.owner_id) and a.reserved_microusd <= a.limit_microusd - greatest(a.spent_microusd, a.provider_actual_microusd)
    order by j.created_at, j.id for update of j skip locked limit 1;
  if not found then return; end if;
  return query update public.jobs set state = 'running', lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
    worker_id = p_worker_id, attempts = attempts + 1 where id = v_job.id returning *;
end $$;

create or replace function public.expire_job_leases() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_next text; v_count integer:=0; v_owner uuid:=public.subscription_worker_owner();
  v_api_worker boolean:=(session_user='service_role' or pg_catalog.current_setting('role',true)='service_role');
begin
  if v_owner is null and not v_api_worker then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
  for v_job in select * from public.jobs where not exists(select 1 from fluid_private.api_text_dispatches d where d.job_id=public.jobs.id) and operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') and lease_expires_at<=clock_timestamp() and state in ('running','cancel_requested')
    and ((billing_mode='chatgpt_subscription' and owner_id=v_owner)
      or (billing_mode='openai_api' and v_owner is null and v_api_worker)) for update skip locked loop
    if exists(select 1 from public.job_steps where job_id=v_job.id and state in ('in_flight','ambiguous')) then
      v_next:='needs_reconciliation';
    elsif v_job.state='cancel_requested' then v_next:='cancelled';
    elsif v_job.attempts<v_job.max_attempts then v_next:='queued';
    elsif exists(select 1 from public.job_steps where job_id=v_job.id and state='succeeded') then v_next:='partial';
    else v_next:='failed'; end if;
    if v_next in ('cancelled','partial','failed') then perform fluid_private.settle_reservation(v_job.id); end if;
    update public.jobs set state=v_next,lease_token=null,lease_expires_at=null,
      error_code=case when v_next='needs_reconciliation' then 'lease_expired_with_unresolved_step' else 'lease_expired' end,
      finished_at=case when v_next in ('cancelled','partial','failed') then clock_timestamp() else null end where id=v_job.id;
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

create or replace function public.request_job_cancel(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs;
begin
  if auth.uid() is not null then perform fluid_private.lock_strategy_owner(auth.uid()); end if;
  select * into v_job from public.jobs where id = p_job_id and owner_id = auth.uid() for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_job.state = 'queued' then
    perform fluid_private.settle_reservation(p_job_id);
    update public.jobs set state = 'cancelled', cancel_requested_at = clock_timestamp(), finished_at = clock_timestamp()
      where id = p_job_id returning * into v_job;
  elsif v_job.state = 'running' then
    update public.jobs set state = 'cancel_requested', cancel_requested_at = clock_timestamp() where id = p_job_id returning * into v_job;
  elsif v_job.state = 'needs_reconciliation' then
    update public.jobs set cancel_requested_at = coalesce(cancel_requested_at, clock_timestamp()) where id = p_job_id returning * into v_job;
  end if;
  return jsonb_build_object(
    'id', v_job.id, 'project_id', v_job.project_id, 'operation', v_job.operation,
    'input_revision', v_job.input_revision, 'state', v_job.state, 'progress', v_job.progress,
    'reserved_cost_microusd', v_job.reserved_cost_microusd, 'actual_cost_microusd', v_job.actual_cost_microusd,
    'cancel_requested_at', v_job.cancel_requested_at, 'error_code', v_job.error_code,
    'created_at', v_job.created_at, 'finished_at', v_job.finished_at);
end $$;

create or replace function public.get_api_strategy_availability(p_project_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_operations jsonb; a public.usage_accounts;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 if fluid_private.api_text_paid_paused(v_owner) then return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','budget_unavailable'); end if;
 select * into a from public.usage_accounts where owner_id=v_owner;
 if not found or a.limit_microusd>5000000 then return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','budget_unavailable'); end if;
 select coalesce(jsonb_agg(jsonb_build_object('operation',p.operation,'maximumCostMicrousd',(p.policy->>'maximumCostMicrousd')::bigint) order by p.operation),'[]'::jsonb)
 into v_operations from fluid_private.strategy_runtime_policy p join fluid_private.api_strategy_bindings b on b.operation=p.operation and b.owner_id=v_owner
 where fluid_private.api_text_policy_allowed(v_owner,p.operation,p.policy,b.deployment_id)
 and (p.policy->>'maximumCostMicrousd')::bigint<=a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd)-a.reserved_microusd;
 if jsonb_array_length(v_operations)=0 then return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','runtime_disabled'); end if;
 return jsonb_build_object('status','available','operations',v_operations);
end $$;

create or replace function public.get_strategy_availability(p_project_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_operations jsonb; v_hourly bigint; v_pending bigint;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
  if exists(select 1 from fluid_private.strategy_billing_routes where owner_id=v_owner and billing_mode='openai_api') then return public.get_api_strategy_availability(p_project_id); end if;
  if not exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation<>'naming.generate') then return public.get_api_strategy_availability(p_project_id); end if;
  if not exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation<>'naming.generate' and enabled) then
    return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','subscription_unavailable');
  end if;
  if not exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation<>'naming.generate' and enabled and worker_ready_until>clock_timestamp()) then
    return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','worker_unavailable');
  end if;
  select count(*) filter(where created_at>clock_timestamp()-interval '1 hour'),count(*) filter(where state in ('queued','running','cancel_requested'))
    into v_hourly,v_pending from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription';
  select coalesce(jsonb_agg(jsonb_build_object('operation',operation,'billingMode','chatgpt_subscription','policyIdentity',encode(sha256(convert_to(policy::text,'UTF8')),'hex'),'limits',policy->'limits') order by operation),'[]'::jsonb)
    into v_operations from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation<>'naming.generate' and enabled and worker_ready_until>clock_timestamp()
      and v_hourly<(policy->'limits'->>'maxRequestsPerHour')::integer and v_pending<(policy->'limits'->>'maxQueuedJobs')::integer;
  if jsonb_array_length(v_operations)=0 then return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','quota_unavailable'); end if;
  return jsonb_build_object('status','available','operations',v_operations);
end $$;

-- Exact new-function ACL inventory. No worker login is created/granted here.
revoke all on function
 fluid_private.api_text_operation(text),fluid_private.protect_api_text_dispatch(),fluid_private.lock_strategy_owner(uuid),
 fluid_private.subscription_strategy_route(uuid,text),fluid_private.api_text_paid_paused(uuid),
 fluid_private.set_strategy_billing_route(uuid,integer,text),fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid),
 fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches),
 public.api_text_worker_can_read_step(uuid,uuid),public.check_api_text_runtime(text,jsonb,text),
 public.get_api_text_dispatch(uuid),public.list_pending_api_text_dispatches(integer),
 public.mark_api_text_published(uuid,text,integer,text),public.expire_api_text_job(uuid),
 public.claim_api_text_job(uuid,text,integer,text,text),public.authorize_api_text_dispatch(uuid,uuid,text,text,text),
 public.prepare_api_text_redrive(uuid,text,integer)
from public,anon,authenticated,service_role;
grant execute on function public.api_text_worker_can_read_step(uuid,uuid) to public;

-- Shared text/image uncertainty pause; preserve existing principals, ACLs and settlement.
create or replace function fluid_private.logo_operation_ready(p_owner uuid,p_operation text) returns boolean language sql volatile set search_path='' as $$
 select exists(
  select 1 from fluid_private.logo_worker_readiness r
  join fluid_private.logo_runtime_policies p on p.owner_id=r.owner_id and p.operation=r.operation
  join fluid_private.logo_worker_principals binding on binding.role_oid=r.role_oid and binding.owner_id=r.owner_id
  join pg_catalog.pg_roles role on role.oid=binding.role_oid and role.rolname=binding.role_name
  where r.owner_id=p_owner and r.operation=p_operation and r.ready_until>clock_timestamp() and p.enabled
   and (p.subscription_policy is not null or p.max_cost_microusd=0 or not fluid_private.api_text_paid_paused(p.owner_id))
   and r.descriptor=fluid_private.logo_policy_descriptor(p)
   and (p.subscription_policy is null or fluid_private.logo_subscription_registration_ready(p.owner_id,p.subscription_policy))
   and role.rolcanlogin and not role.rolinherit and not role.rolsuper and not role.rolbypassrls and not role.rolcreatedb and not role.rolcreaterole and not role.rolreplication
   and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=role.oid)
 )
$$;

-- Shared text/image uncertainty pause; preserve existing principals, ACLs and settlement.
create or replace function fluid_private.logo_job_ready(j public.jobs,p_worker text) returns boolean language sql volatile set search_path='' as $$
 select exists(select 1 from fluid_private.logo_worker_readiness r
  join fluid_private.logo_runtime_policies p on p.owner_id=r.owner_id and p.operation=r.operation
  join pg_catalog.pg_roles login on login.oid=r.role_oid and login.rolname=session_user
  where r.owner_id=j.owner_id and r.owner_id=fluid_private.logo_worker_owner() and r.worker_id=p_worker and r.operation=j.operation
   and (p.subscription_policy is not null or p.max_cost_microusd=0 or not fluid_private.api_text_paid_paused(p.owner_id))
   and r.ready_until>clock_timestamp() and r.descriptor=fluid_private.logo_policy_descriptor(p) and fluid_private.logo_job_policy_matches(j,p)
   and (p.subscription_policy is null or (fluid_private.logo_subscription_registration_ready(j.owner_id,p.subscription_policy) and fluid_private.logo_subscription_quota_available(j.owner_id,p.subscription_policy,j.id))))
$$;

-- Scrub arbitrary hostile default grants only for newly introduced objects.
-- Existing signatures retain their owners and EXECUTE ACLs unchanged.
do $$ declare signature text; relation_id oid; r record; begin
 foreach signature in array array[
  'public.api_text_worker_owner()', 'public.api_text_worker_can_read_step(uuid,uuid)',
  'fluid_private.api_text_operation(text)', 'fluid_private.protect_api_text_dispatch()',
  'fluid_private.lock_strategy_owner(uuid)', 'fluid_private.subscription_strategy_route(uuid,text)',
  'fluid_private.api_text_paid_paused(uuid)', 'fluid_private.set_strategy_billing_route(uuid,integer,text)',
  'fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)',
  'fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)',
  'public.check_api_text_runtime(text,jsonb,text)', 'public.get_api_text_dispatch(uuid)',
  'public.list_pending_api_text_dispatches(integer)', 'public.mark_api_text_published(uuid,text,integer,text)',
  'public.expire_api_text_job(uuid)', 'public.claim_api_text_job(uuid,text,integer,text,text)',
  'public.authorize_api_text_dispatch(uuid,uuid,text,text,text)', 'public.prepare_api_text_redrive(uuid,text,integer)'
 ] loop
  for r in select distinct a.grantee from pg_catalog.pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid=signature::regprocedure and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',signature,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
 foreach relation_id in array array['fluid_private.api_text_worker_principals'::regclass,'fluid_private.strategy_billing_routes'::regclass,
  'fluid_private.api_strategy_bindings'::regclass,'fluid_private.api_text_dispatches'::regclass] loop
  for r in select distinct a.grantee from pg_catalog.pg_class p cross join lateral aclexplode(coalesce(p.relacl,acldefault('r',p.relowner))) a
    where p.oid=relation_id and a.grantee<>p.relowner loop
   execute format('revoke all on table %s from %s cascade',relation_id::regclass,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.api_text_worker_owner(),public.api_text_worker_can_read_step(uuid,uuid) to public;
commit;
