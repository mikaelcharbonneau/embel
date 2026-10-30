-- Uncapped shared raster generation. Estimates are presentation only; usage is
-- recorded exactly once from retained provider evidence. No funding, credentials,
-- model request, historical job rewrite, or automatic activation occurs here.
begin;

do $$declare signature text;expected text;begin
 if session_user<>'postgres' or current_user<>session_user then raise exception 'raster_uncapped_installer_denied' using errcode='42501';end if;
 for signature,expected in values
 ('fluid_private.shared_logo_advanced_policy_valid(text, jsonb)','1b29359527cb0fba59cdaf5def9f227bc715c1734c1b1262c623dad3925c40ce'),
 ('fluid_private.shared_logo_advanced_quote_binding(public.logo_cost_quotes, jsonb)','f046e4cb48c15616f782f8df430f1f65b0b9525b74bb0a3fe0bce571a69bfaed'),
 ('public.shared_logo_operation(uuid, text, jsonb)','e3d508a2c7c325d36551bf68bebfe198a97be0b0d4d04a42d1a635015257bb08'),
 ('fluid_private.shared_logo_advanced_quote_current(public.logo_cost_quotes, jsonb)','57ef03202ffee3bb8e0d2d69ef71e9549d7d7752d293679478d84bd9486fd0d0'),
 ('fluid_private.shared_logo_admit_advanced(uuid, jsonb)','5216fec1e72fce0b70f24741eea92f1f82afc6d0e473c12cdcfab5ad1ee4a77a'),
 ('fluid_private.shared_logo_advanced_job_matches(public.jobs, jsonb)','e40bd54bb86d7b3909d414287294f0ccb7b322c2789429357ddd6ff9e12cc10c'),
 ('fluid_private.shared_logo_record_response(uuid, uuid, jsonb)','4a9e3a85247c1f54be64b9b6b7c0a783e2fb468073e607988e226f79410eecc7'),
 ('fluid_private.shared_logo_advanced_action(uuid, uuid, text, jsonb)','0296d8c0358ac37b4a9757275027147468d9ccc0d4effba4762eb61e2d6b1a8f') loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(signature) and proowner=to_regrole('postgres')::oid
   and proconfig=array['search_path=""'] and not proleakproof and encode(sha256(convert_to(prosrc,'UTF8')),'hex')=expected)
  then raise exception 'raster_uncapped_predecessor_mismatch: %',signature using errcode='55000';end if;
 end loop;
end $$;

-- API raster inputs now carry an explicit uncapped contract. Subscription
-- identity, the old API shapes and the existing text contract remain separate.
do $$declare expression text;begin
 select pg_get_expr(conbin,conrelid) into expression from pg_constraint where conrelid='public.jobs'::regclass and conname='logo_subscription_job_scope';
 if expression is null then raise exception 'raster_job_scope_missing' using errcode='55000';end if;
 alter table public.jobs drop constraint logo_subscription_job_scope;
 execute 'alter table public.jobs add constraint logo_subscription_job_scope check(('||expression||') or coalesce((operation in(''identity.logo_concept'',''identity.logo_refine'') and billing_mode=''openai_api'' and policy_identity is null and input->''version''=''3''::jsonb and input->>''billingMode''=''openai_api'' and input->>''spendControl''=''uncapped'' and reserved_cost_microusd=0 and max_attempts=1),false))';
end $$;

create function fluid_private.shared_logo_raster_policy_valid(p_operation text,p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$begin return coalesce(
 p_operation in('identity.logo_concept','identity.logo_refine') and p->>'operation'=p_operation
 and fluid_private.standalone_keys(p,array['operation','policyIdentity','handlerVersion','provider','model','engine','spendControl','estimatedCostMicrousd'])
 and p->>'policyIdentity'~'^[a-f0-9]{64}$' and p->>'handlerVersion'='logo-image-v1'
 and p->>'provider'='openai' and p->>'model'='gpt-image-2.5-sunburst-2026-09-08'
 and p->'engine'='null'::jsonb and p->>'spendControl'='uncapped'
 and(p->'estimatedCostMicrousd'='null'::jsonb or(jsonb_typeof(p->'estimatedCostMicrousd')='number'
  and(p->>'estimatedCostMicrousd')::numeric between 0 and 9007199254740991
  and trunc((p->>'estimatedCostMicrousd')::numeric)=(p->>'estimatedCostMicrousd')::numeric)),false);exception when others then return false;end $$;

create or replace function fluid_private.shared_logo_advanced_policy_valid(p_operation text,p jsonb) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(fluid_private.shared_logo_raster_policy_valid(p_operation,p) or p->>'operation'=p_operation and p->>'policyIdentity'~'^[a-f0-9]{64}$' and p->>'spendControl'='uncapped'
  and p->>'provider'='openai' and p->>'model'='gpt-6.1-sol' and p->'engine'='null'::jsonb and (
   p_operation='identity.logo_directions' and fluid_private.standalone_keys(p,array['operation','policyIdentity','handlerVersion','provider','model','engine','spendControl','apiPolicy'])
    and p->>'handlerVersion'='logo-directions-api-v1' and fluid_private.shared_logo_text_policy_valid(p->'apiPolicy','directions')
   or p_operation='identity.logo_vector_propose' and fluid_private.standalone_keys(p,array['operation','policyIdentity','handlerVersion','provider','model','engine','spendControl','textPolicy'])
    and p->>'handlerVersion'='logo-vector-propose-v1' and fluid_private.shared_logo_text_policy_valid(p->'textPolicy','proposal')),false);
$$;
create function fluid_private.shared_logo_raster_quote_binding(q public.logo_cost_quotes,approved jsonb) returns boolean
language plpgsql stable set search_path='' as $$declare retained fluid_private.shared_logo_advanced_quotes; n integer; estimate numeric;begin
 select * into retained from fluid_private.shared_logo_advanced_quotes where quote_id=q.id and owner_id=q.owner_id and project_id=q.project_id;
 if not found or retained.operation is distinct from q.operation or retained.policy is distinct from approved
  or not fluid_private.shared_logo_raster_policy_valid(q.operation,approved)
  or not fluid_private.standalone_keys(q.record,array['version','billingMode','spendControl','id','ownerId','projectId','request','inputHash','expected','policyIdentity','handlerVersion','provider','model','engine','estimatedCostMicrousd','expiresAt','conceptPlan','targetSlotIds'])
  or q.record->'version' is distinct from '3'::jsonb or q.record->>'billingMode' is distinct from 'openai_api' or q.record->>'spendControl' is distinct from 'uncapped'
  or q.record->>'id' is distinct from q.id::text or q.record->>'ownerId' is distinct from q.owner_id::text or q.record->>'projectId' is distinct from q.project_id::text
  or q.record->'expected' is distinct from q.record#>'{request,expected}' or q.record->>'policyIdentity' is distinct from approved->>'policyIdentity'
  or q.record->'handlerVersion' is distinct from approved->'handlerVersion' or q.record->'provider' is distinct from approved->'provider'
  or q.record->'model' is distinct from approved->'model' or q.record->'engine' is distinct from 'null'::jsonb then return false;end if;
 n:=case when q.operation='identity.logo_concept' then jsonb_array_length(q.record->'targetSlotIds') else 1 end;
 if q.operation='identity.logo_concept' then
  if n not between 1 and 6 or q.record#>>'{request,operation}' not in('concepts','more_concepts','retry_failed')
   or q.record#>>'{request,operation}'<>'retry_failed' and n<>6 then return false;end if;
 elsif q.record#>>'{request,operation}' is distinct from 'refine_preview' or q.record->'conceptPlan' is distinct from 'null'::jsonb or q.record->'targetSlotIds' is distinct from '[]'::jsonb then return false;end if;
 estimate:=(approved->>'estimatedCostMicrousd')::numeric*n;if estimate>9007199254740991 then estimate:=null;end if;
 return q.record->'estimatedCostMicrousd'=coalesce(to_jsonb(estimate),'null'::jsonb)
  and q.record->>'inputHash'=encode(sha256(convert_to(jsonb_build_object('request',q.record->'request','sources',q.source_inputs,'policy',approved,'plan',q.record->'conceptPlan','targets',q.record->'targetSlotIds')::text,'UTF8')),'hex');
exception when others then return false;end $$;

create or replace function fluid_private.shared_logo_advanced_quote_binding(q public.logo_cost_quotes,approved jsonb) returns boolean
language plpgsql stable set search_path='' as $$declare retained fluid_private.shared_logo_advanced_quotes; kind text; begin
 if q.operation in('identity.logo_concept','identity.logo_refine') then return fluid_private.shared_logo_raster_quote_binding(q,approved);end if;
 select * into retained from fluid_private.shared_logo_advanced_quotes where quote_id=q.id and owner_id=q.owner_id and project_id=q.project_id;
 kind:=case q.operation when 'identity.logo_directions' then 'apiPolicy' when 'identity.logo_vector_propose' then 'textPolicy' end;
 if not found or kind is null or retained.operation is distinct from q.operation or retained.policy is distinct from approved
  or not fluid_private.shared_logo_advanced_policy_valid(q.operation,approved)
  or q.record->'version' is distinct from '3'::jsonb or q.record->>'billingMode' is distinct from 'openai_api' or q.record->>'spendControl' is distinct from 'uncapped'
  or q.record->>'id' is distinct from q.id::text or q.record->>'ownerId' is distinct from q.owner_id::text or q.record->>'projectId' is distinct from q.project_id::text
  or q.record->'expected' is distinct from q.record#>'{request,expected}' or q.record->>'policyIdentity' is distinct from approved->>'policyIdentity'
  or q.record->>'handlerVersion' is distinct from approved->>'handlerVersion' or q.record->'provider' is distinct from approved->'provider'
  or q.record->'model' is distinct from approved->'model' or q.record->'engine' is distinct from 'null'::jsonb or q.record->kind is distinct from approved->kind
  or q.record ?| array['maxCostMicrousd','maximumCostMicrousd','estimatedCostMicrousd','externalProviderCostMicrousd','policy'] then return false; end if;
 return q.record->>'inputHash'=encode(sha256(convert_to(jsonb_build_object('request',q.record->'request','sources',q.source_inputs,'policy',approved)::text,'UTF8')),'hex');
exception when others then return false;
end $$;
create function fluid_private.shared_logo_quote_raster(p_project_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid();workspace jsonb;brief public.logo_stage_revisions;snapshot jsonb;op text;policy jsonb;profile jsonb;batch public.logo_concept_batches;slot public.logo_concept_slots;
 qid uuid:=gen_random_uuid();plan jsonb;targets jsonb:='[]';sources jsonb;inputs jsonb;inputhash text;result jsonb;expires timestamptz:=clock_timestamp()+interval '5 minutes';count integer:=1;prior bigint;target jsonb;source jsonb;total numeric;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 perform 1 from public.projects where id=p_project_id and owner_id=owner for update;if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 workspace:=fluid_private.logo_workspace_json(owner,p_project_id);
 if jsonb_typeof(p_input) is distinct from 'object' or octet_length(p_input::text)>32768 then raise exception 'invalid_logo_quote' using errcode='22023';end if;
 if workspace->'heads' is distinct from p_input->'expected' then raise exception 'logo_head_conflict' using errcode='PT409';end if;
 select r.* into brief from public.logo_stage_revisions r join public.logo_stage_heads h on h.revision_id=r.id and h.owner_id=r.owner_id and h.project_id=r.project_id where h.owner_id=owner and h.project_id=p_project_id and h.stage='brief_references';
 if brief.id is null then raise exception 'logo_brief_required' using errcode='PT409';end if;
 inputs:=jsonb_build_array(jsonb_build_object('stage','brief_references','id',brief.id,'revision',brief.revision));
 case p_input->>'operation'
 when 'concepts','more_concepts' then
  if not fluid_private.standalone_keys(p_input,array['operation','expected','briefRevisionId','referenceSnapshotId']) or not fluid_private.logo_uuid(p_input->'briefRevisionId') or not fluid_private.logo_uuid(p_input->'referenceSnapshotId') then raise exception 'invalid_logo_quote_source' using errcode='22023';end if;
  if p_input->>'briefRevisionId' is distinct from brief.id::text or p_input->>'referenceSnapshotId' is distinct from brief.reference_snapshot_id::text then raise exception 'logo_source_conflict' using errcode='PT409';end if;
  op:='identity.logo_concept';count:=6;select count(*)*6 into prior from public.logo_concept_batches where owner_id=owner and project_id=p_project_id;
  plan:=fluid_private.logo_plan(brief.record#>'{payload,logoTypes}',prior);
  for i in 1..6 loop targets:=targets||jsonb_build_array(gen_random_uuid());end loop;
 when 'retry_failed' then
  if not fluid_private.standalone_keys(p_input,array['operation','expected','sourceBatchId','failedSlotIds']) or not fluid_private.logo_uuid(p_input->'sourceBatchId') or jsonb_typeof(p_input->'failedSlotIds') is distinct from 'array' then raise exception 'invalid_logo_retry' using errcode='22023';end if;
  count:=jsonb_array_length(p_input->'failedSlotIds');if count not between 1 and 6 or (select count(distinct value) from jsonb_array_elements(p_input->'failedSlotIds'))<>count then raise exception 'invalid_logo_retry' using errcode='22023';end if;
  select * into batch from public.logo_concept_batches where id=(p_input->>'sourceBatchId')::uuid and owner_id=owner and project_id=p_project_id;if not found then raise exception 'logo_batch_not_found' using errcode='P0002';end if;
  if batch.brief_revision_id<>brief.id or batch.reference_snapshot_id<>brief.reference_snapshot_id then raise exception 'logo_source_conflict' using errcode='PT409';end if;
  for target in select value from jsonb_array_elements(p_input->'failedSlotIds') loop
   if not fluid_private.logo_uuid(target) then raise exception 'invalid_logo_slot' using errcode='22023';end if;
   select * into slot from public.logo_concept_slots where id=(target#>>'{}')::uuid and batch_id=batch.id and owner_id=owner and project_id=p_project_id;
   if not found or (select j.state from public.logo_concept_attempts a join public.jobs j on j.id=a.job_id where a.slot_id=slot.id order by a.attempt_number desc limit 1) is distinct from 'failed' then raise exception 'logo_retry_requires_confirmed_failure' using errcode='PT409';end if;
  end loop;
  op:='identity.logo_concept';plan:=batch.plan;targets:=p_input->'failedSlotIds';inputs:=batch.input_revisions;
 when 'refine_preview' then
  if not fluid_private.standalone_keys(p_input,array['operation','expected','source','instruction']) or not fluid_private.standalone_text(p_input->'instruction',4000,1) then raise exception 'invalid_logo_refinement' using errcode='22023';end if;
  op:='identity.logo_refine';source:=fluid_private.resolve_logo_raster_source(owner,p_project_id,p_input->'source');
  select jsonb_agg(value order by value->>'stage',value->>'id') into inputs from (select distinct value from jsonb_array_elements(inputs||(source->'inputRevisions'))) refs;
 else raise exception 'logo_operation_unavailable' using errcode='55000';
 end case;
 profile:=fluid_private.shared_logo_policy(owner,op);policy:=profile->'policy';
 if policy is null or not fluid_private.shared_logo_raster_policy_valid(op,policy) then raise exception 'shared_logo_policy_unavailable' using errcode='55000';end if;
 total:=(policy->>'estimatedCostMicrousd')::numeric*count;if total>9007199254740991 then total:=null;end if;
 snapshot:=fluid_private.logo_snapshot_json(owner,p_project_id,brief.reference_snapshot_id);
 sources:=jsonb_build_object('brief',brief.record,'referenceSnapshot',snapshot,'raster',source);
 inputhash:=encode(sha256(convert_to(jsonb_build_object('request',p_input,'sources',sources,'policy',policy,'plan',plan,'targets',targets)::text,'UTF8')),'hex');
 result:=jsonb_build_object('version',3,'billingMode','openai_api','spendControl','uncapped','id',qid,'ownerId',owner,'projectId',p_project_id,
  'request',p_input,'inputHash',inputhash,'expected',p_input->'expected','policyIdentity',policy->'policyIdentity','handlerVersion',policy->'handlerVersion',
  'provider',policy->'provider','model',policy->'model','engine',null,'estimatedCostMicrousd',total,'expiresAt',to_char(expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'conceptPlan',plan,'targetSlotIds',targets);
 insert into public.logo_cost_quotes values(qid,owner,p_project_id,op,result,inputs,sources,expires);
 insert into fluid_private.shared_logo_advanced_quotes(quote_id,owner_id,project_id,operation,policy,deployment_id) values(qid,owner,p_project_id,op,policy,profile->>'deploymentId');
 return result;
end $$;
create or replace function public.shared_logo_operation(p_project_id uuid,p_kind text,p_input jsonb default null) returns jsonb
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
  if p_input->>'operation' in('concepts','more_concepts','retry_failed','refine_preview') then
   result:=fluid_private.shared_logo_quote_raster(p_project_id,p_input);
  elsif p_input->>'operation'='directions' then
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
create or replace function fluid_private.shared_logo_advanced_quote_current(q public.logo_cost_quotes,policy jsonb) returns boolean
language plpgsql stable set search_path='' as $$declare base jsonb; brief jsonb; font jsonb; stored jsonb; source jsonb; begin
 if not fluid_private.shared_logo_advanced_quote_binding(q,policy) or fluid_private.logo_workspace_json(q.owner_id,q.project_id)->'heads' is distinct from q.record->'expected' then return false;end if;
 if q.operation in('identity.logo_concept','identity.logo_refine') then
  select record into brief from public.logo_stage_revisions where id=(q.source_inputs#>>'{brief,id}')::uuid and owner_id=q.owner_id and project_id=q.project_id and stage='brief_references';
  if brief is null or brief is distinct from q.source_inputs->'brief'
   or fluid_private.logo_snapshot_json(q.owner_id,q.project_id,(q.source_inputs#>>'{referenceSnapshot,id}')::uuid) is distinct from q.source_inputs->'referenceSnapshot' then return false;end if;
  return q.operation='identity.logo_concept' or fluid_private.resolve_logo_raster_source(q.owner_id,q.project_id,q.record#>'{request,source}')=q.source_inputs->'raster';
 end if;
 if q.operation='identity.logo_directions' then
  return fluid_private.logo_prepare_direction_sources(q.owner_id,q.project_id,(q.record#>>'{request,approvedLogoId}')::uuid)=q.source_inputs->'direction';
 end if;
 if fluid_private.logo_current_vector_id(q.owner_id,q.project_id)::text is distinct from q.record#>>'{request,baseVectorRevisionId}' then return false;end if;
 select record into base from public.logo_vector_revisions where id=(q.record#>>'{request,baseVectorRevisionId}')::uuid and owner_id=q.owner_id and project_id=q.project_id;
 if base is null or base is distinct from q.source_inputs->'baseRevision'
  or exists(select 1 from jsonb_array_elements(q.input_revisions) i left join public.logo_stage_heads h on h.owner_id=q.owner_id and h.project_id=q.project_id and h.stage=i->>'stage' where h.revision_id::text is distinct from i->>'id') then return false;end if;
 select record into brief from public.logo_stage_revisions where id=(q.source_inputs#>>'{brief,id}')::uuid and owner_id=q.owner_id and project_id=q.project_id and stage='brief_references';
 if brief is null or brief is distinct from q.source_inputs->'brief' then return false;end if;
 for font in select value from jsonb_array_elements(q.source_inputs->'fonts') loop
  select record into stored from public.logo_font_records where record_id=(font->>'id')::uuid and owner_id=q.owner_id and project_id=q.project_id;
  if stored is null or stored is distinct from font or font#>>'{rights,sourceKind}' is distinct from 'reviewed_license' or font#>>'{rights,commercialUse}' is distinct from 'allowed'
   or font#>>'{rights,permissions,render}' is distinct from 'allowed' or font#>>'{rights,permissions,outline}' is distinct from 'allowed' then return false;end if;
 end loop;return true;
exception when others then return false;
end $$;
create function fluid_private.shared_logo_create_raster_jobs(q public.logo_cost_quotes,p_input jsonb,profile jsonb) returns jsonb
language plpgsql set search_path='' as $$declare owner uuid:=auth.uid();p_project_id uuid:=q.project_id;batch uuid;jobid uuid;attempt uuid;
 prior public.logo_concept_attempts;slot public.logo_concept_slots;target jsonb;slotplan jsonb;input jsonb;manifest jsonb;jobids jsonb:='[]';result jsonb;raster uuid;j public.jobs;op text:=q.record#>>'{request,operation}';begin
 if owner is distinct from q.owner_id or not fluid_private.shared_logo_context_allowed(owner,p_project_id)
  or not fluid_private.shared_logo_raster_policy_valid(q.operation,profile->'policy') or not fluid_private.shared_logo_advanced_quote_current(q,profile->'policy') then raise exception 'shared_raster_admission_denied' using errcode='42501';end if;
 insert into public.usage_accounts(owner_id,limit_microusd) values(owner,0) on conflict(owner_id) do nothing;
 if q.operation='identity.logo_concept' then
  if op='retry_failed' then batch:=(q.record#>>'{request,sourceBatchId}')::uuid;
  else batch:=gen_random_uuid();insert into public.logo_concept_batches(id,owner_id,project_id,request_key,brief_revision_id,reference_snapshot_id,plan,input_revisions) values(batch,owner,p_project_id,(p_input->>'requestKey')::uuid,(q.source_inputs#>>'{brief,id}')::uuid,(q.source_inputs#>>'{referenceSnapshot,id}')::uuid,q.record->'conceptPlan',q.input_revisions);end if;
  for target in select value from jsonb_array_elements(q.record->'targetSlotIds') loop
   if op='retry_failed' then
    select * into slot from public.logo_concept_slots where id=(target#>>'{}')::uuid and batch_id=batch and owner_id=owner and project_id=p_project_id;
    select * into prior from public.logo_concept_attempts where slot_id=slot.id order by attempt_number desc limit 1;
    if (select state from public.jobs where id=prior.job_id) is distinct from 'failed' or prior.attempt_number>=100 then raise exception 'logo_retry_requires_confirmed_failure' using errcode='PT409';end if;
   else
    select value into slotplan from jsonb_array_elements(q.record#>'{conceptPlan,slots}') where (value->>'ordinal')::integer=jsonb_array_length(jobids);
    insert into public.logo_concept_slots values((target#>>'{}')::uuid,batch,owner,p_project_id,(slotplan->>'ordinal')::integer,slotplan->>'type',slotplan->>'directionId') returning * into slot;prior:=null;
   end if;
   jobid:=gen_random_uuid();attempt:=gen_random_uuid();
   input:=jsonb_build_object('version',3,'billingMode','openai_api','spendControl','uncapped','ownerId',owner,'projectId',p_project_id,'requestKey',p_input->'requestKey','quoteId',q.id,'policyIdentity',q.record->'policyIdentity','handlerVersion',q.record->'handlerVersion','inputHash',q.record->'inputHash','operation',q.operation,'batchId',batch,'slotId',slot.id,'attemptId',attempt,'attemptNumber',coalesce(prior.attempt_number,0)+1,'previousAttemptId',prior.id,'directionId',slot.direction_id,'plan',q.record->'conceptPlan','ordinal',slot.ordinal,'briefRevisionId',q.source_inputs#>'{brief,id}','referenceSnapshotId',q.source_inputs#>'{referenceSnapshot,id}','references',(select coalesce(jsonb_agg(x->'asset'),'[]') from jsonb_array_elements(q.source_inputs#>'{referenceSnapshot,references}') x));
   manifest:=jsonb_build_array(jsonb_build_object('key','logo-preview-v1:'||slot.id||':'||attempt,'maximumCostMicrousd',0));
   insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,plan_manifest,plan_fingerprint,plan_registered_at) values(jobid,owner,p_project_id,q.operation,(p_input#>>'{expected,projectRevision}')::integer,q.record->>'inputHash',input,'logo-shared-v3:'||jobid,0,1,manifest,encode(sha256(convert_to(manifest::text,'UTF8')),'hex'),clock_timestamp());
   insert into public.logo_concept_attempts values(attempt,owner,p_project_id,slot.id,jobid,(p_input->>'requestKey')::uuid,prior.id,coalesce(prior.attempt_number,0)+1,q.record->>'inputHash');jobids:=jobids||jsonb_build_array(jobid);
  end loop;
 else
  jobid:=gen_random_uuid();raster:=gen_random_uuid();input:=jsonb_build_object('version',3,'billingMode','openai_api','spendControl','uncapped','ownerId',owner,'projectId',p_project_id,'requestKey',p_input->'requestKey','quoteId',q.id,'policyIdentity',q.record->'policyIdentity','handlerVersion',q.record->'handlerVersion','inputHash',q.record->'inputHash','operation',q.operation);
  if q.operation='identity.logo_refine' then input:=input||jsonb_build_object('rasterRevisionId',raster,'instruction',q.record#>'{request,instruction}','briefRevisionId',q.source_inputs#>'{brief,id}','referenceSnapshotId',q.source_inputs#>'{referenceSnapshot,id}','source',jsonb_build_object('kind','preview','raster',q.record#>'{request,source}')); manifest:=jsonb_build_array(jsonb_build_object('key','generate-refinement','maximumCostMicrousd',0));
  else raise exception 'logo_operation_unavailable' using errcode='55000';end if;
  insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,plan_manifest,plan_fingerprint,plan_registered_at) values(jobid,owner,p_project_id,q.operation,(p_input#>>'{expected,projectRevision}')::integer,q.record->>'inputHash',input,'logo-shared-v3:'||jobid,0,1,manifest,encode(sha256(convert_to(manifest::text,'UTF8')),'hex'),clock_timestamp());
  if q.operation='identity.logo_refine' then insert into public.logo_raster_refinements(id,owner_id,project_id,request_key,job_id,source,logo_type,input_revisions) values(raster,owner,p_project_id,(p_input->>'requestKey')::uuid,jobid,q.record#>'{request,source}',q.source_inputs#>>'{raster,logoType}',q.input_revisions);end if;jobids:=jsonb_build_array(jobid);
 end if;

 insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) select id,owner,p_project_id,0 from public.jobs where id in(select(value#>>'{}')::uuid from jsonb_array_elements(jobids));
 result:=jsonb_build_object('ownerId',owner,'projectId',p_project_id,'requestKey',p_input->'requestKey','operation',q.operation,'batchId',batch,'jobIds',jobids,'inputHash',q.record->'inputHash');
 insert into public.logo_operation_requests(owner_id,project_id,request_key,quote_id,input,receipt) values(owner,p_project_id,(p_input->>'requestKey')::uuid,q.id,p_input,result);
 for j in select * from public.jobs where id in(select(value#>>'{}')::uuid from jsonb_array_elements(jobids)) loop
  perform fluid_private.admit_shared_worker_job(j.id,'logo',profile->>'policyIdentity',profile->>'deploymentId',profile->'policy');
 end loop;return result;
end $$;

create or replace function fluid_private.shared_logo_admit_advanced(p_project uuid,p_input jsonb) returns jsonb
language plpgsql set search_path='' as $$declare owner uuid:=auth.uid(); q public.logo_cost_quotes; previous public.logo_operation_requests; rejected public.logo_operation_rejections;
 profile jsonb; policy jsonb; input jsonb; manifest jsonb; id uuid:=gen_random_uuid(); receipt jsonb; j public.jobs; begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not fluid_private.standalone_keys(p_input,array['requestKey','quoteId','expected']) or not fluid_private.logo_uuid(p_input->'requestKey') or not fluid_private.logo_uuid(p_input->'quoteId') then raise exception 'invalid_logo_intent' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,723902));
 perform 1 from public.projects where projects.id=p_project and owner_id=owner for update;if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into previous from public.logo_operation_requests where owner_id=owner and project_id=p_project and request_key=(p_input->>'requestKey')::uuid;
 if found then if previous.input is distinct from p_input then raise exception 'logo_request_conflict' using errcode='PT409';end if;return previous.receipt;end if;
 select * into rejected from public.logo_operation_rejections where owner_id=owner and project_id=p_project and request_key=(p_input->>'requestKey')::uuid;
 if found then if rejected.input is distinct from p_input then raise exception 'logo_request_conflict' using errcode='PT409';end if;return rejected.receipt;end if;
 if exists(select 1 from public.logo_workspace_requests where owner_id=owner and project_id=p_project and request_key=(p_input->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 begin
  if not fluid_private.shared_account_customer_active(owner) or not fluid_private.shared_logo_project_clear(owner,p_project) then raise exception 'shared_logo_unavailable' using errcode='55000';end if;
  select * into q from public.logo_cost_quotes where logo_cost_quotes.id=(p_input->>'quoteId')::uuid and owner_id=owner and project_id=p_project for update;
  if not found then raise exception 'logo_quote_not_found' using errcode='P0002';end if;
  if exists(select 1 from public.logo_operation_requests where quote_id=q.id) or q.expires_at<=clock_timestamp() or q.record->'expected' is distinct from p_input->'expected' then raise exception 'logo_quote_stale' using errcode='PT409';end if;
  profile:=fluid_private.shared_logo_policy(owner,q.operation);policy:=profile->'policy';
  if policy is null or not fluid_private.shared_logo_advanced_quote_current(q,policy)
   or profile->>'deploymentId' is distinct from(select deployment_id from fluid_private.shared_logo_advanced_quotes where quote_id=q.id) then raise exception 'shared_logo_policy_changed' using errcode='PT409';end if;
  if q.operation in('identity.logo_concept','identity.logo_refine') then return fluid_private.shared_logo_create_raster_jobs(q,p_input,profile);end if;
  input:=jsonb_build_object('version',3,'ownerId',owner,'projectId',p_project,'operation',q.operation,'requestKey',p_input->'requestKey','quoteId',q.id,
   'policyIdentity',policy->'policyIdentity','handlerVersion',policy->'handlerVersion','inputHash',q.record->'inputHash','billingMode','openai_api','spendControl','uncapped');
  if q.operation='identity.logo_directions' then
   input:=input||jsonb_build_object('approvedLogoId',q.record#>'{request,approvedLogoId}','briefRevisionId',q.source_inputs#>'{direction,brief,id}','referenceSnapshotId',q.source_inputs#>'{direction,references,id}',
    'fontVersionIds',(select jsonb_agg(f->'id') from jsonb_array_elements(q.source_inputs#>'{direction,permittedFonts}') f),'targetCount',3,'apiPolicy',policy->'apiPolicy');
   manifest:='[{"key":"propose-directions","maximumCostMicrousd":0}]'::jsonb;
  elsif q.operation='identity.logo_vector_propose' then
   input:=input||jsonb_build_object('baseVectorRevisionId',q.record#>'{request,baseVectorRevisionId}','contextHash',q.source_inputs->'contextHash','instruction',q.record#>'{request,instruction}',
    'targetComponentIds',q.record#>'{request,targetComponentIds}','textPolicy',policy->'textPolicy');
   manifest:='[{"key":"propose-vector-edit","maximumCostMicrousd":0}]'::jsonb;
  else raise exception 'wrong_logo_operation' using errcode='22023';end if;
  insert into public.usage_accounts(owner_id,limit_microusd) values(owner,0) on conflict(owner_id) do nothing;
  insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,plan_manifest,plan_fingerprint,plan_registered_at)
   values(id,owner,p_project,q.operation,(p_input#>>'{expected,projectRevision}')::integer,q.record->>'inputHash',input,'logo-shared-v3:'||id,0,1,manifest,encode(sha256(convert_to(manifest::text,'UTF8')),'hex'),clock_timestamp()) returning * into j;
  insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) values(id,owner,p_project,0);
  receipt:=jsonb_build_object('ownerId',owner,'projectId',p_project,'requestKey',p_input->'requestKey','operation',q.operation,'batchId',null,'jobIds',jsonb_build_array(id),'inputHash',q.record->'inputHash');
  insert into public.logo_operation_requests(owner_id,project_id,request_key,quote_id,input,receipt) values(owner,p_project,(p_input->>'requestKey')::uuid,q.id,p_input,receipt);
  if q.operation='identity.logo_directions' then perform fluid_private.logo_freeze_direction_inputs(j,q.source_inputs->'direction');end if;
  perform fluid_private.admit_shared_worker_job(id,'logo',profile->>'policyIdentity',profile->>'deploymentId',policy);return receipt;
 exception when sqlstate 'PT409' then return fluid_private.reject_logo_admission(owner,p_project,p_input,'conflict');
  when sqlstate 'P0002' then return fluid_private.reject_logo_admission(owner,p_project,p_input,'not_found');
 end;
end $$;
create function fluid_private.shared_logo_raster_job_matches(j public.jobs,approved jsonb) returns boolean
language plpgsql stable set search_path='' as $$declare q public.logo_cost_quotes;r public.logo_operation_requests;expected jsonb;manifest jsonb;
 attempt public.logo_concept_attempts;slot public.logo_concept_slots;batch public.logo_concept_batches;refinement public.logo_raster_refinements;begin
 if j.id is null or j.operation not in('identity.logo_concept','identity.logo_refine') or j.billing_mode<>'openai_api' or j.policy_identity is not null
  or j.max_attempts<>1 or j.reserved_cost_microusd<>0 or not fluid_private.logo_uuid(j.input->'requestKey') then return false;end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and(owner_id,project_id,operation)=(j.owner_id,j.project_id,j.operation);
 if not found or not fluid_private.shared_logo_raster_quote_binding(q,approved) or j.input_hash is distinct from q.record->>'inputHash'
  or j.input_revision is distinct from(q.record#>>'{expected,projectRevision}')::integer then return false;end if;
 select * into r from public.logo_operation_requests where owner_id=j.owner_id and project_id=j.project_id and quote_id=q.id and request_key=(j.input->>'requestKey')::uuid;
 if not found or r.input is distinct from jsonb_build_object('requestKey',r.request_key,'quoteId',q.id,'expected',q.record->'expected')
  or r.receipt->>'ownerId' is distinct from j.owner_id::text or r.receipt->>'projectId' is distinct from j.project_id::text
  or r.receipt->>'requestKey' is distinct from r.request_key::text or r.receipt->>'operation' is distinct from j.operation
  or r.receipt->>'inputHash' is distinct from j.input_hash or not(r.receipt->'jobIds' @> jsonb_build_array(j.id)) then return false;end if;
 expected:=jsonb_build_object('version',3,'billingMode','openai_api','spendControl','uncapped','ownerId',j.owner_id,'projectId',j.project_id,
  'requestKey',r.request_key,'quoteId',q.id,'policyIdentity',approved->'policyIdentity','handlerVersion',approved->'handlerVersion','inputHash',j.input_hash,'operation',j.operation,
  'briefRevisionId',q.source_inputs#>'{brief,id}','referenceSnapshotId',q.source_inputs#>'{referenceSnapshot,id}');
 if j.operation='identity.logo_concept' then
  select * into attempt from public.logo_concept_attempts where id=(j.input->>'attemptId')::uuid and(job_id,owner_id,project_id,request_key,input_hash)=(j.id,j.owner_id,j.project_id,r.request_key,j.input_hash);
  select * into slot from public.logo_concept_slots where id=attempt.slot_id and(owner_id,project_id)=(j.owner_id,j.project_id);
  select * into batch from public.logo_concept_batches where id=slot.batch_id and(owner_id,project_id)=(j.owner_id,j.project_id);
  if attempt.id is null or slot.id is null or batch.id is null or r.receipt->>'batchId' is distinct from batch.id::text
   or batch.plan is distinct from q.record->'conceptPlan' or batch.input_revisions is distinct from q.input_revisions
   or batch.brief_revision_id::text is distinct from q.source_inputs#>>'{brief,id}' or batch.reference_snapshot_id::text is distinct from q.source_inputs#>>'{referenceSnapshot,id}'
   or not(q.record->'targetSlotIds' @> jsonb_build_array(slot.id))
   or not exists(select 1 from jsonb_array_elements(batch.plan->'slots') p where p=jsonb_build_object('ordinal',slot.ordinal,'type',slot.logo_type,'directionId',slot.direction_id)) then return false;end if;
  expected:=expected||jsonb_build_object('batchId',batch.id,'slotId',slot.id,'attemptId',attempt.id,'attemptNumber',attempt.attempt_number,
   'previousAttemptId',attempt.previous_attempt_id,'directionId',slot.direction_id,'plan',batch.plan,'ordinal',slot.ordinal,
   'references',(select coalesce(jsonb_agg(v->'asset' order by ordinality),'[]') from jsonb_array_elements(q.source_inputs#>'{referenceSnapshot,references}') with ordinality refs(v,ordinality)));
  manifest:=jsonb_build_array(jsonb_build_object('key','logo-preview-v1:'||slot.id||':'||attempt.id,'maximumCostMicrousd',0));
 else
  select * into refinement from public.logo_raster_refinements where id=(j.input->>'rasterRevisionId')::uuid and(job_id,owner_id,project_id,request_key)=(j.id,j.owner_id,j.project_id,r.request_key);
  if refinement.id is null or refinement.source is distinct from q.record#>'{request,source}' or refinement.input_revisions is distinct from q.input_revisions
   or r.receipt->'batchId' is distinct from 'null'::jsonb or r.receipt->'jobIds' is distinct from jsonb_build_array(j.id) then return false;end if;
  expected:=expected||jsonb_build_object('rasterRevisionId',refinement.id,'instruction',q.record#>'{request,instruction}','source',jsonb_build_object('kind','preview','raster',refinement.source));
  manifest:='[{"key":"generate-refinement","maximumCostMicrousd":0}]'::jsonb;
 end if;
 return j.input=expected and j.plan_manifest=manifest and j.plan_fingerprint=encode(sha256(convert_to(manifest::text,'UTF8')),'hex') and j.plan_registered_at is not null;
exception when others then return false;end $$;

create or replace function fluid_private.shared_logo_advanced_job_matches(j public.jobs,approved jsonb) returns boolean
language plpgsql stable set search_path='' as $$declare q public.logo_cost_quotes; input jsonb; manifest jsonb; begin
 if j.operation in('identity.logo_concept','identity.logo_refine') then return fluid_private.shared_logo_raster_job_matches(j,approved);end if;
 if j.id is null or j.operation not in('identity.logo_directions','identity.logo_vector_propose') or j.billing_mode<>'openai_api' or j.policy_identity is not null
  or j.max_attempts<>1 or j.reserved_cost_microusd<>0 or not fluid_private.logo_uuid(j.input->'requestKey') then return false; end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and(owner_id,project_id,operation)=(j.owner_id,j.project_id,j.operation);
 if not found or not fluid_private.shared_logo_advanced_quote_binding(q,approved) or j.input_hash is distinct from q.record->>'inputHash'
  or j.input_revision is distinct from(q.record#>>'{expected,projectRevision}')::integer then return false; end if;
 input:=jsonb_build_object('version',3,'ownerId',j.owner_id,'projectId',j.project_id,'operation',j.operation,'requestKey',j.input->'requestKey','quoteId',q.id,
  'policyIdentity',approved->'policyIdentity','handlerVersion',approved->'handlerVersion','inputHash',j.input_hash,'billingMode','openai_api','spendControl','uncapped');
 if j.operation='identity.logo_directions' then
  input:=input||jsonb_build_object('approvedLogoId',q.record#>'{request,approvedLogoId}','briefRevisionId',q.source_inputs#>'{direction,brief,id}',
   'referenceSnapshotId',q.source_inputs#>'{direction,references,id}','fontVersionIds',(select coalesce(jsonb_agg(f->'id'),'[]') from jsonb_array_elements(q.source_inputs#>'{direction,permittedFonts}') f),'targetCount',3,'apiPolicy',approved->'apiPolicy');
  manifest:=jsonb_build_array(jsonb_build_object('key','propose-directions','maximumCostMicrousd',0));
 else
  input:=input||jsonb_build_object('baseVectorRevisionId',q.record#>'{request,baseVectorRevisionId}','contextHash',q.source_inputs->'contextHash',
   'instruction',q.record#>'{request,instruction}','targetComponentIds',q.record#>'{request,targetComponentIds}','textPolicy',approved->'textPolicy');
  manifest:=jsonb_build_array(jsonb_build_object('key','propose-vector-edit','maximumCostMicrousd',0));
 end if;
 return j.input=input and j.plan_manifest=manifest and j.plan_fingerprint=encode(sha256(convert_to(manifest::text,'UTF8')),'hex') and j.plan_registered_at is not null
  and exists(select 1 from public.logo_operation_requests r where r.owner_id=j.owner_id and r.project_id=j.project_id and r.quote_id=q.id and r.request_key::text=j.input->>'requestKey'
   and r.input=jsonb_build_object('requestKey',j.input->'requestKey','quoteId',q.id,'expected',q.record->'expected')
   and r.receipt->'jobIds'=jsonb_build_array(j.id) and r.receipt->>'operation'=j.operation and r.receipt->>'inputHash'=j.input_hash);
exception when others then return false;
end $$;
alter table fluid_private.shared_logo_vector_proposal_dispatches drop constraint shared_logo_vector_proposal_dispatches_step_key_check;
alter table fluid_private.shared_logo_vector_proposal_dispatches add constraint shared_logo_vector_proposal_dispatches_step_key_check
 check(step_key in('propose-directions','propose-vector-edit','generate-refinement') or step_key~'^logo-preview-v1:[0-9a-f-]{36}:[0-9a-f-]{36}$');

create function fluid_private.shared_logo_raster_observation_valid(o jsonb) returns boolean
language plpgsql immutable set search_path='' as $$declare b jsonb:=o->'billing';k text;begin
 if not fluid_private.standalone_keys(o-'normalizedPixelHash',array['provider','model','providerRequestId','responseHash','observedAt','billing','artifactHash'])
  or octet_length(o::text)>32768 or o->>'provider' is distinct from 'openai' or o->>'model' is distinct from 'gpt-image-2.5-sunburst-2026-09-08'
  or not fluid_private.standalone_timestamp(o->'observedAt') or not fluid_private.standalone_keys(b,array['status','confirmedMicrousd']) then return false;end if;
 if ((b->>'status'='unknown' and b->'confirmedMicrousd'='null'::jsonb) or(b->>'status'='recorded' and jsonb_typeof(b->'confirmedMicrousd')='number'
  and(b->>'confirmedMicrousd')::numeric between 0 and 9007199254740991 and trunc((b->>'confirmedMicrousd')::numeric)=(b->>'confirmedMicrousd')::numeric)) is distinct from true then return false;end if;
 if o->'providerRequestId'<>'null'::jsonb and not fluid_private.standalone_text(o->'providerRequestId',200,1) then return false;end if;
 foreach k in array array['responseHash','artifactHash','normalizedPixelHash'] loop
  if(o?k and(o->k<>'null'::jsonb or k='normalizedPixelHash')) and(jsonb_typeof(o->k) is distinct from 'string' or o->>k!~'^[a-f0-9]{64}$') then return false;end if;
 end loop;return true;
exception when others then return false;end $$;

create or replace function fluid_private.shared_logo_record_response(p_job uuid,p_lease uuid,o jsonb) returns jsonb
language plpgsql set search_path='' as $$declare j public.jobs; r public.logo_provider_responses; s public.job_steps; account public.usage_accounts; reservation public.usage_reservations;
 cost bigint:=0; reason text; p jsonb; accountable boolean; begin
 j:=fluid_private.shared_logo_lock_issued_job(p_job,p_lease);
 select * into r from public.logo_provider_responses where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 if found then
  if r.observation is distinct from o or r.lease_token is distinct from p_lease then raise exception 'provider_evidence_immutable' using errcode='PT409';end if;
 else
  select * into s from public.job_steps where job_id=j.id for update;
  p:=case j.operation when 'identity.logo_directions' then j.input->'apiPolicy' else j.input->'textPolicy' end;
  if j.state not in('running','cancel_requested','needs_reconciliation') or s.state not in('in_flight','ambiguous') or
   (case j.operation when 'identity.logo_directions' then fluid_private.shared_logo_directions_observation_valid(o,p)
    when 'identity.logo_vector_propose' then fluid_private.shared_logo_valid_vector_proposal_observation(o,p)
    when 'identity.logo_concept' then fluid_private.shared_logo_raster_observation_valid(o)
    when 'identity.logo_refine' then fluid_private.shared_logo_raster_observation_valid(o) else false end) is distinct from true
   or(o->>'observedAt')::timestamptz>clock_timestamp()+interval '1 minute' then raise exception 'invalid_provider_evidence' using errcode='22023'; end if;
  insert into public.logo_provider_responses(owner_id,project_id,job_id,lease_token,observation) values(j.owner_id,j.project_id,j.id,p_lease,o) returning * into r;
  if o#>>'{billing,status}'='recorded' then
   cost:=(o#>>'{billing,confirmedMicrousd}')::bigint;
   select * into reservation from public.usage_reservations where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id for update;
   select * into account from public.usage_accounts where owner_id=j.owner_id for update;
   accountable:=reservation.job_id is not null and account.owner_id is not null and reservation.state='active' and reservation.reserved_microusd=0
    and reservation.actual_microusd=0 and reservation.captured_microusd=0 and j.actual_cost_microusd=0 and s.actual_cost_microusd=0
    and account.provider_actual_microusd::numeric+cost<=9007199254740991;
   if accountable then
    update public.usage_accounts set provider_actual_microusd=provider_actual_microusd+cost where owner_id=j.owner_id;
    update public.usage_reservations set actual_microusd=cost where job_id=j.id;
   else reason:='provider_accounting_unconfirmed';end if;
   update public.jobs set actual_cost_microusd=cost where id=j.id;
   update public.job_steps set actual_cost_microusd=cost where id=s.id;
  else reason:='provider_billing_unknown';end if;
  if reason is null then
   if j.operation in('identity.logo_concept','identity.logo_refine') then
    if o->>'providerRequestId' is null or o->>'responseHash' is null then reason:='provider_evidence_incomplete';end if;
   elsif o->'responseComplete' is distinct from 'true'::jsonb or o->>'responseId' is null or o->>'responseHash' is null then reason:='provider_evidence_incomplete';
   elsif(o#>>'{usage,inputTokens}')::numeric>(p->>'maxInputTokens')::numeric or(o#>>'{usage,outputTokens}')::numeric>(p->>'maxOutputTokens')::numeric then reason:='provider_usage_exceeded';
   end if;
   if reason is null and(j.lease_token is distinct from p_lease or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp()) then reason:='provider_response_after_lease';end if;
  end if;
  if reason is not null then update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=reason where id=j.id;end if;
 end if;
 if j.operation='identity.logo_vector_propose' then
  return jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token,'observation',r.observation);
 end if;
 return r.observation||jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token);
end $$;
create or replace function fluid_private.shared_logo_advanced_action(p_job uuid,p_lease uuid,p_action text,p_args jsonb) returns jsonb
language plpgsql set search_path='' as $$declare j public.jobs; q public.logo_cost_quotes; result jsonb; begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);
 if fluid_private.shared_worker_context_job('logo') is distinct from j.id or not fluid_private.shared_logo_advanced_job_matches(j,(select policy from fluid_private.shared_job_admissions where job_id=j.id)) then raise exception 'shared_logo_advanced_binding_invalid' using errcode='42501';end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
 if p_action='plan' and jsonb_array_length(p_args)=3 then perform public.register_logo_job_plan(p_job,p_lease,fluid_private.shared_logo_json_arg(p_args,2)); return 'null'::jsonb;
 elsif p_action='begin' and jsonb_array_length(p_args)=5 then return to_jsonb(fluid_private.shared_logo_begin_job(p_job,p_lease,p_args->>2,p_args->>3,(p_args->>4)::bigint));
 elsif p_action='receipt' and jsonb_array_length(p_args)=3 then return fluid_private.shared_logo_record_response(p_job,p_lease,fluid_private.shared_logo_json_arg(p_args,2));
 elsif p_action='complete' and jsonb_array_length(p_args)=7 then
  if j.operation='identity.logo_vector_propose' then perform fluid_private.shared_logo_complete_proposal(p_job,p_lease,p_args->>2,p_args->>3,(p_args->>4)::bigint,fluid_private.shared_logo_json_arg(p_args,5),p_args->>6);
  else perform fluid_private.shared_logo_complete_directions(p_job,p_lease,p_args->>2,p_args->>3,(p_args->>4)::bigint,fluid_private.shared_logo_json_arg(p_args,5),p_args->>6);end if;return 'null'::jsonb;
 elsif p_action='finish' and jsonb_array_length(p_args)=3 then perform public.finish_logo_job(p_job,p_lease,p_args->>2);return 'null'::jsonb;
 elsif p_action='direction_inputs' and jsonb_array_length(p_args)=2 and j.operation='identity.logo_directions' then return public.load_logo_direction_inputs(p_job,p_lease);
 elsif p_action='stage_directions' and jsonb_array_length(p_args)=5 and j.operation='identity.logo_directions' then return public.stage_logo_directions(p_job,p_lease,fluid_private.shared_logo_json_arg(p_args,2),(p_args->>3)::uuid,fluid_private.shared_logo_json_arg(p_args,4));
 elsif p_action='stage_proposal' and jsonb_array_length(p_args)=4 and j.operation='identity.logo_vector_propose' then return fluid_private.shared_logo_stage_proposal(p_job,p_lease,fluid_private.shared_logo_json_arg(p_args,2),(p_args->>3)::uuid);
 elsif p_action='read' and jsonb_array_length(p_args)=4 then
  if p_args->>2='runtime_readiness' and fluid_private.shared_logo_json_arg(p_args,3) in('null'::jsonb) then return to_jsonb(j.state='running' and fluid_private.logo_job_ready(j,j.worker_id));
  elsif p_args->>2='input_revisions' then return q.input_revisions;
  elsif j.operation in('identity.logo_concept','identity.logo_refine') and p_args->>2 in('concept_inputs','refinement_inputs','step_output','step_asset') then
   return public.read_leased_logo_record(p_job,p_lease,p_args->>2,fluid_private.shared_logo_json_arg(p_args,3));
  elsif p_args->>2 in('vector_proposal_inputs','vector_proposal_evidence_inputs') and j.operation='identity.logo_vector_propose' and fluid_private.shared_logo_json_arg(p_args,3) in('null'::jsonb) then
   if p_args->>2='vector_proposal_evidence_inputs' then perform fluid_private.shared_logo_lock_issued_job(p_job,p_lease);end if;
   return jsonb_build_object('input',j.input,'context',q.source_inputs->'context');
  elsif p_args->>2='step_output' then select output into result from public.job_steps where job_id=j.id and step_key=fluid_private.shared_logo_json_arg(p_args,3)->>'stepKey' and state='succeeded';return result;
  end if;
 end if; raise exception 'shared_logo_advanced_action_denied' using errcode='42501';
end $$;
do $$declare f record;a record;begin
 for f in select oid,oid::regprocedure signature,proowner from pg_proc where pronamespace='fluid_private'::regnamespace
  and proname=any(array['shared_logo_raster_policy_valid','shared_logo_raster_quote_binding','shared_logo_quote_raster','shared_logo_create_raster_jobs','shared_logo_raster_job_matches','shared_logo_raster_observation_valid']) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  for a in select distinct grantee from aclexplode((select proacl from pg_proc where oid=f.oid)) where grantee not in(0,f.proowner) loop
   execute format('revoke all on function %s from %I',f.signature,pg_get_userbyid(a.grantee));
  end loop;
 end loop;
end $$;
commit;
