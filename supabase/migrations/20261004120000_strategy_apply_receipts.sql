-- Durable proof of an explicit strategy apply. Historical revisions alone do
-- not prove which result was accepted, so no applications are backfilled.
begin;

alter table public.jobs add constraint jobs_application_identity_key unique(id,owner_id,project_id,input_revision);
create table public.strategy_job_applications (
  job_id uuid not null,
  step_key text not null check(length(step_key) between 1 and 200),
  owner_id uuid not null,
  project_id uuid not null,
  input_revision integer not null check(input_revision > 0),
  applied_revision integer not null check(applied_revision = input_revision + 1),
  applied_at timestamptz not null default now(),
  primary key(job_id,step_key),
  unique(project_id,owner_id,applied_revision),
  foreign key(job_id,owner_id,project_id,input_revision) references public.jobs(id,owner_id,project_id,input_revision),
  foreign key(job_id,step_key) references public.job_steps(job_id,step_key),
  foreign key(project_id,owner_id,applied_revision) references public.project_revisions(project_id,owner_id,revision)
);
create index strategy_job_applications_owner_project on public.strategy_job_applications(owner_id,project_id,job_id);
alter table public.strategy_job_applications enable row level security;
alter table public.strategy_job_applications force row level security;
revoke all on public.strategy_job_applications from public,anon,authenticated,service_role;
grant select on public.strategy_job_applications to authenticated;
create policy owned_read on public.strategy_job_applications for select to authenticated using (owner_id = (select auth.uid()));
create trigger strategy_job_applications_immutable before update or delete on public.strategy_job_applications
  for each row execute function fluid_private.prevent_history_change();

-- The project row lock serializes applies and edits. Append plus receipt insert
-- share this transaction; neither can succeed independently.
-- Keep the original RPC and its bare-project response unchanged for deployed
-- clients. Only v2 returns an application receipt and supports exact replay.
create function public.apply_strategy_job_result_v2(p_project_id uuid, p_job_id uuid, p_expected_revision integer, p_step_key text)
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
    raise exception 'revision_conflict' using errcode = '40001';
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
      raise exception 'revision_conflict' using errcode = '40001';
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
    raise exception 'revision_conflict' using errcode = '40001';
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

revoke all on function public.apply_strategy_job_result_v2(uuid,uuid,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.apply_strategy_job_result_v2(uuid,uuid,integer,text) to authenticated;

commit;
