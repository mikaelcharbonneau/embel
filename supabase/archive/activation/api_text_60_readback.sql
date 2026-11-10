-- LOCAL REVIEW TEMPLATE ONLY. Do not execute without the separately reviewed
-- exact project/owner/phase approval. Target project: fricsfwqibyhemknqgyf.
-- Owner is derived internally from two confirmed historical signed-in QA projects.
-- Replace only non-secret reviewed phase evidence below; never expose owner/contact data.
begin read only;
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
 v_policy jsonb := '{"version":1,"pricingVersion":"2026-10-03","handlerVersion":"strategy-openai-v1","model":"gpt-6.1-sol","maxInputTokens":32768,"maxOutputTokens":4096,"maxWebSearchCalls":0,"inputMicrousdPerMillionTokens":2000000,"cachedInputMicrousdPerMillionTokens":100000,"cacheWriteMicrousdPerMillionTokens":2500000,"outputMicrousdPerMillionTokens":10000000,"webSearchMicrousdPerCall":10000,"maximumCostMicrousd":122880}'::jsonb;
 v_policy_identity text;
 v_history_hash text; v_policy_hash text; v_registration_hash text;
 v_expected_history_hash text := 'REPLACE_THREE_SUBSCRIPTION_UNKNOWN_SHA256';
 v_expected_policy_hash text := 'REPLACE_SUBSCRIPTION_POLICY_SHA256';
 v_expected_registration_hash text := 'REPLACE_SUBSCRIPTION_REGISTRATION_SHA256';
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
 v_policy_identity:=encode(sha256(convert_to(v_policy::text,'UTF8')),'hex');
 if not exists(select 1 from fluid_private.strategy_runtime_policy where operation='strategy.reformulate' and enabled and policy=v_policy)
 or (select count(*) from fluid_private.api_strategy_bindings where owner_id=v_owner and enabled)<>1
 or not exists(select 1 from fluid_private.api_strategy_bindings where owner_id=v_owner and operation='strategy.reformulate'
   and role_oid=v_role.oid and enabled and policy_identity=v_policy_identity and deployment_id='REPLACE_QUALIFIED_IMMUTABLE_DEPLOYMENT_ID')
 or not exists(select 1 from fluid_private.strategy_billing_routes where owner_id=v_owner and billing_mode='openai_api') then
  raise exception 'exact_reformulate_only_activation_required'; end if;
end $activation$;
with a as (
 select p.owner_id from public.projects p
 join public.projects q on q.owner_id=p.owner_id and q.id='850dba6b-6811-41a2-ab26-cd3248039574'::uuid
 where p.id='17dd910a-a9cb-4999-aa0e-2b5aa141bb29'::uuid and p.id<>q.id
)
select jsonb_build_object(
 'verifiedProjectAnchorsMatch',true,
 'route',(select jsonb_build_object('billingMode',r.billing_mode,'revision',r.revision) from fluid_private.strategy_billing_routes r where r.owner_id=a.owner_id),
 'usageAccount',(select jsonb_build_object('limitMicrousd',u.limit_microusd,'spentMicrousd',u.spent_microusd,'reservedMicrousd',u.reserved_microusd,'providerActualMicrousd',u.provider_actual_microusd) from public.usage_accounts u where u.owner_id=a.owner_id),
 'subscriptionUnknownCount',(select count(*) from public.jobs j where j.owner_id=a.owner_id and j.billing_mode='chatgpt_subscription' and j.state='needs_reconciliation'),
 'subscriptionUnknownSha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(j) order by j.id),'[]'::jsonb)::text,'UTF8')),'hex') from public.jobs j where j.owner_id=a.owner_id and j.billing_mode='chatgpt_subscription' and j.state='needs_reconciliation'),
 'subscriptionPolicySha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) order by p.operation),'[]'::jsonb)::text,'UTF8')),'hex') from fluid_private.subscription_runtime_policy p where p.owner_id=a.owner_id),
 'subscriptionRegistrationSha256',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by r.registration_id),'[]'::jsonb)::text,'UTF8')),'hex') from fluid_private.subscription_registrations r where r.owner_id=a.owner_id),
 'subscriptionUnknownRows',(select coalesce(jsonb_agg(jsonb_build_object('id',j.id,'reserved',j.reserved_cost_microusd,'actual',j.actual_cost_microusd,'maxAttempts',j.max_attempts,'hasLease',j.lease_token is not null,'sha256',encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex')) order by j.id),'[]'::jsonb) from public.jobs j where j.owner_id=a.owner_id and j.billing_mode='chatgpt_subscription' and j.state='needs_reconciliation'),
 'reservationTotals',(select jsonb_build_object('captured',coalesce(sum(captured_microusd),0),'actual',coalesce(sum(actual_microusd),0),'activeRemaining',coalesce(sum(case when state='active' then reserved_microusd-captured_microusd else 0 end),0)) from public.usage_reservations r where r.owner_id=a.owner_id),
 'apiBindings',(select coalesce(jsonb_agg(jsonb_build_object('operation',b.operation,'roleOid',b.role_oid,'policyIdentity',b.policy_identity,'deploymentId',b.deployment_id,'enabled',b.enabled) order by b.operation),'[]'::jsonb) from fluid_private.api_strategy_bindings b where b.owner_id=a.owner_id),
 'paidApiPaused',fluid_private.api_text_paid_paused(a.owner_id)
) as activation_preflight from a;
select 'fluid_api_text_worker' as role_name,
 has_database_privilege('fluid_api_text_worker','postgres','TEMPORARY') as inherited_database_temporary,
 (select jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text) from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=(select oid from pg_roles where rolname='fluid_api_text_worker') and a.privilege_type='EXECUTE') as direct_execute_inventory;
commit;
