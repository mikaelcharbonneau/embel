-- Account deletion and data export (docs/account-deletion.md; architecture review
-- issue M9, execution plan task B5).
--
-- What this adds:
--   1. A purge exception for the history triggers. Every row trigger that
--      refuses DELETE is given a WHEN condition: it still fires for every
--      DELETE except inside a transaction that public.account_deletion_purge
--      opened for itself (a row in fluid_private.account_purge_transactions
--      keyed by that transaction's own id). Triggers that also fire on INSERT
--      or UPDATE are split: the original name keeps those events unchanged and
--      a "<name>_on_delete" trigger carries DELETE with the condition. Trigger
--      function bodies are not touched, so their reviewed hashes still hold.
--   2. Server-only functions (service_role) that delete one person's rows,
--      list their Storage objects, finish the deletion after the Auth user is
--      gone, and list orphaned Storage objects.
--   3. A minimal deletion receipt and anonymised usage records kept for
--      accounting, with no user id and no content.
--   4. A per-account export rate limit and the list of tables the export reads.
--
-- Foreign keys to auth.users are left as they are. The tables without an
-- "on delete" rule keep refusing a raw Auth deletion while the person still has
-- data, so an account can only disappear through the purge (which removes the
-- rows first) and never half-way through cascades into immutable history.
--
-- Rollback: drop the functions and tables created below, then recreate each
-- guarded trigger from its previous pg_get_triggerdef (drop "<name>_on_delete"
-- and add DELETE back to "<name>"; for DELETE-only triggers, drop the WHEN).

begin;

-- 1. Purge transactions and the trigger guard ---------------------------------

create table fluid_private.account_purge_transactions (
  xact xid8 primary key,
  subject_id uuid not null,
  started_at timestamptz not null default clock_timestamp()
);
alter table fluid_private.account_purge_transactions enable row level security;
revoke all on fluid_private.account_purge_transactions from public, anon, authenticated, service_role;

-- True only inside the purge's own transaction. Never granted: a trigger
-- condition evaluated for an API role reaches this call only if that role set
-- the purge setting itself, and then fails with a permission error.
create function fluid_private.account_purge_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from fluid_private.account_purge_transactions t
                  where t.xact = pg_catalog.pg_current_xact_id_if_assigned());
$$;
revoke all on function fluid_private.account_purge_active() from public, anon, authenticated, service_role;

-- The reviewed list of trigger functions that refuse DELETE on rows a person
-- owns (production catalog, November 10, 2026). Triggers using a function that
-- is missing here are left alone. The check after the loop fails the migration
-- if any row trigger on these schemas fires on DELETE without the condition and
-- with an unreviewed function, so a missed blocker is caught when applied.
do $$
declare
  guard constant text := '(CASE WHEN COALESCE(pg_catalog.current_setting(''embel.account_purge'', true), '''') = '''' THEN true ELSE NOT fluid_private.account_purge_active() END)';
  names constant text[] := array[
    'fluid_private.prevent_history_change()',
    'fluid_private.guard_project_content_lifecycle()',
    'fluid_private.home_attachment_immutable()',
    'fluid_private.logo_direction_publication_immutable()',
    'fluid_private.logo_export_publication_immutable()',
    'fluid_private.api_text_admission_immutable()',
    'fluid_private.protect_api_text_dispatch()',
    'fluid_private.shared_job_admission_immutable()',
    'fluid_private.shared_service_actor_classification()',
    'fluid_private.record_logo_absent_publication_adjudication()',
    'fluid_private.record_logo_publication_failure_adjudication()',
    -- Present in the repository's migration history but not on production.
    'fluid_private.naming_brain_protect_run()'];
  safe constant text[] := array[
    'fluid_private.invalidate_logo_subscription_readiness()',
    'fluid_private.invalidate_logo_worker_readiness()'];
  t record; timing text; events text[]; unreviewed text;
begin
  for t in
    select tg.oid, tg.tgrelid::regclass as rel, tg.tgname, tg.tgtype, tg.tgfoid::regprocedure as fn, tg.tgqual, tg.tgnargs,
           tg.tgconstraint, tg.tgenabled, tg.tgoldtable, tg.tgnewtable,
           (select pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ', ' order by k.ord)
              from unnest(tg.tgattr::int2[]) with ordinality k(attnum, ord)
              join pg_catalog.pg_attribute a on a.attrelid = tg.tgrelid and a.attnum = k.attnum) as update_columns
      from pg_catalog.pg_trigger tg
      join pg_catalog.pg_class c on c.oid = tg.tgrelid
     where not tg.tgisinternal
       and c.relnamespace in ('public'::regnamespace, 'fluid_private'::regnamespace)
       and (tg.tgtype & 1) = 1 and (tg.tgtype & 8) = 8
       and tg.tgfoid::regprocedure::text = any (names)
     order by tg.tgrelid::regclass::text, tg.tgname
  loop
    -- Only the plain shape seen on production is rewritten; anything else stops the migration.
    if t.tgqual is not null or t.tgnargs <> 0 or t.tgconstraint <> 0 or t.tgenabled <> 'O'
       or t.tgoldtable is not null or t.tgnewtable is not null or (t.tgtype & 64) = 64 then
      raise exception 'account purge guard: unexpected trigger shape %.%', t.rel, t.tgname;
    end if;
    timing := case when (t.tgtype & 2) = 2 then 'BEFORE' else 'AFTER' end;
    events := array[]::text[];
    if (t.tgtype & 4) = 4 then events := events || 'INSERT'::text; end if;
    if (t.tgtype & 16) = 16 then
      events := events || (case when t.update_columns is null then 'UPDATE' else 'UPDATE OF ' || t.update_columns end);
    end if;
    execute pg_catalog.format('drop trigger %I on %s', t.tgname, t.rel);
    if pg_catalog.cardinality(events) > 0 then
      execute pg_catalog.format('create trigger %I %s %s on %s for each row execute function %s',
        t.tgname, timing, pg_catalog.array_to_string(events, ' OR '), t.rel, t.fn);
      execute pg_catalog.format('create trigger %I %s DELETE on %s for each row when %s execute function %s',
        t.tgname || '_on_delete', timing, t.rel, guard, t.fn);
    else
      execute pg_catalog.format('create trigger %I %s DELETE on %s for each row when %s execute function %s',
        t.tgname, timing, t.rel, guard, t.fn);
    end if;
  end loop;

  select pg_catalog.string_agg(x.tgrelid::regclass::text || ' ' || x.tgname || ' ' || x.tgfoid::regprocedure::text, ', ')
    into unreviewed
    from pg_catalog.pg_trigger x
    join pg_catalog.pg_class c on c.oid = x.tgrelid
   where not x.tgisinternal
     and c.relnamespace in ('public'::regnamespace, 'fluid_private'::regnamespace)
     and (x.tgtype & 1) = 1      -- row level
     and (x.tgtype & 8) = 8      -- fires on DELETE
     and not (x.tgfoid::regprocedure::text = any (safe)
              or (x.tgfoid::regprocedure::text = any (names)
                  and pg_catalog.pg_get_triggerdef(x.oid) like '%account_purge_active()%'));
  if unreviewed is not null then
    raise exception 'account purge guard: unreviewed DELETE triggers: %', unreviewed;
  end if;
end $$;

-- 2. Receipts and retained usage -----------------------------------------------

-- One receipt per deleted account. subject_hash is sha256 of a fixed prefix and
-- the account id: support can confirm a deletion when given the id, but the
-- receipt never names the person. pending_owner_id exists only while the
-- deletion is unfinished, so an interrupted deletion can be resumed; it is
-- cleared once the Auth user is gone.
create table fluid_private.account_deletion_receipts (
  id uuid primary key default gen_random_uuid(),
  subject_hash text not null unique check (subject_hash ~ '^[0-9a-f]{64}$'),
  pending_owner_id uuid unique,
  state text not null default 'started' check (state in ('started', 'data_deleted', 'completed')),
  attempts integer not null default 1 check (attempts > 0),
  requested_at timestamptz not null default clock_timestamp(),
  data_deleted_at timestamptz,
  completed_at timestamptz,
  deleted_rows bigint not null default 0 check (deleted_rows >= 0),
  deleted_files bigint not null default 0 check (deleted_files >= 0),
  check ((state = 'completed') = (pending_owner_id is null)),
  check (state = 'started' or data_deleted_at is not null),
  check (state <> 'completed' or completed_at is not null)
);

-- Amounts and times kept for accounting after the person is gone: credits
-- granted and spent, what each generation charged and cost the provider, and
-- the older system's recorded provider cost. No user id, project, input,
-- output, file or free text.
create table fluid_private.deleted_account_usage (
  id bigint generated always as identity primary key,
  receipt_id uuid not null references fluid_private.account_deletion_receipts(id),
  source text not null check (source in ('credit_entry', 'generation_run', 'legacy_job')),
  kind text not null check (length(kind) between 1 and 100),
  status text check (status is null or length(status) <= 40),
  credits integer,
  cost_microusd bigint not null default 0 check (cost_microusd >= 0),
  occurred_at timestamptz not null,
  finished_at timestamptz
);
create index deleted_account_usage_receipt on fluid_private.deleted_account_usage (receipt_id);
create index deleted_account_usage_time on fluid_private.deleted_account_usage (occurred_at);

alter table fluid_private.account_deletion_receipts enable row level security;
alter table fluid_private.deleted_account_usage enable row level security;
revoke all on fluid_private.account_deletion_receipts, fluid_private.deleted_account_usage
  from public, anon, authenticated, service_role;

create function fluid_private.account_subject_hash(p_owner uuid) returns text
language sql immutable set search_path = '' as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('embel.account-deletion.v1:' || p_owner::text, 'UTF8')), 'hex');
$$;
revoke all on function fluid_private.account_subject_hash(uuid) from public, anon, authenticated, service_role;

-- 3. Purge -------------------------------------------------------------------

-- Deletes the rows of tables without an owner column that reference p_parent
-- rows selected by p_parent_rows (SQL text using $1 as the owner), deepest
-- first. Tables with an owner column are left to the main purge loop.
create function fluid_private.account_purge_dependents(p_parent regclass, p_parent_rows text, p_owner uuid, p_depth integer)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare fk record; child_cols text; parent_cols text; child_rows text; total bigint := 0; n bigint;
begin
  if p_depth > 4 then raise exception 'account_purge_too_deep' using errcode = '55000'; end if;
  for fk in
    select con.conrelid::regclass as child, con.conrelid as child_oid, con.conkey, con.confkey
      from pg_catalog.pg_constraint con
     where con.contype = 'f' and con.confrelid = p_parent and con.conrelid <> p_parent
       and not exists (select 1 from pg_catalog.pg_attribute a
                        where a.attrelid = con.conrelid and a.attname in ('owner_id', 'auth_user_id')
                          and a.atttypid = 'uuid'::regtype and not a.attisdropped)
     order by con.conrelid::regclass::text, con.conname
  loop
    select pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ',' order by k.ord) into child_cols
      from unnest(fk.conkey) with ordinality k(attnum, ord)
      join pg_catalog.pg_attribute a on a.attrelid = fk.child_oid and a.attnum = k.attnum;
    select pg_catalog.string_agg(pg_catalog.quote_ident(a.attname), ',' order by k.ord) into parent_cols
      from unnest(fk.confkey) with ordinality k(attnum, ord)
      join pg_catalog.pg_attribute a on a.attrelid = p_parent and a.attnum = k.attnum;
    child_rows := pg_catalog.format('select * from %s where (%s) in (select %s from (%s) parent)', fk.child, child_cols, parent_cols, p_parent_rows);
    total := total + fluid_private.account_purge_dependents(fk.child, child_rows, p_owner, p_depth + 1);
    execute pg_catalog.format('delete from %s where (%s) in (select %s from (%s) parent)', fk.child, child_cols, parent_cols, p_parent_rows) using p_owner;
    get diagnostics n = row_count;
    total := total + n;
  end loop;
  return total;
end $$;
revoke all on function fluid_private.account_purge_dependents(regclass, text, uuid, integer) from public, anon, authenticated, service_role;

-- Starts (or resumes) one account deletion. Server role only: the web server
-- calls it after it has verified the signed-in person, with that person's id.
create function public.account_deletion_begin(p_owner uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r fluid_private.account_deletion_receipts;
begin
  if p_owner is null then raise exception 'invalid_input' using errcode = '22023'; end if;
  select * into r from fluid_private.account_deletion_receipts where pending_owner_id = p_owner for update;
  if found then
    update fluid_private.account_deletion_receipts set attempts = attempts + 1 where id = r.id returning * into r;
  else
    if not exists (select 1 from auth.users where id = p_owner) then raise exception 'not_found' using errcode = 'P0002'; end if;
    insert into fluid_private.account_deletion_receipts (subject_hash, pending_owner_id)
      values (fluid_private.account_subject_hash(p_owner), p_owner)
      on conflict (subject_hash) do update set pending_owner_id = excluded.pending_owner_id, state = 'started',
        attempts = fluid_private.account_deletion_receipts.attempts + 1, completed_at = null
      returning * into r;
  end if;
  return jsonb_build_object('receiptId', r.id, 'state', r.state, 'attempts', r.attempts);
end $$;

-- Deletes every row the person owns in one transaction, after copying the
-- accounting amounts into deleted_account_usage. Safe to repeat: a second call
-- finds nothing left. Storage objects are deleted by the server through the
-- Storage API afterwards (direct SQL deletes of storage.objects are refused).
create function public.account_deletion_purge(p_owner uuid) returns jsonb
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

  delete from fluid_private.account_purge_transactions where xact = pg_catalog.pg_current_xact_id();
  perform pg_catalog.set_config('embel.account_purge', '', true);

  update fluid_private.account_deletion_receipts
     set state = case when state = 'completed' then state else 'data_deleted' end,
         data_deleted_at = coalesce(data_deleted_at, clock_timestamp()), deleted_rows = deleted_rows + total
   where id = r.id returning * into r;
  return jsonb_build_object('receiptId', r.id, 'deletedRows', total, 'tables', tables);
end $$;

-- One page of the person's Storage object names, in name order after p_after.
create function public.account_storage_objects(p_owner uuid, p_after text default null, p_limit integer default 500)
returns setof text
language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
   where o.bucket_id = 'fluid-assets' and pg_catalog.starts_with(o.name, p_owner::text || '/')
     and (p_after is null or o.name > p_after)
   order by o.name
   limit least(greatest(coalesce(p_limit, 500), 1), 1000);
$$;

-- Counts files removed by the server for this deletion.
create function public.account_deletion_files_removed(p_owner uuid, p_count integer) returns void
language sql security definer set search_path = '' as $$
  update fluid_private.account_deletion_receipts set deleted_files = deleted_files + greatest(coalesce(p_count, 0), 0)
   where pending_owner_id = p_owner;
$$;

-- Finishes a deletion once the Auth user is gone: the receipt forgets the id.
create function public.account_deletion_complete(p_owner uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r fluid_private.account_deletion_receipts;
begin
  if p_owner is null then raise exception 'invalid_input' using errcode = '22023'; end if;
  select * into r from fluid_private.account_deletion_receipts where pending_owner_id = p_owner for update;
  if not found then
    select * into r from fluid_private.account_deletion_receipts where subject_hash = fluid_private.account_subject_hash(p_owner);
    if found and r.state = 'completed' then return jsonb_build_object('receiptId', r.id, 'state', r.state); end if;
    raise exception 'deletion_not_started' using errcode = 'P0002';
  end if;
  if exists (select 1 from auth.users where id = p_owner) then raise exception 'account_still_exists' using errcode = '55000'; end if;
  if r.state <> 'data_deleted' then raise exception 'data_not_deleted' using errcode = '55000'; end if;
  -- The Auth delete trigger on production (embel_shared_account_auth_changed)
  -- writes a disabled row for the removed id; it holds nothing else.
  if pg_catalog.to_regclass('fluid_private.shared_accounts') is not null then
    execute 'delete from fluid_private.shared_accounts where owner_id = $1' using p_owner;
  end if;
  update fluid_private.account_deletion_receipts
     set state = 'completed', pending_owner_id = null, completed_at = clock_timestamp()
   where id = r.id returning * into r;
  return jsonb_build_object('receiptId', r.id, 'state', r.state);
end $$;

-- Unfinished deletions older than p_min_age, for the maintenance job to resume.
create function public.account_deletions_pending(p_min_age interval default interval '15 minutes', p_limit integer default 20)
returns table (owner_id uuid, state text, auth_user_exists boolean)
language sql stable security definer set search_path = '' as $$
  select r.pending_owner_id, r.state, exists (select 1 from auth.users u where u.id = r.pending_owner_id)
    from fluid_private.account_deletion_receipts r
   where r.pending_owner_id is not null and r.requested_at < clock_timestamp() - p_min_age
   order by r.requested_at
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- Storage objects older than a day whose account or project no longer exists:
-- left behind by an interrupted deletion, or uploaded by work that finished
-- after its records were purged. Objects of soft-deleted projects are kept,
-- because those projects can still be restored.
-- PL/pgSQL so the body is resolved when called, not when created.
create function public.orphaned_storage_objects(p_after text default null, p_limit integer default 500)
returns setof text
language plpgsql stable security definer set search_path = '' as $$
begin
  return query select o.name from storage.objects o
   where o.bucket_id = 'fluid-assets'
     and (p_after is null or o.name > p_after)
     and o.created_at < clock_timestamp() - interval '1 day'
     and (
       pg_catalog.split_part(o.name, '/', 1) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from auth.users u where u.id::text = pg_catalog.split_part(o.name, '/', 1))
       or (pg_catalog.split_part(o.name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           and not exists (select 1 from public.projects p where p.id::text = pg_catalog.split_part(o.name, '/', 2)))
     )
   order by o.name
   limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end $$;

revoke all on function public.account_deletion_begin(uuid), public.account_deletion_purge(uuid),
  public.account_storage_objects(uuid, text, integer), public.account_deletion_files_removed(uuid, integer),
  public.account_deletion_complete(uuid), public.account_deletions_pending(interval, integer),
  public.orphaned_storage_objects(text, integer)
  from public, anon, authenticated;
grant execute on function public.account_deletion_begin(uuid), public.account_deletion_purge(uuid),
  public.account_storage_objects(uuid, text, integer), public.account_deletion_files_removed(uuid, integer),
  public.account_deletion_complete(uuid), public.account_deletions_pending(interval, integer),
  public.orphaned_storage_objects(text, integer)
  to service_role;

-- 4. Data export ------------------------------------------------------------

-- Three downloads per account per day. Rows carry owner_id, so a deletion
-- removes them with everything else.
create table fluid_private.account_export_requests (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  requested_at timestamptz not null default clock_timestamp()
);
create index account_export_requests_owner on fluid_private.account_export_requests (owner_id, requested_at);
alter table fluid_private.account_export_requests enable row level security;
revoke all on fluid_private.account_export_requests from public, anon, authenticated, service_role;

create function public.admit_account_export() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o uuid := auth.uid(); recent integer;
begin
  if o is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('embel_account_export:' || o::text, 0));
  delete from fluid_private.account_export_requests where owner_id = o and requested_at < clock_timestamp() - interval '1 day';
  select count(*) into recent from fluid_private.account_export_requests where owner_id = o;
  if recent >= 3 then raise exception 'export_rate_limited' using errcode = 'PT429'; end if;
  insert into fluid_private.account_export_requests (owner_id) values (o);
  return jsonb_build_object('remainingToday', 2 - recent);
end $$;

-- The app tables the signed-in person can read and that carry their owner id,
-- with their primary-key columns so the export can page through them in a
-- stable order. The export reads each one with the person's own login, so row
-- security decides what is included.
create function public.account_export_tables() returns table (table_name text, key_columns text[])
language sql stable set search_path = '' as $$
  select c.relname::text,
         (select pg_catalog.array_agg(k.attname::text order by pg_catalog.array_position(i.indkey::int2[], k.attnum))
            from pg_catalog.pg_index i join pg_catalog.pg_attribute k on k.attrelid = i.indrelid and k.attnum = any (i.indkey)
           where i.indrelid = c.oid and i.indisprimary)
    from pg_catalog.pg_class c
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'owner_id' and a.atttypid = 'uuid'::regtype and not a.attisdropped
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
     and pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT')
   order by c.relname;
$$;

revoke all on function public.admit_account_export(), public.account_export_tables() from public, anon, service_role;
grant execute on function public.admit_account_export(), public.account_export_tables() to authenticated;

commit;
