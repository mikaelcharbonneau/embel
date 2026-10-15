-- Reversible collection lifecycle only. Never purge content, settle/cancel jobs,
-- alter allowances, or remove access to the owner's historical evidence.
begin;

alter table public.projects
  add column deleted_at timestamptz check(deleted_at is null or isfinite(deleted_at)),
  add column lifecycle_version integer not null default 0 check(lifecycle_version >= 0);
create index projects_owner_active_page on public.projects(owner_id,created_at desc,id desc) where deleted_at is null;
create index projects_owner_deleted_page on public.projects(owner_id,created_at desc,id desc) where deleted_at is not null;
create index usage_reservations_project_unsettled on public.usage_reservations(project_id,owner_id) where state='active';
create index jobs_project_unsettled on public.jobs(project_id,owner_id)
  where state in ('queued','running','partial','cancel_requested','needs_reconciliation');

-- Every admission/storage writer shares the project lock with lifecycle changes.
-- Keep this helper private: existing RPCs/RLS still authorize each actual write.
create function fluid_private.require_active_project(p_project_id uuid,p_owner_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_deleted_at timestamptz;
begin
  select p.deleted_at into v_deleted_at from public.projects p
    where p.id=p_project_id and p.owner_id=p_owner_id for share;
  if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
  if v_deleted_at is not null then raise exception 'project_deleted' using errcode='PT409'; end if;
end $$;

create function fluid_private.guard_project_content_lifecycle()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_link record; v_deleted_at timestamptz;
begin
  -- Do not add child->parent locks to existing child-first mutation/worker paths.
  -- A content-only save already in flight may finish alongside reversible
  -- deletion; subsequent writes are denied. Context revision RPCs already hold
  -- the project lock. Admission and Storage below retain their atomic fence.
  for v_link in select NEW.project_id as project_id,NEW.owner_id as owner_id where TG_OP<>'DELETE'
    union select OLD.project_id,OLD.owner_id where TG_OP<>'INSERT'
  loop
    if v_link.project_id is null then continue; end if;
    select p.deleted_at into v_deleted_at from public.projects p
      where p.id=v_link.project_id and p.owner_id=v_link.owner_id;
    if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
    if v_deleted_at is not null then raise exception 'project_deleted' using errcode='PT409'; end if;
  end loop;
  if TG_OP='DELETE' then return OLD; end if;
  return NEW;
end $$;

-- Explicit reviewed project-content table allowlist for this migration. Future
-- tables require their own review; no schema-discovery wildcard expands scope.
-- These content tables use this ownership key. Install a guard on
-- their writes without replacing existing ownership policies or immutable-history
-- triggers. Financial settlement, steps and streaming audit rows retain their
-- existing boundaries so lifecycle never disables later accounting evidence.
do $$ declare t text; begin
  foreach t in array array[
    'asset_heads','asset_selection_receipts','asset_selections',
    'asset_usages','asset_versions','assets',
    'home_attachment_project_requests','home_attachments','idea_brand_links',
    'idea_project_attachments','identity_batches','identity_component_changes',
    'identity_generated_roots','identity_input_snapshots','identity_preferences',
    'identity_reference_heads','identity_reference_reactions','identity_reference_snapshots',
    'identity_references','identity_selections','identity_sessions',
    'identity_system_files','identity_system_versions','logo_approvals',
    'logo_asset_publications','logo_concept_attempts','logo_concept_batches',
    'logo_concept_slots','logo_cost_quotes','logo_direction_font_checks',
    'logo_direction_inputs','logo_direction_publications','logo_direction_records',
    'logo_export_inputs','logo_export_manifests','logo_export_publications',
    'logo_font_records','logo_input_receipts','logo_input_rejections',
    'logo_input_requests','logo_input_rights','logo_operation_rejections',
    'logo_operation_requests','logo_provider_responses','logo_raster_refinements',
    'logo_raster_results','logo_reference_snapshots','logo_reference_sources',
    'logo_stage_heads','logo_stage_revisions','logo_variant_reviews',
    'logo_variant_sets','logo_vector_edit_cancellations','logo_vector_revisions',
    'logo_workspace_requests','logo_workspaces','name_candidates',
    'name_retention','name_selections','name_transforms',
    'naming_batch_results','naming_batches','naming_preferences',
    'naming_sessions','project_inspiration_choices','project_inspiration_heads',
    'project_revisions','project_screening_records','project_visual_directions',
    'standalone_promotions','strategy_job_applications'
  ]
  loop
    execute format('create trigger project_content_lifecycle before insert or update or delete on public.%I for each row execute function fluid_private.guard_project_content_lifecycle()',t);
  end loop;
end $$;

-- Storage upload policies intentionally keep historical reads available. A new
-- object under an existing manifest/staging authorization must still serialize
-- with deletion. Match exact persisted paths, never trust path prefixes as
-- authorization, and leave the existing provider functions/policies unchanged.
create function fluid_private.guard_project_storage_lifecycle()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_link record; v_object record;
begin
  -- An unauthenticated authenticated-role request cannot gain information before
  -- the unchanged Storage RLS check denies it.
  if current_setting('role',true) in ('authenticated','anon') and v_owner is null then return NEW; end if;
  for v_object in select NEW.bucket_id as bucket_id,NEW.name as name
    union select OLD.bucket_id,OLD.name where TG_OP='UPDATE'
  loop
    if v_object.bucket_id is distinct from 'fluid-assets' then continue; end if;
    if split_part(v_object.name,'/',2)='home' then
      -- This row lock also serializes an upload with linking a staged Home file.
      -- Unlinked Home files remain usable; their later linkage is content-guarded.
      for v_link in select h.project_id,h.owner_id from public.home_attachments h
        where v_object.name=h.owner_id::text||'/home/'||h.id::text||'/'||h.blob_version_id::text
          and (v_owner is null or h.owner_id=v_owner) for share
      loop
        if v_link.project_id is not null then
          perform fluid_private.require_active_project(v_link.project_id,v_link.owner_id);
        end if;
      end loop;
    else
      for v_link in select v.project_id,v.owner_id from public.asset_versions v
        where v.storage_path=v_object.name and (v_owner is null or v.owner_id=v_owner)
        union select p.project_id,p.owner_id from public.logo_asset_publications p
        where v_object.name=p.owner_id::text||'/'||p.project_id::text||'/'||p.asset_id::text||'/'||p.version_id::text
          and (v_owner is null or p.owner_id=v_owner)
      loop
        perform fluid_private.require_active_project(v_link.project_id,v_link.owner_id);
      end loop;
    end if;
  end loop;
  return NEW;
end $$;
create trigger fluid_project_storage_lifecycle before insert or update of bucket_id,name,owner_id on storage.objects
  for each row execute function fluid_private.guard_project_storage_lifecycle();

-- A table trigger covers every enqueue entrypoint, including service-backed ones.
-- Reactivating an old terminal job is admission too. Ordinary worker settlement
-- remains untouched. The row lock is held until the entire transaction commits.
create function fluid_private.guard_project_job_admission()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if TG_OP='INSERT' or (NEW.project_id,NEW.owner_id) is distinct from (OLD.project_id,OLD.owner_id)
      or (NEW.state in ('queued','running','partial','cancel_requested','needs_reconciliation')
        and OLD.state in ('succeeded','failed','cancelled')) then
    perform fluid_private.require_active_project(NEW.project_id,NEW.owner_id);
  end if;
  return NEW;
end $$;
create trigger project_job_admission before insert or update of state,project_id,owner_id on public.jobs
  for each row execute function fluid_private.guard_project_job_admission();

-- Lifecycle transitions cannot carry hidden content changes. Also protect the
-- project head itself from legacy title/scope/context writers on stale tabs.
create function fluid_private.guard_project_lifecycle_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if NEW.deleted_at is distinct from OLD.deleted_at then
    -- A fixed transaction snapshot can miss a job admitted before this lock was
    -- acquired. The application's normal READ COMMITTED transaction refreshes
    -- the job query after the lock; reject unsupported isolation fail-closed.
    if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then
      raise exception 'lifecycle_requires_read_committed' using errcode='40001';
    end if;
    if (NEW.deleted_at is not null and OLD.deleted_at is not null)
      or NEW.lifecycle_version<>OLD.lifecycle_version+1
      or (to_jsonb(NEW)-array['deleted_at','lifecycle_version']) is distinct from
         (to_jsonb(OLD)-array['deleted_at','lifecycle_version']) then
      raise exception 'invalid_lifecycle_transition' using errcode='22023';
    end if;
    if NEW.deleted_at is not null and exists(select 1 from public.jobs j
      where j.project_id=OLD.id and j.owner_id=OLD.owner_id
        and j.state in ('queued','running','partial','cancel_requested','needs_reconciliation')) then
      raise exception 'project_busy' using errcode='PT409';
    end if;
    if NEW.deleted_at is not null and exists(select 1 from public.usage_reservations r
      where r.project_id=OLD.id and r.owner_id=OLD.owner_id and r.state='active') then
      raise exception 'project_busy' using errcode='PT409';
    end if;
  elsif NEW.lifecycle_version<>OLD.lifecycle_version then
    raise exception 'invalid_lifecycle_transition' using errcode='22023';
  elsif OLD.deleted_at is not null and NEW is distinct from OLD then
    raise exception 'project_deleted' using errcode='PT409';
  end if;
  return NEW;
end $$;
create trigger project_lifecycle_change before update on public.projects
  for each row execute function fluid_private.guard_project_lifecycle_change();

create function public.set_project_deleted(
  p_project_id uuid,p_expected_revision integer,p_expected_lifecycle_version integer,p_deleted boolean
) returns public.projects language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_project public.projects;
begin
  if v_owner is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select p.* into v_project from public.projects p where p.id=p_project_id and p.owner_id=v_owner for update;
  if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
  if p_expected_revision is null or p_expected_revision<1 or p_expected_lifecycle_version is null
    or p_expected_lifecycle_version not between 0 and 2147483646 or p_deleted is null then
    raise exception 'invalid_lifecycle_request' using errcode='22023';
  end if;
  if v_project.current_revision<>p_expected_revision or v_project.lifecycle_version<>p_expected_lifecycle_version
    or (v_project.deleted_at is not null)=p_deleted then
    raise exception 'lifecycle_conflict' using errcode='PT409';
  end if;
  update public.projects p set deleted_at=case when p_deleted then clock_timestamp() else null end,
    lifecycle_version=p.lifecycle_version+1 where p.id=v_project.id and p.owner_id=v_owner returning p.* into v_project;
  return v_project;
end $$;

-- Deployment default grants can name worker roles beyond the three public API
-- roles. Clear every non-owner ACL on these new functions before narrow grant.
do $$ declare obj record; access record; begin
  for obj in select p.oid,p.proowner from pg_catalog.pg_proc p where p.oid in (
    'fluid_private.require_active_project(uuid,uuid)'::regprocedure,
    'fluid_private.guard_project_content_lifecycle()'::regprocedure,
    'fluid_private.guard_project_job_admission()'::regprocedure,
    'fluid_private.guard_project_storage_lifecycle()'::regprocedure,
    'fluid_private.guard_project_lifecycle_change()'::regprocedure,
    'public.set_project_deleted(uuid,integer,integer,boolean)'::regprocedure
  ) loop
    for access in select distinct a.grantee,r.rolname from pg_catalog.pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      left join pg_catalog.pg_roles r on r.oid=a.grantee
      where p.oid=obj.oid and a.grantee<>obj.proowner loop
      execute 'revoke all on function '||obj.oid::regprocedure::text||' from '||
        case when access.grantee=0 then 'PUBLIC' else quote_ident(access.rolname) end;
    end loop;
  end loop;
end $$;
grant execute on function public.set_project_deleted(uuid,integer,integer,boolean) to authenticated;

commit;
