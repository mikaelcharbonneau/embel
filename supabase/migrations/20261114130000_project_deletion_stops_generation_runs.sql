-- Deleting a project now stops its AI work (docs/state-machines.md, R4).
--
-- request_project_deletion predates the generation engine: it stops the old `jobs` rows and
-- never looked at generation_runs. A project deleted while a Strategy, Naming or Logo run
-- was working showed as deleted at once while the workflow kept making paid calls; a
-- Strategy run even finished and kept its credit.
--
-- What this changes: one trigger on public.projects. When a project is marked for deletion
-- (deletion_requested_at or deleted_at goes from empty to set, by any path), each of its
-- active runs is treated exactly as cancel_generation treats it:
--   * queued with no workflow yet: ended now as cancelled, credits returned;
--   * otherwise: cancel_requested_at is set, and the workflow stops at its next check
--     (every few seconds) and ends the run itself, returning what it did not deliver.
-- Finished runs and other projects' runs are not touched. Restoring the project does not
-- withdraw the stop, the same as for old jobs.
--
-- Locks are NOWAIT, like every other lock a deletion request takes: if the engine is saving
-- to one of these runs at that instant, the request fails with lock_not_available, which
-- request_project_deletion already reports as project_deletion_retry and the web app
-- already retries. So this adds no way for a deletion and a paid step to wait on each other.
--
-- Nothing else changes: project_deletion_state, request_project_deletion and
-- restore_project_deletion keep their bodies.
--
-- Rollback: drop trigger project_deletion_stops_generation on public.projects;
--           drop function fluid_private.stop_project_generation_runs();

begin;

create function fluid_private.stop_project_generation_runs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.generation_runs;
begin
  for r in
    select * from public.generation_runs g
     where g.project_id = new.id and g.status in ('queued', 'running')
     order by g.id for update nowait
  loop
    if r.status = 'queued' and r.workflow_run_id is null then
      perform fluid_private.finish_generation_run(r.id, 'cancelled', 'cancelled');
    else
      update public.generation_runs set cancel_requested_at = coalesce(cancel_requested_at, now()) where id = r.id;
    end if;
  end loop;
  return null;
end $$;

revoke all on function fluid_private.stop_project_generation_runs() from public;

create trigger project_deletion_stops_generation
  after update of deletion_requested_at, deleted_at on public.projects
  for each row
  when ((old.deletion_requested_at is null and new.deletion_requested_at is not null)
     or (old.deleted_at is null and new.deleted_at is not null))
  execute function fluid_private.stop_project_generation_runs();

commit;
