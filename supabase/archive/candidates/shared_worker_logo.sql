-- UNAPPLIED shared Logo gateway. Fixed operator-installed slots only. No role,
-- credential, Auth actor, provider request or historical authority is created.
-- Requires the reviewed Logo Storage/local concept/refinement packets + core.
begin;
do $$declare signature text; expected text; begin
 for signature,expected in values
 ('fluid_private.logo_worker_owner()','28c3876cb1de6b2adf58ba12b6ecec2c'),
 ('fluid_private.logo_lock_job(uuid,uuid)','1c9e46b5e25a358e000f02a0bb88dfbb'),
 ('fluid_private.logo_job_ready(public.jobs,text)','b9b501ad50a9931f9d8570d533cb6572'),
 ('fluid_private.lock_logo_job_readiness(public.jobs,text)','149b6bdb9252197d4644b513176082f3'),
 ('fluid_private.logo_local_context_allowed(uuid,uuid)','30e96504426807c2e2e9f5c326a6ff36'),
 ('fluid_private.logo_local_job_allowed(uuid,text)','2efa081fe0dc1ee5a3fe502830148ec6'),
 ('fluid_private.logo_operation_ready(uuid,text)','6f642f35d966e16974ec3442e61a6e64'),
 ('public.claim_logo_job(text,integer)','9f9df81497f1c23ef25697a89fa9de2e'),
 ('public.begin_logo_job_step(uuid,uuid,text,text,bigint)','9320f56ac28171cb2d52b9a633ef28a9'),
 ('public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)','a638f170315481412f111e4b11ba961d') loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(signature) and proowner=to_regrole('postgres')::oid
    and proconfig=array['search_path=""'] and not proleakproof and md5(prosrc)=expected) then
   raise exception 'shared_logo_predecessor_mismatch: %',signature using errcode='55000'; end if;
 end loop;
end $$;
create table fluid_private.shared_logo_admission_context (
 backend_pid integer not null,transaction_id bigint not null,owner_id uuid not null,project_id uuid not null,
 primary key(backend_pid,transaction_id)
);
create table fluid_private.shared_logo_output_observations (
 execution_id uuid not null references fluid_private.shared_worker_executions(execution_id),reservation_id uuid not null references public.logo_asset_publications(id),
 verification jsonb not null,observed_at timestamptz not null default clock_timestamp(),primary key(execution_id,reservation_id)
);
create trigger shared_logo_output_observation_immutable before update or delete on fluid_private.shared_logo_output_observations
 for each row execute function fluid_private.shared_job_admission_immutable();

-- Clone reviewed predecessors privately; replacing their public-name bodies
-- below preserves original OIDs/ACLs and every nonshared branch.
do $$declare signature text; alias text; definition text; begin
 for signature,alias in values
 ('fluid_private.logo_worker_owner()','shared_logo_legacy_owner'),
 ('fluid_private.logo_lock_job(uuid,uuid)','shared_logo_legacy_lock_job'),
 ('fluid_private.logo_job_ready(public.jobs,text)','shared_logo_legacy_job_ready'),
 ('fluid_private.lock_logo_job_readiness(public.jobs,text)','shared_logo_legacy_lock_readiness'),
 ('fluid_private.logo_local_context_allowed(uuid,uuid)','shared_logo_legacy_local_context'),
 ('fluid_private.logo_local_job_allowed(uuid,text)','shared_logo_legacy_local_job'),
 ('fluid_private.logo_operation_ready(uuid,text)','shared_logo_legacy_operation_ready') loop
  definition:=pg_get_functiondef(to_regprocedure(signature));
  execute replace(definition,split_part(signature,'(',1)||'(','fluid_private.'||alias||'(');
 end loop;
end $$;
create function fluid_private.shared_logo_storage_ready(p_slot uuid) returns boolean
language plpgsql volatile set search_path='' as $$declare ready boolean; begin
 if to_regprocedure('fluid_private.shared_storage_slot_ready(uuid)') is null then return false; end if;
 execute 'select fluid_private.shared_storage_slot_ready($1)' into ready using p_slot; return coalesce(ready,false);
end $$;
-- Finite descriptor qualification. Future API text profiles are validated by the
-- separately reviewed advanced packet; its absence is closed, never a fallback.
create function fluid_private.shared_logo_policy_valid(p_operation text,p jsonb) returns boolean
language plpgsql stable set search_path='' as $$declare qualified boolean; begin
 if p->>'operation' is distinct from p_operation or jsonb_typeof(p->'policyIdentity') is distinct from 'string' or p->>'policyIdentity'!~'^[a-f0-9]{64}$' then return false; end if;
 if p->>'spendControl'='uncapped' then
  if to_regprocedure('fluid_private.shared_logo_advanced_policy_valid(text,jsonb)') is null then return false; end if;
  execute 'select fluid_private.shared_logo_advanced_policy_valid($1,$2)' into qualified using p_operation,p;
  return coalesce(qualified,false);
 end if;
 if not fluid_private.standalone_keys(p,array['operation','policyIdentity','handlerVersion','provider','model','engine','maxCostMicrousd'])
  or jsonb_typeof(p->'maxCostMicrousd') is distinct from 'number' or (p->>'maxCostMicrousd')::numeric not between 0 and 9007199254740991
  or trunc((p->>'maxCostMicrousd')::numeric)<>(p->>'maxCostMicrousd')::numeric then return false; end if;
 if p_operation in('identity.logo_concept','identity.logo_refine') then
  return p->>'handlerVersion'='logo-image-v1' and p->>'provider'='openai' and p->>'model'='gpt-image-2.5-sunburst-2026-09-08' and p->'engine'='null'::jsonb;
 elsif p_operation='identity.logo_vectorize' then
  return p->>'handlerVersion'='1' and p->'provider'='null'::jsonb and p->'model'='null'::jsonb and p->'maxCostMicrousd'='0'::jsonb
   and fluid_private.standalone_keys(p->'engine',array['id','version','artifactHash']) and p#>>'{engine,id}'='vtracer'
   and fluid_private.standalone_text(p#>'{engine,version}',200,1) and p#>>'{engine,artifactHash}'~'^[a-f0-9]{64}$';
 elsif p_operation='identity.logo_export' then
  return p->>'handlerVersion'='logo-export-v1' and p->'provider'='null'::jsonb and p->'model'='null'::jsonb and p->'engine'='null'::jsonb and p->'maxCostMicrousd'='0'::jsonb;
 end if;
 return false;
exception when others then return false;
end $$;
create function fluid_private.shared_logo_storage_policy_matches(j public.jobs,approved jsonb) returns boolean
language plpgsql stable set search_path='' as $$declare p fluid_private.logo_runtime_policies; qualified boolean; begin
 if not fluid_private.shared_logo_policy_valid(j.operation,approved) or j.input->>'policyIdentity' is distinct from approved->>'policyIdentity'
  or j.input->>'handlerVersion' is distinct from approved->>'handlerVersion' then return false; end if;
 if j.input->'version'='3'::jsonb and j.input->>'spendControl'='uncapped' then
  if to_regprocedure('fluid_private.shared_logo_advanced_job_matches(public.jobs,jsonb)') is null then return false; end if;
  execute 'select fluid_private.shared_logo_advanced_job_matches($1,$2)' into qualified using j,approved; return coalesce(qualified,false);
 end if;
 select * into p from fluid_private.logo_runtime_policies where owner_id=j.owner_id and operation=j.operation and enabled;
 return found and fluid_private.logo_policy_descriptor(p)=approved and fluid_private.logo_job_policy_matches(j,p);
exception when others then return false;
end $$;
create function fluid_private.shared_logo_storage_policy(j public.jobs) returns jsonb
language sql stable set search_path='' as $$
 select a.policy from fluid_private.shared_job_admissions a where (a.job_id,a.owner_id,a.project_id,a.operation,a.input_hash,a.policy_identity,a.lane)
  =(j.id,j.owner_id,j.project_id,j.operation,j.input_hash,j.input->>'policyIdentity','logo'::text)
  and fluid_private.shared_logo_storage_policy_matches(j,a.policy);
$$;
create function fluid_private.shared_logo_storage_member(j public.jobs,r public.logo_asset_publications,p_mode text) returns jsonb
language plpgsql stable set search_path='' as $$declare member text; value jsonb; q public.logo_cost_quotes; base jsonb; ref jsonb; begin
 if j.id is null or r.id is null or p_mode not in('read','write') or r.owner_id is distinct from j.owner_id or r.project_id is distinct from j.project_id then return null; end if;
 if j.operation in('identity.logo_concept','identity.logo_refine') then
  member:=fluid_private.logo_generative_storage_member(j,r,p_mode);
  if member in('reference','base','output') then return jsonb_build_object('member',member); end if;
 elsif j.operation in('identity.logo_vectorize','identity.logo_export') then
  member:=fluid_private.logo_production_storage_member(j,r,p_mode);
  if member is null then return null; end if;
  return jsonb_build_object('member',case when p_mode='write' then 'output' when member='logo-document' then 'logo-document' else 'source' end);
 elsif j.operation='identity.logo_directions' and p_mode='read' then
  if to_regprocedure('fluid_private.shared_logo_direction_storage_member(public.jobs,public.logo_asset_publications)') is not null then
   execute 'select fluid_private.shared_logo_direction_storage_member($1,$2)' into value using j,r;
  elsif to_regprocedure('fluid_private.logo_directions_storage_member(public.jobs,public.logo_asset_publications)') is not null then
   execute 'select fluid_private.logo_directions_storage_member($1,$2)' into value using j,r;
  else return null; end if;
  if value->>'kind'='logo-document' then return jsonb_build_object('member','logo-document');
  elsif value->>'kind'='font' and value->'font' is not null then return jsonb_build_object('member','font','font',value->'font'); end if;
 elsif j.operation='identity.logo_vector_propose' and p_mode='read' then
  -- The only proposal byte source is the exact frozen base vector document.
  -- Same-project assets, previews, SVG and fonts are not a generic read fallback.
  select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id and operation=j.operation and input_revisions is not null;
  base:=q.source_inputs->'baseRevision'; ref:=fluid_private.logo_asset_reservation(r)->'reference';
  if base is null or base->>'id' is distinct from j.input->>'baseVectorRevisionId' or base->'documentAsset' is distinct from ref
   or base->>'documentHash' is distinct from r.content_hash or base#>>'{proof,documentHash}' is distinct from r.content_hash
   or not fluid_private.logo_vector_proof_valid(base->'proof') or r.state<>'committed' or r.purpose<>'brand_asset' or r.mime_type<>'application/json'
   or r.source_kind<>'vector' or r.rights_evidence_id is not null or r.byte_length not between 1 and 8388608
   or r.verification->>'status' is distinct from 'verified' or r.verification->>'contentHash' is distinct from r.content_hash
   or r.verification->>'mimeType' is distinct from r.mime_type or r.verification->'byteLength' is distinct from to_jsonb(r.byte_length)
   or not exists(select 1 from public.asset_versions v join public.assets a on(a.id,a.owner_id,a.project_id)=(v.asset_id,v.owner_id,v.project_id)
    where(v.id,v.asset_id,v.owner_id,v.project_id,v.content_hash,v.mime_type)=(r.version_id,r.asset_id,r.owner_id,r.project_id,r.content_hash,r.mime_type)
     and v.storage_path=r.owner_id::text||'/'||r.project_id::text||'/'||r.asset_id::text||'/'||r.version_id::text
     and v.provenance->>'publicationId'=r.id::text and a.purpose=r.purpose and a.kind='logo_vector') then return null; end if;
  return jsonb_build_object('member','logo-document');
 end if;
 return null;
end $$;
create function fluid_private.shared_logo_runtime_ready(p_slot uuid,p_operation text) returns boolean
language plpgsql volatile set search_path='' as $$declare ready boolean; begin
 if to_regprocedure('fluid_private.shared_logo_slot_runtime_ready(uuid)') is null then return p_operation in('identity.logo_concept','identity.logo_refine');end if;
 execute 'select fluid_private.shared_logo_slot_runtime_ready($1)' into ready using p_slot;return coalesce(ready,false);
end $$;
create function fluid_private.shared_logo_project_clear(p_owner uuid,p_project uuid) returns boolean
language sql stable set search_path='' as $$select not exists(select 1 from public.jobs j where j.owner_id=p_owner and j.project_id=p_project
 and j.operation in('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose')
 and(j.state='needs_reconciliation' or exists(select 1 from public.job_steps s where s.job_id=j.id and s.state='ambiguous')));$$;
create function fluid_private.shared_logo_policy(p_owner uuid,p_operation text) returns jsonb
language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('policy',p.policy,'deploymentId',s.deployment_id,'policyIdentity',p.policy_identity,'expiresAt',s.expires_at)
 from fluid_private.shared_worker_slots s join fluid_private.shared_worker_policies p using(slot_id)
 where s.lane='logo' and s.enabled and s.expires_at>clock_timestamp() and s.instance_id is not null
  and p.operation=p_operation and p_operation in('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose') and fluid_private.shared_logo_policy_valid(p_operation,p.policy)
  and fluid_private.shared_worker_role_safe(s.role_name,s.role_oid)
  and fluid_private.shared_account_customer_active(p_owner) and fluid_private.shared_logo_storage_ready(s.slot_id) and fluid_private.shared_logo_runtime_ready(s.slot_id,p_operation)
 order by s.slot_index limit 1;
$$;
create function fluid_private.shared_logo_context_allowed(p_owner uuid,p_project uuid default null) returns boolean
language sql volatile set search_path='' as $$
 select fluid_private.shared_account_customer_active(p_owner) and exists(select 1 from fluid_private.shared_logo_admission_context c
 where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.owner_id=p_owner and (p_project is null or c.project_id=p_project)
 and fluid_private.shared_logo_project_clear(c.owner_id,c.project_id));
$$;
create function fluid_private.shared_logo_job_context(p_job uuid) returns boolean
language sql stable set search_path='' as $$
 select p_job=fluid_private.shared_worker_context_job('logo') and exists(select 1 from fluid_private.shared_job_admissions a
 join public.jobs j on (j.id,j.owner_id,j.project_id,j.operation,j.input_hash)=(a.job_id,a.owner_id,a.project_id,a.operation,a.input_hash)
 where a.job_id=p_job and a.lane='logo' and a.operation in('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose')
 and j.input->>'policyIdentity'=a.policy_identity);
$$;
create function fluid_private.shared_logo_json_arg(p_args jsonb,p_index integer) returns jsonb
language sql immutable set search_path='' as $$
 select case when jsonb_typeof(p_args->p_index)='string' then (p_args->>p_index)::jsonb else p_args->p_index end;
$$;
create or replace function fluid_private.logo_worker_owner() returns uuid language sql stable security definer set search_path='' as $$
 select case when exists(select 1 from fluid_private.shared_worker_slots where role_name=session_user)
 then fluid_private.shared_worker_context_owner('logo') else fluid_private.shared_logo_legacy_owner() end;
$$;
create or replace function fluid_private.logo_local_context_allowed(p_owner uuid,p_project uuid default null) returns boolean
language sql stable set search_path='' as $$
 select fluid_private.shared_logo_context_allowed(p_owner,p_project) or fluid_private.shared_logo_legacy_local_context(p_owner,p_project);
$$;
create or replace function fluid_private.logo_local_job_allowed(p_job uuid,p_worker text default null) returns boolean
language sql stable set search_path='' as $$
 select fluid_private.shared_logo_job_context(p_job) or fluid_private.shared_logo_legacy_local_job(p_job,p_worker);
$$;
create or replace function fluid_private.logo_operation_ready(p_owner uuid,p_operation text) returns boolean
language sql volatile set search_path='' as $$
 select (fluid_private.shared_logo_context_allowed(p_owner) and fluid_private.shared_logo_policy(p_owner,p_operation) is not null)
 or fluid_private.shared_logo_legacy_operation_ready(p_owner,p_operation);
$$;
create or replace function fluid_private.logo_job_ready(j public.jobs,p_worker text) returns boolean
language sql volatile set search_path='' as $$
 select case when exists(select 1 from fluid_private.shared_worker_slots where role_name=session_user) then
 fluid_private.shared_logo_job_context(j.id) and fluid_private.shared_worker_context_mode('logo') in('claim','active')
 and exists(select 1 from fluid_private.shared_job_admissions a join fluid_private.shared_worker_gateway_context c on c.job_id=a.job_id
  join fluid_private.shared_worker_policies p on p.slot_id=c.slot_id and p.operation=a.operation and p.policy_identity=a.policy_identity and p.policy=a.policy
  where a.job_id=j.id and c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.role_name=session_user
   and fluid_private.shared_logo_storage_policy_matches(j,p.policy))
 else fluid_private.shared_logo_legacy_job_ready(j,p_worker) end;
$$;
create or replace function fluid_private.lock_logo_job_readiness(j public.jobs,p_worker text) returns boolean
language plpgsql set search_path='' as $$begin
 if exists(select 1 from fluid_private.shared_worker_slots where role_name=session_user) then
  perform 1 from fluid_private.logo_runtime_policies where owner_id=j.owner_id and operation=j.operation for share;
  return fluid_private.logo_job_ready(j,p_worker);
 end if;
 return fluid_private.shared_logo_legacy_lock_readiness(j,p_worker);
end $$;
create or replace function fluid_private.logo_lock_job(p_job uuid,p_lease uuid) returns public.jobs
language plpgsql set search_path='' as $$declare e fluid_private.shared_worker_executions; j public.jobs; begin
 if fluid_private.shared_worker_context_mode('logo')='observe' then
  e:=fluid_private.shared_worker_context_execution('logo');
  if e.job_id is distinct from p_job or e.lease_token is distinct from p_lease then raise exception 'shared_logo_observation_denied' using errcode='42501'; end if;
  select * into j from public.jobs where id=e.job_id and owner_id=e.owner_id and project_id=e.project_id for update;
  if not found or j.lease_token is not null and j.lease_token<>e.lease_token then raise exception 'shared_logo_observation_denied' using errcode='42501'; end if;
  return j;
 end if;
 if fluid_private.shared_worker_context_mode('logo')='active' then
  e:=fluid_private.shared_worker_context_execution('logo');
  if e.job_id is distinct from p_job or e.lease_token is distinct from p_lease
   or e.operation not in('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose')
  then raise exception 'shared_logo_active_scope_denied' using errcode='42501';end if;
  select * into j from public.jobs where id=e.job_id and(owner_id,project_id,operation)=(e.owner_id,e.project_id,e.operation) for update;
  if not found or j.lease_token is distinct from p_lease or p_lease is null or j.lease_expires_at<=clock_timestamp()
   or j.state not in('running','cancel_requested') then raise exception 'lease_lost' using errcode='40001';end if;
  return j;
 end if;
 return fluid_private.shared_logo_legacy_lock_job(p_job,p_lease);
end $$;

create function public.shared_logo_operation(p_project_id uuid,p_kind text,p_input jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid(); profile jsonb; descriptor jsonb; op text; result jsonb; q public.logo_cost_quotes; j public.jobs; old fluid_private.logo_runtime_policies;
 observed timestamptz:=date_trunc('milliseconds',clock_timestamp()); ready_until timestamptz; statuses jsonb:='{}';
begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=o) then raise exception 'logo_project_not_found' using errcode='P0002'; end if;
 if p_kind is null or p_kind not in('capabilities','quote','admit','export') then raise exception 'invalid_shared_logo_action' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(o::text,723902));
 -- Original receipts keep their original request body and authority class.
 if p_kind='admit' and fluid_private.logo_uuid(p_input->'requestKey') and (
  exists(select 1 from public.logo_operation_requests where owner_id=o and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid)
  or exists(select 1 from public.logo_operation_rejections where owner_id=o and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid)) then
  select * into q from public.logo_cost_quotes where id=(p_input->>'quoteId')::uuid and owner_id=o and project_id=p_project_id;
  if q.record->'version'='3'::jsonb and to_regprocedure('fluid_private.shared_logo_admit_advanced(uuid,jsonb)') is not null then
   execute 'select fluid_private.shared_logo_admit_advanced($1,$2)' into result using p_project_id,p_input;return result;end if;
  return public.admit_logo_operation(p_project_id,case when p_input?'acceptedMaxCostMicrousd' then p_input else p_input||jsonb_build_object('acceptedMaxCostMicrousd',(q.record->>'maxCostMicrousd')::bigint) end);
 end if;
 if p_kind='export' and fluid_private.logo_uuid(p_input->'requestKey') and(
  exists(select 1 from public.logo_operation_requests where owner_id=o and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid)
  or exists(select 1 from public.logo_operation_rejections where owner_id=o and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid)) then return public.request_logo_export(p_project_id,p_input);end if;
 if not fluid_private.shared_account_customer_active(o) or not fluid_private.shared_logo_project_clear(o,p_project_id) then raise exception 'shared_logo_unavailable' using errcode='55000'; end if;
 if p_kind='capabilities' then
  -- A read projects only supported shared operations; it never installs owner
  -- policy metadata or borrows the legacy per-owner heartbeat projection.
  foreach op in array array['identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose'] loop
   profile:=fluid_private.shared_logo_policy(o,op);
   ready_until:=case when profile is not null then least((profile->>'expiresAt')::timestamptz,observed+interval '30 seconds') else null end;
   statuses:=statuses||jsonb_build_object(op,case when ready_until>clock_timestamp() then jsonb_build_object('status','available','expiresAt',to_char(ready_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) else jsonb_build_object('status','unavailable') end);
  end loop;
  return jsonb_build_object('ownerId',o,'projectId',p_project_id,'observedAt',to_char(observed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'operations',statuses);
 end if;
 for op in select unnest(array['identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose']) loop
  profile:=fluid_private.shared_logo_policy(o,op);
  if profile is null then continue; end if; descriptor:=profile->'policy';
  if not fluid_private.shared_logo_policy_valid(op,descriptor) then raise exception 'shared_logo_policy_invalid' using errcode='55000'; end if;
  -- Future uncapped text profiles use independent shared authority, never the
  -- historical capped/subscription runtime-policy relation.
  if descriptor->>'spendControl'='uncapped' then continue; end if;
  select * into old from fluid_private.logo_runtime_policies where owner_id=o and operation=op;
  if found then
   if fluid_private.logo_policy_descriptor(old) is distinct from descriptor then raise exception 'shared_logo_policy_conflict' using errcode='55000'; end if;
  else
   insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,engine,max_cost_microusd,enabled)
   values(o,op,descriptor->>'policyIdentity',descriptor->>'handlerVersion',descriptor->>'provider',descriptor->>'model',nullif(descriptor->'engine','null'),(descriptor->>'maxCostMicrousd')::bigint,true);
  end if;
 end loop;
 insert into fluid_private.shared_logo_admission_context values(pg_backend_pid(),txid_current(),o,p_project_id);
 if p_kind='export' then
  profile:=fluid_private.shared_logo_policy(o,'identity.logo_export');if profile is null then raise exception 'shared_logo_policy_unavailable' using errcode='55000';end if;
  insert into public.usage_accounts(owner_id,limit_microusd) values(o,0) on conflict(owner_id) do nothing;
  result:=public.request_logo_export(p_project_id,p_input);
  for j in select jobs.* from public.jobs jobs where id in(select(value#>>'{}')::uuid from jsonb_array_elements(result->'jobIds')) loop
   perform fluid_private.admit_shared_worker_job(j.id,'logo',profile->>'policyIdentity',profile->>'deploymentId',profile->'policy');end loop;
 elsif p_kind='quote' then
  if p_input->>'operation' is null or p_input->>'operation' not in('concepts','more_concepts','retry_failed','refine_preview','vectorize','directions') then raise exception 'shared_logo_operation_unsupported' using errcode='55000'; end if;
  if p_input->>'operation'='directions' then
   if to_regprocedure('fluid_private.shared_logo_quote_directions(uuid,jsonb)') is null then raise exception 'shared_logo_advanced_unavailable' using errcode='55000';end if;
   execute 'select fluid_private.shared_logo_quote_directions($1,$2)' into result using p_project_id,p_input;
  else result:=public.quote_logo_operation(p_project_id,p_input);end if;
 else
  select * into q from public.logo_cost_quotes where id=(p_input->>'quoteId')::uuid and owner_id=o and project_id=p_project_id;
  if not found or not(q.operation in('identity.logo_concept','identity.logo_vectorize','identity.logo_directions','identity.logo_vector_propose') or q.operation='identity.logo_refine' and q.record#>>'{request,operation}'='refine_preview') then raise exception 'shared_logo_quote_unavailable' using errcode='55000'; end if;
  profile:=fluid_private.shared_logo_policy(o,q.operation);
  if profile is null or q.record->>'policyIdentity' is distinct from profile->>'policyIdentity' then raise exception 'shared_logo_policy_changed' using errcode='55000'; end if;
  if q.record->'version'='3'::jsonb then
   if to_regprocedure('fluid_private.shared_logo_admit_advanced(uuid,jsonb)') is null then raise exception 'shared_logo_advanced_unavailable' using errcode='55000';end if;
   execute 'select fluid_private.shared_logo_admit_advanced($1,$2)' into result using p_project_id,p_input;
  else
  -- Bookkeeping only: never fund a ledger or rewrite an existing allowance.
  insert into public.usage_accounts(owner_id,limit_microusd) values(o,0) on conflict(owner_id) do nothing;
  if q.operation='identity.logo_vectorize' then
   if to_regprocedure('fluid_private.shared_logo_admit_vector(uuid,jsonb)') is null then raise exception 'shared_logo_advanced_unavailable' using errcode='55000';end if;
   execute 'select fluid_private.shared_logo_admit_vector($1,$2)' into result using p_project_id,p_input||jsonb_build_object('acceptedMaxCostMicrousd',0);
  else result:=public.admit_logo_operation(p_project_id,p_input||jsonb_build_object('acceptedMaxCostMicrousd',(q.record->>'maxCostMicrousd')::bigint));end if;
  for j in select jobs.* from public.jobs jobs where id in(select (value#>>'{}')::uuid from jsonb_array_elements(result->'jobIds')) loop
   perform fluid_private.admit_shared_worker_job(j.id,'logo',profile->>'policyIdentity',profile->>'deploymentId',profile->'policy');
  end loop;
  end if;
 end if;
 delete from fluid_private.shared_logo_admission_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
 return result;
end $$;

create function public.shared_logo_worker_action(p_slot jsonb,p_execution jsonb,p_action text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots; e fluid_private.shared_worker_executions; j public.jobs; result jsonb; mode text;
 r public.logo_asset_publications; v jsonb; previous fluid_private.shared_logo_output_observations; known_state text; login_oid oid;
begin
 if jsonb_typeof(p_args) is distinct from 'array' or octet_length(p_args::text)>2097152 or p_action is null then raise exception 'invalid_shared_logo_action' using errcode='22023'; end if;
 if p_action='runtime_ready' then
  if p_execution is not null or jsonb_array_length(p_args)<>1 or to_regprocedure('fluid_private.shared_logo_report_runtime_ready(jsonb,jsonb)') is null then raise exception 'shared_logo_runtime_ready_unavailable' using errcode='55000';end if;
  execute 'select to_jsonb(fluid_private.shared_logo_report_runtime_ready($1,$2))' into result using p_slot,p_args->0;
  return jsonb_build_object('execution',null,'result',result);
 end if;
 if p_action='claim' then
  if p_execution is not null or jsonb_array_length(p_args)<>2 then raise exception 'invalid_shared_logo_claim' using errcode='22023'; end if;
  s:=fluid_private.lock_shared_worker_slot(p_slot,true); if s.lane<>'logo' then raise exception 'shared_logo_slot_required' using errcode='42501'; end if;
  select jobs.* into j from public.jobs jobs join fluid_private.shared_job_admissions a on a.job_id=jobs.id and a.lane='logo'
   where jobs.operation in('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose') and jobs.state='queued' and fluid_private.shared_worker_claimable(p_slot,jobs.id)
   order by jobs.created_at,jobs.id for update of jobs skip locked limit 1;
  if not found then return jsonb_build_object('execution',null,'result','[]'::jsonb); end if;
  perform fluid_private.enter_shared_worker_claim_context(p_slot,j.id);
  if j.input->'version'='3'::jsonb and j.input->>'spendControl'='uncapped' then
   if to_regprocedure('fluid_private.shared_logo_claim_job(uuid,text,integer)') is null then raise exception 'shared_logo_advanced_unavailable' using errcode='55000'; end if;
   execute 'select * from fluid_private.shared_logo_claim_job($1,$2,$3)' into j using j.id,p_args->>0,(p_args->>1)::integer;
  else select * into j from public.claim_logo_job(p_args->>0,(p_args->>1)::integer); end if;
  if j.id is null then perform fluid_private.leave_shared_worker_context(); return jsonb_build_object('execution',null,'result','[]'::jsonb); end if;
  e:=fluid_private.bind_shared_worker_execution(p_slot,j.id);
  perform fluid_private.leave_shared_worker_context();
  return jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'result',jsonb_build_array(to_jsonb(j)));
 end if;
 -- Terminal readback never reopens the core's closed mutation boundary. This
 -- handles a committed finish whose acknowledgement was lost.
 if p_action='recovery' and p_args='[]'::jsonb then
  select * into e from fluid_private.shared_worker_executions where execution_id=(p_execution->>'executionId')::uuid and state='closed';
  if found then
   select * into s from fluid_private.shared_worker_slots where slot_id=e.slot_id;
   select oid into login_oid from pg_roles where rolname=session_user;
   select * into j from public.jobs where id=e.job_id;
   if fluid_private.shared_worker_execution_json(e) is distinct from p_execution or e.lane<>'logo' or p_slot->'version' is distinct from '1'::jsonb
    or (s.role_name,s.role_oid) is distinct from(session_user::name,login_oid) or not fluid_private.shared_worker_role_safe(session_user,login_oid)
    or (p_slot->>'slotId')::uuid is distinct from s.slot_id or p_slot->>'lane' is distinct from 'logo'
    or p_slot->>'roleName' is distinct from s.role_name::text or (p_slot->>'roleOid')::oid is distinct from s.role_oid
    or not coalesce((((p_slot->>'instanceId')::uuid,(p_slot->>'generation')::bigint,(p_slot->>'leaseToken')::uuid)=(s.instance_id,s.generation,s.lease_token)
     or ((p_slot->>'instanceId')::uuid,(p_slot->>'generation')::bigint,(p_slot->>'leaseToken')::uuid)=(e.instance_id,e.generation,e.slot_lease_token)),false)
    or (j.owner_id,j.project_id,j.operation) is distinct from(e.owner_id,e.project_id,e.operation)
    or not exists(select 1 from fluid_private.shared_job_admissions a where a.job_id=j.id and (a.owner_id,a.project_id,a.lane,a.operation,a.input_hash,a.policy_identity,a.deployment_id)
     =(e.owner_id,e.project_id,'logo'::text,e.operation,j.input_hash,e.policy_identity,e.deployment_id))
    or j.state not in('succeeded','failed','cancelled','partial') or j.lease_token is not null
    or exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then raise exception 'shared_logo_terminal_unverified' using errcode='42501'; end if;
   return jsonb_build_object('execution',p_execution,'result',jsonb_build_object('observationJob',to_jsonb(j),'observationLeaseToken',e.lease_token,'outputs','[]'::jsonb,'executionClosed',true,'remaining',false,'capability',(select policy from fluid_private.shared_job_admissions where job_id=j.id)));
  end if;
 end if;
 mode:=case when p_action in('heartbeat','complete','finish','receipt','observe_asset','has_results','recovery','observe_recovered_asset','finish_known','stage_proposal','stage_directions') then 'observe' else 'active' end;
 if p_action='read' and p_args->>2='vector_proposal_evidence_inputs' then mode:='observe';end if;
 if p_action='heartbeat' then
  begin perform fluid_private.shared_worker_execution(p_slot,p_execution,'active'); mode:='active';
  exception when insufficient_privilege then mode:='observe'; end;
 end if;
 e:=fluid_private.shared_worker_execution(p_slot,p_execution,mode);
 if e.lane<>'logo' or e.operation not in('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose') then raise exception 'shared_logo_execution_required' using errcode='42501'; end if;
 if p_action in('assert_continue','recovery','finish_known') then
  if p_args<>'[]'::jsonb then raise exception 'invalid_shared_logo_args' using errcode='22023'; end if;
 elsif p_action='observe_recovered_asset' then
  if jsonb_array_length(p_args)<>3 or (p_args->>0)::uuid is distinct from e.lease_token then raise exception 'shared_logo_args_mismatch' using errcode='42501'; end if;
 else
  if p_action in('prepare_asset','read_asset','observe_asset') then
   if jsonb_array_length(p_args)<>4 or (p_args->>2)::uuid is distinct from e.job_id or (p_args->>3)::uuid is distinct from e.lease_token
    or p_action<>'observe_asset' and (p_args->>0)::uuid is distinct from e.project_id then raise exception 'shared_logo_args_mismatch' using errcode='42501'; end if;
  elsif (p_args->>0)::uuid is distinct from e.job_id or (p_args->>1)::uuid is distinct from e.lease_token then raise exception 'shared_logo_args_mismatch' using errcode='42501'; end if;
 end if;
 if p_action in('direction_inputs','stage_directions') and e.operation<>'identity.logo_directions'
  or p_action in('export_inputs','stage_exports') and e.operation<>'identity.logo_export'
  or p_action in('stage_vector','read_vector') and e.operation<>'identity.logo_vectorize'
  or p_action='stage_proposal' and e.operation<>'identity.logo_vector_propose' then
  raise exception 'shared_logo_operation_action_denied' using errcode='42501'; end if;
 if p_action='read' and (p_args->>2 is null or p_args->>2 not in('concept_inputs','refinement_inputs','vector_input','input_revisions','vector_proposal_inputs','vector_proposal_evidence_inputs','runtime_readiness','step_output','step_asset','has_results')
  or p_args->>2='concept_inputs' and e.operation<>'identity.logo_concept'
  or p_args->>2 in('refinement_inputs','step_asset') and e.operation<>'identity.logo_refine'
  or p_args->>2='vector_input' and e.operation<>'identity.logo_vectorize'
  or p_args->>2 in('vector_proposal_inputs','vector_proposal_evidence_inputs') and e.operation<>'identity.logo_vector_propose') then
  raise exception 'shared_logo_read_denied' using errcode='42501'; end if;
 perform fluid_private.enter_shared_worker_context(p_slot,p_execution,mode);
 select * into j from public.jobs where id=e.job_id;
 if j.input->'version'='3'::jsonb and j.input->>'spendControl'='uncapped'
  and p_action not in('assert_continue','heartbeat','has_results','recovery','observe_recovered_asset','finish_known','prepare_asset','read_asset','observe_asset') then
  if to_regprocedure('fluid_private.shared_logo_advanced_action(uuid,uuid,text,jsonb)') is null then raise exception 'shared_logo_advanced_unavailable' using errcode='55000'; end if;
  execute 'select fluid_private.shared_logo_advanced_action($1,$2,$3,$4)' into result using e.job_id,e.lease_token,p_action,p_args;
 elsif p_action='assert_continue' then result:='true'::jsonb;
 elsif p_action='recovery' then
  select * into j from public.jobs where id=e.job_id;
  select coalesce(jsonb_agg(jsonb_build_object('reservation',fluid_private.logo_asset_reservation(p),'publication',p.request->'publication') order by p.id),'[]'::jsonb) into result
   from (select candidate.* from public.logo_asset_publications candidate where candidate.job_id=e.job_id and candidate.owner_id=e.owner_id and candidate.project_id=e.project_id
    and candidate.lease_token=e.lease_token and candidate.state in('reserved','staged')
    and not exists(select 1 from fluid_private.shared_logo_output_observations observed where observed.execution_id=e.execution_id and observed.reservation_id=candidate.id)
    and exists(select 1 from fluid_private.shared_storage_grants issued where issued.execution_id=e.execution_id and issued.reservation_id=candidate.id and issued.mode='write'
     and issued.binding->'execution'=fluid_private.shared_worker_execution_json(e)) order by candidate.id limit 3) p;
  result:=jsonb_build_object('observationJob',to_jsonb(j),'observationLeaseToken',e.lease_token,'outputs',result,'executionClosed',false,'capability',(select policy from fluid_private.shared_job_admissions where job_id=j.id),'remaining',exists(
   select 1 from public.logo_asset_publications candidate where candidate.job_id=e.job_id and candidate.owner_id=e.owner_id and candidate.project_id=e.project_id
    and candidate.lease_token=e.lease_token and candidate.state in('reserved','staged')
    and not exists(select 1 from fluid_private.shared_logo_output_observations observed where observed.execution_id=e.execution_id and observed.reservation_id=candidate.id)
    and exists(select 1 from fluid_private.shared_storage_grants issued where issued.execution_id=e.execution_id and issued.reservation_id=candidate.id and issued.mode='write'
     and issued.binding->'execution'=fluid_private.shared_worker_execution_json(e)) offset 3 limit 1));
 elsif p_action='finish_known' then
  select * into j from public.jobs where id=e.job_id;
  if e.operation='identity.logo_export' and to_regprocedure('fluid_private.shared_logo_resolve_prepared_export()') is not null then
   execute 'select fluid_private.shared_logo_resolve_prepared_export()' into result;
   if result is not null then select * into j from public.jobs where id=e.job_id;known_state:='succeeded';end if;
  end if;
  if known_state='succeeded' and j.state='succeeded' then null;
  elsif exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then known_state:=null;
  elsif j.cancel_requested_at is not null then known_state:='cancelled';
  elsif j.plan_registered_at is not null and jsonb_typeof(j.plan_manifest)='array' and jsonb_array_length(j.plan_manifest)>0
   and not exists(select 1 from jsonb_array_elements(j.plan_manifest) p where not exists(select 1 from public.job_steps step where step.job_id=j.id and step.step_key=p->>'key' and step.state in('succeeded','failed'))) then
   known_state:=case when not exists(select 1 from public.job_steps where job_id=j.id and state<>'succeeded') then 'succeeded'
    when exists(select 1 from public.job_steps where job_id=j.id and state='succeeded') then 'partial' else 'failed' end;
  end if;
  if known_state is null then result:=jsonb_build_object('status','retained_unknown');
  else if j.state is distinct from known_state then perform public.finish_logo_job(e.job_id,e.lease_token,known_state);end if;result:=jsonb_build_object('status','terminal','state',known_state); end if;
 elsif p_action='observe_recovered_asset' then
  select * into r from public.logo_asset_publications where id=(p_args->>1)::uuid and job_id=e.job_id and owner_id=e.owner_id and project_id=e.project_id and lease_token=e.lease_token and state in('reserved','staged') for update;
  v:=fluid_private.shared_logo_json_arg(p_args,2);
  if not found or not exists(select 1 from fluid_private.shared_storage_grants issued where issued.execution_id=e.execution_id and issued.reservation_id=r.id and issued.mode='write'
    and issued.binding->'execution'=fluid_private.shared_worker_execution_json(e))
   or not fluid_private.standalone_keys(v,array['status','checkedAt','contentHash','mimeType','byteLength']) or v->>'status' is distinct from 'verified'
   or not fluid_private.standalone_timestamp(v->'checkedAt') or length(v->>'checkedAt')>64 or v->>'contentHash' is distinct from r.content_hash
   or v->>'mimeType' is distinct from r.mime_type or v->'byteLength' is distinct from to_jsonb(r.byte_length) then raise exception 'shared_logo_recovery_verification_invalid' using errcode='42501'; end if;
  insert into fluid_private.shared_logo_output_observations(execution_id,reservation_id,verification) values(e.execution_id,r.id,v) on conflict do nothing;
  select * into previous from fluid_private.shared_logo_output_observations where execution_id=e.execution_id and reservation_id=r.id;
  if previous.verification-'checkedAt' is distinct from v-'checkedAt' then raise exception 'shared_logo_recovery_verification_conflict' using errcode='42501'; end if;
  if r.state='reserved' then update public.logo_asset_publications set state='staged',verification=previous.verification where id=r.id returning * into r; end if;
  result:=jsonb_build_object('reservationId',r.id,'verification',previous.verification,'status','observed_only','providerOutcome','retained_unknown');
 elsif p_action='heartbeat' and jsonb_array_length(p_args)=3 then
  if mode='active' then select jsonb_build_array(to_jsonb(x)) into result from public.heartbeat_logo_job(e.job_id,e.lease_token,(p_args->>2)::integer) x;
  else select jsonb_build_array(to_jsonb(x)) into result from public.jobs x where id=e.job_id; end if;
 elsif p_action='plan' and jsonb_array_length(p_args)=3 then perform public.register_logo_job_plan(e.job_id,e.lease_token,fluid_private.shared_logo_json_arg(p_args,2)); result:='null'::jsonb;
 elsif p_action='begin' and jsonb_array_length(p_args)=5 then result:=to_jsonb(public.begin_logo_job_step(e.job_id,e.lease_token,p_args->>2,p_args->>3,(p_args->>4)::bigint));
 elsif p_action='complete' and jsonb_array_length(p_args)=7 then perform public.complete_logo_job_step(e.job_id,e.lease_token,p_args->>2,p_args->>3,(p_args->>4)::bigint,fluid_private.shared_logo_json_arg(p_args,5),p_args->>6); result:='null'::jsonb;
 elsif p_action='finish' and jsonb_array_length(p_args)=3 then perform public.finish_logo_job(e.job_id,e.lease_token,p_args->>2); result:='null'::jsonb;
 elsif p_action='direction_inputs' and jsonb_array_length(p_args)=2 then result:=public.load_logo_direction_inputs(e.job_id,e.lease_token);
 elsif p_action='stage_directions' and jsonb_array_length(p_args)=5 then result:=public.stage_logo_directions(e.job_id,e.lease_token,fluid_private.shared_logo_json_arg(p_args,2),(p_args->>3)::uuid,fluid_private.shared_logo_json_arg(p_args,4));
 elsif p_action='export_inputs' and jsonb_array_length(p_args)=2 then result:=public.load_logo_export_inputs(e.job_id,e.lease_token);
 elsif p_action='stage_exports' and jsonb_array_length(p_args)=3 then result:=public.stage_logo_exports(e.job_id,e.lease_token,fluid_private.shared_logo_json_arg(p_args,2));
 elsif p_action='stage_vector' and jsonb_array_length(p_args)=3 then result:=fluid_private.stage_logo_vector_publication(e.job_id,e.lease_token,fluid_private.shared_logo_json_arg(p_args,2));
 elsif p_action='read_vector' and jsonb_array_length(p_args)=3 then result:=fluid_private.read_leased_logo_vector_revision(e.job_id,e.lease_token,(p_args->>2)::uuid);
 elsif p_action='stage_proposal' and jsonb_array_length(p_args)=4 then
  if to_regprocedure('fluid_private.shared_logo_stage_proposal(uuid,uuid,jsonb,uuid)') is null then raise exception 'shared_logo_proposal_unavailable' using errcode='55000'; end if;
  execute 'select fluid_private.shared_logo_stage_proposal($1,$2,$3,$4)' into result using e.job_id,e.lease_token,fluid_private.shared_logo_json_arg(p_args,2),(p_args->>3)::uuid;
 elsif p_action='read' and jsonb_array_length(p_args)=4 then result:=public.read_leased_logo_record(e.job_id,e.lease_token,p_args->>2,fluid_private.shared_logo_json_arg(p_args,3));
 elsif p_action='has_results' and jsonb_array_length(p_args)=2 then result:=public.read_leased_logo_record(e.job_id,e.lease_token,'has_results',null);
 elsif p_action='receipt' and jsonb_array_length(p_args)=3 then result:=public.record_logo_provider_response(e.job_id,e.lease_token,fluid_private.shared_logo_json_arg(p_args,2));
 elsif p_action='prepare_asset' then result:=fluid_private.prepare_logo_asset(e.project_id,fluid_private.shared_logo_json_arg(p_args,1),e.job_id,e.lease_token);
 elsif p_action='read_asset' then
  if e.operation='identity.logo_vector_propose' then
   if to_regprocedure('fluid_private.shared_logo_read_proposal_asset(uuid,jsonb,uuid,uuid)') is null then raise exception 'shared_logo_proposal_unavailable' using errcode='55000';end if;
   execute 'select fluid_private.shared_logo_read_proposal_asset($1,$2,$3,$4)' into result using e.project_id,fluid_private.shared_logo_json_arg(p_args,1),e.job_id,e.lease_token;
  else result:=fluid_private.read_logo_asset_publication(e.project_id,fluid_private.shared_logo_json_arg(p_args,1),e.job_id,e.lease_token);end if;
 elsif p_action='observe_asset' then result:=fluid_private.observe_logo_asset((p_args->>0)::uuid,fluid_private.shared_logo_json_arg(p_args,1),e.job_id,e.lease_token);
 else raise exception 'shared_logo_action_denied' using errcode='42501'; end if;
 perform fluid_private.leave_shared_worker_context();
 select * into j from public.jobs where id=e.job_id;
 if j.state in('succeeded','failed','cancelled','partial') and j.lease_token is null and not exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then
  perform fluid_private.close_shared_worker_execution(p_slot,p_execution);
 elsif j.state='needs_reconciliation' or not fluid_private.shared_worker_admission_active(j.id)
  or j.state in('succeeded','failed','cancelled','partial') and exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then
  perform fluid_private.park_shared_worker_execution(p_slot,p_execution);
 end if;
 return jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'result',result);
end $$;

do $$declare object record; grant_row record; begin
 for object in select c.oid,c.oid::regclass signature from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='fluid_private' and c.relname in('shared_logo_admission_context','shared_logo_output_observations') loop
  execute format('alter table %s enable row level security',object.signature); execute format('alter table %s force row level security',object.signature);
  for grant_row in select distinct a.grantee from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=object.oid and a.grantee<>c.relowner loop
   execute format('revoke all on table %s from %s cascade',object.signature,case when grant_row.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grant_row.grantee)) end);
  end loop;
 end loop;
 for object in select p.oid,p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in('fluid_private','public') and p.proname like 'shared_logo_%' loop
  for grant_row in select distinct a.grantee from pg_proc p,lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object.oid and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object.signature,case when grant_row.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(grant_row.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.shared_logo_operation(uuid,text,jsonb) to authenticated;
commit;
