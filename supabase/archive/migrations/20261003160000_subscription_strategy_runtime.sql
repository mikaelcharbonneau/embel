-- ChatGPT subscription execution keeps Supabase ownership and immutable revisions.
-- No OAuth tokens or login credentials are stored here. A separately approved
-- direct database login is administratively bound to exactly one Fluid owner.
alter table public.jobs add column billing_mode text not null default 'openai_api'
  check (billing_mode in ('openai_api','chatgpt_subscription'));
alter table public.jobs add column policy_identity text;
alter table public.jobs add constraint subscription_policy_identity check (
  (billing_mode='openai_api' and policy_identity is null) or
  (billing_mode='chatgpt_subscription' and policy_identity is not null and policy_identity ~ '^[0-9a-f]{64}$'
    and policy_identity is not distinct from encode(sha256(convert_to((input->'policy')::text,'UTF8')),'hex')));
alter table public.jobs add constraint subscription_job_input check (
  billing_mode <> 'chatgpt_subscription' or (
    input->>'billingMode' is not distinct from 'chatgpt_subscription' and reserved_cost_microusd = 0
    and actual_cost_microusd = 0 and max_attempts = 1));
create unique index subscription_job_revision_operation on public.jobs(owner_id,project_id,input_revision,operation)
  where billing_mode = 'chatgpt_subscription';
grant select(billing_mode,policy_identity) on public.jobs to authenticated;

-- Provisioning is deliberately separate: this migration creates no login,
-- password, membership, or owner mapping. Login OIDs prevent a dropped/recreated
-- role with the same name from silently inheriting an old account binding.
create table fluid_private.subscription_worker_principals (
  role_name name primary key,
  role_oid oid not null unique,
  owner_id uuid not null references auth.users(id) on delete cascade
);
alter table fluid_private.subscription_worker_principals enable row level security;
alter table fluid_private.subscription_worker_principals force row level security;
revoke all on fluid_private.subscription_worker_principals from public,anon,authenticated,service_role;

-- session_user is the authenticated database login even inside a definer
-- function. JWT claims, SET ROLE and caller-controlled custom GUCs cannot pick
-- an owner. Privileged or membership-bearing roles fail closed.
create function public.subscription_worker_owner() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.owner_id
  from fluid_private.subscription_worker_principals p
  join pg_catalog.pg_roles r on r.oid=p.role_oid and r.rolname=p.role_name
  where p.role_name=session_user and r.rolcanlogin and not r.rolinherit
    and not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb
    and not r.rolcreaterole and not r.rolreplication
    and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid);
$$;

-- The worker's only direct table access is seven recovery-metadata columns.
-- This predicate performs the mode check without granting jobs-table access.
create function public.subscription_worker_can_read_step(p_job_id uuid,p_owner_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid:=public.subscription_worker_owner();
begin
  if v_owner is null or p_owner_id is distinct from v_owner then return false; end if;
  return exists(select 1 from public.jobs j where j.id=p_job_id and j.owner_id=v_owner and j.billing_mode='chatgpt_subscription');
end $$;
create policy subscription_worker_step_read on public.job_steps for select to public
  using(public.subscription_worker_can_read_step(job_id,owner_id));

create function fluid_private.valid_subscription_policy(p_policy jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_limits jsonb; v_key text; v_value numeric; v_min integer; v_max integer;
begin
  if p_policy is null or jsonb_typeof(p_policy) <> 'object'
    or p_policy - array['version','billingMode','handlerVersion','registrationId','model','limits'] <> '{}'::jsonb
    or p_policy->'version' is distinct from '1'::jsonb
    or p_policy->>'billingMode' is distinct from 'chatgpt_subscription'
    or p_policy->>'handlerVersion' is distinct from 'strategy-chatgpt-v1'
    or jsonb_typeof(p_policy->'registrationId') is distinct from 'string'
    or length(p_policy->>'registrationId') not between 1 and 300
    or jsonb_typeof(p_policy->'model') is distinct from 'string'
    or length(p_policy->>'model') not between 1 and 150 then return false; end if;
  v_limits := p_policy->'limits';
  if jsonb_typeof(v_limits) is distinct from 'object'
    or v_limits - array['maxInputBytes','maxOutputBytes','deadlineMs','maxObservedWebSearchCalls','maxRequestsPerHour','maxQueuedJobs'] <> '{}'::jsonb then return false; end if;
  foreach v_key in array array['maxInputBytes','maxOutputBytes','deadlineMs','maxObservedWebSearchCalls','maxRequestsPerHour','maxQueuedJobs'] loop
    if jsonb_typeof(v_limits->v_key) is distinct from 'number' then return false; end if;
    v_value := (v_limits->>v_key)::numeric;
    v_min := case v_key when 'maxInputBytes' then 1024 when 'maxOutputBytes' then 1024 when 'deadlineMs' then 1000 when 'maxObservedWebSearchCalls' then 0 else 1 end;
    v_max := case v_key when 'maxInputBytes' then 1048576 when 'maxOutputBytes' then 1048576 when 'deadlineMs' then 300000 when 'maxObservedWebSearchCalls' then 10 when 'maxRequestsPerHour' then 100 else 10 end;
    if trunc(v_value) <> v_value or v_value not between v_min and v_max then return false; end if;
  end loop;
  return true;
end $$;

create table fluid_private.subscription_registrations (
  registration_id text primary key check(length(registration_id) between 1 and 300),
  owner_id uuid not null references auth.users(id) on delete cascade,
  unique(registration_id,owner_id)
);
create table fluid_private.subscription_runtime_policy (
  owner_id uuid not null references auth.users(id) on delete cascade,
  operation text not null check(operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')),
  registration_id text not null,
  enabled boolean not null default false,
  policy jsonb not null check(fluid_private.valid_subscription_policy(policy)),
  worker_ready_until timestamptz,
  primary key(owner_id,operation),
  foreign key(registration_id,owner_id) references fluid_private.subscription_registrations(registration_id,owner_id),
  check(policy->>'registrationId' = registration_id)
);
revoke all on fluid_private.subscription_registrations, fluid_private.subscription_runtime_policy from public,anon,authenticated,service_role;

create function public.configure_subscription_runtime(p_owner_id uuid,p_operation text,p_policy jsonb,p_enabled boolean default true)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=public.subscription_worker_owner();
begin
  if v_owner is null or p_owner_id is distinct from v_owner then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
  if p_owner_id is null or p_enabled is null or not fluid_private.valid_subscription_policy(p_policy) then
    raise exception 'invalid_policy' using errcode='22023';
  end if;
  insert into fluid_private.subscription_registrations(registration_id,owner_id) values(p_policy->>'registrationId',p_owner_id)
    on conflict(registration_id) do nothing;
  if not exists(select 1 from fluid_private.subscription_registrations where registration_id=p_policy->>'registrationId' and owner_id=p_owner_id) then
    raise exception 'registration_owner_conflict' using errcode='23505';
  end if;
  insert into fluid_private.subscription_runtime_policy(owner_id,operation,registration_id,enabled,policy)
    values(p_owner_id,p_operation,p_policy->>'registrationId',p_enabled,p_policy)
    on conflict(owner_id,operation) do update set registration_id=excluded.registration_id,enabled=excluded.enabled,policy=excluded.policy,
      worker_ready_until=case when subscription_runtime_policy.policy=excluded.policy and subscription_runtime_policy.enabled=excluded.enabled
        then subscription_runtime_policy.worker_ready_until else null end;
  -- A policy change never rewrites job input or automatically dispatches again.
  -- Stop superseded jobs so they cannot occupy the bounded queue indefinitely.
  update public.jobs set state=case when state='queued' then 'cancelled' else 'cancel_requested' end,
    cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),error_code='subscription_policy_changed',
    finished_at=case when state='queued' then clock_timestamp() else finished_at end
    where owner_id=p_owner_id and operation=p_operation and billing_mode='chatgpt_subscription'
      and state in ('queued','running') and (input->'policy' is distinct from p_policy or not p_enabled);
  return true;
end $$;

create function public.get_subscription_runtime_bindings()
returns table(owner_id uuid,registration_id text,operation text,policy jsonb,enabled boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid:=public.subscription_worker_owner();
begin
  if v_owner is null then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
  return query select p.owner_id,p.registration_id,p.operation,p.policy,p.enabled
    from fluid_private.subscription_runtime_policy p where p.owner_id=v_owner and p.enabled order by p.operation;
end $$;

create function public.report_subscription_worker_ready(p_owner_id uuid,p_registration_id text,p_operation text,p_policy jsonb,p_ready_seconds integer default 60)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=public.subscription_worker_owner();
begin
  if v_owner is null or p_owner_id is distinct from v_owner then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
  if p_ready_seconds is null or p_ready_seconds not between 1 and 90 then raise exception 'invalid_readiness_window' using errcode='22023'; end if;
  update fluid_private.subscription_runtime_policy set worker_ready_until=clock_timestamp()+make_interval(secs=>p_ready_seconds)
    where owner_id=p_owner_id and registration_id=p_registration_id and operation=p_operation and enabled and policy=p_policy;
  return found;
end $$;

create function public.disable_subscription_runtime(p_owner_id uuid,p_registration_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=public.subscription_worker_owner();
begin
  if v_owner is null or p_owner_id is distinct from v_owner then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
  update fluid_private.subscription_runtime_policy set enabled=false,worker_ready_until=null where owner_id=p_owner_id and registration_id=p_registration_id;
  update public.jobs set state=case when state='queued' then 'cancelled' else 'cancel_requested' end,
    cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),
    finished_at=case when state='queued' then clock_timestamp() else finished_at end
    where owner_id=p_owner_id and billing_mode='chatgpt_subscription' and input->'policy'->>'registrationId'=p_registration_id and state in ('queued','running');
  return exists(select 1 from fluid_private.subscription_registrations where owner_id=p_owner_id and registration_id=p_registration_id);
end $$;

-- Preserve the old API-only availability behavior for accounts never configured
-- for subscriptions. Once chosen, a subscription outage never falls back to API.
alter function public.get_strategy_availability(uuid) rename to get_api_strategy_availability;
revoke all on function public.get_api_strategy_availability(uuid) from public,anon,authenticated,service_role;
create function public.get_strategy_availability(p_project_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_operations jsonb; v_hourly bigint; v_pending bigint;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
  if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
  if not exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=v_owner) then return public.get_api_strategy_availability(p_project_id); end if;
  if not exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=v_owner and enabled) then
    return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','subscription_unavailable');
  end if;
  if not exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=v_owner and enabled and worker_ready_until>clock_timestamp()) then
    return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','worker_unavailable');
  end if;
  select count(*) filter(where created_at>clock_timestamp()-interval '1 hour'),count(*) filter(where state in ('queued','running','cancel_requested'))
    into v_hourly,v_pending from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription';
  select coalesce(jsonb_agg(jsonb_build_object('operation',operation,'billingMode','chatgpt_subscription','policyIdentity',encode(sha256(convert_to(policy::text,'UTF8')),'hex'),'limits',policy->'limits') order by operation),'[]'::jsonb)
    into v_operations from fluid_private.subscription_runtime_policy where owner_id=v_owner and enabled and worker_ready_until>clock_timestamp()
      and v_hourly<(policy->'limits'->>'maxRequestsPerHour')::integer and v_pending<(policy->'limits'->>'maxQueuedJobs')::integer;
  if jsonb_array_length(v_operations)=0 then return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','quota_unavailable'); end if;
  return jsonb_build_object('status','available','operations',v_operations);
end $$;

create or replace function fluid_private.strategy_job_summary(p_job public.jobs)
returns jsonb language sql stable set search_path = '' as $$
 select jsonb_build_object('id',p_job.id,'owner_id',p_job.owner_id,'project_id',p_job.project_id,'operation',p_job.operation,
   'input_revision',p_job.input_revision,'state',p_job.state,'progress',p_job.progress,'cancel_requested_at',p_job.cancel_requested_at,
   'error_code',p_job.error_code,'created_at',p_job.created_at,'finished_at',p_job.finished_at)
   || case when p_job.billing_mode='chatgpt_subscription' then jsonb_build_object('billingMode','chatgpt_subscription','policyIdentity',p_job.policy_identity)
     else jsonb_build_object('reserved_cost_microusd',p_job.reserved_cost_microusd,'actual_cost_microusd',p_job.actual_cost_microusd) end;
$$;

create function public.enqueue_subscription_strategy_job(p_project_id uuid,p_expected_revision integer,p_operation text,p_idempotency_key text,p_accepted_policy_identity text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_project public.projects; v_revision public.project_revisions; v_policy fluid_private.subscription_runtime_policy; v_job public.jobs; v_input jsonb;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_expected_revision is null or p_expected_revision<1 or p_operation is null or p_operation not in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')
   or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
   or p_accepted_policy_identity is null or p_accepted_policy_identity !~ '^[0-9a-f]{64}$' then raise exception 'invalid_input' using errcode='22023'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 -- Serialize all operations/registrations for this owner, without a USD account.
 perform pg_advisory_xact_lock(hashtextextended(v_owner::text,723902));
 select * into v_job from public.jobs where owner_id=v_owner and idempotency_key=p_idempotency_key;
 if found then
   if (v_job.project_id,v_job.operation,v_job.input_revision,v_job.billing_mode) is distinct from (p_project_id,p_operation,p_expected_revision,'chatgpt_subscription') then raise exception 'idempotency_conflict' using errcode='23505'; end if;
   if v_job.policy_identity<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='40001'; end if;
   return fluid_private.strategy_job_summary(v_job);
 end if;
 select * into v_job from public.jobs where owner_id=v_owner and project_id=p_project_id and input_revision=p_expected_revision and operation=p_operation and billing_mode='chatgpt_subscription';
 if found then
   if v_job.policy_identity<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='40001'; end if;
   return fluid_private.strategy_job_summary(v_job);
 end if;
 select * into v_project from public.projects where id=p_project_id and owner_id=v_owner for share;
 if v_project.current_revision<>p_expected_revision then raise exception 'revision_conflict' using errcode='40001'; end if;
 select * into v_policy from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation=p_operation and enabled for share;
 if not found or v_policy.worker_ready_until is null or v_policy.worker_ready_until<=clock_timestamp() then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
 if encode(sha256(convert_to(v_policy.policy::text,'UTF8')),'hex')<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='40001'; end if;
 if (select count(*) from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and created_at>clock_timestamp()-interval '1 hour') >= (v_policy.policy->'limits'->>'maxRequestsPerHour')::integer
   or (select count(*) from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and state in ('queued','running','cancel_requested')) >= (v_policy.policy->'limits'->>'maxQueuedJobs')::integer then raise exception 'quota_unavailable' using errcode='P0001'; end if;
 select * into strict v_revision from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=p_expected_revision;
 v_input:=jsonb_build_object('version',1,'billingMode','chatgpt_subscription','context',v_revision.context,'policy',v_policy.policy);
 if octet_length(v_input::text)>(v_policy.policy->'limits'->>'maxInputBytes')::integer then raise exception 'input_too_large' using errcode='22023'; end if;
 insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,billing_mode,policy_identity)
   values(v_owner,p_project_id,p_operation,p_expected_revision,v_revision.input_hash,v_input,p_idempotency_key,0,1,'chatgpt_subscription',p_accepted_policy_identity) returning * into v_job;
 return fluid_private.strategy_job_summary(v_job);
end $$;

create function public.claim_subscription_job(p_worker_id text,p_owner_id uuid,p_registration_id text,p_lease_seconds integer default 60)
returns setof public.jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_owner uuid:=public.subscription_worker_owner();
begin
 if v_owner is null or p_owner_id is distinct from v_owner then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_worker_id is null or length(p_worker_id) not between 1 and 100 or p_lease_seconds is null or p_lease_seconds not between 5 and 300 then raise exception 'invalid_lease' using errcode='22023'; end if;
 select j.* into v_job from public.jobs j join fluid_private.subscription_runtime_policy p on p.owner_id=j.owner_id and p.operation=j.operation
   where j.billing_mode='chatgpt_subscription' and j.state='queued' and j.attempts<j.max_attempts and j.owner_id=p_owner_id
     and p.registration_id=p_registration_id and p.enabled and p.worker_ready_until>clock_timestamp() and p.policy=j.input->'policy'
   order by j.created_at,j.id for update of j skip locked limit 1;
 if not found then return; end if;
 return query update public.jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
   worker_id=p_worker_id,attempts=attempts+1 where id=v_job.id returning *;
end $$;

create table public.subscription_job_partials (
 job_id uuid primary key,owner_id uuid not null,project_id uuid not null,
 partial_text text not null check(octet_length(partial_text)<=1048576),updated_at timestamptz not null default now(),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
create index subscription_partials_owner_project on public.subscription_job_partials(owner_id,project_id);
alter table public.subscription_job_partials enable row level security;
alter table public.subscription_job_partials force row level security;
create policy subscription_partial_owner on public.subscription_job_partials for select to authenticated using ((select auth.uid())=owner_id);
revoke all on public.subscription_job_partials from public,anon,authenticated,service_role;
grant select on public.subscription_job_partials to authenticated;
create function public.append_subscription_partial(p_job_id uuid,p_lease_token uuid,p_text text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_old text;
begin
 v_job:=fluid_private.lock_leased_job(p_job_id,p_lease_token);
 if v_job.billing_mode<>'chatgpt_subscription' or v_job.state<>'running' then raise exception 'invalid_partial_state' using errcode='55000'; end if;
 if p_text is null or octet_length(p_text)>(v_job.input->'policy'->'limits'->>'maxOutputBytes')::integer then raise exception 'invalid_partial_size' using errcode='22023'; end if;
 select partial_text into v_old from public.subscription_job_partials where job_id=p_job_id;
 if v_old is not null and left(p_text,length(v_old))<>v_old then raise exception 'partial_conflict' using errcode='40001'; end if;
 insert into public.subscription_job_partials(job_id,owner_id,project_id,partial_text) values(v_job.id,v_job.owner_id,v_job.project_id,p_text)
   on conflict(job_id) do update set partial_text=excluded.partial_text,updated_at=clock_timestamp();
 return true;
end $$;

-- All shared lease mutations (heartbeat, progress, plan, begin, complete,
-- finish and partials) pass this boundary. A correct foreign lease token never
-- authorizes another owner; subscription logins cannot operate paid API jobs.
create or replace function fluid_private.lock_leased_job(p_job_id uuid,p_lease_token uuid)
returns public.jobs language plpgsql set search_path = '' as $$
declare v_job public.jobs; v_owner uuid:=public.subscription_worker_owner();
  v_api_worker boolean:=(session_user='service_role' or pg_catalog.current_setting('role',true)='service_role');
begin
  select * into v_job from public.jobs where id=p_job_id;
  if not found then raise exception 'lease_lost' using errcode='40001'; end if;
  if (v_job.billing_mode='chatgpt_subscription' and (v_owner is null or v_job.owner_id is distinct from v_owner))
    or (v_job.billing_mode='openai_api' and (v_owner is not null or not v_api_worker)) then
    raise exception 'worker_owner_mismatch' using errcode='42501';
  end if;
  -- Check identity before acquiring the row lock, then retain both predicates
  -- while locking so even an administrative concurrent edit cannot cross modes.
  select j.* into v_job from public.jobs j where j.id=p_job_id and
    ((j.billing_mode='chatgpt_subscription' and j.owner_id=v_owner)
      or (j.billing_mode='openai_api' and v_owner is null and v_api_worker)) for update;
  if not found or p_lease_token is null or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at is null or v_job.lease_expires_at<=clock_timestamp() or v_job.state not in ('running','cancel_requested') then
    raise exception 'lease_lost' using errcode='40001';
  end if;
  return v_job;
end $$;

create or replace function public.expire_job_leases() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_next text; v_count integer:=0; v_owner uuid:=public.subscription_worker_owner();
  v_api_worker boolean:=(session_user='service_role' or pg_catalog.current_setting('role',true)='service_role');
begin
  if v_owner is null and not v_api_worker then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
  for v_job in select * from public.jobs where lease_expires_at<=clock_timestamp() and state in ('running','cancel_requested')
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

-- Existing paid API behavior is unchanged; subscriptions skip monetary accounts.
create or replace function fluid_private.settle_reservation(p_job_id uuid) returns void language plpgsql set search_path = '' as $$
declare v_reservation public.usage_reservations;
begin
  if exists(select 1 from public.jobs where id=p_job_id and billing_mode='chatgpt_subscription') then return; end if;
  select * into strict v_reservation from public.usage_reservations where job_id = p_job_id for update;
  if v_reservation.state = 'settled' then return; end if;
  update public.usage_accounts set reserved_microusd = reserved_microusd - greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd, 0)
    where owner_id = v_reservation.owner_id;
  update public.usage_reservations set state = 'settled' where job_id = p_job_id;
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
    where j.billing_mode = 'openai_api' and j.state = 'queued' and j.attempts < j.max_attempts
      and a.reserved_microusd <= a.limit_microusd - greatest(a.spent_microusd, a.provider_actual_microusd)
    order by j.created_at, j.id for update of j skip locked limit 1;
  if not found then return; end if;
  return query update public.jobs set state = 'running', lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
    worker_id = p_worker_id, attempts = attempts + 1 where id = v_job.id returning *;
end $$;

create or replace function public.begin_job_step(p_job_id uuid, p_lease_token uuid, p_step_key text, p_request_key text, p_max_cost_microusd bigint)
returns public.job_steps language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_step public.job_steps; v_pending bigint; v_account public.usage_accounts;
begin
  v_job := fluid_private.lock_leased_job(p_job_id, p_lease_token);
  if v_job.state <> 'running' then raise exception 'cancel_requested' using errcode = '55000'; end if;
  if v_job.billing_mode = 'openai_api' then
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

create or replace function public.complete_job_step(p_job_id uuid, p_lease_token uuid, p_step_key text, p_state text,
  p_actual_cost_microusd bigint, p_output jsonb default null, p_provider_request_id text default null)
returns public.job_steps language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_step public.job_steps; v_reservation public.usage_reservations;
begin
  v_job := fluid_private.lock_leased_job(p_job_id, p_lease_token);
  select * into v_step from public.job_steps where job_id = p_job_id and step_key = p_step_key for update;
  if not found then raise exception 'step_not_found' using errcode = 'P0002'; end if;
  if p_state is null or p_state not in ('succeeded','failed','ambiguous') or p_actual_cost_microusd is null or p_actual_cost_microusd not between 0 and 9007199254740991 then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;
  if v_step.state <> 'in_flight' then
    if (v_step.state, v_step.actual_cost_microusd, v_step.output, v_step.provider_request_id)
      is not distinct from (p_state, p_actual_cost_microusd, p_output, p_provider_request_id) then return v_step; end if;
    raise exception 'immutable_result' using errcode = '55000';
  end if;
  if v_job.billing_mode = 'openai_api' then
  select * into strict v_reservation from public.usage_reservations where job_id = p_job_id for update;
  update public.usage_accounts set
    spent_microusd = spent_microusd + least(greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd,0), p_actual_cost_microusd),
    provider_actual_microusd = provider_actual_microusd + p_actual_cost_microusd,
    reserved_microusd = reserved_microusd - least(greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd,0), p_actual_cost_microusd)
    where owner_id = v_job.owner_id;
  update public.usage_reservations set actual_microusd = actual_microusd + p_actual_cost_microusd,
    captured_microusd = captured_microusd + least(greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd,0), p_actual_cost_microusd) where job_id = p_job_id;
  else
    if p_actual_cost_microusd <> 0 then raise exception 'invalid_subscription_cost' using errcode='22023'; end if;
    if p_state='succeeded' and (v_job.state<>'running' or not exists(select 1 from fluid_private.subscription_runtime_policy p where p.owner_id=v_job.owner_id and p.operation=v_job.operation and p.enabled and p.policy=v_job.input->'policy')) then raise exception 'subscription_changed' using errcode='55000'; end if;
    if p_state='succeeded' and (p_output->>'billingMode' is distinct from 'chatgpt_subscription' or p_output->>'provider' is distinct from 'openai' or p_output->>'operation' is distinct from v_job.operation or p_output->>'model' is distinct from v_job.input->'policy'->>'model') then raise exception 'invalid_subscription_result' using errcode='22023'; end if;
  end if;
  update public.job_steps set state = p_state, actual_cost_microusd = p_actual_cost_microusd, output = p_output,
    provider_request_id = p_provider_request_id, completed_at = clock_timestamp() where id = v_step.id returning * into v_step;
  update public.jobs set actual_cost_microusd = actual_cost_microusd + p_actual_cost_microusd where id = p_job_id;
  -- Retain real billing evidence even on an unexpected overrun; stop all further execution.
  if p_state = 'ambiguous' or p_actual_cost_microusd > v_step.reserved_cost_microusd then
    update public.jobs set state = 'needs_reconciliation', lease_token = null, lease_expires_at = null,
      error_code = case when p_state = 'ambiguous' then 'provider_outcome_unknown' else 'cost_overrun' end where id = p_job_id;
  end if;
  return v_step;
end $$;

revoke all on function fluid_private.valid_subscription_policy(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.configure_subscription_runtime(uuid,text,jsonb,boolean),public.get_subscription_runtime_bindings(),
 public.report_subscription_worker_ready(uuid,text,text,jsonb,integer),public.disable_subscription_runtime(uuid,text),
 public.claim_subscription_job(text,uuid,text,integer),public.append_subscription_partial(uuid,uuid,text),
 public.enqueue_subscription_strategy_job(uuid,integer,text,text,text),public.get_strategy_availability(uuid) from public,anon,authenticated,service_role;
-- These no-secret helpers fail closed for unbound callers and expose no other
-- owner's identity or job metadata. PUBLIC execution lets existing Auth RLS
-- policies coexist without granting worker capabilities to browser roles.
revoke all on function public.subscription_worker_owner(),public.subscription_worker_can_read_step(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.subscription_worker_owner(),public.subscription_worker_can_read_step(uuid,uuid) to public;
-- Worker RPC EXECUTE and seven-column SELECT grants are made individually only
-- after the separate role/owner/credential approval. service_role is excluded.
grant execute on function public.enqueue_subscription_strategy_job(uuid,integer,text,text,text),public.get_strategy_availability(uuid) to authenticated;

-- Explicit API requests cannot bypass an account's selected subscription route.
create or replace function public.enqueue_strategy_job(p_project_id uuid, p_expected_revision integer, p_operation text,
  p_idempotency_key text, p_accepted_max_cost_microusd bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_project public.projects; v_revision public.project_revisions;
  v_policy fluid_private.strategy_runtime_policy; v_job public.jobs; v_account public.usage_accounts; v_maximum bigint;
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
  -- Match enqueue_job's lock order; serialize owner idempotency and budget reservation.
  select * into v_account from public.usage_accounts where owner_id = v_owner for update;
  if not found then raise exception 'budget_unavailable' using errcode = 'P0001'; end if;
  select * into v_job from public.jobs where owner_id = v_owner and idempotency_key = p_idempotency_key;
  if found then
    if (v_job.project_id, v_job.operation, v_job.input_revision, (v_job.input->>'acceptedMaxCostMicrousd')::bigint)
      is distinct from (p_project_id, p_operation, p_expected_revision, p_accepted_max_cost_microusd) then
      raise exception 'idempotency_conflict' using errcode = '23505';
    end if;
    -- Replaying the same request is stable even after edits, policy changes or outage.
    return fluid_private.strategy_job_summary(v_job);
  end if;
  if exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=v_owner) then
    raise exception 'billing_mode_conflict' using errcode='40001';
  end if;
  select * into v_project from public.projects where id = p_project_id and owner_id = v_owner for share;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_project.current_revision <> p_expected_revision then raise exception 'revision_conflict' using errcode = '40001'; end if;
  select * into v_policy from fluid_private.strategy_runtime_policy where operation = p_operation and enabled for share;
  if not found or v_policy.worker_ready_until is null or v_policy.worker_ready_until <= clock_timestamp() then
    raise exception 'runtime_unavailable' using errcode = 'P0001';
  end if;
  v_maximum := (v_policy.policy->>'maximumCostMicrousd')::bigint;
  if p_accepted_max_cost_microusd < v_maximum then raise exception 'accepted_cap_exceeded' using errcode = '22023'; end if;
  select * into strict v_revision from public.project_revisions
    where project_id = p_project_id and owner_id = v_owner and revision = p_expected_revision;
  select * into v_job from public.enqueue_job(v_owner, p_project_id, p_operation, p_expected_revision, v_revision.input_hash,
    jsonb_build_object('version',1,'context',v_revision.context,'policy',v_policy.policy,'acceptedMaxCostMicrousd',p_accepted_max_cost_microusd),
    p_idempotency_key, v_maximum, 1);
  return fluid_private.strategy_job_summary(v_job);
end $$;
