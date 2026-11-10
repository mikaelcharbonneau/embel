-- NEW LOCAL CANDIDATE ONLY. No policies, principals or hosted grants are activated.
-- Independent V2 logo operations; generic identity.image and runner stay unchanged.
begin;
create table fluid_private.logo_worker_principals(role_name name primary key,role_oid oid not null unique,owner_id uuid not null references auth.users(id));
create table fluid_private.logo_runtime_policies(
 owner_id uuid not null references auth.users(id),operation text not null check(operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export')),
 policy_identity text not null check(policy_identity ~ '^[0-9a-f]{64}$'),handler_version text not null check(handler_version ~ '^[A-Za-z0-9._:-]{1,200}$'),
 provider text,model text,engine jsonb,max_cost_microusd bigint not null check(max_cost_microusd between 0 and 9007199254740991),enabled boolean not null default false,
 primary key(owner_id,operation),check((provider is null)=(model is null)),check(operation<>'identity.logo_concept' or (provider='openai' and model='gpt-image-2.5-sunburst-2026-09-08' and handler_version='logo-image-v1' and max_cost_microusd>0)),
 check(operation<>'identity.logo_vectorize' or (provider is null and model is null and engine is not null and max_cost_microusd=0))
);
create table public.logo_cost_quotes(
 id uuid primary key,owner_id uuid not null,project_id uuid not null,operation text not null,record jsonb not null,input_revisions jsonb not null,source_inputs jsonb not null,expires_at timestamptz not null,
 unique(id,owner_id,project_id),foreign key(project_id,owner_id) references public.projects(id,owner_id),check(octet_length(record::text)<=131072),check(octet_length(source_inputs::text)<=1048576)
);
create table public.logo_operation_requests(
 owner_id uuid not null,project_id uuid not null,request_key uuid not null,quote_id uuid,input jsonb not null,receipt jsonb not null,created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,project_id,request_key),unique(quote_id),foreign key(quote_id,owner_id,project_id) references public.logo_cost_quotes(id,owner_id,project_id),
 check(((quote_id is null)=(receipt->>'operation'='identity.logo_export')) is true),
 foreign key(project_id,owner_id) references public.projects(id,owner_id)
);
-- A committed rejection fences every delayed or explicit replay of this exact key.
create table public.logo_operation_rejections(
 owner_id uuid not null,project_id uuid not null,request_key uuid not null,input jsonb not null,receipt jsonb not null,created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,project_id,request_key),foreign key(project_id,owner_id) references public.projects(id,owner_id)
);
create table public.logo_concept_batches(
 id uuid primary key,owner_id uuid not null,project_id uuid not null,request_key uuid not null,brief_revision_id uuid not null,reference_snapshot_id uuid not null,plan jsonb not null,input_revisions jsonb not null,created_at timestamptz not null default clock_timestamp(),
 unique(id,owner_id,project_id),foreign key(project_id,owner_id) references public.projects(id,owner_id),foreign key(reference_snapshot_id,project_id,owner_id) references public.logo_reference_snapshots(id,project_id,owner_id)
);
create table public.logo_concept_slots(
 id uuid primary key,batch_id uuid not null,owner_id uuid not null,project_id uuid not null,ordinal integer not null check(ordinal between 0 and 5),logo_type text not null,direction_id text not null,
 unique(id,owner_id,project_id),unique(batch_id,ordinal),foreign key(batch_id,owner_id,project_id) references public.logo_concept_batches(id,owner_id,project_id)
);
create table public.logo_concept_attempts(
 id uuid primary key,owner_id uuid not null,project_id uuid not null,slot_id uuid not null,job_id uuid not null unique,request_key uuid not null,previous_attempt_id uuid,attempt_number integer not null check(attempt_number between 1 and 100),input_hash text not null,
 unique(id,owner_id,project_id),unique(slot_id,attempt_number),foreign key(slot_id,owner_id,project_id) references public.logo_concept_slots(id,owner_id,project_id),foreign key(previous_attempt_id,owner_id,project_id) references public.logo_concept_attempts(id,owner_id,project_id),foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),check((attempt_number=1)=(previous_attempt_id is null))
);
create table public.logo_raster_refinements(
 id uuid primary key,owner_id uuid not null,project_id uuid not null,request_key uuid not null,job_id uuid not null unique,source jsonb not null,logo_type text not null,input_revisions jsonb not null,created_at timestamptz not null default clock_timestamp(),
 unique(id,owner_id,project_id),foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
create table public.logo_provider_responses(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null,project_id uuid not null,job_id uuid not null,lease_token uuid not null,observation jsonb not null,
 unique(job_id),foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
-- A result is inserted only by atomic completion, never by a browser or byte uploader.
create table public.logo_raster_results(
 job_id uuid primary key,owner_id uuid not null,project_id uuid not null,preview jsonb not null,provider_response_receipt_id uuid not null references public.logo_provider_responses(id),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
create index logo_quotes_owned on public.logo_cost_quotes(owner_id,project_id);
create index logo_requests_owned on public.logo_operation_requests(owner_id,project_id,created_at desc);
create index logo_batches_owned on public.logo_concept_batches(owner_id,project_id,created_at desc,id desc);
create index logo_attempts_slot on public.logo_concept_attempts(owner_id,project_id,slot_id,attempt_number desc);
create index logo_refinements_owned on public.logo_raster_refinements(owner_id,project_id,created_at desc,id desc);

create function fluid_private.logo_worker_owner() returns uuid language sql stable security definer set search_path='' as $$
 select p.owner_id from fluid_private.logo_worker_principals p join pg_catalog.pg_roles r on r.oid=p.role_oid and r.rolname=p.role_name
 where p.role_name=session_user and r.rolcanlogin and not r.rolinherit and not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
 and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid)
$$;
create function fluid_private.logo_lock_job(p_job uuid,p_lease uuid) returns public.jobs language plpgsql set search_path='' as $$
declare j public.jobs; owner uuid:=fluid_private.logo_worker_owner();
begin
 if owner is null then raise exception 'logo_worker_unauthorized' using errcode='42501'; end if;
 select * into j from public.jobs where id=p_job and owner_id=owner and operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') for update;
 if not found or j.lease_token is distinct from p_lease or p_lease is null or j.lease_expires_at<=clock_timestamp() or j.state not in ('running','cancel_requested') then raise exception 'lease_lost' using errcode='40001'; end if;
 return j;
end $$;
create function fluid_private.logo_job_input_revisions(p_job public.jobs) returns jsonb language plpgsql stable set search_path='' as $$
declare result jsonb;
begin
 if p_job.operation='identity.logo_export' then return fluid_private.logo_export_input_revisions(p_job);end if;
 select q.input_revisions into result from public.logo_cost_quotes q where q.id=(p_job.input->>'quoteId')::uuid and q.owner_id=p_job.owner_id and q.project_id=p_job.project_id and q.record->>'inputHash'=p_job.input_hash;
 if result is null then raise exception 'logo_job_sources_missing' using errcode='55000'; end if;return result;end $$;
create function fluid_private.logo_plan(p_types jsonb,p_prior bigint) returns jsonb language plpgsql immutable set search_path='' as $$
declare types jsonb;slots jsonb:='[]';covered jsonb;uncovered jsonb;i integer;t jsonb;dirs text[]:=array['open_geometry','compact_structure','organic_motion','angular_energy','negative_space','expressive_detail'];
begin
 select jsonb_agg(value order by ordinality) into types from jsonb_array_elements('["wordmark","lettermark_monogram","pictorial","abstract","combination","emblem","mascot"]'::jsonb) with ordinality where p_types @> jsonb_build_array(value);
 if types is null then raise exception 'logo_types_required' using errcode='22023';end if;
 for i in 0..5 loop t:=types->(((p_prior+i)%jsonb_array_length(types))::integer);slots:=slots||jsonb_build_array(jsonb_build_object('ordinal',i,'type',t,'directionId',dirs[i+1]));end loop;
 select coalesce(jsonb_agg(t.value order by t.ordinality),'[]') into covered from jsonb_array_elements(types) with ordinality t where exists(select 1 from jsonb_array_elements(slots) s where s->'type'=t.value);
 select coalesce(jsonb_agg(t.value order by t.ordinality),'[]') into uncovered from jsonb_array_elements(types) with ordinality t where not exists(select 1 from jsonb_array_elements(slots) s where s->'type'=t.value);
 return jsonb_build_object('version',1,'targetCount',6,'requestedTypes',types,'slots',slots,'coveredTypes',covered,'uncoveredTypes',uncovered);
end $$;

create function fluid_private.logo_trace_settings_valid(v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
begin
 if not fluid_private.standalone_keys(v,array['preset','simplify','filterSpeckle','maxColors']) or jsonb_typeof(v->'preset') is distinct from 'string' or v->>'preset' not in ('bw','poster') or jsonb_typeof(v->'simplify') is distinct from 'number' or jsonb_typeof(v->'filterSpeckle') is distinct from 'number' or jsonb_typeof(v->'maxColors') is distinct from 'number' then return false;end if;
 return (v->>'simplify')::numeric between 0 and 2.5 and (v->>'filterSpeckle')::numeric between 0 and 16 and (v->>'filterSpeckle')::numeric=trunc((v->>'filterSpeckle')::numeric) and (v->>'maxColors')::numeric between 2 and 32 and (v->>'maxColors')::numeric=trunc((v->>'maxColors')::numeric) and (v->>'preset'<>'bw' or v->'maxColors'='2');
end $$;
create function public.quote_logo_operation(p_project_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
 total:=policy.max_cost_microusd::numeric*count;if total>9007199254740991 then raise exception 'logo_cost_overflow' using errcode='22003';end if;
 snapshot:=fluid_private.logo_snapshot_json(owner,p_project_id,brief.reference_snapshot_id);
 sources:=jsonb_build_object('brief',brief.record,'referenceSnapshot',snapshot,'raster',source);if direction is not null then sources:=sources||jsonb_build_object('direction',direction);end if;
 inputhash:=encode(sha256(convert_to(jsonb_build_object('request',p_input,'sources',sources,'policy',to_jsonb(policy),'plan',plan,'targets',targets)::text,'UTF8')),'hex');
 result:=jsonb_build_object('id',qid,'ownerId',owner,'projectId',p_project_id,'request',p_input,'inputHash',inputhash,'expected',p_input->'expected','policyIdentity',policy.policy_identity,'handlerVersion',policy.handler_version,'provider',policy.provider,'model',policy.model,'engine',case when policy.engine is null then null else policy.engine||jsonb_build_object('settingsHash',encode(sha256(convert_to((p_input->'settings')::text,'UTF8')),'hex')) end,'estimatedCostMicrousd',total,'maxCostMicrousd',total,'externalProviderCostMicrousd',case when policy.provider is null then 0 else total end,'expiresAt',to_char(expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'conceptPlan',plan,'targetSlotIds',targets);
 insert into public.logo_cost_quotes values(qid,owner,p_project_id,op,result,inputs,sources,expires);return result;
end $$;

create function fluid_private.reject_logo_admission(p_owner uuid,p_project uuid,p_input jsonb,p_error text) returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;
begin
 if p_error not in ('conflict','not_found') then raise exception 'invalid_admission_rejection' using errcode='22023';end if;
 result:=jsonb_build_object('kind','logo_admission_rejected','errorCode',p_error,'rejection',jsonb_build_object('status','rejected','ownerId',p_owner,'projectId',p_project,'requestKey',p_input->'requestKey','quoteId',p_input->'quoteId'));
 insert into public.logo_operation_rejections(owner_id,project_id,request_key,input,receipt) values(p_owner,p_project,(p_input->>'requestKey')::uuid,p_input,result);return result;
end $$;
create function public.admit_logo_operation(p_project_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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

create function public.claim_logo_job(p_worker text,p_seconds integer) returns setof public.jobs language plpgsql security definer set search_path='' as $$
declare owner uuid:=fluid_private.logo_worker_owner();j public.jobs;account public.usage_accounts;pending_paid boolean;
begin
 if owner is null then raise exception 'logo_worker_unauthorized' using errcode='42501';end if;
 if p_seconds not between 10 and 300 or p_seconds is null or p_worker is null or length(p_worker) not between 1 and 200 then raise exception 'invalid_lease' using errcode='22023';end if;
 select candidate.* into j from public.jobs candidate join public.usage_accounts a on a.owner_id=candidate.owner_id
 where candidate.owner_id=owner and candidate.operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') and candidate.state='queued' and candidate.attempts<candidate.max_attempts
 and (a.reserved_microusd<=a.limit_microusd-greatest(a.spent_microusd,a.provider_actual_microusd) or not exists(
  select 1 from jsonb_array_elements(candidate.plan_manifest) planned where (planned->>'maximumCostMicrousd')::numeric>0 and not exists(select 1 from public.job_steps done where done.job_id=candidate.id and done.step_key=planned->>'key' and done.state='succeeded')))
 order by candidate.created_at,candidate.id for update of candidate skip locked limit 1;
 if not found then return;end if;
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
create function public.heartbeat_logo_job(p_job uuid,p_lease uuid,p_seconds integer) returns public.jobs language plpgsql security definer set search_path='' as $$
declare j public.jobs;begin j:=fluid_private.logo_lock_job(p_job,p_lease);if p_seconds not between 10 and 300 or p_seconds is null then raise exception 'invalid_lease' using errcode='22023';end if;update public.jobs set lease_expires_at=clock_timestamp()+make_interval(secs=>p_seconds) where id=j.id returning * into j;return j;end $$;
create function public.register_logo_job_plan(p_job uuid,p_lease uuid,p_manifest jsonb) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;begin j:=fluid_private.logo_lock_job(p_job,p_lease);if j.state<>'running' then raise exception 'cancel_requested' using errcode='55000';end if;if j.plan_manifest is null or j.plan_manifest is distinct from p_manifest then raise exception 'plan_conflict' using errcode='40001';end if;end $$;
create function public.begin_logo_job_step(p_job uuid,p_lease uuid,p_step text,p_key text,p_cost bigint) returns text language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.job_steps;account public.usage_accounts;
begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);if j.state<>'running' then raise exception 'cancel_requested' using errcode='55000';end if;
 if j.operation='identity.logo_export' then
  if p_cost is distinct from 0 or j.reserved_cost_microusd<>0 or j.actual_cost_microusd<>0 or j.input ? 'quoteId' or p_step<>'prepare-export' or not exists(
   select 1 from fluid_private.logo_runtime_policies p where p.owner_id=j.owner_id and p.operation=j.operation and p.enabled and p.policy_identity=j.input->>'policyIdentity' and p.handler_version=j.input->>'handlerVersion' and p.handler_version='logo-export-v1' and p.provider is null and p.model is null and p.max_cost_microusd=0) then raise exception 'logo_export_policy_revoked' using errcode='55000';end if;
  perform fluid_private.logo_export_input_revisions(j);
 elsif not exists(select 1 from public.logo_cost_quotes q join fluid_private.logo_runtime_policies p on p.owner_id=q.owner_id and p.operation=q.operation where q.id=(j.input->>'quoteId')::uuid and q.owner_id=j.owner_id and q.project_id=j.project_id and p.enabled and p.policy_identity=j.input->>'policyIdentity' and p.handler_version=j.input->>'handlerVersion') then raise exception 'logo_policy_revoked' using errcode='55000';end if;
 if not exists(select 1 from jsonb_array_elements(j.plan_manifest) m where m->>'key'=p_step and (m->>'maximumCostMicrousd')::bigint=p_cost) then raise exception 'plan_conflict' using errcode='40001';end if;
 select * into s from public.job_steps where job_id=j.id and step_key=p_step;
 if found then if s.state='succeeded' and s.request_key=p_key and s.reserved_cost_microusd=p_cost then return 'already_succeeded';end if;raise exception 'step_requires_reconciliation_or_new_job' using errcode='55000';end if;
 if p_cost<0 or p_cost>j.reserved_cost_microusd-j.actual_cost_microusd or exists(select 1 from public.job_steps where job_id=j.id and state in ('in_flight','ambiguous','failed')) then raise exception 'unsafe_step' using errcode='55000';end if;
 -- Already claimed siblings must recheck the same aggregate reservation
 -- fence immediately before persisting a new paid dispatch boundary.
 if p_cost>0 then
  select * into account from public.usage_accounts where owner_id=j.owner_id for share;
  if not found or account.reserved_microusd>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd) then raise exception 'budget_exceeded' using errcode='P0001';end if;
 end if;
 insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values(j.id,j.owner_id,j.project_id,p_step,p_key,'in_flight',p_cost);return 'started';
end $$;
create function public.record_logo_provider_response(p_job uuid,p_lease uuid,p_observation jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;q public.logo_cost_quotes;r public.logo_provider_responses;b jsonb;
begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
 if not fluid_private.standalone_keys(p_observation-'normalizedPixelHash',array['provider','model','providerRequestId','responseHash','observedAt','billing','artifactHash']) or octet_length(p_observation::text)>32768 or p_observation->'provider' is distinct from q.record->'provider' or p_observation->'model' is distinct from q.record->'model' or q.record->'provider'='null' or not fluid_private.standalone_timestamp(p_observation->'observedAt') or (p_observation->>'observedAt')::timestamptz>clock_timestamp()+interval '1 minute' then raise exception 'invalid_provider_evidence' using errcode='22023';end if;
 if p_observation ? 'normalizedPixelHash' and (jsonb_typeof(p_observation->'normalizedPixelHash') is distinct from 'string' or p_observation->>'normalizedPixelHash' !~ '^[0-9a-f]{64}$') then raise exception 'invalid_pixel_evidence' using errcode='22023';end if;
 b:=p_observation->'billing';if not fluid_private.standalone_keys(b,array['status','confirmedMicrousd']) or ((b->>'status'='unknown' and b->'confirmedMicrousd'='null') or (b->>'status'='recorded' and jsonb_typeof(b->'confirmedMicrousd')='number' and (b->>'confirmedMicrousd')::numeric between 0 and 9007199254740991 and trunc((b->>'confirmedMicrousd')::numeric)=(b->>'confirmedMicrousd')::numeric)) is not true then raise exception 'invalid_billing_evidence' using errcode='22023';end if;
 if not exists(select 1 from public.job_steps where job_id=j.id and state='in_flight') then raise exception 'provider_step_not_started' using errcode='55000';end if;
 if (p_observation->'providerRequestId'<>'null' and (jsonb_typeof(p_observation->'providerRequestId')<>'string' or length(p_observation->>'providerRequestId') not between 1 and 200)) or (p_observation->'artifactHash'<>'null' and (jsonb_typeof(p_observation->'artifactHash') is distinct from 'string' or (p_observation->>'artifactHash') !~ '^[0-9a-f]{64}$')) or (p_observation->'responseHash'<>'null' and (jsonb_typeof(p_observation->'responseHash') is distinct from 'string' or (p_observation->>'responseHash') !~ '^[0-9a-f]{64}$')) then raise exception 'invalid_provider_evidence' using errcode='22023';end if;
 select * into r from public.logo_provider_responses where job_id=j.id;
 if found then if r.observation is distinct from p_observation or r.lease_token<>p_lease then raise exception 'provider_evidence_immutable' using errcode='PT409';end if;
 else insert into public.logo_provider_responses(owner_id,project_id,job_id,lease_token,observation) values(j.owner_id,j.project_id,j.id,p_lease,p_observation) returning * into r;end if;
 return r.observation||jsonb_build_object('id',r.id,'ownerId',r.owner_id,'projectId',r.project_id,'jobId',r.job_id,'leaseToken',r.lease_token);
end $$;
create function public.complete_logo_job_step(p_job_id uuid,p_lease_token uuid,p_step_key text,p_state text,p_actual_cost_microusd bigint,p_output jsonb,p_provider_request_id text) returns public.job_steps language plpgsql security definer set search_path='' as $$
<<completion>>
declare j public.jobs;s public.job_steps;r public.logo_provider_responses;reservation public.usage_reservations;output jsonb;receipt jsonb;reason text;state text:=p_state;paid boolean;q public.logo_cost_quotes;current_heads jsonb;payload jsonb;revision jsonb;duplicate boolean:=false;
begin
 -- Project-first order matches manual publication/admission and prevents lock inversion.
 perform 1 from public.projects where id=(select project_id from public.jobs where id=p_job_id and owner_id=fluid_private.logo_worker_owner()) for update;
 j:=fluid_private.logo_lock_job(p_job_id,p_lease_token);
 select * into s from public.job_steps where job_id=j.id and step_key=p_step_key for update;if not found then raise exception 'step_not_found' using errcode='P0002';end if;
 if state is null or state not in ('succeeded','failed','ambiguous') or p_actual_cost_microusd is null or p_actual_cost_microusd not between 0 and 9007199254740991 or octet_length(p_output::text)>1048576 then raise exception 'invalid_outcome' using errcode='22023';end if;
 if s.state<>'in_flight' then if (s.state,s.actual_cost_microusd,s.output,s.provider_request_id) is not distinct from (state,p_actual_cost_microusd,p_output,p_provider_request_id) then return s;end if;raise exception 'immutable_outcome' using errcode='55000';end if;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
 paid:=q.record->'provider'<>'null' and (j.operation in ('identity.logo_concept','identity.logo_directions') or p_step_key='generate-refinement');
 output:=case when state='succeeded' then p_output else p_output->'result' end;reason:=p_output->>'error';
 if p_state='failed' and output is not null and output<>'null' and j.operation<>'identity.logo_export' then raise exception 'failed_publication_not_supported' using errcode='22023';end if;
 if j.operation='identity.logo_export' and (p_actual_cost_microusd<>0 or p_provider_request_id is not null or j.reserved_cost_microusd<>0 or p_step_key<>'prepare-export') then raise exception 'invalid_zero_cost_export' using errcode='22023';end if;
 select * into r from public.logo_provider_responses where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=p_lease_token;
 if paid then
  if state='succeeded' and (r.id is null or r.observation#>>'{billing,status}'<>'recorded' or r.observation->>'providerRequestId' is null or r.observation->>'responseHash' is null) then raise exception 'provider_evidence_required' using errcode='55000';end if;
  if r.id is not null and ((r.observation->>'providerRequestId') is distinct from p_provider_request_id or (r.observation#>>'{billing,status}'='recorded' and (r.observation#>>'{billing,confirmedMicrousd}')::bigint<>p_actual_cost_microusd)) then raise exception 'provider_evidence_mismatch' using errcode='22023';end if;
  if r.id is not null and r.observation#>>'{billing,status}'='unknown' then state:='ambiguous';reason:=case when output is not null then 'billing_unknown' else 'provider_outcome_unknown' end;end if;
  if state='failed' and r.id is null and not (reason='not_dispatched' and p_actual_cost_microusd=0 and p_provider_request_id is null) then state:='ambiguous';reason:='provider_outcome_unknown';end if;
 end if;
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
 if p_actual_cost_microusd>s.reserved_cost_microusd or j.actual_cost_microusd+p_actual_cost_microusd>j.reserved_cost_microusd then state:='ambiguous';reason:='provider_cost_exceeded';end if;
 select * into reservation from public.usage_reservations where job_id=j.id for update;
 update public.usage_accounts set spent_microusd=spent_microusd+least(greatest(reservation.reserved_microusd-reservation.actual_microusd,0),p_actual_cost_microusd),provider_actual_microusd=provider_actual_microusd+p_actual_cost_microusd,reserved_microusd=reserved_microusd-least(greatest(reservation.reserved_microusd-reservation.actual_microusd,0),p_actual_cost_microusd) where owner_id=j.owner_id;
 update public.usage_reservations set actual_microusd=actual_microusd+p_actual_cost_microusd,captured_microusd=captured_microusd+least(greatest(reservation.reserved_microusd-reservation.actual_microusd,0),p_actual_cost_microusd) where job_id=j.id;
 update public.job_steps set state=completion.state,actual_cost_microusd=p_actual_cost_microusd,output=p_output,provider_request_id=p_provider_request_id,completed_at=clock_timestamp() where id=s.id returning * into s;
 update public.jobs set actual_cost_microusd=actual_cost_microusd+p_actual_cost_microusd where id=j.id;
 if state='ambiguous' then update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null,error_code=coalesce(reason,'provider_outcome_unknown') where id=j.id;
 elsif duplicate then perform fluid_private.settle_reservation(j.id);update public.jobs set state='failed',lease_token=null,lease_expires_at=null,error_code='duplicate_preview',finished_at=clock_timestamp() where id=j.id;end if;
 return s;
end $$;

create function public.finish_logo_job(p_job_id uuid, p_lease_token uuid, p_state text)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_has_output boolean;
begin
  v_job := fluid_private.logo_lock_job(p_job_id, p_lease_token);
  if p_state is null or p_state not in ('succeeded','failed','partial','cancelled') then raise exception 'invalid_outcome' using errcode = '22023'; end if;
  if exists(select 1 from public.job_steps where job_id = p_job_id and state in ('in_flight','ambiguous')) then
    raise exception 'unresolved_steps' using errcode = '55000';
  end if;
  if v_job.state = 'cancel_requested' and p_state <> 'cancelled' then raise exception 'cancel_requested' using errcode = '55000'; end if;
  select exists(select 1 from public.job_steps where job_id = p_job_id and state = 'succeeded') into v_has_output;
  if (p_state in ('succeeded','partial') and not v_has_output) or
      (p_state = 'succeeded' and exists(select 1 from public.job_steps where job_id = p_job_id and state <> 'succeeded')) or
      (p_state = 'failed' and v_has_output) then raise exception 'invalid_outcome' using errcode = '22023'; end if;
  if p_state = 'succeeded' then
    if v_job.plan_manifest is null or exists(
        select 1 from jsonb_array_elements(v_job.plan_manifest) planned(step)
        where not exists(select 1 from public.job_steps s where s.job_id = p_job_id
          and s.step_key = planned.step->>'key' and s.state = 'succeeded'
          and s.reserved_cost_microusd = (planned.step->>'maximumCostMicrousd')::numeric))
        or exists(select 1 from public.job_steps s where s.job_id = p_job_id and not exists(
          select 1 from jsonb_array_elements(v_job.plan_manifest) planned(step) where planned.step->>'key' = s.step_key)) then
      raise exception 'plan_incomplete' using errcode = '55000';
    end if;
  end if;
  perform fluid_private.settle_reservation(p_job_id);
  update public.jobs set state = p_state, error_code = case when p_state in ('failed','partial') then 'operation_incomplete' else null end,
    progress = case when p_state = 'succeeded' then 100 else progress end,
    lease_token = null, lease_expires_at = null, finished_at = clock_timestamp() where id = p_job_id returning * into v_job;
  return v_job;
end $$;

create function fluid_private.logo_job_observation(p_job public.jobs) returns jsonb language plpgsql stable set search_path='' as $$
declare r public.logo_raster_results;b jsonb;status text;reason text;provider_id uuid;
begin
 select * into r from public.logo_raster_results where job_id=p_job.id and owner_id=p_job.owner_id and project_id=p_job.project_id;
 select observation->'billing',id into b,provider_id from public.logo_provider_responses where job_id=p_job.id and owner_id=p_job.owner_id and project_id=p_job.project_id;
 if b is null then
  if p_job.operation in ('identity.logo_vectorize','identity.logo_export') or not exists(select 1 from public.job_steps where job_id=p_job.id) or (p_job.state in ('cancelled','failed') and not exists(select 1 from public.job_steps where job_id=p_job.id and (state in ('ambiguous','in_flight') or output->>'error' is distinct from 'not_dispatched'))) then b:=jsonb_build_object('status','recorded','confirmedMicrousd',0);
  else b:=jsonb_build_object('status','unknown','confirmedMicrousd',null);end if;
 end if;
 status:=case when p_job.state='cancel_requested' then 'running' when p_job.state='partial' then 'failed' else p_job.state end;
 reason:=p_job.error_code;
 if r.preview is not null and b->>'status'='unknown' then status:='needs_reconciliation';reason:='billing_unknown';end if;
 if status='needs_reconciliation' and reason is null then reason:='provider_outcome_unknown';end if;
 return jsonb_build_object('preview',r.preview,'providerResponseReceiptId',provider_id,'state',status,'billing',b,'reason',reason);
end $$;
create function fluid_private.logo_job_record(p_owner uuid,p_project uuid,p_kind text,p_id uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare batch public.logo_concept_batches;slot public.logo_concept_slots;attempt public.logo_concept_attempts;j public.jobs;raster public.logo_raster_refinements;slots jsonb:='[]';attempts jsonb;observation jsonb;
begin
 if p_kind='concept_batch' then
  select * into batch from public.logo_concept_batches where id=p_id and owner_id=p_owner and project_id=p_project;if not found then raise exception 'logo_batch_not_found' using errcode='P0002';end if;
  for slot in select * from public.logo_concept_slots where batch_id=batch.id and owner_id=p_owner and project_id=p_project order by ordinal loop
   attempts:='[]';for attempt in select * from public.logo_concept_attempts where slot_id=slot.id and owner_id=p_owner and project_id=p_project order by attempt_number loop
    select * into j from public.jobs where id=attempt.job_id and owner_id=p_owner and project_id=p_project;observation:=fluid_private.logo_job_observation(j);
    attempts:=attempts||jsonb_build_array(jsonb_build_object('id',attempt.id,'jobId',j.id,'slotId',slot.id,'requestKey',attempt.request_key,'previousAttemptId',attempt.previous_attempt_id,'attemptNumber',attempt.attempt_number,'inputHash',attempt.input_hash,'reservedCostMicrousd',j.reserved_cost_microusd)||observation);
   end loop;
   slots:=slots||jsonb_build_array(jsonb_build_object('id',slot.id,'ordinal',slot.ordinal,'type',slot.logo_type,'directionId',slot.direction_id,'attempts',attempts,'acceptedPreview',null));
  end loop;
  return jsonb_build_object('version',2,'id',batch.id,'ownerId',p_owner,'projectId',p_project,'requestKey',batch.request_key,'briefRevisionId',batch.brief_revision_id,'referenceSnapshotId',batch.reference_snapshot_id,'targetCount',6,'plan',batch.plan,'slots',slots,'createdAt',to_char(batch.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 elsif p_kind='raster_refinement' then
  select * into raster from public.logo_raster_refinements where id=p_id and owner_id=p_owner and project_id=p_project;if not found then raise exception 'logo_raster_not_found' using errcode='P0002';end if;
  select * into j from public.jobs where id=raster.job_id and owner_id=p_owner and project_id=p_project;
  return jsonb_build_object('version',2,'id',raster.id,'ownerId',p_owner,'projectId',p_project,'requestKey',raster.request_key,'jobId',j.id,'source',raster.source,'logoType',raster.logo_type,'inputRevisions',raster.input_revisions,'createdAt',to_char(raster.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))||fluid_private.logo_job_observation(j);
 else raise exception 'invalid_logo_read_kind' using errcode='22023';end if;
end $$;
create function fluid_private.logo_job_records(p_owner uuid,p_project uuid,p_kind text,p_query jsonb) returns jsonb language plpgsql stable set search_path='' as $$
declare n integer;cursor_id uuid;cursor_time timestamptz;row public.logo_raster_refinements;batch public.logo_concept_batches;items jsonb:='[]';next_cursor text;seen integer:=0;
begin
 if p_kind not in ('raster_refinement','concept_batch') or jsonb_typeof(p_query) is distinct from 'object' or p_query-array['cursor','limit']<>'{}' then raise exception 'invalid_logo_query' using errcode='22023';end if;
 if p_query ? 'limit' and (jsonb_typeof(p_query->'limit')<>'number' or (p_query->>'limit')::numeric<>trunc((p_query->>'limit')::numeric) or (p_query->>'limit')::numeric not between 1 and 50) then raise exception 'invalid_logo_limit' using errcode='22023';end if;n:=coalesce((p_query->>'limit')::integer,20);
 if p_kind='concept_batch' then
  if p_query ? 'cursor' then
   if not fluid_private.logo_uuid(p_query->'cursor') then raise exception 'invalid_logo_cursor' using errcode='22023';end if;
   cursor_id:=(p_query->>'cursor')::uuid;select created_at into cursor_time from public.logo_concept_batches where id=cursor_id and owner_id=p_owner and project_id=p_project;
   if not found then raise exception 'invalid_logo_cursor' using errcode='22023';end if;
  end if;
  for batch in select * from public.logo_concept_batches where owner_id=p_owner and project_id=p_project and (cursor_id is null or (created_at,id)<(cursor_time,cursor_id)) order by created_at desc,id desc limit n+1 loop
   seen:=seen+1;if seen>n then return jsonb_build_object('ownerId',p_owner,'projectId',p_project,'items',items,'nextCursor',next_cursor);end if;
   items:=items||jsonb_build_array(jsonb_build_object('id',batch.id,'requestKey',batch.request_key,'createdAt',to_char(batch.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));next_cursor:=batch.id::text;
  end loop;return jsonb_build_object('ownerId',p_owner,'projectId',p_project,'items',items,'nextCursor',null);
 end if;
 if p_query ? 'cursor' then if not fluid_private.logo_uuid(p_query->'cursor') then raise exception 'invalid_logo_cursor' using errcode='22023';end if;cursor_id:=(p_query->>'cursor')::uuid;select created_at into cursor_time from public.logo_raster_refinements where id=cursor_id and owner_id=p_owner and project_id=p_project;if not found then raise exception 'invalid_logo_cursor' using errcode='22023';end if;end if;
 for row in select * from public.logo_raster_refinements where owner_id=p_owner and project_id=p_project and (cursor_id is null or (created_at,id)<(cursor_time,cursor_id)) order by created_at desc,id desc limit n+1 loop
  seen:=seen+1;if seen>n then return jsonb_build_object('ownerId',p_owner,'projectId',p_project,'items',items,'nextCursor',next_cursor);end if;
  items:=items||jsonb_build_array(fluid_private.logo_job_record(p_owner,p_project,'raster_refinement',row.id));next_cursor:=row.id::text;
 end loop;return jsonb_build_object('ownerId',p_owner,'projectId',p_project,'items',items,'nextCursor',null);
end $$;
create function fluid_private.resolve_logo_raster_source(p_owner uuid,p_project uuid,p_source jsonb) returns jsonb language plpgsql stable set search_path='' as $$
declare result jsonb;jid uuid;inputs jsonb;typ text;
begin
 if p_source->>'kind'='concept' and fluid_private.standalone_keys(p_source,array['kind','batchId','slotId','attemptId']) and fluid_private.logo_uuid(p_source->'batchId') and fluid_private.logo_uuid(p_source->'slotId') and fluid_private.logo_uuid(p_source->'attemptId') then
  select a.job_id,b.input_revisions,s.logo_type into jid,inputs,typ from public.logo_concept_attempts a join public.logo_concept_slots s on s.id=a.slot_id and s.owner_id=a.owner_id and s.project_id=a.project_id join public.logo_concept_batches b on b.id=s.batch_id and b.owner_id=s.owner_id and b.project_id=s.project_id where a.id=(p_source->>'attemptId')::uuid and s.id=(p_source->>'slotId')::uuid and b.id=(p_source->>'batchId')::uuid and a.owner_id=p_owner and a.project_id=p_project;
 elsif p_source->>'kind'='refinement' and fluid_private.standalone_keys(p_source,array['kind','rasterRevisionId']) and fluid_private.logo_uuid(p_source->'rasterRevisionId') then
  select job_id,input_revisions,logo_type into jid,inputs,typ from public.logo_raster_refinements where id=(p_source->>'rasterRevisionId')::uuid and owner_id=p_owner and project_id=p_project;
 else raise exception 'invalid_logo_source' using errcode='22023';end if;
 select preview into result from public.logo_raster_results where job_id=jid and owner_id=p_owner and project_id=p_project;
 if result is null or result->>'publicationState'<>'committed' then raise exception 'logo_source_not_found' using errcode='P0002';end if;
 return jsonb_build_object('source',p_source,'preview',result,'inputRevisions',inputs,'logoType',typ);
end $$;
create function fluid_private.logo_job_can_read_asset(p_job public.jobs,p_reference jsonb) returns boolean language plpgsql stable set search_path='' as $$
declare q public.logo_cost_quotes;item jsonb;
begin
 if p_reference->>'ownerId' is distinct from p_job.owner_id::text or p_reference->>'projectId' is distinct from p_job.project_id::text then return false;end if;
 if p_job.operation='identity.logo_export' then return fluid_private.logo_export_can_read_asset(p_job,p_reference);end if;
 select * into q from public.logo_cost_quotes where id=(p_job.input->>'quoteId')::uuid and owner_id=p_job.owner_id and project_id=p_job.project_id;
 if not found then return false;end if;
 if p_job.operation='identity.logo_directions' then
  if p_reference in (q.source_inputs#>'{direction,logoRevision,documentAsset}',q.source_inputs#>'{direction,logoRevision,svgAsset}',q.source_inputs#>'{direction,logoRevision,sourcePreview}') then return true;end if;
  if exists(select 1 from jsonb_array_elements(q.source_inputs#>'{direction,permittedFonts}') f where f->'asset'=p_reference) then return true;end if;
 end if;
 for item in select value from jsonb_array_elements(q.source_inputs#>'{referenceSnapshot,references}') loop
  if item->'asset'=p_reference and exists(select 1 from public.logo_reference_sources s where s.owner_id=p_job.owner_id and s.project_id=p_job.project_id and s.reference_id=(item->>'referenceId')::uuid and s.asset_id=(p_reference->>'assetId')::uuid and s.version_id=(p_reference->>'versionId')::uuid and s.content_hash=p_reference->>'contentHash' and s.rights_evidence_id=(item->>'rightsEvidenceId')::uuid and s.source_kind=item->>'sourceKind') then return true;end if;
 end loop;
 if q.source_inputs#>'{raster,preview,reference}'=p_reference then return exists(select 1 from public.logo_raster_results r where r.owner_id=p_job.owner_id and r.project_id=p_job.project_id and r.preview#>'{reference}'=p_reference);end if;
 return exists(select 1 from public.logo_raster_results r where r.job_id=p_job.id and r.owner_id=p_job.owner_id and r.project_id=p_job.project_id and r.preview->'reference'=p_reference);
end $$;
create function public.read_leased_logo_record(p_job uuid,p_lease uuid,p_kind text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;q public.logo_cost_quotes;result jsonb;
begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
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
create function public.read_logo_request(p_project_id uuid,p_request_key uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid();request public.logo_operation_requests;rejected public.logo_operation_rejections;proof jsonb;receipt jsonb;j public.jobs;observation jsonb;outputs jsonb:='[]';status text:='admitted';uncertain boolean:=false;running boolean:=false;successes integer:=0;failures integer:=0;cancelled integer:=0;total integer:=0;billing_known boolean:=true;cost bigint:=0;reason text;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501';end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=owner) then raise exception 'logo_project_not_found' using errcode='P0002';end if;
 select * into request from public.logo_operation_requests where owner_id=owner and project_id=p_project_id and request_key=p_request_key;
 if not found then
  select * into rejected from public.logo_operation_rejections where owner_id=owner and project_id=p_project_id and request_key=p_request_key;
  if found then
   receipt:=jsonb_build_object('status','failed','requestKey',p_request_key,'receipt',null,'outputs','[]'::jsonb,'billing',jsonb_build_object('status','recorded','confirmedMicrousd',0),'reason','admission_rejected');
   if rejected.receipt->>'kind'='logo_export_admission_rejected' then
    proof:=rejected.receipt->'rejection';
    if (jsonb_typeof(proof)='object' and proof->>'status'='rejected' and proof->>'operation'='identity.logo_export' and proof->>'ownerId'=owner::text and proof->>'projectId'=p_project_id::text and proof->>'requestKey'=p_request_key::text and proof->'input'=rejected.input and proof#>>'{input,requestKey}'=p_request_key::text) is not true then raise exception 'invalid_export_rejection_proof' using errcode='55000';end if;
    receipt:=receipt||jsonb_build_object('rejection',proof);
   end if;
   return receipt;
  end if;
  return public.read_logo_workspace_record(p_project_id,'manual_request',p_request_key);
 end if;
 for j in select * from public.jobs where owner_id=owner and project_id=p_project_id and id in (select (value#>>'{}')::uuid from jsonb_array_elements(request.receipt->'jobIds')) order by id loop
  total:=total+1;observation:=fluid_private.logo_job_observation(j);
  if observation->'preview'<>'null' then outputs:=outputs||jsonb_build_array(observation->'preview');end if;
  if j.operation='identity.logo_export' then outputs:=outputs||fluid_private.logo_export_job_outputs(j);end if;
  if observation#>>'{billing,status}'<>'recorded' then billing_known:=false;else cost:=cost+(observation#>>'{billing,confirmedMicrousd}')::bigint;end if;
  uncertain:=uncertain or j.state='needs_reconciliation';running:=running or j.state in ('running','cancel_requested');
  if j.state='succeeded' then successes:=successes+1;elsif j.state in ('failed','partial') then failures:=failures+1;elsif j.state='cancelled' then cancelled:=cancelled+1;end if;
 end loop;
 if uncertain then status:='needs_reconciliation';reason:='provider_outcome_unknown';elsif successes=total then status:='succeeded';elsif running or (successes+failures+cancelled>0 and successes+failures+cancelled<total) then status:='running';elsif successes>0 or (failures>0 and cancelled>0) then status:='partial';elsif failures=total then status:='failed';elsif cancelled=total then status:='cancelled';end if;
 if status='failed' and request.receipt->>'operation'='identity.logo_export' and jsonb_array_length(outputs)>0 then status:='partial';reason:='export_partial';end if;
 if jsonb_array_length(outputs)>0 and not billing_known then status:='needs_reconciliation';reason:='billing_unknown';end if;
 return jsonb_build_object('status',status,'requestKey',p_request_key,'receipt',request.receipt,'outputs',outputs,'billing',case when billing_known then jsonb_build_object('status','recorded','confirmedMicrousd',cost) else jsonb_build_object('status','unknown','confirmedMicrousd',null) end,'reason',reason);
end $$;
create function public.reconcile_logo_request(p_project_id uuid,p_request_key uuid) returns jsonb language sql stable security definer set search_path='' as $$select public.read_logo_request(p_project_id,p_request_key)$$;
create function public.expire_logo_job_leases() returns integer language plpgsql security definer set search_path='' as $$
declare owner uuid:=fluid_private.logo_worker_owner();j public.jobs;next text;n integer:=0;
begin
 if owner is null then raise exception 'logo_worker_unauthorized' using errcode='42501';end if;
 for j in select * from public.jobs where owner_id=owner and operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') and state in ('running','cancel_requested') and lease_expires_at<=clock_timestamp() for update skip locked loop
  if exists(select 1 from public.job_steps where job_id=j.id and state in ('in_flight','ambiguous')) then next:='needs_reconciliation';
  elsif j.state='cancel_requested' then next:='cancelled';
  elsif exists(select 1 from public.job_steps where job_id=j.id and state='failed') then
   next:=case when exists(select 1 from public.job_steps where job_id=j.id and state='succeeded') then 'partial' else 'failed' end;
  elsif j.attempts<j.max_attempts then next:='queued';elsif exists(select 1 from public.job_steps where job_id=j.id and state='succeeded') then next:='partial';else next:='failed';end if;
  if next in ('failed','cancelled','partial') then perform fluid_private.settle_reservation(j.id);end if;
  update public.jobs set state=next,lease_token=null,lease_expires_at=null,error_code='lease_expired',finished_at=case when next in ('failed','partial','cancelled') then clock_timestamp() else null end where id=j.id;n:=n+1;
 end loop;return n;
end $$;

-- Additive V2 operation isolation. Existing API/subscription worker grants and
-- old operation semantics are preserved; only these five new jobs use logo RPCs.
create or replace function fluid_private.lock_leased_job(p_job_id uuid,p_lease_token uuid)
returns public.jobs language plpgsql set search_path = '' as $$
declare v_job public.jobs; v_owner uuid:=public.subscription_worker_owner();
  v_api_worker boolean:=(session_user='service_role' or pg_catalog.current_setting('role',true)='service_role');
begin
  select * into v_job from public.jobs where id=p_job_id;
  if not found then raise exception 'lease_lost' using errcode='40001'; end if;
  if v_job.operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') then raise exception 'logo_worker_required' using errcode='42501';end if;
  if (v_job.billing_mode='chatgpt_subscription' and (v_owner is null or v_job.owner_id is distinct from v_owner))
    or (v_job.billing_mode='openai_api' and (v_owner is not null or not v_api_worker)) then
    raise exception 'worker_owner_mismatch' using errcode='42501';
  end if;
  -- Check identity before acquiring the row lock, then retain both predicates
  -- while locking so even an administrative concurrent edit cannot cross modes.
  select j.* into v_job from public.jobs j where j.id=p_job_id and j.operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') and
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
  for v_job in select * from public.jobs where operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') and lease_expires_at<=clock_timestamp() and state in ('running','cancel_requested')
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
    where j.operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') and j.billing_mode = 'openai_api' and j.state = 'queued' and j.attempts < j.max_attempts
      and a.reserved_microusd <= a.limit_microusd - greatest(a.spent_microusd, a.provider_actual_microusd)
    order by j.created_at, j.id for update of j skip locked limit 1;
  if not found then return; end if;
  return query update public.jobs set state = 'running', lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
    worker_id = p_worker_id, attempts = attempts + 1 where id = v_job.id returning *;
end $$;

create or replace function public.claim_subscription_job(p_worker_id text,p_owner_id uuid,p_registration_id text,p_lease_seconds integer default 60)
returns setof public.jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_owner uuid:=public.subscription_worker_owner();
begin
 if v_owner is null or p_owner_id is distinct from v_owner then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
 if p_worker_id is null or length(p_worker_id) not between 1 and 100 or p_lease_seconds is null or p_lease_seconds not between 5 and 300 then raise exception 'invalid_lease' using errcode='22023'; end if;
 select j.* into v_job from public.jobs j join fluid_private.subscription_runtime_policy p on p.owner_id=j.owner_id and p.operation=j.operation
   where j.operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') and j.billing_mode='chatgpt_subscription' and j.state='queued' and j.attempts<j.max_attempts and j.owner_id=p_owner_id
     and p.registration_id=p_registration_id and p.enabled and p.worker_ready_until>clock_timestamp() and p.policy=j.input->'policy'
   order by j.created_at,j.id for update of j skip locked limit 1;
 if not found then return; end if;
 return query update public.jobs set state='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
   worker_id=p_worker_id,attempts=attempts+1 where id=v_job.id returning *;
end $$;

-- Remove hostile default ACLs only from this exact new-object inventory.
do $$ declare name text; signature text; r record; col_acl record; begin
foreach name in array array['fluid_private.logo_worker_principals','fluid_private.logo_runtime_policies','public.logo_cost_quotes','public.logo_operation_requests','public.logo_operation_rejections','public.logo_concept_batches','public.logo_concept_slots','public.logo_concept_attempts','public.logo_raster_refinements','public.logo_provider_responses','public.logo_raster_results'] loop
execute format('alter table %s enable row level security',name);execute format('alter table %s force row level security',name);
for r in select distinct a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=to_regclass(name) and a.grantee<>c.relowner loop execute format('revoke all on table %s from %s',name,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);end loop;
for col_acl in select at.attname,a.grantee from pg_attribute at join pg_class cl on cl.oid=at.attrelid cross join lateral aclexplode(at.attacl) a where cl.oid=to_regclass(name) and a.grantee<>cl.relowner loop execute format('revoke all (%I) on table %s from %s',col_acl.attname,name,case when col_acl.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(col_acl.grantee)) end);end loop;end loop;
foreach signature in array array['fluid_private.reject_logo_admission(uuid,uuid,jsonb,text)','fluid_private.logo_trace_settings_valid(jsonb)','fluid_private.logo_worker_owner()','fluid_private.logo_lock_job(uuid,uuid)','fluid_private.logo_job_input_revisions(public.jobs)','fluid_private.logo_plan(jsonb,bigint)','public.quote_logo_operation(uuid,jsonb)','public.admit_logo_operation(uuid,jsonb)','public.claim_logo_job(text,integer)','public.heartbeat_logo_job(uuid,uuid,integer)','public.register_logo_job_plan(uuid,uuid,jsonb)','public.begin_logo_job_step(uuid,uuid,text,text,bigint)','public.record_logo_provider_response(uuid,uuid,jsonb)','public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)','public.finish_logo_job(uuid,uuid,text)','fluid_private.logo_job_observation(public.jobs)','fluid_private.logo_job_record(uuid,uuid,text,uuid)','fluid_private.logo_job_records(uuid,uuid,text,jsonb)','fluid_private.resolve_logo_raster_source(uuid,uuid,jsonb)','fluid_private.logo_job_can_read_asset(public.jobs,jsonb)','public.read_leased_logo_record(uuid,uuid,text,jsonb)','public.read_logo_request(uuid,uuid)','public.reconcile_logo_request(uuid,uuid)','public.expire_logo_job_leases()'] loop
for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(signature) and a.grantee<>p.proowner loop execute format('revoke all on function %s from %s',signature,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);end loop;end loop;end $$;
grant execute on function public.quote_logo_operation(uuid,jsonb),public.admit_logo_operation(uuid,jsonb),public.read_logo_request(uuid,uuid),public.reconcile_logo_request(uuid,uuid) to authenticated;
create trigger logo_cost_quotes_immutable before update or delete on public.logo_cost_quotes for each row execute function fluid_private.prevent_history_change();
create trigger logo_operation_rejections_immutable before update or delete on public.logo_operation_rejections for each row execute function fluid_private.prevent_history_change();
create trigger logo_operation_requests_immutable before update or delete on public.logo_operation_requests for each row execute function fluid_private.prevent_history_change();
create trigger logo_concept_batches_immutable before update or delete on public.logo_concept_batches for each row execute function fluid_private.prevent_history_change();
create trigger logo_concept_slots_immutable before update or delete on public.logo_concept_slots for each row execute function fluid_private.prevent_history_change();
create trigger logo_concept_attempts_immutable before update or delete on public.logo_concept_attempts for each row execute function fluid_private.prevent_history_change();
create trigger logo_raster_refinements_immutable before update or delete on public.logo_raster_refinements for each row execute function fluid_private.prevent_history_change();
create trigger logo_provider_responses_immutable before update or delete on public.logo_provider_responses for each row execute function fluid_private.prevent_history_change();
create trigger logo_raster_results_immutable before update or delete on public.logo_raster_results for each row execute function fluid_private.prevent_history_change();
commit;
