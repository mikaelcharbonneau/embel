-- Scheduled sweep of overdue generation runs, for every owner (docs/state-machines.md, R1;
-- owner decision of November 14, 2026).
--
-- Until now an overdue run was ended only when its own owner started or cancelled something
-- (expire_overdue_generation_runs). A person who closed the page kept a stuck run and its
-- charged credits until they came back. This adds one function that applies the same two
-- rules to every owner, for the web app's scheduled route (GET /api/maintenance/expire-runs,
-- a Vercel cron every 10 minutes):
--   queued, no workflow, admitted more than 10 minutes ago   -> failed, start_failed
--   running longer than the kind's max_running_minutes       -> failed, run_timed_out
-- Each run ends through finish_generation_run, so credits come back by the normal rule (and a
-- Creative directions round that delivered its three boards still ends as succeeded).
--
-- Locks: the overdue rows are locked as they are read, and a row another transaction holds
-- (a workflow finishing that run right now) is skipped, not waited for; the next sweep sees
-- whatever is left. A run that changed before its lock was taken is checked again by
-- Postgres and dropped if it is no longer overdue. Oldest first, at most p_limit (200) per
-- call, so one call stays short. A run whose ending raises an error is left as it is and
-- counted as failed, so one broken run cannot hold back everybody else's refunds.
--
-- It never starts work and does not read engine_settings.paused: ending and refunding are
-- safe while generation is paused.
--
-- Callable by the engine login only (embel_engine), like every fluid_private.engine_* function.
-- The existing per-owner function and its callers are unchanged.
--
-- Rollback:
--   drop function fluid_private.engine_expire_overdue_runs(integer);
--   (and remove the cron entry from vercel.json; without the function the route answers 500
--   and changes nothing).

begin;

create function fluid_private.engine_expire_overdue_runs(p_limit integer default 200) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare overdue record; ended integer := 0; failed integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  for overdue in
    select r.id, case when r.status = 'queued' then 'start_failed' else 'run_timed_out' end as code
      from public.generation_runs r join fluid_private.generation_kinds k on k.kind = r.kind
     where (r.status = 'queued' and r.workflow_run_id is null and r.created_at < now() - interval '10 minutes')
        or (r.status = 'running' and r.started_at < now() - make_interval(mins => k.max_running_minutes))
     order by r.created_at, r.id
     limit p_limit
       for update of r skip locked
  loop
    begin
      perform fluid_private.finish_generation_run(overdue.id, 'failed', overdue.code);
      ended := ended + 1;
    exception when others then
      failed := failed + 1;
      raise warning 'engine_expire_overdue_runs: run % was not ended (%)', overdue.id, sqlstate;
    end;
  end loop;
  return jsonb_build_object('ended', ended, 'failed', failed);
end $$;

revoke all on function fluid_private.engine_expire_overdue_runs(integer) from public, anon, authenticated, service_role;
grant execute on function fluid_private.engine_expire_overdue_runs(integer) to embel_engine;

commit;
