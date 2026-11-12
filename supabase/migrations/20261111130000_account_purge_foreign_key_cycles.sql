-- Account deletion failed for anyone who had chosen a brand name
-- (docs/account-deletion.md). public.account_deletion_purge deletes one table
-- at a time and retries a table refused by a foreign key after its children are
-- gone. Some tables refer to each other in a loop, so neither side could go
-- first and the purge stopped with account_purge_blocked:
--
--   naming_sessions.current_selection_id -> name_selections -> name_candidates -> naming_sessions
--   name_candidates.transform_id -> name_transforms -> name_candidates (parent candidate)
--   identity_sessions.current_preferences_revision -> identity_preferences -> identity_sessions
--   identity_sessions.current_selection_id -> identity_selections -> ... -> identity_sessions
--
-- Clearing the session pointers first is not an option: the project content
-- guard refuses that UPDATE for a project in the trash, and name candidates
-- are immutable history.
--
-- What this changes:
--   1. The four foreign keys that close those loops become DEFERRABLE INITIALLY
--      IMMEDIATE. Outside the purge nothing changes: they are still checked at
--      the end of every statement.
--   2. account_deletion_purge defers all deferrable constraints while it
--      deletes and sets them back to IMMEDIATE before it returns, which runs
--      every postponed check at that point: a purge that left a dangling
--      reference fails and rolls back instead of committing it. The history
--      trigger exception (fluid_private.account_purge_transactions) is
--      unchanged.
--   3. The migration fails if any loop made only of non-deferrable foreign keys
--      remains between tables of the public and fluid_private schemas.
--
-- Rollback: recreate public.account_deletion_purge from
-- 20261110200000_account_deletion_and_export.sql (the same body without the two
-- SET CONSTRAINTS statements), then for each constraint below run
-- "alter table ... alter constraint ... not deferrable".

begin;

-- 1. Deferrable loop-closing foreign keys -------------------------------------

alter table public.naming_sessions
  alter constraint naming_sessions_current_selection_id_owner_id_project_id_fkey deferrable initially immediate;
alter table public.name_candidates
  alter constraint name_candidates_transform_id_owner_id_project_id_fkey deferrable initially immediate;
alter table public.identity_sessions
  alter constraint identity_sessions_current_selection_id_identity_revision_p_fkey deferrable initially immediate;
alter table public.identity_sessions
  alter constraint identity_sessions_project_id_owner_id_current_preferences__fkey deferrable initially immediate;

-- 2. Purge --------------------------------------------------------------------

create or replace function public.account_deletion_purge(p_owner uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r fluid_private.account_deletion_receipts; t record; n bigint; m bigint; total bigint := 0;
  pass integer := 0; blocked text; progressed boolean; rows_sql text; tables jsonb := '{}'::jsonb;
begin
  if p_owner is null then raise exception 'invalid_input' using errcode = '22023'; end if;
  select * into r from fluid_private.account_deletion_receipts where pending_owner_id = p_owner for update;
  if not found then raise exception 'deletion_not_started' using errcode = 'P0002'; end if;
  -- The same lock start_generation takes: no run can be admitted mid-purge.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('embel_generation:' || p_owner::text, 0));

  insert into fluid_private.deleted_account_usage (receipt_id, source, kind, status, credits, cost_microusd, occurred_at)
    select r.id, 'credit_entry', e.kind, null, e.delta, 0, e.created_at from public.credit_entries e where e.owner_id = p_owner;
  insert into fluid_private.deleted_account_usage (receipt_id, source, kind, status, credits, cost_microusd, occurred_at, finished_at)
    select r.id, 'generation_run', g.kind, g.status, g.credits,
           coalesce((select sum(o.cost_microusd) from public.generation_outputs o where o.run_id = g.id), 0), g.created_at, g.finished_at
      from public.generation_runs g where g.owner_id = p_owner;
  insert into fluid_private.deleted_account_usage (receipt_id, source, kind, status, credits, cost_microusd, occurred_at, finished_at)
    select r.id, 'legacy_job', pg_catalog.left(j.operation, 100), j.state, null, j.actual_cost_microusd, j.created_at, j.finished_at
      from public.jobs j where j.owner_id = p_owner and j.actual_cost_microusd > 0;

  perform pg_catalog.set_config('embel.account_purge', p_owner::text, true);
  insert into fluid_private.account_purge_transactions (xact, subject_id) values (pg_catalog.pg_current_xact_id(), p_owner);
  -- Tables that refer to each other in a loop can only be emptied with the
  -- loop's deferrable foreign key checked at the end; SET CONSTRAINTS ALL
  -- IMMEDIATE below runs those checks before the purge returns.
  set constraints all deferred;

  -- Every table in the app's schemas with an owner column, in passes: a delete
  -- refused by a foreign key waits for the next pass, after its children are gone.
  loop
    pass := pass + 1; blocked := null; progressed := false;
    for t in
      select c.oid::regclass as rel,
             pg_catalog.string_agg(pg_catalog.format('%I = $1', a.attname), ' or ' order by a.attname) as owner_filter
        from pg_catalog.pg_class c
        join pg_catalog.pg_attribute a on a.attrelid = c.oid
       where c.relnamespace in ('public'::regnamespace, 'fluid_private'::regnamespace)
         and c.relkind in ('r', 'p') and not c.relispartition
         and a.attname in ('owner_id', 'auth_user_id') and a.atttypid = 'uuid'::regtype and not a.attisdropped
       group by c.oid
       order by c.oid::regclass::text
    loop
      rows_sql := pg_catalog.format('select * from %s where %s', t.rel, t.owner_filter);
      begin
        n := fluid_private.account_purge_dependents(t.rel, rows_sql, p_owner, 1);
        execute pg_catalog.format('delete from %s where %s', t.rel, t.owner_filter) using p_owner;
        get diagnostics m = row_count;
        n := n + m;
        if n > 0 then
          progressed := true; total := total + n;
          tables := tables || jsonb_build_object(t.rel::text, coalesce((tables ->> t.rel::text)::bigint, 0) + n);
        end if;
      exception when foreign_key_violation then
        blocked := t.rel::text;
      end;
    end loop;
    exit when blocked is null;
    if not progressed or pass >= 25 then
      raise exception 'account_purge_blocked' using errcode = '55000', detail = blocked;
    end if;
  end loop;

  set constraints all immediate;
  delete from fluid_private.account_purge_transactions where xact = pg_catalog.pg_current_xact_id();
  perform pg_catalog.set_config('embel.account_purge', '', true);

  update fluid_private.account_deletion_receipts
     set state = case when state = 'completed' then state else 'data_deleted' end,
         data_deleted_at = coalesce(data_deleted_at, clock_timestamp()), deleted_rows = deleted_rows + total
   where id = r.id returning * into r;
  return jsonb_build_object('receiptId', r.id, 'deletedRows', total, 'tables', tables);
end $$;

revoke all on function public.account_deletion_purge(uuid) from public, anon, authenticated;
grant execute on function public.account_deletion_purge(uuid) to service_role;

-- 3. No loop of non-deferrable foreign keys remains ---------------------------

do $$
declare loops text;
begin
  with recursive edge as (
    select distinct con.conrelid as child, con.confrelid as parent
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
     where con.contype = 'f' and not con.condeferrable and con.conrelid <> con.confrelid
       and c.relnamespace in ('public'::regnamespace, 'fluid_private'::regnamespace)
  ), walk(start, cur, path) as (
    select e.child, e.parent, array[e.child, e.parent] from edge e
    union all
    select w.start, e.parent, w.path || e.parent
      from walk w join edge e on e.child = w.cur
     where w.cur <> w.start and not (e.parent = any (w.path[2:]))
  )
  select pg_catalog.string_agg(distinct w.start::regclass::text, ', ') into loops
    from walk w where w.cur = w.start;
  if loops is not null then
    raise exception 'account purge: tables in a loop of non-deferrable foreign keys: %', loops;
  end if;
end $$;

commit;
