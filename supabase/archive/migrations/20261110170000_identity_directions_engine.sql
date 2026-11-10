-- Creative directions on the generation engine (docs/generation-engine.md, step 5).
-- Additive except one replaced function body with an unchanged signature and
-- grants (finish_generation_run), guarded by the sha256 of the body it replaces.
--
-- Kind identity.directions ships disabled. While it is off nothing here runs and
-- Creative direction keeps the shared worker exactly as before.
--  * One run is one round of three direction boards around the chosen logo.
--  * 3 credits: one per delivered board, like Logo images. A run keeps a credit
--    for each board it delivered, however it ends, and returns the rest.
--
-- A round is written into the same tables the shared worker writes, so the
-- Creative direction screens, selection, the brand board and downloads read it
-- unchanged: an input snapshot, an identity.image job (input version 3), its
-- batch and request, then per delivered board a committed asset, a system
-- version with its application design, its file, a succeeded job step and a
-- generated root. Each board is checked with the existing evidence check
-- (fluid_private.identity_root_evidence) before it is saved.
--
-- The selected-logo board packet (supabase/candidates/shared_identity_selected_logo_boards.sql
-- and its predecessors) is applied in production but not by migrations. The
-- functions below use it at run time only; on a database built from migrations
-- alone they refuse with generation_unavailable, and the kind stays off.
begin;
set local lock_timeout = '2s';
do $guard$
begin
  if current_user <> 'postgres' then raise exception 'identity_directions_engine_prerequisite' using errcode = '55000'; end if;
end $guard$;

-- Daily limits are per owner. The longest path is three specifications in turn
-- (each at most two paid tries of up to four minutes) and the last board
-- (up to five minutes), so a round gets 35 minutes.
insert into fluid_private.generation_kinds (kind, credits, enabled, max_per_day, max_running_minutes) values
  ('identity.directions', 3, false, 10, 35)
on conflict (kind) do nothing;

-- The engine's direction policy: the shared worker's text policy and the board
-- image request, unchanged. The identity is the sha256 of their canonical JSON
-- (src/server/engine/identity-input.ts computes the same value).
create function fluid_private.engine_identity_policy() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'policyIdentity', '8d1ddc5bf5bdd42135277a217ff67057d729b6f797840146a6bc7c701bb94ae2',
    'textPolicy', jsonb_build_object('version', 1, 'model', 'gpt-6.1-sol', 'serviceTier', 'default', 'pricingVersion', '2026-10-03',
      'maxInputTokens', 32768, 'maxOutputTokens', 8192, 'maxInputBytes', 131072, 'maxOutputBytes', 65536, 'deadlineMs', 240000, 'maxTools', 0),
    'requestedModel', 'gpt-image-2.6-sunburst');
$$;

-- The person's account, as the shared Creative direction functions check it.
-- Refuses on a database without the selected-logo board packet.
create function fluid_private.engine_identity_customer(p_project_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o uuid := auth.uid();
begin
  if o is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if to_regprocedure('fluid_private.shared_identity_customer(uuid)') is null
     or to_regprocedure('fluid_private.shared_identity_selected_logo(uuid,uuid)') is null
     or to_regprocedure('fluid_private.shared_identity_batch_state(uuid,uuid,uuid)') is null
     or to_regclass('fluid_private.identity_system_applications') is null then
    raise exception 'generation_unavailable' using errcode = '55000';
  end if;
  return fluid_private.shared_identity_customer(p_project_id);
end $$;

-- Ends the batch's job with the run: three boards succeeded, a stop cancelled,
-- some boards partial, none failed. Runs inside finish_generation_run.
create function fluid_private.engine_identity_close_job(r public.generation_runs) returns void
language plpgsql security definer set search_path = '' as $$
declare j public.jobs; n integer; v_state text;
begin
  if r.kind <> 'identity.directions' or not fluid_private.logo_uuid(r.input->'jobId') then return; end if;
  select * into j from public.jobs where id = (r.input->>'jobId')::uuid and owner_id = r.owner_id and project_id = r.project_id
     and operation = 'identity.image' for update;
  if not found or j.state not in ('queued', 'running', 'cancel_requested') then return; end if;
  select count(*) into n from public.job_steps where job_id = j.id and state = 'succeeded';
  v_state := case when n = 3 then 'succeeded' when r.status = 'cancelled' then 'cancelled' when n > 0 then 'partial' else 'failed' end;
  update public.jobs
     set state = v_state, lease_token = null, lease_expires_at = null, progress = 100, finished_at = clock_timestamp(),
         cancel_requested_at = case when r.status = 'cancelled' then coalesce(cancel_requested_at, clock_timestamp()) else cancel_requested_at end,
         actual_cost_microusd = greatest(actual_cost_microusd, (select coalesce(sum(o.cost_microusd), 0) from public.generation_outputs o where o.run_id = r.id)),
         error_code = case when v_state = 'succeeded' then null
           when r.error_code ~ '^[a-z][a-z0-9_]{0,79}$' then r.error_code else 'directions_incomplete' end
   where id = j.id;
end $$;

-- finish_generation_run: as in 20261110151000_logo_engine, plus Creative
-- directions: a round keeps one credit per delivered board ("board.N" outputs)
-- and its batch's job ends with the run. Replaced only from that exact body.
do $install$
declare body text;
begin
  select prosrc into body from pg_proc where oid = 'fluid_private.finish_generation_run(uuid,text,text)'::regprocedure;
  if strpos(body, 'engine_identity_close_job') > 0 then return; end if;
  if encode(sha256(convert_to(body, 'UTF8')), 'hex') <> 'c17a7122e813c6085c7ac2351ffa68eca0c06e419d065e889bbb39e684013f7b' then
    raise exception 'identity_directions_finish_mismatch' using errcode = '55000';
  end if;
end $install$;
create or replace function fluid_private.finish_generation_run(p_run_id uuid, p_status text, p_error text) returns public.generation_runs
language plpgsql security definer set search_path = '' as $$
declare r public.generation_runs; images boolean; delivered integer := 0; kept integer; v_status text := p_status; v_error text := p_error;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then raise exception 'invalid_status' using errcode = '22023'; end if;
  select * into r from public.generation_runs where id = p_run_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.status not in ('queued', 'running') then return r; end if;
  images := r.kind in ('logo.concepts', 'logo.refine', 'identity.directions');
  if images then
    select count(*) into delivered from public.generation_outputs o
     where o.run_id = r.id and o.output_key ~ case when r.kind = 'identity.directions' then '^board\.' else '^image\.' end
       and o.output->>'state' = 'succeeded';
    if v_status = 'succeeded' and delivered = 0 then
      v_status := 'failed';
      v_error := coalesce(v_error, case when r.kind = 'identity.directions' then 'no_boards_delivered' else 'no_images_delivered' end);
    end if;
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
  if r.kind = 'identity.directions' then perform fluid_private.engine_identity_close_job(r); end if;
  return r;
end $$;

-- Person-facing functions -------------------------------------------------------

-- Whether a round can start: the shared availability check without the shared
-- worker's slot, under the engine's policy. No cost estimate.
create function public.get_identity_directions_availability(p_project_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o uuid := fluid_private.engine_identity_customer(p_project_id); p public.projects; state jsonb; logo jsonb; reason text;
  members integer; bytes bigint; policy jsonb := fluid_private.engine_identity_policy();
begin
  select * into strict p from public.projects where id = p_project_id and owner_id = o;
  state := fluid_private.identity_current_state(p_project_id);
  if p.scope = 'naming_only' then reason := 'inputs_not_ready'; end if;
  logo := fluid_private.shared_identity_selected_logo(o, p_project_id);
  if reason is null and logo is null then
    reason := case when exists (select 1 from public.logo_stage_heads h join public.logo_stage_revisions r on r.id = h.revision_id
                where h.owner_id = o and h.project_id = p_project_id and h.stage = 'concepts' and r.record#>'{payload,selected}' <> 'null'::jsonb)
              then 'logo_needs_review' else 'logo_selection_required' end;
  end if;
  if reason is null and (state#>>'{referenceSnapshot,selectedReferenceCount}')::integer > 3 then reason := 'reference_limit_exceeded'; end if;
  if reason is null then
    select count(*), coalesce(sum(publication.byte_length), 0) into members, bytes
      from jsonb_array_elements(state#>'{referenceSnapshot,selected}') entry
      join public.logo_asset_publications publication on publication.owner_id = o and publication.project_id = p_project_id
       and publication.asset_id = (entry#>>'{reference,media,assetId}')::uuid and publication.version_id = (entry#>>'{reference,media,versionId}')::uuid
       and publication.content_hash = entry#>>'{reference,media,contentHash}' and publication.mime_type = entry#>>'{reference,media,mimeType}'
       and publication.state = 'committed' and publication.purpose = 'reference_media' and publication.verification->>'status' = 'verified'
      join fluid_private.shared_identity_reference_requests registered on registered.owner_id = o and registered.project_id = p_project_id
       and registered.request_key = publication.request_key and registered.reference_id = (entry#>>'{reference,id}')::uuid
      join public.asset_versions v on (v.id, v.asset_id, v.owner_id, v.project_id, v.content_hash, v.mime_type)
        = (publication.version_id, publication.asset_id, o, p_project_id, publication.content_hash, publication.mime_type)
       and v.provenance->>'publicationId' = publication.id::text;
    if members <> (state#>>'{referenceSnapshot,selectedReferenceCount}')::integer then reason := 'references_unavailable';
    elsif bytes + coalesce((logo#>>'{preview,verification,byteLength}')::bigint, 0) > 20971520 then reason := 'reference_bytes_exceeded';
    end if;
  end if;
  if reason is not null then
    return jsonb_build_object('ownerId', o, 'projectId', p_project_id, 'status', 'unavailable', 'operation', 'identity.image',
      'requestedModel', policy->'requestedModel', 'reason', reason);
  end if;
  return jsonb_build_object('version', 3, 'spendControl', 'uncapped', 'ownerId', o, 'projectId', p_project_id, 'status', 'available',
    'operation', 'identity.image', 'requestedModel', policy->'requestedModel', 'policyIdentity', policy->'policyIdentity',
    'handlerVersion', 'identity-image-v1', 'targetCount', 3, 'maxReferenceImages', 4, 'maxReferenceBytes', 20971520,
    'estimatedCostMicrousd', null, 'sourceLogo', logo,
    'expectedProjectRevision', p.current_revision, 'expectedReferenceRevision', state#>'{referenceSnapshot,referenceRevision}',
    'expectedPreferencesRevision', coalesce(state#>'{preferences,revision}', '0'::jsonb),
    'expectedIdentityRevision', coalesce(state#>'{session,identityRevision}', '0'::jsonb), 'expectedLogoRevision', logo->'selectionRevision');
end $$;

-- Starts one round from the person's request (a version 3 intent), once per
-- request key, in one transaction: start_generation admits and charges the
-- run (kind enabled, not paused, no active round, daily limit, credits), and
-- the round's input is frozen from the person's saved work exactly as the
-- shared admission does it (ensure_shared_identity_batch). Replays return the
-- same run and batch. Returns {run, batch}.
create function public.start_identity_directions(p_project_id uuid, p_intent jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o uuid := fluid_private.engine_identity_customer(p_project_id); p public.projects; s public.identity_sessions; pref public.identity_preferences;
  existing uuid; existing_intent jsonb; refs jsonb; context jsonb; preferences jsonb; snapshot jsonb; input jsonb; manifest jsonb;
  bid uuid := gen_random_uuid(); jid uuid := gen_random_uuid(); iid uuid; logo jsonb; policy jsonb := fluid_private.engine_identity_policy();
  run public.generation_runs; minutes integer;
begin
  if fluid_private.shared_identity_intent_valid(p_intent) is not true or p_intent->'version' is distinct from '3'::jsonb then
    raise exception 'invalid_identity_generation_intent' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(o::text || ':' || p_project_id::text, 724005));
  if exists (select 1 from fluid_private.shared_identity_rejected_intents closed
              where closed.owner_id = o and closed.project_id = p_project_id and closed.request_key = p_intent->>'idempotencyKey') then
    raise exception 'identity_generation_intent_closed' using errcode = 'PT409';
  end if;
  select r.batch_id, r.intent into existing, existing_intent from fluid_private.shared_identity_requests r
   where r.owner_id = o and r.project_id = p_project_id and r.request_key = p_intent->>'idempotencyKey';
  if existing is not null then
    if existing_intent is distinct from p_intent then raise exception 'identity_generation_intent_conflict' using errcode = 'PT409'; end if;
    select g.* into run from public.generation_runs g where g.owner_id = o and g.project_id = p_project_id
       and g.kind = 'identity.directions' and g.input->>'batchId' = existing::text;
    return jsonb_build_object('replayed', true, 'run', case when run.id is null then null else to_jsonb(run) end,
      'batch', fluid_private.shared_identity_batch_state(o, p_project_id, existing));
  end if;
  select * into strict p from public.projects where id = p_project_id and owner_id = o for update;
  perform 1 from public.logo_workspaces where project_id = p.id and owner_id = o for share;
  logo := fluid_private.shared_identity_selected_logo(o, p.id);
  if logo is null or logo->'source' is distinct from p_intent->'sourceLogo' or logo->'selectionRevision' is distinct from p_intent->'expectedLogoRevision' then
    raise exception 'identity_logo_selection_conflict' using errcode = 'PT409';
  end if;
  insert into public.identity_sessions (project_id, owner_id) values (p.id, o) on conflict do nothing;
  select * into strict s from public.identity_sessions where project_id = p.id and owner_id = o for update;
  if p.current_revision <> fluid_private.identity_counter(p_intent->'expectedProjectRevision', true)
     or s.identity_revision <> fluid_private.identity_counter(p_intent->'expectedIdentityRevision')
     or coalesce(s.current_preferences_revision, 0) <> fluid_private.identity_counter(p_intent->'expectedPreferencesRevision') then
    raise exception 'identity_generation_head_conflict' using errcode = 'PT409';
  end if;
  -- A round whose workflow stopped reporting is ended (and its job closed) before the checks below.
  perform fluid_private.expire_overdue_generation_runs(o);
  if exists (select 1 from public.jobs where owner_id = o and project_id = p.id and operation = 'identity.image'
              and state in ('queued', 'running', 'cancel_requested', 'needs_reconciliation')) then
    raise exception 'identity_generation_pending' using errcode = 'PT409';
  end if;
  if public.get_identity_directions_availability(p.id)->>'status' <> 'available' then
    raise exception 'identity_generation_unavailable' using errcode = '55000';
  end if;
  if p_intent->>'acceptedPolicyIdentity' is distinct from policy->>'policyIdentity' then
    raise exception 'identity_generation_policy_changed' using errcode = 'PT409';
  end if;
  run := public.start_generation(p.id, 'identity.directions', p_intent->>'idempotencyKey',
    jsonb_build_object('version', 1, 'revision', p.current_revision, 'batchId', bid, 'jobId', jid));
  if run.input->>'batchId' is distinct from bid::text then raise exception 'idempotency_conflict' using errcode = '23505'; end if;
  refs := fluid_private.capture_identity_reference_snapshot(p.id, fluid_private.identity_counter(p_intent->'expectedReferenceRevision'));
  select pr.context into strict context from public.project_revisions pr where pr.project_id = p.id and pr.owner_id = o and pr.revision = p.current_revision;
  select * into pref from public.identity_preferences where project_id = p.id and owner_id = o and revision = s.current_preferences_revision;
  preferences := coalesce(pref.preferences, jsonb_build_object('version', 1, 'creativeLocale', coalesce(context->>'creativeLocale', 'en'),
    'notes', coalesce(context#>>'{intake,identityNotes}', ''), 'avoidanceNotes', ''));
  snapshot := jsonb_build_object('version', 2, 'logoBrief', logo->'brief', 'ownerId', o, 'projectId', p.id, 'scope', p.scope,
    'projectRevision', p.current_revision, 'context', fluid_private.identity_material_context(context), 'referenceSnapshot', refs,
    'preferencesRevision', coalesce(pref.revision, 0), 'preferences', fluid_private.identity_preferences_value(preferences), 'capturedAt', clock_timestamp(),
    'basis', fluid_private.identity_logo_basis(o, p.id, context, refs, preferences, logo->'brief'));
  insert into public.identity_input_snapshots (project_id, owner_id, project_revision, reference_revision, preferences_revision, input)
    values (p.id, o, p.current_revision, (refs->>'referenceRevision')::bigint, pref.revision, snapshot) returning id into iid;
  input := jsonb_build_object('version', 3, 'operation', 'identity.image', 'ownerId', o, 'projectId', p.id, 'batchId', bid, 'input', snapshot,
    'policyIdentity', policy->'policyIdentity', 'handlerVersion', 'identity-image-v1', 'spendControl', 'uncapped', 'textPolicy', policy->'textPolicy',
    'systemIds', jsonb_build_array(gen_random_uuid(), gen_random_uuid(), gen_random_uuid()), 'sourceLogo', logo);
  select jsonb_agg(jsonb_build_object('key', 'identity-system-v1:' || n, 'maximumCostMicrousd', 0) order by n) into manifest from generate_series(1, 3) n;
  select k.max_running_minutes into strict minutes from fluid_private.generation_kinds k where k.kind = 'identity.directions';
  -- Running under the engine from the start: the job carries the run's lease for the
  -- run's whole running time, and no shared worker is admitted to it, so none claims it.
  insert into public.jobs (id, owner_id, project_id, operation, input_revision, input_hash, input, idempotency_key, state, progress,
      lease_token, lease_expires_at, worker_id, attempts, max_attempts, reserved_cost_microusd, plan_manifest, plan_fingerprint, plan_registered_at, billing_mode)
    values (jid, o, p.id, 'identity.image', p.current_revision, encode(sha256(convert_to(input::text, 'UTF8')), 'hex'), input, 'engine:' || run.id::text,
      'running', 0, run.id, clock_timestamp() + make_interval(mins => minutes + 15), 'embel-engine', 1, 1, 0,
      manifest, encode(sha256(convert_to(manifest::text, 'UTF8')), 'hex'), clock_timestamp(), 'openai_api');
  insert into public.identity_batches (id, project_id, owner_id, job_id, input_id) values (bid, p.id, o, jid, iid);
  insert into fluid_private.shared_identity_requests values (o, p.id, p_intent->>'idempotencyKey', p_intent, bid);
  return jsonb_build_object('replayed', false, 'run', to_jsonb(run), 'batch', fluid_private.shared_identity_batch_state(o, p.id, bid));
end $$;

-- Stop for an engine round: cancels its run (the workflow stops within seconds;
-- boards already delivered stay) and shows the job as stopping. False when the
-- batch is not an engine round.
create function fluid_private.engine_identity_cancel(o uuid, p_project_id uuid, p_batch_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare run_id uuid;
begin
  select g.id into run_id from public.generation_runs g
   where g.owner_id = o and g.project_id = p_project_id and g.kind = 'identity.directions' and g.input->>'batchId' = p_batch_id::text;
  if run_id is null then return false; end if;
  perform public.cancel_generation(run_id);
  update public.jobs j set state = 'cancel_requested', cancel_requested_at = coalesce(j.cancel_requested_at, clock_timestamp())
    from public.identity_batches b
   where b.id = p_batch_id and b.owner_id = o and b.project_id = p_project_id and j.id = b.job_id and j.state = 'running';
  return true;
end $$;

create function public.cancel_identity_directions(p_project_id uuid, p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o uuid := fluid_private.engine_identity_customer(p_project_id);
begin
  if not fluid_private.engine_identity_cancel(o, p_project_id, p_batch_id) then raise exception 'identity_batch_missing' using errcode = 'P0002'; end if;
  return fluid_private.shared_identity_batch_state(o, p_project_id, p_batch_id);
end $$;

-- Closes a request whose outcome the screen could not confirm, as
-- close_shared_identity_generation_intent does: an admitted round is stopped
-- (an engine round through its run), anything else gets a tombstone so the
-- request can never be admitted later.
create function public.close_identity_directions_intent(p_project_id uuid, p_intent jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o uuid := fluid_private.engine_identity_customer(p_project_id); admitted uuid; admitted_intent jsonb; closed_intent jsonb; jid uuid; closed boolean;
begin
  if fluid_private.shared_identity_intent_valid(p_intent) is not true then raise exception 'identity_generation_intent_invalid' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(o::text || ':' || p_project_id::text, 724005));
  select r.batch_id, r.intent into admitted, admitted_intent from fluid_private.shared_identity_requests r
   where r.owner_id = o and r.project_id = p_project_id and r.request_key = p_intent->>'idempotencyKey';
  if admitted is not null then
    if admitted_intent is distinct from p_intent then raise exception 'identity_generation_intent_conflict' using errcode = 'PT409'; end if;
    if not fluid_private.engine_identity_cancel(o, p_project_id, admitted) then
      select job_id into strict jid from public.identity_batches where id = admitted and owner_id = o and project_id = p_project_id;
      perform public.request_job_cancel(jid);
    end if;
    return jsonb_build_object('status', 'admitted', 'batch', fluid_private.shared_identity_batch_state(o, p_project_id, admitted));
  end if;
  select c.intent, true into closed_intent, closed from fluid_private.shared_identity_rejected_intents c
   where c.owner_id = o and c.project_id = p_project_id and c.request_key = p_intent->>'idempotencyKey';
  if closed then
    if closed_intent is distinct from p_intent then raise exception 'identity_generation_intent_conflict' using errcode = 'PT409'; end if;
  else
    insert into fluid_private.shared_identity_rejected_intents (owner_id, project_id, request_key, intent, reason)
      values (o, p_project_id, p_intent->>'idempotencyKey', p_intent, 'explicit_cancel');
  end if;
  return jsonb_build_object('status', 'not_admitted', 'ownerId', o, 'projectId', p_project_id, 'intent', p_intent);
end $$;

-- Engine-only functions ----------------------------------------------------------

-- Opens a claimed round: checks its batch and job, keeps the job's lease for the
-- run's running time, and returns the frozen job input, the directions still to
-- make and the components of directions already saved (in order).
create function fluid_private.engine_identity_begin(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.generation_runs; j public.jobs; b public.identity_batches; minutes integer; pending jsonb; prior jsonb;
begin
  select * into r from public.generation_runs where id = p_run_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.status <> 'running' then raise exception 'run_not_running' using errcode = '55000'; end if;
  if r.kind <> 'identity.directions' or r.input->'version' is distinct from '1'::jsonb
     or not fluid_private.logo_uuid(r.input->'batchId') or not fluid_private.logo_uuid(r.input->'jobId') then
    raise exception 'invalid_run_input' using errcode = '22023';
  end if;
  select * into j from public.jobs where id = (r.input->>'jobId')::uuid and owner_id = r.owner_id and project_id = r.project_id
     and operation = 'identity.image' and idempotency_key = 'engine:' || r.id::text for update;
  select * into b from public.identity_batches where id = (r.input->>'batchId')::uuid and job_id = j.id and owner_id = r.owner_id and project_id = r.project_id;
  if j.id is null or b.id is null or j.input->>'batchId' is distinct from b.id::text or j.input->'version' is distinct from '3'::jsonb then
    raise exception 'invalid_run_input' using errcode = '22023';
  end if;
  select k.max_running_minutes into strict minutes from fluid_private.generation_kinds k where k.kind = r.kind;
  update public.jobs set lease_expires_at = greatest(lease_expires_at, clock_timestamp() + make_interval(mins => minutes + 15))
   where id = j.id and state in ('running', 'cancel_requested');
  select coalesce(jsonb_agg(n order by n), '[]'::jsonb) into pending from generate_series(1, 3) n
   where not exists (select 1 from public.generation_outputs o where o.run_id = r.id and o.output_key = 'board.' || n);
  select coalesce(jsonb_agg(sv.components order by root.step_key), '[]'::jsonb) into prior
    from public.identity_generated_roots root join public.identity_system_versions sv on sv.id = root.system_id
   where root.batch_id = b.id and root.owner_id = r.owner_id and root.project_id = r.project_id;
  return jsonb_build_object('batchId', b.id, 'jobId', j.id, 'job', j.input, 'pending', pending, 'prior', prior);
end $$;

-- Records one direction of a round (p_ordinal 1 to 3), once, in one transaction:
--  * a delivered board whose bytes are already stored at the owner's path
--    {owner}/{project}/{asset}/{version} becomes a committed asset, a system
--    version (with its application design and file), a succeeded job step and a
--    generated root, checked by fluid_private.identity_root_evidence;
--  * a direction that could not be made becomes a failed job step;
--  * a board that finished after its round stopped keeps only its usage.
-- Costs (this board and its specification tries) are estimates from usage and
-- never shown. Replays return the saved output.
create function fluid_private.engine_identity_save_board(p_run_id uuid, p_ordinal integer, p_board jsonb, p_response_id text, p_cost bigint)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.generation_runs; v_key text; existing jsonb; cost bigint := greatest(coalesce(p_cost, 0), 0); spent bigint;
  j public.jobs; b public.identity_batches; v_step text; sid uuid; succeeded boolean; code text;
  img jsonb := p_board->'image'; v_components jsonb := p_board#>'{specification,components}'; v_design jsonb := p_board#>'{specification,applicationDesign}';
  publication public.logo_asset_publications; created text; sv public.identity_system_versions; snapshot jsonb; v_result jsonb;
begin
  if p_ordinal is null or p_ordinal not between 1 and 3 or jsonb_typeof(p_board) is distinct from 'object'
     or p_board->>'state' not in ('succeeded', 'failed') or (p_response_id is not null and length(p_response_id) not between 1 and 200) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_key := 'board.' || p_ordinal;
  select * into r from public.generation_runs where id = p_run_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select o.output into existing from public.generation_outputs o where o.run_id = r.id and o.output_key = v_key;
  if existing is not null then return existing; end if;
  if r.kind <> 'identity.directions' then raise exception 'invalid_input' using errcode = '22023'; end if;
  succeeded := p_board->>'state' = 'succeeded';
  code := case when succeeded then null else p_board->>'code' end;
  if not succeeded and (code is null or code !~ '^[a-z][a-z_]{0,63}$') then raise exception 'invalid_input' using errcode = '22023'; end if;
  if succeeded and (jsonb_typeof(img) is distinct from 'object' or img->>'mimeType' is distinct from 'image/png'
     or not fluid_private.logo_uuid(img->'assetId') or not fluid_private.logo_uuid(img->'versionId')
     or coalesce(img->>'contentHash', '') !~ '^[0-9a-f]{64}$' or jsonb_typeof(img->'byteLength') is distinct from 'number'
     or (img->>'byteLength')::numeric not between 1 and 52428800
     or jsonb_typeof(v_components) is distinct from 'object' or jsonb_typeof(v_design) is distinct from 'object') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if r.status <> 'running' then
    -- The round already ended: this board is not delivered, but its usage is kept.
    if r.status in ('cancelled', 'failed') and r.finished_at > now() - interval '1 hour' then
      v_result := jsonb_build_object('state', 'discarded', 'code', coalesce(code, 'run_stopped'));
      insert into public.generation_outputs (run_id, owner_id, output_key, output, provider_response_id, cost_microusd)
        values (r.id, r.owner_id, v_key, v_result, p_response_id, cost) on conflict (run_id, output_key) do nothing;
      return v_result;
    end if;
    raise exception 'run_not_running' using errcode = '55000';
  end if;
  select * into j from public.jobs where id = (r.input->>'jobId')::uuid and owner_id = r.owner_id and project_id = r.project_id
     and operation = 'identity.image' and idempotency_key = 'engine:' || r.id::text for update;
  select * into b from public.identity_batches where id = (r.input->>'batchId')::uuid and job_id = j.id and owner_id = r.owner_id and project_id = r.project_id;
  if j.id is null or b.id is null then raise exception 'invalid_run_input' using errcode = '22023'; end if;
  v_step := 'identity-system-v1:' || p_ordinal;
  sid := (j.input#>>array['systemIds', (p_ordinal - 1)::text])::uuid;
  select coalesce(sum(o.cost_microusd), 0) + cost into spent from public.generation_outputs o
   where o.run_id = r.id and o.output_key like 'spec.' || p_ordinal || '.%';
  if succeeded then
    if v_components is distinct from fluid_private.identity_components(v_components)
       or fluid_private.identity_application_design_valid(v_design, v_components) is not true
       or fluid_private.identity_board_typography_valid(v_components) is not true then
      raise exception 'invalid_input' using errcode = '22023';
    end if;
    -- Each direction of a round is distinct, as on the shared worker.
    if exists (select 1 from public.identity_generated_roots root join public.identity_system_versions other on other.id = root.system_id
                where root.batch_id = b.id and other.components = v_components) then
      succeeded := false; code := 'duplicate_identity_direction';
    elsif exists (select 1 from public.identity_generated_roots root where root.batch_id = b.id and root.board->>'contentHash' = img->>'contentHash') then
      succeeded := false; code := 'duplicate_identity_board';
    elsif not exists (select 1 from storage.objects so where so.bucket_id = 'fluid-assets'
        and so.name = r.owner_id::text || '/' || r.project_id::text || '/' || (img->>'assetId') || '/' || (img->>'versionId')) then
      raise exception 'image_not_stored' using errcode = '55000';
    end if;
  end if;
  if succeeded then
    insert into public.logo_asset_publications (owner_id, project_id, request_key, request, asset_id, version_id, content_hash, mime_type, byte_length,
        purpose, source_receipt_id, rights_evidence_id, source_kind, state, verification, job_id, lease_token, input_revision, input_hash)
      values (r.owner_id, r.project_id, sid, jsonb_build_object('kind', 'engine', 'runId', r.id, 'outputKey', v_key),
        (img->>'assetId')::uuid, (img->>'versionId')::uuid, img->>'contentHash', 'image/png', (img->>'byteLength')::bigint,
        'brand_asset', sid, null, 'identity_system', 'staged',
        jsonb_build_object('status', 'verified', 'checkedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'contentHash', img->'contentHash', 'mimeType', 'image/png', 'byteLength', img->'byteLength'),
        null, null, j.input_revision, j.input_hash)
      returning * into publication;
    perform fluid_private.logo_commit_asset(publication);
    created := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    insert into public.identity_system_versions (id, owner_id, project_id, input_id, source, components, board, production_files, created_at, created_at_text, root_system_id)
      values (sid, r.owner_id, r.project_id, b.input_id, jsonb_build_object('kind', 'generated', 'batchId', b.id, 'jobId', j.id, 'stepKey', v_step), v_components,
        jsonb_build_object('asset', jsonb_build_object('ownerId', r.owner_id, 'projectId', r.project_id, 'assetId', publication.asset_id,
          'versionId', publication.version_id, 'contentHash', publication.content_hash, 'purpose', 'brand_asset', 'mimeType', 'image/png'),
          'depictsSystemVersionId', sid, 'staleComponents', '[]'::jsonb),
        '[]'::jsonb, created::timestamptz, created, sid)
      returning * into sv;
    insert into fluid_private.identity_system_applications (system_id, owner_id, project_id, design) values (sid, r.owner_id, r.project_id, v_design);
    insert into public.identity_system_files (system_id, slot, project_id, owner_id, component, role, asset_id, version_id)
      values (sid, 0, r.project_id, r.owner_id, null, 'board', publication.asset_id, publication.version_id);
    select i.input into strict snapshot from public.identity_input_snapshots i where i.id = b.input_id and i.owner_id = r.owner_id and i.project_id = r.project_id;
    insert into public.job_steps (job_id, owner_id, project_id, step_key, request_key, state, reserved_cost_microusd, actual_cost_microusd, provider_request_id, output, completed_at)
      values (j.id, r.owner_id, r.project_id, v_step, 'engine:' || r.id::text || ':' || v_key, 'succeeded', 0, spent, p_response_id,
        jsonb_build_object('identity', jsonb_build_object('version', 1, 'operation', 'identity.image', 'ownerId', r.owner_id, 'projectId', r.project_id,
          'batchId', b.id, 'jobId', j.id, 'stepKey', v_step, 'targetCount', 3, 'input', snapshot, 'systems', jsonb_build_array(fluid_private.identity_system_json(sv)))),
        clock_timestamp());
    insert into public.identity_generated_roots (system_id, project_id, owner_id, batch_id, job_id, step_key, output_index, board)
      values (sid, r.project_id, r.owner_id, b.id, j.id, v_step, 0, sv.board->'asset');
    -- The same check every reader applies; anything inconsistent rolls the board back.
    perform fluid_private.identity_root_evidence(sv);
    v_result := jsonb_build_object('state', 'succeeded', 'systemId', sid);
  else
    insert into public.job_steps (job_id, owner_id, project_id, step_key, request_key, state, reserved_cost_microusd, actual_cost_microusd, provider_request_id, output, completed_at)
      values (j.id, r.owner_id, r.project_id, v_step, 'engine:' || r.id::text || ':' || v_key, 'failed', 0, spent, p_response_id,
        jsonb_build_object('error', code), clock_timestamp());
    v_result := jsonb_build_object('state', 'failed', 'code', code);
  end if;
  update public.jobs set actual_cost_microusd = actual_cost_microusd + spent,
      progress = least(99, (select count(*)::integer * 33 from public.job_steps s where s.job_id = j.id))
   where id = j.id;
  insert into public.generation_outputs (run_id, owner_id, output_key, output, provider_response_id, cost_microusd)
    values (r.id, r.owner_id, v_key, v_result, p_response_id, cost);
  return v_result;
end $$;

-- Grants -------------------------------------------------------------------------
-- Every function here, new or replaced, gets explicit privileges: a replaced function keeps
-- its old ACL, and 20261110160000_harden_database_api made new functions private by default.
-- finish_generation_run stays private: only the engine functions that own it call it.
revoke all on function fluid_private.finish_generation_run(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function fluid_private.engine_identity_policy(), fluid_private.engine_identity_customer(uuid),
  fluid_private.engine_identity_close_job(public.generation_runs), fluid_private.engine_identity_cancel(uuid, uuid, uuid),
  fluid_private.engine_identity_begin(uuid), fluid_private.engine_identity_save_board(uuid, integer, jsonb, text, bigint),
  public.get_identity_directions_availability(uuid), public.start_identity_directions(uuid, jsonb),
  public.cancel_identity_directions(uuid, uuid), public.close_identity_directions_intent(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.get_identity_directions_availability(uuid), public.start_identity_directions(uuid, jsonb),
  public.cancel_identity_directions(uuid, uuid), public.close_identity_directions_intent(uuid, jsonb) to authenticated;
grant execute on function fluid_private.engine_identity_begin(uuid), fluid_private.engine_identity_save_board(uuid, integer, jsonb, text, bigint) to embel_engine;
commit;
