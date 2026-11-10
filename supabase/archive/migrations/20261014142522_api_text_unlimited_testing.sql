-- Operator opt-in for an existing account's continuing text testing only.
-- No account is opted in, no limit/credit/counter is changed, and no worker
-- privilege or operation is enabled by this migration. Requests remain bounded.
begin;

-- Fail closed if a predecessor changed. Replacements below preserve each
-- existing function's owner, signature, security settings and EXECUTE ACL.
do $guard$
declare signature text; expected_md5 text; expected_definer boolean; expected_volatility "char";
begin
 for signature,expected_md5,expected_definer,expected_volatility in values
  ('fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)','2e5d6991b655845ad9672efc898010b6',false,'s'),
  ('fluid_private.api_text_allowance_available(uuid,text)','eff62c8c168c924ea2299c7097962fbe',false,'s'),
  ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)','31c39228e12106bde8a6b1fdadd2809a',true,'v'),
  ('public.enqueue_job(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)','ad301247e000e64b5c96ae9979dc7bc9',true,'v'),
  ('public.check_api_text_runtime(text,jsonb,text)','69503dd7cfc30f6364bca7c2578452ac',true,'v'),
  ('fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)','4432527800626fdabcee289747118617',false,'s'),
  ('public.begin_job_step(uuid,uuid,text,text,bigint)','2b14ef9621d6b9f0e2211e0832cb6820',true,'v'),
  ('public.api_text_multi_account_readiness(jsonb,text)','e64211a5e731f5b4f483daebf2978057',true,'v'),
  ('public.claim_api_text_job(uuid,text,integer,text,text)','139d3805c7444860cddfc8f66a779f01',true,'v'),
  ('public.authorize_api_text_dispatch(uuid,uuid,text,text,text)','c54820cd32b02b94ddc614bedd350930',true,'v') loop
  if not exists(select 1 from pg_catalog.pg_proc p where p.oid=signature::regprocedure
   and md5(p.prosrc)=expected_md5 and p.prosecdef=expected_definer and p.provolatile=expected_volatility
   and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user)) then
   raise exception 'unexpected_api_testing_predecessor: %',signature;
  end if;
 end loop;
end $guard$;

create table fluid_private.api_text_testing_access (
 owner_id uuid primary key references fluid_private.api_text_owner_entitlements(owner_id),
 cohort_id text not null references fluid_private.api_text_allowance_cohorts(id),
 operation text not null default 'strategy.reformulate' check(operation='strategy.reformulate'),
 enabled boolean not null default false,
 created_at timestamptz not null default clock_timestamp()
);
-- The original allowance admission supplies immutable owner/cohort/role/cost.
-- A separate marker leaves all historical admission rows and counters intact.
create table fluid_private.api_text_testing_admissions (
 job_id uuid primary key references fluid_private.api_text_allowance_admissions(job_id),
 created_at timestamptz not null default clock_timestamp()
);
create trigger api_text_testing_admission_immutable before update or delete on fluid_private.api_text_testing_admissions
 for each row execute function fluid_private.api_text_admission_immutable();

-- A trusted admission wrapper creates this exact-input context only during
-- its transaction. No client/worker can read or supply it. Success deletes it;
-- every error rolls the insertion back with its job/reservation/admission.
create table fluid_private.api_text_testing_admission_context (
 backend_pid integer not null,
 transaction_id bigint not null,
 owner_id uuid not null,
 project_id uuid not null,
 input_revision integer not null,
 operation text not null check(operation='strategy.reformulate'),
 idempotency_key text not null,
 input_hash text not null,
 input jsonb not null,
 primary key(backend_pid,transaction_id)
);

create function fluid_private.api_text_testing_enabled(p_owner uuid,p_operation text) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.api_text_testing_access t
  join fluid_private.api_text_owner_entitlements e on e.owner_id=t.owner_id and e.cohort_id=t.cohort_id
  where t.owner_id=p_owner and t.operation=p_operation and t.enabled and e.enabled);
$$;

create function fluid_private.api_text_testing_enqueue_matches(p_owner uuid,p_project uuid,p_operation text,
 p_revision integer,p_hash text,p_input jsonb,p_key text,p_cost bigint,p_attempts integer) returns boolean
language sql stable set search_path='' as $$
 select coalesce(p_owner=auth.uid() and p_operation='strategy.reformulate' and p_cost=122880 and p_attempts=3
  and fluid_private.api_text_bounded_policy(p_input->'policy')
  and fluid_private.api_text_testing_enabled(p_owner,p_operation)
  and exists(select 1 from fluid_private.api_text_testing_admission_context c
   where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current()
    and (c.owner_id,c.project_id,c.operation,c.input_revision,c.input_hash,c.input,c.idempotency_key)
     is not distinct from (p_owner,p_project,p_operation,p_revision,p_hash,p_input,p_key)),false);
$$;

create function fluid_private.api_text_testing_job_allowed(p_job uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.api_text_testing_admissions marker
  join fluid_private.api_text_allowance_admissions a on a.job_id=marker.job_id
  join public.jobs j on j.id=a.job_id and j.owner_id=a.owner_id
  join fluid_private.api_text_dispatches d on d.job_id=j.id and d.owner_id=j.owner_id and d.project_id=j.project_id
  join fluid_private.api_text_testing_access t on t.owner_id=a.owner_id and t.cohort_id=a.cohort_id and t.operation=j.operation
  where j.id=p_job and t.enabled and j.billing_mode='openai_api' and j.operation='strategy.reformulate'
   and a.maximum_cost_microusd=122880 and j.reserved_cost_microusd=122880
   and fluid_private.api_text_bounded_policy(j.input->'policy')
   and fluid_private.api_text_testing_enabled(j.owner_id,j.operation)
   and not fluid_private.api_text_paid_paused(j.owner_id)
   and fluid_private.api_text_policy_allowed(j.owner_id,j.operation,j.input->'policy',d.deployment_id,a.role_oid));
$$;

create function fluid_private.api_text_testing_gateway_matches(p_owner uuid,p_operation text,p_policy jsonb,p_deployment text,p_job uuid default null) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.api_text_gateway_context c
  join public.jobs j on j.id=c.job_id and j.owner_id=c.owner_id
  join fluid_private.api_text_dispatches d on d.job_id=j.id and d.owner_id=j.owner_id and d.project_id=j.project_id
  where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current()
   and c.role_name=session_user and fluid_private.api_text_restricted_role(c.role_name,c.role_oid)
   and c.owner_id=p_owner and (p_job is null or c.job_id=p_job) and j.operation=p_operation and j.input->'policy'=p_policy and d.deployment_id=p_deployment
   and fluid_private.api_text_testing_job_allowed(j.id));
$$;

-- These exact substitutions change only the aggregate testing exceptions.
-- Authentication, ownership, operation policy, maximum request cost, plans,
-- lease/idempotency, uncertain outcomes, cancellation and settlement remain.
do $patch$
declare signature text; definition text; original text; replacement text;
begin
 for signature,original,replacement in values
  ('fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid)',$old$and e.expires_at>clock_timestamp() and c.expires_at>clock_timestamp()$old$,$new$and ((e.expires_at>clock_timestamp() and c.expires_at>clock_timestamp())
    or fluid_private.api_text_testing_enabled(p_owner,p_operation))$new$),
  ('fluid_private.api_text_allowance_available(uuid,text)',$old$e fluid_private.api_text_owner_entitlements; a public.usage_accounts; v_new boolean; v_active bigint;$old$,$new$e fluid_private.api_text_owner_entitlements; a public.usage_accounts; v_new boolean; v_active bigint; v_testing boolean;$new$),
  ('fluid_private.api_text_allowance_available(uuid,text)',$old$v_new:=not found;$old$,$new$v_new:=not found;
 v_testing:=not v_new and fluid_private.api_text_testing_enabled(p_owner,p_operation);$new$),
  ('fluid_private.api_text_allowance_available(uuid,text)',$old$not c.enabled or c.expires_at<=clock_timestamp() or p_operation<>all(c.operations)$old$,$new$not c.enabled or (not v_testing and c.expires_at<=clock_timestamp()) or p_operation<>all(c.operations)$new$),
  ('fluid_private.api_text_allowance_available(uuid,text)',$old$if r.attempts_used>=r.attempt_limit or r.cost_committed>r.cost_limit-122880
  or c.attempts_used>=c.attempt_limit or c.cost_committed>c.cost_limit-122880 then return null; end if;$old$,$new$if not v_testing and (r.attempts_used>=r.attempt_limit or r.cost_committed>r.cost_limit-122880
  or c.attempts_used>=c.attempt_limit or c.cost_committed>c.cost_limit-122880) then return null; end if;$new$),
  ('fluid_private.api_text_allowance_available(uuid,text)',$old$if not e.enabled or e.expires_at<=clock_timestamp() or e.attempts_used>=e.attempt_limit
   or e.cost_committed>e.cost_limit-122880 or a.owner_id is null or a.limit_microusd>5000000
   or a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd)-a.reserved_microusd<122880$old$,$new$if not e.enabled or a.owner_id is null or a.limit_microusd>5000000
   or (not v_testing and (e.expires_at<=clock_timestamp() or e.attempts_used>=e.attempt_limit
    or e.cost_committed>e.cost_limit-122880
    or a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd)-a.reserved_microusd<122880))$new$),
  ('fluid_private.api_text_allowance_available(uuid,text)',$old$case when v_new then c.owner_active_limit else e.active_limit end$old$,$new$case when v_testing then 1 when v_new then c.owner_active_limit else e.active_limit end$new$),
  ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)',$old$c fluid_private.api_text_allowance_cohorts; e fluid_private.api_text_owner_entitlements;$old$,$new$c fluid_private.api_text_allowance_cohorts; e fluid_private.api_text_owner_entitlements; v_testing boolean; v_count integer;$new$),
  ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)',$old$ v_result:=fluid_private.enqueue_strategy_job_legacy(p_project_id,p_expected_revision,p_operation,p_idempotency_key,p_accepted_max_cost_microusd);
 insert into fluid_private.api_text_allowance_admissions$old$,$new$ -- Only this authenticated, locked wrapper may establish the temporary bypass.
 -- The exact nested enqueue input is frozen here; all downstream rows retain
 -- their normal immutable reservation, policy and worker admission evidence.
 perform 1 from fluid_private.api_text_testing_access where owner_id=v_owner for share;
 v_testing:=not v_new and fluid_private.api_text_testing_enabled(v_owner,p_operation);
 if v_testing then
  insert into fluid_private.api_text_testing_admission_context(
   backend_pid,transaction_id,owner_id,project_id,input_revision,operation,idempotency_key,input_hash,input)
  select pg_backend_pid(),txid_current(),v_owner,p_project_id,p_expected_revision,p_operation,p_idempotency_key,revision.input_hash,
   jsonb_build_object('version',1,'context',revision.context,'policy',policy.policy,'acceptedMaxCostMicrousd',p_accepted_max_cost_microusd)
  from public.project_revisions revision join fluid_private.strategy_runtime_policy policy on policy.operation=p_operation
  where revision.project_id=p_project_id and revision.owner_id=v_owner and revision.revision=p_expected_revision;
  if not found then raise exception 'testing_context_unavailable' using errcode='55000'; end if;
 end if;
 v_result:=fluid_private.enqueue_strategy_job_legacy(p_project_id,p_expected_revision,p_operation,p_idempotency_key,p_accepted_max_cost_microusd);
 insert into fluid_private.api_text_allowance_admissions$new$),
  ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)',$old$ update fluid_private.api_text_owner_entitlements set attempts_used=attempts_used+1,cost_committed=cost_committed+122880 where owner_id=v_owner;
 update fluid_private.api_text_allowance_cohorts set accounts_used=accounts_used+v_new::integer,attempts_used=attempts_used+1,cost_committed=cost_committed+122880 where id=c.id;
 update fluid_private.api_text_allowance_rollout set accounts_used=accounts_used+v_new::integer,attempts_used=attempts_used+1,cost_committed=cost_committed+122880 where singleton;$old$,$new$ if v_testing then
  insert into fluid_private.api_text_testing_admissions(job_id) values((v_result->>'id')::uuid);
  delete from fluid_private.api_text_testing_admission_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'testing_context_lost' using errcode='55000'; end if;
 else
  update fluid_private.api_text_owner_entitlements set attempts_used=attempts_used+1,cost_committed=cost_committed+122880 where owner_id=v_owner;
  update fluid_private.api_text_allowance_cohorts set accounts_used=accounts_used+v_new::integer,attempts_used=attempts_used+1,cost_committed=cost_committed+122880 where id=c.id;
  update fluid_private.api_text_allowance_rollout set accounts_used=accounts_used+v_new::integer,attempts_used=attempts_used+1,cost_committed=cost_committed+122880 where singleton;
 end if;$new$),
  ('public.enqueue_job(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)',$old$if p_max_cost_microusd < 0 or p_max_cost_microusd > v_account.limit_microusd - greatest(v_account.spent_microusd, v_account.provider_actual_microusd) - v_account.reserved_microusd then$old$,$new$if p_max_cost_microusd < 0 or (p_max_cost_microusd > v_account.limit_microusd - greatest(v_account.spent_microusd, v_account.provider_actual_microusd) - v_account.reserved_microusd
    and not fluid_private.api_text_testing_enqueue_matches(p_owner_id,p_project_id,p_operation,p_input_revision,p_input_hash,p_input,p_idempotency_key,p_max_cost_microusd,p_max_attempts)) then$new$),
  ('public.check_api_text_runtime(text,jsonb,text)',$old$and reserved_microusd<=limit_microusd-greatest(spent_microusd,provider_actual_microusd));$old$,$new$and (reserved_microusd<=limit_microusd-greatest(spent_microusd,provider_actual_microusd)
  or fluid_private.api_text_testing_gateway_matches(v_owner,p_operation,p_policy,p_deployment_id)));$new$),
  ('public.check_api_text_runtime(text,jsonb,text)',$old$and not fluid_private.api_text_paid_paused(v_owner)$old$,$new$and not fluid_private.api_text_paid_paused(v_owner)
 and not exists(select 1 from fluid_private.api_text_gateway_context context
  join fluid_private.api_text_testing_admissions marker on marker.job_id=context.job_id
  where context.backend_pid=pg_backend_pid() and context.transaction_id=txid_current()
   and not fluid_private.api_text_testing_gateway_matches(v_owner,p_operation,p_policy,p_deployment_id))
 and not exists(select 1 from fluid_private.api_text_testing_admissions marker
  join public.jobs testing_job on testing_job.id=marker.job_id
  join fluid_private.api_text_dispatches dispatch on dispatch.job_id=testing_job.id
  where testing_job.owner_id=v_owner and testing_job.operation=p_operation and testing_job.input->'policy'=p_policy
   and dispatch.deployment_id=p_deployment_id and testing_job.state not in ('succeeded','failed','partial','cancelled')
   and not fluid_private.api_text_testing_gateway_matches(v_owner,p_operation,p_policy,p_deployment_id,testing_job.id))$new$),
  ('fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)',$old$and reserved_microusd<=limit_microusd-greatest(spent_microusd,provider_actual_microusd)),$old$,$new$and (reserved_microusd<=limit_microusd-greatest(spent_microusd,provider_actual_microusd)
      or fluid_private.api_text_testing_job_allowed(p_job.id))),$new$),
  ('fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)',$old$and not fluid_private.api_text_paid_paused(p_job.owner_id)$old$,$new$and not fluid_private.api_text_paid_paused(p_job.owner_id)
   and (not exists(select 1 from fluid_private.api_text_testing_admissions where job_id=p_job.id)
    or fluid_private.api_text_testing_job_allowed(p_job.id))$new$),
  ('public.begin_job_step(uuid,uuid,text,text,bigint)',$old$if v_account.reserved_microusd > v_account.limit_microusd - greatest(v_account.spent_microusd, v_account.provider_actual_microusd) then$old$,$new$if v_account.reserved_microusd > v_account.limit_microusd - greatest(v_account.spent_microusd, v_account.provider_actual_microusd)
    and not fluid_private.api_text_testing_job_allowed(v_job.id) then$new$),
  ('public.begin_job_step(uuid,uuid,text,text,bigint)',$old$v_job := fluid_private.lock_leased_job(p_job_id, p_lease_token);$old$,$new$v_job := fluid_private.lock_leased_job(p_job_id, p_lease_token);
  if exists(select 1 from fluid_private.api_text_testing_admissions where job_id=v_job.id)
    and not fluid_private.api_text_testing_gateway_matches(v_job.owner_id,v_job.operation,v_job.input->'policy',
      (select deployment_id from fluid_private.api_text_dispatches where job_id=v_job.id),v_job.id) then raise exception 'runtime_unavailable' using errcode='P0001'; end if;$new$),
  ('public.api_text_multi_account_readiness(jsonb,text)',$old$where r.enabled and c.enabled and c.expires_at>clock_timestamp() and c.role_name=session_user and c.role_oid=v_role$old$,$new$where r.enabled and c.enabled and (c.expires_at>clock_timestamp() or exists(
    select 1 from fluid_private.api_text_testing_access testing
    where testing.cohort_id=c.id and fluid_private.api_text_testing_enabled(testing.owner_id,candidate->>'operation')
     and fluid_private.api_text_policy_allowed(testing.owner_id,candidate->>'operation',candidate->'policy',p_deployment,v_role)))
    and c.role_name=session_user and c.role_oid=v_role$new$),
  ('public.claim_api_text_job(uuid,text,integer,text,text)',$old$or not public.check_api_text_runtime(j.operation,j.input->'policy',p_deployment_id) then$old$,$new$or not public.check_api_text_runtime(j.operation,j.input->'policy',p_deployment_id)
 or (exists(select 1 from fluid_private.api_text_testing_admissions where job_id=j.id)
  and not fluid_private.api_text_testing_gateway_matches(v_owner,j.operation,j.input->'policy',p_deployment_id,j.id)) then$new$),
  ('public.authorize_api_text_dispatch(uuid,uuid,text,text,text)',$old$return j.state='running' and j.cancel_requested_at is null$old$,$new$return j.state='running' and j.cancel_requested_at is null
 and (not exists(select 1 from fluid_private.api_text_testing_admissions where job_id=j.id)
  or fluid_private.api_text_testing_gateway_matches(v_owner,j.operation,j.input->'policy',p_deployment_id,j.id))$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
   raise exception 'unexpected_api_testing_fragment: %',signature;
  end if;
  execute replace(definition,original,replacement);
 end loop;
end $patch$;

-- Scrub hostile defaults on new objects only; existing worker/RPC ACLs stay
-- byte-for-byte unchanged. An operator must separately grant one existing
-- entitlement access. Ordinary authenticated owners cannot self-enroll.
do $deny$
declare object_id oid; privilege record;
begin
 foreach object_id in array array[
  'fluid_private.api_text_testing_access'::regclass,
  'fluid_private.api_text_testing_admissions'::regclass,
  'fluid_private.api_text_testing_admission_context'::regclass] loop
  execute format('alter table %s enable row level security',object_id::regclass);
  execute format('alter table %s force row level security',object_id::regclass);
  execute format('revoke all on table %s from public,anon,authenticated,service_role',object_id::regclass);
  for privilege in select distinct a.grantee from pg_catalog.pg_class c,
   lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   where c.oid=object_id and a.grantee<>c.relowner loop
   execute format('revoke all on table %s from %s cascade',object_id::regclass,
    case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
  end loop;
 end loop;
 foreach object_id in array array[
  'fluid_private.api_text_testing_enabled(uuid,text)'::regprocedure,
  'fluid_private.api_text_testing_enqueue_matches(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)'::regprocedure,
  'fluid_private.api_text_testing_job_allowed(uuid)'::regprocedure,
  'fluid_private.api_text_testing_gateway_matches(uuid,text,jsonb,text,uuid)'::regprocedure] loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',object_id::regprocedure);
  for privilege in select distinct a.grantee from pg_catalog.pg_proc p,
   lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,
    case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
  end loop;
 end loop;
end $deny$;
commit;
