-- UNAPPLIED QUOTE-ONLY CONTINUATION after logo-vector-proposals.sql.
-- No policy seed, login, helper grant, admission branch or provider/host enablement.
begin;

create function fluid_private.valid_logo_vector_proposal_text_policy(p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text;n numeric;maximum numeric;
begin
 if fluid_private.standalone_keys(p,array['version','billingMode','handlerVersion','adapterVersion','schemaVersion','model','pricingVersion','serviceTier','maxInputTokens','maxOutputTokens','maxInputBytes','maxOutputBytes','maxStreamBytes','deadlineMs','maxTools','inputMicrousdPerMillionTokens','cachedInputMicrousdPerMillionTokens','cacheWriteMicrousdPerMillionTokens','outputMicrousdPerMillionTokens','maximumCostMicrousd']) is distinct from true then return false;end if;
 if p->'version' is distinct from '1'::jsonb or p->>'billingMode' is distinct from 'openai_api'
  or p->>'handlerVersion' is distinct from 'logo-vector-propose-v1' or p->>'adapterVersion' is distinct from 'logo-vector-propose-api-v1'
  or p->>'schemaVersion' is distinct from 'logo-vector-proposal-v1' or p->>'model' is distinct from 'gpt-6.1-sol'
  or p->>'pricingVersion' is distinct from '2026-10-03' or p->>'serviceTier' is distinct from 'default' or p->'maxTools' is distinct from '0'::jsonb
  or p->'inputMicrousdPerMillionTokens' is distinct from '2000000'::jsonb or p->'cachedInputMicrousdPerMillionTokens' is distinct from '100000'::jsonb
  or p->'cacheWriteMicrousdPerMillionTokens' is distinct from '2500000'::jsonb or p->'outputMicrousdPerMillionTokens' is distinct from '10000000'::jsonb then return false;end if;
 foreach k in array array['maxInputTokens','maxOutputTokens','maxInputBytes','maxOutputBytes','maxStreamBytes','deadlineMs','maximumCostMicrousd'] loop
  if jsonb_typeof(p->k) is distinct from 'number' then return false;end if;n:=(p->>k)::numeric;
  if n<>trunc(n) or n<(case k when 'maxInputBytes' then 1024 when 'maxOutputBytes' then 1024 when 'maxStreamBytes' then 1024 when 'deadlineMs' then 1000 else 1 end)
   or n>(case k when 'maxInputTokens' then 32768 when 'maxOutputTokens' then 4096 when 'maxInputBytes' then 131072 when 'maxOutputBytes' then 32768 when 'maxStreamBytes' then 2097152 when 'deadlineMs' then 240000 else 122880 end) then return false;end if;
 end loop;
 maximum:=ceil(((p->>'maxInputTokens')::numeric*2500000+(p->>'maxOutputTokens')::numeric*10000000)/1000000);
 return (p->>'maximumCostMicrousd')::numeric=maximum;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;

-- Exact current constraint; adding the column does not qualify any operation.
do $$ declare d text;begin
 select pg_get_constraintdef(oid) into d from pg_constraint where conrelid='fluid_private.logo_runtime_policies'::regclass and conname='logo_runtime_policies_operation_check';
 if d is distinct from $expected$CHECK ((operation = ANY (ARRAY['identity.logo_concept'::text, 'identity.logo_refine'::text, 'identity.logo_vectorize'::text, 'identity.logo_directions'::text, 'identity.logo_export'::text])))$expected$ then raise exception 'proposal_policy_constraint_predecessor_mismatch' using errcode='55000';end if;
end $$;
alter table fluid_private.logo_runtime_policies drop constraint logo_runtime_policies_operation_check;
alter table fluid_private.logo_runtime_policies add constraint logo_runtime_policies_operation_check check(operation in('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose'));
alter table fluid_private.logo_runtime_policies add column text_policy jsonb;
alter table fluid_private.logo_runtime_policies add constraint logo_vector_proposal_text_policy check(
 ((operation='identity.logo_vector_propose')=(text_policy is not null)) and
 (text_policy is null or (fluid_private.valid_logo_vector_proposal_text_policy(text_policy) and subscription_policy is null
  and provider='openai' and model=text_policy->>'model' and handler_version='logo-vector-propose-v1' and engine is null
  and max_cost_microusd=(text_policy->>'maximumCostMicrousd')::bigint
  and policy_identity=encode(sha256(convert_to(text_policy::text,'UTF8')),'hex')) is true)
);

create function fluid_private.quote_logo_vector_proposal(p_project_id uuid,p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid:=fluid_private.logo_asset_web_owner();request jsonb:=p_evidence->'request';context jsonb:=p_evidence->'context';
 base jsonb;brief jsonb;workspace jsonb;font jsonb;stored_font jsonb;summary jsonb;component jsonb;target jsonb;
 policy fluid_private.logo_runtime_policies;account public.usage_accounts;sources jsonb;input_hash text;context_hash text;
 quote_id uuid:=gen_random_uuid();expires timestamptz:=clock_timestamp()+interval '5 minutes';result jsonb;
begin
 if fluid_private.standalone_keys(p_evidence,array['version','request','context','baseRevision','brief','fonts']) is distinct from true
  or p_evidence->'version' is distinct from '1'::jsonb or octet_length(p_evidence::text)>1048576
  or fluid_private.standalone_keys(request,array['operation','expected','baseVectorRevisionId','instruction','targetComponentIds']) is distinct from true
  or request->>'operation' is distinct from 'propose_vector_edit' or fluid_private.logo_uuid(request->'baseVectorRevisionId') is distinct from true
  or fluid_private.standalone_text(request->'instruction',4000,1) is distinct from true or nullif(btrim(request->>'instruction'),'') is null
  or jsonb_typeof(request->'targetComponentIds') is distinct from 'array' or jsonb_array_length(request->'targetComponentIds') not between 1 and 64
  or (select count(*)<>count(distinct value) from jsonb_array_elements(request->'targetComponentIds')) then raise exception 'invalid_vector_proposal_quote' using errcode='22023';end if;
 if fluid_private.standalone_keys(context,array['version','ownerId','projectId','baseVectorRevisionId','documentHash','source','viewBox','locks','inputRevisions','brief','components','fonts','targetComponentIds','allowedOperations']) is distinct from true
  or octet_length(context::text)>65536 or context->'version' is distinct from '1'::jsonb or context->>'ownerId' is distinct from owner::text or context->>'projectId' is distinct from p_project_id::text
  or context->'baseVectorRevisionId' is distinct from request->'baseVectorRevisionId' or context->'targetComponentIds' is distinct from request->'targetComponentIds'
  or jsonb_typeof(context->'components') is distinct from 'array' or jsonb_array_length(context->'components') not between 1 and 64
  or jsonb_typeof(context->'fonts') is distinct from 'array' or jsonb_array_length(context->'fonts')>100
  or jsonb_typeof(p_evidence->'fonts') is distinct from 'array' or jsonb_array_length(p_evidence->'fonts')<>jsonb_array_length(context->'fonts') then raise exception 'invalid_vector_proposal_context' using errcode='22023';end if;
 if(select count(*)<>count(distinct value->>'id') from jsonb_array_elements(context->'components')) or(select count(*)<>count(distinct value->>'id') from jsonb_array_elements(context->'fonts')) or(select count(*)<>count(distinct value->>'id') from jsonb_array_elements(p_evidence->'fonts')) then raise exception 'invalid_vector_proposal_context' using errcode='22023';end if;
 for component in select value from jsonb_array_elements(context->'components') loop
  if fluid_private.standalone_keys(component,array['id','role','editingKind','transform','paintedBounds','localPaintedBounds','paint','text','allowedOperations']) is distinct from true then raise exception 'invalid_vector_proposal_component' using errcode='22023';end if;
 end loop;
 for target in select value from jsonb_array_elements(request->'targetComponentIds') loop
  if jsonb_typeof(target) is distinct from 'string' or target#>>'{}'!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' or not exists(select 1 from jsonb_array_elements(context->'components') c where c->'id'=target) then raise exception 'invalid_vector_proposal_target' using errcode='22023';end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended(owner::text,723902));
 perform 1 from public.projects where id=p_project_id and owner_id=owner for update;if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 workspace:=fluid_private.logo_workspace_json(owner,p_project_id);
 if workspace->'heads' is distinct from request->'expected' or fluid_private.logo_current_vector_id(owner,p_project_id) is distinct from (request->>'baseVectorRevisionId')::uuid then raise exception 'logo_quote_stale' using errcode='PT409';end if;
 select record into base from public.logo_vector_revisions where id=(request->>'baseVectorRevisionId')::uuid and owner_id=owner and project_id=p_project_id;
 if base is null or base is distinct from p_evidence->'baseRevision' or context->'documentHash' is distinct from base->'documentHash'
  or context->'locks' is distinct from base->'locks' or context->'source' is distinct from base->'source' or context->'inputRevisions' is distinct from base->'inputRevisions'
  or context->'viewBox' is distinct from base#>'{proof,viewBox}' or fluid_private.logo_vector_proof_valid(base->'proof') is distinct from true
  or base->'documentHash' is distinct from base#>'{documentAsset,contentHash}' or base->'documentHash' is distinct from base#>'{proof,documentHash}' then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 if exists(select 1 from jsonb_array_elements(base->'inputRevisions') i left join public.logo_stage_heads h on h.owner_id=owner and h.project_id=p_project_id and h.stage=i->>'stage' where h.revision_id::text is distinct from i->>'id') then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 select r.record into brief from public.logo_stage_revisions r where r.id=(context#>>'{brief,id}')::uuid and r.owner_id=owner and r.project_id=p_project_id and r.stage='brief_references';
 if brief is null or brief is distinct from p_evidence->'brief' or context->'brief' is distinct from jsonb_build_object('id',brief->'id','revision',brief->'revision','inputHash',brief->'inputHash','name',brief#>'{payload,name}')
  or not exists(select 1 from jsonb_array_elements(base->'inputRevisions') i where i->>'stage'='brief_references' and i->'id'=brief->'id' and i->'revision'=brief->'revision') then raise exception 'logo_proposal_brief_changed' using errcode='PT409';end if;
 for font in select value from jsonb_array_elements(p_evidence->'fonts') loop
  select record into stored_font from public.logo_font_records where record_id=(font->>'id')::uuid and owner_id=owner and project_id=p_project_id;
  select value into summary from jsonb_array_elements(context->'fonts') f where f->'id'=font->'id';
  if stored_font is null or font is distinct from stored_font or summary is null
   or summary->'family' is distinct from font->'family' or summary->'source' is distinct from font->'source'
   or summary->'assetVersionId' is distinct from font#>'{asset,versionId}' or summary->'fontContentHash' is distinct from font#>'{asset,contentHash}'
   or summary->'rightsEvidenceId' is distinct from font#>'{rights,id}' or font#>>'{rights,commercialUse}' is distinct from 'allowed'
   or font#>>'{rights,sourceKind}' is distinct from 'reviewed_license' or font#>'{rights,reviewedAt}'='null'::jsonb
   or font#>>'{rights,permissions,render}' is distinct from 'allowed' or font#>>'{rights,permissions,outline}' is distinct from 'allowed' then raise exception 'logo_proposal_font_changed' using errcode='PT409';end if;
 end loop;
 select * into policy from fluid_private.logo_runtime_policies where owner_id=owner and operation='identity.logo_vector_propose' and enabled for share;
 if not found or fluid_private.valid_logo_vector_proposal_text_policy(policy.text_policy) is distinct from true then raise exception 'logo_policy_unavailable' using errcode='55000';end if;
 -- Known frozen AI-safe payload only. Final prompt/schema/token sizing is a later dispatch gate.
 if octet_length(jsonb_build_object('context',context,'instruction',request->'instruction')::text)>(policy.text_policy->>'maxInputBytes')::integer then raise exception 'logo_proposal_input_too_large' using errcode='22023';end if;
 if not fluid_private.logo_operation_ready(owner,policy.operation) then raise exception 'logo_runtime_unavailable' using errcode='55000';end if;
 select * into account from public.usage_accounts where owner_id=owner for share;
 if not found or policy.max_cost_microusd>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)-account.reserved_microusd then raise exception 'logo_budget_exceeded' using errcode='PT409';end if;
 context_hash:=encode(sha256(convert_to(context::text,'UTF8')),'hex');
 sources:=jsonb_build_object('context',context,'contextHash',context_hash,'baseRevision',base,'brief',brief,'fonts',p_evidence->'fonts');
 input_hash:=encode(sha256(convert_to(jsonb_build_object('request',request,'sources',sources,'policy',fluid_private.logo_policy_descriptor(policy))::text,'UTF8')),'hex');
 result:=jsonb_build_object('id',quote_id,'ownerId',owner,'projectId',p_project_id,'request',request,'inputHash',input_hash,'expected',request->'expected','policyIdentity',policy.policy_identity,'handlerVersion',policy.handler_version,'provider',policy.provider,'model',policy.model,'engine',null,'estimatedCostMicrousd',policy.max_cost_microusd,'maxCostMicrousd',policy.max_cost_microusd,'externalProviderCostMicrousd',policy.max_cost_microusd,'expiresAt',to_char(expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'conceptPlan',null,'targetSlotIds','[]'::jsonb,'textPolicy',policy.text_policy);
 insert into public.logo_cost_quotes(id,owner_id,project_id,operation,record,input_revisions,source_inputs,expires_at) values(quote_id,owner,p_project_id,policy.operation,result,base->'inputRevisions',sources,expires);
 return result;
end $$;

-- Exact predecessor: supabase/migrations/20261007020000_logo_directions_subscription.sql; preserve existing ACL and metadata.
do $patch$ declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='fluid_private.logo_policy_descriptor(fluid_private.logo_runtime_policies)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '55c16dea0668913c17f03762f4b37d891acd1031bf4af779f3024705895e43b9' then raise exception 'proposal_quote_predecessor_mismatch: fluid_private.logo_policy_descriptor(fluid_private.logo_runtime_policies)' using errcode='55000';end if;
 definition:=pg_get_functiondef('fluid_private.logo_policy_descriptor(fluid_private.logo_runtime_policies)'::regprocedure);execute replace(definition,body,$replacement$
 select jsonb_build_object('operation',p.operation,'policyIdentity',p.policy_identity,'handlerVersion',p.handler_version,'provider',p.provider,'model',p.model,'engine',p.engine,'maxCostMicrousd',p.max_cost_microusd)
 || case when p.subscription_policy is null then '{}'::jsonb else jsonb_build_object('billingMode','chatgpt_subscription','policy',p.subscription_policy) end
 || case when p.text_policy is null then '{}'::jsonb else jsonb_build_object('textPolicy',p.text_policy) end
$replacement$);
end $patch$;

-- Exact predecessor: supabase/migrations/20261007020000_logo_directions_subscription.sql; preserve existing ACL and metadata.
do $patch$ declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.report_logo_worker_ready(text,jsonb,integer)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '5ecdf90ca0b5359a0ad841510617a2ea0697eb2e7acbfcbc9e7aec06548187b3' then raise exception 'proposal_quote_predecessor_mismatch: public.report_logo_worker_ready(text,jsonb,integer)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.report_logo_worker_ready(text,jsonb,integer)'::regprocedure);execute replace(definition,body,$replacement$
declare owner uuid:=fluid_private.logo_worker_owner();login_oid oid;item jsonb;policy fluid_private.logo_runtime_policies;valid boolean:=true;
begin
 if owner is null then raise exception 'logo_worker_unauthorized' using errcode='42501';end if;
 if p_worker is null or length(p_worker) not between 1 and 200 or length(btrim(p_worker))=0 then raise exception 'invalid_logo_worker_id' using errcode='22023';end if;
 select oid into login_oid from pg_catalog.pg_roles where rolname=session_user;
 -- Serialize complete replacements for one actual login/worker, including empty
 -- and rejected reports. No advisory lock or row lock spans runtime/provider I/O.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(login_oid::text||':'||p_worker,0));
 -- Lock policies before readiness rows, matching policy invalidation. This also
 -- prevents a concurrent policy update from reviving a stale report at commit.
 perform 1 from fluid_private.logo_runtime_policies where owner_id=owner order by operation for share;
 delete from fluid_private.logo_worker_readiness where role_oid=login_oid and worker_id=p_worker;
 -- A well-identified but malformed report also withdraws its old advertisement.
 -- Returning false is deliberate: raising would roll the withdrawal back.
 if p_seconds is null or p_seconds not between 1 and 90 or jsonb_typeof(p_manifest) is distinct from 'array' or octet_length(p_manifest::text)>32768 then return false;end if;
 if jsonb_array_length(p_manifest)>6 or (select count(*)<>count(distinct value->>'operation') from jsonb_array_elements(p_manifest)) then return false;end if;
 for item in select value from jsonb_array_elements(p_manifest) loop
  if fluid_private.standalone_keys(item,case when item?'textPolicy' then array['operation','policyIdentity','handlerVersion','provider','model','engine','maxCostMicrousd','textPolicy'] when item?'billingMode' or item?'policy' then array['operation','policyIdentity','handlerVersion','provider','model','engine','maxCostMicrousd','billingMode','policy'] else array['operation','policyIdentity','handlerVersion','provider','model','engine','maxCostMicrousd'] end) is distinct from true then valid:=false;exit;end if;
  select * into policy from fluid_private.logo_runtime_policies where owner_id=owner and operation=item->>'operation' and enabled;
  if not found or item is distinct from fluid_private.logo_policy_descriptor(policy) or (policy.subscription_policy is not null and not fluid_private.logo_subscription_registration_ready(owner,policy.subscription_policy)) then valid:=false;exit;end if;
 end loop;
 if not valid then return false;end if;
 insert into fluid_private.logo_worker_readiness(role_oid,worker_id,owner_id,operation,descriptor,ready_until)
 select login_oid,p_worker,owner,value->>'operation',value,clock_timestamp()+make_interval(secs=>p_seconds) from jsonb_array_elements(p_manifest);
 return true;
end $replacement$);
end $patch$;

-- Exact predecessor: supabase/migrations/20261007020000_logo_directions_subscription.sql; preserve existing ACL and metadata.
do $patch$ declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.quote_logo_operation(uuid,jsonb)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '658a66ae8dd7ee542abd29de57b500332f6f3904d5cb14aae7ef7fd8128e20ff' then raise exception 'proposal_quote_predecessor_mismatch: public.quote_logo_operation(uuid,jsonb)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.quote_logo_operation(uuid,jsonb)'::regprocedure);execute replace(definition,body,$replacement$
declare owner uuid:=auth.uid();workspace jsonb;brief public.logo_stage_revisions;snapshot jsonb;op text;policy fluid_private.logo_runtime_policies;batch public.logo_concept_batches;slot public.logo_concept_slots;
 qid uuid:=gen_random_uuid();plan jsonb;targets jsonb:='[]';sources jsonb;inputs jsonb;inputhash text;result jsonb;expires timestamptz:=clock_timestamp()+interval '5 minutes';count integer:=1;prior bigint;target jsonb;source jsonb;direction jsonb;total numeric;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner::text,723902));
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
 when 'directions' then
  if not fluid_private.standalone_keys(p_input,array['operation','expected','approvedLogoId']) or not fluid_private.logo_uuid(p_input->'approvedLogoId') then raise exception 'invalid_logo_directions' using errcode='22023';end if;
  op:='identity.logo_directions';direction:=fluid_private.logo_prepare_direction_sources(owner,p_project_id,(p_input->>'approvedLogoId')::uuid);inputs:=direction->'inputRevisions';
 when 'vectorize' then
  if not fluid_private.standalone_keys(p_input,array['operation','expected','source','settings']) or not fluid_private.logo_trace_settings_valid(p_input->'settings') then raise exception 'invalid_logo_vectorize' using errcode='22023';end if;
  op:='identity.logo_vectorize';source:=fluid_private.resolve_logo_raster_source(owner,p_project_id,p_input->'source');inputs:=source->'inputRevisions';
 else raise exception 'logo_operation_unavailable' using errcode='55000';
 end case;
 select * into policy from fluid_private.logo_runtime_policies where owner_id=owner and operation=op and enabled;if not found then raise exception 'logo_policy_unavailable' using errcode='55000';end if;
 if not fluid_private.logo_operation_ready(owner,op) then raise exception 'logo_runtime_unavailable' using errcode='55000';end if;
 if policy.subscription_policy is not null and not fluid_private.logo_subscription_quota_available(owner,policy.subscription_policy) then raise exception 'logo_subscription_quota_unavailable' using errcode='55000';end if;
 total:=policy.max_cost_microusd::numeric*count;if total>9007199254740991 then raise exception 'logo_cost_overflow' using errcode='22003';end if;
 snapshot:=fluid_private.logo_snapshot_json(owner,p_project_id,brief.reference_snapshot_id);
 sources:=jsonb_build_object('brief',brief.record,'referenceSnapshot',snapshot,'raster',source);if direction is not null then sources:=sources||jsonb_build_object('direction',direction);end if;
 inputhash:=encode(sha256(convert_to(jsonb_build_object('request',p_input,'sources',sources,'policy',case when policy.subscription_policy is null then to_jsonb(policy)-'subscription_policy'-'text_policy' else to_jsonb(policy)-'text_policy' end,'plan',plan,'targets',targets)::text,'UTF8')),'hex');
 result:=jsonb_build_object('id',qid,'ownerId',owner,'projectId',p_project_id,'request',p_input,'inputHash',inputhash,'expected',p_input->'expected','policyIdentity',policy.policy_identity,'handlerVersion',policy.handler_version,'provider',policy.provider,'model',policy.model,'engine',case when policy.engine is null then null else policy.engine||jsonb_build_object('settingsHash',encode(sha256(convert_to((p_input->'settings')::text,'UTF8')),'hex')) end,'estimatedCostMicrousd',total,'maxCostMicrousd',total,'externalProviderCostMicrousd',case when policy.provider is null then 0 else total end,'expiresAt',to_char(expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'conceptPlan',plan,'targetSlotIds',targets);
 if policy.subscription_policy is not null then
  result:=result||jsonb_build_object('billingMode','chatgpt_subscription','policy',policy.subscription_policy);
  if octet_length((sources->'direction')::text)+octet_length(result::text)>(policy.subscription_policy#>>'{limits,maxInputBytes}')::integer then raise exception 'logo_subscription_input_too_large' using errcode='22023';end if;
 end if;
 insert into public.logo_cost_quotes values(qid,owner,p_project_id,op,result,inputs,sources,expires);return result;
end $replacement$);
end $patch$;

do $$ declare signature text;r record;object_id oid;begin
 foreach signature in array array['fluid_private.valid_logo_vector_proposal_text_policy(jsonb)','fluid_private.quote_logo_vector_proposal(uuid,jsonb)'] loop
  object_id:=signature::regprocedure;
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
commit;
