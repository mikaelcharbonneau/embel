-- Context-preserving draft updates and one-way scope expansion. No provider work.
begin;

-- All title edits now share the revision compare-and-swap transaction.
revoke update(title) on public.projects from authenticated;
drop policy owned_project_update on public.projects;

-- Replace, rather than overload, the RPC so PostgREST has one unambiguous signature.
-- The trailing default preserves existing four-argument SQL and RPC callers.
drop function public.append_project_revision(uuid, integer, jsonb, text);
create function public.append_project_revision(
  p_project_id uuid, p_expected_revision integer, p_context jsonb, p_input_hash text,
  p_title text default null
)
returns public.project_revisions language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_project public.projects;
  v_revision public.project_revisions;
begin
  select p.* into v_project from public.projects p
    where p.id = p_project_id and p.owner_id = v_owner for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'invalid_revision' using errcode = '22023';
  end if;
  if v_project.current_revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = '40001';
  end if;
  if p_title is not null and length(btrim(p_title)) not between 1 and 160 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;
  insert into public.project_revisions(project_id, owner_id, revision, context, input_hash)
    values(v_project.id, v_owner, v_project.current_revision + 1, p_context, p_input_hash)
    returning * into v_revision;
  update public.projects p set current_revision = v_revision.revision,
    title = coalesce(btrim(p_title), v_project.title)
    where p.id = v_project.id and p.owner_id = v_owner;
  return v_revision;
end $$;

create function public.expand_project_scope(p_project_id uuid, p_expected_revision integer)
returns table(id uuid, owner_id uuid, scope text, title text, current_revision integer, created_at timestamptz, context jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_project public.projects;
  v_revision public.project_revisions;
begin
  select p.* into v_project from public.projects p
    where p.id = p_project_id and p.owner_id = v_owner for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'invalid_revision' using errcode = '22023';
  end if;
  -- Check before the idempotent branch: stale callers must refresh their context.
  if v_project.current_revision <> p_expected_revision then
    raise exception 'revision_conflict' using errcode = '40001';
  end if;
  select r.* into strict v_revision from public.project_revisions r
    where r.project_id = v_project.id and r.owner_id = v_owner and r.revision = v_project.current_revision;
  if v_project.scope <> 'complete_brand' then
    -- The persisted snapshot and input hash are copied exactly, including intake
    -- details, audience selections and any future context fields. History stays intact.
    insert into public.project_revisions(project_id, owner_id, revision, context, input_hash)
      values(v_project.id, v_owner, v_project.current_revision + 1, v_revision.context, v_revision.input_hash)
      returning * into v_revision;
    update public.projects p set scope = 'complete_brand', current_revision = v_revision.revision
      where p.id = v_project.id and p.owner_id = v_owner returning p.* into v_project;
  end if;
  return query select v_project.id, v_project.owner_id, v_project.scope, v_project.title,
    v_project.current_revision, v_project.created_at, v_revision.context;
end $$;

-- New SECURITY DEFINER functions default to PUBLIC execute; restrict both explicitly.
revoke all on function public.append_project_revision(uuid, integer, jsonb, text, text),
  public.expand_project_scope(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.append_project_revision(uuid, integer, jsonb, text, text),
  public.expand_project_scope(uuid, integer) to authenticated;

commit;
