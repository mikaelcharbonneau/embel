-- Naming on the generation engine (docs/generation-engine.md, step 3).
-- Additive and safe to run twice:
--   1. the generation kind naming.generate, one credit per generation round, disabled;
--   2. a name origin for engine runs (brainstorm version 2, no old batch row);
--   3. fluid_private.engine_save_names, the engine login's only way to add names;
--   4. public.get_name_feed, the Naming feed that shows old runs and engine runs together.
-- Enabling the kind is a release decision. While it is disabled the app keeps the old
-- Naming path and nothing here is used.
set local lock_timeout = '5s';

-- 1. The kind. A round asks for up to 100 names. The daily limit is per person.
insert into fluid_private.generation_kinds (kind, credits, enabled, max_per_day)
  values ('naming.generate', 1, false, 30)
  on conflict (kind) do nothing;

-- 2. Engine names are generated brainstorm names whose run is an engine run, so they have
-- no naming_batches row. Every existing branch stays exactly as it is. Databases without the
-- brainstorm origin (older test fixtures that install it later) are left unchanged.
do $origin$
declare d text;
begin
  select pg_get_constraintdef(c.oid) into d from pg_constraint c
   where c.conrelid = 'public.name_candidates'::regclass and c.conname = 'name_candidates_check1';
  if d is null or position('brainstorm' in d) = 0 or position('''2''::jsonb' in d) > 0 then return; end if;
  alter table public.name_candidates drop constraint name_candidates_check1;
  alter table public.name_candidates add constraint name_candidates_check1 check(
   (origin->>'kind'='generated' and batch_id is not null and transform_id is null and source_candidate_id is null)
   or(origin->>'kind'='local_import' and batch_id is null and transform_id is null and source_candidate_id is null)
   or(origin->>'kind'='transform' and batch_id is null and transform_id is not null and source_candidate_id is null and origin->>'authorship'='user_supplied')
   or(origin->>'kind'='account_copy' and batch_id is null and transform_id is null and source_candidate_id is not null)
   or(origin->>'kind'='brainstorm' and origin->>'profile'='brainstorm_v1' and origin->'version'='1'::jsonb
    and batch_id is not null and transform_id is null and source_candidate_id is null)
   or(origin->>'kind'='brainstorm' and origin->>'profile'='brainstorm_v1' and origin->'version'='2'::jsonb
    and batch_id is null and transform_id is null and source_candidate_id is null and origin ? 'runId'));
end $origin$;

-- 3. Saves one finished OpenAI reply of a naming run: the output row (with its response id
-- and cost) and its checked names, in one transaction. Names already in the project are
-- skipped and a run keeps at most 100. A replayed save changes nothing.
create or replace function fluid_private.engine_save_names(p_run_id uuid, p_key text, p_output jsonb, p_response_id text, p_cost bigint)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.generation_runs; total integer; inserted jsonb := '[]'::jsonb; item jsonb; v_id uuid; v_identity text; v_revision integer; v_basis jsonb;
begin
  -- The row lock serializes saves of one run, so the 100-name cap and duplicate checks hold.
  select * into r from public.generation_runs where id = p_run_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.kind <> 'naming.generate' or p_key is null or p_key !~ '^round\.[1-3]\.[1-9]$'
     or jsonb_typeof(p_output) is distinct from 'object' or jsonb_typeof(p_output->'names') is distinct from 'array'
     or jsonb_array_length(p_output->'names') > 100 or length(coalesce(p_output->>'model', '')) not between 1 and 150
     or p_response_id is null or p_response_id !~ '^resp_[A-Za-z0-9_-]{1,194}$' or pg_column_size(p_output) > 262144 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if r.status <> 'running' then raise exception 'run_not_running' using errcode = '55000'; end if;
  select count(*) into total from public.name_candidates c
   where c.project_id = r.project_id and c.owner_id = r.owner_id and c.batch_id is null and c.origin->>'runId' = r.id::text;
  insert into public.generation_outputs (run_id, owner_id, output_key, output, provider_response_id, cost_microusd)
    values (r.id, r.owner_id, p_key, p_output, p_response_id, greatest(coalesce(p_cost, 0), 0))
    on conflict (run_id, output_key) do nothing;
  if not found then
    return jsonb_build_object('saved', false, 'savedCount', least(total, 100), 'inserted', coalesce((select jsonb_agg(c.identity_key order by c.created_at, c.id)
      from public.name_candidates c where c.project_id = r.project_id and c.owner_id = r.owner_id and c.batch_id is null
       and c.origin->>'runId' = r.id::text and c.origin->>'outputKey' = p_key), '[]'::jsonb));
  end if;
  v_revision := case when jsonb_typeof(r.input->'revision') = 'number' then (r.input->>'revision')::integer end;
  v_basis := r.input #> '{brief,strategyBasis}';
  if v_revision is null or jsonb_typeof(v_basis) is distinct from 'object' then raise exception 'invalid_run_input' using errcode = '22023'; end if;
  for item in select value from jsonb_array_elements(p_output->'names') loop
    if jsonb_typeof(item) is distinct from 'object'
       or (select array_agg(k order by k) from jsonb_object_keys(item) k) is distinct from array['identityKey', 'primaryApproach', 'rationale', 'value']
       or jsonb_typeof(item->'value') is distinct from 'string' or length(item->>'value') not between 1 and 160 or btrim(item->>'value') = ''
       or jsonb_typeof(item->'rationale') is distinct from 'string' or length(item->>'rationale') not between 1 and 600
       or jsonb_typeof(item->'identityKey') is distinct from 'string' or length(item->>'identityKey') not between 1 and 320
       or coalesce(item->>'primaryApproach', '') not in ('real_words', 'compounds', 'blends', 'invented', 'modified', 'phrases', 'initials',
         'other_languages', 'classical_roots', 'people_places', 'stories_culture') then
      raise exception 'invalid_input' using errcode = '22023';
    end if;
    exit when total >= 100;
    v_identity := item->>'identityKey';
    continue when exists (select 1 from public.name_candidates where project_id = r.project_id and identity_key = v_identity);
    v_id := gen_random_uuid();
    -- clock_timestamp keeps the feed in the order the AI proposed the names.
    insert into public.name_candidates (id, owner_id, project_id, value, identity_key, context_revision, strategy_basis, origin, rationale, caution, created_at)
    values (v_id, r.owner_id, r.project_id, item->>'value', v_identity, v_revision, v_basis,
      jsonb_build_object('kind', 'brainstorm', 'version', 2, 'profile', 'brainstorm_v1', 'ownerId', r.owner_id, 'projectId', r.project_id,
        'candidateId', v_id, 'contextRevision', v_revision, 'value', item->>'value', 'runId', r.id, 'outputKey', p_key,
        'responseId', p_response_id, 'model', p_output->>'model', 'primaryApproach', item->>'primaryApproach', 'generatedAt', clock_timestamp()),
      item->>'rationale', 'Unchecked brainstorm. Research and screening are needed before use.', clock_timestamp());
    inserted := inserted || to_jsonb(v_identity);
    total := total + 1;
  end loop;
  return jsonb_build_object('saved', true, 'inserted', inserted, 'savedCount', total);
end $$;

-- 4. The Naming feed while the engine path is on: generated names of the old runs and of
-- engine runs, oldest first, and the latest run of either path. Same shape as
-- get_naming_generation. The old-run helpers are resolved only when such runs exist.
create or replace function public.get_name_feed(p_project uuid, p_after_created_at timestamptz default null, p_after_id uuid default null, p_limit integer default 100)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o uuid := auth.uid(); p public.projects; b public.naming_batches; j public.jobs; g public.generation_runs; c public.name_candidates;
  k fluid_private.generation_kinds; paused boolean; run jsonb; approach jsonb; entries jsonb := '[]'::jsonb; n integer := 0; more boolean := false;
  last_created timestamptz; last_id uuid; legacy_batches uuid[] := '{}';
begin
  if o is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_after_created_at is null) <> (p_after_id is null) then
    raise exception 'invalid_naming_request' using errcode = '22023';
  end if;
  select * into p from public.projects where id = p_project and owner_id = o and deleted_at is null and deletion_requested_at is null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;

  select coalesce(array_agg(bb.id), '{}') into legacy_batches from public.naming_batches bb
   where bb.project_id = p.id and bb.owner_id = o and bb.engine_version = 3;
  select * into g from public.generation_runs where project_id = p.id and owner_id = o and kind = 'naming.generate' order by created_at desc, id desc limit 1;
  if cardinality(legacy_batches) > 0 then
    select bb.* into b from public.naming_batches bb where bb.id = any(legacy_batches) order by bb.sequence desc limit 1;
    select * into strict j from public.jobs where id = b.job_id;
  end if;
  if g.id is not null and (j.id is null or g.created_at >= j.created_at) then
    run := jsonb_build_object('runId', g.id, 'jobId', g.id,
      'kind', case when g.input->>'kind' in ('initial', 'more', 'steer') then g.input->>'kind' else 'more' end,
      'state', case when g.status in ('queued', 'running') and g.cancel_requested_at is not null then 'cancel_requested' else g.status end,
      'target', 100,
      'savedCount', least(100, (select count(*) from public.name_candidates nc where nc.project_id = p.id and nc.owner_id = o
         and nc.batch_id is null and nc.origin->>'runId' = g.id::text))::integer,
      'errorCode', g.error_code, 'usage', null, 'createdAt', g.created_at, 'finishedAt', g.finished_at);
  elsif j.id is not null then
    run := fluid_private.naming_run_json(b, j);
  end if;

  for c in select cc.* from public.name_candidates cc
    where cc.project_id = p.id and cc.owner_id = o
      and (cc.batch_id = any(legacy_batches) or cc.batch_id is null and cc.origin->>'kind' = 'brainstorm' and cc.origin->'version' = '2'::jsonb)
      and (p_after_id is null or (cc.created_at, cc.id) > (p_after_created_at, p_after_id))
    order by cc.created_at, cc.id limit p_limit + 1 loop
    n := n + 1;
    if n > p_limit then more := true; exit; end if;
    if c.batch_id is null then
      approach := c.origin->'primaryApproach';
    else
      select to_jsonb(a.primary_approach) into approach from fluid_private.naming_candidate_approaches a where a.candidate_id = c.id;
    end if;
    entries := entries || jsonb_build_array(jsonb_build_object('entry', fluid_private.naming_entry(c),
      'runId', coalesce(c.batch_id, (c.origin->>'runId')::uuid), 'primaryApproach', coalesce(approach, 'null'::jsonb)));
    last_created := c.created_at; last_id := c.id;
  end loop;

  select * into k from fluid_private.generation_kinds where kind = 'naming.generate';
  select s.paused into paused from fluid_private.engine_settings s where s.id;
  return jsonb_build_object('version', 2, 'projectId', p.id,
    'availability', case when coalesce(k.enabled, false) and not coalesce(paused, false) then jsonb_build_object('status', 'available')
      else jsonb_build_object('status', 'unavailable', 'code', case when paused then 'generation_paused' else 'generation_unavailable' end) end,
    'run', coalesce(run, 'null'::jsonb), 'entries', entries,
    'nextCursor', case when more then jsonb_build_object('createdAt', last_created, 'id', last_id) else 'null'::jsonb end);
end $$;

-- Grants --------------------------------------------------------------------

revoke all on function fluid_private.engine_save_names(uuid, text, jsonb, text, bigint) from public, anon, authenticated, service_role;
grant execute on function fluid_private.engine_save_names(uuid, text, jsonb, text, bigint) to embel_engine;
revoke all on function public.get_name_feed(uuid, timestamptz, uuid, integer) from public, anon, service_role;
grant execute on function public.get_name_feed(uuid, timestamptz, uuid, integer) to authenticated;
