-- LOCAL REVIEW TEMPLATE ONLY. Do not execute without the separately reviewed
-- exact project/owner/phase approval. Target project: fricsfwqibyhemknqgyf.
-- Owner is derived internally from two confirmed historical signed-in QA projects.
-- Replace only non-secret reviewed phase evidence below; never expose owner/contact data.
begin;
do $activation$
declare
 v_project uuid := '17dd910a-a9cb-4999-aa0e-2b5aa141bb29'::uuid;
 v_second_project uuid := '850dba6b-6811-41a2-ab26-cd3248039574'::uuid;
 v_owner uuid;
 v_expected_role_oid oid := 'REPLACE_FRESH_ROLE_OID'::oid;
 v_role pg_catalog.pg_roles;
 v_signature text; v_relation record; v_column record;
 v_expected_functions oid[] := (select array_agg(s::regprocedure::oid) from unnest(array[
  'public.claim_api_text_job(uuid,text,integer,text,text)',
  'public.check_api_text_runtime(text,jsonb,text)',
  'public.authorize_api_text_dispatch(uuid,uuid,text,text,text)',
  'public.heartbeat_job(uuid,uuid,integer)',
  'public.register_job_plan(uuid,uuid,jsonb)',
  'public.begin_job_step(uuid,uuid,text,text,bigint)',
  'public.complete_job_step(uuid,uuid,text,text,bigint,jsonb,text)',
  'public.finish_job(uuid,uuid,text,text)',
  'public.expire_api_text_job(uuid)',
  'public.get_api_text_dispatch(uuid)',
  'public.mark_api_text_published(uuid,text,integer,text)',
  'public.list_pending_api_text_dispatches(integer)',
  'public.prepare_api_text_redrive(uuid,text,integer)'
 ]) s);
 v_allowed_definers oid[] := (select array_agg(s::regprocedure::oid) from unnest(array[
  'public.claim_api_text_job(uuid,text,integer,text,text)',
  'public.check_api_text_runtime(text,jsonb,text)',
  'public.authorize_api_text_dispatch(uuid,uuid,text,text,text)',
  'public.heartbeat_job(uuid,uuid,integer)',
  'public.register_job_plan(uuid,uuid,jsonb)',
  'public.begin_job_step(uuid,uuid,text,text,bigint)',
  'public.complete_job_step(uuid,uuid,text,text,bigint,jsonb,text)',
  'public.finish_job(uuid,uuid,text,text)',
  'public.expire_api_text_job(uuid)',
  'public.get_api_text_dispatch(uuid)',
  'public.mark_api_text_published(uuid,text,integer,text)',
  'public.list_pending_api_text_dispatches(integer)',
  'public.prepare_api_text_redrive(uuid,text,integer)',
  'public.api_text_worker_owner()',
  'public.api_text_worker_can_read_step(uuid,uuid)',
  'public.subscription_worker_owner()',
  'public.subscription_worker_can_read_step(uuid,uuid)'
 ]) s);
 v_columns text[] := array['job_id','owner_id','project_id','step_key','state','request_key','reserved_cost_microusd'];
 v_account public.usage_accounts;
 v_expected_external_floor bigint := 'REPLACE_REVIEWED_EXTERNAL_CHARGE_FLOOR_MICROUSD'::bigint;
 v_external_status text := 'REPLACE_EXTERNAL_USAGE_RECONCILIATION_STATUS';
 v_evidence text := 'REPLACE_RECONCILIATION_EVIDENCE_REFERENCE';
 v_captured numeric; v_actual numeric; v_reserved numeric;
 v_history_hash text; v_policy_hash text; v_registration_hash text;
 v_expected_history_hash text := 'REPLACE_THREE_SUBSCRIPTION_UNKNOWN_SHA256';
 v_expected_policy_hash text := 'REPLACE_SUBSCRIPTION_POLICY_SHA256';
 v_expected_registration_hash text := 'REPLACE_SUBSCRIPTION_REGISTRATION_SHA256';
 v_deployment text := 'REPLACE_QUALIFIED_IMMUTABLE_DEPLOYMENT_ID';
 v_expected_route_revision integer := 'REPLACE_OBSERVED_ROUTE_REVISION'::integer;
 v_policy jsonb := '{"version":1,"pricingVersion":"2026-10-03","handlerVersion":"strategy-openai-v1","model":"gpt-6.1-sol","maxInputTokens":32768,"maxOutputTokens":4096,"maxWebSearchCalls":0,"inputMicrousdPerMillionTokens":2000000,"cachedInputMicrousdPerMillionTokens":100000,"cacheWriteMicrousdPerMillionTokens":2500000,"outputMicrousdPerMillionTokens":10000000,"webSearchMicrousdPerCall":10000,"maximumCostMicrousd":122880}'::jsonb;
 v_policy_identity text;
begin
 if current_database()<>'postgres' then raise exception 'unexpected_database'; end if;
 select p.owner_id into v_owner from public.projects p
 join public.projects q on q.owner_id=p.owner_id and q.id=v_second_project
 where p.id=v_project and p.id<>q.id;
 if v_owner is null then raise exception 'verified_owner_project_anchor_mismatch'; end if;
 select * into v_role from pg_catalog.pg_roles where rolname='fluid_api_text_worker';
 if not found or v_role.oid<>v_expected_role_oid or not v_role.rolcanlogin or v_role.rolinherit
 or v_role.rolsuper or v_role.rolbypassrls or v_role.rolcreatedb or v_role.rolcreaterole or v_role.rolreplication
 or exists(select 1 from pg_catalog.pg_auth_members where member=v_role.oid)
 or exists(select 1 from pg_catalog.pg_shdepend where refclassid='pg_catalog.pg_authid'::regclass and refobjid=v_role.oid and deptype='o') then
  raise exception 'fresh_restricted_role_required'; end if;
 if not exists(select 1 from fluid_private.api_text_worker_principals where role_name=v_role.rolname and role_oid=v_role.oid and owner_id=v_owner)
 or exists(select 1 from fluid_private.api_text_worker_principals where owner_id=v_owner and role_oid<>v_role.oid) then
  raise exception 'exact_owner_role_mapping_required'; end if;
 -- Validate effective capabilities too, including inherited PUBLIC defaults.
 -- Direct grants must match the reviewed database/schema inventory exactly.
 if exists(select 1 from pg_catalog.pg_database d cross join lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
   where a.grantee=v_role.oid and (d.datname<>current_database() or a.privilege_type<>'CONNECT' or a.is_grantable))
 or (select count(*) from pg_catalog.pg_database d cross join lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
   where a.grantee=v_role.oid)<>1 then raise exception 'unexpected_direct_database_grant'; end if;
 if exists(select 1 from pg_catalog.pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
   where a.grantee=v_role.oid and (n.nspname<>'public' or a.privilege_type<>'USAGE' or a.is_grantable))
 or (select count(*) from pg_catalog.pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
   where a.grantee=v_role.oid)<>1 then raise exception 'unexpected_direct_schema_grant'; end if;
 if has_database_privilege(v_role.oid,current_database(),'CREATE') then raise exception 'unexpected_database_create'; end if;
 if exists(select 1 from pg_catalog.pg_namespace n where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
   and has_schema_privilege(v_role.oid,n.oid,'CREATE')) then raise exception 'unexpected_schema_create'; end if;
 if not has_database_privilege(v_role.oid,current_database(),'CONNECT') or not has_schema_privilege(v_role.oid,'public','USAGE') then
  raise exception 'missing_connect_or_schema_usage'; end if;
 if exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and p.prosecdef
   and has_schema_privilege(v_role.oid,n.oid,'USAGE') and has_function_privilege(v_role.oid,p.oid,'EXECUTE')
   and not(p.oid=any(v_allowed_definers))) then raise exception 'unexpected_effective_privileged_rpc'; end if;
 if exists(select 1 from pg_catalog.pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where a.grantee=v_role.oid and (not(p.oid=any(v_expected_functions)) or a.is_grantable)) then raise exception 'unexpected_direct_function_grant'; end if;
 if exists(select 1 from pg_catalog.pg_attribute p cross join lateral aclexplode(p.attacl) a
   where a.grantee=v_role.oid and a.is_grantable) then raise exception 'unexpected_column_grant_option'; end if;
 -- Direct object grants are inventoried across every schema, even without USAGE.
 if exists(select 1 from pg_catalog.pg_class c cross join lateral aclexplode(c.relacl) a
   where a.grantee=v_role.oid) then raise exception 'unexpected_direct_relation_grant'; end if;
 if exists(select 1 from pg_catalog.pg_attribute p cross join lateral aclexplode(p.attacl) a
   where a.grantee=v_role.oid and (p.attrelid<>'public.job_steps'::regclass or not(p.attname=any(v_columns))
     or a.privilege_type<>'SELECT' or a.is_grantable))
 or (select count(*) from pg_catalog.pg_attribute p cross join lateral aclexplode(p.attacl) a
   where a.grantee=v_role.oid)<>7 then raise exception 'unexpected_direct_column_grant'; end if;
 if (select count(distinct p.oid) from pg_catalog.pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where a.grantee=v_role.oid and a.privilege_type='EXECUTE')<>13 then raise exception 'exact_thirteen_execute_grants_required'; end if;
 foreach v_signature in array (select array_agg(x::regprocedure::text) from unnest(v_expected_functions) x) loop
  if not has_function_privilege(v_role.oid,v_signature,'EXECUTE') then raise exception 'missing_worker_execute'; end if;
 end loop;
 for v_relation in select c.oid,n.nspname,c.relname,c.relkind from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
   and has_schema_privilege(v_role.oid,n.oid,'USAGE') and c.relkind in ('r','p','v','m','f','S') loop
  if v_relation.relkind='S' then
   if has_sequence_privilege(v_role.oid,v_relation.oid,'USAGE,SELECT,UPDATE') then raise exception 'unexpected_sequence_access'; end if;
  else
   if has_table_privilege(v_role.oid,v_relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then raise exception 'unexpected_table_access: %.%',v_relation.nspname,v_relation.relname; end if;
   for v_column in select attname,attnum from pg_catalog.pg_attribute where attrelid=v_relation.oid and attnum>0 and not attisdropped loop
    if has_column_privilege(v_role.oid,v_relation.oid,v_column.attnum,'INSERT,UPDATE,REFERENCES') then raise exception 'unexpected_column_write'; end if;
    if has_column_privilege(v_role.oid,v_relation.oid,v_column.attnum,'SELECT') is distinct from
      (v_relation.oid='public.job_steps'::regclass and v_column.attname=any(v_columns)) then raise exception 'unexpected_column_read: %.%.%',v_relation.nspname,v_relation.relname,v_column.attname; end if;
   end loop;
  end if;
 end loop;
 if not exists(select 1 from pg_class where oid='public.job_steps'::regclass and relrowsecurity and relforcerowsecurity) then raise exception 'step_force_rls_required'; end if;
 if v_deployment like 'REPLACE_%' or v_deployment !~ '^[A-Za-z0-9._:-]{1,200}$' or v_expected_route_revision<0 then raise exception 'qualified_deployment_and_route_revision_required'; end if;
 perform fluid_private.lock_strategy_owner(v_owner);
 select * into v_account from public.usage_accounts where owner_id=v_owner for update;
 if v_external_status<>'REVIEWED_COMPLETE' or v_expected_external_floor<0 or v_evidence like 'REPLACE_%' or length(v_evidence)<8 then
  raise exception 'complete_external_test_reconciliation_required'; end if;
 if exists(select 1 from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription'
   and (reserved_cost_microusd<>0 or actual_cost_microusd<>0 or max_attempts<>1)) then raise exception 'subscription_zero_money_invariant_failed'; end if;
 select coalesce(sum(captured_microusd),0),coalesce(sum(actual_microusd),0),
   coalesce(sum(case when state='active' then reserved_microusd-captured_microusd else 0 end),0)
 into v_captured,v_actual,v_reserved from public.usage_reservations where owner_id=v_owner;
 if exists(select 1 from public.usage_reservations r join public.jobs j on j.id=r.job_id where r.owner_id=v_owner
   and (j.billing_mode<>'openai_api' or j.owner_id<>r.owner_id or j.project_id<>r.project_id
     or j.reserved_cost_microusd<>r.reserved_microusd or j.actual_cost_microusd<>r.actual_microusd
     or r.captured_microusd<>least(r.reserved_microusd,r.actual_microusd)
     or (r.state='settled' and j.state not in ('succeeded','failed','partial','cancelled'))
     or (r.state='active' and j.state in ('succeeded','failed','partial','cancelled')))) then raise exception 'reservation_job_reconciliation_mismatch'; end if;
 if exists(select 1 from public.jobs j where j.owner_id=v_owner and j.billing_mode='openai_api'
   and (j.reserved_cost_microusd>0 or j.actual_cost_microusd>0)
   and not exists(select 1 from public.usage_reservations r where r.job_id=j.id)) then raise exception 'unrepresented_paid_job'; end if;
 if v_account.owner_id is null or v_account.limit_microusd<>5000000
   or v_account.spent_microusd<>v_captured or v_account.provider_actual_microusd<>v_actual or v_account.reserved_microusd<>v_reserved
   or v_account.provider_actual_microusd<v_expected_external_floor
   or greatest(v_account.spent_microusd,v_account.provider_actual_microusd)+v_account.reserved_microusd>5000000 then
  raise exception 'shared_ledger_requires_reviewed_reconciliation'; end if;
 if fluid_private.api_text_paid_paused(v_owner) then raise exception 'unresolved_paid_api_outcome'; end if;
 if 5000000-greatest(v_account.spent_microusd,v_account.provider_actual_microusd)-v_account.reserved_microusd<122880 then raise exception 'insufficient_trial_balance'; end if;
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(j) order by j.id),'[]'::jsonb)::text,'UTF8')),'hex') into v_history_hash
 from public.jobs j where j.owner_id=v_owner and j.billing_mode='chatgpt_subscription' and j.state='needs_reconciliation';
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) order by p.operation),'[]'::jsonb)::text,'UTF8')),'hex') into v_policy_hash
 from fluid_private.subscription_runtime_policy p where p.owner_id=v_owner;
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by r.registration_id),'[]'::jsonb)::text,'UTF8')),'hex') into v_registration_hash
 from fluid_private.subscription_registrations r where r.owner_id=v_owner;
 if (select count(*) from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and state='needs_reconciliation')<>3
 or exists(select 1 from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and state='needs_reconciliation'
   and (reserved_cost_microusd<>0 or actual_cost_microusd<>0 or max_attempts<>1 or lease_token is not null or lease_expires_at is not null))
 or v_history_hash<>v_expected_history_hash or v_policy_hash<>v_expected_policy_hash or v_registration_hash<>v_expected_registration_hash then
  raise exception 'preserved_subscription_evidence_changed'; end if;
 if exists(select 1 from fluid_private.api_strategy_bindings where owner_id=v_owner) then raise exception 'existing_api_binding_collision_stop'; end if;
 if exists(select 1 from fluid_private.strategy_runtime_policy where operation='strategy.reformulate') then raise exception 'existing_global_policy_collision_stop'; end if;
 v_policy_identity:=encode(sha256(convert_to(v_policy::text,'UTF8')),'hex');
 insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,v_policy);
 insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled)
 values(v_owner,'strategy.reformulate',v_role.oid,v_policy_identity,v_deployment,true);
 perform fluid_private.set_strategy_billing_route(v_owner,v_expected_route_revision,'openai_api');
 -- All writes above roll back together if route/history/ledger checks fail.
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(j) order by j.id),'[]'::jsonb)::text,'UTF8')),'hex') into v_history_hash
 from public.jobs j where j.owner_id=v_owner and j.billing_mode='chatgpt_subscription' and j.state='needs_reconciliation';
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) order by p.operation),'[]'::jsonb)::text,'UTF8')),'hex') into v_policy_hash
 from fluid_private.subscription_runtime_policy p where p.owner_id=v_owner;
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by r.registration_id),'[]'::jsonb)::text,'UTF8')),'hex') into v_registration_hash
 from fluid_private.subscription_registrations r where r.owner_id=v_owner;
 if (select count(*) from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and state='needs_reconciliation')<>3
 or exists(select 1 from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and state='needs_reconciliation'
   and (reserved_cost_microusd<>0 or actual_cost_microusd<>0 or max_attempts<>1 or lease_token is not null or lease_expires_at is not null))
 or v_history_hash<>v_expected_history_hash or v_policy_hash<>v_expected_policy_hash or v_registration_hash<>v_expected_registration_hash then
  raise exception 'preserved_subscription_evidence_changed'; end if;
end $activation$;
commit;
