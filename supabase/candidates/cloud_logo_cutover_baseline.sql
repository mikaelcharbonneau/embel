-- READ-ONLY preservation snapshot. Only this existing development project.
-- Capture before freeze and compare after freeze/enable BEFORE new work starts.
-- All owner jobs/accounting include Naming: other active work can legitimately
-- change their digest, so record its activity separately. No content, tokens,
-- passwords, session IDs or object bytes are returned.
begin read only;
set local statement_timeout='30s';
select jsonb_build_object(
 'observed_at',clock_timestamp(),
 'preservation',(select jsonb_agg(x order by x.relation) from (
 select 'public.naming_sessions' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.naming_sessions t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.naming_preferences' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.naming_preferences t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.naming_batches' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.naming_batches t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.naming_batch_results' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.naming_batch_results t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.name_transforms' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.name_transforms t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.name_candidates' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.name_candidates t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.name_retention' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.name_retention t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.name_selections' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.name_selections t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.names_workspaces' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.names_workspaces t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'fluid_private.names_workspace_requests' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from fluid_private.names_workspace_requests t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.project_inspiration_heads' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.project_inspiration_heads t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.project_inspiration_choices' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.project_inspiration_choices t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.projects' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.projects t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.project_revisions' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.project_revisions t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.assets' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.assets t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.asset_versions' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.asset_versions t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.asset_selections' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.asset_selections t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.jobs' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.jobs t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.job_steps' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.job_steps t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.usage_accounts' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.usage_accounts t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.usage_reservations' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.usage_reservations t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_workspaces' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_workspaces t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_stage_heads' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_stage_heads t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_stage_revisions' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_stage_revisions t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_reference_snapshots' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_reference_snapshots t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_concept_batches' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_concept_batches t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_concept_slots' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_concept_slots t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_concept_attempts' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_concept_attempts t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_raster_refinements' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_raster_refinements t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_raster_results' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_raster_results t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_provider_responses' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_provider_responses t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_asset_publications' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_asset_publications t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_operation_requests' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_operation_requests t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_operation_rejections' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_operation_rejections t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'public.logo_cost_quotes' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from public.logo_cost_quotes t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'fluid_private.logo_local_jobs' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from fluid_private.logo_local_jobs t where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'
 union all
 select 'fluid_private.logo_generative_storage_grants' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from fluid_private.logo_generative_storage_grants t where auth_user_id='853fa383-9606-4577-924f-966194dc2f67'
 union all
 select 'fluid_private.logo_publication_failure_adjudications' as relation,count(*) as row_count,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') as digest from fluid_private.logo_publication_failure_adjudications t where job_id in(select id from public.jobs where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42')
 union all
 select 'storage.objects:fluid-assets',count(*),encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E'\n' order by to_jsonb(t)::text),''),'UTF8')),'hex') from storage.objects t where bucket_id='fluid-assets'
 ) x),
 'readiness',(select jsonb_agg(to_jsonb(r)) from fluid_private.logo_worker_readiness r where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'),
 'blockers',(select jsonb_build_object(
  'active_or_leased',count(*) filter(where state in('running','cancel_requested','needs_reconciliation') or lease_token is not null or lease_expires_at is not null or (state='queued' and cancel_requested_at is not null)),
  'queued',count(*) filter(where state='queued'),'total',count(*))
  from public.jobs where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42' and operation like 'identity.logo%'),
 'pending_steps',(select count(*) from public.job_steps s join public.jobs j on j.id=s.job_id
  where j.owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42' and j.operation like 'identity.logo%'
  and (s.state='in_flight' or (s.state='ambiguous' and fluid_private.logo_publication_failure_adjudication_matches(j.id) is distinct from true)))
) as baseline;
commit;
