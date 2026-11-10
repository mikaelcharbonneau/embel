-- UNAPPLIED ADMISSION-ONLY CONTINUATION after the two proposal candidates.
-- No seeds, grants, provider or host registration. Typed evidence is deliberately
-- unavailable until a separate append-only observation/completion transition.
begin;

create function fluid_private.valid_logo_vector_proposal_job_input(v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text;target jsonb;
begin
 if fluid_private.standalone_keys(v,array['version','ownerId','projectId','operation','requestKey','quoteId','policyIdentity','handlerVersion','inputHash','baseVectorRevisionId','contextHash','instruction','targetComponentIds','textPolicy']) is distinct from true
  or v->'version' is distinct from '2'::jsonb or v->>'operation' is distinct from 'identity.logo_vector_propose'
  or v->>'handlerVersion' is distinct from 'logo-vector-propose-v1' or fluid_private.valid_logo_vector_proposal_text_policy(v->'textPolicy') is distinct from true
  or fluid_private.standalone_text(v->'instruction',4000,1) is distinct from true or nullif(btrim(v->>'instruction'),'') is null
  or jsonb_typeof(v->'targetComponentIds') is distinct from 'array' or jsonb_array_length(v->'targetComponentIds') not between 1 and 64
  or(select count(*)<>count(distinct value) from jsonb_array_elements(v->'targetComponentIds')) then return false;end if;
 foreach k in array array['ownerId','projectId','requestKey','quoteId','baseVectorRevisionId'] loop if fluid_private.logo_uuid(v->k) is distinct from true then return false;end if;end loop;
 foreach k in array array['policyIdentity','inputHash','contextHash'] loop if jsonb_typeof(v->k) is distinct from 'string' or v->>k!~'^[0-9a-f]{64}$' then return false;end if;end loop;
 for target in select value from jsonb_array_elements(v->'targetComponentIds') loop if jsonb_typeof(target) is distinct from 'string' or target#>>'{}'!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' then return false;end if;end loop;
 return v->>'policyIdentity'=encode(sha256(convert_to((v->'textPolicy')::text,'UTF8')),'hex');
exception when others then return false;
end $$;

-- This verifies immutable quoted bytes, without imposing current readiness.
-- Later evidence retention may legitimately refer to an earlier owned basis.
create function fluid_private.logo_vector_proposal_quote_binding(q public.logo_cost_quotes) returns boolean
language plpgsql immutable set search_path='' as $$
declare c jsonb:=q.source_inputs->'context';p jsonb:=q.record->'textPolicy';descriptor jsonb;
begin
 if q.id is null or q.operation is distinct from 'identity.logo_vector_propose' or q.record->>'id' is distinct from q.id::text
  or q.record->>'ownerId' is distinct from q.owner_id::text or q.record->>'projectId' is distinct from q.project_id::text
  or q.record#>>'{request,operation}' is distinct from 'propose_vector_edit'
  or q.record->'expected' is distinct from q.record#>'{request,expected}'
  or q.record?'billingMode' or q.record?'policy' or q.record->>'handlerVersion' is distinct from 'logo-vector-propose-v1'
  or q.record->>'provider' is distinct from 'openai' or q.record->'model' is distinct from p->'model' or q.record->'engine' is distinct from 'null'::jsonb
  or fluid_private.valid_logo_vector_proposal_text_policy(p) is distinct from true
  or q.record->>'policyIdentity' is distinct from encode(sha256(convert_to(p::text,'UTF8')),'hex')
  or q.record->'maxCostMicrousd' is distinct from p->'maximumCostMicrousd' or q.record->'externalProviderCostMicrousd' is distinct from p->'maximumCostMicrousd'
  or fluid_private.standalone_keys(q.source_inputs,array['context','contextHash','baseRevision','brief','fonts']) is distinct from true
  or q.source_inputs->>'contextHash' is distinct from encode(sha256(convert_to(c::text,'UTF8')),'hex')
  or octet_length(c::text)>65536 or c->>'ownerId' is distinct from q.owner_id::text or c->>'projectId' is distinct from q.project_id::text
  or c->'baseVectorRevisionId' is distinct from q.record#>'{request,baseVectorRevisionId}'
  or c->'targetComponentIds' is distinct from q.record#>'{request,targetComponentIds}'
  or c->'inputRevisions' is distinct from q.input_revisions or q.input_revisions is distinct from q.source_inputs#>'{baseRevision,inputRevisions}'
  or octet_length(jsonb_build_object('context',c,'instruction',q.record#>'{request,instruction}')::text)>(p->>'maxInputBytes')::integer then return false;end if;
 descriptor:=jsonb_build_object('operation',q.operation,'policyIdentity',q.record->'policyIdentity','handlerVersion',q.record->'handlerVersion','provider',q.record->'provider','model',q.record->'model','engine',null,'maxCostMicrousd',q.record->'maxCostMicrousd','textPolicy',p);
 return q.record->>'inputHash'=encode(sha256(convert_to(jsonb_build_object('request',q.record->'request','sources',q.source_inputs,'policy',descriptor)::text,'UTF8')),'hex');
exception when others then return false;
end $$;

create function fluid_private.logo_vector_proposal_quote_current(q public.logo_cost_quotes,p fluid_private.logo_runtime_policies) returns boolean
language plpgsql stable set search_path='' as $$
declare base jsonb;brief jsonb;f jsonb;stored jsonb;c jsonb:=q.source_inputs->'context';
begin
 if fluid_private.logo_vector_proposal_quote_binding(q) is distinct from true or p.owner_id is distinct from q.owner_id or p.operation is distinct from q.operation
  or not p.enabled or p.text_policy is distinct from q.record->'textPolicy' or p.policy_identity is distinct from q.record->>'policyIdentity'
  or p.handler_version is distinct from q.record->>'handlerVersion' or p.provider is distinct from q.record->>'provider' or p.model is distinct from q.record->>'model'
  or p.engine is not null or p.max_cost_microusd::numeric is distinct from (q.record->>'maxCostMicrousd')::numeric
  or q.record->'expected' is distinct from (fluid_private.logo_workspace_json(q.owner_id,q.project_id)->'heads')
  or fluid_private.logo_current_vector_id(q.owner_id,q.project_id)::text is distinct from q.record#>>'{request,baseVectorRevisionId}' then return false;end if;
 select record into base from public.logo_vector_revisions where id=(q.record#>>'{request,baseVectorRevisionId}')::uuid and owner_id=q.owner_id and project_id=q.project_id;
 if base is null or base is distinct from q.source_inputs->'baseRevision' or c->'documentHash' is distinct from base->'documentHash' or c->'locks' is distinct from base->'locks' or c->'source' is distinct from base->'source' then return false;end if;
 if exists(select 1 from jsonb_array_elements(q.input_revisions) i left join public.logo_stage_heads h on h.owner_id=q.owner_id and h.project_id=q.project_id and h.stage=i->>'stage' where h.revision_id::text is distinct from i->>'id') then return false;end if;
 select record into brief from public.logo_stage_revisions where id=(q.source_inputs#>>'{brief,id}')::uuid and owner_id=q.owner_id and project_id=q.project_id and stage='brief_references';
 if brief is null or brief is distinct from q.source_inputs->'brief' then return false;end if;
 if jsonb_typeof(q.source_inputs->'fonts') is distinct from 'array' or jsonb_array_length(q.source_inputs->'fonts')>100 then return false;end if;
 for f in select value from jsonb_array_elements(q.source_inputs->'fonts') loop
  select record into stored from public.logo_font_records where record_id=(f->>'id')::uuid and owner_id=q.owner_id and project_id=q.project_id;
  if stored is null or stored is distinct from f or f#>>'{rights,commercialUse}' is distinct from 'allowed' or f#>>'{rights,sourceKind}' is distinct from 'reviewed_license'
   or f#>>'{rights,permissions,render}' is distinct from 'allowed' or f#>>'{rights,permissions,outline}' is distinct from 'allowed' then return false;end if;
 end loop;return true;
exception when others then return false;
end $$;

create function fluid_private.logo_vector_proposal_job_quote_matches(j public.jobs,q public.logo_cost_quotes) returns boolean
language plpgsql stable set search_path='' as $$
begin
 if j.id is null or j.operation is distinct from 'identity.logo_vector_propose' or j.billing_mode is distinct from 'openai_api' or j.policy_identity is not null
  or fluid_private.valid_logo_vector_proposal_job_input(j.input) is distinct from true or fluid_private.logo_vector_proposal_quote_binding(q) is distinct from true
  or q.owner_id is distinct from j.owner_id or q.project_id is distinct from j.project_id or q.id::text is distinct from j.input->>'quoteId'
  or j.input->>'ownerId' is distinct from j.owner_id::text or j.input->>'projectId' is distinct from j.project_id::text
  or j.input_hash is distinct from q.record->>'inputHash' or j.input->>'inputHash' is distinct from j.input_hash
  or j.input->'textPolicy' is distinct from q.record->'textPolicy' or j.input->'policyIdentity' is distinct from q.record->'policyIdentity'
  or j.input->'handlerVersion' is distinct from q.record->'handlerVersion' or j.input->'contextHash' is distinct from q.source_inputs->'contextHash'
  or j.input->'baseVectorRevisionId' is distinct from q.record#>'{request,baseVectorRevisionId}'
  or j.input->'instruction' is distinct from q.record#>'{request,instruction}' or j.input->'targetComponentIds' is distinct from q.record#>'{request,targetComponentIds}'
  or j.input_revision::numeric is distinct from (q.record#>>'{expected,projectRevision}')::numeric or j.max_attempts<>1
  or j.reserved_cost_microusd::numeric is distinct from (q.record->>'maxCostMicrousd')::numeric
  or j.plan_manifest is distinct from jsonb_build_array(jsonb_build_object('key','propose-vector-edit','maximumCostMicrousd',j.reserved_cost_microusd))
  or j.plan_fingerprint is distinct from encode(sha256(convert_to(j.plan_manifest::text,'UTF8')),'hex') or j.plan_registered_at is null then return false;end if;
 return exists(select 1 from public.logo_operation_requests r where r.owner_id=j.owner_id and r.project_id=j.project_id and r.quote_id=q.id and r.request_key::text=j.input->>'requestKey'
  and r.receipt->>'operation'=j.operation and r.receipt->'jobIds'=jsonb_build_array(j.id) and r.receipt->>'inputHash'=j.input_hash
  and r.input->'quoteId'=j.input->'quoteId' and r.input->'expected'=q.record->'expected' and(r.input->>'acceptedMaxCostMicrousd')::numeric>=j.reserved_cost_microusd);
exception when others then return false;
end $$;

-- Preserve the subscription-only policy_identity column contract unchanged.
do $$declare d text;begin
 select pg_get_constraintdef(oid) into d from pg_constraint where conrelid='public.jobs'::regclass and conname='logo_subscription_job_scope';
 if encode(sha256(convert_to(d,'UTF8')),'hex') is distinct from '47794cdabebc93fb3534a82ea7c3feb493cb074cf9bf93119d678837fe28eb8a' then raise exception 'proposal_job_scope_predecessor_mismatch' using errcode='55000';end if;
end $$;
alter table public.jobs drop constraint logo_subscription_job_scope;
alter table public.jobs add constraint logo_subscription_job_scope check (
 operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose') or (
  (billing_mode='openai_api' and not(input?'billingMode') and not(input?'policy')) or
  (operation='identity.logo_directions' and billing_mode='chatgpt_subscription' and fluid_private.valid_logo_directions_subscription_policy(input->'policy') and input->>'policyIdentity'=policy_identity and input->>'handlerVersion'='logo-directions-v1')
 ) is true);
alter table public.jobs add constraint logo_vector_proposal_job_scope check(operation<>'identity.logo_vector_propose' or (
 billing_mode='openai_api' and policy_identity is null and max_attempts=1 and fluid_private.valid_logo_vector_proposal_job_input(input)
 and input->>'ownerId'=owner_id::text and input->>'projectId'=project_id::text and input->>'inputHash'=input_hash
 and reserved_cost_microusd=(input#>>'{textPolicy,maximumCostMicrousd}')::bigint
 and plan_manifest=jsonb_build_array(jsonb_build_object('key','propose-vector-edit','maximumCostMicrousd',reserved_cost_microusd))
 and plan_fingerprint=encode(sha256(convert_to(plan_manifest::text,'UTF8')),'hex') and plan_registered_at is not null
) is true);

-- Exact predecessor supabase/migrations/20261007020000_logo_directions_subscription.sql; preserve existing signature metadata/ACL.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.admit_logo_operation(uuid,jsonb)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '6567f6572b4744dd6e9fa78144de8c7c9b88aa86490fc3bf2ed719d88dee8188' then raise exception 'proposal_admission_predecessor_mismatch: public.admit_logo_operation(uuid,jsonb)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.admit_logo_operation(uuid,jsonb)'::regprocedure);execute replace(definition,body,$replacement$
declare owner uuid:=auth.uid();q public.logo_cost_quotes;r public.logo_operation_requests;policy fluid_private.logo_runtime_policies;batch uuid;jobid uuid;attempt uuid;prior public.logo_concept_attempts;slot public.logo_concept_slots;target jsonb;slotplan jsonb;input jsonb;manifest jsonb;jobids jsonb:='[]';result jsonb;cap bigint;cost bigint;raster uuid;account public.usage_accounts;op text;created_job public.jobs;rejected public.logo_operation_rejections;failure_message text;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not fluid_private.standalone_keys(p_input,array['requestKey','quoteId','acceptedMaxCostMicrousd','expected']) or not fluid_private.logo_uuid(p_input->'requestKey') or not fluid_private.logo_uuid(p_input->'quoteId') or jsonb_typeof(p_input->'acceptedMaxCostMicrousd') is distinct from 'number' or (p_input->>'acceptedMaxCostMicrousd')::numeric not between 0 and 9007199254740991 or trunc((p_input->>'acceptedMaxCostMicrousd')::numeric)<>(p_input->>'acceptedMaxCostMicrousd')::numeric then raise exception 'invalid_logo_intent' using errcode='22023';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner::text,723902));
 perform 1 from public.projects where id=p_project_id and owner_id=owner for update;if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into r from public.logo_operation_requests where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid;
 if found then if r.input is distinct from p_input then raise exception 'logo_request_conflict' using errcode='PT409';end if;return r.receipt;end if;
 select * into rejected from public.logo_operation_rejections where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid;
 if found then if rejected.input is distinct from p_input then raise exception 'logo_request_conflict' using errcode='PT409';end if;return rejected.receipt;end if;
 if exists(select 1 from public.logo_workspace_requests where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 -- The inner block rolls back every partial child write before recording rejection.
 begin
 select * into q from public.logo_cost_quotes where id=(p_input->>'quoteId')::uuid and owner_id=owner and project_id=p_project_id for update;if not found then raise exception 'logo_quote_not_found' using errcode='P0002';end if;
 if exists(select 1 from public.logo_operation_requests where quote_id=q.id) then raise exception 'logo_quote_already_used' using errcode='PT409';end if;
 if q.expires_at<=clock_timestamp() or q.record->'expected' is distinct from p_input->'expected' or fluid_private.logo_workspace_json(owner,p_project_id)->'heads' is distinct from p_input->'expected' then raise exception 'logo_quote_stale' using errcode='PT409';end if;
 select * into policy from fluid_private.logo_runtime_policies where owner_id=owner and operation=q.operation and enabled for share;
 if not found or policy.policy_identity is distinct from q.record->>'policyIdentity' or policy.handler_version is distinct from q.record->>'handlerVersion' or to_jsonb(policy.provider) is distinct from nullif(q.record->'provider','null') or to_jsonb(policy.model) is distinct from nullif(q.record->'model','null') or policy.engine is distinct from (nullif(q.record->'engine','null')-'settingsHash') or policy.max_cost_microusd::numeric*(case when q.operation='identity.logo_concept' then jsonb_array_length(q.record->'targetSlotIds') else 1 end)<>(q.record->>'maxCostMicrousd')::numeric then raise exception 'logo_policy_changed' using errcode='PT409';end if;
 if (policy.subscription_policy is null and (q.record?'billingMode' or q.record?'policy')) or (policy.subscription_policy is not null and (q.record->>'billingMode' is distinct from 'chatgpt_subscription' or q.record->'policy' is distinct from policy.subscription_policy)) then raise exception 'logo_policy_changed' using errcode='PT409';end if;
 if not fluid_private.logo_operation_ready(owner,q.operation) then raise exception 'logo_runtime_unavailable' using errcode='55000';end if;
 if policy.subscription_policy is not null then
  perform 1 from fluid_private.subscription_registrations where owner_id=owner and registration_id=policy.subscription_policy->>'registrationId' for share;
  if not fluid_private.logo_subscription_registration_ready(owner,policy.subscription_policy) then raise exception 'logo_runtime_unavailable' using errcode='55000';end if;
  if not fluid_private.logo_subscription_quota_available(owner,policy.subscription_policy) then raise exception 'logo_subscription_quota_unavailable' using errcode='55000';end if;
 end if;
 cap:=(p_input->>'acceptedMaxCostMicrousd')::bigint;cost:=(q.record->>'maxCostMicrousd')::bigint;if cap<cost then raise exception 'logo_cap_exceeded' using errcode='PT409';end if;
 if policy.subscription_policy is null then
  select * into account from public.usage_accounts where owner_id=owner for update;if not found or cost>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)-account.reserved_microusd then raise exception 'logo_budget_exceeded' using errcode='PT409';end if;
 end if;
 if q.operation='identity.logo_vector_propose' and fluid_private.logo_vector_proposal_quote_current(q,policy) is distinct from true then raise exception 'logo_proposal_source_changed' using errcode='PT409';end if;
 op:=q.record#>>'{request,operation}';
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
   input:=jsonb_build_object('version',2,'ownerId',owner,'projectId',p_project_id,'requestKey',p_input->'requestKey','quoteId',q.id,'policyIdentity',q.record->'policyIdentity','handlerVersion',q.record->'handlerVersion','inputHash',q.record->'inputHash','operation',q.operation,'batchId',batch,'slotId',slot.id,'attemptId',attempt,'attemptNumber',coalesce(prior.attempt_number,0)+1,'previousAttemptId',prior.id,'directionId',slot.direction_id,'plan',q.record->'conceptPlan','ordinal',slot.ordinal,'briefRevisionId',q.source_inputs#>'{brief,id}','referenceSnapshotId',q.source_inputs#>'{referenceSnapshot,id}','references',(select coalesce(jsonb_agg(x->'asset'),'[]') from jsonb_array_elements(q.source_inputs#>'{referenceSnapshot,references}') x));
   manifest:=jsonb_build_array(jsonb_build_object('key','logo-preview-v1:'||slot.id||':'||attempt,'maximumCostMicrousd',cost/jsonb_array_length(q.record->'targetSlotIds')));
   insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,plan_manifest,plan_fingerprint,plan_registered_at) values(jobid,owner,p_project_id,q.operation,(p_input#>>'{expected,projectRevision}')::integer,q.record->>'inputHash',input,'logo:'||jobid,cost/jsonb_array_length(q.record->'targetSlotIds'),3,manifest,encode(sha256(convert_to(manifest::text,'UTF8')),'hex'),clock_timestamp());
   insert into public.logo_concept_attempts values(attempt,owner,p_project_id,slot.id,jobid,(p_input->>'requestKey')::uuid,prior.id,coalesce(prior.attempt_number,0)+1,q.record->>'inputHash');jobids:=jobids||jsonb_build_array(jobid);
  end loop;
 else
  jobid:=gen_random_uuid();raster:=gen_random_uuid();input:=jsonb_build_object('version',2,'ownerId',owner,'projectId',p_project_id,'requestKey',p_input->'requestKey','quoteId',q.id,'policyIdentity',q.record->'policyIdentity','handlerVersion',q.record->'handlerVersion','inputHash',q.record->'inputHash','operation',q.operation);
  if q.operation='identity.logo_refine' then input:=input||jsonb_build_object('rasterRevisionId',raster,'instruction',q.record#>'{request,instruction}','briefRevisionId',q.source_inputs#>'{brief,id}','referenceSnapshotId',q.source_inputs#>'{referenceSnapshot,id}','source',jsonb_build_object('kind','preview','raster',q.record#>'{request,source}')); manifest:=jsonb_build_array(jsonb_build_object('key','generate-refinement','maximumCostMicrousd',cost));
  elsif q.operation='identity.logo_directions' then input:=input||jsonb_build_object('approvedLogoId',q.record#>'{request,approvedLogoId}','briefRevisionId',q.source_inputs#>'{direction,brief,id}','referenceSnapshotId',q.source_inputs#>'{direction,references,id}','fontVersionIds',(select coalesce(jsonb_agg(f->'id'),'[]') from jsonb_array_elements(q.source_inputs#>'{direction,permittedFonts}') f),'targetCount',3);manifest:=jsonb_build_array(jsonb_build_object('key','propose-directions','maximumCostMicrousd',cost));
  elsif q.operation='identity.logo_vector_propose' then input:=input||jsonb_build_object('baseVectorRevisionId',q.record#>'{request,baseVectorRevisionId}','contextHash',q.source_inputs->'contextHash','instruction',q.record#>'{request,instruction}','targetComponentIds',q.record#>'{request,targetComponentIds}','textPolicy',policy.text_policy);manifest:=jsonb_build_array(jsonb_build_object('key','propose-vector-edit','maximumCostMicrousd',cost));
  elsif q.operation='identity.logo_vectorize' then input:=input||jsonb_build_object('source',q.record#>'{request,source}','settings',q.record#>'{request,settings}','engine',(q.record->'engine')-'settingsHash');manifest:=jsonb_build_array(jsonb_build_object('key','convert-vector','maximumCostMicrousd',0));
  else raise exception 'logo_operation_unavailable' using errcode='55000';end if;
  if policy.subscription_policy is not null then
   input:=input||jsonb_build_object('billingMode','chatgpt_subscription','policy',policy.subscription_policy);
   if octet_length(input::text)+octet_length((q.source_inputs->'direction')::text)>(policy.subscription_policy#>>'{limits,maxInputBytes}')::integer then raise exception 'logo_subscription_input_too_large' using errcode='22023';end if;
  end if;
  insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,plan_manifest,plan_fingerprint,plan_registered_at,billing_mode,policy_identity) values(jobid,owner,p_project_id,q.operation,(p_input#>>'{expected,projectRevision}')::integer,q.record->>'inputHash',input,'logo:'||jobid,cost,case when q.operation='identity.logo_vector_propose' then 1 when policy.subscription_policy is null then 3 else 1 end,manifest,encode(sha256(convert_to(manifest::text,'UTF8')),'hex'),clock_timestamp(),case when policy.subscription_policy is null then 'openai_api' else 'chatgpt_subscription' end,case when policy.subscription_policy is null then null else policy.policy_identity end);
  if q.operation='identity.logo_directions' then select * into created_job from public.jobs where id=jobid;perform fluid_private.logo_freeze_direction_inputs(created_job,q.source_inputs->'direction');end if;
  if q.operation='identity.logo_refine' then insert into public.logo_raster_refinements(id,owner_id,project_id,request_key,job_id,source,logo_type,input_revisions) values(raster,owner,p_project_id,(p_input->>'requestKey')::uuid,jobid,q.record#>'{request,source}',q.source_inputs#>>'{raster,logoType}',q.input_revisions);end if;jobids:=jsonb_build_array(jobid);
 end if;
 if policy.subscription_policy is null then
 insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) select j.id,owner,p_project_id,j.reserved_cost_microusd from public.jobs j where j.id in (select (value#>>'{}')::uuid from jsonb_array_elements(jobids));
 update public.usage_accounts set reserved_microusd=reserved_microusd+cost where owner_id=owner;
 end if;
 result:=jsonb_build_object('ownerId',owner,'projectId',p_project_id,'requestKey',p_input->'requestKey','operation',q.operation,'batchId',batch,'jobIds',jobids,'inputHash',q.record->'inputHash');
 insert into public.logo_operation_requests(owner_id,project_id,request_key,quote_id,input,receipt) values(owner,p_project_id,(p_input->>'requestKey')::uuid,q.id,p_input,result);return result;
 exception when sqlstate 'PT409' then
  get stacked diagnostics failure_message=MESSAGE_TEXT;
  if failure_message in ('logo_quote_stale','logo_policy_changed','logo_cap_exceeded','logo_budget_exceeded','logo_retry_requires_confirmed_failure','logo_quote_already_used','logo_proposal_source_changed') then
   return fluid_private.reject_logo_admission(owner,p_project_id,p_input,'conflict');
  end if;raise;
 when sqlstate 'P0002' then
  get stacked diagnostics failure_message=MESSAGE_TEXT;
  if failure_message='logo_quote_not_found' then return fluid_private.reject_logo_admission(owner,p_project_id,p_input,'not_found');end if;raise;
 end;
end $replacement$);
end $patch$;

-- Exact predecessor supabase/migrations/20261007020000_logo_directions_subscription.sql; preserve existing signature metadata/ACL.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='fluid_private.logo_job_policy_matches(public.jobs,fluid_private.logo_runtime_policies)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from 'f1c029f2c7b2c838a6988abbe5fac4694dbddcbe42cac82033eb30655b9d50b3' then raise exception 'proposal_admission_predecessor_mismatch: fluid_private.logo_job_policy_matches(public.jobs,fluid_private.logo_runtime_policies)' using errcode='55000';end if;
 definition:=pg_get_functiondef('fluid_private.logo_job_policy_matches(public.jobs,fluid_private.logo_runtime_policies)'::regprocedure);execute replace(definition,body,$replacement$
declare q public.logo_cost_quotes;count numeric:=1;
begin
 if p.owner_id is distinct from j.owner_id or p.operation is distinct from j.operation or not p.enabled or p.policy_identity is distinct from j.input->>'policyIdentity' or p.handler_version is distinct from j.input->>'handlerVersion' then return false;end if;
 if j.operation='identity.logo_vector_propose' then
  select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
  return fluid_private.logo_vector_proposal_job_quote_matches(j,q) and fluid_private.logo_vector_proposal_quote_current(q,p);
 end if;
 if p.subscription_policy is null then
  if j.billing_mode<>'openai_api' or j.input?'billingMode' or j.input?'policy' then return false;end if;
 else
  if j.operation<>'identity.logo_directions' or j.billing_mode<>'chatgpt_subscription' or j.input->>'billingMode' is distinct from 'chatgpt_subscription' or j.input->'policy' is distinct from p.subscription_policy or j.policy_identity is distinct from p.policy_identity or j.max_attempts<>1 or j.reserved_cost_microusd<>0 or j.actual_cost_microusd<>0 then return false;end if;
 end if;
 if j.operation='identity.logo_export' then
  return p.handler_version='logo-export-v1' and p.provider is null and p.model is null and p.engine is null and p.max_cost_microusd=0 and j.reserved_cost_microusd=0 and not(j.input?'quoteId');
 end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id and operation=j.operation and record->>'inputHash'=j.input_hash;
 if not found then return false;end if;
 if p.subscription_policy is null then
  if q.record?'billingMode' or q.record?'policy' then return false;end if;
 elsif q.record->>'billingMode' is distinct from 'chatgpt_subscription' or q.record->'policy' is distinct from p.subscription_policy then return false;end if;
 if j.operation='identity.logo_concept' then count:=jsonb_array_length(q.record->'targetSlotIds');end if;
 return p.policy_identity=q.record->>'policyIdentity' and p.handler_version=q.record->>'handlerVersion'
  and to_jsonb(p.provider) is not distinct from nullif(q.record->'provider','null')
  and to_jsonb(p.model) is not distinct from nullif(q.record->'model','null')
  and p.engine is not distinct from (nullif(q.record->'engine','null')-'settingsHash')
  and p.max_cost_microusd::numeric*count=(q.record->>'maxCostMicrousd')::numeric;
end $replacement$);
end $patch$;

-- Exact predecessor supabase/migrations/20261007020000_logo_directions_subscription.sql; preserve existing signature metadata/ACL.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.claim_logo_job(text,integer)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '62bdab69d9ef76610fa52de869b5291ef582d3a5a2bd518b52d47dfe3d752d63' then raise exception 'proposal_admission_predecessor_mismatch: public.claim_logo_job(text,integer)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.claim_logo_job(text,integer)'::regprocedure);execute replace(definition,body,$replacement$
declare owner uuid:=fluid_private.logo_worker_owner();j public.jobs;account public.usage_accounts;pending_paid boolean;
begin
 if owner is null then raise exception 'logo_worker_unauthorized' using errcode='42501';end if;
 if p_seconds not between 10 and 300 or p_seconds is null or p_worker is null or length(p_worker) not between 1 and 200 then raise exception 'invalid_lease' using errcode='22023';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner::text,723902));
 select candidate.* into j from public.jobs candidate left join public.usage_accounts a on a.owner_id=candidate.owner_id
 where candidate.owner_id=owner and candidate.operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose') and candidate.state='queued' and candidate.attempts<candidate.max_attempts
 and fluid_private.logo_job_ready(candidate,p_worker)
 and (candidate.billing_mode='chatgpt_subscription' or (a.owner_id is not null and (a.reserved_microusd<=a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd) or not exists(
  select 1 from jsonb_array_elements(candidate.plan_manifest) planned where (planned->>'maximumCostMicrousd')::numeric>0 and not exists(select 1 from public.job_steps done where done.job_id=candidate.id and done.step_key=planned->>'key' and done.state='succeeded')))))
 order by candidate.created_at,candidate.id for update of candidate skip locked limit 1;
 if not found then return;end if;
 if not fluid_private.lock_logo_job_readiness(j,p_worker) then return;end if;
 -- Recheck after locking the chosen job. Completion may have recorded an
 -- overrun since the initial eligibility snapshot. Job -> account lock order
 -- agrees with step start/completion; no locks span provider work.
 select exists(select 1 from jsonb_array_elements(j.plan_manifest) planned where (planned->>'maximumCostMicrousd')::numeric>0 and not exists(select 1 from public.job_steps done where done.job_id=j.id and done.step_key=planned->>'key' and done.state='succeeded')) into pending_paid;
 if pending_paid then
  select * into account from public.usage_accounts where owner_id=owner for share;
  if not found or account.reserved_microusd>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd) then return;end if;
 end if;
 return query update public.jobs set state='running',worker_id=p_worker,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_seconds),attempts=attempts+1 where id=j.id returning *;
end $replacement$);
end $patch$;

-- Exact predecessor supabase/migrations/20261007011000_logo_durable_jobs.sql; preserve existing signature metadata/ACL.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='fluid_private.logo_lock_job(uuid,uuid)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '402b0f35d685954ca67705f26a1219834bd11d1afdeed306f432ef744760b871' then raise exception 'proposal_admission_predecessor_mismatch: fluid_private.logo_lock_job(uuid,uuid)' using errcode='55000';end if;
 definition:=pg_get_functiondef('fluid_private.logo_lock_job(uuid,uuid)'::regprocedure);execute replace(definition,body,$replacement$
declare j public.jobs; owner uuid:=fluid_private.logo_worker_owner();
begin
 if owner is null then raise exception 'logo_worker_unauthorized' using errcode='42501'; end if;
 select * into j from public.jobs where id=p_job and owner_id=owner and operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose') for update;
 if not found or j.lease_token is distinct from p_lease or p_lease is null or j.lease_expires_at<=clock_timestamp() or j.state not in ('running','cancel_requested') then raise exception 'lease_lost' using errcode='40001'; end if;
 return j;
end $replacement$);
end $patch$;

-- Exact predecessor supabase/migrations/20261007020000_logo_directions_subscription.sql; preserve existing signature metadata/ACL.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.begin_logo_job_step(uuid,uuid,text,text,bigint)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from 'a188bae5fee2c50527c874540e0289096f39d5d3ff82e5db47e54e5f7f7125f4' then raise exception 'proposal_admission_predecessor_mismatch: public.begin_logo_job_step(uuid,uuid,text,text,bigint)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.begin_logo_job_step(uuid,uuid,text,text,bigint)'::regprocedure);execute replace(definition,body,$replacement$
declare j public.jobs;s public.job_steps;account public.usage_accounts;
begin
 if fluid_private.logo_worker_owner() is null then raise exception 'logo_worker_unauthorized' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(fluid_private.logo_worker_owner()::text,723902));
 j:=fluid_private.logo_lock_job(p_job,p_lease);if j.state<>'running' then raise exception 'cancel_requested' using errcode='55000';end if;
 if not exists(select 1 from jsonb_array_elements(j.plan_manifest) m where m->>'key'=p_step and (m->>'maximumCostMicrousd')::bigint=p_cost) then raise exception 'plan_conflict' using errcode='40001';end if;
 select * into s from public.job_steps where job_id=j.id and step_key=p_step;
 if found then if s.state='succeeded' and s.request_key=p_key and s.reserved_cost_microusd=p_cost then return 'already_succeeded';end if;raise exception 'step_requires_reconciliation_or_new_job' using errcode='55000';end if;
 if j.operation='identity.logo_vector_propose' and (p_step is distinct from 'propose-vector-edit' or p_cost is distinct from j.reserved_cost_microusd or j.max_attempts<>1) then raise exception 'invalid_vector_proposal_step' using errcode='22023';end if;
 if j.operation='identity.logo_export' then
  if p_cost is distinct from 0 or j.reserved_cost_microusd<>0 or j.actual_cost_microusd<>0 or j.input ? 'quoteId' or p_step<>'prepare-export' or not exists(
   select 1 from fluid_private.logo_runtime_policies p where p.owner_id=j.owner_id and p.operation=j.operation and p.enabled and p.policy_identity=j.input->>'policyIdentity' and p.handler_version=j.input->>'handlerVersion' and p.handler_version='logo-export-v1' and p.provider is null and p.model is null and p.engine is null and p.max_cost_microusd=0) then raise exception 'logo_export_policy_revoked' using errcode='55000';end if;
  perform fluid_private.logo_export_input_revisions(j);
 elsif not exists(select 1 from public.logo_cost_quotes q join fluid_private.logo_runtime_policies p on p.owner_id=q.owner_id and p.operation=q.operation where q.id=(j.input->>'quoteId')::uuid and q.owner_id=j.owner_id and q.project_id=j.project_id and p.enabled and p.policy_identity=j.input->>'policyIdentity' and p.handler_version=j.input->>'handlerVersion') then raise exception 'logo_policy_revoked' using errcode='55000';end if;
 if not fluid_private.lock_logo_job_readiness(j,j.worker_id) then raise exception 'logo_runtime_unavailable' using errcode='55000';end if;
 if j.billing_mode='chatgpt_subscription' and (p_cost is distinct from 0 or octet_length(j.input::text)+(select octet_length(source::text) from public.logo_direction_inputs where job_id=j.id)>(j.input#>>'{policy,limits,maxInputBytes}')::integer) then raise exception 'invalid_subscription_cost_or_input' using errcode='22023';end if;
 if p_cost<0 or p_cost>j.reserved_cost_microusd-j.actual_cost_microusd or exists(select 1 from public.job_steps where job_id=j.id and state in ('in_flight','ambiguous','failed')) then raise exception 'unsafe_step' using errcode='55000';end if;
 -- Already claimed siblings must recheck the same aggregate reservation
 -- fence immediately before persisting a new paid dispatch boundary.
 if p_cost>0 then
  select * into account from public.usage_accounts where owner_id=j.owner_id for share;
  if not found or account.reserved_microusd>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd) then raise exception 'budget_exceeded' using errcode='P0001';end if;
 end if;
 insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values(j.id,j.owner_id,j.project_id,p_step,p_key,'in_flight',p_cost);return 'started';
end $replacement$);
end $patch$;

-- Exact predecessor supabase/migrations/20261007019000_logo_worker_readiness.sql; preserve existing signature metadata/ACL.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.read_leased_logo_record(uuid,uuid,text,jsonb)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from 'bab0ce0ccf78929ea06e3b490d315d8a94daaaf211c683f183d2848820ca7408' then raise exception 'proposal_admission_predecessor_mismatch: public.read_leased_logo_record(uuid,uuid,text,jsonb)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.read_leased_logo_record(uuid,uuid,text,jsonb)'::regprocedure);execute replace(definition,body,$replacement$
declare j public.jobs;q public.logo_cost_quotes;result jsonb;
begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
 if p_kind='runtime_readiness' then
  if p_input is not null and p_input<>'null'::jsonb then raise exception 'invalid_logo_readiness_input' using errcode='22023';end if;
  return to_jsonb(j.state='running' and fluid_private.logo_job_ready(j,j.worker_id));
 end if;
 if p_kind='vector_proposal_inputs' then
  if p_input is not null and p_input<>'null'::jsonb then raise exception 'invalid_vector_proposal_read_input' using errcode='22023';end if;
  if fluid_private.logo_vector_proposal_job_quote_matches(j,q) is distinct from true then raise exception 'logo_proposal_input_mismatch' using errcode='55000';end if;
  return jsonb_build_object('input',j.input,'context',q.source_inputs->'context');
 end if;
 case p_kind
 when 'concept_inputs' then if j.operation<>'identity.logo_concept' then raise exception 'wrong_logo_operation' using errcode='22023';end if;return jsonb_build_object('input',j.input,'inputRevisions',q.input_revisions,'brief',q.source_inputs->'brief','referenceSnapshot',q.source_inputs->'referenceSnapshot');
 when 'refinement_inputs' then if j.operation<>'identity.logo_refine' then raise exception 'wrong_logo_operation' using errcode='22023';end if;return jsonb_build_object('input',j.input,'inputRevisions',q.input_revisions,'brief',q.source_inputs->'brief','referenceSnapshot',q.source_inputs->'referenceSnapshot','basePreview',q.source_inputs#>'{raster,preview,reference}');
 when 'vector_input' then if j.operation<>'identity.logo_vectorize' then raise exception 'wrong_logo_operation' using errcode='22023';end if;return jsonb_build_object('reference',q.source_inputs#>'{raster,preview,reference}','logoType',q.source_inputs#>'{raster,logoType}','settings',j.input->'settings');
 when 'step_output' then select output into result from public.job_steps where job_id=j.id and step_key=p_input->>'stepKey' and state='succeeded';return result;
 when 'step_asset' then if p_input->>'stepKey'<>'generate-refinement' or j.operation<>'identity.logo_refine' then raise exception 'wrong_logo_step' using errcode='22023';end if;select r.preview->'reference' into result from public.logo_raster_results r join public.job_steps s on s.job_id=r.job_id where r.job_id=j.id and s.step_key='generate-refinement' and s.state='succeeded';if result is null then raise exception 'logo_step_not_found' using errcode='P0002';end if;return result;
 when 'has_results' then return to_jsonb(exists(select 1 from public.job_steps where job_id=j.id and state='succeeded'));
 when 'input_revisions' then return fluid_private.logo_job_input_revisions(j);
 else raise exception 'invalid_logo_read_kind' using errcode='22023';end case;
end $replacement$);
end $patch$;

-- Exact predecessor supabase/migrations/20261007011000_logo_durable_jobs.sql; preserve existing signature metadata/ACL.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.expire_logo_job_leases()'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from 'd2dacfd55811963d869da03d04986177c4591c28d84204d6176c7e437a7b306a' then raise exception 'proposal_admission_predecessor_mismatch: public.expire_logo_job_leases()' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.expire_logo_job_leases()'::regprocedure);execute replace(definition,body,$replacement$
declare owner uuid:=fluid_private.logo_worker_owner();j public.jobs;next text;n integer:=0;
begin
 if owner is null then raise exception 'logo_worker_unauthorized' using errcode='42501';end if;
 for j in select * from public.jobs where owner_id=owner and operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export','identity.logo_vector_propose') and state in ('running','cancel_requested') and lease_expires_at<=clock_timestamp() for update skip locked loop
  if exists(select 1 from public.job_steps where job_id=j.id and state in ('in_flight','ambiguous')) then next:='needs_reconciliation';
  elsif j.state='cancel_requested' then next:='cancelled';
  elsif exists(select 1 from public.job_steps where job_id=j.id and state='failed') then
   next:=case when exists(select 1 from public.job_steps where job_id=j.id and state='succeeded') then 'partial' else 'failed' end;
  elsif j.attempts<j.max_attempts then next:='queued';elsif exists(select 1 from public.job_steps where job_id=j.id and state='succeeded') then next:='partial';else next:='failed';end if;
  if next in ('failed','cancelled','partial') then perform fluid_private.settle_reservation(j.id);end if;
  update public.jobs set state=next,lease_token=null,lease_expires_at=null,error_code='lease_expired',finished_at=case when next in ('failed','partial','cancelled') then clock_timestamp() else null end where id=j.id;n:=n+1;
 end loop;return n;
end $replacement$);
end $patch$;

-- Exact predecessor supabase/migrations/20261007020000_logo_directions_subscription.sql; preserve existing signature metadata/ACL.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.record_logo_provider_response(uuid,uuid,jsonb)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '5e1fa9978f0cb01bb60969a900e31aed391333ff2d21397623f49d120e2eb840' then raise exception 'proposal_admission_predecessor_mismatch: public.record_logo_provider_response(uuid,uuid,jsonb)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.record_logo_provider_response(uuid,uuid,jsonb)'::regprocedure);execute replace(definition,body,$replacement$
declare j public.jobs;q public.logo_cost_quotes;r public.logo_provider_responses;b jsonb;
begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);if j.operation='identity.logo_vector_propose' then raise exception 'logo_vector_proposal_evidence_unavailable' using errcode='55000';end if;select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
 if j.billing_mode='chatgpt_subscription' then
  if not fluid_private.logo_subscription_observation_valid(j,p_observation) or q.record->>'billingMode' is distinct from 'chatgpt_subscription' or q.record->'policy' is distinct from j.input->'policy' or q.record->>'policyIdentity' is distinct from j.policy_identity or q.record->'model' is distinct from p_observation->'model' or q.record->'provider' is distinct from p_observation->'provider' then raise exception 'invalid_provider_evidence' using errcode='22023';end if;
 else
 if not fluid_private.standalone_keys(p_observation-'normalizedPixelHash',array['provider','model','providerRequestId','responseHash','observedAt','billing','artifactHash']) or octet_length(p_observation::text)>32768 or p_observation->'provider' is distinct from q.record->'provider' or p_observation->'model' is distinct from q.record->'model' or q.record->'provider'='null' or not fluid_private.standalone_timestamp(p_observation->'observedAt') or (p_observation->>'observedAt')::timestamptz>clock_timestamp()+interval '1 minute' then raise exception 'invalid_provider_evidence' using errcode='22023';end if;
 if p_observation ? 'normalizedPixelHash' and (jsonb_typeof(p_observation->'normalizedPixelHash') is distinct from 'string' or p_observation->>'normalizedPixelHash' !~ '^[0-9a-f]{64}$') then raise exception 'invalid_pixel_evidence' using errcode='22023';end if;
 b:=p_observation->'billing';if not fluid_private.standalone_keys(b,array['status','confirmedMicrousd']) or ((b->>'status'='unknown' and b->'confirmedMicrousd'='null') or (b->>'status'='recorded' and jsonb_typeof(b->'confirmedMicrousd')='number' and (b->>'confirmedMicrousd')::numeric between 0 and 9007199254740991 and trunc((b->>'confirmedMicrousd')::numeric)=(b->>'confirmedMicrousd')::numeric)) is not true then raise exception 'invalid_billing_evidence' using errcode='22023';end if;

 if (p_observation->'providerRequestId'<>'null' and (jsonb_typeof(p_observation->'providerRequestId')<>'string' or length(p_observation->>'providerRequestId') not between 1 and 200)) or (p_observation->'artifactHash'<>'null' and (jsonb_typeof(p_observation->'artifactHash') is distinct from 'string' or (p_observation->>'artifactHash') !~ '^[0-9a-f]{64}$')) or (p_observation->'responseHash'<>'null' and (jsonb_typeof(p_observation->'responseHash') is distinct from 'string' or (p_observation->>'responseHash') !~ '^[0-9a-f]{64}$')) then raise exception 'invalid_provider_evidence' using errcode='22023';end if;
 end if;
 if not exists(select 1 from public.job_steps where job_id=j.id and state='in_flight') then raise exception 'provider_step_not_started' using errcode='55000';end if;
 select * into r from public.logo_provider_responses where job_id=j.id;
 if found then if r.observation is distinct from p_observation or r.lease_token<>p_lease then raise exception 'provider_evidence_immutable' using errcode='PT409';end if;
 else insert into public.logo_provider_responses(owner_id,project_id,job_id,lease_token,observation) values(j.owner_id,j.project_id,j.id,p_lease,p_observation) returning * into r;end if;
 return r.observation||jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token);
end $replacement$);
end $patch$;

-- Exact predecessor supabase/migrations/20261007020000_logo_directions_subscription.sql; preserve existing signature metadata/ACL.
do $patch$declare body text;definition text;begin
 select prosrc into body from pg_proc where oid='public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from '377853d055563bbb16bd51ac1d1521ac9850210392b8f3509335a3a1f497a054' then raise exception 'proposal_admission_predecessor_mismatch: public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure);execute replace(definition,body,$replacement$
<<completion>>
declare j public.jobs;s public.job_steps;r public.logo_provider_responses;reservation public.usage_reservations;output jsonb;receipt jsonb;reason text;state text:=p_state;paid boolean;q public.logo_cost_quotes;current_heads jsonb;payload jsonb;revision jsonb;duplicate boolean:=false;
begin
 -- Project-first order matches manual publication/admission and prevents lock inversion.
 perform 1 from public.projects where id=(select project_id from public.jobs where id=p_job_id and owner_id=fluid_private.logo_worker_owner()) for update;
 j:=fluid_private.logo_lock_job(p_job_id,p_lease_token);
 if j.operation='identity.logo_vector_propose' then raise exception 'logo_vector_proposal_evidence_unavailable' using errcode='55000';end if;
 select * into s from public.job_steps where job_id=j.id and step_key=p_step_key for update;if not found then raise exception 'step_not_found' using errcode='P0002';end if;
 if state is null or state not in ('succeeded','failed','ambiguous') or p_actual_cost_microusd is null or p_actual_cost_microusd not between 0 and 9007199254740991 or octet_length(p_output::text)>1048576 then raise exception 'invalid_outcome' using errcode='22023';end if;
 if j.billing_mode='chatgpt_subscription' and p_actual_cost_microusd<>0 then raise exception 'invalid_subscription_cost' using errcode='22023';end if;
 if s.state<>'in_flight' then if (s.state,s.actual_cost_microusd,s.output,s.provider_request_id) is not distinct from (state,p_actual_cost_microusd,p_output,p_provider_request_id) then return s;end if;raise exception 'immutable_outcome' using errcode='55000';end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
 paid:=q.record->'provider'<>'null' and (j.operation in ('identity.logo_concept','identity.logo_directions') or p_step_key='generate-refinement');
 output:=case when state='succeeded' then p_output else p_output->'result' end;reason:=p_output->>'error';
 if p_state='failed' and output is not null and output<>'null' and j.operation<>'identity.logo_export' then raise exception 'failed_publication_not_supported' using errcode='22023';end if;
 if j.operation='identity.logo_export' and (p_actual_cost_microusd<>0 or p_provider_request_id is not null or j.reserved_cost_microusd<>0 or p_step_key<>'prepare-export') then raise exception 'invalid_zero_cost_export' using errcode='22023';end if;
 select * into r from public.logo_provider_responses where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=p_lease_token;
 if paid then
  if state='succeeded' and (r.id is null or r.observation#>>'{billing,status}'<>'recorded' or not fluid_private.logo_response_identity_complete(j,r.observation)) then raise exception 'provider_evidence_required' using errcode='55000';end if;
  if r.id is not null and ((r.observation->>'providerRequestId') is distinct from p_provider_request_id or (r.observation#>>'{billing,status}'='recorded' and (r.observation#>>'{billing,confirmedMicrousd}')::bigint<>p_actual_cost_microusd)) then raise exception 'provider_evidence_mismatch' using errcode='22023';end if;
  if r.id is not null and r.observation#>>'{billing,status}'='unknown' then state:='ambiguous';reason:=case when output is not null then 'billing_unknown' else 'provider_outcome_unknown' end;end if;
  if state='failed' and r.id is null and not (reason='not_dispatched' and p_actual_cost_microusd=0 and p_provider_request_id is null) then state:='ambiguous';reason:='provider_outcome_unknown';end if;
 end if;
 if j.billing_mode='chatgpt_subscription' and state='failed' and (reason='not_dispatched' and r.id is null and p_provider_request_id is null) is not true then state:='ambiguous';reason:='provider_outcome_unknown';end if;
 if p_actual_cost_microusd>s.reserved_cost_microusd or j.actual_cost_microusd+p_actual_cost_microusd>j.reserved_cost_microusd then state:='ambiguous';reason:='provider_cost_exceeded';end if;
 if output is not null and output<>'null' then
  if j.operation='identity.logo_export' then
   if (fluid_private.standalone_keys(output,array['version','kind','publicationId']) and output->'version'='2' and fluid_private.logo_uuid(output->'publicationId')
    and ((state='succeeded' and output->>'kind'='logo_export') or (state='failed' and output->>'kind'='logo_export_partial' and reason in ('export_file_failed','export_package_too_large')))) is not true then raise exception 'invalid_export_output' using errcode='22023';end if;
   receipt:=fluid_private.logo_commit_export_publication(j,(output->>'publicationId')::uuid);
   if (fluid_private.standalone_keys(receipt,array['publicationId','completeness','failure','manifestId','stageRevision','outputs']) and receipt->'publicationId'=output->'publicationId' and jsonb_typeof(receipt->'outputs')='array' and jsonb_array_length(receipt->'outputs') between 1 and 100
    and ((state='succeeded' and receipt->>'completeness'='complete' and fluid_private.logo_uuid(receipt->'manifestId') and receipt->'failure'='null')
      or (state='failed' and receipt->>'completeness'='partial' and receipt->'manifestId'='null' and receipt->'stageRevision'='null' and 'export_'||(receipt->>'failure')=reason))) is not true then raise exception 'export_group_outcome_mismatch' using errcode='55000';end if;
  elsif j.operation='identity.logo_directions' and state='ambiguous' and output->>'kind'='logo_directions_unpublished' then
   payload:=output->'payload';
   if (fluid_private.standalone_keys(output,array['version','kind','reason','payload']) and output->'version'='2' and output->>'reason'=p_output->>'error'
    and output->>'reason' in ('provider_outcome_unknown','provider_evidence_unconfirmed','provider_evidence_incomplete','publication_unknown','direction_payload_invalid','billing_unknown')
    and fluid_private.standalone_keys(payload,array['json','sha256','byteLength','truncated'])
    and jsonb_typeof(payload->'json')='string' and octet_length(payload->>'json')<=262144
    and jsonb_typeof(payload->'sha256')='string' and payload->>'sha256' ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(payload->'byteLength')='number' and (payload->>'byteLength')::numeric between 0 and 9007199254740991 and (payload->>'byteLength')::numeric=trunc((payload->>'byteLength')::numeric)
    and jsonb_typeof(payload->'truncated')='boolean'
    and ((payload->'truncated'='false' and (payload->>'byteLength')::numeric=octet_length(payload->>'json') and payload->>'sha256'=encode(sha256(convert_to(payload->>'json','UTF8')),'hex'))
      or (payload->'truncated'='true' and (payload->>'byteLength')::numeric>octet_length(payload->>'json')))) is not true then raise exception 'invalid_unpublished_direction_evidence' using errcode='22023';end if;
   -- This passive evidence never creates a direction, publication receipt or head.
  elsif j.operation='identity.logo_directions' and state='ambiguous' and reason='direction_payload_invalid' then
   -- Retain bounded raw provider response only as non-publishable step evidence.
   null;
  elsif j.operation='identity.logo_directions' then
   if not fluid_private.standalone_keys(output,array['version','kind','publicationId','providerResponseReceiptId']) or output->'version'<>'2' or output->>'kind'<>'logo_directions' or not fluid_private.logo_uuid(output->'publicationId') or output->>'providerResponseReceiptId' is distinct from r.id::text then raise exception 'invalid_direction_output' using errcode='22023';end if;
   if not exists(select 1 from public.logo_direction_publications p where p.id=(output->>'publicationId')::uuid and p.job_id=j.id and p.owner_id=j.owner_id and p.project_id=j.project_id and p.lease_token=j.lease_token and p.provider_receipt_id=r.id) then raise exception 'direction_publication_not_found' using errcode='P0002';end if;
   if state='succeeded' and r.observation#>>'{billing,status}'='recorded' then perform fluid_private.logo_commit_direction_publication(j,(output->>'publicationId')::uuid,r.id);end if;
  elsif j.operation='identity.logo_vectorize' or (j.operation='identity.logo_refine' and p_step_key='convert-refinement') then
   if j.operation='identity.logo_vectorize' then
    if not fluid_private.standalone_keys(output,array['version','kind','publicationId']) or output->'version'<>'2' or output->>'kind'<>'logo_vector' then raise exception 'invalid_vector_output' using errcode='22023';end if;
   else
    if not fluid_private.standalone_keys(output,array['version','kind','publicationId','sourceStepKey']) or output->'version'<>'2' or output->>'kind'<>'logo_refinement_vector' or output->>'sourceStepKey'<>'generate-refinement' then raise exception 'invalid_vector_output' using errcode='22023';end if;
   end if;
   if not fluid_private.logo_uuid(output->'publicationId') or p_actual_cost_microusd<>0 or p_provider_request_id is not null then raise exception 'invalid_vector_output' using errcode='22023';end if;
   perform fluid_private.logo_commit_vector_publication(j,(output->>'publicationId')::uuid);
  else
  if j.operation='identity.logo_concept' then
   if not fluid_private.standalone_keys(output,array['version','kind','batchId','slotId','attemptId','publicationId','providerResponseReceiptId']) or output->'version'<>'2' or output->>'kind'<>'logo_concept' or output->'batchId' is distinct from j.input->'batchId' or output->'slotId' is distinct from j.input->'slotId' or output->'attemptId' is distinct from j.input->'attemptId' then raise exception 'invalid_logo_output' using errcode='22023';end if;
  elsif j.operation='identity.logo_refine' and p_step_key='generate-refinement' then
   if not fluid_private.standalone_keys(output,array['version','kind','rasterRevisionId','publicationId','providerResponseReceiptId']) or output->>'kind'<>'logo_refinement_raster' or output->'version'<>'2' or output->'rasterRevisionId' is distinct from j.input->'rasterRevisionId' then raise exception 'invalid_logo_output' using errcode='22023';end if;
  else raise exception 'logo_publication_adapter_unavailable' using errcode='55000';end if;
  if r.id is null or output->>'providerResponseReceiptId' is distinct from r.id::text or not fluid_private.logo_uuid(output->'publicationId') then raise exception 'provider_evidence_required' using errcode='55000';end if;
  if r.observation->>'normalizedPixelHash' is null then raise exception 'normalized_pixel_evidence_required' using errcode='55000';end if;
  if j.operation='identity.logo_concept' then
   duplicate:=exists(select 1 from public.logo_concept_attempts a join public.logo_concept_slots sl on sl.id=a.slot_id join public.logo_raster_results rr on rr.job_id=a.job_id join public.logo_provider_responses pr on pr.id=rr.provider_response_receipt_id where sl.batch_id=(j.input->>'batchId')::uuid and a.owner_id=j.owner_id and a.project_id=j.project_id and pr.observation->>'normalizedPixelHash'=r.observation->>'normalizedPixelHash');
  end if;
  if duplicate then state:=case when r.observation#>>'{billing,status}'='recorded' then 'failed' else 'ambiguous' end;reason:='duplicate_preview';
  else
  receipt:=fluid_private.commit_logo_asset_publication(j,(output->>'publicationId')::uuid);
  if receipt#>>'{reference,contentHash}' is distinct from r.observation->>'artifactHash' or receipt#>>'{verification,mimeType}'<>'image/png' or receipt->>'sourceReceiptId' is distinct from coalesce(j.input->>'attemptId',j.input->>'rasterRevisionId') then raise exception 'invalid_logo_artifact' using errcode='22023';end if;
  insert into public.logo_raster_results(job_id,owner_id,project_id,preview,provider_response_receipt_id) values(j.id,j.owner_id,j.project_id,receipt,r.id);
  -- A stale result is retained against its frozen source; it cannot move a current head.
  if j.operation='identity.logo_refine' and j.state='running' and fluid_private.logo_workspace_json(j.owner_id,j.project_id)->'heads'=q.record->'expected' then
   select rr.record->'payload' into payload from public.logo_stage_heads h join public.logo_stage_revisions rr on rr.id=h.revision_id where h.project_id=j.project_id and h.owner_id=j.owner_id and h.stage='refinements';
   payload:=jsonb_build_object('rasterRevisionIds',coalesce(payload->'rasterRevisionIds','[]')||jsonb_build_array(j.input->'rasterRevisionId'),'vectorRevisionId',null,'approvalId',null,'sourceRequestKey',j.input->'requestKey');
   perform fluid_private.logo_append_stage(j.owner_id,j.project_id,'refinements',payload,q.input_revisions);
  end if;
 end if; -- duplicate artifacts stay staged and never become selectable
  end if; -- operation-specific publication group
 elsif state='succeeded' then raise exception 'logo_publication_required' using errcode='55000';
 end if;
 if j.billing_mode='chatgpt_subscription' and state='failed' and (reason='not_dispatched' and r.id is null and p_provider_request_id is null) is not true then state:='ambiguous';reason:='provider_outcome_unknown';end if;
 if p_actual_cost_microusd>s.reserved_cost_microusd or j.actual_cost_microusd+p_actual_cost_microusd>j.reserved_cost_microusd then state:='ambiguous';reason:='provider_cost_exceeded';end if;
 if j.billing_mode<>'chatgpt_subscription' then
 select * into reservation from public.usage_reservations where job_id=j.id for update;
 update public.usage_accounts set spent_microusd=spent_microusd+least(greatest(reservation.reserved_microusd-reservation.actual_microusd,0),p_actual_cost_microusd),provider_actual_microusd=provider_actual_microusd+p_actual_cost_microusd,reserved_microusd=reserved_microusd-least(greatest(reservation.reserved_microusd-reservation.actual_microusd,0),p_actual_cost_microusd) where owner_id=j.owner_id;
 update public.usage_reservations set actual_microusd=actual_microusd+p_actual_cost_microusd,captured_microusd=captured_microusd+least(greatest(reservation.reserved_microusd-reservation.actual_microusd,0),p_actual_cost_microusd) where job_id=j.id;
 end if;
 update public.job_steps set state=completion.state,actual_cost_microusd=p_actual_cost_microusd,output=p_output,provider_request_id=p_provider_request_id,completed_at=clock_timestamp() where id=s.id returning * into s;
 update public.jobs set actual_cost_microusd=actual_cost_microusd+p_actual_cost_microusd where id=j.id;
 if state='ambiguous' then update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=coalesce(reason,'provider_outcome_unknown') where id=j.id;
 elsif duplicate then perform fluid_private.settle_reservation(j.id);update public.jobs set state='failed',lease_token=null,lease_expires_at=null,error_code='duplicate_preview',finished_at=clock_timestamp() where id=j.id;end if;
 return s;
end $replacement$);
end $patch$;

-- No execute grants. Newly introduced pure/internal helpers remain private.
do $$declare signature text;r record;object_id oid;begin
 foreach signature in array array['fluid_private.valid_logo_vector_proposal_job_input(jsonb)','fluid_private.logo_vector_proposal_quote_binding(public.logo_cost_quotes)','fluid_private.logo_vector_proposal_quote_current(public.logo_cost_quotes,fluid_private.logo_runtime_policies)','fluid_private.logo_vector_proposal_job_quote_matches(public.jobs,public.logo_cost_quotes)'] loop
  object_id:=signature::regprocedure;
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
commit;
