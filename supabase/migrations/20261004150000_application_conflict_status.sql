-- Application conflicts are final outcomes, not serialization failures. Hasql's
-- transaction runner retries SQLSTATE 40001, so deterministic revision/policy
-- conflicts would otherwise loop until the HTTP request deadline.
-- Deploy both server error mappers with PT409 support before this migration.
-- Replace only the six authenticated app RPCs; preserve their signatures,
-- successful return values, security settings and existing EXECUTE privileges.
-- Worker lease/plan/partial conflicts and the worker-only enqueue RPC are unchanged.
-- Sources: https://raw.githubusercontent.com/PostgREST/postgrest/v14.5/src/PostgREST/MainTx.hs
-- https://raw.githubusercontent.com/nikita-volkov/hasql-transaction/1.1.0.1/library/Hasql/Transaction/Private/Sessions.hs
-- https://docs.postgrest.org/en/stable/references/errors.html#raise-errors-with-http-status-codes
begin;

create or replace function public.append_project_revision(
  p_project_id uuid, p_expected_revision integer, p_context jsonb, p_input_hash text,
  p_title text default null
)
returns public.project_revisions language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_project public.projects;
  v_revision public.project_revisions;
begin
  select p.* into v_project from public.projects p
    where p.id = p_project_id and p.owner_id = v_owner for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'invalid_revision' using errcode = '22023';
  end if;
  if v_project.current_revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = 'PT409';
  end if;
  if p_title is not null and length(btrim(p_title)) not between 1 and 160 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;
  insert into public.project_revisions(project_id, owner_id, revision, context, input_hash)
    values(v_project.id, v_owner, v_project.current_revision + 1, p_context, p_input_hash)
    returning * into v_revision;
  update public.projects p set current_revision = v_revision.revision,
    title = coalesce(btrim(p_title), v_project.title)
    where p.id = v_project.id and p.owner_id = v_owner;
  return v_revision;
end $$;

create or replace function public.expand_project_scope(p_project_id uuid, p_expected_revision integer)
returns table(id uuid, owner_id uuid, scope text, title text, current_revision integer, created_at timestamptz, context jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_project public.projects;
  v_revision public.project_revisions;
begin
  select p.* into v_project from public.projects p
    where p.id = p_project_id and p.owner_id = v_owner for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'invalid_revision' using errcode = '22023';
  end if;
  -- Check before the idempotent branch: stale callers must refresh their context.
  if v_project.current_revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = 'PT409';
  end if;
  select r.* into strict v_revision from public.project_revisions r
    where r.project_id = v_project.id and r.owner_id = v_owner and r.revision = v_project.current_revision;
  if v_project.scope <> 'complete_brand' then
    -- The persisted snapshot and input hash are copied exactly, including intake
    -- details, audience selections and any future context fields. History stays intact.
    insert into public.project_revisions(project_id, owner_id, revision, context, input_hash)
      values(v_project.id, v_owner, v_project.current_revision + 1, v_revision.context, v_revision.input_hash)
      returning * into v_revision;
    update public.projects p set scope = 'complete_brand', current_revision = v_revision.revision
      where p.id = v_project.id and p.owner_id = v_owner returning p.* into v_project;
  end if;
  return query select v_project.id, v_project.owner_id, v_project.scope, v_project.title,
    v_project.current_revision, v_project.created_at, v_revision.context;
end $$;

create or replace function public.enqueue_strategy_job(p_project_id uuid, p_expected_revision integer, p_operation text,
  p_idempotency_key text, p_accepted_max_cost_microusd bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_project public.projects; v_revision public.project_revisions;
  v_policy fluid_private.strategy_runtime_policy; v_job public.jobs; v_account public.usage_accounts; v_maximum bigint;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_expected_revision is null or p_expected_revision < 1
    or p_operation is null or p_operation not in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')
    or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or p_accepted_max_cost_microusd is null or p_accepted_max_cost_microusd not between 0 and 9007199254740991 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if not exists(select 1 from public.projects where id = p_project_id and owner_id = v_owner) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- Match enqueue_job's lock order; serialize owner idempotency and budget reservation.
  select * into v_account from public.usage_accounts where owner_id = v_owner for update;
  if not found then raise exception 'budget_unavailable' using errcode = 'P0001'; end if;
  select * into v_job from public.jobs where owner_id = v_owner and idempotency_key = p_idempotency_key;
  if found then
    if (v_job.project_id, v_job.operation, v_job.input_revision, (v_job.input->>'acceptedMaxCostMicrousd')::bigint)
      is distinct from (p_project_id, p_operation, p_expected_revision, p_accepted_max_cost_microusd) then
      raise exception 'idempotency_conflict' using errcode = '23505';
    end if;
    -- Replaying the same request is stable even after edits, policy changes or outage.
    return fluid_private.strategy_job_summary(v_job);
  end if;
  if exists(select 1 from fluid_private.subscription_runtime_policy where owner_id=v_owner) then
    raise exception 'billing_mode_conflict' using errcode='PT409';
  end if;
  select * into v_project from public.projects where id = p_project_id and owner_id = v_owner for share;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_project.current_revision <> p_expected_revision then raise exception 'revision_conflict' using errcode = 'PT409'; end if;
  select * into v_policy from fluid_private.strategy_runtime_policy where operation = p_operation and enabled for share;
  if not found or v_policy.worker_ready_until is null or v_policy.worker_ready_until <= clock_timestamp() then
    raise exception 'runtime_unavailable' using errcode = 'P0001';
  end if;
  v_maximum := (v_policy.policy->>'maximumCostMicrousd')::bigint;
  if p_accepted_max_cost_microusd < v_maximum then raise exception 'accepted_cap_exceeded' using errcode = '22023'; end if;
  select * into strict v_revision from public.project_revisions
    where project_id = p_project_id and owner_id = v_owner and revision = p_expected_revision;
  select * into v_job from public.enqueue_job(v_owner, p_project_id, p_operation, p_expected_revision, v_revision.input_hash,
    jsonb_build_object('version',1,'context',v_revision.context,'policy',v_policy.policy,'acceptedMaxCostMicrousd',p_accepted_max_cost_microusd),
    p_idempotency_key, v_maximum, 1);
  return fluid_private.strategy_job_summary(v_job);
end $$;

create or replace function public.enqueue_subscription_strategy_job(p_project_id uuid,p_expected_revision integer,p_operation text,p_idempotency_key text,p_accepted_policy_identity text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_project public.projects; v_revision public.project_revisions; v_policy fluid_private.subscription_runtime_policy; v_job public.jobs; v_input jsonb;
 v_history jsonb := '{"entries":[],"truncated":false}'::jsonb; v_candidate jsonb; v_entry jsonb; v_source record;
 v_frozen_at timestamptz;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_expected_revision is null or p_expected_revision<1 or p_operation is null or p_operation not in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')
   or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
   or p_accepted_policy_identity is null or p_accepted_policy_identity !~ '^[0-9a-f]{64}$' then raise exception 'invalid_input' using errcode='22023'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 -- Serialize all operations/registrations for this owner, without a USD account.
 perform pg_advisory_xact_lock(hashtextextended(v_owner::text,723902));
 select * into v_job from public.jobs where owner_id=v_owner and idempotency_key=p_idempotency_key;
 if found then
   if (v_job.project_id,v_job.operation,v_job.input_revision,v_job.billing_mode) is distinct from (p_project_id,p_operation,p_expected_revision,'chatgpt_subscription') then raise exception 'idempotency_conflict' using errcode='23505'; end if;
   if v_job.policy_identity<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='PT409'; end if;
   return fluid_private.strategy_job_summary(v_job);
 end if;
 select * into v_job from public.jobs where owner_id=v_owner and project_id=p_project_id and input_revision=p_expected_revision and operation=p_operation and billing_mode='chatgpt_subscription';
 if found then
   if v_job.policy_identity<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='PT409'; end if;
   return fluid_private.strategy_job_summary(v_job);
 end if;
 select * into v_project from public.projects where id=p_project_id and owner_id=v_owner for share;
 if v_project.current_revision<>p_expected_revision then raise exception 'revision_conflict' using errcode='PT409'; end if;
 select * into v_policy from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation=p_operation and enabled for share;
 if not found or v_policy.worker_ready_until is null or v_policy.worker_ready_until<=clock_timestamp() then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
 if encode(sha256(convert_to(v_policy.policy::text,'UTF8')),'hex')<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='PT409'; end if;
 if (select count(*) from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and created_at>clock_timestamp()-interval '1 hour') >= (v_policy.policy->'limits'->>'maxRequestsPerHour')::integer
   or (select count(*) from public.jobs where owner_id=v_owner and billing_mode='chatgpt_subscription' and state in ('queued','running','cancel_requested')) >= (v_policy.policy->'limits'->>'maxQueuedJobs')::integer then raise exception 'quota_unavailable' using errcode='P0001'; end if;
 select * into strict v_revision from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=p_expected_revision;
 v_input:=jsonb_build_object('version',2,'billingMode','chatgpt_subscription','context',v_revision.context,'policy',v_policy.policy,'assistantHistory',v_history);
 -- Freeze one database snapshot of completed, bound sources. Never read partial
 -- text, provider reasoning, browser-authored assistant events or another tenant.
 -- Provider context/history are JSON strings inside the request. Budget their
 -- escaped serialization as well as raw history, with room for instructions and
 -- output schema. Whole-entry omission never raises the selected input limit.
 v_frozen_at:=clock_timestamp();
 for v_source in
   select j.id as job_id,j.owner_id,j.project_id,j.input_revision,s.step_key,s.completed_at,s.output
   from public.jobs j join public.job_steps s on s.job_id=j.id and s.owner_id=j.owner_id and s.project_id=j.project_id
   where j.owner_id=v_owner and j.project_id=p_project_id and j.input_revision<=p_expected_revision
     and j.state='succeeded' and j.finished_at<=v_frozen_at and s.state='succeeded' and s.completed_at<=v_frozen_at
     and j.operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')
     and s.output->'version'='1'::jsonb and s.output->>'provider'='openai'
     and s.output->>'operation'=j.operation and s.output->>'model'=j.input->'policy'->>'model'
     and coalesce(s.output->>'billingMode','openai_api')=j.billing_mode
     and s.provider_request_id=s.output->>'responseId'
     and jsonb_typeof(s.output->'proposal')='object'
     and s.output-array['version','provider','billingMode','operation','model','responseId','requestId','generatedAt','usage','proposal']='{}'::jsonb
   order by s.completed_at desc,j.id desc,s.step_key desc limit 6
 loop
   if jsonb_array_length(v_history->'entries')>=5 then
     v_history:=jsonb_set(v_history,'{truncated}','true'::jsonb); exit;
   end if;
   v_entry:=jsonb_build_object('jobId',v_source.job_id,'ownerId',v_source.owner_id,'projectId',v_source.project_id,
     'inputRevision',v_source.input_revision,'stepKey',v_source.step_key,'completedAt',v_source.completed_at,'output',v_source.output);
   v_candidate:=jsonb_set(v_history,'{entries}',(v_history->'entries')||jsonb_build_array(v_entry));
   if octet_length(v_candidate::text)<=32768
     and octet_length(to_jsonb(jsonb_set(v_input,'{assistantHistory}',v_candidate)::text)::text)+8192
       <=(v_policy.policy->'limits'->>'maxInputBytes')::integer then v_history:=v_candidate;
   else v_history:=jsonb_set(v_history,'{truncated}','true'::jsonb); end if;
 end loop;
 v_input:=jsonb_set(v_input,'{assistantHistory}',v_history);
 if octet_length(v_input::text)>(v_policy.policy->'limits'->>'maxInputBytes')::integer then raise exception 'input_too_large' using errcode='22023'; end if;
 insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,billing_mode,policy_identity)
   values(v_owner,p_project_id,p_operation,p_expected_revision,encode(sha256(convert_to(v_input::text,'UTF8')),'hex'),v_input,p_idempotency_key,0,1,'chatgpt_subscription',p_accepted_policy_identity) returning * into v_job;
 return fluid_private.strategy_job_summary(v_job);
end $$;

create or replace function public.apply_strategy_job_result(p_project_id uuid, p_job_id uuid, p_expected_revision integer, p_step_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_project public.projects; v_job public.jobs; v_step public.job_steps;
  v_revision public.project_revisions; v_context jsonb; v_proposal jsonb; v_items jsonb;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_expected_revision is null or p_expected_revision < 1 or p_step_key is null or length(p_step_key) not between 1 and 200 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_project from public.projects where id = p_project_id and owner_id = v_owner for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into v_job from public.jobs where id = p_job_id and project_id = p_project_id and owner_id = v_owner
    and operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning');
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_project.current_revision <> p_expected_revision or v_job.input_revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = 'PT409';
  end if;
  select * into v_step from public.job_steps where job_id = p_job_id and project_id = p_project_id and owner_id = v_owner
    and step_key = p_step_key and state = 'succeeded' and output is not null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_step.output->>'version' is distinct from '1' or v_step.output->>'provider' is distinct from 'openai'
    or v_step.output->>'operation' is distinct from v_job.operation or jsonb_typeof(v_step.output->'proposal') is distinct from 'object' then
    raise exception 'invalid_result' using errcode = '22023';
  end if;
  select context into v_context from public.project_revisions where project_id = p_project_id and owner_id = v_owner and revision = p_expected_revision;
  v_proposal := v_step.output->'proposal';
  -- Review is always a separate user action; accepting suggestions never invents approval.
  v_context := jsonb_set(v_context, '{intake}', coalesce(v_context->'intake','{}'::jsonb) || jsonb_build_object('personalityReviewedAt',null,'positioningReviewedAt',null));
  if v_job.operation = 'strategy.reformulate' then
    if jsonb_typeof(v_proposal->'activity') is distinct from 'string' or jsonb_typeof(v_proposal->'offering') is distinct from 'string'
      or jsonb_typeof(v_proposal->'knownAudience') is distinct from 'string' then raise exception 'invalid_result' using errcode = '22023'; end if;
    v_context := v_context || jsonb_build_object('activity',v_proposal->'activity','offering',v_proposal->'offering','knownAudience',v_proposal->'knownAudience',
      'reformulationConfirmed',false,'competitorReviewComplete',false);
    v_context := jsonb_set(v_context,'{intake,audienceReviewedAt}','null'::jsonb);
  elsif v_job.operation = 'strategy.competitors' then
    if jsonb_typeof(v_proposal->'competitors') is distinct from 'array' then raise exception 'invalid_result' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(item || jsonb_build_object('selected',false,'origin','research')),'[]'::jsonb) into v_items
      from jsonb_array_elements(v_proposal->'competitors') proposed(item)
      where not exists(select 1 from jsonb_array_elements(coalesce(v_context->'competitors','[]'::jsonb)) existing(item) where existing.item->>'id' = proposed.item->>'id');
    v_context := v_context || jsonb_build_object('competitors',coalesce(v_context->'competitors','[]'::jsonb) || v_items,'competitorReviewComplete',false);
    if jsonb_array_length(v_context->'competitors') > 50 then raise exception 'result_capacity_exceeded' using errcode = '22023'; end if;
    v_context := jsonb_set(v_context,'{intake,audienceReviewedAt}','null'::jsonb);
  elsif v_job.operation = 'strategy.audience' then
    if jsonb_typeof(v_proposal->'segments') is distinct from 'array' then raise exception 'invalid_result' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(item || jsonb_build_object('selected',false,'origin','proposal','sources','[]'::jsonb)),'[]'::jsonb) into v_items
      from jsonb_array_elements(v_proposal->'segments') proposed(item)
      where not exists(select 1 from jsonb_array_elements(coalesce(v_context->'audienceSegments','[]'::jsonb)) existing(item) where existing.item->>'id' = proposed.item->>'id');
    v_context := v_context || jsonb_build_object('audienceSegments',coalesce(v_context->'audienceSegments','[]'::jsonb) || v_items);
    if jsonb_array_length(v_context->'audienceSegments') > 30 then raise exception 'result_capacity_exceeded' using errcode = '22023'; end if;
    v_context := jsonb_set(v_context,'{intake,audienceReviewedAt}','null'::jsonb);
  elsif v_job.operation = 'strategy.personality' then
    if jsonb_typeof(v_proposal->'personality') is distinct from 'object' then raise exception 'invalid_result' using errcode = '22023'; end if;
    v_context := v_context || jsonb_build_object('personality',v_proposal->'personality');
  elsif v_job.operation = 'strategy.positioning' then
    if jsonb_typeof(v_proposal->'positioning') is distinct from 'string' then raise exception 'invalid_result' using errcode = '22023'; end if;
    -- Preserve the already reviewed personality when applying a positioning proposal.
    v_context := jsonb_set(v_context,'{intake,personalityReviewedAt}',coalesce((select context#>'{intake,personalityReviewedAt}' from public.project_revisions where project_id = p_project_id and revision = p_expected_revision),'null'::jsonb));
    v_context := v_context || jsonb_build_object('positioning',v_proposal->'positioning');
  end if;
  select * into v_revision from public.append_project_revision(p_project_id,p_expected_revision,v_context,encode(sha256(convert_to(v_context::text,'UTF8')),'hex'));
  return jsonb_build_object('id',v_project.id,'owner_id',v_owner,'scope',v_project.scope,'title',v_project.title,
    'current_revision',v_revision.revision,'created_at',v_project.created_at,'context',v_revision.context);
end $$;

create or replace function public.apply_strategy_job_result_v2(p_project_id uuid, p_job_id uuid, p_expected_revision integer, p_step_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_project public.projects; v_job public.jobs; v_step public.job_steps;
  v_revision public.project_revisions; v_application public.strategy_job_applications; v_context jsonb; v_proposal jsonb; v_items jsonb;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_expected_revision is null or p_expected_revision < 1 or p_step_key is null or length(p_step_key) not between 1 and 200 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_project from public.projects where id = p_project_id and owner_id = v_owner for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into v_job from public.jobs where id = p_job_id and project_id = p_project_id and owner_id = v_owner
    and operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning');
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_job.input_revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = 'PT409';
  end if;
  select * into v_step from public.job_steps where job_id = p_job_id and project_id = p_project_id and owner_id = v_owner
    and step_key = p_step_key and state = 'succeeded' and output is not null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_step.output->>'version' is distinct from '1' or v_step.output->>'provider' is distinct from 'openai'
    or v_step.output->>'operation' is distinct from v_job.operation or jsonb_typeof(v_step.output->'proposal') is distinct from 'object' then
    raise exception 'invalid_result' using errcode = '22023';
  end if;
  select * into v_application from public.strategy_job_applications
    where job_id = p_job_id and step_key = p_step_key and owner_id = v_owner and project_id = p_project_id;
  if found then
    -- Lost-response recovery is tied to this exact input/result and only the
    -- revision it created. A later edit must still produce a conflict.
    if v_application.input_revision <> p_expected_revision or v_project.current_revision <> v_application.applied_revision then
      raise exception 'revision_conflict' using errcode = 'PT409';
    end if;
    select * into v_revision from public.project_revisions
      where project_id = p_project_id and owner_id = v_owner and revision = v_application.applied_revision;
    return jsonb_build_object(
      'project',jsonb_build_object('id',v_project.id,'owner_id',v_owner,'scope',v_project.scope,'title',v_project.title,
        'current_revision',v_revision.revision,'created_at',v_project.created_at,'context',v_revision.context),
      'application',jsonb_build_object('jobId',v_application.job_id,'stepKey',v_application.step_key,
        'inputRevision',v_application.input_revision,'appliedRevision',v_application.applied_revision,'appliedAt',v_application.applied_at));
  end if;
  if v_project.current_revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = 'PT409';
  end if;
  select context into v_context from public.project_revisions where project_id = p_project_id and owner_id = v_owner and revision = p_expected_revision;
  v_proposal := v_step.output->'proposal';
  -- Review is always a separate user action; accepting suggestions never invents approval.
  v_context := jsonb_set(v_context, '{intake}', coalesce(v_context->'intake','{}'::jsonb) || jsonb_build_object('personalityReviewedAt',null,'positioningReviewedAt',null));
  if v_job.operation = 'strategy.reformulate' then
    if jsonb_typeof(v_proposal->'activity') is distinct from 'string' or jsonb_typeof(v_proposal->'offering') is distinct from 'string'
      or jsonb_typeof(v_proposal->'knownAudience') is distinct from 'string' then raise exception 'invalid_result' using errcode = '22023'; end if;
    v_context := v_context || jsonb_build_object('activity',v_proposal->'activity','offering',v_proposal->'offering','knownAudience',v_proposal->'knownAudience',
      'reformulationConfirmed',false,'competitorReviewComplete',false);
    v_context := jsonb_set(v_context,'{intake,audienceReviewedAt}','null'::jsonb);
  elsif v_job.operation = 'strategy.competitors' then
    if jsonb_typeof(v_proposal->'competitors') is distinct from 'array' then raise exception 'invalid_result' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(item || jsonb_build_object('selected',false,'origin','research')),'[]'::jsonb) into v_items
      from jsonb_array_elements(v_proposal->'competitors') proposed(item)
      where not exists(select 1 from jsonb_array_elements(coalesce(v_context->'competitors','[]'::jsonb)) existing(item) where existing.item->>'id' = proposed.item->>'id');
    v_context := v_context || jsonb_build_object('competitors',coalesce(v_context->'competitors','[]'::jsonb) || v_items,'competitorReviewComplete',false);
    if jsonb_array_length(v_context->'competitors') > 50 then raise exception 'result_capacity_exceeded' using errcode = '22023'; end if;
    v_context := jsonb_set(v_context,'{intake,audienceReviewedAt}','null'::jsonb);
  elsif v_job.operation = 'strategy.audience' then
    if jsonb_typeof(v_proposal->'segments') is distinct from 'array' then raise exception 'invalid_result' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(item || jsonb_build_object('selected',false,'origin','proposal','sources','[]'::jsonb)),'[]'::jsonb) into v_items
      from jsonb_array_elements(v_proposal->'segments') proposed(item)
      where not exists(select 1 from jsonb_array_elements(coalesce(v_context->'audienceSegments','[]'::jsonb)) existing(item) where existing.item->>'id' = proposed.item->>'id');
    v_context := v_context || jsonb_build_object('audienceSegments',coalesce(v_context->'audienceSegments','[]'::jsonb) || v_items);
    if jsonb_array_length(v_context->'audienceSegments') > 30 then raise exception 'result_capacity_exceeded' using errcode = '22023'; end if;
    v_context := jsonb_set(v_context,'{intake,audienceReviewedAt}','null'::jsonb);
  elsif v_job.operation = 'strategy.personality' then
    if jsonb_typeof(v_proposal->'personality') is distinct from 'object' then raise exception 'invalid_result' using errcode = '22023'; end if;
    v_context := v_context || jsonb_build_object('personality',v_proposal->'personality');
  elsif v_job.operation = 'strategy.positioning' then
    if jsonb_typeof(v_proposal->'positioning') is distinct from 'string' then raise exception 'invalid_result' using errcode = '22023'; end if;
    -- Preserve the already reviewed personality when applying a positioning proposal.
    v_context := jsonb_set(v_context,'{intake,personalityReviewedAt}',coalesce((select context#>'{intake,personalityReviewedAt}' from public.project_revisions where project_id = p_project_id and revision = p_expected_revision),'null'::jsonb));
    v_context := v_context || jsonb_build_object('positioning',v_proposal->'positioning');
  end if;
  select * into v_revision from public.append_project_revision(p_project_id,p_expected_revision,v_context,encode(sha256(convert_to(v_context::text,'UTF8')),'hex'));
  insert into public.strategy_job_applications(job_id,step_key,owner_id,project_id,input_revision,applied_revision)
    values(v_job.id,v_step.step_key,v_owner,p_project_id,v_job.input_revision,v_revision.revision) returning * into v_application;
  return jsonb_build_object(
    'project',jsonb_build_object('id',v_project.id,'owner_id',v_owner,'scope',v_project.scope,'title',v_project.title,
      'current_revision',v_revision.revision,'created_at',v_project.created_at,'context',v_revision.context),
    'application',jsonb_build_object('jobId',v_application.job_id,'stepKey',v_application.step_key,
      'inputRevision',v_application.input_revision,'appliedRevision',v_application.applied_revision,'appliedAt',v_application.applied_at));
end $$;

commit;
