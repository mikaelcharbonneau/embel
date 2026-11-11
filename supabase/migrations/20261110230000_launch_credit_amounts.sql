-- Launch credit amounts (owner decision, November 10, 2026): Free / Pro / Studio at
-- $0 / $7.99 / $27.99 a month with 30 / 150 / 500 monthly credits, and Creative directions
-- raised from 3 to 6 credits so that even a month spent only on directions stays within
-- what the plan's price covers.
--
-- Image steps keep credit only for what they delivered. Until now that was one credit per
-- delivered image or board, which matched 3 credits for 3 boards. At 6 credits a fully
-- delivered round would have refunded 3, so a Creative directions round now keeps
-- delivered x credits / 3 (2 per board at 6 credits). Runs admitted at the old price of 3
-- still keep 1 per board, because the rule uses each run's own recorded credits.
-- Nothing else in finish_generation_run changes.
--
-- Monthly allowances apply from each account's next credit period; a period already
-- granted is not changed.
--
-- Rollback: set the plans back to 30 / 300 / 1000 and identity.directions back to 3
-- credits, and re-run finish_generation_run from 20261110220000_naming_keeps_credit_on_stop.sql.

begin;

update fluid_private.plans set monthly_credits = 30 where id = 'free';
update fluid_private.plans set monthly_credits = 150 where id = 'pro';
update fluid_private.plans set monthly_credits = 500 where id = 'studio';
update fluid_private.generation_kinds set credits = 6 where kind = 'identity.directions';

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

commit;
