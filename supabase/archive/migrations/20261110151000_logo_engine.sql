-- Logo concepts, refinements and style notes on the generation engine
-- (docs/generation-engine.md, step 4). Additive except one replaced function
-- body with an unchanged signature and grants (finish_generation_run).
--
-- Kinds start disabled; enabling all three together is a release decision, and
-- the Logo screens keep the old path until every one of them is enabled.
--  * logo.concepts: one round of up to six concept images, drawn in parallel.
--    6 credits: one per image. A retry of failed concepts is a round of fewer
--    images that is charged 6 and keeps only what it delivers.
--  * logo.refine: one refined image, 1 credit.
--  * logo.style_note: style notes for liked uploads (short text, free).
-- A round's images are recorded in the same Logo tables the shared worker
-- writes (concept batches, attempts, raster results, committed assets), as
-- terminal records only, so the Logo screens, selection, refinement and
-- Creative direction read them unchanged. Style notes are generation outputs.
begin;
set local lock_timeout = '2s';

-- Daily limits are per owner and kind. Running limits fit the longest path: a
-- highest-quality image takes two to three minutes and gets at most three tries
-- when nothing was drawn.
insert into fluid_private.generation_kinds (kind, credits, enabled, max_per_day, max_running_minutes) values
  ('logo.concepts', 6, false, 20, 20),
  ('logo.refine', 1, false, 60, 15),
  ('logo.style_note', 0, false, 30, 10)
on conflict (kind) do nothing;

-- Credits pay for what is delivered. A Logo image run keeps one credit per image
-- it saved, however it ends (finished, failed, stopped or timed out), and
-- returns the rest; a run of another kind keeps its credits only when it
-- succeeds, as before. A Logo run that delivered nothing ends as failed.
create or replace function fluid_private.finish_generation_run(p_run_id uuid, p_status text, p_error text) returns public.generation_runs
language plpgsql security definer set search_path = '' as $$
declare r public.generation_runs; images boolean; delivered integer := 0; kept integer; v_status text := p_status; v_error text := p_error;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then raise exception 'invalid_status' using errcode = '22023'; end if;
  select * into r from public.generation_runs where id = p_run_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.status not in ('queued', 'running') then return r; end if;
  images := r.kind in ('logo.concepts', 'logo.refine');
  if images then
    select count(*) into delivered from public.generation_outputs o
     where o.run_id = r.id and o.output_key ~ '^image\.' and o.output->>'state' = 'succeeded';
    if v_status = 'succeeded' and delivered = 0 then v_status := 'failed'; v_error := coalesce(v_error, 'no_images_delivered'); end if;
  end if;
  update public.generation_runs
     set status = v_status, error_code = case when v_status = 'succeeded' then null else v_error end, finished_at = now()
   where id = r.id returning * into r;
  kept := case when images then least(delivered, r.credits) when v_status = 'succeeded' then r.credits else 0 end;
  if r.credits - kept > 0 then
    insert into public.credit_entries (owner_id, delta, kind, run_id, note)
      values (r.owner_id, r.credits - kept, 'refund', r.id, case when kept > 0 then 'Images that were not delivered' else 'Generation did not finish' end)
      on conflict (run_id) where kind = 'refund' do nothing;
  end if;
  return r;
end $$;

-- Engine-only Logo functions ---------------------------------------------------

-- Opens a concepts round: creates its batch and six slots from the person's
-- frozen brief (or, to retry failed concepts, checks that each named slot of
-- that batch last failed), records the batch as output "batch", and returns
-- the slots to draw. Replays return the same slots.
create function fluid_private.engine_logo_begin(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.generation_runs; i jsonb; brief public.logo_stage_revisions; b public.logo_concept_batches;
  plan jsonb; prior bigint; item jsonb; slots jsonb := '[]'::jsonb; s public.logo_concept_slots; v_batch uuid;
begin
  select * into r from public.generation_runs where id = p_run_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.status <> 'running' then raise exception 'run_not_running' using errcode = '55000'; end if;
  i := r.input;
  if r.kind <> 'logo.concepts' or i->'version' is distinct from '1'::jsonb or not fluid_private.logo_uuid(i->'batchId')
     or not fluid_private.logo_uuid(i#>'{brief,id}') or jsonb_typeof(i#>'{brief,revision}') is distinct from 'number' then
    raise exception 'invalid_run_input' using errcode = '22023';
  end if;
  v_batch := (i->>'batchId')::uuid;
  select * into brief from public.logo_stage_revisions
   where id = (i#>>'{brief,id}')::uuid and owner_id = r.owner_id and project_id = r.project_id and stage = 'brief_references'
     and revision = (i#>>'{brief,revision}')::bigint;
  if not found then raise exception 'invalid_run_input' using errcode = '22023'; end if;
  select * into b from public.logo_concept_batches where id = v_batch;
  if i->>'operation' in ('concepts', 'more_concepts') then
    if not found then
      select count(*) * 6 into prior from public.logo_concept_batches where owner_id = r.owner_id and project_id = r.project_id;
      plan := fluid_private.logo_plan(brief.record#>'{payload,logoTypes}', prior);
      insert into public.logo_concept_batches (id, owner_id, project_id, request_key, brief_revision_id, reference_snapshot_id, plan, input_revisions)
        values (v_batch, r.owner_id, r.project_id, r.id, brief.id, brief.reference_snapshot_id, plan,
          jsonb_build_array(jsonb_build_object('stage', 'brief_references', 'id', brief.id, 'revision', brief.revision)))
        returning * into b;
      for item in select value from jsonb_array_elements(plan->'slots') loop
        insert into public.logo_concept_slots (id, batch_id, owner_id, project_id, ordinal, logo_type, direction_id)
          values (gen_random_uuid(), v_batch, r.owner_id, r.project_id, (item->>'ordinal')::integer, item->>'type', item->>'directionId');
      end loop;
    elsif b.owner_id <> r.owner_id or b.project_id <> r.project_id or b.request_key <> r.id then
      raise exception 'invalid_run_input' using errcode = '22023';
    end if;
    for s in select sl.* from public.logo_concept_slots sl where sl.batch_id = b.id order by sl.ordinal loop
      slots := slots || jsonb_build_array(jsonb_build_object('ordinal', s.ordinal, 'slotId', s.id, 'type', s.logo_type, 'directionId', s.direction_id));
    end loop;
  elsif i->>'operation' = 'retry_failed' then
    if not found or b.owner_id <> r.owner_id or b.project_id <> r.project_id or b.brief_revision_id <> brief.id
       or jsonb_typeof(i->'slotIds') is distinct from 'array' or jsonb_array_length(i->'slotIds') not between 1 and 6 then
      raise exception 'invalid_run_input' using errcode = '22023';
    end if;
    for s in select sl.* from public.logo_concept_slots sl where sl.batch_id = b.id order by sl.ordinal loop
      if i->'slotIds' ? s.id::text then
        -- Only a slot whose latest attempt definitely failed is drawn again.
        if (select j.state from public.logo_concept_attempts a join public.jobs j on j.id = a.job_id
             where a.slot_id = s.id order by a.attempt_number desc limit 1) is distinct from 'failed'
           and not exists (select 1 from public.generation_outputs o where o.run_id = r.id and o.output_key = 'image.' || s.ordinal) then
          raise exception 'logo_retry_requires_confirmed_failure' using errcode = '22023';
        end if;
        slots := slots || jsonb_build_array(jsonb_build_object('ordinal', s.ordinal, 'slotId', s.id, 'type', s.logo_type, 'directionId', s.direction_id));
      end if;
    end loop;
    if jsonb_array_length(slots) <> jsonb_array_length(i->'slotIds') then raise exception 'invalid_run_input' using errcode = '22023'; end if;
  else
    raise exception 'invalid_run_input' using errcode = '22023';
  end if;
  insert into public.generation_outputs (run_id, owner_id, output_key, output)
    values (r.id, r.owner_id, 'batch', jsonb_build_object('batchId', b.id)) on conflict (run_id, output_key) do nothing;
  return jsonb_build_object('batchId', b.id, 'plan', b.plan, 'slots', slots);
end $$;

-- Records one image of a Logo run, once per output key ("image.0" to
-- "image.5" for concepts, "image.refine" for a refinement), in one transaction:
--  * a drawn image whose bytes are already stored at the owner's path
--    {owner}/{project}/{asset}/{version} becomes a committed asset and a
--    finished attempt (or refinement) that the Logo screens show and select;
--  * a failed image becomes a failed attempt, so it can be retried;
--  * an image that finished after its run stopped keeps only its usage.
-- Costs are estimated from usage and never shown. Replays return the output.
create function fluid_private.engine_logo_save_image(p_run_id uuid, p_key text, p_image jsonb, p_response_id text, p_cost bigint)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.generation_runs; i jsonb; existing jsonb; cost bigint := greatest(coalesce(p_cost, 0), 0);
  succeeded boolean; code text; img jsonb := p_image->'image'; provider jsonb := p_image->'provider';
  v_revision integer; job_id uuid := gen_random_uuid(); job_input jsonb; job_hash text; target_id uuid := gen_random_uuid();
  s public.logo_concept_slots; previous public.logo_concept_attempts; resolved jsonb; inputs jsonb; receipt_id uuid;
  publication public.logo_asset_publications; receipt jsonb; payload jsonb; v_output jsonb;
begin
  if p_key is null or p_key !~ '^image\.([0-5]|refine)$' or jsonb_typeof(p_image) is distinct from 'object'
     or p_image->>'state' not in ('succeeded', 'failed') or (p_response_id is not null and length(p_response_id) not between 1 and 200) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into r from public.generation_runs where id = p_run_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select o.output into existing from public.generation_outputs o where o.run_id = r.id and o.output_key = p_key;
  if existing is not null then return existing; end if;
  if r.kind not in ('logo.concepts', 'logo.refine') or (r.kind = 'logo.refine') <> (p_key = 'image.refine') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  succeeded := p_image->>'state' = 'succeeded';
  code := case when succeeded then null else p_image->>'code' end;
  if not succeeded and (code is null or code !~ '^[a-z][a-z_]{0,63}$') then raise exception 'invalid_input' using errcode = '22023'; end if;
  if succeeded and (provider is null or jsonb_typeof(img) is distinct from 'object' or img->>'mimeType' <> 'image/png'
     or not fluid_private.logo_uuid(img->'assetId') or not fluid_private.logo_uuid(img->'versionId')
     or coalesce(img->>'contentHash', '') !~ '^[0-9a-f]{64}$' or coalesce(img->>'normalizedPixelHash', '') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(img->'byteLength') is distinct from 'number' or (img->>'byteLength')::numeric not between 1 and 52428800) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if provider is not null and jsonb_typeof(provider) is distinct from 'object' then raise exception 'invalid_input' using errcode = '22023'; end if;
  if r.status <> 'running' then
    -- The run already ended; this image is not delivered, but its usage is kept.
    if r.status in ('cancelled', 'failed') and r.finished_at > now() - interval '1 hour' then
      v_output := jsonb_build_object('state', 'discarded', 'code', coalesce(code, 'run_stopped'));
      insert into public.generation_outputs (run_id, owner_id, output_key, output, provider_response_id, cost_microusd)
        values (r.id, r.owner_id, p_key, v_output, p_response_id, cost) on conflict (run_id, output_key) do nothing;
      return v_output;
    end if;
    raise exception 'run_not_running' using errcode = '55000';
  end if;
  i := r.input;
  v_revision := (i->>'revision')::integer;
  if r.kind = 'logo.concepts' then
    select sl.* into s from public.logo_concept_slots sl
     where sl.batch_id = (i->>'batchId')::uuid and sl.owner_id = r.owner_id and sl.project_id = r.project_id and sl.ordinal = substring(p_key from 7)::integer;
    if not found or (i->>'operation' = 'retry_failed' and not (i->'slotIds' ? s.id::text)) then raise exception 'invalid_input' using errcode = '22023'; end if;
    select a.* into previous from public.logo_concept_attempts a where a.slot_id = s.id order by a.attempt_number desc limit 1;
    -- The same picture twice in one round is not a second concept.
    if succeeded and exists (select 1 from public.logo_concept_slots sl
         join public.logo_concept_attempts a on a.slot_id = sl.id
         join public.logo_raster_results rr on rr.job_id = a.job_id
         join public.logo_provider_responses pr on pr.id = rr.provider_response_receipt_id
        where sl.batch_id = s.batch_id and pr.observation->>'normalizedPixelHash' = img->>'normalizedPixelHash') then
      succeeded := false; code := 'duplicate_preview';
    end if;
    job_input := jsonb_build_object('version', 1, 'engine', jsonb_build_object('runId', r.id, 'outputKey', p_key),
      'operation', 'identity.logo_concept', 'ownerId', r.owner_id, 'projectId', r.project_id, 'requestKey', r.id,
      'batchId', s.batch_id, 'slotId', s.id, 'attemptId', target_id);
  else
    resolved := fluid_private.resolve_logo_raster_source(r.owner_id, r.project_id, i->'source');
    select jsonb_agg(value order by value->>'stage', value->>'id') into inputs from (select distinct value from jsonb_array_elements(
      jsonb_build_array(jsonb_build_object('stage', 'brief_references', 'id', i#>'{brief,id}', 'revision', i#>'{brief,revision}')) || (resolved->'inputRevisions'))) refs;
    job_input := jsonb_build_object('version', 1, 'engine', jsonb_build_object('runId', r.id, 'outputKey', p_key),
      'operation', 'identity.logo_refine', 'ownerId', r.owner_id, 'projectId', r.project_id, 'requestKey', r.id,
      'rasterRevisionId', target_id, 'source', i->'source');
  end if;
  if succeeded and not exists (select 1 from storage.objects o where o.bucket_id = 'fluid-assets'
       and o.name = r.owner_id::text || '/' || r.project_id::text || '/' || (img->>'assetId') || '/' || (img->>'versionId')) then
    raise exception 'image_not_stored' using errcode = '55000';
  end if;
  job_hash := encode(sha256(convert_to(job_input::text, 'UTF8')), 'hex');
  -- A finished record only: no lease, so no worker ever claims it.
  insert into public.jobs (id, owner_id, project_id, operation, input_revision, input_hash, input, idempotency_key, state, progress,
      worker_id, attempts, max_attempts, reserved_cost_microusd, actual_cost_microusd, error_code, finished_at)
    values (job_id, r.owner_id, r.project_id, job_input->>'operation', v_revision, job_hash, job_input, 'engine:' || r.id::text || ':' || p_key,
      case when succeeded then 'succeeded' else 'failed' end, 100, 'embel-engine', 1, 1, 0, cost, code, clock_timestamp());
  if provider is not null then
    insert into public.logo_provider_responses (owner_id, project_id, job_id, lease_token, observation)
      values (r.owner_id, r.project_id, job_id, gen_random_uuid(), jsonb_strip_nulls(jsonb_build_object('provider', 'openai',
        'model', provider->'model', 'providerRequestId', provider->'providerRequestId', 'responseHash', provider->'responseHash',
        'observedAt', provider->'observedAt', 'billing', jsonb_build_object('status', 'recorded', 'confirmedMicrousd', cost),
        'artifactHash', img->'contentHash', 'normalizedPixelHash', img->'normalizedPixelHash')))
      returning id into receipt_id;
  end if;
  if r.kind = 'logo.concepts' then
    insert into public.logo_concept_attempts (id, owner_id, project_id, slot_id, job_id, request_key, previous_attempt_id, attempt_number, input_hash)
      values (target_id, r.owner_id, r.project_id, s.id, job_id, r.id, previous.id, coalesce(previous.attempt_number, 0) + 1, job_hash);
  else
    insert into public.logo_raster_refinements (id, owner_id, project_id, request_key, job_id, source, logo_type, input_revisions)
      values (target_id, r.owner_id, r.project_id, r.id, job_id, i->'source', resolved->>'logoType', inputs);
  end if;
  if succeeded then
    insert into public.logo_asset_publications (owner_id, project_id, request_key, request, asset_id, version_id, content_hash, mime_type, byte_length,
        purpose, source_receipt_id, rights_evidence_id, source_kind, state, verification, job_id, lease_token, input_revision, input_hash)
      values (r.owner_id, r.project_id, target_id, jsonb_build_object('kind', 'engine', 'runId', r.id, 'outputKey', p_key),
        (img->>'assetId')::uuid, (img->>'versionId')::uuid, img->>'contentHash', 'image/png', (img->>'byteLength')::bigint,
        'brand_asset', target_id, null, 'concept', 'staged',
        jsonb_build_object('status', 'verified', 'checkedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'contentHash', img->'contentHash', 'mimeType', 'image/png', 'byteLength', img->'byteLength'),
        null, null, v_revision, job_hash)
      returning * into publication;
    receipt := fluid_private.logo_commit_asset(publication);
    insert into public.logo_raster_results (job_id, owner_id, project_id, preview, provider_response_receipt_id)
      values (job_id, r.owner_id, r.project_id, receipt, receipt_id);
    -- Like the shared worker: a refinement moves the refinements head only
    -- while the workspace is still where the person asked from.
    if r.kind = 'logo.refine' and fluid_private.logo_workspace_json(r.owner_id, r.project_id)->'heads' = i->'expected' then
      select rr.record->'payload' into payload from public.logo_stage_heads h join public.logo_stage_revisions rr on rr.id = h.revision_id
       where h.project_id = r.project_id and h.owner_id = r.owner_id and h.stage = 'refinements';
      payload := jsonb_build_object('rasterRevisionIds', coalesce(payload->'rasterRevisionIds', '[]'::jsonb) || jsonb_build_array(target_id),
        'vectorRevisionId', null, 'approvalId', null, 'sourceRequestKey', r.id);
      perform fluid_private.logo_append_stage(r.owner_id, r.project_id, 'refinements', payload, inputs);
    end if;
  end if;
  v_output := jsonb_build_object('state', case when succeeded then 'succeeded' else 'failed' end, 'jobId', job_id)
    || case when code is null then '{}'::jsonb else jsonb_build_object('code', code) end
    || case when r.kind = 'logo.concepts' then jsonb_build_object('batchId', s.batch_id, 'slotId', s.id, 'ordinal', s.ordinal, 'attemptId', target_id)
            else jsonb_build_object('rasterRevisionId', target_id) end;
  insert into public.generation_outputs (run_id, owner_id, output_key, output, provider_response_id, cost_microusd)
    values (r.id, r.owner_id, p_key, v_output, p_response_id, cost);
  return v_output;
end $$;

revoke all on function fluid_private.engine_logo_begin(uuid), fluid_private.engine_logo_save_image(uuid, text, jsonb, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function fluid_private.engine_logo_begin(uuid), fluid_private.engine_logo_save_image(uuid, text, jsonb, text, bigint) to embel_engine;
commit;
