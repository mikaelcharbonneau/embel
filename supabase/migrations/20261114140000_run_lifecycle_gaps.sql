-- Generation run lifecycle: three gaps closed (docs/state-machines.md, R1 and R6).
--
-- 1. cancel_generation no longer marks a finished run. It used to set cancel_requested_at on
--    any run of the caller, so a run that had already succeeded could read as "stop asked".
--    Now the stop request is recorded only on a run that is still queued or running; a
--    finished run is returned exactly as it is. Everything else is unchanged: a queued run
--    with no workflow ends at once with its refund, and the caller's overdue runs are ended.
--
-- 2. finish_generation_run ends a Creative directions round as succeeded once all three of
--    its boards were delivered, whatever ending was asked for. Until now a Stop (or the time
--    limit) that arrived after the third board ended the run as cancelled (or failed) while
--    its job closed as succeeded and every credit was kept: the run said "stopped", the
--    ledger and the step said "delivered in full". Credits are unchanged (three boards always
--    kept every credit); only the run's status and error code now agree with them. Rounds
--    with fewer than three boards, and every other kind, end exactly as before.
--
-- 3. A CHECK ties finished_at to the status: empty while a run is queued or running, set once
--    it has succeeded, failed or been cancelled. finish_generation_run is the only writer of
--    an ending and always sets both, so no existing row should break the rule. In case one
--    does (a row edited by hand), the two statements before the constraint repair it first,
--    so the constraint cannot fail on existing rows: an ended run without a time gets the
--    best time its row knows (when it started, else when it was created), and a working run
--    with a time loses it. Statuses, credits and ledger entries are never touched.
--
-- Not in this migration: a scheduled sweep of overdue runs for every owner. The app has no
-- scheduled route to call it from (vercel.json has no crons), and adding one is a job system
-- of its own; expire_overdue_generation_runs still runs when that owner starts or stops work.
--
-- Rollback:
--   alter table public.generation_runs drop constraint generation_runs_finished_at_check;
--   re-run public.cancel_generation from 20261110190000_baseline.sql (with the revoke and
--   grant below) and fluid_private.finish_generation_run from
--   20261110230000_launch_credit_amounts.sql (with its revoke).

begin;

create or replace function public.cancel_generation(p_run_id uuid) returns public.generation_runs
language plpgsql security definer set search_path = '' as $$
declare o uuid := auth.uid(); r public.generation_runs;
begin
  if o is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  update public.generation_runs set cancel_requested_at = coalesce(cancel_requested_at, now())
   where id = p_run_id and owner_id = o and status in ('queued', 'running') returning * into r;
  if not found then
    -- A finished run has nothing left to stop: it is returned as it is.
    select * into r from public.generation_runs where id = p_run_id and owner_id = o;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  -- Nothing has started yet, so it can end right away.
  if r.status = 'queued' and r.workflow_run_id is null then
    r := fluid_private.finish_generation_run(r.id, 'cancelled', 'cancelled');
  else
    perform fluid_private.expire_overdue_generation_runs(o);
    select * into strict r from public.generation_runs where id = p_run_id;
  end if;
  return r;
end $$;

revoke all on function public.cancel_generation(uuid) from public, anon;
grant execute on function public.cancel_generation(uuid) to authenticated;

create or replace function fluid_private.finish_generation_run(p_run_id uuid, p_status text, p_error text)
returns public.generation_runs
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
    -- A Creative directions round is its 3 boards. With all of them delivered it succeeded,
    -- even when a Stop or the time limit arrived after the last one: the job closes as
    -- succeeded and every credit is kept (below), so the run says the same.
    if r.kind = 'identity.directions' and delivered >= 3 and v_status <> 'succeeded' then
      v_status := 'succeeded';
      v_error := null;
    end if;
  elsif r.kind = 'naming.generate' and v_status = 'cancelled' then
    -- Names already in the person's feed count as delivered.
    select count(*) into delivered from public.name_candidates c
     where c.project_id = r.project_id and c.owner_id = r.owner_id and c.origin->>'runId' = r.id::text;
  end if;
  update public.generation_runs
     set status = v_status, error_code = case when v_status = 'succeeded' then null else v_error end, finished_at = now()
   where id = r.id returning * into r;
  -- A Creative directions round has 3 boards and keeps its credits in proportion to the boards delivered.
  kept := case when r.kind = 'identity.directions' then least(delivered * r.credits / 3, r.credits)
               when images then least(delivered, r.credits)
               when v_status = 'succeeded' then r.credits
               when r.kind = 'naming.generate' and v_status = 'cancelled' and delivered > 0 then r.credits
               else 0 end;
  if r.credits - kept > 0 then
    insert into public.credit_entries (owner_id, delta, kind, run_id, note)
      values (r.owner_id, r.credits - kept, 'refund', r.id, case when kept > 0 then 'Images that were not delivered' else 'Generation did not finish' end)
      on conflict (run_id) where kind = 'refund' do nothing;
  end if;
  if r.kind = 'identity.directions' then perform fluid_private.engine_identity_close_job(r); end if;
  return r;
end $$;

revoke all on function fluid_private.finish_generation_run(uuid, text, text) from public;

-- Repairs first, so the constraint below cannot fail on a row that already exists.
update public.generation_runs set finished_at = coalesce(started_at, created_at)
 where status in ('succeeded', 'failed', 'cancelled') and finished_at is null;
update public.generation_runs set finished_at = null
 where status in ('queued', 'running') and finished_at is not null;

alter table public.generation_runs add constraint generation_runs_finished_at_check
  check ((finished_at is null) = (status in ('queued', 'running')));

commit;
