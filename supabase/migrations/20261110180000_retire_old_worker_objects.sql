-- Retire the old worker system's database objects (docs/architecture-review.md step 5.2,
-- docs/execution-plan.md task B2). The old worker code was removed in PR #231; every AI
-- step runs on the generation engine.
--
-- What goes: the old dispatch, queue, lease, outbox, receipt, slot, lane, API-text,
-- local-runtime, subscription (ChatGPT plan) and account-enrollment functions, tables,
-- triggers and policies that nothing kept references, the Logo vector-proposal and
-- standalone/ideas leftovers nothing reads, and the old worker logins.
--
-- How the list was made: reachability over the live catalog of a database built from the
-- migrations plus the shared packets that dev:up installs (the same packets production
-- ran), and again over a database built from the migrations alone (tests use one; its older
-- bodies of a few kept functions still name some old objects, which therefore stay). Roots
-- are every name the app source (src/, comments excluded) uses, the provider-table triggers
-- and Storage policies that stay, and everything granted to embel_engine and the web-lane
-- logins. A kept function body (comments excluded) that names an object keeps it. Mentions
-- that never run (comments, and calls guarded by to_regprocedure(...) is null) are listed in
-- the JSON. The full list, with signatures, is supabase/retired-objects-20261110.json.
--
-- Everything uses IF EXISTS and never CASCADE, ordered so dependents go first, so a hidden
-- dependency stops the migration instead of removing more. The last block checks that no
-- object with a retired name is left.
--
-- Kept on purpose (see the pull request): jobs, job_steps, the logo_* and identity_* result
-- tables, name_candidates and the Naming batch readers, the web lanes' restricted write
-- functions and logins, embel_engine, set_project_deleted, the account-enrollment packets'
-- objects (kept code still names them), and old worker objects that a kept function still
-- calls (rewriting those functions is follow-up work).
--
-- Rollback: restore the daily backup, or re-run the defining SQL of a dropped object from
-- git commit 35351e0 (supabase/migrations and supabase/candidates|activation|operator).

begin;
set local lock_timeout = '10s';

-- 1. Objects from hand-applied packets that a database built from the migrations does not
--    have. Each is a no-op unless production ran that packet.
drop policy if exists fluid_logo_generative_storage_read on storage.objects;
drop policy if exists fluid_logo_generative_storage_insert on storage.objects;
drop policy if exists fluid_logo_directions_storage_read on storage.objects;
drop policy if exists fluid_logo_production_storage_read on storage.objects;
drop policy if exists fluid_logo_production_storage_insert on storage.objects;
drop function if exists fluid_private.retain_logo_vector_proposal(public.jobs, fluid_private.logo_vector_proposal_prepared_results, text, text);
drop function if exists fluid_private.logo_vector_proposal_materializable(fluid_private.logo_vector_proposals);
drop function if exists fluid_private.logo_vector_proposal_basis_current(fluid_private.logo_vector_proposals);
drop table if exists
  fluid_private.logo_vector_proposal_prepared_results,
  fluid_private.logo_vector_proposal_materializations,
  fluid_private.logo_vector_proposal_dispatches,
  fluid_private.logo_vector_proposals,
  fluid_private.logo_directions_storage_capabilities,
  fluid_private.logo_directions_storage_grants,
  fluid_private.logo_production_storage_capabilities,
  fluid_private.logo_production_storage_grants;
drop function if exists fluid_private.logo_vector_proposal_quote_binding(public.logo_cost_quotes);
drop function if exists fluid_private.logo_vector_proposal_quote_current(public.logo_cost_quotes, fluid_private.logo_runtime_policies);
drop function if exists fluid_private.logo_vector_proposal_job_quote_matches(public.jobs, public.logo_cost_quotes);
drop function if exists fluid_private.logo_vector_proposal_payload_shape_valid(jsonb, jsonb);
drop function if exists fluid_private.logo_vector_proposal_payload_valid(jsonb, jsonb);
drop function if exists fluid_private.logo_vector_proposal_result_valid(jsonb, jsonb, jsonb);
drop function if exists fluid_private.logo_vector_proposal_pending_reason(public.jobs, jsonb, jsonb);
drop function if exists fluid_private.stage_logo_vector_proposal(uuid, uuid, jsonb, uuid);
drop function if exists fluid_private.complete_logo_vector_proposal_step(uuid, uuid, text, text, bigint, jsonb, text);
drop function if exists fluid_private.logo_vector_proposal_application_command_valid(jsonb);
drop function if exists fluid_private.logo_vector_proposal_owned_asset_valid(uuid, uuid, jsonb, text);
drop function if exists fluid_private.commit_logo_vector_proposal(uuid, uuid, jsonb, jsonb);
drop function if exists fluid_private.valid_logo_vector_proposal_observation(jsonb, jsonb);
drop function if exists fluid_private.lock_logo_vector_proposal_dispatch(uuid, uuid);
drop function if exists fluid_private.record_logo_vector_proposal_response(uuid, uuid, jsonb);
drop function if exists fluid_private.logo_directions_storage_member(public.jobs, public.logo_asset_publications);
drop function if exists fluid_private.logo_directions_storage_job(jsonb, uuid, uuid);
drop function if exists public.authorize_logo_directions_storage(uuid, uuid, uuid, text);
drop function if exists fluid_private.logo_directions_storage_object_allowed(text, text);
drop function if exists fluid_private.logo_production_storage_job(jsonb, uuid, uuid);
drop function if exists public.authorize_logo_production_storage(uuid, uuid, uuid, text);
drop function if exists fluid_private.logo_production_storage_object_allowed(text, text, text, text);
drop function if exists fluid_private.quote_logo_vector_proposal(uuid, jsonb);

-- 2. Old Naming objects (naming brain, hosted and local Naming, the old Naming worker) that
--    candidates/shared_naming_cleanup.sql already removed in production. Only a database
--    built from the migrations alone still has them, so each is a no-op in production.
drop function if exists fluid_private.naming_worker_status_json(fluid_private.naming_worker_leadership,boolean,boolean,text);
drop table if exists
  fluid_private.hosted_naming_admission_context,
  fluid_private.naming_brain_artifacts,
  fluid_private.naming_brain_feed_entries,
  fluid_private.naming_brain_identity_index,
  fluid_private.naming_brain_intents,
  fluid_private.naming_brain_progressive_plans,
  fluid_private.naming_brain_provider_records,
  fluid_private.naming_brain_stage_results,
  fluid_private.naming_observation_recovery_audit,
  fluid_private.naming_worker_gateway_context,
  fluid_private.naming_worker_job_authority,
  fluid_private.naming_worker_leadership;
drop function if exists public.complete_naming_job_step(uuid,uuid,text,text,bigint,jsonb,text);
drop function if exists fluid_private.naming_brain_can_resume(fluid_private.naming_brain_runs);
drop function if exists fluid_private.naming_brain_counter(jsonb,integer);
drop function if exists fluid_private.naming_brain_uuid(jsonb);
drop function if exists fluid_private.naming_brain_request_key(jsonb);
drop function if exists fluid_private.naming_brain_cursor(jsonb);
drop function if exists fluid_private.naming_brain_visible_text(jsonb);
drop function if exists fluid_private.naming_brain_free_resume(fluid_private.naming_brain_runs);
drop function if exists public.enqueue_subscription_naming_job(uuid,integer,integer,integer,text,text);
drop function if exists fluid_private.naming_brain_observable(fluid_private.naming_brain_runs);
drop function if exists fluid_private.naming_brain_json_matches(text,jsonb);
drop function if exists fluid_private.naming_brain_call_failed(fluid_private.naming_brain_calls);
drop function if exists fluid_private.naming_brain_cap(text);
drop function if exists fluid_private.naming_brain_call_completed(fluid_private.naming_brain_calls);
drop function if exists fluid_private.naming_brain_run_worker(fluid_private.naming_brain_runs);
drop function if exists fluid_private.naming_brain_head(uuid,uuid);
drop function if exists fluid_private.naming_brain_accounting(fluid_private.naming_brain_runs);
drop function if exists fluid_private.naming_brain_ready(fluid_private.naming_brain_runs,text);
drop function if exists public.report_naming_brain_worker_ready(jsonb,text,text,integer);
drop function if exists fluid_private.naming_brain_ready_preferences(uuid,uuid,integer);
drop function if exists public.get_naming_brain_preference_work(integer);
drop function if exists public.attest_naming_brain_preferences(uuid,integer,text,jsonb,jsonb);
drop function if exists fluid_private.naming_brain_available(uuid);
drop function if exists fluid_private.naming_brain_summary(fluid_private.naming_brain_runs);
drop function if exists fluid_private.naming_brain_legacy_lock(uuid,uuid);
drop function if exists fluid_private.naming_brain_invalid_output(fluid_private.naming_brain_calls,jsonb);
drop function if exists fluid_private.naming_brain_call_terminal(fluid_private.naming_brain_calls);
drop function if exists fluid_private.naming_brain_preparation_pending(fluid_private.naming_brain_runs);
drop function if exists fluid_private.naming_brain_preparation_recovery(fluid_private.naming_brain_runs);
drop function if exists public.claim_naming_brain_job(text,text,integer);
drop function if exists fluid_private.naming_brain_ensure_response(fluid_private.naming_brain_runs,boolean);
drop function if exists public.expire_naming_brain_leases(text,text);
drop function if exists fluid_private.naming_brain_valid_intent(text,jsonb);
drop function if exists fluid_private.naming_brain_lock(uuid,uuid);
drop function if exists public.record_naming_brain_provider_receipt(uuid,uuid,jsonb);
drop function if exists fluid_private.naming_brain_prepare(fluid_private.naming_brain_runs,jsonb);
drop function if exists public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb);
drop function if exists public.naming_brain_worker_action(uuid,uuid,text,jsonb);
drop function if exists fluid_private.naming_brain_reconcile(uuid,uuid);
drop function if exists public.steer_naming_feed(uuid,jsonb);
drop function if exists public.ensure_naming_brain_run(uuid,jsonb);
drop function if exists public.get_naming_feed(uuid,jsonb);
drop function if exists fluid_private.hosted_naming_context(uuid,uuid);
drop function if exists public.stop_naming_feed(uuid,jsonb);
drop function if exists public.get_naming_brain_job_accounting(uuid);
drop function if exists public.get_naming_brain_candidate_sources(uuid,jsonb);
drop function if exists public.get_naming_brain_candidate_source(uuid,uuid);
drop function if exists fluid_private.hosted_naming_job_enabled(uuid);
drop function if exists fluid_private.naming_brain_unlimited_context(uuid,uuid);
drop function if exists fluid_private.naming_brain_rejected_receipt(fluid_private.naming_brain_calls);
drop function if exists fluid_private.naming_brain_saved_usable(fluid_private.naming_brain_runs);
drop function if exists public.authorize_naming_brain_dispatch(uuid,uuid,jsonb);
drop function if exists public.append_prepared_naming_set(uuid,uuid);
drop function if exists fluid_private.naming_brain_local_not_dispatched(fluid_private.naming_brain_calls,jsonb);
drop function if exists fluid_private.naming_brain_paid_paused(uuid,uuid,uuid);
drop function if exists public.get_hosted_naming_availability(uuid);
drop function if exists public.get_naming_brain_run(uuid,uuid);
drop function if exists fluid_private.local_naming_previous_feed(uuid,jsonb);
drop function if exists fluid_private.local_naming_previous_run(uuid,uuid);
drop function if exists fluid_private.local_naming_previous_source(uuid,uuid);
drop function if exists fluid_private.local_naming_previous_authorize(uuid,uuid,jsonb);
drop function if exists fluid_private.local_naming_previous_complete(uuid,uuid,text,text,jsonb);
drop function if exists fluid_private.local_naming_publish_microbatch(fluid_private.naming_brain_runs,jsonb);
drop function if exists fluid_private.local_naming_progressive_action(uuid,uuid,text,jsonb);
drop function if exists fluid_private.local_naming_previous_summary(fluid_private.naming_brain_runs);
drop function if exists fluid_private.local_naming_previous_call_terminal(fluid_private.naming_brain_calls);
drop function if exists fluid_private.local_naming_previous_can_resume(fluid_private.naming_brain_runs);
drop function if exists fluid_private.local_naming_previous_ensure_response(fluid_private.naming_brain_runs,boolean);
drop function if exists fluid_private.hosted_naming_owner_enabled(uuid);
drop function if exists fluid_private.local_naming_progressive_researched(fluid_private.naming_brain_runs);
drop function if exists fluid_private.local_naming_progressive_basis(fluid_private.naming_brain_runs);
drop function if exists fluid_private.local_naming_progressive_counts(fluid_private.naming_brain_runs);
drop function if exists fluid_private.local_naming_progressive_saved_resume(fluid_private.naming_brain_runs);
drop function if exists fluid_private.local_naming_progressive_state(fluid_private.naming_brain_runs,text,text,text);
drop function if exists fluid_private.local_naming_progressive_current(fluid_private.naming_brain_runs);
drop function if exists fluid_private.local_naming_previous_worker_action(uuid,uuid,text,jsonb);
drop function if exists fluid_private.local_naming_previous_preparation_pending(fluid_private.naming_brain_runs);
drop function if exists public.ensure_local_naming_brain_run(uuid,jsonb);
drop function if exists fluid_private.naming_brain_paid_resume(fluid_private.naming_brain_runs);
drop function if exists public.report_naming_brain_worker_status(jsonb,text,text,bigint,integer);
drop function if exists public.ensure_hosted_naming_brain_run(uuid,jsonb);
drop function if exists fluid_private.hosted_naming_step_authority(uuid);
drop function if exists fluid_private.latest_naming_brain_receipt(uuid,text,text);
drop function if exists fluid_private.local_naming_progressive_authorize(uuid,uuid,jsonb);
drop function if exists fluid_private.naming_progressive_provider_cap(jsonb,jsonb);
drop function if exists fluid_private.naming_brain_artifact_output_matches(text,jsonb,text);
drop function if exists fluid_private.ensure_naming_brain_receipt_totals(uuid);
drop function if exists fluid_private.naming_worker_job_ready(fluid_private.naming_brain_runs,text);
drop function if exists fluid_private.naming_worker_claim_pending(uuid,text,text);
drop function if exists fluid_private.naming_worker_claim_core(text,text,integer);
drop function if exists fluid_private.naming_worker_expiry_core(text,text);
drop function if exists fluid_private.naming_worker_attest_core(uuid,integer,text,jsonb,jsonb);
drop function if exists public.naming_brain_worker_maintenance_v2(text,text,bigint,text,jsonb);
drop function if exists fluid_private.naming_worker_ready_core(fluid_private.naming_brain_runs,text);
drop function if exists fluid_private.naming_worker_scope(text);
drop function if exists fluid_private.naming_worker_context(uuid,text,text,text);
drop function if exists fluid_private.naming_worker_expiry_pending(uuid,text);


-- 3. Row-level security policies (old worker Storage access, old worker reads of job_steps,
--    and the policies on the tables dropped below).
drop policy if exists owned_read on public.idea_brand_links;
drop policy if exists owned_read on public.idea_project_attachment_requests;
drop policy if exists owned_read on public.idea_project_attachments;
drop policy if exists api_text_worker_step_read on public.job_steps;
drop policy if exists subscription_worker_step_read on public.job_steps;
do $$ begin if to_regclass('public.logo_style_notes') is not null then drop policy if exists owned_read on public.logo_style_notes; end if; end $$;
drop policy if exists names_workspace_owner_read on public.names_workspaces;
drop policy if exists owned_read on public.standalone_promotions;
drop policy if exists standalone_owner_read on public.standalone_workspace_revisions;
drop policy if exists standalone_owner_read on public.standalone_workspaces;
drop policy if exists owned_read on public.strategy_job_applications;
drop policy if exists embel_shared_storage_delete_fence on storage.objects;
drop policy if exists embel_shared_storage_insert on storage.objects;
drop policy if exists embel_shared_storage_insert_fence on storage.objects;
drop policy if exists embel_shared_storage_read on storage.objects;
drop policy if exists embel_shared_storage_read_fence on storage.objects;
drop policy if exists embel_shared_storage_update_fence on storage.objects;
drop policy if exists fluid_logo_worker_storage_delete_fence on storage.objects;
drop policy if exists fluid_logo_worker_storage_insert on storage.objects;
drop policy if exists fluid_logo_worker_storage_insert_fence on storage.objects;
drop policy if exists fluid_logo_worker_storage_read on storage.objects;
drop policy if exists fluid_logo_worker_storage_read_fence on storage.objects;
drop policy if exists fluid_logo_worker_storage_update_fence on storage.objects;

-- 4. Triggers on the tables dropped below, and old worker triggers.
drop trigger if exists api_text_allowance_admission_immutable on fluid_private.api_text_allowance_admissions;
drop trigger if exists research_operator_adjudication_immutable on fluid_private.api_text_operator_adjudications;
drop trigger if exists research_operator_adjudication_insert on fluid_private.api_text_operator_adjudications;
drop trigger if exists research_operator_adjudication_no_truncate on fluid_private.api_text_operator_adjudications;
drop trigger if exists api_text_testing_admission_immutable on fluid_private.api_text_testing_admissions;
drop trigger if exists names_workspace_requests_immutable on fluid_private.names_workspace_requests;
do $$ begin if to_regclass('fluid_private.shared_identity_prepared') is not null then drop trigger if exists shared_identity_immutable on fluid_private.shared_identity_prepared; end if; end $$;
do $$ begin if to_regclass('fluid_private.shared_identity_specification_cancellations') is not null then drop trigger if exists shared_identity_immutable on fluid_private.shared_identity_specification_cancellations; end if; end $$;
do $$ begin if to_regclass('fluid_private.shared_logo_advanced_quotes') is not null then drop trigger if exists shared_logo_advanced_quote_immutable on fluid_private.shared_logo_advanced_quotes; end if; end $$;
do $$ begin if to_regclass('fluid_private.shared_logo_export_resolutions') is not null then drop trigger if exists shared_logo_export_resolution_immutable on fluid_private.shared_logo_export_resolutions; end if; end $$;
do $$ begin if to_regclass('fluid_private.shared_logo_output_observations') is not null then drop trigger if exists shared_logo_output_observation_immutable on fluid_private.shared_logo_output_observations; end if; end $$;
do $$ begin if to_regclass('fluid_private.shared_logo_proposal_request_closures') is not null then drop trigger if exists shared_logo_proposal_request_closure_immutable on fluid_private.shared_logo_proposal_request_closures; end if; end $$;
do $$ begin if to_regclass('fluid_private.shared_logo_raster_recoveries') is not null then drop trigger if exists shared_logo_raster_recoveries_immutable on fluid_private.shared_logo_raster_recoveries; end if; end $$;
do $$ begin if to_regclass('fluid_private.shared_logo_vector_proposal_dispatches') is not null then drop trigger if exists shared_logo_advanced_dispatch_immutable on fluid_private.shared_logo_vector_proposal_dispatches; end if; end $$;
do $$ begin if to_regclass('fluid_private.shared_logo_vector_proposal_materializations') is not null then drop trigger if exists logo_vector_proposal_materializations_immutable on fluid_private.shared_logo_vector_proposal_materializations; end if; end $$;
do $$ begin if to_regclass('fluid_private.shared_logo_vector_proposal_prepared_results') is not null then drop trigger if exists logo_vector_proposal_prepared_results_immutable on fluid_private.shared_logo_vector_proposal_prepared_results; end if; end $$;
do $$ begin if to_regclass('fluid_private.shared_logo_vector_proposals') is not null then drop trigger if exists logo_vector_proposals_immutable on fluid_private.shared_logo_vector_proposals; end if; end $$;
do $$ begin if to_regclass('fluid_private.shared_strategy_observed_outcomes') is not null then drop trigger if exists shared_strategy_observed_outcome_immutable on fluid_private.shared_strategy_observed_outcomes; end if; end $$;
do $$ begin if to_regclass('fluid_private.shared_strategy_observed_responses') is not null then drop trigger if exists shared_strategy_observed_response_immutable on fluid_private.shared_strategy_observed_responses; end if; end $$;
drop trigger if exists idea_brand_links_immutable on public.idea_brand_links;
drop trigger if exists project_content_lifecycle on public.idea_brand_links;
drop trigger if exists idea_project_attachment_requests_immutable on public.idea_project_attachment_requests;
drop trigger if exists idea_project_attachments_immutable on public.idea_project_attachments;
drop trigger if exists project_content_lifecycle on public.idea_project_attachments;
do $$ begin if to_regclass('public.logo_style_notes') is not null then drop trigger if exists logo_style_notes_immutable on public.logo_style_notes; end if; end $$;
do $$ begin if to_regclass('public.logo_style_notes') is not null then drop trigger if exists project_content_lifecycle on public.logo_style_notes; end if; end $$;
drop trigger if exists project_content_lifecycle on public.standalone_promotions;
drop trigger if exists standalone_promotions_immutable on public.standalone_promotions;
drop trigger if exists standalone_workspace_revisions_immutable on public.standalone_workspace_revisions;
drop trigger if exists project_content_lifecycle on public.strategy_job_applications;
drop trigger if exists strategy_job_applications_immutable on public.strategy_job_applications;

-- 5. Functions.
drop function if exists fluid_private.admit_shared_worker_job(uuid,text,text,text,jsonb);
drop function if exists fluid_private.api_text_allowance_available(uuid,text);
drop function if exists fluid_private.api_text_allowance_paused();
drop function if exists fluid_private.api_text_background_action(uuid,uuid,text,text,jsonb);
drop function if exists fluid_private.api_text_background_control(uuid,text,jsonb);
drop function if exists fluid_private.api_text_bounded_policy(jsonb);
drop function if exists fluid_private.api_text_deleted_strategy_quarantined(uuid,text,uuid,uuid);
drop function if exists fluid_private.api_text_deleted_strategy_runtime_quarantined(uuid,text,jsonb,text,uuid);
drop function if exists fluid_private.api_text_descriptor_owner(jsonb);
drop function if exists fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches);
drop function if exists fluid_private.api_text_legacy_policy_allowed(uuid,text,jsonb,text,oid);
drop function if exists fluid_private.api_text_paid_paused(uuid);
drop function if exists fluid_private.api_text_policy_allowed(uuid,text,jsonb,text,oid);
drop function if exists fluid_private.api_text_project_allowance_available(uuid,text,uuid);
drop function if exists fluid_private.api_text_project_allowance_paused(uuid,text,uuid);
drop function if exists fluid_private.api_text_project_policy_allowed(uuid,text,jsonb,text,uuid,oid);
drop function if exists fluid_private.api_text_quarantine_worker_ready(text,jsonb,text,oid);
drop function if exists fluid_private.api_text_request_policy(uuid,text,jsonb);
drop function if exists fluid_private.api_text_strategy_outcome_resolved(uuid);
drop function if exists fluid_private.api_text_strategy_paused(uuid,text,uuid);
drop function if exists fluid_private.api_text_strategy_runtime_paused(uuid,text,jsonb,text);
drop function if exists fluid_private.api_text_testing_enabled(uuid,text);
drop function if exists fluid_private.api_text_testing_enqueue_matches(uuid,uuid,text,integer,text,jsonb,text,bigint,integer);
drop function if exists fluid_private.api_text_testing_gateway_matches(uuid,text,jsonb,text,uuid);
drop function if exists fluid_private.api_text_testing_gateway_project(uuid,text,jsonb,text);
drop function if exists fluid_private.api_text_testing_job_allowed(uuid);
drop function if exists fluid_private.api_text_testing_project_scope(uuid,text,uuid);
drop function if exists fluid_private.bind_shared_worker_execution(jsonb,uuid);
drop function if exists fluid_private.claim_local_strategy_job(text,integer);
drop function if exists fluid_private.close_shared_worker_execution(jsonb,jsonb);
drop function if exists fluid_private.commit_logo_asset_publication(public.jobs,uuid);
drop function if exists fluid_private.complete_job_step_core(uuid,uuid,text,text,bigint,jsonb,text);
drop function if exists fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint);
drop function if exists fluid_private.enter_shared_worker_claim_context(jsonb,uuid);
drop function if exists fluid_private.enter_shared_worker_context(jsonb,jsonb,text);
drop function if exists fluid_private.expire_local_strategy_leases();
drop function if exists fluid_private.get_api_strategy_availability_legacy(uuid);
drop function if exists fluid_private.guided_api_strategy_input(uuid,uuid,integer,text,jsonb,bigint);
drop function if exists fluid_private.handles_search_payload(jsonb);
drop function if exists fluid_private.handles_search_preset(jsonb);
drop function if exists fluid_private.idea_content(jsonb);
drop function if exists fluid_private.idea_link_json(public.idea_brand_links);
drop function if exists fluid_private.idea_project_context_text(jsonb);
drop function if exists fluid_private.idea_record(uuid,uuid);
drop function if exists fluid_private.identity_mutation_context(uuid,jsonb);
drop function if exists fluid_private.identity_request(jsonb,boolean);
drop function if exists fluid_private.identity_write_selection(public.identity_system_versions,jsonb,boolean,text,uuid,timestamp with time zone);
drop function if exists fluid_private.leave_shared_worker_context();
drop function if exists fluid_private.lifecycle_revision(jsonb);
drop function if exists fluid_private.lifecycle_uuid(jsonb);
drop function if exists fluid_private.local_prototype_job_worker(uuid);
drop function if exists fluid_private.local_prototype_paid_paused(uuid,uuid,uuid);
drop function if exists fluid_private.local_prototype_project_paused(uuid,uuid);
drop function if exists fluid_private.local_prototype_unlimited_context(uuid,uuid);
drop function if exists fluid_private.local_strategy_job_ready(uuid);
drop function if exists fluid_private.local_strategy_worker_owner();
drop function if exists fluid_private.lock_leased_job(uuid,uuid);
drop function if exists fluid_private.lock_local_strategy_job(uuid,uuid);
drop function if exists fluid_private.lock_logo_job_readiness(public.jobs,text);
drop function if exists fluid_private.lock_shared_worker_slot(jsonb,boolean);
drop function if exists fluid_private.logo_commit_direction_publication(public.jobs,uuid,uuid);
drop function if exists fluid_private.logo_commit_export_publication(public.jobs,uuid);
drop function if exists fluid_private.logo_commit_vector_publication(public.jobs,uuid);
drop function if exists fluid_private.logo_direction_checks_valid(jsonb,jsonb,jsonb);
drop function if exists fluid_private.logo_direction_group_valid(jsonb,jsonb,uuid,uuid);
drop function if exists fluid_private.logo_export_expected_files(jsonb);
drop function if exists fluid_private.logo_export_group_valid(public.jobs,jsonb);
drop function if exists fluid_private.logo_freeze_direction_inputs(public.jobs,jsonb);
drop function if exists fluid_private.logo_generative_storage_job(jsonb,uuid,uuid);
drop function if exists fluid_private.logo_generative_storage_member(public.jobs,public.logo_asset_publications,text);
drop function if exists fluid_private.logo_generative_storage_object_allowed(text,text,text,text);
drop function if exists fluid_private.logo_job_policy_matches(public.jobs,fluid_private.logo_runtime_policies);
drop function if exists fluid_private.logo_job_ready(public.jobs,text);
drop function if exists fluid_private.logo_local_context_allowed(uuid,uuid);
drop function if exists fluid_private.logo_local_enabled(uuid);
drop function if exists fluid_private.logo_local_job_allowed(uuid,text);
drop function if exists fluid_private.logo_local_project_clear(uuid,uuid);
drop function if exists fluid_private.logo_lock_job(uuid,uuid);
drop function if exists fluid_private.logo_operation_ready(uuid,text);
drop function if exists fluid_private.logo_policy_descriptor(fluid_private.logo_runtime_policies);
drop function if exists fluid_private.logo_prepare_direction_sources_before_visual_direction(uuid,uuid,uuid);
drop function if exists fluid_private.logo_prepare_direction_sources(uuid,uuid,uuid);
drop function if exists fluid_private.logo_production_storage_member(public.jobs,public.logo_asset_publications,text);
drop function if exists fluid_private.logo_publication_failure_adjudication_matches(uuid);
drop function if exists fluid_private.logo_response_identity_complete(public.jobs,jsonb);
drop function if exists fluid_private.logo_storage_context();
drop function if exists fluid_private.logo_storage_identity_bound();
drop function if exists fluid_private.logo_storage_object_allowed(text,text);
drop function if exists fluid_private.logo_storage_reservation_live(jsonb,uuid,uuid,uuid);
drop function if exists fluid_private.logo_subscription_observation_valid(public.jobs,jsonb);
drop function if exists fluid_private.logo_subscription_quota_available(uuid,jsonb,uuid);
drop function if exists fluid_private.logo_subscription_registration_ready(uuid,jsonb);
drop function if exists fluid_private.logo_trace_settings_valid(jsonb);
drop function if exists fluid_private.logo_vector_edit_cancel_command_valid(jsonb);
drop function if exists fluid_private.logo_vector_edit_request_state(uuid,uuid,uuid);
drop function if exists fluid_private.names_workspace_input(jsonb);
drop function if exists fluid_private.names_workspace_payload(jsonb);
drop function if exists fluid_private.names_workspace_text(jsonb,integer,integer);
drop function if exists fluid_private.names_workspace_uuid(jsonb,boolean);
drop function if exists fluid_private.naming_expire_job(uuid,boolean);
drop function if exists fluid_private.naming_finish_job(uuid,text);
drop function if exists fluid_private.naming_round_json(fluid_private.naming_rounds);
drop function if exists fluid_private.park_shared_worker_execution(jsonb,jsonb);
drop function if exists fluid_private.read_leased_logo_vector_revision(uuid,uuid,uuid);
drop function if exists fluid_private.record_research_operator_adjudication();
drop function if exists fluid_private.reject_logo_admission(uuid,uuid,jsonb,text);
drop function if exists fluid_private.reject_logo_export_admission(uuid,uuid,jsonb);
drop function if exists fluid_private.report_local_strategy_ready(text,jsonb,integer);
drop function if exists fluid_private.research_operator_adjudication_matches(uuid);
drop function if exists fluid_private.set_strategy_billing_route(uuid,integer,text);
drop function if exists fluid_private.shared_identity_asset_shape(jsonb,uuid,uuid,boolean);
drop function if exists fluid_private.shared_identity_authorize(public.jobs,text,text,text,text);
drop function if exists fluid_private.shared_identity_cancel_known_specification(public.jobs,text);
drop function if exists fluid_private.shared_identity_complete(public.jobs,text,text,bigint,jsonb,text);
drop function if exists fluid_private.shared_identity_context(uuid,uuid,boolean);
drop function if exists fluid_private.shared_identity_finish(public.jobs,text);
drop function if exists fluid_private.shared_identity_input(public.jobs);
drop function if exists fluid_private.shared_identity_manifest_shape(jsonb,uuid,uuid);
drop function if exists fluid_private.shared_identity_observation_valid(jsonb,fluid_private.shared_identity_calls);
drop function if exists fluid_private.shared_identity_observe_asset(public.jobs,uuid,jsonb);
drop function if exists fluid_private.shared_identity_policy(uuid);
drop function if exists fluid_private.shared_identity_prepare_asset(public.jobs,jsonb);
drop function if exists fluid_private.shared_identity_previous_logo_gateway(jsonb,jsonb,text,jsonb);
drop function if exists fluid_private.shared_identity_read_asset(public.jobs,jsonb);
drop function if exists fluid_private.shared_identity_receipt_complete(public.jobs,fluid_private.shared_identity_receipts,text);
drop function if exists fluid_private.shared_identity_receipt_json(fluid_private.shared_identity_receipts);
drop function if exists fluid_private.shared_identity_record_receipt(public.jobs,uuid,jsonb);
drop function if exists fluid_private.shared_identity_runtime_ready(uuid);
drop function if exists fluid_private.shared_identity_stage(public.jobs,text,jsonb,jsonb);
drop function if exists fluid_private.shared_identity_storage_member(public.jobs,public.logo_asset_publications,text);
drop function if exists fluid_private.shared_identity_system_id(public.jobs,text);
drop function if exists fluid_private.shared_logo_admit_advanced(uuid,jsonb);
drop function if exists fluid_private.shared_logo_admit_vector(uuid,jsonb);
drop function if exists fluid_private.shared_logo_advanced_action(uuid,uuid,text,jsonb);
drop function if exists fluid_private.shared_logo_advanced_job_matches(public.jobs,jsonb);
drop function if exists fluid_private.shared_logo_advanced_quote_binding(public.logo_cost_quotes,jsonb);
drop function if exists fluid_private.shared_logo_advanced_quote_current(public.logo_cost_quotes,jsonb);
drop function if exists fluid_private.shared_logo_apply_proposal_command(uuid,jsonb,jsonb);
drop function if exists fluid_private.shared_logo_begin_job(uuid,uuid,text,text,bigint);
drop function if exists fluid_private.shared_logo_claim_job(uuid,text,integer);
drop function if exists fluid_private.shared_logo_commit_direction_publication(public.jobs,uuid,uuid);
drop function if exists fluid_private.shared_logo_commit_vector_proposal(uuid,uuid,jsonb,jsonb);
drop function if exists fluid_private.shared_logo_complete_directions(uuid,uuid,text,text,bigint,jsonb,text);
drop function if exists fluid_private.shared_logo_complete_proposal(uuid,uuid,text,text,bigint,jsonb,text);
drop function if exists fluid_private.shared_logo_complete_style_note(uuid,uuid,text,text,bigint,jsonb,text);
drop function if exists fluid_private.shared_logo_context_allowed(uuid,uuid);
drop function if exists fluid_private.shared_logo_create_raster_jobs(public.logo_cost_quotes,jsonb,jsonb);
drop function if exists fluid_private.shared_logo_direction_storage_member(public.jobs,public.logo_asset_publications);
drop function if exists fluid_private.shared_logo_directions_observation_valid(jsonb,jsonb);
drop function if exists fluid_private.shared_logo_job_context(uuid);
drop function if exists fluid_private.shared_logo_json_arg(jsonb,integer);
drop function if exists fluid_private.shared_logo_legacy_cancel_command_valid(jsonb);
drop function if exists fluid_private.shared_logo_legacy_edit_request_state(uuid,uuid,uuid);
drop function if exists fluid_private.shared_logo_legacy_job_ready(public.jobs,text);
drop function if exists fluid_private.shared_logo_legacy_local_context(uuid,uuid);
drop function if exists fluid_private.shared_logo_legacy_local_job(uuid,text);
drop function if exists fluid_private.shared_logo_legacy_lock_job(uuid,uuid);
drop function if exists fluid_private.shared_logo_legacy_lock_readiness(public.jobs,text);
drop function if exists fluid_private.shared_logo_legacy_operation_ready(uuid,text);
drop function if exists fluid_private.shared_logo_lock_issued_job(uuid,uuid);
drop function if exists fluid_private.shared_logo_lock_vector_proposal_dispatch(uuid,uuid);
drop function if exists fluid_private.shared_logo_policy_valid(text,jsonb);
drop function if exists fluid_private.shared_logo_policy(uuid,text);
drop function if exists fluid_private.shared_logo_project_clear(uuid,uuid);
drop function if exists fluid_private.shared_logo_proposal_request_owner(uuid,boolean);
drop function if exists fluid_private.shared_logo_proposal_request_quote(uuid,uuid,jsonb);
drop function if exists fluid_private.shared_logo_quote_directions(uuid,jsonb);
drop function if exists fluid_private.shared_logo_quote_raster(uuid,jsonb);
drop function if exists fluid_private.shared_logo_quote_style_note(uuid,jsonb);
drop function if exists fluid_private.shared_logo_quote_vector_proposal(uuid,jsonb);
drop function if exists fluid_private.shared_logo_raster_job_matches(public.jobs,jsonb);
drop function if exists fluid_private.shared_logo_raster_observation_valid(jsonb);
drop function if exists fluid_private.shared_logo_raster_policy_valid(text,jsonb);
drop function if exists fluid_private.shared_logo_raster_quote_binding(public.logo_cost_quotes,jsonb);
drop function if exists fluid_private.shared_logo_read_proposal_asset(uuid,jsonb,uuid,uuid);
drop function if exists fluid_private.shared_logo_read_proposal_command(uuid,jsonb);
drop function if exists fluid_private.shared_logo_read_proposal_request(uuid,uuid,jsonb,public.logo_cost_quotes);
drop function if exists fluid_private.shared_logo_record_response(uuid,uuid,jsonb);
drop function if exists fluid_private.shared_logo_record_vector_proposal_response(uuid,uuid,jsonb);
drop function if exists fluid_private.shared_logo_report_runtime_ready(jsonb,jsonb);
drop function if exists fluid_private.shared_logo_resolve_prepared_export();
drop function if exists fluid_private.shared_logo_resolve_raster();
drop function if exists fluid_private.shared_logo_response_identity_complete(public.jobs,jsonb);
drop function if exists fluid_private.shared_logo_retain_proposal(public.jobs,fluid_private.shared_logo_vector_proposal_prepared_results,text,text);
drop function if exists fluid_private.shared_logo_runtime_manifest_item_valid(jsonb);
drop function if exists fluid_private.shared_logo_runtime_ready(uuid,text);
drop function if exists fluid_private.shared_logo_slot_runtime_ready(uuid);
drop function if exists fluid_private.shared_logo_stage_proposal(uuid,uuid,jsonb,uuid);
drop function if exists fluid_private.shared_logo_stage_style_note(uuid,uuid,jsonb,uuid);
drop function if exists fluid_private.shared_logo_storage_member(public.jobs,public.logo_asset_publications,text);
drop function if exists fluid_private.shared_logo_storage_policy_matches(public.jobs,jsonb);
drop function if exists fluid_private.shared_logo_storage_policy(public.jobs);
drop function if exists fluid_private.shared_logo_storage_ready(uuid);
drop function if exists fluid_private.shared_logo_style_note_exists(uuid,uuid,jsonb);
drop function if exists fluid_private.shared_logo_style_note_observation_valid(jsonb,jsonb);
drop function if exists fluid_private.shared_logo_style_note_source(uuid,uuid,uuid);
drop function if exists fluid_private.shared_logo_style_note_storage_member(public.jobs,public.logo_asset_publications);
drop function if exists fluid_private.shared_logo_style_note_text_policy_valid(jsonb);
drop function if exists fluid_private.shared_logo_valid_vector_proposal_observation(jsonb,jsonb);
drop function if exists fluid_private.shared_logo_valid_vector_proposal_text_policy(jsonb);
drop function if exists fluid_private.shared_logo_vector_proposal_application_command_valid(jsonb);
drop function if exists fluid_private.shared_logo_vector_proposal_basis_current(fluid_private.shared_logo_vector_proposals);
drop function if exists fluid_private.shared_logo_vector_proposal_job_quote_matches(public.jobs,public.logo_cost_quotes);
drop function if exists fluid_private.shared_logo_vector_proposal_materializable(fluid_private.shared_logo_vector_proposals);
drop function if exists fluid_private.shared_logo_vector_proposal_owned_asset_valid(uuid,uuid,jsonb,text);
drop function if exists fluid_private.shared_logo_vector_proposal_payload_shape_valid(jsonb,jsonb);
drop function if exists fluid_private.shared_logo_vector_proposal_payload_valid(jsonb,jsonb);
drop function if exists fluid_private.shared_logo_vector_proposal_pending_reason(public.jobs,jsonb,jsonb);
drop function if exists fluid_private.shared_logo_vector_proposal_quote_binding(public.logo_cost_quotes);
drop function if exists fluid_private.shared_logo_vector_proposal_result_valid(jsonb,jsonb,jsonb);
drop function if exists fluid_private.shared_storage_auth_context();
drop function if exists fluid_private.shared_storage_execution(jsonb,uuid,uuid,uuid,uuid,boolean);
drop function if exists fluid_private.shared_storage_identity_bound();
drop function if exists fluid_private.shared_storage_object_allowed(text,text,text,text);
drop function if exists fluid_private.shared_storage_operation_member(public.jobs,public.logo_asset_publications,text);
drop function if exists fluid_private.shared_storage_operation_policy_matches(public.jobs,jsonb);
drop function if exists fluid_private.shared_storage_operation_policy(public.jobs);
drop function if exists fluid_private.shared_storage_slot_ready(uuid);
drop function if exists fluid_private.shared_strategy_descriptor(public.jobs,fluid_private.api_text_dispatches);
drop function if exists fluid_private.shared_strategy_legacy_descriptor(public.jobs,fluid_private.api_text_dispatches);
drop function if exists fluid_private.shared_strategy_legacy_runtime(text,jsonb,text);
drop function if exists fluid_private.shared_strategy_policy_available(uuid,uuid,text,jsonb,text);
drop function if exists fluid_private.shared_strategy_uncapped_context(uuid,uuid,text,integer,text,jsonb,text,bigint,integer);
drop function if exists fluid_private.shared_worker_admission_active(uuid);
drop function if exists fluid_private.shared_worker_base_lock_leased_job(uuid,uuid);
drop function if exists fluid_private.shared_worker_claimable(jsonb,uuid);
drop function if exists fluid_private.shared_worker_context_execution(text);
drop function if exists fluid_private.shared_worker_context_mode(text);
drop function if exists fluid_private.shared_worker_execution_json(fluid_private.shared_worker_executions);
drop function if exists fluid_private.shared_worker_execution(jsonb,jsonb,text);
drop function if exists fluid_private.shared_worker_legacy_lock_leased_job_v1(uuid,uuid);
drop function if exists fluid_private.shared_worker_role_safe(name,oid);
drop function if exists fluid_private.shared_worker_slot_json(fluid_private.shared_worker_slots);
drop function if exists fluid_private.stage_logo_vector_publication(uuid,uuid,jsonb);
drop function if exists fluid_private.standalone_current_import(uuid,uuid);
drop function if exists fluid_private.standalone_domain(text);
drop function if exists fluid_private.standalone_names_availability(uuid);
drop function if exists fluid_private.standalone_names_dto(public.standalone_name_jobs);
drop function if exists fluid_private.standalone_names_keys(jsonb,text[]);
drop function if exists fluid_private.standalone_names_text(jsonb,integer,integer);
drop function if exists fluid_private.standalone_payload(text,jsonb);
drop function if exists fluid_private.standalone_record(uuid,uuid);
drop function if exists fluid_private.subscription_strategy_route(uuid,text);
drop function if exists public.admit_logo_operation(uuid,jsonb);
drop function if exists public.api_text_dispatch_action(jsonb,text,jsonb);
drop function if exists public.api_text_multi_account_readiness(jsonb,text);
drop function if exists public.api_text_worker_can_read_step(uuid,uuid);
drop function if exists public.append_subscription_partial(uuid,uuid,text);
drop function if exists public.apply_strategy_job_result_v2(uuid,uuid,integer,text);
drop function if exists public.apply_strategy_job_result(uuid,uuid,integer,text);
drop function if exists public.attach_idea_to_project(jsonb);
drop function if exists public.authorize_api_text_dispatch(uuid,uuid,text,text,text);
drop function if exists public.authorize_logo_generative_storage(uuid,uuid,uuid,text);
drop function if exists public.authorize_logo_storage_reservation(uuid,uuid,uuid);
drop function if exists public.authorize_shared_logo_storage(uuid,uuid,uuid,uuid,uuid,text);
drop function if exists public.begin_job_step(uuid,uuid,text,text,bigint);
drop function if exists public.begin_logo_job_step(uuid,uuid,text,text,bigint);
drop function if exists public.cancel_logo_vector_edit(uuid,jsonb);
drop function if exists public.cancel_shared_identity_batch(uuid,uuid);
drop function if exists public.cancel_standalone_names(uuid);
drop function if exists public.check_api_text_runtime(text,jsonb,text);
drop function if exists public.claim_api_text_job(uuid,text,integer,text,text);
drop function if exists public.claim_job(text,integer);
drop function if exists public.claim_logo_job(text,integer);
drop function if exists public.claim_shared_worker_slot(uuid,uuid,text,integer);
drop function if exists public.claim_standalone_names(jsonb);
drop function if exists public.claim_subscription_job(text,uuid,text,integer);
drop function if exists public.close_logo_vector_proposal_request(uuid,jsonb);
drop function if exists public.close_shared_identity_generation_intent(uuid,jsonb);
drop function if exists public.complete_job_step(uuid,uuid,text,text,bigint,jsonb,text);
drop function if exists public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text);
drop function if exists public.configure_subscription_runtime(uuid,jsonb);
drop function if exists public.configure_subscription_runtime(uuid,text,jsonb,boolean);
drop function if exists public.create_idea_brand(uuid,integer,uuid,jsonb,text);
drop function if exists public.create_idea(uuid,jsonb);
drop function if exists public.disable_subscription_runtime(uuid,text);
drop function if exists public.enqueue_job(uuid,uuid,text,integer,text,jsonb,text,bigint,integer);
drop function if exists public.enqueue_local_strategy_job(uuid,integer,text,text,bigint);
drop function if exists public.enqueue_shared_strategy_job(uuid,integer,text,text,text);
drop function if exists public.enqueue_standalone_names(jsonb);
drop function if exists public.enqueue_strategy_job(uuid,integer,text,text,bigint);
drop function if exists public.enqueue_subscription_strategy_job(uuid,integer,text,text,text);
drop function if exists public.ensure_shared_account_enrollment();
drop function if exists public.ensure_shared_identity_batch(uuid,jsonb);
drop function if exists public.expand_project_scope(uuid,integer);
drop function if exists public.expire_api_text_job(uuid);
drop function if exists public.expire_job_leases();
drop function if exists public.expire_logo_job_leases();
drop function if exists public.fence_shared_worker_slot(jsonb);
drop function if exists public.finish_job(uuid,uuid,text,text);
drop function if exists public.finish_logo_job(uuid,uuid,text);
drop function if exists public.finish_standalone_names(uuid,uuid,text,jsonb,text,text);
drop function if exists public.get_api_strategy_availability(uuid);
drop function if exists public.get_api_text_dispatch(uuid);
drop function if exists public.get_idea(uuid);
drop function if exists public.get_local_strategy_availability(uuid);
drop function if exists public.get_names_workspace();
drop function if exists public.get_project_idea_attachments(uuid,uuid,integer);
drop function if exists public.get_project_idea_source(uuid);
drop function if exists public.get_shared_account_enrollment();
drop function if exists public.get_shared_identity_availability(uuid);
drop function if exists public.get_shared_strategy_availability(uuid);
drop function if exists public.get_standalone_import(uuid);
drop function if exists public.get_standalone_name_job(uuid);
drop function if exists public.get_standalone_names(timestamp with time zone,uuid);
drop function if exists public.get_standalone_promotion_snapshot(uuid);
drop function if exists public.get_standalone_promotion_source(uuid);
drop function if exists public.get_standalone_workspace(text);
drop function if exists public.get_strategy_availability(uuid);
drop function if exists public.get_strategy_job_deliveries(uuid,uuid[]);
drop function if exists public.get_subscription_runtime_bindings();
drop function if exists public.heartbeat_job(uuid,uuid,integer);
drop function if exists public.heartbeat_logo_job(uuid,uuid,integer);
drop function if exists public.list_api_text_dispatches_v2(integer);
drop function if exists public.list_ideas(timestamp with time zone,uuid,integer,text,text);
drop function if exists public.list_logo_project_creations(jsonb);
drop function if exists public.list_logo_vector_history(uuid,jsonb);
drop function if exists public.list_logo_vector_proposals(uuid,jsonb);
drop function if exists public.list_pending_api_text_dispatches(integer);
drop function if exists public.list_pending_logo_vector_proposal_requests(uuid,uuid,integer);
drop function if exists public.list_shared_strategy_dispatches(jsonb,integer);
drop function if exists public.load_logo_direction_inputs(uuid,uuid);
drop function if exists public.load_logo_export_inputs(uuid,uuid);
drop function if exists public.local_logo_operation(uuid,text,jsonb);
drop function if exists public.local_strategy_job_action(uuid,text,jsonb);
drop function if exists public.logo_storage_session();
drop function if exists public.mark_api_text_published(uuid,text,integer,text);
drop function if exists public.prepare_api_text_redrive(uuid,text,integer);
drop function if exists public.promote_standalone_workspace(jsonb);
drop function if exists public.pulse_standalone_names(uuid,uuid,boolean,text);
drop function if exists public.quote_logo_operation(uuid,jsonb);
drop function if exists public.read_idea_project_attachment_request(uuid);
drop function if exists public.read_leased_logo_record(uuid,uuid,text,jsonb);
drop function if exists public.read_local_strategy_steps(uuid,uuid,uuid,text);
drop function if exists public.read_logo_capabilities(uuid);
drop function if exists public.read_logo_project_creation(uuid);
drop function if exists public.read_logo_style_note_jobs(uuid);
drop function if exists public.read_logo_vector_edit_request(uuid,uuid);
drop function if exists public.read_logo_vector_proposal_application(uuid,uuid);
drop function if exists public.read_logo_vector_proposal_request(uuid,jsonb);
drop function if exists public.read_logo_vector_proposal(uuid,uuid);
drop function if exists public.read_shared_worker_execution_page(jsonb,uuid,integer);
drop function if exists public.read_shared_worker_executions(jsonb);
drop function if exists public.read_standalone_promotion_request(uuid);
drop function if exists public.reconcile_logo_request(uuid,uuid);
drop function if exists public.record_logo_provider_response(uuid,uuid,jsonb);
drop function if exists public.refine_identity_component(uuid,jsonb);
drop function if exists public.register_job_plan(uuid,uuid,jsonb);
drop function if exists public.register_logo_job_plan(uuid,uuid,jsonb);
drop function if exists public.release_shared_worker_slot(jsonb);
drop function if exists public.renew_shared_worker_slot(jsonb,integer);
drop function if exists public.report_job_progress(uuid,uuid,integer);
drop function if exists public.report_logo_worker_ready(text,jsonb,integer);
drop function if exists public.report_standalone_names_ready(jsonb);
drop function if exists public.report_strategy_worker_ready(text,jsonb,integer);
drop function if exists public.report_subscription_worker_ready(uuid,text,text,jsonb,integer);
drop function if exists public.request_logo_export(uuid,jsonb);
drop function if exists public.retain_standalone_name(uuid,integer,boolean,boolean);
drop function if exists public.save_names_workspace(integer,uuid,jsonb);
drop function if exists public.save_standalone_workspace(text,integer,uuid,jsonb,jsonb);
drop function if exists public.select_identity_system(uuid,jsonb);
drop function if exists public.shared_logo_operation(uuid,text,jsonb);
drop function if exists public.shared_logo_storage_session_closed();
drop function if exists public.shared_logo_storage_session();
drop function if exists public.shared_logo_worker_action(jsonb,jsonb,text,jsonb);
drop function if exists public.shared_naming_worker_action(jsonb,jsonb,text,jsonb);
drop function if exists public.shared_strategy_worker_action(jsonb,jsonb,text,jsonb);
drop function if exists public.shared_worker_pool_configuration();
drop function if exists public.stage_logo_directions(uuid,uuid,jsonb,uuid,jsonb);
drop function if exists public.stage_logo_exports(uuid,uuid,jsonb);
drop function if exists public.start_logo_project(jsonb);
drop function if exists public.start_naming_run(uuid,jsonb);
drop function if exists public.stop_naming_run(uuid);
drop function if exists public.subscription_worker_can_read_step(uuid,uuid);
drop function if exists public.update_idea(uuid,integer,uuid,jsonb);
drop function if exists fluid_private.save_names_workspace(integer,uuid,jsonb);

-- 6. Tables, in dependency order. A few functions that check constraints or column
--    types of these tables use are dropped between them.
drop table if exists fluid_private.api_strategy_bindings;
drop table if exists fluid_private.api_text_allowance_rollout;
drop table if exists fluid_private.api_text_background_responses;
drop table if exists fluid_private.api_text_operator_adjudications;
drop table if exists fluid_private.api_text_testing_access;
drop table if exists fluid_private.api_text_testing_admission_context;
drop table if exists fluid_private.api_text_testing_admissions;
drop table if exists fluid_private.local_prototype_admission_context;
drop table if exists fluid_private.logo_generative_storage_capabilities;
drop table if exists fluid_private.logo_local_capabilities;
drop table if exists fluid_private.logo_local_context;
drop table if exists fluid_private.logo_storage_grants;
drop table if exists fluid_private.names_workspace_requests;
drop table if exists fluid_private.shared_identity_prepared;
drop table if exists fluid_private.shared_identity_specification_cancellations;
drop table if exists fluid_private.shared_logo_admission_context;
drop table if exists fluid_private.shared_logo_advanced_quotes;
drop table if exists fluid_private.shared_logo_export_resolutions;
drop table if exists fluid_private.shared_logo_output_observations;
drop table if exists fluid_private.shared_logo_proposal_request_closures;
drop table if exists fluid_private.shared_logo_raster_recoveries;
drop table if exists fluid_private.shared_logo_slot_runtime_readiness;
drop table if exists fluid_private.shared_logo_vector_proposal_dispatches;
drop table if exists fluid_private.shared_logo_vector_proposal_materializations;
drop table if exists fluid_private.shared_logo_vector_proposal_prepared_results;
drop table if exists fluid_private.shared_storage_grants;
drop table if exists fluid_private.shared_storage_target;
drop table if exists fluid_private.shared_strategy_admission_context;
drop table if exists fluid_private.shared_strategy_observed_outcomes;
drop table if exists fluid_private.shared_strategy_observed_responses;
drop table if exists fluid_private.standalone_names_runtime;
drop table if exists public.idea_brand_links;
drop table if exists public.idea_project_attachment_requests;
drop table if exists public.logo_style_notes;
drop table if exists public.standalone_promotions;
drop table if exists public.strategy_job_applications;

drop function if exists fluid_private.api_text_operation(text);
drop function if exists fluid_private.shared_logo_advanced_policy_valid(text,jsonb);

drop table if exists fluid_private.api_text_allowance_admissions;
drop table if exists fluid_private.api_text_owner_entitlements;
drop table if exists fluid_private.shared_logo_vector_proposals;
drop table if exists fluid_private.shared_storage_actors;
drop table if exists public.idea_project_attachments;
drop table if exists public.names_workspaces;
drop table if exists fluid_private.api_text_allowance_cohorts;
drop table if exists public.standalone_workspaces, public.standalone_workspace_revisions;

-- 7. Old worker logins: the fixed worker logins, every shared-worker slot login
--    (embel_shared_strategy_*, embel_shared_naming_*, embel_shared_logo_*, including the
--    names in the slot registry), and the logins registered for the old Strategy,
--    subscription and Logo workers. The web lanes' logins (embel_shared_http_*,
--    embel_identity_web_*, embel_home_web_*), embel_engine, embel_account_role_manager and
--    fluid_identity_writer_definer_v1 stay. A login that owns anything stops the migration.
--    postgres created these logins, so it holds ADMIN on them; it takes their privileges
--    only for DROP OWNED, which here just revokes what was granted to them.
do $$
declare
  login name;
  registry text;
  registered name[] := '{}';
  web name[] := '{}';
  found_names name[];
begin
  -- Registries that only exist where the shared or old worker packets were installed.
  foreach registry in array array['fluid_private.shared_worker_slots', 'fluid_private.api_text_worker_principals',
    'fluid_private.subscription_worker_principals', 'fluid_private.logo_worker_principals'] loop
    if to_regclass(registry) is not null then
      execute format('select coalesce(array_agg(role_name::name), ''{}'') from %s', registry) into found_names;
      registered := registered || found_names;
    end if;
  end loop;
  foreach registry in array array['fluid_private.shared_http_principals', 'fluid_private.shared_logo_http_principals'] loop
    if to_regclass(registry) is not null then
      execute format('select coalesce(array_agg(role_name::name), ''{}'') from %s', registry) into found_names;
      web := web || found_names;
    end if;
  end loop;
  for login in
    select r.rolname from pg_catalog.pg_roles r
    where r.rolname = any(array['embel_development_logo_worker', 'embel_development_text_worker', 'fluid_api_text_worker', 'fluid_local_worker', 'fluid_logo_worker', 'fluid_naming_brain_worker']::name[])
      or r.rolname ~ '^embel_shared_(strategy|naming|logo)_[a-z0-9_]+$'
      or r.rolname = any(registered)
    order by 1
  loop
    if login in ('postgres', 'embel_engine', 'embel_account_role_manager', 'fluid_identity_writer_definer_v1', 'authenticator', 'anon', 'authenticated', 'service_role')
      or login ~ '^(embel_shared_http_|embel_identity_web_|embel_home_web_|supabase|pg_)'
      or login = any(web)
    then
      raise exception 'retired_login_is_protected: %', login;
    end if;
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = login and (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolreplication)) then
      raise exception 'retired_login_is_privileged: %', login;
    end if;
    if exists (select 1 from pg_catalog.pg_class where relowner = to_regrole(login))
      or exists (select 1 from pg_catalog.pg_proc where proowner = to_regrole(login))
      or exists (select 1 from pg_catalog.pg_namespace where nspowner = to_regrole(login))
      or exists (select 1 from pg_catalog.pg_type where typowner = to_regrole(login))
    then
      raise exception 'retired_login_owns_objects: %', login;
    end if;
    execute format('grant %I to current_user with inherit true, set false', login);
    execute format('drop owned by %I', login);
    execute format('drop role %I', login);
  end loop;
end $$;

-- 8. Check: no function or table with a retired name is left (another overload made by
--    SQL outside this repository, for example), and no retired login.
do $$
declare
  leftover text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into leftover
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace s on s.oid = p.pronamespace
  where s.nspname || '.' || p.proname = any(array[
    'fluid_private.admit_shared_worker_job',
    'fluid_private.api_text_allowance_available',
    'fluid_private.api_text_allowance_paused',
    'fluid_private.api_text_background_action',
    'fluid_private.api_text_background_control',
    'fluid_private.api_text_bounded_policy',
    'fluid_private.api_text_deleted_strategy_quarantined',
    'fluid_private.api_text_deleted_strategy_runtime_quarantined',
    'fluid_private.api_text_descriptor',
    'fluid_private.api_text_descriptor_owner',
    'fluid_private.api_text_legacy_policy_allowed',
    'fluid_private.api_text_operation',
    'fluid_private.api_text_paid_paused',
    'fluid_private.api_text_policy_allowed',
    'fluid_private.api_text_project_allowance_available',
    'fluid_private.api_text_project_allowance_paused',
    'fluid_private.api_text_project_policy_allowed',
    'fluid_private.api_text_quarantine_worker_ready',
    'fluid_private.api_text_request_policy',
    'fluid_private.api_text_strategy_outcome_resolved',
    'fluid_private.api_text_strategy_paused',
    'fluid_private.api_text_strategy_runtime_paused',
    'fluid_private.api_text_testing_enabled',
    'fluid_private.api_text_testing_enqueue_matches',
    'fluid_private.api_text_testing_gateway_matches',
    'fluid_private.api_text_testing_gateway_project',
    'fluid_private.api_text_testing_job_allowed',
    'fluid_private.api_text_testing_project_scope',
    'fluid_private.bind_shared_worker_execution',
    'fluid_private.claim_local_strategy_job',
    'fluid_private.close_shared_worker_execution',
    'fluid_private.commit_logo_asset_publication',
    'fluid_private.commit_logo_vector_proposal',
    'fluid_private.complete_job_step_core',
    'fluid_private.complete_logo_vector_proposal_step',
    'fluid_private.enqueue_strategy_job_legacy',
    'fluid_private.ensure_naming_brain_receipt_totals',
    'fluid_private.enter_shared_worker_claim_context',
    'fluid_private.enter_shared_worker_context',
    'fluid_private.expire_local_strategy_leases',
    'fluid_private.get_api_strategy_availability_legacy',
    'fluid_private.guided_api_strategy_input',
    'fluid_private.handles_search_payload',
    'fluid_private.handles_search_preset',
    'fluid_private.hosted_naming_context',
    'fluid_private.hosted_naming_job_enabled',
    'fluid_private.hosted_naming_owner_enabled',
    'fluid_private.hosted_naming_step_authority',
    'fluid_private.idea_content',
    'fluid_private.idea_link_json',
    'fluid_private.idea_project_context_text',
    'fluid_private.idea_record',
    'fluid_private.identity_mutation_context',
    'fluid_private.identity_request',
    'fluid_private.identity_write_selection',
    'fluid_private.latest_naming_brain_receipt',
    'fluid_private.leave_shared_worker_context',
    'fluid_private.lifecycle_revision',
    'fluid_private.lifecycle_uuid',
    'fluid_private.local_naming_previous_authorize',
    'fluid_private.local_naming_previous_call_terminal',
    'fluid_private.local_naming_previous_can_resume',
    'fluid_private.local_naming_previous_complete',
    'fluid_private.local_naming_previous_ensure_response',
    'fluid_private.local_naming_previous_feed',
    'fluid_private.local_naming_previous_preparation_pending',
    'fluid_private.local_naming_previous_run',
    'fluid_private.local_naming_previous_source',
    'fluid_private.local_naming_previous_summary',
    'fluid_private.local_naming_previous_worker_action',
    'fluid_private.local_naming_progressive_action',
    'fluid_private.local_naming_progressive_authorize',
    'fluid_private.local_naming_progressive_basis',
    'fluid_private.local_naming_progressive_counts',
    'fluid_private.local_naming_progressive_current',
    'fluid_private.local_naming_progressive_researched',
    'fluid_private.local_naming_progressive_saved_resume',
    'fluid_private.local_naming_progressive_state',
    'fluid_private.local_naming_publish_microbatch',
    'fluid_private.local_prototype_job_worker',
    'fluid_private.local_prototype_paid_paused',
    'fluid_private.local_prototype_project_paused',
    'fluid_private.local_prototype_unlimited_context',
    'fluid_private.local_strategy_job_ready',
    'fluid_private.local_strategy_worker_owner',
    'fluid_private.lock_leased_job',
    'fluid_private.lock_local_strategy_job',
    'fluid_private.lock_logo_job_readiness',
    'fluid_private.lock_logo_vector_proposal_dispatch',
    'fluid_private.lock_shared_worker_slot',
    'fluid_private.logo_commit_direction_publication',
    'fluid_private.logo_commit_export_publication',
    'fluid_private.logo_commit_vector_publication',
    'fluid_private.logo_direction_checks_valid',
    'fluid_private.logo_direction_group_valid',
    'fluid_private.logo_directions_storage_job',
    'fluid_private.logo_directions_storage_member',
    'fluid_private.logo_directions_storage_object_allowed',
    'fluid_private.logo_export_expected_files',
    'fluid_private.logo_export_group_valid',
    'fluid_private.logo_freeze_direction_inputs',
    'fluid_private.logo_generative_storage_job',
    'fluid_private.logo_generative_storage_member',
    'fluid_private.logo_generative_storage_object_allowed',
    'fluid_private.logo_job_policy_matches',
    'fluid_private.logo_job_ready',
    'fluid_private.logo_local_context_allowed',
    'fluid_private.logo_local_enabled',
    'fluid_private.logo_local_job_allowed',
    'fluid_private.logo_local_project_clear',
    'fluid_private.logo_lock_job',
    'fluid_private.logo_operation_ready',
    'fluid_private.logo_policy_descriptor',
    'fluid_private.logo_prepare_direction_sources',
    'fluid_private.logo_prepare_direction_sources_before_visual_direction',
    'fluid_private.logo_production_storage_job',
    'fluid_private.logo_production_storage_member',
    'fluid_private.logo_production_storage_object_allowed',
    'fluid_private.logo_publication_failure_adjudication_matches',
    'fluid_private.logo_response_identity_complete',
    'fluid_private.logo_storage_context',
    'fluid_private.logo_storage_identity_bound',
    'fluid_private.logo_storage_object_allowed',
    'fluid_private.logo_storage_reservation_live',
    'fluid_private.logo_subscription_observation_valid',
    'fluid_private.logo_subscription_quota_available',
    'fluid_private.logo_subscription_registration_ready',
    'fluid_private.logo_trace_settings_valid',
    'fluid_private.logo_vector_edit_cancel_command_valid',
    'fluid_private.logo_vector_edit_request_state',
    'fluid_private.logo_vector_proposal_application_command_valid',
    'fluid_private.logo_vector_proposal_basis_current',
    'fluid_private.logo_vector_proposal_job_quote_matches',
    'fluid_private.logo_vector_proposal_materializable',
    'fluid_private.logo_vector_proposal_owned_asset_valid',
    'fluid_private.logo_vector_proposal_payload_shape_valid',
    'fluid_private.logo_vector_proposal_payload_valid',
    'fluid_private.logo_vector_proposal_pending_reason',
    'fluid_private.logo_vector_proposal_quote_binding',
    'fluid_private.logo_vector_proposal_quote_current',
    'fluid_private.logo_vector_proposal_result_valid',
    'fluid_private.names_workspace_input',
    'fluid_private.names_workspace_payload',
    'fluid_private.names_workspace_text',
    'fluid_private.names_workspace_uuid',
    'fluid_private.naming_brain_accounting',
    'fluid_private.naming_brain_artifact_output_matches',
    'fluid_private.naming_brain_available',
    'fluid_private.naming_brain_call_completed',
    'fluid_private.naming_brain_call_failed',
    'fluid_private.naming_brain_call_terminal',
    'fluid_private.naming_brain_can_resume',
    'fluid_private.naming_brain_cap',
    'fluid_private.naming_brain_counter',
    'fluid_private.naming_brain_cursor',
    'fluid_private.naming_brain_ensure_response',
    'fluid_private.naming_brain_free_resume',
    'fluid_private.naming_brain_head',
    'fluid_private.naming_brain_invalid_output',
    'fluid_private.naming_brain_json_matches',
    'fluid_private.naming_brain_legacy_lock',
    'fluid_private.naming_brain_local_not_dispatched',
    'fluid_private.naming_brain_lock',
    'fluid_private.naming_brain_observable',
    'fluid_private.naming_brain_paid_paused',
    'fluid_private.naming_brain_paid_resume',
    'fluid_private.naming_brain_preparation_pending',
    'fluid_private.naming_brain_preparation_recovery',
    'fluid_private.naming_brain_prepare',
    'fluid_private.naming_brain_ready',
    'fluid_private.naming_brain_ready_preferences',
    'fluid_private.naming_brain_reconcile',
    'fluid_private.naming_brain_rejected_receipt',
    'fluid_private.naming_brain_request_key',
    'fluid_private.naming_brain_run_worker',
    'fluid_private.naming_brain_saved_usable',
    'fluid_private.naming_brain_summary',
    'fluid_private.naming_brain_unlimited_context',
    'fluid_private.naming_brain_uuid',
    'fluid_private.naming_brain_valid_intent',
    'fluid_private.naming_brain_visible_text',
    'fluid_private.naming_expire_job',
    'fluid_private.naming_finish_job',
    'fluid_private.naming_progressive_provider_cap',
    'fluid_private.naming_round_json',
    'fluid_private.naming_worker_attest_core',
    'fluid_private.naming_worker_claim_core',
    'fluid_private.naming_worker_claim_pending',
    'fluid_private.naming_worker_context',
    'fluid_private.naming_worker_expiry_core',
    'fluid_private.naming_worker_expiry_pending',
    'fluid_private.naming_worker_job_ready',
    'fluid_private.naming_worker_ready_core',
    'fluid_private.naming_worker_scope',
    'fluid_private.naming_worker_status_json',
    'fluid_private.park_shared_worker_execution',
    'fluid_private.quote_logo_vector_proposal',
    'fluid_private.read_leased_logo_vector_revision',
    'fluid_private.record_logo_vector_proposal_response',
    'fluid_private.record_research_operator_adjudication',
    'fluid_private.reject_logo_admission',
    'fluid_private.reject_logo_export_admission',
    'fluid_private.report_local_strategy_ready',
    'fluid_private.research_operator_adjudication_matches',
    'fluid_private.retain_logo_vector_proposal',
    'fluid_private.save_names_workspace',
    'fluid_private.set_strategy_billing_route',
    'fluid_private.shared_identity_asset_shape',
    'fluid_private.shared_identity_authorize',
    'fluid_private.shared_identity_cancel_known_specification',
    'fluid_private.shared_identity_complete',
    'fluid_private.shared_identity_context',
    'fluid_private.shared_identity_finish',
    'fluid_private.shared_identity_input',
    'fluid_private.shared_identity_manifest_shape',
    'fluid_private.shared_identity_observation_valid',
    'fluid_private.shared_identity_observe_asset',
    'fluid_private.shared_identity_policy',
    'fluid_private.shared_identity_prepare_asset',
    'fluid_private.shared_identity_previous_logo_gateway',
    'fluid_private.shared_identity_read_asset',
    'fluid_private.shared_identity_receipt_complete',
    'fluid_private.shared_identity_receipt_json',
    'fluid_private.shared_identity_record_receipt',
    'fluid_private.shared_identity_runtime_ready',
    'fluid_private.shared_identity_stage',
    'fluid_private.shared_identity_storage_member',
    'fluid_private.shared_identity_system_id',
    'fluid_private.shared_logo_admit_advanced',
    'fluid_private.shared_logo_admit_vector',
    'fluid_private.shared_logo_advanced_action',
    'fluid_private.shared_logo_advanced_job_matches',
    'fluid_private.shared_logo_advanced_policy_valid',
    'fluid_private.shared_logo_advanced_quote_binding',
    'fluid_private.shared_logo_advanced_quote_current',
    'fluid_private.shared_logo_apply_proposal_command',
    'fluid_private.shared_logo_begin_job',
    'fluid_private.shared_logo_claim_job',
    'fluid_private.shared_logo_commit_direction_publication',
    'fluid_private.shared_logo_commit_vector_proposal',
    'fluid_private.shared_logo_complete_directions',
    'fluid_private.shared_logo_complete_proposal',
    'fluid_private.shared_logo_complete_style_note',
    'fluid_private.shared_logo_context_allowed',
    'fluid_private.shared_logo_create_raster_jobs',
    'fluid_private.shared_logo_direction_storage_member',
    'fluid_private.shared_logo_directions_observation_valid',
    'fluid_private.shared_logo_job_context',
    'fluid_private.shared_logo_json_arg',
    'fluid_private.shared_logo_legacy_cancel_command_valid',
    'fluid_private.shared_logo_legacy_edit_request_state',
    'fluid_private.shared_logo_legacy_job_ready',
    'fluid_private.shared_logo_legacy_local_context',
    'fluid_private.shared_logo_legacy_local_job',
    'fluid_private.shared_logo_legacy_lock_job',
    'fluid_private.shared_logo_legacy_lock_readiness',
    'fluid_private.shared_logo_legacy_operation_ready',
    'fluid_private.shared_logo_lock_issued_job',
    'fluid_private.shared_logo_lock_vector_proposal_dispatch',
    'fluid_private.shared_logo_policy',
    'fluid_private.shared_logo_policy_valid',
    'fluid_private.shared_logo_project_clear',
    'fluid_private.shared_logo_proposal_request_owner',
    'fluid_private.shared_logo_proposal_request_quote',
    'fluid_private.shared_logo_quote_directions',
    'fluid_private.shared_logo_quote_raster',
    'fluid_private.shared_logo_quote_style_note',
    'fluid_private.shared_logo_quote_vector_proposal',
    'fluid_private.shared_logo_raster_job_matches',
    'fluid_private.shared_logo_raster_observation_valid',
    'fluid_private.shared_logo_raster_policy_valid',
    'fluid_private.shared_logo_raster_quote_binding',
    'fluid_private.shared_logo_read_proposal_asset',
    'fluid_private.shared_logo_read_proposal_command',
    'fluid_private.shared_logo_read_proposal_request',
    'fluid_private.shared_logo_record_response',
    'fluid_private.shared_logo_record_vector_proposal_response',
    'fluid_private.shared_logo_report_runtime_ready',
    'fluid_private.shared_logo_resolve_prepared_export',
    'fluid_private.shared_logo_resolve_raster',
    'fluid_private.shared_logo_response_identity_complete',
    'fluid_private.shared_logo_retain_proposal',
    'fluid_private.shared_logo_runtime_manifest_item_valid',
    'fluid_private.shared_logo_runtime_ready',
    'fluid_private.shared_logo_slot_runtime_ready',
    'fluid_private.shared_logo_stage_proposal',
    'fluid_private.shared_logo_stage_style_note',
    'fluid_private.shared_logo_storage_member',
    'fluid_private.shared_logo_storage_policy',
    'fluid_private.shared_logo_storage_policy_matches',
    'fluid_private.shared_logo_storage_ready',
    'fluid_private.shared_logo_style_note_exists',
    'fluid_private.shared_logo_style_note_observation_valid',
    'fluid_private.shared_logo_style_note_source',
    'fluid_private.shared_logo_style_note_storage_member',
    'fluid_private.shared_logo_style_note_text_policy_valid',
    'fluid_private.shared_logo_valid_vector_proposal_observation',
    'fluid_private.shared_logo_valid_vector_proposal_text_policy',
    'fluid_private.shared_logo_vector_proposal_application_command_valid',
    'fluid_private.shared_logo_vector_proposal_basis_current',
    'fluid_private.shared_logo_vector_proposal_job_quote_matches',
    'fluid_private.shared_logo_vector_proposal_materializable',
    'fluid_private.shared_logo_vector_proposal_owned_asset_valid',
    'fluid_private.shared_logo_vector_proposal_payload_shape_valid',
    'fluid_private.shared_logo_vector_proposal_payload_valid',
    'fluid_private.shared_logo_vector_proposal_pending_reason',
    'fluid_private.shared_logo_vector_proposal_quote_binding',
    'fluid_private.shared_logo_vector_proposal_result_valid',
    'fluid_private.shared_storage_auth_context',
    'fluid_private.shared_storage_execution',
    'fluid_private.shared_storage_identity_bound',
    'fluid_private.shared_storage_object_allowed',
    'fluid_private.shared_storage_operation_member',
    'fluid_private.shared_storage_operation_policy',
    'fluid_private.shared_storage_operation_policy_matches',
    'fluid_private.shared_storage_slot_ready',
    'fluid_private.shared_strategy_descriptor',
    'fluid_private.shared_strategy_legacy_descriptor',
    'fluid_private.shared_strategy_legacy_runtime',
    'fluid_private.shared_strategy_policy_available',
    'fluid_private.shared_strategy_uncapped_context',
    'fluid_private.shared_worker_admission_active',
    'fluid_private.shared_worker_base_lock_leased_job',
    'fluid_private.shared_worker_claimable',
    'fluid_private.shared_worker_context_execution',
    'fluid_private.shared_worker_context_mode',
    'fluid_private.shared_worker_execution',
    'fluid_private.shared_worker_execution_json',
    'fluid_private.shared_worker_legacy_lock_leased_job_v1',
    'fluid_private.shared_worker_role_safe',
    'fluid_private.shared_worker_slot_json',
    'fluid_private.stage_logo_vector_proposal',
    'fluid_private.stage_logo_vector_publication',
    'fluid_private.standalone_current_import',
    'fluid_private.standalone_domain',
    'fluid_private.standalone_names_availability',
    'fluid_private.standalone_names_dto',
    'fluid_private.standalone_names_keys',
    'fluid_private.standalone_names_text',
    'fluid_private.standalone_payload',
    'fluid_private.standalone_record',
    'fluid_private.subscription_strategy_route',
    'fluid_private.valid_logo_vector_proposal_observation',
    'public.admit_logo_operation',
    'public.api_text_dispatch_action',
    'public.api_text_multi_account_readiness',
    'public.api_text_worker_can_read_step',
    'public.append_prepared_naming_set',
    'public.append_subscription_partial',
    'public.apply_strategy_job_result',
    'public.apply_strategy_job_result_v2',
    'public.attach_idea_to_project',
    'public.attest_naming_brain_preferences',
    'public.authorize_api_text_dispatch',
    'public.authorize_logo_directions_storage',
    'public.authorize_logo_generative_storage',
    'public.authorize_logo_production_storage',
    'public.authorize_logo_storage_reservation',
    'public.authorize_naming_brain_dispatch',
    'public.authorize_shared_logo_storage',
    'public.begin_job_step',
    'public.begin_logo_job_step',
    'public.cancel_logo_vector_edit',
    'public.cancel_shared_identity_batch',
    'public.cancel_standalone_names',
    'public.check_api_text_runtime',
    'public.claim_api_text_job',
    'public.claim_job',
    'public.claim_logo_job',
    'public.claim_naming_brain_job',
    'public.claim_shared_worker_slot',
    'public.claim_standalone_names',
    'public.claim_subscription_job',
    'public.close_logo_vector_proposal_request',
    'public.close_shared_identity_generation_intent',
    'public.complete_job_step',
    'public.complete_logo_job_step',
    'public.complete_naming_brain_stage',
    'public.complete_naming_job_step',
    'public.configure_subscription_runtime',
    'public.create_idea',
    'public.create_idea_brand',
    'public.disable_subscription_runtime',
    'public.enqueue_job',
    'public.enqueue_local_strategy_job',
    'public.enqueue_shared_strategy_job',
    'public.enqueue_standalone_names',
    'public.enqueue_strategy_job',
    'public.enqueue_subscription_naming_job',
    'public.enqueue_subscription_strategy_job',
    'public.ensure_hosted_naming_brain_run',
    'public.ensure_local_naming_brain_run',
    'public.ensure_naming_brain_run',
    'public.ensure_shared_account_enrollment',
    'public.ensure_shared_identity_batch',
    'public.expand_project_scope',
    'public.expire_api_text_job',
    'public.expire_job_leases',
    'public.expire_logo_job_leases',
    'public.expire_naming_brain_leases',
    'public.fence_shared_worker_slot',
    'public.finish_job',
    'public.finish_logo_job',
    'public.finish_standalone_names',
    'public.get_api_strategy_availability',
    'public.get_api_text_dispatch',
    'public.get_hosted_naming_availability',
    'public.get_idea',
    'public.get_local_strategy_availability',
    'public.get_names_workspace',
    'public.get_naming_brain_candidate_source',
    'public.get_naming_brain_candidate_sources',
    'public.get_naming_brain_job_accounting',
    'public.get_naming_brain_preference_work',
    'public.get_naming_brain_run',
    'public.get_naming_feed',
    'public.get_project_idea_attachments',
    'public.get_project_idea_source',
    'public.get_shared_account_enrollment',
    'public.get_shared_identity_availability',
    'public.get_shared_strategy_availability',
    'public.get_standalone_import',
    'public.get_standalone_name_job',
    'public.get_standalone_names',
    'public.get_standalone_promotion_snapshot',
    'public.get_standalone_promotion_source',
    'public.get_standalone_workspace',
    'public.get_strategy_availability',
    'public.get_strategy_job_deliveries',
    'public.get_subscription_runtime_bindings',
    'public.heartbeat_job',
    'public.heartbeat_logo_job',
    'public.list_api_text_dispatches_v2',
    'public.list_ideas',
    'public.list_logo_project_creations',
    'public.list_logo_vector_history',
    'public.list_logo_vector_proposals',
    'public.list_pending_api_text_dispatches',
    'public.list_pending_logo_vector_proposal_requests',
    'public.list_shared_strategy_dispatches',
    'public.load_logo_direction_inputs',
    'public.load_logo_export_inputs',
    'public.local_logo_operation',
    'public.local_strategy_job_action',
    'public.logo_storage_session',
    'public.mark_api_text_published',
    'public.naming_brain_worker_action',
    'public.naming_brain_worker_maintenance_v2',
    'public.prepare_api_text_redrive',
    'public.promote_standalone_workspace',
    'public.pulse_standalone_names',
    'public.quote_logo_operation',
    'public.read_idea_project_attachment_request',
    'public.read_leased_logo_record',
    'public.read_local_strategy_steps',
    'public.read_logo_capabilities',
    'public.read_logo_project_creation',
    'public.read_logo_style_note_jobs',
    'public.read_logo_vector_edit_request',
    'public.read_logo_vector_proposal',
    'public.read_logo_vector_proposal_application',
    'public.read_logo_vector_proposal_request',
    'public.read_shared_worker_execution_page',
    'public.read_shared_worker_executions',
    'public.read_standalone_promotion_request',
    'public.reconcile_logo_request',
    'public.record_logo_provider_response',
    'public.record_naming_brain_provider_receipt',
    'public.refine_identity_component',
    'public.register_job_plan',
    'public.register_logo_job_plan',
    'public.release_shared_worker_slot',
    'public.renew_shared_worker_slot',
    'public.report_job_progress',
    'public.report_logo_worker_ready',
    'public.report_naming_brain_worker_ready',
    'public.report_naming_brain_worker_status',
    'public.report_standalone_names_ready',
    'public.report_strategy_worker_ready',
    'public.report_subscription_worker_ready',
    'public.request_logo_export',
    'public.retain_standalone_name',
    'public.save_names_workspace',
    'public.save_standalone_workspace',
    'public.select_identity_system',
    'public.shared_logo_operation',
    'public.shared_logo_storage_session',
    'public.shared_logo_storage_session_closed',
    'public.shared_logo_worker_action',
    'public.shared_naming_worker_action',
    'public.shared_strategy_worker_action',
    'public.shared_worker_pool_configuration',
    'public.stage_logo_directions',
    'public.stage_logo_exports',
    'public.start_logo_project',
    'public.start_naming_run',
    'public.steer_naming_feed',
    'public.stop_naming_feed',
    'public.stop_naming_run',
    'public.subscription_worker_can_read_step',
    'public.update_idea'
  ]);
  if leftover is not null then raise exception 'retired_functions_left: %', leftover; end if;
  select string_agg(s.nspname || '.' || c.relname, ', ') into leftover
  from pg_catalog.pg_class c join pg_catalog.pg_namespace s on s.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'f') and s.nspname || '.' || c.relname = any(array[
    'fluid_private.api_strategy_bindings',
    'fluid_private.api_text_allowance_admissions',
    'fluid_private.api_text_allowance_cohorts',
    'fluid_private.api_text_allowance_rollout',
    'fluid_private.api_text_background_responses',
    'fluid_private.api_text_operator_adjudications',
    'fluid_private.api_text_owner_entitlements',
    'fluid_private.api_text_testing_access',
    'fluid_private.api_text_testing_admission_context',
    'fluid_private.api_text_testing_admissions',
    'fluid_private.hosted_naming_admission_context',
    'fluid_private.local_prototype_admission_context',
    'fluid_private.logo_directions_storage_capabilities',
    'fluid_private.logo_directions_storage_grants',
    'fluid_private.logo_generative_storage_capabilities',
    'fluid_private.logo_local_capabilities',
    'fluid_private.logo_local_context',
    'fluid_private.logo_production_storage_capabilities',
    'fluid_private.logo_production_storage_grants',
    'fluid_private.logo_storage_grants',
    'fluid_private.logo_vector_proposal_dispatches',
    'fluid_private.logo_vector_proposal_materializations',
    'fluid_private.logo_vector_proposal_prepared_results',
    'fluid_private.logo_vector_proposals',
    'fluid_private.names_workspace_requests',
    'fluid_private.naming_brain_artifacts',
    'fluid_private.naming_brain_feed_entries',
    'fluid_private.naming_brain_identity_index',
    'fluid_private.naming_brain_intents',
    'fluid_private.naming_brain_progressive_plans',
    'fluid_private.naming_brain_provider_records',
    'fluid_private.naming_brain_stage_results',
    'fluid_private.naming_observation_recovery_audit',
    'fluid_private.naming_worker_gateway_context',
    'fluid_private.naming_worker_job_authority',
    'fluid_private.naming_worker_leadership',
    'fluid_private.shared_identity_prepared',
    'fluid_private.shared_identity_specification_cancellations',
    'fluid_private.shared_logo_admission_context',
    'fluid_private.shared_logo_advanced_quotes',
    'fluid_private.shared_logo_export_resolutions',
    'fluid_private.shared_logo_output_observations',
    'fluid_private.shared_logo_proposal_request_closures',
    'fluid_private.shared_logo_raster_recoveries',
    'fluid_private.shared_logo_slot_runtime_readiness',
    'fluid_private.shared_logo_vector_proposal_dispatches',
    'fluid_private.shared_logo_vector_proposal_materializations',
    'fluid_private.shared_logo_vector_proposal_prepared_results',
    'fluid_private.shared_logo_vector_proposals',
    'fluid_private.shared_storage_actors',
    'fluid_private.shared_storage_grants',
    'fluid_private.shared_storage_target',
    'fluid_private.shared_strategy_admission_context',
    'fluid_private.shared_strategy_observed_outcomes',
    'fluid_private.shared_strategy_observed_responses',
    'fluid_private.standalone_names_runtime',
    'public.idea_brand_links',
    'public.idea_project_attachment_requests',
    'public.idea_project_attachments',
    'public.logo_style_notes',
    'public.names_workspaces',
    'public.standalone_promotions',
    'public.standalone_workspace_revisions',
    'public.standalone_workspaces',
    'public.strategy_job_applications'
  ]);
  if leftover is not null then raise exception 'retired_tables_left: %', leftover; end if;
  select string_agg(rolname, ', ') into leftover from pg_catalog.pg_roles
  where rolname = any(array['embel_development_logo_worker', 'embel_development_text_worker', 'fluid_api_text_worker', 'fluid_local_worker', 'fluid_logo_worker', 'fluid_naming_brain_worker']::name[]) or rolname ~ '^embel_shared_(strategy|naming|logo)_[a-z0-9_]+$';
  if leftover is not null then raise exception 'retired_logins_left: %', leftover; end if;
end $$;

commit;
