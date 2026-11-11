// The reviewed list of database functions a signed-in user (role authenticated) may execute,
// each with the reason it is safe to expose. tests/qa/database-adversarial.test.ts asserts the
// migrated grants equal this list exactly and attacks every entry with another owner's ids;
// tests/qa/abuse-local-stack.test.ts checks the same grants on the real local Supabase stack.
// Adding a function here is a security review: say who calls it and why it cannot reach
// another owner's data or spend beyond the caller's own credits and limits.

// Reviewed exact client surface, grouped by source migration and its intended
// application boundary. No producer/lease/private helper is granted by this list.
export const reviewedLogoAndHomeFunctions = [
  // 20261007010000: owned committed asset/font reads and current vector pointer.
  // Callers: server/data/identity-asset-store.ts and server/data/logo-workspace.ts.
  "public.read_logo_asset(jsonb)",
  "public.read_logo_font_record(uuid)",
  "public.read_logo_current_vector(uuid)",
  // 20261007011000: server/data/logo-jobs.ts uses bounded quote/admission and
  // owner-scoped recovery. Reconcile is read-only; it cannot dispatch a retry.
  "public.read_logo_request(uuid, uuid)",
  // 20261007011700 and 20261007012000: vector history and exact direction source
  // reads used by features/logo-vector and features/identity-directions/server.
  "public.read_logo_direction_selection_sources(uuid, jsonb)",
  // 20261007013000: features/identity-deliverables/server/persistence.ts reads
  // owned frozen proofs and requests an explicitly reviewed zero-cost export.
  "public.read_logo_deliverable_sources(uuid)",
  "public.read_logo_variant_set(uuid, uuid)",
  "public.get_logo_export(uuid, uuid)",
  "public.get_logo_deliverables(uuid, jsonb)",
  // 20261110090000: generation engine. Owner-derived admission with credits and limits,
  // cancellation of the caller's own run, and read-only credit and catalog summaries.
  "public.start_generation(uuid, text, text, jsonb)",
  "public.cancel_generation(uuid)",
  "public.get_credit_summary()",
  "public.get_generation_catalog()",
  // 20261110140000: Naming on the engine. Owner-scoped read of the project's generated names
  // and latest run; names are written only by the engine login (engine_save_names).
  "public.get_name_feed(uuid, timestamp with time zone, uuid, integer)",
  // 20261110170000: Creative directions on the engine. Owner-derived availability,
  // admission (through start_generation), Stop and request closing; boards are written
  // only by the engine login (engine_identity_save_board).
  "public.get_identity_directions_availability(uuid)",
  "public.start_identity_directions(uuid, jsonb)",
  "public.cancel_identity_directions(uuid, uuid)",
  "public.close_identity_directions_intent(uuid, jsonb)",
  // Frozen revision/hash inspection, never the mutable standalone workspace head.
  // 20261007015000: owned upload-status recovery and one-time project attachment
  // linking; byte upload/verification helpers receive no authenticated EXECUTE.
  "public.read_home_attachment_request(uuid)",
  "public.save_attached_home_project(jsonb, text)",
  "public.read_attached_home_project_request(uuid)",
  // 20261007016000: server/data/existing-brand-logo.ts initializes only an owned
  // existing brand's brief under the exact initial-head/rejection-key fence.
  "public.initialize_existing_brand_logo(uuid, jsonb)",
  // local20261007017000: server/data/logo-inputs.ts reads owner/project-scoped
  // requests and registered references/fonts; registration itself stays private.
  "public.read_logo_input_request(uuid, uuid)",
  "public.list_logo_input_references(uuid, jsonb)",
  "public.list_logo_input_fonts(uuid)",
  "public.list_logo_input_requests(uuid, jsonb)",
  // Exact-body cancellation only: project-locked immutable tombstone; a
  // committed registration remains successful and cannot be deleted or replaced.
  "public.cancel_logo_input_request(uuid, jsonb)",
] as const;

export const reviewedAccountWorkflowFunctions = [
  // Reviewed owner-scoped hosted admission/availability and read-only delivery recovery.
  // Existing migrations 20261019024815 and 20261020033500; no grant changes here.
  // 20261029180000: owned read-only Strategy summaries. Raw input and lease
  // fields stay private; this grants no worker mutation or execution authority.
  "public.get_strategy_job_summaries(uuid, uuid)",
  // 20261013120000 / 20261013140801 / 20261013190225: owned project catalog
  // choices, immutable direction review and owner-authored screening evidence.
  // Read-only authenticated discovery of public catalog IDs; no owner data or execution authority.
  "public.get_inspiration_reference_ids()",
  "public.get_project_inspiration(uuid)",
  "public.set_project_inspiration_reaction(uuid, uuid, jsonb)",
  "public.get_project_visual_direction(uuid)",
  "public.review_project_visual_direction(uuid, jsonb)",
  "public.get_project_screening(uuid, jsonb)",
  "public.record_project_screening(uuid, jsonb)",
  // 20261015201722 / 20261015201757: parsed public wrappers delegate to exact
  // private helpers below without granting private-schema USAGE or raw writes.
  "public.create_project_with_request(uuid, text, text, jsonb, text)",
  // 20261015232500 / 20261015235900: owner/revision/lifecycle-fenced recoverable
  // deletion and restore, with durable stop intent and read-only status.
  // set_project_deleted is no longer client-callable (20261110160000).
  "public.request_project_deletion(uuid, integer, integer)",
  "public.restore_project_deletion(uuid, integer, integer)",
  "public.get_project_deletion(uuid)",
  "public.get_project_deletion_states(uuid[])",
  // The baseline's shared account, Identity and Logo web lanes: owners issue their own
  // delegations and read their own uploads and batches; the HTTP logins execute them.
  "public.issue_shared_account_request(text, text, jsonb)",
  "public.issue_shared_logo_request(text, jsonb)",
  "public.prepare_shared_identity_reference_upload(uuid, jsonb)",
  "public.read_shared_identity_reference_upload(uuid, uuid)",
  "public.register_shared_identity_reference(uuid, uuid, jsonb)",
  "public.get_shared_identity_batch(uuid, uuid, text)",
  "public.get_identity_logo_source(uuid, uuid)",
  // Owned Naming generation reads and usage.
  "public.get_naming_generation(uuid, timestamp with time zone, uuid, integer)",
  "public.get_naming_usage(uuid[])",
  // Storage policy predicates signed-in owners evaluate through the policies.
  "fluid_private.shared_http_customer_storage_live()",
  "fluid_private.shared_storage_legacy_registry_present()",
] as const;

export const authenticatedWrapperFunctions = [
  "fluid_private.create_project_with_request(uuid, text, text, jsonb, text)",
] as const;

// Exact reviewed signatures: a newly introduced overload must not inherit an
// allowlist entry merely because it shares the name of a safe client RPC.
// The two old worker identity helpers reveal only the actual session's binding
// (null for everyone now) and confer no execution authority. Project lifecycle
// guards still call them as the signed-in role. 20261110160000 revoked them from
// PUBLIC and anon; 20261110180000 dropped the job_steps worker policies and the
// worker functions that service_role and the worker logins executed.
export const publicFunctions = new Set([
  "public.subscription_worker_owner()",
  // Actual-session identity and owner-scoped RLS predicate only; no mutation.
  "public.api_text_worker_owner()",
]);
// 20261007022000 grants only this exact private RLS predicate to the
// authenticated role. It is not a public RPC: private-schema USAGE remains
// absent, and direct invocation is denied below even for an authenticated UID.
export const authenticatedPolicyFunctions = new Set(["fluid_private.owner_staging_object_allowed(text, text)"]);
export const userFunctions = new Set([
  ...publicFunctions,
  ...reviewedLogoAndHomeFunctions,
  ...reviewedAccountWorkflowFunctions,
  ...authenticatedWrapperFunctions,
  ...authenticatedPolicyFunctions,
  "public.create_project(text, text, jsonb, text)",
  "public.append_project_revision(uuid, integer, jsonb, text, text)",
  "public.request_job_cancel(uuid)",
  "public.save_naming_preferences(uuid, integer, jsonb)",
  "public.save_naming_view(uuid, integer, jsonb)",
  "public.set_name_retention(uuid, uuid, integer, boolean, boolean)",
  "public.get_naming_availability(uuid)",
  "public.get_naming_batch(uuid, uuid)",
  "public.import_local_name(uuid, integer, jsonb, jsonb, text, text)",
  "public.persist_name_transform(uuid, uuid, uuid, jsonb, jsonb, text)",
  "public.select_project_name(uuid, uuid, integer, boolean)",
  "public.create_brand_from_project_name(uuid, uuid, integer, text, boolean, text)",
  "public.get_project_name(uuid, uuid)",
  "public.get_project_name_transform(uuid, uuid)",
  "public.get_naming_batches(uuid, jsonb)",
  "public.get_project_naming(uuid, jsonb)",
  "public.get_account_names(jsonb)",
  "public.list_account_assets(jsonb)",
  "public.get_asset_detail(uuid, jsonb)",
  "public.set_asset_retention(uuid, integer, boolean, boolean)",
  "public.select_asset_version(uuid, uuid, integer, integer, boolean)",
  "public.get_identity_references(uuid, jsonb)",
  "public.set_identity_reference_reaction(uuid, uuid, jsonb)",
  "public.get_project_identity(uuid, jsonb)",
  "public.list_identity_systems(uuid, jsonb)",
  "public.get_identity_system(uuid, uuid)",
  "public.set_identity_preferences(uuid, jsonb)",
  // 20261006130000_logo_workspace_v2: owner-checked manual history and CAS;
  // no generation, upload, provider execution or broader worker access.
  // 20261109100000 retired its logo-only project start and readers.
  "public.get_logo_workspace(uuid)",
  "public.read_logo_workspace_record(uuid, text, uuid)",
  "public.list_logo_workspace_records(uuid, text, jsonb)",
  "public.apply_logo_workspace_command(uuid, jsonb)",
  // 20261110200000_account_deletion_and_export: the caller's own export
  // limit (auth.uid()) and the catalog list of tables the export reads.
  "public.admit_account_export()",
  "public.account_export_tables()",
  // 20261111100000_stripe_billing: the caller's own plan, credits and subscription state.
  "public.get_billing_summary()",
]);
