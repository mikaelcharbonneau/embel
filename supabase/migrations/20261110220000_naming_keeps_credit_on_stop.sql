-- A stopped Naming run that already delivered names keeps its credit (owner decision,
-- November 10, 2026). Until now finish_generation_run kept a text run's credit only when the
-- run succeeded, so pressing Stop after the first names appeared refunded the credit while
-- the person kept the names. Image steps already keep the credit for what they delivered.
--
-- The rule: a cancelled naming.generate run keeps its credit when at least one name from
-- that run reached the person's name feed (public.name_candidates rows whose origin carries
-- the run id). A cancelled run with no names, and a failed run, are refunded as before.
-- Nothing else in the function changes.
--
-- Rollback: re-run the finish_generation_run definition from 20261110190000_baseline.sql.

begin;

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
  elsif r.kind = 'naming.generate' and v_status = 'cancelled' then
    -- Names already in the person's feed count as delivered.
    select count(*) into delivered from public.name_candidates c
     where c.project_id = r.project_id and c.owner_id = r.owner_id and c.origin->>'runId' = r.id::text;
  end if;
  update public.generation_runs
     set status = v_status, error_code = case when v_status = 'succeeded' then null else v_error end, finished_at = now()
   where id = r.id returning * into r;
  kept := case when images then least(delivered, r.credits)
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

commit;
