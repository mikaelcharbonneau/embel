-- LOCAL CANDIDATE ONLY. No login, binding, policy enablement or worker grants.
-- A report is ephemeral evidence from the actual restricted login, not policy.
-- Future EXECUTE on report_logo_worker_ready requires separate activation review.
begin;
create table fluid_private.logo_worker_readiness (
 role_oid oid not null, worker_id text not null check(length(worker_id) between 1 and 200 and length(btrim(worker_id))>0),
 owner_id uuid not null references auth.users(id), operation text not null,
 descriptor jsonb not null check(octet_length(descriptor::text)<=32768), ready_until timestamptz not null,
 primary key(role_oid,worker_id,operation),
 foreign key(owner_id,operation) references fluid_private.logo_runtime_policies(owner_id,operation) on delete cascade
);

create function fluid_private.logo_policy_descriptor(p fluid_private.logo_runtime_policies) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('operation',p.operation,'policyIdentity',p.policy_identity,'handlerVersion',p.handler_version,'provider',p.provider,'model',p.model,'engine',p.engine,'maxCostMicrousd',p.max_cost_microusd)
$$;

-- Also validate the current principal at read time: revoking/renaming/dropping a
-- login or adding membership must immediately remove its admission authority.
create function fluid_private.logo_operation_ready(p_owner uuid,p_operation text) returns boolean language sql volatile set search_path='' as $$
 select exists(
  select 1 from fluid_private.logo_worker_readiness r
  join fluid_private.logo_runtime_policies p on p.owner_id=r.owner_id and p.operation=r.operation
  join fluid_private.logo_worker_principals binding on binding.role_oid=r.role_oid and binding.owner_id=r.owner_id
  join pg_catalog.pg_roles role on role.oid=binding.role_oid and role.rolname=binding.role_name
  where r.owner_id=p_owner and r.operation=p_operation and r.ready_until>clock_timestamp() and p.enabled
   and r.descriptor=fluid_private.logo_policy_descriptor(p)
   and role.rolcanlogin and not role.rolinherit and not role.rolsuper and not role.rolbypassrls and not role.rolcreatedb and not role.rolcreaterole and not role.rolreplication
   and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=role.oid)
 )
$$;

create function public.report_logo_worker_ready(p_worker text,p_manifest jsonb,p_seconds integer) returns boolean language plpgsql security definer set search_path='' as $$
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
 if jsonb_array_length(p_manifest)>5 or (select count(*)<>count(distinct value->>'operation') from jsonb_array_elements(p_manifest)) then return false;end if;
 for item in select value from jsonb_array_elements(p_manifest) loop
  if fluid_private.standalone_keys(item,array['operation','policyIdentity','handlerVersion','provider','model','engine','maxCostMicrousd']) is distinct from true then valid:=false;exit;end if;
  select * into policy from fluid_private.logo_runtime_policies where owner_id=owner and operation=item->>'operation' and enabled;
  if not found or item is distinct from fluid_private.logo_policy_descriptor(policy) then valid:=false;exit;end if;
 end loop;
 if not valid then return false;end if;
 insert into fluid_private.logo_worker_readiness(role_oid,worker_id,owner_id,operation,descriptor,ready_until)
 select login_oid,p_worker,owner,value->>'operation',value,clock_timestamp()+make_interval(secs=>p_seconds) from jsonb_array_elements(p_manifest);
 return true;
end $$;

create function fluid_private.invalidate_logo_worker_readiness() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or to_jsonb(old) is distinct from to_jsonb(new) then
  delete from fluid_private.logo_worker_readiness where owner_id=old.owner_id and operation=old.operation;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger logo_runtime_policy_invalidates_readiness before update or delete on fluid_private.logo_runtime_policies for each row execute function fluid_private.invalidate_logo_worker_readiness();

-- Exact frozen policy checks are independent of heartbeat liveness. Vector
-- settingsHash is quote-specific, and concept quotes reserve all target slots.
create function fluid_private.logo_job_policy_matches(j public.jobs,p fluid_private.logo_runtime_policies) returns boolean language plpgsql stable set search_path='' as $$
declare q public.logo_cost_quotes;count numeric:=1;
begin
 if p.owner_id is distinct from j.owner_id or p.operation is distinct from j.operation or not p.enabled or p.policy_identity is distinct from j.input->>'policyIdentity' or p.handler_version is distinct from j.input->>'handlerVersion' then return false;end if;
 if j.operation='identity.logo_export' then
  return p.handler_version='logo-export-v1' and p.provider is null and p.model is null and p.engine is null and p.max_cost_microusd=0 and j.reserved_cost_microusd=0 and not(j.input?'quoteId');
 end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id and operation=j.operation and record->>'inputHash'=j.input_hash;
 if not found then return false;end if;
 if j.operation='identity.logo_concept' then count:=jsonb_array_length(q.record->'targetSlotIds');end if;
 return p.policy_identity=q.record->>'policyIdentity' and p.handler_version=q.record->>'handlerVersion'
  and to_jsonb(p.provider) is not distinct from nullif(q.record->'provider','null')
  and to_jsonb(p.model) is not distinct from nullif(q.record->'model','null')
  and p.engine is not distinct from (nullif(q.record->'engine','null')-'settingsHash')
  and p.max_cost_microusd::numeric*count=(q.record->>'maxCostMicrousd')::numeric;
end $$;

create function fluid_private.logo_job_ready(j public.jobs,p_worker text) returns boolean language sql volatile set search_path='' as $$
 select exists(select 1 from fluid_private.logo_worker_readiness r
  join fluid_private.logo_runtime_policies p on p.owner_id=r.owner_id and p.operation=r.operation
  join pg_catalog.pg_roles login on login.oid=r.role_oid and login.rolname=session_user
  where r.owner_id=j.owner_id and r.owner_id=fluid_private.logo_worker_owner() and r.worker_id=p_worker and r.operation=j.operation
   and r.ready_until>clock_timestamp() and r.descriptor=fluid_private.logo_policy_descriptor(p) and fluid_private.logo_job_policy_matches(j,p))
$$;
create function fluid_private.lock_logo_job_readiness(j public.jobs,p_worker text) returns boolean language plpgsql set search_path='' as $$
begin
 perform 1 from fluid_private.logo_runtime_policies where owner_id=j.owner_id and operation=j.operation for share;
 perform 1 from fluid_private.logo_worker_readiness where role_oid=(select oid from pg_catalog.pg_roles where rolname=session_user) and worker_id=p_worker and owner_id=j.owner_id and operation=j.operation for share;
 return fluid_private.logo_job_ready(j,p_worker);
end $$;

-- Replace only the exact existing signatures, retaining their owners and ACLs.
-- The 018000 cancellation tables, helpers and insert triggers stay untouched.
create or replace function public.quote_logo_operation(p_project_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid();workspace jsonb;brief public.logo_stage_revisions;snapshot jsonb;op text;policy fluid_private.logo_runtime_policies;batch public.logo_concept_batches;slot public.logo_concept_slots;
 qid uuid:=gen_random_uuid();plan jsonb;targets jsonb:='[]';sources jsonb;inputs jsonb;inputhash text;result jsonb;expires timestamptz:=clock_timestamp()+interval '5 minutes';count integer:=1;prior bigint;target jsonb;source jsonb;direction jsonb;total numeric;
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
 total:=policy.max_cost_microusd::numeric*count;if total>9007199254740991 then raise exception 'logo_cost_overflow' using errcode='22003';end if;
 snapshot:=fluid_private.logo_snapshot_json(owner,p_project_id,brief.reference_snapshot_id);
 sources:=jsonb_build_object('brief',brief.record,'referenceSnapshot',snapshot,'raster',source);if direction is not null then sources:=sources||jsonb_build_object('direction',direction);end if;
 inputhash:=encode(sha256(convert_to(jsonb_build_object('request',p_input,'sources',sources,'policy',to_jsonb(policy),'plan',plan,'targets',targets)::text,'UTF8')),'hex');
 result:=jsonb_build_object('id',qid,'ownerId',owner,'projectId',p_project_id,'request',p_input,'inputHash',inputhash,'expected',p_input->'expected','policyIdentity',policy.policy_identity,'handlerVersion',policy.handler_version,'provider',policy.provider,'model',policy.model,'engine',case when policy.engine is null then null else policy.engine||jsonb_build_object('settingsHash',encode(sha256(convert_to((p_input->'settings')::text,'UTF8')),'hex')) end,'estimatedCostMicrousd',total,'maxCostMicrousd',total,'externalProviderCostMicrousd',case when policy.provider is null then 0 else total end,'expiresAt',to_char(expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'conceptPlan',plan,'targetSlotIds',targets);
 insert into public.logo_cost_quotes values(qid,owner,p_project_id,op,result,inputs,sources,expires);return result;
end $$;

create or replace function public.admit_logo_operation(p_project_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid();q public.logo_cost_quotes;r public.logo_operation_requests;policy fluid_private.logo_runtime_policies;batch uuid;jobid uuid;attempt uuid;prior public.logo_concept_attempts;slot public.logo_concept_slots;target jsonb;slotplan jsonb;input jsonb;manifest jsonb;jobids jsonb:='[]';result jsonb;cap bigint;cost bigint;raster uuid;account public.usage_accounts;op text;created_job public.jobs;rejected public.logo_operation_rejections;failure_message text;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not fluid_private.standalone_keys(p_input,array['requestKey','quoteId','acceptedMaxCostMicrousd','expected']) or not fluid_private.logo_uuid(p_input->'requestKey') or not fluid_private.logo_uuid(p_input->'quoteId') or jsonb_typeof(p_input->'acceptedMaxCostMicrousd') is distinct from 'number' or (p_input->>'acceptedMaxCostMicrousd')::numeric not between 0 and 9007199254740991 or trunc((p_input->>'acceptedMaxCostMicrousd')::numeric)<>(p_input->>'acceptedMaxCostMicrousd')::numeric then raise exception 'invalid_logo_intent' using errcode='22023';end if;
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
 if not fluid_private.logo_operation_ready(owner,q.operation) then raise exception 'logo_runtime_unavailable' using errcode='55000';end if;
 cap:=(p_input->>'acceptedMaxCostMicrousd')::bigint;cost:=(q.record->>'maxCostMicrousd')::bigint;if cap<cost then raise exception 'logo_cap_exceeded' using errcode='PT409';end if;
 select * into account from public.usage_accounts where owner_id=owner for update;if not found or cost>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd)-account.reserved_microusd then raise exception 'logo_budget_exceeded' using errcode='PT409';end if;
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
  elsif q.operation='identity.logo_vectorize' then input:=input||jsonb_build_object('source',q.record#>'{request,source}','settings',q.record#>'{request,settings}','engine',(q.record->'engine')-'settingsHash');manifest:=jsonb_build_array(jsonb_build_object('key','convert-vector','maximumCostMicrousd',0));
  else raise exception 'logo_operation_unavailable' using errcode='55000';end if;
  insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,plan_manifest,plan_fingerprint,plan_registered_at) values(jobid,owner,p_project_id,q.operation,(p_input#>>'{expected,projectRevision}')::integer,q.record->>'inputHash',input,'logo:'||jobid,cost,3,manifest,encode(sha256(convert_to(manifest::text,'UTF8')),'hex'),clock_timestamp());
  if q.operation='identity.logo_directions' then select * into created_job from public.jobs where id=jobid;perform fluid_private.logo_freeze_direction_inputs(created_job,q.source_inputs->'direction');end if;
  if q.operation='identity.logo_refine' then insert into public.logo_raster_refinements(id,owner_id,project_id,request_key,job_id,source,logo_type,input_revisions) values(raster,owner,p_project_id,(p_input->>'requestKey')::uuid,jobid,q.record#>'{request,source}',q.source_inputs#>>'{raster,logoType}',q.input_revisions);end if;jobids:=jsonb_build_array(jobid);
 end if;
 insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) select j.id,owner,p_project_id,j.reserved_cost_microusd from public.jobs j where j.id in (select (value#>>'{}')::uuid from jsonb_array_elements(jobids));
 update public.usage_accounts set reserved_microusd=reserved_microusd+cost where owner_id=owner;
 result:=jsonb_build_object('ownerId',owner,'projectId',p_project_id,'requestKey',p_input->'requestKey','operation',q.operation,'batchId',batch,'jobIds',jobids,'inputHash',q.record->'inputHash');
 insert into public.logo_operation_requests(owner_id,project_id,request_key,quote_id,input,receipt) values(owner,p_project_id,(p_input->>'requestKey')::uuid,q.id,p_input,result);return result;
 exception when sqlstate 'PT409' then
  get stacked diagnostics failure_message=MESSAGE_TEXT;
  if failure_message in ('logo_quote_stale','logo_policy_changed','logo_cap_exceeded','logo_budget_exceeded','logo_retry_requires_confirmed_failure','logo_quote_already_used') then
   return fluid_private.reject_logo_admission(owner,p_project_id,p_input,'conflict');
  end if;raise;
 when sqlstate 'P0002' then
  get stacked diagnostics failure_message=MESSAGE_TEXT;
  if failure_message='logo_quote_not_found' then return fluid_private.reject_logo_admission(owner,p_project_id,p_input,'not_found');end if;raise;
 end;
end $$;

create or replace function public.request_logo_export(p_project_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid();prior public.logo_operation_requests;rejected public.logo_operation_rejections;failure_message text;policy fluid_private.logo_runtime_policies;source jsonb;variant public.logo_variant_sets;review public.logo_variant_reviews;w jsonb;job_id uuid:=gen_random_uuid();snapshot_hash text;input_hash text;job_input jsonb;receipt jsonb;plan jsonb;item jsonb;expected_reviews jsonb;basis jsonb;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if (fluid_private.standalone_keys(p_input,array['requestKey','expected','approvedLogoId','directionApprovalId','variantSetId','pngLongEdge','socialSelections']) and fluid_private.logo_uuid(p_input->'requestKey') and fluid_private.logo_uuid(p_input->'approvedLogoId') and fluid_private.logo_uuid(p_input->'directionApprovalId') and fluid_private.logo_uuid(p_input->'variantSetId') and p_input->'pngLongEdge' in('512','1024','2048','4096') and jsonb_typeof(p_input->'socialSelections')='array' and jsonb_array_length(p_input->'socialSelections')<=2 and octet_length(p_input::text)<=32768) is not true then raise exception 'invalid_export_intent' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_input->'socialSelections') loop
  if (fluid_private.standalone_keys(item,array['kind','presetId']) and(item='{"kind":"avatar","presetId":"avatar-1024-contain-v1"}' or item='{"kind":"banner","presetId":"banner-1500x500-contain-v1"}')) is not true then raise exception 'invalid_export_social' using errcode='22023';end if;
 end loop;
 if(select count(*)<>count(distinct value) from jsonb_array_elements(p_input->'socialSelections')) then raise exception 'duplicate_export_social' using errcode='22023';end if;
 perform 1 from public.projects where id=p_project_id and owner_id=owner for update;if not found then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into prior from public.logo_operation_requests where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid;
 if found then if prior.input is distinct from p_input then raise exception 'logo_request_conflict' using errcode='PT409';end if;return prior.receipt;end if;
 select * into rejected from public.logo_operation_rejections where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid;
 if found then
  if rejected.input is distinct from p_input or rejected.receipt->>'kind' is distinct from 'logo_export_admission_rejected' then raise exception 'logo_request_conflict' using errcode='PT409';end if;return rejected.receipt;
 end if;
 if exists(select 1 from public.logo_workspace_requests where owner_id=owner and project_id=p_project_id and request_key=(p_input->>'requestKey')::uuid) then raise exception 'logo_request_conflict' using errcode='PT409';end if;
 begin
 w:=fluid_private.logo_workspace_json(owner,p_project_id);
 if w->'heads' is distinct from p_input->'expected' then raise exception 'logo_head_conflict' using errcode='PT409';end if;
 source:=fluid_private.logo_approved_deliverable_sources(owner,p_project_id);
 if source#>'{logoApproval,id}' is distinct from p_input->'approvedLogoId' or source#>'{directionApproval,id}' is distinct from p_input->'directionApprovalId' then raise exception 'export_approval_changed' using errcode='PT409';end if;
 select * into variant from public.logo_variant_sets where id=(p_input->>'variantSetId')::uuid and owner_id=owner and project_id=p_project_id;
 select r.record->'payload' into basis from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id where h.owner_id=owner and h.project_id=p_project_id and h.stage='deliverables';
 if variant.id is null or variant.source-'heads' is distinct from source-'heads' or basis->'variantSetId' is distinct from p_input->'variantSetId' then raise exception 'export_variant_source_changed' using errcode='PT409';end if;
 select * into review from public.logo_variant_reviews where variant_set_id=variant.id and owner_id=owner and project_id=p_project_id order by created_at desc,id desc limit 1;
 select jsonb_agg(jsonb_build_object('variantId',value->'id','renderHash',value->'renderHash') order by ordinality) into expected_reviews from jsonb_array_elements(variant.record->'items') with ordinality where value#>>'{applicability,status}'='applicable';
 if review.id is null or review.record->'acceptedVariants' is distinct from expected_reviews then raise exception 'variant_review_required' using errcode='PT409';end if;
 select * into policy from fluid_private.logo_runtime_policies where owner_id=owner and operation='identity.logo_export' and enabled for share;
 if not found or policy.handler_version<>'logo-export-v1' or policy.provider is not null or policy.model is not null or policy.engine is not null or policy.max_cost_microusd<>0 then raise exception 'export_runtime_unavailable' using errcode='55000';end if;
 if not fluid_private.logo_operation_ready(owner,'identity.logo_export') then raise exception 'logo_runtime_unavailable' using errcode='55000';end if;
 select jsonb_build_object('stage',r.stage,'id',r.id,'revision',r.revision) into basis from public.logo_stage_heads h join public.logo_stage_revisions r on r.id=h.revision_id where h.owner_id=owner and h.project_id=p_project_id and h.stage='deliverables';
 source:=source||jsonb_build_object('inputRevisions',(source->'inputRevisions')||jsonb_build_array(basis),'variants',variant.record,'variantReview',review.record,'pngLongEdge',p_input->'pngLongEdge','socialSelections',p_input->'socialSelections');
 snapshot_hash:=encode(sha256(convert_to(source::text,'UTF8')),'hex');source:=source||jsonb_build_object('sourceSnapshotHash',snapshot_hash);
 input_hash:=encode(sha256(convert_to(jsonb_build_object('sourceSnapshotHash',snapshot_hash,'policyIdentity',policy.policy_identity,'handlerVersion',policy.handler_version)::text,'UTF8')),'hex');
 job_input:=jsonb_build_object('version',2,'ownerId',owner,'projectId',p_project_id,'requestKey',p_input->'requestKey','policyIdentity',policy.policy_identity,'handlerVersion',policy.handler_version,'inputHash',input_hash,'operation','identity.logo_export','approvedLogoId',p_input->'approvedLogoId','directionApprovalId',p_input->'directionApprovalId','variantSetId',variant.id,'variantReviewId',review.id,'sourceSnapshotHash',snapshot_hash);
 plan:='[{"key":"prepare-export","maximumCostMicrousd":0}]';
 insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,plan_manifest,plan_fingerprint,plan_registered_at) values(job_id,owner,p_project_id,'identity.logo_export',(p_input#>>'{expected,projectRevision}')::integer,input_hash,job_input,'logo:'||job_id,0,3,plan,encode(sha256(convert_to(plan::text,'UTF8')),'hex'),clock_timestamp());
 insert into public.logo_export_inputs(job_id,owner_id,project_id,source_snapshot_hash,source) values(job_id,owner,p_project_id,snapshot_hash,source);
 insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) values(job_id,owner,p_project_id,0);
 receipt:=jsonb_build_object('ownerId',owner,'projectId',p_project_id,'requestKey',p_input->'requestKey','operation','identity.logo_export','batchId',null,'jobIds',jsonb_build_array(job_id),'inputHash',input_hash);
 insert into public.logo_operation_requests(owner_id,project_id,request_key,quote_id,input,receipt) values(owner,p_project_id,(p_input->>'requestKey')::uuid,null,p_input,receipt);
 return receipt;
 exception when sqlstate 'PT409' then
  get stacked diagnostics failure_message=MESSAGE_TEXT;
  if failure_message in('logo_head_conflict','export_approval_changed','export_variant_source_changed','variant_review_required','logo_approval_required','identity_approval_stale','identity_approval_required') then
   return fluid_private.reject_logo_export_admission(owner,p_project_id,p_input);
  end if;raise;
 end;
end $$;

create or replace function public.claim_logo_job(p_worker text,p_seconds integer) returns setof public.jobs language plpgsql security definer set search_path='' as $$
declare owner uuid:=fluid_private.logo_worker_owner();j public.jobs;account public.usage_accounts;pending_paid boolean;
begin
 if owner is null then raise exception 'logo_worker_unauthorized' using errcode='42501';end if;
 if p_seconds not between 10 and 300 or p_seconds is null or p_worker is null or length(p_worker) not between 1 and 200 then raise exception 'invalid_lease' using errcode='22023';end if;
 select candidate.* into j from public.jobs candidate join public.usage_accounts a on a.owner_id=candidate.owner_id
 where candidate.owner_id=owner and candidate.operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') and candidate.state='queued' and candidate.attempts<candidate.max_attempts
 and fluid_private.logo_job_ready(candidate,p_worker)
 and (a.reserved_microusd<=a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd) or not exists(
  select 1 from jsonb_array_elements(candidate.plan_manifest) planned where (planned->>'maximumCostMicrousd')::numeric>0 and not exists(select 1 from public.job_steps done where done.job_id=candidate.id and done.step_key=planned->>'key' and done.state='succeeded')))
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
end $$;

create or replace function public.begin_logo_job_step(p_job uuid,p_lease uuid,p_step text,p_key text,p_cost bigint) returns text language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.job_steps;account public.usage_accounts;
begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);if j.state<>'running' then raise exception 'cancel_requested' using errcode='55000';end if;
 if not exists(select 1 from jsonb_array_elements(j.plan_manifest) m where m->>'key'=p_step and (m->>'maximumCostMicrousd')::bigint=p_cost) then raise exception 'plan_conflict' using errcode='40001';end if;
 select * into s from public.job_steps where job_id=j.id and step_key=p_step;
 if found then if s.state='succeeded' and s.request_key=p_key and s.reserved_cost_microusd=p_cost then return 'already_succeeded';end if;raise exception 'step_requires_reconciliation_or_new_job' using errcode='55000';end if;
 if j.operation='identity.logo_export' then
  if p_cost is distinct from 0 or j.reserved_cost_microusd<>0 or j.actual_cost_microusd<>0 or j.input ? 'quoteId' or p_step<>'prepare-export' or not exists(
   select 1 from fluid_private.logo_runtime_policies p where p.owner_id=j.owner_id and p.operation=j.operation and p.enabled and p.policy_identity=j.input->>'policyIdentity' and p.handler_version=j.input->>'handlerVersion' and p.handler_version='logo-export-v1' and p.provider is null and p.model is null and p.engine is null and p.max_cost_microusd=0) then raise exception 'logo_export_policy_revoked' using errcode='55000';end if;
  perform fluid_private.logo_export_input_revisions(j);
 elsif not exists(select 1 from public.logo_cost_quotes q join fluid_private.logo_runtime_policies p on p.owner_id=q.owner_id and p.operation=q.operation where q.id=(j.input->>'quoteId')::uuid and q.owner_id=j.owner_id and q.project_id=j.project_id and p.enabled and p.policy_identity=j.input->>'policyIdentity' and p.handler_version=j.input->>'handlerVersion') then raise exception 'logo_policy_revoked' using errcode='55000';end if;
 if not fluid_private.lock_logo_job_readiness(j,j.worker_id) then raise exception 'logo_runtime_unavailable' using errcode='55000';end if;
 if p_cost<0 or p_cost>j.reserved_cost_microusd-j.actual_cost_microusd or exists(select 1 from public.job_steps where job_id=j.id and state in ('in_flight','ambiguous','failed')) then raise exception 'unsafe_step' using errcode='55000';end if;
 -- Already claimed siblings must recheck the same aggregate reservation
 -- fence immediately before persisting a new paid dispatch boundary.
 if p_cost>0 then
  select * into account from public.usage_accounts where owner_id=j.owner_id for share;
  if not found or account.reserved_microusd>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd) then raise exception 'budget_exceeded' using errcode='P0001';end if;
 end if;
 insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values(j.id,j.owner_id,j.project_id,p_step,p_key,'in_flight',p_cost);return 'started';
end $$;

create or replace function public.read_leased_logo_record(p_job uuid,p_lease uuid,p_kind text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;q public.logo_cost_quotes;result jsonb;
begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
 if p_kind='runtime_readiness' then
  if p_input is not null and p_input<>'null'::jsonb then raise exception 'invalid_logo_readiness_input' using errcode='22023';end if;
  return to_jsonb(j.state='running' and fluid_private.logo_job_ready(j,j.worker_id));
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
end $$;

-- Scrub only new exact object OIDs, including hostile default and column ACLs.
-- Existing overloads, pre-existing function ACLs and default privileges survive.
do $$ declare relation_id oid:='fluid_private.logo_worker_readiness'::regclass; signature text;r record;c record;
begin
 for r in select distinct a.grantee from pg_class p cross join lateral aclexplode(coalesce(p.relacl,acldefault('r',p.relowner))) a where p.oid=relation_id and a.grantee<>p.relowner loop
  execute format('revoke all on table %s from %s cascade',relation_id::regclass,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
 end loop;
 for c in select at.attname,a.grantee from pg_attribute at join pg_class p on p.oid=at.attrelid cross join lateral aclexplode(at.attacl) a where p.oid=relation_id and a.grantee<>p.relowner loop
  execute format('revoke all (%I) on table %s from %s cascade',c.attname,relation_id::regclass,case when c.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(c.grantee)) end);
 end loop;
 alter table fluid_private.logo_worker_readiness enable row level security;
 alter table fluid_private.logo_worker_readiness force row level security;
 foreach signature in array array[
  'fluid_private.logo_policy_descriptor(fluid_private.logo_runtime_policies)',
  'fluid_private.logo_operation_ready(uuid,text)',
  'public.report_logo_worker_ready(text,jsonb,integer)',
  'fluid_private.invalidate_logo_worker_readiness()',
  'fluid_private.logo_job_policy_matches(public.jobs,fluid_private.logo_runtime_policies)',
  'fluid_private.logo_job_ready(public.jobs,text)',
  'fluid_private.lock_logo_job_readiness(public.jobs,text)'
 ] loop
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(signature) and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',signature,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
commit;
