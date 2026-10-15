-- Forward review candidate. Disabled by default. No role, credential, worker
-- EXECUTE grant, funded allowance, enabled cohort, deployment or inference.
begin;

create table fluid_private.api_text_allowance_cohorts (
 id text primary key check(id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
 enabled boolean not null default false,
 role_name name not null, role_oid oid not null,
 deployment_id text not null check(deployment_id ~ '^dpl_[A-Za-z0-9_-]{1,196}$'),
 operations text[] not null check(cardinality(operations) between 1 and 4
   and operations <@ array['strategy.reformulate','strategy.audience','strategy.personality','strategy.positioning']),
 signup_after timestamptz not null, signup_before timestamptz not null,
 expires_at timestamptz not null,
 owner_attempt_limit integer not null check(owner_attempt_limit between 1 and 1000),
 owner_cost_limit bigint not null check(owner_cost_limit between 1 and 5000000),
 owner_active_limit integer not null check(owner_active_limit between 1 and 3),
 account_limit integer not null check(account_limit between 1 and 100000),
 attempt_limit bigint not null check(attempt_limit between 1 and 1000000),
 cost_limit bigint not null check(cost_limit between 1 and 500000000000),
 accounts_used integer not null default 0 check(accounts_used>=0),
 attempts_used bigint not null default 0 check(attempts_used>=0),
 cost_committed bigint not null default 0 check(cost_committed>=0),
 check(signup_before>signup_after and expires_at>signup_after),
 check(accounts_used<=account_limit and attempts_used<=attempt_limit and cost_committed<=cost_limit)
);
create table fluid_private.api_text_allowance_rollout (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 signup_cohort text references fluid_private.api_text_allowance_cohorts(id),
 account_limit integer not null default 0 check(account_limit between 0 and 100000),
 attempt_limit bigint not null default 0 check(attempt_limit between 0 and 1000000),
 cost_limit bigint not null default 0 check(cost_limit between 0 and 500000000000),
 accounts_used integer not null default 0 check(accounts_used>=0),
 attempts_used bigint not null default 0 check(attempts_used>=0),
 cost_committed bigint not null default 0 check(cost_committed>=0),
 check(accounts_used<=account_limit and attempts_used<=attempt_limit and cost_committed<=cost_limit)
);
insert into fluid_private.api_text_allowance_rollout(singleton) values(true);
create table fluid_private.api_text_owner_entitlements (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 cohort_id text not null references fluid_private.api_text_allowance_cohorts(id),
 enabled boolean not null default true,
 attempt_limit integer not null check(attempt_limit between 1 and 1000),
 cost_limit bigint not null check(cost_limit between 1 and 5000000),
 active_limit integer not null check(active_limit between 1 and 3),
 attempts_used bigint not null default 0 check(attempts_used>=0),
 cost_committed bigint not null default 0 check(cost_committed>=0),
 expires_at timestamptz not null,
 created_at timestamptz not null default clock_timestamp(),
 check(attempts_used<=attempt_limit and cost_committed<=cost_limit)
);
create table fluid_private.api_text_allowance_admissions (
 job_id uuid primary key references public.jobs(id),
 owner_id uuid not null references auth.users(id),
 cohort_id text not null references fluid_private.api_text_allowance_cohorts(id),
 role_name name not null, role_oid oid not null,
 maximum_cost_microusd bigint not null check(maximum_cost_microusd=122880),
 created_at timestamptz not null default clock_timestamp()
);
-- A trusted gateway creates this row only during one fixed-action invocation.
-- No caller has table privileges. Return deletes it; errors roll back insertion.
create table fluid_private.api_text_gateway_context (
 backend_pid integer not null, transaction_id bigint not null,
 role_name name not null, role_oid oid not null,
 owner_id uuid not null, job_id uuid not null,
 primary key(backend_pid,transaction_id)
);
do $acl$
declare t regclass; grantee text;
begin
 foreach t in array array['fluid_private.api_text_allowance_cohorts'::regclass,
  'fluid_private.api_text_allowance_rollout'::regclass,'fluid_private.api_text_owner_entitlements'::regclass,
  'fluid_private.api_text_allowance_admissions'::regclass,'fluid_private.api_text_gateway_context'::regclass] loop
  execute format('alter table %s enable row level security',t);
  execute format('alter table %s force row level security',t);
  execute format('revoke all on table %s from public,anon,authenticated,service_role',t);
  for grantee in select r.rolname from pg_catalog.pg_class c,
   lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   join pg_catalog.pg_roles r on r.oid=a.grantee where c.oid=t and a.grantee<>c.relowner loop
   execute format('revoke all on table %s from %I cascade',t,grantee);
  end loop;
 end loop;
end $acl$;

-- Preserve the existing implementation and its public ACLs. Only the fixed
-- wrappers below change; subscription functions are not rewritten.
do $copy$
declare signature text; source_name text; target_name text; definition text; expected_hash text; expected_definer boolean; expected_volatility "char";
begin
 for signature,source_name,target_name,expected_hash,expected_definer,expected_volatility in values
  ('public.api_text_worker_owner()','public.api_text_worker_owner','fluid_private.api_text_worker_legacy_owner','5052d9233e6d1178ac7c84d211e87dbabeb1561782729748af670efada49e29b',true,'s'),
  ('fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)','fluid_private.api_text_policy_allowed','fluid_private.api_text_legacy_policy_allowed','a3660e937c99d43f0ff72c6efffdd7f9037019129d66c83f2e5885860b9cf0a7',false,'s'),
  ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)','public.enqueue_strategy_job','fluid_private.enqueue_strategy_job_legacy','107078414970e63cf1d93db4bd81965e2e8f5d42bb15168e0e79bcb1a775e92c',true,'v'),
  ('public.get_api_strategy_availability(uuid)','public.get_api_strategy_availability','fluid_private.get_api_strategy_availability_legacy','b525fd07c0b3558d301103c75815e37841006e10d0fd782ccb7f743ee130a5f9',true,'v') loop
  if not exists(select 1 from pg_catalog.pg_proc p where p.oid=signature::regprocedure
    and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=expected_hash
    and p.prosecdef=expected_definer and p.provolatile=expected_volatility
    and p.proconfig=array['search_path=""'] and not p.proleakproof
    and p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user)) then
   raise exception 'unexpected_api_runtime_definition';
  end if;
  definition:=pg_get_functiondef(signature::regprocedure);
  if position('CREATE OR REPLACE FUNCTION '||source_name||'(' in definition)<>1 then raise exception 'unexpected_api_runtime_definition'; end if;
  execute replace(definition,'CREATE OR REPLACE FUNCTION '||source_name||'(','CREATE FUNCTION '||target_name||'(');
 end loop;
end $copy$;

create function fluid_private.api_text_restricted_role(p_name name,p_oid oid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from pg_catalog.pg_roles r where r.rolname=p_name and r.oid=p_oid
 and r.rolcanlogin and not r.rolinherit and not r.rolsuper and not r.rolbypassrls
 and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
 and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid)
 and not exists(select 1 from pg_catalog.pg_shdepend d where d.refclassid='pg_catalog.pg_authid'::regclass and d.refobjid=r.oid and d.deptype='o'));
$$;
create function fluid_private.api_text_allowance_paused() returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.api_text_allowance_admissions a join public.jobs j on j.id=a.job_id
  where j.state='needs_reconciliation' or j.actual_cost_microusd>a.maximum_cost_microusd
   or exists(select 1 from public.job_steps s where s.job_id=j.id and s.state='ambiguous'));
$$;
create function fluid_private.api_text_bounded_policy(p jsonb) returns boolean
language sql immutable set search_path='' as $$
 select p='{"version":1,"pricingVersion":"2026-10-03","handlerVersion":"strategy-openai-v1","model":"gpt-6.1-sol","maxInputTokens":32768,"maxOutputTokens":4096,"maxWebSearchCalls":0,"inputMicrousdPerMillionTokens":2000000,"cachedInputMicrousdPerMillionTokens":100000,"cacheWriteMicrousdPerMillionTokens":2500000,"outputMicrousdPerMillionTokens":10000000,"webSearchMicrousdPerCall":10000,"maximumCostMicrousd":122880}'::jsonb;
$$;

create or replace function public.api_text_worker_owner() returns uuid
language sql stable security definer set search_path='' as $$
 select coalesce((select c.owner_id from fluid_private.api_text_gateway_context c
  where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current()
   and c.role_name=session_user and fluid_private.api_text_restricted_role(c.role_name,c.role_oid)),
  fluid_private.api_text_worker_legacy_owner());
$$;

create or replace function fluid_private.api_text_policy_allowed(p_owner uuid,p_operation text,p_policy jsonb,p_deployment text,p_role oid default null)
returns boolean language sql stable set search_path='' as $$
 select (not exists(select 1 from fluid_private.api_text_owner_entitlements where owner_id=p_owner)
  and fluid_private.api_text_legacy_policy_allowed(p_owner,p_operation,p_policy,p_deployment,p_role))
 or coalesce(not fluid_private.api_text_allowance_paused() and fluid_private.api_text_bounded_policy(p_policy) and exists(
  select 1 from fluid_private.api_text_owner_entitlements e
  join fluid_private.api_text_allowance_cohorts c on c.id=e.cohort_id
  join fluid_private.api_text_allowance_rollout r on r.singleton
  join fluid_private.api_strategy_bindings b on b.owner_id=e.owner_id and b.operation=p_operation
  join fluid_private.strategy_runtime_policy p on p.operation=p_operation
  join fluid_private.strategy_billing_routes route on route.owner_id=e.owner_id
  where e.owner_id=p_owner and e.enabled and c.enabled and r.enabled
   and e.expires_at>clock_timestamp() and c.expires_at>clock_timestamp()
   and p_operation=any(c.operations) and p.enabled and p.policy=p_policy and b.enabled
   and b.role_oid=c.role_oid and (p_role is null or p_role=c.role_oid)
   and fluid_private.api_text_restricted_role(c.role_name,c.role_oid)
   and b.deployment_id=p_deployment and c.deployment_id=p_deployment
   and b.policy_identity=encode(sha256(convert_to(p_policy::text,'UTF8')),'hex')
   and route.billing_mode='openai_api'),false);
$$;

-- Returns only potential admission, never creates an entitlement or funds it.
create function fluid_private.api_text_allowance_available(p_owner uuid,p_operation text) returns text
language plpgsql stable set search_path='' as $$
declare r fluid_private.api_text_allowance_rollout; c fluid_private.api_text_allowance_cohorts;
 e fluid_private.api_text_owner_entitlements; a public.usage_accounts; v_new boolean; v_active bigint;
begin
 select * into r from fluid_private.api_text_allowance_rollout where singleton;
 if not r.enabled or fluid_private.api_text_allowance_paused() then return null; end if;
 select * into e from fluid_private.api_text_owner_entitlements where owner_id=p_owner;
 v_new:=not found;
 select * into c from fluid_private.api_text_allowance_cohorts where id=case when v_new then r.signup_cohort else e.cohort_id end;
 if not found or not c.enabled or c.expires_at<=clock_timestamp() or p_operation<>all(c.operations)
  or not fluid_private.api_text_restricted_role(c.role_name,c.role_oid)
  or not exists(select 1 from fluid_private.strategy_runtime_policy p where p.operation=p_operation and p.enabled and fluid_private.api_text_bounded_policy(p.policy))
  or fluid_private.api_text_paid_paused(p_owner) then return null; end if;
 if not exists(select 1 from auth.users u where u.id=p_owner and to_jsonb(u)->>'email_confirmed_at' is not null
  and (not v_new or (to_jsonb(u)->>'created_at')::timestamptz between c.signup_after and c.signup_before)) then return null; end if;
 if exists(select 1 from fluid_private.strategy_billing_routes where owner_id=p_owner and billing_mode<>'openai_api')
  or (not exists(select 1 from fluid_private.strategy_billing_routes where owner_id=p_owner)
    and exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=p_owner and operation<>'naming.generate')) then return null; end if;
 if r.attempts_used>=r.attempt_limit or r.cost_committed>r.cost_limit-122880
  or c.attempts_used>=c.attempt_limit or c.cost_committed>c.cost_limit-122880 then return null; end if;
 select * into a from public.usage_accounts where owner_id=p_owner;
 if v_new then
  if r.accounts_used>=r.account_limit or c.accounts_used>=c.account_limit or c.owner_cost_limit<122880
   or exists(select 1 from fluid_private.api_strategy_bindings where owner_id=p_owner)
   or (a.owner_id is not null and (a.limit_microusd<>0 or a.spent_microusd<>0 or a.provider_actual_microusd<>0 or a.reserved_microusd<>0)) then return null; end if;
 else
  if not e.enabled or e.expires_at<=clock_timestamp() or e.attempts_used>=e.attempt_limit
   or e.cost_committed>e.cost_limit-122880 or a.owner_id is null or a.limit_microusd>5000000
   or a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd)-a.reserved_microusd<122880
   or not fluid_private.api_text_policy_allowed(p_owner,p_operation,
    (select policy from fluid_private.strategy_runtime_policy where operation=p_operation),c.deployment_id,c.role_oid) then return null; end if;
 end if;
 select count(*) into v_active from public.jobs where owner_id=p_owner and billing_mode='openai_api'
  and state not in ('succeeded','failed','partial','cancelled');
 if v_active>=(case when v_new then c.owner_active_limit else e.active_limit end) then return null; end if;
 return c.id;
end $$;

create or replace function public.get_api_strategy_availability(p_project_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_legacy jsonb; v_operations jsonb;
begin
 -- Legacy validation establishes authentication and project ownership first.
 v_legacy:=fluid_private.get_api_strategy_availability_legacy(p_project_id);
 if not exists(select 1 from fluid_private.api_text_owner_entitlements where owner_id=v_owner)
  and v_legacy->>'status'='available' then return v_legacy; end if;
 select coalesce(jsonb_agg(jsonb_build_object('operation',operation,'maximumCostMicrousd',122880) order by operation),'[]'::jsonb)
 into v_operations from unnest(array['strategy.reformulate','strategy.audience','strategy.personality','strategy.positioning']) operation
 where fluid_private.api_text_allowance_available(v_owner,operation) is not null;
 if jsonb_array_length(v_operations)>0 then return jsonb_build_object('status','available','operations',v_operations); end if;
 if exists(select 1 from fluid_private.api_text_owner_entitlements where owner_id=v_owner) then
  return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','budget_unavailable');
 end if;
 return v_legacy;
end $$;

create or replace function public.enqueue_strategy_job(p_project_id uuid,p_expected_revision integer,p_operation text,
 p_idempotency_key text,p_accepted_max_cost_microusd bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_result jsonb; v_cohort text; v_new boolean;
 c fluid_private.api_text_allowance_cohorts; e fluid_private.api_text_owner_entitlements;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_expected_revision is null or p_expected_revision<1 or p_operation is null
  or p_operation not in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')
  or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
  or p_accepted_max_cost_microusd is null or p_accepted_max_cost_microusd not between 0 and 9007199254740991 then
  raise exception 'invalid_input' using errcode='22023'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 -- Exact historical replay remains independent of rollout, expiry and quota.
 if exists(select 1 from public.jobs where owner_id=v_owner and idempotency_key=p_idempotency_key)
  or (not exists(select 1 from fluid_private.api_text_owner_entitlements where owner_id=v_owner)
   and exists(select 1 from fluid_private.api_strategy_bindings b join fluid_private.strategy_runtime_policy p on p.operation=b.operation
    where b.owner_id=v_owner and b.operation=p_operation and fluid_private.api_text_legacy_policy_allowed(v_owner,p_operation,p.policy,b.deployment_id,b.role_oid))) then
  return fluid_private.enqueue_strategy_job_legacy(p_project_id,p_expected_revision,p_operation,p_idempotency_key,p_accepted_max_cost_microusd);
 end if;
 -- Global -> cohort -> owner -> project -> usage. Settlement never takes a
 -- global/cohort lock, so it cannot form an inverse lock cycle.
 perform 1 from fluid_private.api_text_allowance_rollout where singleton for update;
 -- A concurrent first request may have consumed the final slot while this
 -- request waited. Replay must win before any current eligibility check.
 if exists(select 1 from public.jobs where owner_id=v_owner and idempotency_key=p_idempotency_key)
  or not exists(select 1 from fluid_private.api_text_allowance_rollout where singleton and enabled) then
  return fluid_private.enqueue_strategy_job_legacy(p_project_id,p_expected_revision,p_operation,p_idempotency_key,p_accepted_max_cost_microusd);
 end if;
 v_cohort:=fluid_private.api_text_allowance_available(v_owner,p_operation);
 if v_cohort is null then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
 select * into strict c from fluid_private.api_text_allowance_cohorts where id=v_cohort for update;
 perform fluid_private.lock_strategy_owner(v_owner);
 if exists(select 1 from public.jobs where owner_id=v_owner and idempotency_key=p_idempotency_key) then
  return fluid_private.enqueue_strategy_job_legacy(p_project_id,p_expected_revision,p_operation,p_idempotency_key,p_accepted_max_cost_microusd);
 end if;
 if fluid_private.api_text_allowance_available(v_owner,p_operation) is distinct from v_cohort then raise exception 'allowance_unavailable' using errcode='P0001'; end if;
 perform 1 from public.projects where id=p_project_id and owner_id=v_owner for share;
 if not found then raise exception 'not_found' using errcode='P0002'; end if;
 select * into e from fluid_private.api_text_owner_entitlements where owner_id=v_owner for update;
 v_new:=not found;
 if v_new then
  insert into fluid_private.api_text_owner_entitlements(owner_id,cohort_id,attempt_limit,cost_limit,active_limit,expires_at)
   values(v_owner,c.id,c.owner_attempt_limit,c.owner_cost_limit,c.owner_active_limit,c.expires_at);
  insert into public.usage_accounts(owner_id,limit_microusd) values(v_owner,c.owner_cost_limit)
   on conflict(owner_id) do update set limit_microusd=excluded.limit_microusd
   where usage_accounts.limit_microusd=0 and usage_accounts.spent_microusd=0 and usage_accounts.provider_actual_microusd=0 and usage_accounts.reserved_microusd=0;
  if not found then raise exception 'budget_changed' using errcode='PT409'; end if;
  insert into fluid_private.strategy_billing_routes values(v_owner,'openai_api',1) on conflict(owner_id) do nothing;
  insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled)
   select v_owner,p.operation,c.role_oid,encode(sha256(convert_to(p.policy::text,'UTF8')),'hex'),c.deployment_id,true
   from fluid_private.strategy_runtime_policy p where p.operation=any(c.operations) and p.enabled and fluid_private.api_text_bounded_policy(p.policy);
 end if;
 v_result:=fluid_private.enqueue_strategy_job_legacy(p_project_id,p_expected_revision,p_operation,p_idempotency_key,p_accepted_max_cost_microusd);
 insert into fluid_private.api_text_allowance_admissions(job_id,owner_id,cohort_id,role_name,role_oid,maximum_cost_microusd)
  values((v_result->>'id')::uuid,v_owner,c.id,c.role_name,c.role_oid,122880);
 update fluid_private.api_text_owner_entitlements set attempts_used=attempts_used+1,cost_committed=cost_committed+122880 where owner_id=v_owner;
 update fluid_private.api_text_allowance_cohorts set accounts_used=accounts_used+v_new::integer,attempts_used=attempts_used+1,cost_committed=cost_committed+122880 where id=c.id;
 update fluid_private.api_text_allowance_rollout set accounts_used=accounts_used+v_new::integer,attempts_used=attempts_used+1,cost_committed=cost_committed+122880 where singleton;
 return v_result;
end $$;

create function fluid_private.api_text_admission_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'immutable_allowance_admission' using errcode='55000'; end $$;
create trigger api_text_allowance_admission_immutable before update or delete on fluid_private.api_text_allowance_admissions
 for each row execute function fluid_private.api_text_admission_immutable();

-- Historical settlement uses the frozen admitted role even after entitlement
-- disable/expiry. New work independently checks current policy in the old state machine.
create function fluid_private.api_text_descriptor_owner(p_descriptor jsonb) returns uuid
language plpgsql stable set search_path='' as $$
declare d fluid_private.api_text_dispatches; v_role oid;
begin
 if jsonb_typeof(p_descriptor) is distinct from 'object' then raise exception 'invalid_descriptor' using errcode='22023'; end if;
 if (select count(*) from jsonb_object_keys(p_descriptor))<>5
  or not p_descriptor ?& array['version','jobId','policyIdentity','deploymentId','dispatchIdentity']
  or p_descriptor->'version'<>'1'::jsonb then raise exception 'invalid_descriptor' using errcode='22023'; end if;
 select oid into v_role from pg_catalog.pg_roles where rolname=session_user;
 if not fluid_private.api_text_restricted_role(session_user,v_role) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 select * into d from fluid_private.api_text_dispatches where job_id=(p_descriptor->>'jobId')::uuid
  and policy_identity=p_descriptor->>'policyIdentity' and deployment_id=p_descriptor->>'deploymentId'
  and dispatch_identity=p_descriptor->>'dispatchIdentity';
 if not found or not exists(select 1 from public.jobs j where j.id=d.job_id and j.owner_id=d.owner_id
  and j.project_id=d.project_id and j.billing_mode='openai_api' and fluid_private.api_text_operation(j.operation)) then
  raise exception 'dispatch_not_found' using errcode='P0002'; end if;
 if d.owner_id=fluid_private.api_text_worker_legacy_owner() or exists(
  select 1 from fluid_private.api_text_allowance_admissions a where a.job_id=d.job_id and a.owner_id=d.owner_id
   and a.role_name=session_user and a.role_oid=v_role) then return d.owner_id; end if;
 raise exception 'worker_owner_mismatch' using errcode='42501';
end $$;

create function public.api_text_dispatch_action(p_descriptor jsonb,p_action text,p_arguments jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid; v_job uuid; v_result jsonb; v_count integer; v_expected integer; v_role oid;
begin
 if exists(select 1 from fluid_private.api_text_gateway_context where backend_pid=pg_backend_pid() and transaction_id=txid_current()) then
  raise exception 'nested_dispatch_action' using errcode='42501'; end if;
 v_owner:=fluid_private.api_text_descriptor_owner(p_descriptor); v_job:=(p_descriptor->>'jobId')::uuid;
 v_expected:=case p_action when 'descriptor' then 0 when 'expire' then 0 when 'claim' then 2
  when 'published' then 2 when 'redrive' then 1 when 'runtime' then 2 when 'authorize' then 2
  when 'heartbeat' then 2 when 'plan' then 2 when 'begin' then 4 when 'complete' then 6
  when 'finish' then 3 when 'step' then 3 when 'has_results' then 2 else null end;
 if v_expected is null or jsonb_typeof(p_arguments) is distinct from 'array' then
  raise exception 'invalid_dispatch_action' using errcode='22023'; end if;
 if jsonb_array_length(p_arguments)<>v_expected then
  raise exception 'invalid_dispatch_action' using errcode='22023'; end if;
 select oid into strict v_role from pg_catalog.pg_roles where rolname=session_user;
 insert into fluid_private.api_text_gateway_context values(pg_backend_pid(),txid_current(),session_user,v_role,v_owner,v_job);
 case p_action
 when 'descriptor' then v_result:=public.get_api_text_dispatch(v_job);
 when 'expire' then v_result:=public.expire_api_text_job(v_job);
 when 'claim' then v_result:=public.claim_api_text_job(v_job,p_arguments->>0,(p_arguments->>1)::integer,p_descriptor->>'policyIdentity',p_descriptor->>'deploymentId');
 when 'published' then v_result:=to_jsonb(public.mark_api_text_published(v_job,p_descriptor->>'dispatchIdentity',(p_arguments->>0)::integer,p_arguments->>1));
 when 'redrive' then v_result:=public.prepare_api_text_redrive(v_job,p_descriptor->>'dispatchIdentity',(p_arguments->>0)::integer);
 when 'runtime' then
  if not exists(select 1 from public.jobs where id=v_job and owner_id=v_owner and operation=p_arguments->>0 and input->'policy'=p_arguments->1) then raise exception 'dispatch_policy_mismatch' using errcode='42501'; end if;
  v_result:=to_jsonb(public.check_api_text_runtime(p_arguments->>0,p_arguments->1,p_descriptor->>'deploymentId'));
 when 'authorize' then v_result:=to_jsonb(public.authorize_api_text_dispatch(v_job,(p_arguments->>0)::uuid,p_arguments->>1,p_descriptor->>'policyIdentity',p_descriptor->>'deploymentId'));
 when 'heartbeat' then v_result:=to_jsonb(public.heartbeat_job(v_job,(p_arguments->>0)::uuid,(p_arguments->>1)::integer));
 when 'plan' then v_result:=to_jsonb(public.register_job_plan(v_job,(p_arguments->>0)::uuid,p_arguments->1));
 when 'begin' then v_result:=to_jsonb(public.begin_job_step(v_job,(p_arguments->>0)::uuid,p_arguments->>1,p_arguments->>2,(p_arguments->>3)::bigint));
 when 'complete' then v_result:=to_jsonb(public.complete_job_step(v_job,(p_arguments->>0)::uuid,p_arguments->>1,p_arguments->>2,(p_arguments->>3)::bigint,p_arguments->4,p_arguments->>5));
 when 'finish' then v_result:=to_jsonb(public.finish_job(v_job,(p_arguments->>0)::uuid,p_arguments->>1,p_arguments->>2));
 when 'step' then
  if (p_arguments->>0)::uuid is distinct from v_owner or not exists(select 1 from public.jobs where id=v_job and project_id=(p_arguments->>1)::uuid) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('state',state,'request_key',request_key,'reserved_cost_microusd',reserved_cost_microusd)),'[]'::jsonb) into v_result
   from public.job_steps where job_id=v_job and owner_id=v_owner and step_key=p_arguments->>2;
 when 'has_results' then
  if (p_arguments->>0)::uuid is distinct from v_owner or not exists(select 1 from public.jobs where id=v_job and project_id=(p_arguments->>1)::uuid) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
  select to_jsonb(exists(select 1 from public.job_steps where job_id=v_job and owner_id=v_owner and state='succeeded')) into v_result;
 end case;
 delete from fluid_private.api_text_gateway_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
 get diagnostics v_count=row_count;
 if v_count<>1 then raise exception 'dispatch_context_lost'; end if;
 return v_result;
end $$;

create function public.list_api_text_dispatches_v2(p_limit integer) returns setof jsonb
language plpgsql security definer set search_path='' as $$
declare d fluid_private.api_text_dispatches; v_message jsonb; v_descriptor jsonb; v_role oid;
begin
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'invalid_limit' using errcode='22023'; end if;
 select oid into v_role from pg_catalog.pg_roles where rolname=session_user;
 if not fluid_private.api_text_restricted_role(session_user,v_role) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 for d in select dispatch.* from fluid_private.api_text_dispatches dispatch join public.jobs j on j.id=dispatch.job_id
  where (dispatch.owner_id=fluid_private.api_text_worker_legacy_owner() or exists(select 1 from fluid_private.api_text_allowance_admissions a
   where a.job_id=dispatch.job_id and a.owner_id=dispatch.owner_id and a.role_name=session_user and a.role_oid=v_role))
   and j.owner_id=dispatch.owner_id and j.project_id=dispatch.project_id and j.billing_mode='openai_api'
   and ((j.state='queued' and fluid_private.api_text_descriptor(j,dispatch)->'retryable'='true'::jsonb)
    or (j.state in ('running','cancel_requested') and (j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp())))
  order by coalesce(dispatch.published_at,dispatch.created_at),dispatch.job_id limit p_limit loop
  v_message:=jsonb_build_object('version',1,'jobId',d.job_id,'policyIdentity',d.policy_identity,'deploymentId',d.deployment_id,'dispatchIdentity',d.dispatch_identity);
  v_descriptor:=public.api_text_dispatch_action(v_message,'descriptor');
  return next v_descriptor;
 end loop;
end $$;

create function public.api_text_multi_account_readiness(p_candidates jsonb,p_deployment text) returns table(operation text,ready boolean)
language plpgsql security definer set search_path='' as $$
declare candidate jsonb; v_role oid; v_legacy boolean;
begin
 if jsonb_typeof(p_candidates) is distinct from 'array' then raise exception 'invalid_input' using errcode='22023'; end if;
 if jsonb_array_length(p_candidates)>4 then raise exception 'invalid_input' using errcode='22023'; end if;
 select oid into v_role from pg_catalog.pg_roles where rolname=session_user;
 if not fluid_private.api_text_restricted_role(session_user,v_role) then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 for candidate in select value from jsonb_array_elements(p_candidates) loop
  operation:=candidate->>'operation';
  v_legacy:=false;
  if fluid_private.api_text_worker_legacy_owner() is not null then v_legacy:=public.check_api_text_runtime(operation,candidate->'policy',p_deployment); end if;
  ready:=v_legacy or (not fluid_private.api_text_allowance_paused() and fluid_private.api_text_bounded_policy(candidate->'policy') and exists(
   select 1 from fluid_private.api_text_allowance_cohorts c join fluid_private.api_text_allowance_rollout r on r.singleton
   join fluid_private.strategy_runtime_policy p on p.operation=candidate->>'operation'
   where r.enabled and c.enabled and c.expires_at>clock_timestamp() and c.role_name=session_user and c.role_oid=v_role
    and c.deployment_id=p_deployment and candidate->>'operation'=any(c.operations) and p.enabled and p.policy=candidate->'policy'));
  return next;
 end loop;
end $$;

-- Default privileges may contain unexpected grantees. Revoke every ACL on all
-- new functions/tables, then retain only the existing public facade ACLs.
do $deny$
declare item record; grantee text;
begin
 for item in select p.oid::regprocedure object,p.proowner owner,p.proacl acl from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='fluid_private' and p.proname in ('api_text_worker_legacy_owner','api_text_legacy_policy_allowed','enqueue_strategy_job_legacy','get_api_strategy_availability_legacy',
   'api_text_restricted_role','api_text_bounded_policy','api_text_allowance_paused','api_text_allowance_available','api_text_admission_immutable','api_text_descriptor_owner'))
  or (n.nspname='public' and p.proname in ('api_text_dispatch_action','list_api_text_dispatches_v2','api_text_multi_account_readiness')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',item.object);
  for grantee in select r.rolname from aclexplode(coalesce(item.acl,acldefault('f',item.owner))) a join pg_catalog.pg_roles r on r.oid=a.grantee where a.grantee<>item.owner loop
   execute format('revoke all on function %s from %I cascade',item.object,grantee);
  end loop;
 end loop;
end $deny$;
commit;
