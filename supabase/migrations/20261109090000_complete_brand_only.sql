-- Every project is a complete brand. The "Name only" and "Visual identity"
-- project types were retired on November 9, 2026; the app no longer creates or
-- shows them. This converts the projects that still have one.
--
-- Live projects change the same way "Expand to complete brand" did: a new
-- revision copies the saved context, then the type and head move together, so
-- an open tab sees a newer version instead of silently changing. History stays.
-- Deleted projects only change their type, so restoring one brings back a
-- complete brand. The database constraint still lists the old values, which
-- keeps local development databases compatible; nothing writes them any more.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';

with live as (
  select p.id, p.owner_id, p.current_revision
  from public.projects p
  where p.scope <> 'complete_brand' and p.deleted_at is null and p.deletion_requested_at is null
  for update
), copied as (
  insert into public.project_revisions(project_id, owner_id, revision, context, input_hash)
  select l.id, l.owner_id, l.current_revision + 1, r.context, r.input_hash
  from live l
  join public.project_revisions r on r.project_id = l.id and r.owner_id = l.owner_id and r.revision = l.current_revision
  returning project_id, owner_id, revision
)
update public.projects p set scope = 'complete_brand', current_revision = c.revision
from copied c where p.id = c.project_id and p.owner_id = c.owner_id;

-- The lifecycle guard rejects every change to a deleted project. It is paused
-- for this one statement, which changes nothing but the type. Deferred checks
-- from the live conversion run first, since the table cannot be altered with
-- trigger events pending.
set constraints all immediate;
alter table public.projects disable trigger project_lifecycle_change;
update public.projects set scope = 'complete_brand'
  where scope <> 'complete_brand' and (deleted_at is not null or deletion_requested_at is not null);
alter table public.projects enable trigger project_lifecycle_change;

do $$
begin
  if exists(select 1 from public.projects where scope <> 'complete_brand') then
    raise exception 'complete_brand_only_incomplete';
  end if;
  if exists(select 1 from public.projects p where not exists(
      select 1 from public.project_revisions r where r.project_id = p.id and r.owner_id = p.owner_id and r.revision = p.current_revision)) then
    raise exception 'complete_brand_only_missing_revision';
  end if;
end $$;
commit;
