-- Naming maintenance leadership is distinct from paid readiness. No historical
-- input/evidence/accounting is rewritten. Stopped, coordinated rollout required.
begin;

do $predecessors$
declare signature text; expected text; expected_definer boolean; expected_volatility text;
begin
 for signature,expected,expected_definer,expected_volatility in values
 ('public.claim_naming_brain_job(text,text,integer)','4e300b9217f94229c6f9c87e7ea5f0fb',true,'v'),
 ('public.expire_naming_brain_leases(text,text)','d45f8fed269dfe46c9f7a5d053e6c1a7',true,'v'),
 ('public.attest_naming_brain_preferences(uuid,integer,text,jsonb,jsonb)','ae4a8e7726380ac0cc356f14af0d9354',true,'v'),
 ('public.report_naming_brain_worker_ready(jsonb,text,text,integer)','f2fa7b4c5dadd750ba4b001d3f95abf0',true,'v'),
 ('fluid_private.naming_brain_ready(fluid_private.naming_brain_runs,text)','35a5321f1e951d12def2c067ab52896b',false,'s') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.proowner=(select oid from pg_roles where rolname=current_user) and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.prosecdef=expected_definer and p.provolatile::text=expected_volatility
   and p.prolang=(select oid from pg_language where lanname=case when expected_volatility='s' then 'sql' else 'plpgsql' end)) then
   raise exception 'unexpected_naming_worker_authority_predecessor: %',signature;
  end if;
 end loop;
end $predecessors$;

create table fluid_private.naming_worker_leadership (
 owner_id uuid not null references auth.users(id), deployment_id text not null check(length(deployment_id) between 1 and 200),
 role_name name not null, role_oid oid not null, worker_id text not null check(length(worker_id) between 1 and 100),
 generation bigint not null check(generation between 1 and 9007199254740991), expires_at timestamptz not null,
 primary key(owner_id,deployment_id)
);
create table fluid_private.naming_worker_job_authority (
 job_id uuid primary key, owner_id uuid not null, project_id uuid not null, deployment_id text not null,
 worker_id text not null, generation bigint not null check(generation between 1 and 9007199254740991), lease_token uuid not null,
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
-- Trusted transaction-local capability, not a caller-controlled GUC. Empty
-- probes never insert a context row. It exists only around positive mutations.
create table fluid_private.naming_worker_gateway_context (
 backend_pid integer not null, transaction_id bigint not null, owner_id uuid not null, deployment_id text not null,
 role_name name not null, role_oid oid not null, worker_id text not null, generation bigint not null, action text not null,
 primary key(backend_pid,transaction_id)
);
alter table fluid_private.naming_worker_leadership enable row level security;
alter table fluid_private.naming_worker_leadership force row level security;
alter table fluid_private.naming_worker_job_authority enable row level security;
alter table fluid_private.naming_worker_job_authority force row level security;
alter table fluid_private.naming_worker_gateway_context enable row level security;
alter table fluid_private.naming_worker_gateway_context force row level security;

-- Keep the original implementations behind narrow private wrappers. Public OIDs
-- and ACLs stay in place; core eligibility/proof/settlement remains authoritative.
do $cores$
declare signature text; target text; definition text;
begin
 for signature,target in values
 ('public.claim_naming_brain_job(text,text,integer)','naming_worker_claim_core'),
 ('public.expire_naming_brain_leases(text,text)','naming_worker_expiry_core'),
 ('public.attest_naming_brain_preferences(uuid,integer,text,jsonb,jsonb)','naming_worker_attest_core'),
 ('fluid_private.naming_brain_ready(fluid_private.naming_brain_runs,text)','naming_worker_ready_core') loop
  definition:=pg_get_functiondef(signature::regprocedure);
  definition:=regexp_replace(definition,'^CREATE OR REPLACE FUNCTION [a-z_]+\.[a-z_]+','CREATE FUNCTION fluid_private.'||target);
  if target='naming_worker_expiry_core' then
   if (length(definition)-length(replace(definition,'order by j0.id for update of j0 skip locked loop','')))/length('order by j0.id for update of j0 skip locked loop')<>1
    or (length(definition)-length(replace(definition,'order by j0.id for update of j0,r0 skip locked','')))/length('order by j0.id for update of j0,r0 skip locked')<>1 then
    raise exception 'unexpected_naming_worker_expiry_batch_shape';
   end if;
   definition:=replace(definition,'order by j0.id for update of j0 skip locked loop','order by j0.id limit 20 for update of j0 skip locked loop');
   definition:=replace(definition,'order by j0.id for update of j0,r0 skip locked','order by j0.id limit greatest(0,20-n) for update of j0,r0 skip locked');
  end if;
  execute definition;
 end loop;
end $cores$;

create function fluid_private.naming_worker_scope(p_deployment text) returns uuid
language plpgsql stable set search_path='' as $$
declare o uuid:=fluid_private.naming_brain_worker_owner();
begin
 if o is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_deployment is null or length(p_deployment) not between 1 and 200 then raise exception 'invalid_deployment' using errcode='22023'; end if;
 if not exists(select 1 from fluid_private.naming_brain_pilots p where p.owner_id=o and p.deployment_id=p_deployment)
  and not exists(select 1 from fluid_private.naming_brain_runs r where r.owner_id=o and r.deployment_id=p_deployment and fluid_private.naming_brain_run_worker(r)) then
  raise exception 'worker_deployment_mismatch' using errcode='42501';
 end if;
 return o;
end $$;

create function fluid_private.naming_worker_context(p_owner uuid,p_deployment text,p_worker text,p_action text) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.naming_worker_gateway_context c
 join fluid_private.naming_worker_leadership l on l.owner_id=c.owner_id and l.deployment_id=c.deployment_id
 where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.role_name=session_user
 and fluid_private.api_text_restricted_role(c.role_name,c.role_oid)
 and c.owner_id=p_owner and (p_deployment is null or c.deployment_id=p_deployment) and (p_worker is null or c.worker_id=p_worker) and c.action=p_action
 and (l.role_name,l.role_oid,l.worker_id,l.generation)=(c.role_name,c.role_oid,c.worker_id,c.generation) and l.expires_at>clock_timestamp());
$$;

create function fluid_private.naming_worker_status_json(p_lease fluid_private.naming_worker_leadership,p_leader boolean,p_ready boolean,p_reason text) returns jsonb
language sql volatile set search_path='' as $$
 select jsonb_build_object('version',1,'leader',p_leader,'generation',case when p_leader then p_lease.generation else null end,
 'expiresAt',case when p_leader then p_lease.expires_at else null end,'serverTime',clock_timestamp(),'ready',p_leader and coalesce(p_ready,false),'reason',p_reason);
$$;

create function public.report_naming_brain_worker_status(p_policy jsonb,p_deployment_id text,p_worker_id text,p_generation bigint default null,p_lease_seconds integer default 60) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.naming_brain_worker_owner(); l fluid_private.naming_worker_leadership; p fluid_private.naming_brain_pilots; ready boolean;
begin
 if o is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_worker_id is null or length(p_worker_id) not between 1 and 100 or p_deployment_id is null or length(p_deployment_id) not between 1 and 200
  or p_lease_seconds is null or p_lease_seconds not between 5 and 120 or p_generation is not null and p_generation not between 1 and 9007199254740991
  or jsonb_typeof(p_policy) is distinct from 'object' or octet_length(p_policy::text)>8192 then raise exception 'invalid_worker_status' using errcode='22023'; end if;
 select * into strict p from fluid_private.naming_brain_pilots where owner_id=o;
 if p.deployment_id<>p_deployment_id and not exists(select 1 from fluid_private.naming_brain_runs r where r.owner_id=o and r.deployment_id=p_deployment_id and fluid_private.naming_brain_run_worker(r)) then
  return fluid_private.naming_worker_status_json(l,false,false,'binding_mismatch');
 end if;
 select * into l from fluid_private.naming_worker_leadership where owner_id=o and deployment_id=p_deployment_id;
 if p_generation is null and l.expires_at>clock_timestamp() then
  if (l.role_name,l.role_oid,l.worker_id)=(p.role_name,p.role_oid,p_worker_id) then
   ready:=p.enabled and p.policy=p_policy and p.deployment_id=p_deployment_id and p.worker_id=p_worker_id and p.ready_until>clock_timestamp();
   return fluid_private.naming_worker_status_json(l,true,ready,'leader');
  end if;
  return fluid_private.naming_worker_status_json(l,false,false,'held');
 end if;
 if p_generation is not null then
  if l.generation is null or (l.role_name,l.role_oid,l.worker_id,l.generation) is distinct from (p.role_name,p.role_oid,p_worker_id,p_generation) then
   return fluid_private.naming_worker_status_json(l,false,false,'fenced');
  end if;
  if l.expires_at<=clock_timestamp() then return fluid_private.naming_worker_status_json(l,false,false,'expired'); end if;
  -- Healthy renewal has no owner/account lock. It never changes generation.
  select * into strict l from fluid_private.naming_worker_leadership where owner_id=o and deployment_id=p_deployment_id for update;
  select * into strict p from fluid_private.naming_brain_pilots where owner_id=o for update;
  if (l.role_name,l.role_oid,l.worker_id,l.generation) is distinct from (p.role_name,p.role_oid,p_worker_id,p_generation) then
   return fluid_private.naming_worker_status_json(l,false,false,'fenced');
  end if;
  if l.expires_at<=clock_timestamp() then return fluid_private.naming_worker_status_json(l,false,false,'expired'); end if;
 else
  -- Do not displace a healthy legacy publisher during a stopped cutover.
  if l.generation is null and p.deployment_id=p_deployment_id and p.ready_until>clock_timestamp() and p.worker_id is distinct from p_worker_id then
   l.expires_at:=p.ready_until; return fluid_private.naming_worker_status_json(l,false,false,'held');
  end if;
  -- Only actual ownership acquisition/takeover serializes with admission/Stop.
  -- Order: owner/account -> leadership -> pilot. Never control -> owner.
  perform fluid_private.lock_strategy_owner(o);
  select * into l from fluid_private.naming_worker_leadership where owner_id=o and deployment_id=p_deployment_id for update;
  select * into strict p from fluid_private.naming_brain_pilots where owner_id=o for update;
  if l.expires_at>clock_timestamp() then
   if (l.role_name,l.role_oid,l.worker_id)=(p.role_name,p.role_oid,p_worker_id) then
    ready:=p.enabled and p.policy=p_policy and p.deployment_id=p_deployment_id and p.worker_id=p_worker_id and p.ready_until>clock_timestamp();
    return fluid_private.naming_worker_status_json(l,true,ready,'leader');
   end if;
   return fluid_private.naming_worker_status_json(l,false,false,'held');
  end if;
  if l.generation is null and p.deployment_id=p_deployment_id and p.ready_until>clock_timestamp() and p.worker_id is distinct from p_worker_id then
   l.expires_at:=p.ready_until; return fluid_private.naming_worker_status_json(l,false,false,'held');
  end if;
  if coalesce(l.generation,0)>=9007199254740991 then raise exception 'worker_generation_exhausted' using errcode='55000'; end if;
  insert into fluid_private.naming_worker_leadership(owner_id,deployment_id,role_name,role_oid,worker_id,generation,expires_at)
   values(o,p_deployment_id,p.role_name,p.role_oid,p_worker_id,coalesce(l.generation,0)+1,clock_timestamp()+make_interval(secs=>p_lease_seconds))
   on conflict(owner_id,deployment_id) do update set role_name=excluded.role_name,role_oid=excluded.role_oid,worker_id=excluded.worker_id,generation=excluded.generation,expires_at=excluded.expires_at returning * into l;
 end if;
 update fluid_private.naming_worker_leadership set expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds) where owner_id=o and deployment_id=p_deployment_id returning * into l;
 ready:=p.enabled and p.policy=p_policy and p.deployment_id=p_deployment_id;
 if p.deployment_id=p_deployment_id then
  update fluid_private.naming_brain_pilots set worker_id=p_worker_id,ready_until=case when ready then l.expires_at else null end where owner_id=o;
 end if;
 return fluid_private.naming_worker_status_json(l,true,ready,'leader');
end $$;

-- This guard adds generation fencing to the original paid-readiness predicate.
-- Unleased queued/reconciliation work can be claimed; a leased job requires the
-- exact binding installed only by successful v2 claim. Evidence RPCs do not use
-- this paid gate, and a heartbeat/resume can never rewrite the sidecar.
create function fluid_private.naming_worker_job_ready(r fluid_private.naming_brain_runs,p_worker text) returns boolean
language sql stable set search_path='' as $$
 select not exists(select 1 from fluid_private.naming_worker_leadership where owner_id=r.owner_id and deployment_id=r.deployment_id)
 or exists(select 1 from fluid_private.naming_worker_leadership l join public.jobs j on j.id=r.job_id
 join fluid_private.naming_brain_pilots p on p.owner_id=r.owner_id
 where l.owner_id=r.owner_id and l.deployment_id=r.deployment_id and l.role_name=r.admitted_role_name and l.role_oid=r.admitted_role_oid
 and l.expires_at>clock_timestamp() and l.worker_id=p.worker_id and (p_worker is null or l.worker_id=p_worker)
 and (p_worker is null or (j.lease_token is null and j.state in('queued','needs_reconciliation'))
 or exists(select 1 from fluid_private.naming_worker_job_authority a where a.job_id=j.id and a.owner_id=r.owner_id and a.project_id=r.project_id
 and (a.deployment_id,a.worker_id,a.generation,a.lease_token)=(l.deployment_id,l.worker_id,l.generation,j.lease_token))));
$$;
create or replace function fluid_private.naming_brain_ready(r fluid_private.naming_brain_runs,p_worker text default null) returns boolean
language sql stable set search_path='' as $$
 select fluid_private.naming_worker_ready_core(r,p_worker) and fluid_private.naming_worker_job_ready(r,p_worker);
$$;

-- Read-only advisory preflight. The core repeats every original predicate after
-- the mutation lock. CASE rejects exhausted/ambiguous historical work before
-- reading proof payloads; no tuple/advisory locks or context writes occur here.
create function fluid_private.naming_worker_claim_pending(p_owner uuid,p_deployment text,p_worker text) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.naming_brain_runs rr join public.jobs stopped on stopped.id=rr.job_id
 where rr.owner_id=p_owner and rr.deployment_id=p_deployment and fluid_private.naming_brain_run_worker(rr)
 and stopped.state in('queued','needs_reconciliation') and (stopped.cancel_requested_at is not null or rr.recovery_mode='observe_only')
 and case when exists(select 1 from public.job_steps s where s.job_id=stopped.id and s.state in('in_flight','ambiguous')) then false else
 not fluid_private.naming_brain_preparation_pending(rr)
 and exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=rr.id)
 and not exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=rr.id and not fluid_private.naming_brain_call_terminal(c)) end)
 or exists(select 1 from public.jobs j join fluid_private.naming_brain_runs r on r.job_id=j.id
 where r.owner_id=p_owner and j.owner_id=p_owner and r.deployment_id=p_deployment and fluid_private.naming_brain_is_job(j) and fluid_private.naming_brain_run_worker(r)
 and j.state in('queued','needs_reconciliation') and (
 case when r.observation_attempts>=12 or r.observation_deadline_at<=clock_timestamp() or r.next_observation_at>clock_timestamp() then false
 else fluid_private.naming_brain_observable(r) or fluid_private.naming_brain_preparation_recovery(r) end
 or case when j.state<>'queued' or r.recovery_mode<>'execute' or j.attempts>=j.max_attempts or j.cancel_requested_at is not null or r.superseded then false else
 not fluid_private.naming_brain_preparation_pending(r) and fluid_private.naming_brain_ready(r,p_worker)
 and not(r.observed_overrun and not fluid_private.naming_brain_unlimited_job(r.job_id)) and not fluid_private.naming_brain_paid_paused(p_owner,r.project_id,r.job_id)
 and not exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and paused)
 and (fluid_private.naming_brain_unlimited_job(r.job_id) or not exists(select 1 from fluid_private.naming_brain_runs overrun where overrun.owner_id=p_owner and overrun.observed_overrun)) end));
$$;

create function fluid_private.naming_worker_expiry_pending(p_owner uuid,p_deployment text) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from public.jobs j join fluid_private.naming_brain_runs r on r.job_id=j.id
 where r.owner_id=p_owner and r.deployment_id=p_deployment and fluid_private.naming_brain_run_worker(r)
 and j.state in('running','cancel_requested') and j.lease_expires_at<=clock_timestamp())
 or exists(select 1 from public.jobs j join fluid_private.naming_brain_runs r on r.job_id=j.id and r.owner_id=j.owner_id and r.project_id=j.project_id
 where r.owner_id=p_owner and r.deployment_id=p_deployment and fluid_private.naming_brain_run_worker(r)
 and j.state='needs_reconciliation' and j.lease_token is null and j.lease_expires_at is null
 and j.actual_cost_microusd=0 and not r.observed_overrun and r.actual_cost_microusd is null
 and j.error_code in('progressive_execution_unknown','progressive_context_unknown','local_planning_failed')
 and fluid_private.naming_brain_no_dispatch(j.id)
 and not exists(select 1 from fluid_private.naming_brain_provider_records where run_id=r.id)
 and not exists(select 1 from fluid_private.naming_brain_artifacts where run_id=r.id)
 and not exists(select 1 from fluid_private.naming_brain_prepared_sets where run_id=r.id)
 and not exists(select 1 from public.usage_reservations where job_id=j.id and (actual_microusd<>0 or captured_microusd<>0)));
$$;

create or replace function public.report_naming_brain_worker_ready(p_policy jsonb,p_deployment_id text,p_worker_id text,p_ready_seconds integer default 60) returns boolean
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.naming_brain_worker_owner();
begin
 if o is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_ready_seconds is null or p_ready_seconds not between 5 and 120 or p_worker_id is null or length(p_worker_id) not between 1 and 100 then raise exception 'invalid_readiness' using errcode='22023'; end if;
 if exists(select 1 from fluid_private.naming_worker_leadership where owner_id=o and deployment_id=p_deployment_id) then return false; end if;
 update fluid_private.naming_brain_pilots set ready_until=clock_timestamp()+make_interval(secs=>p_ready_seconds),worker_id=p_worker_id
 where owner_id=o and enabled and policy=p_policy and deployment_id=p_deployment_id
 and (worker_id=p_worker_id or ready_until is null or ready_until<=clock_timestamp());
 return found;
end $$;

create or replace function public.claim_naming_brain_job(p_worker_id text,p_deployment_id text,p_lease_seconds integer default 120) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.naming_worker_scope(p_deployment_id);
begin
 if p_worker_id is null or length(p_worker_id) not between 1 and 100 or p_lease_seconds is null or p_lease_seconds not between 5 and 300 then raise exception 'invalid_lease' using errcode='22023'; end if;
 if exists(select 1 from fluid_private.naming_worker_leadership where owner_id=o and deployment_id=p_deployment_id)
 and not fluid_private.naming_worker_context(o,p_deployment_id,p_worker_id,'claim') then raise exception 'worker_authority_required' using errcode='PT409'; end if;
 if not fluid_private.naming_worker_claim_pending(o,p_deployment_id,p_worker_id) then return null; end if;
 perform fluid_private.lock_strategy_owner(o);
 if exists(select 1 from fluid_private.naming_worker_leadership where owner_id=o and deployment_id=p_deployment_id)
 and not fluid_private.naming_worker_context(o,p_deployment_id,p_worker_id,'claim') then raise exception 'worker_authority_required' using errcode='PT409'; end if;
 return fluid_private.naming_worker_claim_core(p_worker_id,p_deployment_id,p_lease_seconds);
end $$;

create or replace function public.expire_naming_brain_leases(p_worker_id text,p_deployment_id text) returns integer
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.naming_worker_scope(p_deployment_id);
begin
 if p_worker_id is null or length(p_worker_id) not between 1 and 100 then raise exception 'invalid_worker' using errcode='22023'; end if;
 if exists(select 1 from fluid_private.naming_worker_leadership where owner_id=o and deployment_id=p_deployment_id)
 and not fluid_private.naming_worker_context(o,p_deployment_id,p_worker_id,'expire_leases') then raise exception 'worker_authority_required' using errcode='PT409'; end if;
 if not fluid_private.naming_worker_expiry_pending(o,p_deployment_id) then return 0; end if;
 perform fluid_private.lock_strategy_owner(o);
 if exists(select 1 from fluid_private.naming_worker_leadership where owner_id=o and deployment_id=p_deployment_id)
 and not fluid_private.naming_worker_context(o,p_deployment_id,p_worker_id,'expire_leases') then raise exception 'worker_authority_required' using errcode='PT409'; end if;
 return fluid_private.naming_worker_expiry_core(p_worker_id,p_deployment_id);
end $$;

create or replace function public.attest_naming_brain_preferences(p_project_id uuid,p_preferences_version integer,p_preferences_hash text,p_fingerprint jsonb,p_readiness jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.naming_brain_worker_owner();
begin
 if o is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if exists(select 1 from fluid_private.naming_worker_leadership where owner_id=o)
 and not fluid_private.naming_worker_context(o,null,null,'attest_preferences') then raise exception 'worker_authority_required' using errcode='PT409'; end if;
 perform fluid_private.lock_strategy_owner(o);
 if exists(select 1 from fluid_private.naming_worker_leadership where owner_id=o)
 and not fluid_private.naming_worker_context(o,null,null,'attest_preferences') then raise exception 'worker_authority_required' using errcode='PT409'; end if;
 return fluid_private.naming_worker_attest_core(p_project_id,p_preferences_version,p_preferences_hash,p_fingerprint,p_readiness);
end $$;

create function public.naming_brain_worker_maintenance_v2(p_worker_id text,p_deployment_id text,p_generation bigint,p_action text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=fluid_private.naming_worker_scope(p_deployment_id); l fluid_private.naming_worker_leadership; result jsonb; j public.jobs; r fluid_private.naming_brain_runs;
begin
 if p_worker_id is null or length(p_worker_id) not between 1 and 100 or p_generation is null or p_generation not between 1 and 9007199254740991
 or p_action is null or p_action not in('preference_work','attest_preferences','expire_leases','claim','assert_continue')
 or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>8192 then raise exception 'invalid_worker_maintenance' using errcode='22023'; end if;
 select * into l from fluid_private.naming_worker_leadership where owner_id=o and deployment_id=p_deployment_id;
 if l.worker_id is distinct from p_worker_id or l.generation is distinct from p_generation or l.role_name is distinct from session_user
 or not fluid_private.api_text_restricted_role(l.role_name,l.role_oid) or l.expires_at<=clock_timestamp() then raise exception 'leadership_lost' using errcode='PT409'; end if;
 if p_action='preference_work' then
  if p_payload-array['limit']<>'{}'::jsonb then raise exception 'invalid_worker_payload' using errcode='22023'; end if;
  return public.get_naming_brain_preference_work(coalesce((p_payload->>'limit')::integer,20));
 elsif p_action='claim' then
  if p_payload-array['leaseSeconds']<>'{}'::jsonb or coalesce((p_payload->>'leaseSeconds')::integer,120) not between 5 and 300 then raise exception 'invalid_worker_payload' using errcode='22023'; end if;
  if not fluid_private.naming_worker_claim_pending(o,p_deployment_id,p_worker_id) then return null; end if;
 elsif p_action='expire_leases' then
  if p_payload-array['limit']<>'{}'::jsonb or coalesce((p_payload->>'limit')::integer,20)<>20 then raise exception 'invalid_worker_payload' using errcode='22023'; end if;
  if not fluid_private.naming_worker_expiry_pending(o,p_deployment_id) then return '0'::jsonb; end if;
 end if;
 -- Positive-work lock order. A preflight never grants mutation authority.
 perform fluid_private.lock_strategy_owner(o);
 select * into strict l from fluid_private.naming_worker_leadership where owner_id=o and deployment_id=p_deployment_id for update;
 if l.worker_id is distinct from p_worker_id or l.generation is distinct from p_generation or l.role_name is distinct from session_user
 or not fluid_private.api_text_restricted_role(l.role_name,l.role_oid) or l.expires_at<=clock_timestamp()
 or fluid_private.naming_worker_scope(p_deployment_id) is distinct from o then raise exception 'leadership_lost' using errcode='PT409'; end if;
 if p_action='assert_continue' then
  if p_payload-array['jobId','leaseToken']<>'{}'::jsonb then raise exception 'invalid_worker_payload' using errcode='22023'; end if;
  if not exists(select 1 from fluid_private.naming_brain_runs where job_id=(p_payload->>'jobId')::uuid and owner_id=o and deployment_id=p_deployment_id) then
   raise exception 'worker_owner_mismatch' using errcode='42501';
  end if;
  r:=fluid_private.naming_brain_lock((p_payload->>'jobId')::uuid,(p_payload->>'leaseToken')::uuid);
  select * into strict j from public.jobs where id=r.job_id;
  if r.owner_id<>o or r.deployment_id<>p_deployment_id then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
  return to_jsonb(j.state='running' and j.cancel_requested_at is null and not r.superseded and not(r.observed_overrun and not fluid_private.naming_brain_unlimited_job(r.job_id)) and r.recovery_mode='execute'
   and fluid_private.naming_brain_ready(r,p_worker_id)
   and not exists(select 1 from fluid_private.naming_brain_heads where project_id=r.project_id and paused)
   and not exists(select 1 from public.projects where id=r.project_id and (deleted_at is not null or deletion_requested_at is not null)));
 end if;
 insert into fluid_private.naming_worker_gateway_context values(pg_backend_pid(),txid_current(),o,p_deployment_id,l.role_name,l.role_oid,p_worker_id,p_generation,p_action);
 if p_action='claim' then
  result:=public.claim_naming_brain_job(p_worker_id,p_deployment_id,coalesce((p_payload->>'leaseSeconds')::integer,120));
  if result is not null then
   select * into strict j from public.jobs where id=(result#>>'{job,id}')::uuid;
   if j.owner_id<>o or j.worker_id<>p_worker_id or j.lease_token is null then raise exception 'worker_claim_binding_mismatch' using errcode='55000'; end if;
   insert into fluid_private.naming_worker_job_authority values(j.id,j.owner_id,j.project_id,p_deployment_id,p_worker_id,p_generation,j.lease_token)
    on conflict(job_id) do update set owner_id=excluded.owner_id,project_id=excluded.project_id,deployment_id=excluded.deployment_id,worker_id=excluded.worker_id,generation=excluded.generation,lease_token=excluded.lease_token;
  end if;
 elsif p_action='expire_leases' then result:=to_jsonb(public.expire_naming_brain_leases(p_worker_id,p_deployment_id));
 elsif p_action='attest_preferences' then
  if p_payload-array['projectId','preferencesVersion','preferencesHash','fingerprint','readiness']<>'{}'::jsonb then raise exception 'invalid_worker_payload' using errcode='22023'; end if;
  result:=public.attest_naming_brain_preferences((p_payload->>'projectId')::uuid,(p_payload->>'preferencesVersion')::integer,p_payload->>'preferencesHash',p_payload->'fingerprint',p_payload->'readiness');
 end if;
 delete from fluid_private.naming_worker_gateway_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
 return result;
end $$;

-- Strip hostile default ACLs from every new object, not only known API roles.
-- Existing public function OIDs/ACLs remain unchanged by CREATE OR REPLACE.
do $security$
declare item record; grant_row record; target text; login record;
begin
 for item in select c.oid,c.relowner owner,c.relacl acl from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='fluid_private' and c.relname in('naming_worker_leadership','naming_worker_job_authority','naming_worker_gateway_context') loop
  target:=item.oid::regclass::text;
  for grant_row in select distinct a.grantee,r.rolname from aclexplode(coalesce(item.acl,acldefault('r',item.owner))) a left join pg_roles r on r.oid=a.grantee where a.grantee<>item.owner loop
   execute format('revoke all on table %s from %s',target,case when grant_row.grantee=0 then 'PUBLIC' else quote_ident(grant_row.rolname) end);
  end loop;
 end loop;
 for item in select p.oid,p.proowner owner,p.proacl acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='fluid_private' and p.proname like 'naming_worker_%'
 or n.nspname='public' and p.proname in('report_naming_brain_worker_status','naming_brain_worker_maintenance_v2') loop
  target:=item.oid::regprocedure::text;
  for grant_row in select distinct a.grantee,r.rolname from aclexplode(coalesce(item.acl,acldefault('f',item.owner))) a left join pg_roles r on r.oid=a.grantee where a.grantee<>item.owner loop
   execute format('revoke all on function %s from %s',target,case when grant_row.grantee=0 then 'PUBLIC' else quote_ident(grant_row.rolname) end);
  end loop;
 end loop;
 -- New entrypoints mirror only already bound restricted Naming worker logins.
 for login in select r.rolname from pg_roles r join fluid_private.naming_brain_pilots p on p.role_name=r.rolname and p.role_oid=r.oid
 where fluid_private.api_text_restricted_role(r.rolname,r.oid) and has_function_privilege(r.oid,'public.claim_naming_brain_job(text,text,integer)'::regprocedure,'EXECUTE') loop
  execute format('grant execute on function public.report_naming_brain_worker_status(jsonb,text,text,bigint,integer),public.naming_brain_worker_maintenance_v2(text,text,bigint,text,jsonb) to %I',login.rolname);
 end loop;
end $security$;
commit;
