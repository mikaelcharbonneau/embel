-- LOCAL CANDIDATE ONLY. No login, binding, credentials, grants or policy activation.
-- Subscription text and API image execution are deliberately distinct. The
-- verified_zero string is an operator attestation, not proof of account access.
-- Future activation must qualify the exact transport/account/registration first.
begin;

alter table fluid_private.subscription_registrations
 add column connected boolean not null default false,
 add column plan_usage_enabled boolean not null default false;
-- Existing Strategy/Naming configure functions never set these new flags.
-- Only a separately reviewed qualification/activation may set both true.
alter table fluid_private.logo_runtime_policies add column subscription_policy jsonb;

create function fluid_private.valid_logo_directions_subscription_policy(p jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare lim jsonb;k text;n numeric;lo integer;hi integer;
begin
 if fluid_private.standalone_keys(p,array['version','billingMode','handlerVersion','adapterVersion','registrationId','model','apiCharge','limits']) is distinct from true
  or p->'version' is distinct from '1'::jsonb or p->>'billingMode' is distinct from 'chatgpt_subscription'
  or p->>'handlerVersion' is distinct from 'logo-directions-v1' or p->>'adapterVersion' is distinct from 'logo-directions-chatgpt-v1'
  or p->>'apiCharge' is distinct from 'verified_zero'
  or jsonb_typeof(p->'registrationId') is distinct from 'string' or length(p->>'registrationId') not between 1 and 200 or p->>'registrationId' !~ '^[A-Za-z0-9_-]+$'
  or jsonb_typeof(p->'model') is distinct from 'string' or length(p->>'model') not between 1 and 150 or p->>'model' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' then return false;end if;
 lim:=p->'limits';
 if fluid_private.standalone_keys(lim,array['maxInputBytes','maxOutputBytes','maxStreamBytes','deadlineMs','maxObservedWebSearchCalls','maxRequestsPerHour','maxQueuedJobs']) is distinct from true then return false;end if;
 foreach k in array array['maxInputBytes','maxOutputBytes','maxStreamBytes','deadlineMs','maxObservedWebSearchCalls','maxRequestsPerHour','maxQueuedJobs'] loop
  if jsonb_typeof(lim->k) is distinct from 'number' then return false;end if;n:=(lim->>k)::numeric;
  lo:=case k when 'maxInputBytes' then 1024 when 'maxOutputBytes' then 1024 when 'maxStreamBytes' then 1024 when 'deadlineMs' then 1000 when 'maxObservedWebSearchCalls' then 0 else 1 end;
  hi:=case k when 'maxInputBytes' then 131072 when 'maxOutputBytes' then 262144 when 'maxStreamBytes' then 2097152 when 'deadlineMs' then 240000 when 'maxObservedWebSearchCalls' then 0 when 'maxRequestsPerHour' then 100 else 10 end;
  if n<>trunc(n) or n not between lo and hi then return false;end if;
 end loop;return true;
end $$;

alter table fluid_private.logo_runtime_policies add constraint logo_directions_subscription_policy check (
 subscription_policy is null or (
  fluid_private.valid_logo_directions_subscription_policy(subscription_policy)
  and operation='identity.logo_directions' and provider='openai' and model=subscription_policy->>'model'
  and handler_version='logo-directions-v1' and engine is null and max_cost_microusd=0
  and policy_identity=encode(sha256(convert_to(subscription_policy::text,'UTF8')),'hex')
 ) is true);
-- The existing subscription_policy_identity/subscription_job_input constraints
-- continue to enforce canonical full-policy hashes, one attempt and zero money.
alter table public.jobs add constraint logo_subscription_job_scope check (
 operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') or (
  (billing_mode='openai_api' and not(input?'billingMode') and not(input?'policy')) or
  (operation='identity.logo_directions' and billing_mode='chatgpt_subscription'
   and fluid_private.valid_logo_directions_subscription_policy(input->'policy')
   and input->>'policyIdentity'=policy_identity and input->>'handlerVersion'='logo-directions-v1')
 ) is true);

create function fluid_private.logo_subscription_registration_ready(p_owner uuid,p_policy jsonb) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.subscription_registrations r where r.owner_id=p_owner and r.registration_id=p_policy->>'registrationId' and r.connected and r.plan_usage_enabled)
$$;
-- Counts are owner-wide, matching Strategy/Naming admission. Unresolved logo
-- outcomes continue occupying the queue. A dispatch excludes its own accepted
-- job; the admission that created it already consumed one hourly/queue slot.
create function fluid_private.logo_subscription_quota_available(p_owner uuid,p_policy jsonb,p_exclude uuid default null) returns boolean language sql volatile set search_path='' as $$
 select fluid_private.valid_logo_directions_subscription_policy(p_policy)
  and count(*) filter(where created_at>clock_timestamp()-interval '1 hour')<(p_policy#>>'{limits,maxRequestsPerHour}')::integer
  and count(*) filter(where state in ('queued','running','cancel_requested','needs_reconciliation'))<(p_policy#>>'{limits,maxQueuedJobs}')::integer
 from public.jobs where owner_id=p_owner and billing_mode='chatgpt_subscription' and (p_exclude is null or id<>p_exclude)
$$;

-- Any actual qualification change withdraws heartbeat advertisements. Reconnect
-- does not revive a stale manifest; policy and login must report again.
create function fluid_private.invalidate_logo_subscription_readiness() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or to_jsonb(old) is distinct from to_jsonb(new) then
  delete from fluid_private.logo_worker_readiness r using fluid_private.logo_runtime_policies p
   where p.owner_id=old.owner_id and p.subscription_policy->>'registrationId'=old.registration_id and r.owner_id=p.owner_id and r.operation=p.operation;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger subscription_registration_invalidates_logo_readiness before update or delete on fluid_private.subscription_registrations for each row execute function fluid_private.invalidate_logo_subscription_readiness();

-- A registration is metadata, never authority to read or execute logo jobs.
create or replace function public.subscription_worker_can_read_step(p_job_id uuid,p_owner_id uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=public.subscription_worker_owner();
begin
 if v_owner is null or p_owner_id is distinct from v_owner then return false;end if;
 return exists(select 1 from public.jobs j where j.id=p_job_id and j.owner_id=v_owner and j.billing_mode='chatgpt_subscription'
  and j.operation not in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export'));
end $$;


-- Owner disconnect applies to every pending subscription job on that registration.
create or replace function public.disable_subscription_runtime(p_owner_id uuid,p_registration_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=public.subscription_worker_owner();
begin
  if v_owner is null or p_owner_id is distinct from v_owner then raise exception 'worker_owner_mismatch' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text,723902));
  update fluid_private.subscription_registrations set connected=false,plan_usage_enabled=false where owner_id=p_owner_id and registration_id=p_registration_id;
  update fluid_private.subscription_runtime_policy set enabled=false,worker_ready_until=null where owner_id=p_owner_id and registration_id=p_registration_id;
  update public.jobs set state=case when state='queued' then 'cancelled' else 'cancel_requested' end,
    cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),
    finished_at=case when state='queued' then clock_timestamp() else finished_at end
    where owner_id=p_owner_id and billing_mode='chatgpt_subscription' and input->'policy'->>'registrationId'=p_registration_id and state in ('queued','running');
  return exists(select 1 from fluid_private.subscription_registrations where owner_id=p_owner_id and registration_id=p_registration_id);
end $$;

create or replace function fluid_private.logo_policy_descriptor(p fluid_private.logo_runtime_policies) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('operation',p.operation,'policyIdentity',p.policy_identity,'handlerVersion',p.handler_version,'provider',p.provider,'model',p.model,'engine',p.engine,'maxCostMicrousd',p.max_cost_microusd)
 || case when p.subscription_policy is null then '{}'::jsonb else jsonb_build_object('billingMode','chatgpt_subscription','policy',p.subscription_policy) end
$$;

create or replace function fluid_private.logo_operation_ready(p_owner uuid,p_operation text) returns boolean language sql volatile set search_path='' as $$
 select exists(
  select 1 from fluid_private.logo_worker_readiness r
  join fluid_private.logo_runtime_policies p on p.owner_id=r.owner_id and p.operation=r.operation
  join fluid_private.logo_worker_principals binding on binding.role_oid=r.role_oid and binding.owner_id=r.owner_id
  join pg_catalog.pg_roles role on role.oid=binding.role_oid and role.rolname=binding.role_name
  where r.owner_id=p_owner and r.operation=p_operation and r.ready_until>clock_timestamp() and p.enabled
   and r.descriptor=fluid_private.logo_policy_descriptor(p)
   and (p.subscription_policy is null or fluid_private.logo_subscription_registration_ready(p.owner_id,p.subscription_policy))
   and role.rolcanlogin and not role.rolinherit and not role.rolsuper and not role.rolbypassrls and not role.rolcreatedb and not role.rolcreaterole and not role.rolreplication
   and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=role.oid)
 )
$$;

create or replace function public.report_logo_worker_ready(p_worker text,p_manifest jsonb,p_seconds integer) returns boolean language plpgsql security definer set search_path='' as $$
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
  if fluid_private.standalone_keys(item,case when item?'billingMode' or item?'policy' then array['operation','policyIdentity','handlerVersion','provider','model','engine','maxCostMicrousd','billingMode','policy'] else array['operation','policyIdentity','handlerVersion','provider','model','engine','maxCostMicrousd'] end) is distinct from true then valid:=false;exit;end if;
  select * into policy from fluid_private.logo_runtime_policies where owner_id=owner and operation=item->>'operation' and enabled;
  if not found or item is distinct from fluid_private.logo_policy_descriptor(policy) or (policy.subscription_policy is not null and not fluid_private.logo_subscription_registration_ready(owner,policy.subscription_policy)) then valid:=false;exit;end if;
 end loop;
 if not valid then return false;end if;
 insert into fluid_private.logo_worker_readiness(role_oid,worker_id,owner_id,operation,descriptor,ready_until)
 select login_oid,p_worker,owner,value->>'operation',value,clock_timestamp()+make_interval(secs=>p_seconds) from jsonb_array_elements(p_manifest);
 return true;
end $$;

create or replace function fluid_private.logo_job_policy_matches(j public.jobs,p fluid_private.logo_runtime_policies) returns boolean language plpgsql stable set search_path='' as $$
declare q public.logo_cost_quotes;count numeric:=1;
begin
 if p.owner_id is distinct from j.owner_id or p.operation is distinct from j.operation or not p.enabled or p.policy_identity is distinct from j.input->>'policyIdentity' or p.handler_version is distinct from j.input->>'handlerVersion' then return false;end if;
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
end $$;

create or replace function fluid_private.logo_job_ready(j public.jobs,p_worker text) returns boolean language sql volatile set search_path='' as $$
 select exists(select 1 from fluid_private.logo_worker_readiness r
  join fluid_private.logo_runtime_policies p on p.owner_id=r.owner_id and p.operation=r.operation
  join pg_catalog.pg_roles login on login.oid=r.role_oid and login.rolname=session_user
  where r.owner_id=j.owner_id and r.owner_id=fluid_private.logo_worker_owner() and r.worker_id=p_worker and r.operation=j.operation
   and r.ready_until>clock_timestamp() and r.descriptor=fluid_private.logo_policy_descriptor(p) and fluid_private.logo_job_policy_matches(j,p)
   and (p.subscription_policy is null or (fluid_private.logo_subscription_registration_ready(j.owner_id,p.subscription_policy) and fluid_private.logo_subscription_quota_available(j.owner_id,p.subscription_policy,j.id))))
$$;

create or replace function fluid_private.lock_logo_job_readiness(j public.jobs,p_worker text) returns boolean language plpgsql set search_path='' as $$
begin
 perform 1 from fluid_private.logo_runtime_policies where owner_id=j.owner_id and operation=j.operation for share;
 perform 1 from fluid_private.subscription_registrations where owner_id=j.owner_id and registration_id=j.input#>>'{policy,registrationId}' for share;
 perform 1 from fluid_private.logo_worker_readiness where role_oid=(select oid from pg_catalog.pg_roles where rolname=session_user) and worker_id=p_worker and owner_id=j.owner_id and operation=j.operation for share;
 return fluid_private.logo_job_ready(j,p_worker);
end $$;

-- Null policy is omitted from legacy serialization, preserving its exact old input hash.
create or replace function public.quote_logo_operation(p_project_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
 inputhash:=encode(sha256(convert_to(jsonb_build_object('request',p_input,'sources',sources,'policy',case when policy.subscription_policy is null then to_jsonb(policy)-'subscription_policy' else to_jsonb(policy) end,'plan',plan,'targets',targets)::text,'UTF8')),'hex');
 result:=jsonb_build_object('id',qid,'ownerId',owner,'projectId',p_project_id,'request',p_input,'inputHash',inputhash,'expected',p_input->'expected','policyIdentity',policy.policy_identity,'handlerVersion',policy.handler_version,'provider',policy.provider,'model',policy.model,'engine',case when policy.engine is null then null else policy.engine||jsonb_build_object('settingsHash',encode(sha256(convert_to((p_input->'settings')::text,'UTF8')),'hex')) end,'estimatedCostMicrousd',total,'maxCostMicrousd',total,'externalProviderCostMicrousd',case when policy.provider is null then 0 else total end,'expiresAt',to_char(expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'conceptPlan',plan,'targetSlotIds',targets);
 if policy.subscription_policy is not null then
  result:=result||jsonb_build_object('billingMode','chatgpt_subscription','policy',policy.subscription_policy);
  if octet_length((sources->'direction')::text)+octet_length(result::text)>(policy.subscription_policy#>>'{limits,maxInputBytes}')::integer then raise exception 'logo_subscription_input_too_large' using errcode='22023';end if;
 end if;
 insert into public.logo_cost_quotes values(qid,owner,p_project_id,op,result,inputs,sources,expires);return result;
end $$;

create or replace function public.admit_logo_operation(p_project_id uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
  if policy.subscription_policy is not null then
   input:=input||jsonb_build_object('billingMode','chatgpt_subscription','policy',policy.subscription_policy);
   if octet_length(input::text)+octet_length((q.source_inputs->'direction')::text)>(policy.subscription_policy#>>'{limits,maxInputBytes}')::integer then raise exception 'logo_subscription_input_too_large' using errcode='22023';end if;
  end if;
  insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,plan_manifest,plan_fingerprint,plan_registered_at,billing_mode,policy_identity) values(jobid,owner,p_project_id,q.operation,(p_input#>>'{expected,projectRevision}')::integer,q.record->>'inputHash',input,'logo:'||jobid,cost,case when policy.subscription_policy is null then 3 else 1 end,manifest,encode(sha256(convert_to(manifest::text,'UTF8')),'hex'),clock_timestamp(),case when policy.subscription_policy is null then 'openai_api' else 'chatgpt_subscription' end,case when policy.subscription_policy is null then null else policy.policy_identity end);
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
  if failure_message in ('logo_quote_stale','logo_policy_changed','logo_cap_exceeded','logo_budget_exceeded','logo_retry_requires_confirmed_failure','logo_quote_already_used') then
   return fluid_private.reject_logo_admission(owner,p_project_id,p_input,'conflict');
  end if;raise;
 when sqlstate 'P0002' then
  get stacked diagnostics failure_message=MESSAGE_TEXT;
  if failure_message='logo_quote_not_found' then return fluid_private.reject_logo_admission(owner,p_project_id,p_input,'not_found');end if;raise;
 end;
end $$;

create or replace function public.claim_logo_job(p_worker text,p_seconds integer) returns setof public.jobs language plpgsql security definer set search_path='' as $$
declare owner uuid:=fluid_private.logo_worker_owner();j public.jobs;account public.usage_accounts;pending_paid boolean;
begin
 if owner is null then raise exception 'logo_worker_unauthorized' using errcode='42501';end if;
 if p_seconds not between 10 and 300 or p_seconds is null or p_worker is null or length(p_worker) not between 1 and 200 then raise exception 'invalid_lease' using errcode='22023';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner::text,723902));
 select candidate.* into j from public.jobs candidate left join public.usage_accounts a on a.owner_id=candidate.owner_id
 where candidate.owner_id=owner and candidate.operation in ('identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export') and candidate.state='queued' and candidate.attempts<candidate.max_attempts
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
end $$;

create or replace function public.begin_logo_job_step(p_job uuid,p_lease uuid,p_step text,p_key text,p_cost bigint) returns text language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.job_steps;account public.usage_accounts;
begin
 if fluid_private.logo_worker_owner() is null then raise exception 'logo_worker_unauthorized' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(fluid_private.logo_worker_owner()::text,723902));
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
 if j.billing_mode='chatgpt_subscription' and (p_cost is distinct from 0 or octet_length(j.input::text)+(select octet_length(source::text) from public.logo_direction_inputs where job_id=j.id)>(j.input#>>'{policy,limits,maxInputBytes}')::integer) then raise exception 'invalid_subscription_cost_or_input' using errcode='22023';end if;
 if p_cost<0 or p_cost>j.reserved_cost_microusd-j.actual_cost_microusd or exists(select 1 from public.job_steps where job_id=j.id and state in ('in_flight','ambiguous','failed')) then raise exception 'unsafe_step' using errcode='55000';end if;
 -- Already claimed siblings must recheck the same aggregate reservation
 -- fence immediately before persisting a new paid dispatch boundary.
 if p_cost>0 then
  select * into account from public.usage_accounts where owner_id=j.owner_id for share;
  if not found or account.reserved_microusd>account.limit_microusd-greatest(account.spent_microusd,account.provider_actual_microusd) then raise exception 'budget_exceeded' using errcode='P0001';end if;
 end if;
 insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values(j.id,j.owner_id,j.project_id,p_step,p_key,'in_flight',p_cost);return 'started';
end $$;

-- The identifier in the completed Responses envelope is independent of the
-- optional HTTP request-ID header. Legacy API/image evidence retains its header
-- requirement. Null usage means unavailable, never an allowance estimate.
create function fluid_private.logo_subscription_observation_valid(j public.jobs,o jsonb) returns boolean language plpgsql stable set search_path='' as $$
declare u jsonb;b jsonb;k text;n numeric;
begin
 if j.operation<>'identity.logo_directions' or j.billing_mode<>'chatgpt_subscription'
  or not fluid_private.valid_logo_directions_subscription_policy(j.input->'policy')
  or j.input->>'billingMode' is distinct from 'chatgpt_subscription'
  or j.policy_identity is distinct from encode(sha256(convert_to((j.input->'policy')::text,'UTF8')),'hex')
  or fluid_private.standalone_keys(o,array['version','billingMode','registrationId','responseId','usage','provider','model','providerRequestId','responseHash','observedAt','billing','artifactHash']) is distinct from true
  or o->'version' is distinct from '2'::jsonb or o->>'billingMode' is distinct from 'chatgpt_subscription'
  or o->>'provider' is distinct from 'openai' or o->'model' is distinct from j.input#>'{policy,model}'
  or o->'registrationId' is distinct from j.input#>'{policy,registrationId}'
  or o->'artifactHash' is distinct from 'null'::jsonb
  or octet_length(o::text)>32768 then return false;end if;
 if o->'responseId'<>'null' and (jsonb_typeof(o->'responseId') is distinct from 'string' or o->>'responseId' !~ '^resp_[a-zA-Z0-9_-]+$' or length(o->>'responseId')>200) then return false;end if;
 if o->'providerRequestId'<>'null' and (jsonb_typeof(o->'providerRequestId') is distinct from 'string' or length(o->>'providerRequestId') not between 1 and 200) then return false;end if;
 if o->'responseHash'<>'null' and (jsonb_typeof(o->'responseHash') is distinct from 'string' or o->>'responseHash' !~ '^[0-9a-f]{64}$') then return false;end if;
 if not fluid_private.standalone_timestamp(o->'observedAt') or (o->>'observedAt')::timestamptz>clock_timestamp()+interval '1 minute' then return false;end if;
 b:=o->'billing';
 if fluid_private.standalone_keys(b,array['status','confirmedMicrousd']) is distinct from true
  or ((b->>'status'='unknown' and b->'confirmedMicrousd'='null') or (b->>'status'='recorded' and b->'confirmedMicrousd'='0')) is not true then return false;end if;
 u:=o->'usage';
 if u<>'null' then
  if fluid_private.standalone_keys(u,array['inputTokens','outputTokens','totalTokens']) is distinct from true then return false;end if;
  foreach k in array array['inputTokens','outputTokens','totalTokens'] loop
   if jsonb_typeof(u->k) is distinct from 'number' then return false;end if;n:=(u->>k)::numeric;
   if n not between 0 and 9007199254740991 or n<>trunc(n) then return false;end if;
  end loop;
  if (u->>'inputTokens')::numeric+(u->>'outputTokens')::numeric<>(u->>'totalTokens')::numeric then return false;end if;
 end if;return true;
end $$;
create function fluid_private.logo_response_identity_complete(j public.jobs,o jsonb) returns boolean language sql stable set search_path='' as $$
 select case when j.billing_mode='chatgpt_subscription' then
  fluid_private.logo_subscription_observation_valid(j,o) and o->>'responseId' is not null and o->>'responseHash' is not null
 else not(o?'version') and not(o?'billingMode') and o->>'providerRequestId' is not null and o->>'responseHash' is not null end
$$;
create unique index logo_subscription_response_replay on public.logo_provider_responses(owner_id,(observation->>'registrationId'),(observation->>'responseId'))
 where observation->>'billingMode'='chatgpt_subscription' and observation->>'responseId' is not null;


create or replace function public.record_logo_provider_response(p_job uuid,p_lease uuid,p_observation jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;q public.logo_cost_quotes;r public.logo_provider_responses;b jsonb;
begin
 j:=fluid_private.logo_lock_job(p_job,p_lease);select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid and owner_id=j.owner_id and project_id=j.project_id;
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
end $$;

create or replace function public.stage_logo_directions(p_job uuid,p_lease uuid,p_result jsonb,p_provider_receipt uuid,p_checks jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.logo_direction_inputs;p public.logo_direction_publications;r public.logo_provider_responses;
begin
 perform 1 from public.projects where id=(select project_id from public.jobs where id=p_job and owner_id=fluid_private.logo_worker_owner()) for update;
 j:=fluid_private.logo_lock_job(p_job,p_lease);
 select * into s from public.logo_direction_inputs where job_id=j.id and owner_id=j.owner_id and project_id=j.project_id;
 select * into r from public.logo_provider_responses where id=p_provider_receipt and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=j.lease_token;
 if j.operation<>'identity.logo_directions' or s.job_id is null or r.id is null or r.observation->>'responseHash' is null or (j.billing_mode='chatgpt_subscription' and not fluid_private.logo_response_identity_complete(j,r.observation)) then raise exception 'direction_source_evidence_required' using errcode='55000';end if;
 if not fluid_private.logo_direction_group_valid(p_result,s.source,j.owner_id,j.project_id) or not fluid_private.logo_direction_checks_valid(p_checks,p_result,s.source) then raise exception 'invalid_direction_result' using errcode='22023';end if;
 select * into p from public.logo_direction_publications where job_id=j.id;
 if found then
  if p.result is distinct from p_result or p.font_checks is distinct from p_checks or p.provider_receipt_id<>p_provider_receipt or p.lease_token<>p_lease then raise exception 'immutable_direction_request' using errcode='PT409';end if;
 else
  insert into public.logo_direction_publications(job_id,owner_id,project_id,lease_token,provider_receipt_id,input_hash,result,font_checks) values(j.id,j.owner_id,j.project_id,j.lease_token,r.id,j.input_hash,p_result,p_checks) returning * into p;
 end if;
 return jsonb_build_object('id',p.id,'ownerId',p.owner_id,'projectId',p.project_id,'jobId',p.job_id,'inputHash',p.input_hash,'directionIds',(select jsonb_agg(value->'id') from jsonb_array_elements(p.result->'directions')),'publicationState','staged');
end $$;

create or replace function fluid_private.logo_commit_direction_publication(p_job public.jobs,p_publication uuid,p_provider_receipt uuid) returns jsonb language plpgsql set search_path='' as $$
declare j public.jobs;p public.logo_direction_publications;s public.logo_direction_inputs;r public.logo_provider_responses;k text;item jsonb;revision jsonb;q public.logo_cost_quotes;
begin
 j:=fluid_private.logo_lock_job(p_job.id,p_job.lease_token);
 select * into p from public.logo_direction_publications where id=p_publication and owner_id=j.owner_id and project_id=j.project_id and job_id=j.id and lease_token=j.lease_token for update;
 select * into r from public.logo_provider_responses where id=p_provider_receipt and job_id=j.id and owner_id=j.owner_id and project_id=j.project_id and lease_token=j.lease_token;
 if p.id is null or r.id is null or p.provider_receipt_id<>r.id or p.input_hash<>j.input_hash or r.observation#>>'{billing,status}'<>'recorded' or not fluid_private.logo_response_identity_complete(j,r.observation) then raise exception 'direction_publication_evidence_required' using errcode='55000';end if;
 if p.committed_at is not null then return p.stage_revision;end if;
 select * into s from public.logo_direction_inputs where job_id=j.id;
 if not fluid_private.logo_direction_group_valid(p.result,s.source,j.owner_id,j.project_id) or not fluid_private.logo_direction_checks_valid(p.font_checks,p.result,s.source) then raise exception 'invalid_direction_publication' using errcode='55000';end if;
 foreach k in array array['directions','palettes','typography','graphics'] loop
  for item in select value from jsonb_array_elements(p.result->k) loop
   insert into public.logo_direction_records(id,owner_id,project_id,kind,approved_logo_id,record,publication_id) values((item->>'id')::uuid,j.owner_id,j.project_id,case k when 'directions' then 'direction' when 'palettes' then 'palette' else k end,(item->>'approvedLogoId')::uuid,item,p.id);
  end loop;
 end loop;
 for item in select value from jsonb_array_elements(p.font_checks) loop insert into public.logo_direction_font_checks(typography_id,style_key,owner_id,project_id,record) values((item->>'typographyVersionId')::uuid,item->>'styleKey',j.owner_id,j.project_id,item);end loop;
 select * into q from public.logo_cost_quotes where id=(j.input->>'quoteId')::uuid;
 if j.state='running' and fluid_private.logo_workspace_json(j.owner_id,j.project_id)->'heads'=q.record->'expected' and fluid_private.logo_workspace_json(j.owner_id,j.project_id)#>>'{approvedLogo,id}'=j.input->>'approvedLogoId' then
  revision:=fluid_private.logo_append_stage(j.owner_id,j.project_id,'directions',jsonb_build_object('directionIds',(select jsonb_agg(value->'id') from jsonb_array_elements(p.result->'directions')),'selectionId',null,'approvalId',null),s.source->'inputRevisions');
 end if;
 update public.logo_direction_publications set committed_at=clock_timestamp(),stage_revision=revision where id=p.id;
 return revision;
end $$;

create or replace function public.complete_logo_job_step(p_job_id uuid,p_lease_token uuid,p_step_key text,p_state text,p_actual_cost_microusd bigint,p_output jsonb,p_provider_request_id text) returns public.job_steps language plpgsql security definer set search_path='' as $$
<<completion>>
declare j public.jobs;s public.job_steps;r public.logo_provider_responses;reservation public.usage_reservations;output jsonb;receipt jsonb;reason text;state text:=p_state;paid boolean;q public.logo_cost_quotes;current_heads jsonb;payload jsonb;revision jsonb;duplicate boolean:=false;
begin
 -- Project-first order matches manual publication/admission and prevents lock inversion.
 perform 1 from public.projects where id=(select project_id from public.jobs where id=p_job_id and owner_id=fluid_private.logo_worker_owner()) for update;
 j:=fluid_private.logo_lock_job(p_job_id,p_lease_token);
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
end $$;

-- No grant changes on existing signatures. Scrub only newly created helper
-- OIDs so hostile defaults cannot give a caller registration or policy access.
do $$ declare signature text;r record;
begin
 foreach signature in array array[
  'fluid_private.valid_logo_directions_subscription_policy(jsonb)',
  'fluid_private.logo_subscription_registration_ready(uuid,jsonb)',
  'fluid_private.logo_subscription_quota_available(uuid,jsonb,uuid)',
  'fluid_private.invalidate_logo_subscription_readiness()',
  'fluid_private.logo_subscription_observation_valid(public.jobs,jsonb)',
  'fluid_private.logo_response_identity_complete(public.jobs,jsonb)'
 ] loop
  for r in select distinct a.grantee from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure(signature) and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',signature,case when r.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r.grantee)) end);
  end loop;
 end loop;
end $$;
commit;
