-- Authenticated strategy enqueue never accepts owner, provider input, model or prices.
-- Disabled by default: an approved operator must configure policy and account budget.
begin;

create table fluid_private.strategy_runtime_policy (
  operation text primary key check(operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')),
  enabled boolean not null default false,
  policy jsonb not null check(jsonb_typeof(policy) = 'object' and octet_length(policy::text) <= 4096
    and policy ?& array['version','pricingVersion','handlerVersion','model','maxInputTokens','maxOutputTokens','maxWebSearchCalls',
      'inputMicrousdPerMillionTokens','cachedInputMicrousdPerMillionTokens','cacheWriteMicrousdPerMillionTokens',
      'outputMicrousdPerMillionTokens','webSearchMicrousdPerCall','maximumCostMicrousd']
    and policy->>'version' = '1' and policy->>'pricingVersion' = '2026-10-03'
    and policy->>'handlerVersion' = 'strategy-openai-v1'
    and length(policy->>'model') between 1 and 150
    and jsonb_typeof(policy->'maximumCostMicrousd') = 'number'
    and (policy->>'maximumCostMicrousd')::numeric between 1 and 9007199254740991
    and (policy->>'maximumCostMicrousd')::numeric = trunc((policy->>'maximumCostMicrousd')::numeric)),
  worker_ready_until timestamptz
);
revoke all on fluid_private.strategy_runtime_policy from public, anon, authenticated, service_role;

create function fluid_private.invalidate_strategy_readiness() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.policy,new.enabled) is distinct from (old.policy,old.enabled) then new.worker_ready_until := null; end if;
  return new;
end $$;
create trigger strategy_policy_readiness before update on fluid_private.strategy_runtime_policy
  for each row execute function fluid_private.invalidate_strategy_readiness();

create function fluid_private.strategy_job_summary(p_job public.jobs)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_job.id, 'owner_id', p_job.owner_id, 'project_id', p_job.project_id,
    'operation', p_job.operation, 'input_revision', p_job.input_revision,
    'state', p_job.state, 'progress', p_job.progress,
    'reserved_cost_microusd', p_job.reserved_cost_microusd, 'actual_cost_microusd', p_job.actual_cost_microusd,
    'cancel_requested_at', p_job.cancel_requested_at, 'error_code', p_job.error_code,
    'created_at', p_job.created_at, 'finished_at', p_job.finished_at);
$$;

-- A configured worker proves exact policy compatibility, not provider inference success.
-- No ability to create/enable policies or raise an account budget is granted here.
create function public.report_strategy_worker_ready(p_operation text, p_policy jsonb, p_ready_seconds integer default 60)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_ready_seconds is null or p_ready_seconds < 1 or p_ready_seconds > 90 then
    raise exception 'invalid_readiness_window' using errcode = '22023';
  end if;
  update fluid_private.strategy_runtime_policy
    set worker_ready_until = clock_timestamp() + make_interval(secs => p_ready_seconds)
    where operation = p_operation and enabled and policy = p_policy;
  return found;
end $$;

create function public.get_strategy_availability(p_project_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_account public.usage_accounts; v_operations jsonb;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_project_id is not null and not exists(select 1 from public.projects where id = p_project_id and owner_id = v_owner) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not exists(select 1 from fluid_private.strategy_runtime_policy where enabled) then
    return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','runtime_disabled');
  end if;
  if not exists(select 1 from fluid_private.strategy_runtime_policy where enabled and worker_ready_until > clock_timestamp()) then
    return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','worker_unavailable');
  end if;
  select * into v_account from public.usage_accounts where owner_id = v_owner;
  select coalesce(jsonb_agg(jsonb_build_object('operation', operation, 'maximumCostMicrousd', (policy->>'maximumCostMicrousd')::bigint) order by operation), '[]'::jsonb)
    into v_operations from fluid_private.strategy_runtime_policy
    where enabled and worker_ready_until > clock_timestamp()
      and (policy->>'maximumCostMicrousd')::bigint <= v_account.limit_microusd - greatest(v_account.spent_microusd, v_account.provider_actual_microusd) - v_account.reserved_microusd;
  if jsonb_array_length(v_operations) = 0 then
    return jsonb_build_object('status','unavailable','operations','[]'::jsonb,'reason','budget_unavailable');
  end if;
  return jsonb_build_object('status','available','operations',v_operations);
end $$;

create function public.enqueue_strategy_job(p_project_id uuid, p_expected_revision integer, p_operation text,
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
  select * into v_project from public.projects where id = p_project_id and owner_id = v_owner for share;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_project.current_revision <> p_expected_revision then raise exception 'revision_conflict' using errcode = '40001'; end if;
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

-- Applying a proposal creates a new revision. The caller supplies no output or provenance.
create function public.apply_strategy_job_result(p_project_id uuid, p_job_id uuid, p_expected_revision integer, p_step_key text)
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
    raise exception 'revision_conflict' using errcode = '40001';
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

revoke all on function fluid_private.strategy_job_summary(public.jobs) from public, anon, authenticated, service_role;
revoke all on function fluid_private.invalidate_strategy_readiness() from public, anon, authenticated, service_role;
revoke all on function public.report_strategy_worker_ready(text,jsonb,integer), public.get_strategy_availability(uuid),
  public.enqueue_strategy_job(uuid,integer,text,text,bigint), public.apply_strategy_job_result(uuid,uuid,integer,text)
  from public, anon, authenticated, service_role;
grant execute on function public.report_strategy_worker_ready(text,jsonb,integer) to service_role;
grant execute on function public.get_strategy_availability(uuid), public.enqueue_strategy_job(uuid,integer,text,text,bigint),
  public.apply_strategy_job_result(uuid,uuid,integer,text) to authenticated;

commit;
