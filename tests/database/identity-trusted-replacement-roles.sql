-- NEW disposable local roles/ACLs only. Never hosted provisioning or recovered bytes.
begin;
create role fixture_identity_replacement_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role fixture_identity_replacement_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
create role fixture_identity_replacement_unbound login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant connect, temporary on database postgres to fixture_identity_replacement_a,fixture_identity_replacement_b,fixture_identity_replacement_unbound;
grant temporary on database postgres to fluid_identity_writer_definer_v1;
grant usage on schema public,fluid_private to fluid_identity_writer_definer_v1;
grant usage on schema fluid_private to fixture_identity_replacement_a,fixture_identity_replacement_b,fixture_identity_replacement_unbound;
grant execute on function fluid_private.prepare_identity_transaction(uuid,jsonb,boolean),fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)
 to fixture_identity_replacement_a,fixture_identity_replacement_b,fixture_identity_replacement_unbound;
grant select on fluid_private.identity_web_principals to fluid_identity_writer_definer_v1;
grant execute on function fluid_private.identity_web_owner(),fluid_private.asset_library_project(public.projects),
 fluid_private.identity_session_json(public.identity_sessions),fluid_private.identity_preferences_json(public.identity_preferences),
 fluid_private.identity_system_json(public.identity_system_versions),fluid_private.identity_selection_json(public.identity_selections),
 fluid_private.identity_change_json(public.identity_component_changes),fluid_private.identity_reference_entry(uuid,uuid,uuid),fluid_private.identity_time_key(text)
 to fluid_identity_writer_definer_v1;
grant select on public.projects,public.project_revisions,public.identity_reference_heads,public.identity_references,
 public.identity_reference_reactions,public.identity_reference_snapshots,public.identity_sessions,public.identity_preferences,
 public.identity_input_snapshots,public.identity_batches,public.identity_generated_roots,public.identity_system_versions,
 public.identity_system_files,public.identity_selections,public.identity_component_changes,public.asset_usages,
 public.jobs,public.job_steps,public.assets,public.asset_versions to fluid_identity_writer_definer_v1;
grant insert on public.identity_reference_snapshots,public.identity_sessions,public.identity_system_versions,
 public.identity_system_files,public.identity_selections,public.identity_component_changes,public.asset_usages to fluid_identity_writer_definer_v1;
grant update(id) on public.projects,public.jobs to fluid_identity_writer_definer_v1;
grant update(project_id) on public.identity_reference_heads to fluid_identity_writer_definer_v1;
grant update(step_key) on public.job_steps to fluid_identity_writer_definer_v1;
grant update(identity_revision,current_selection_id,updated_at) on public.identity_sessions to fluid_identity_writer_definer_v1;
grant update(used) on public.assets to fluid_identity_writer_definer_v1;
do $$declare object_name text;begin
 foreach object_name in array array['projects','project_revisions','identity_reference_heads','identity_references',
  'identity_reference_reactions','identity_reference_snapshots','identity_sessions','identity_preferences',
  'identity_input_snapshots','identity_batches','identity_generated_roots','identity_system_versions',
  'identity_system_files','identity_selections','identity_component_changes','asset_usages','jobs','job_steps','assets','asset_versions'] loop
  execute pg_catalog.format('create policy identity_replacement_read on public.%I for select to fluid_identity_writer_definer_v1 using(owner_id=fluid_private.identity_web_owner())',object_name);
 end loop;
 foreach object_name in array array['identity_reference_snapshots','identity_sessions','identity_system_versions',
  'identity_system_files','identity_selections','identity_component_changes','asset_usages'] loop
  execute pg_catalog.format('create policy identity_replacement_insert on public.%I for insert to fluid_identity_writer_definer_v1 with check(owner_id=fluid_private.identity_web_owner())',object_name);
 end loop;
 foreach object_name in array array['projects','identity_reference_heads','identity_sessions','jobs','job_steps','assets'] loop
  execute pg_catalog.format('create policy identity_replacement_update on public.%I for update to fluid_identity_writer_definer_v1 using(owner_id=fluid_private.identity_web_owner()) with check(owner_id=fluid_private.identity_web_owner())',object_name);
 end loop;
end $$;
commit;
