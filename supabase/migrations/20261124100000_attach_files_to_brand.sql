-- Files can be added to a brand after it was created (the side chat's attach button).
--
-- Until now a file could only be linked to a brand in the same transaction that created the
-- brand (save_attached_home_project, revision 1). This adds:
--
-- 1. home_attachments may be linked at any revision of the brand (the check said revision 1).
--    Linking is still one-way and once: fluid_private.home_attachment_immutable is unchanged.
-- 2. public.attach_home_files_to_project(p_input): the signed-in owner links files they
--    already uploaded and that were verified (staged through the existing upload path) to one
--    of their own brands. A brand holds at most 5 files and 25 MiB in all, counting the files
--    it already has. Repeating the same call is harmless: files already linked to that brand
--    are returned as they are.
-- 3. The generation kind brief.read_files: reading a brand's attached files outside a Strategy
--    run (docs/home-prompt-inputs.md). No credits (owner decision, November 24); it is still
--    admitted by start_generation, so the pause switch, the daily cost caps, one run at a time
--    per brand and a daily limit (20) apply.
--
-- Rollback: disable the kind (update fluid_private.generation_kinds set enabled = false where
-- kind = 'brief.read_files'), drop function public.attach_home_files_to_project(jsonb). The
-- check can only return to "revision 1" while no file is linked at a later revision.

begin;

alter table public.home_attachments drop constraint home_attachments_check1;
alter table public.home_attachments
  add constraint home_attachments_check1 check (project_id is null or (verified and project_revision >= 1));

create function public.attach_home_files_to_project(p_input jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o uuid := auth.uid(); p public.projects; ids uuid[]; v_id uuid; r public.home_attachments;
  held integer; held_bytes bigint; added integer := 0; added_bytes bigint := 0; refs jsonb := '[]';
begin
  if o is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object'
     or not fluid_private.standalone_keys(p_input, array['projectId', 'attachmentIds'])
     or not fluid_private.logo_uuid(p_input->'projectId')
     or jsonb_typeof(p_input->'attachmentIds') is distinct from 'array'
     or jsonb_array_length(p_input->'attachmentIds') not between 1 and 5
     or exists (select 1 from jsonb_array_elements(p_input->'attachmentIds') v where not fluid_private.logo_uuid(v)) then
    raise exception 'invalid_home_ids' using errcode = '22023';
  end if;
  select coalesce(array_agg(value::uuid order by value), '{}'::uuid[]) into ids
    from jsonb_array_elements_text(p_input->'attachmentIds') v(value);
  if cardinality(ids) <> (select count(distinct v) from unnest(ids) v) then
    raise exception 'duplicate_home_ids' using errcode = '22023';
  end if;
  -- One brand's links are serialized, so two calls cannot both fit under the limit.
  perform pg_advisory_xact_lock(hashtextextended(o::text || ':home-project-files:' || (p_input->>'projectId'), 0));
  select * into p from public.projects
    where id = (p_input->>'projectId')::uuid and owner_id = o and deleted_at is null and deletion_requested_at is null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform 1 from public.home_attachments where owner_id = o and id = any(ids) order by id for update;
  foreach v_id in array ids loop
    select * into r from public.home_attachments where id = v_id and owner_id = o;
    if not found then raise exception 'home_attachment_not_found' using errcode = 'P0002'; end if;
    if not r.verified or (r.project_id is not null and r.project_id <> p.id) then
      raise exception 'home_attachment_conflict' using errcode = 'PT409';
    end if;
    if r.project_id is null then added := added + 1; added_bytes := added_bytes + r.byte_length; end if;
  end loop;
  select count(*), coalesce(sum(byte_length), 0) into held, held_bytes
    from public.home_attachments where owner_id = o and project_id = p.id;
  if held + added > 5 or held_bytes + added_bytes > 26214400 then
    raise exception 'home_aggregate_limit' using errcode = '22023';
  end if;
  foreach v_id in array ids loop
    update public.home_attachments set project_id = p.id, project_revision = p.current_revision
      where id = v_id and owner_id = o and verified and project_id is null;
    select * into r from public.home_attachments where id = v_id and owner_id = o;
    refs := refs || jsonb_build_array(fluid_private.home_attachment_ref(r));
  end loop;
  return jsonb_build_object('ownerId', o, 'projectId', p.id, 'attachments', refs);
end $$;

revoke all on function public.attach_home_files_to_project(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.attach_home_files_to_project(jsonb) to authenticated;

insert into fluid_private.generation_kinds (kind, credits, enabled, max_per_day, max_running_minutes)
  values ('brief.read_files', 0, true, 20, 10)
  on conflict (kind) do nothing;

commit;
