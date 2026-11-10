import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, asSubscriptionWorker, createTestDatabase, enqueue, HASH, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";
import type { LogoWorkspaceV2 } from "../../src/domain/logo-workspace";
import { ownerQuery, startLogoFixture } from "../database/logo-project-fixture";

// Reviewed exact client surface, grouped by source migration and its intended
// application boundary. No producer/lease/private helper is granted by this list.
const reviewedLogoAndHomeFunctions = [
  // 20261007010000: owned committed asset/font reads and current vector pointer.
  // Callers: server/data/identity-asset-store.ts and server/data/logo-workspace.ts.
  "public.read_logo_asset(jsonb)",
  "public.read_logo_font_record(uuid)",
  "public.read_logo_current_vector(uuid)",
  // 20261007011000: server/data/logo-jobs.ts uses bounded quote/admission and
  // owner-scoped recovery. Reconcile is read-only; it cannot dispatch a retry.
  "public.quote_logo_operation(uuid, jsonb)",
  "public.admit_logo_operation(uuid, jsonb)",
  "public.read_logo_request(uuid, uuid)",
  "public.reconcile_logo_request(uuid, uuid)",
  // 20261007011700 and 20261007012000: vector history and exact direction source
  // reads used by features/logo-vector and features/identity-directions/server.
  "public.list_logo_vector_history(uuid, jsonb)",
  "public.read_logo_direction_selection_sources(uuid, jsonb)",
  // 20261007013000: features/identity-deliverables/server/persistence.ts reads
  // owned frozen proofs and requests an explicitly reviewed zero-cost export.
  "public.read_logo_deliverable_sources(uuid)",
  "public.read_logo_variant_set(uuid, uuid)",
  "public.request_logo_export(uuid, jsonb)",
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
  // local20261007014000: server/data/home-lifecycle.ts preserves manual source
  // provenance through owner-derived association/promotion and receipt recovery.
  "public.attach_idea_to_project(jsonb)",
  "public.read_idea_project_attachment_request(uuid)",
  "public.get_project_idea_attachments(uuid, uuid, integer)",
  "public.promote_standalone_workspace(jsonb)",
  "public.read_standalone_promotion_request(uuid)",
  "public.get_standalone_promotion_source(uuid)",
  // Frozen revision/hash inspection, never the mutable standalone workspace head.
  "public.get_standalone_promotion_snapshot(uuid)",
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
  // 20261007018000: features/logo-vector/server/cancellation.ts reads exact
  // edit outcomes and appends owner/project-locked cancellation proofs only.
  "public.cancel_logo_vector_edit(uuid, jsonb)",
  "public.read_logo_vector_edit_request(uuid, uuid)",
  // 20261007021000: server/data/logo-capabilities.ts exposes only five fresh
  // owned readiness hints; no policy, worker, job or stored workspace mutation.
  "public.read_logo_capabilities(uuid)",
] as const;

const reviewedAccountWorkflowFunctions = [
  // Reviewed owner-scoped hosted admission/availability and read-only delivery recovery.
  // Existing migrations 20261019024815 and 20261020033500; no grant changes here.
  "public.get_hosted_naming_availability(uuid)",
  "public.ensure_hosted_naming_brain_run(uuid, jsonb)",
  "public.get_strategy_job_deliveries(uuid, uuid[])",
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
  // 20261013190229: owned standalone jobs and retention. No worker readiness,
  // claim, pulse or finish entrypoint receives a client EXECUTE grant.
  "public.get_standalone_names(timestamp with time zone, uuid)",
  "public.get_standalone_name_job(uuid)",
  "public.enqueue_standalone_names(jsonb)",
  "public.cancel_standalone_names(uuid)",
  "public.retain_standalone_name(uuid, integer, boolean, boolean)",
  // 20261015201722 / 20261015201757: parsed public wrappers delegate to exact
  // private helpers below without granting private-schema USAGE or raw writes.
  "public.create_project_with_request(uuid, text, text, jsonb, text)",
  "public.get_names_workspace()",
  "public.save_names_workspace(integer, uuid, jsonb)",
  // 20261015232500 / 20261015235900: owner/revision/lifecycle-fenced recoverable
  // deletion and restore, with durable stop intent and read-only status.
  // set_project_deleted is no longer client-callable (20261110160000).
  "public.request_project_deletion(uuid, integer, integer)",
  "public.restore_project_deletion(uuid, integer, integer)",
  "public.get_project_deletion(uuid)",
  "public.get_project_deletion_states(uuid[])",
] as const;

const authenticatedWrapperFunctions = [
  "fluid_private.create_project_with_request(uuid, text, text, jsonb, text)",
  "fluid_private.save_names_workspace(integer, uuid, jsonb)",
] as const;

// Uses the real greenfield migration in local PostgreSQL/WASM, with emulated Auth claims.
// It does not represent two live Supabase sessions or multi-connection concurrency.
describe("independent database boundary attacks", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  beforeEach(async () => { await resetFixture(db); });
  afterAll(async () => { await db?.close(); });

  async function fullTenant(owner: string) {
    const project = await seedProject(db, owner);
    const asset = randomUUID(), version = randomUUID();
    const path = `${owner}/${project.id}/${asset}/${version}`;
    await db.query("insert into public.assets(id,owner_id,project_id,kind) values($1,$2,$3,'qa_fixture')", [asset, owner, project.id]);
    await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance,storage_path) values($1,$2,$3,$4,1,1,$5,$5,'application/json','{\"source\":\"qa_local_fixture\"}',$6)", [version, owner, project.id, asset, HASH, path]);
    await asRole(db, "authenticated", owner, async () => {
      await db.query("select public.select_asset_version($1,$2,1,0,false)", [asset, version]);
      await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [path, owner]);
    });
    const job = await enqueue(db, project.id, "same-key-different-owners", 100, owner);
    // Administrative fixture creation only: application roles cannot insert job outputs.
    await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,output) values($1,$2,$3,'qa-step','qa-request','succeeded',0,'{\"source\":\"qa_local_fixture\"}')", [job.id, owner, project.id]);
    return { project: project.id, asset, version, path, job: job.id };
  }

  it("isolates populated rows in every owned public table and private storage in both directions", async () => {
    const a = await fullTenant(OWNER_A), b = await fullTenant(OWNER_B);
    const tables = ["projects", "project_revisions", "assets", "asset_versions", "asset_selections", "asset_heads", "asset_selection_receipts", "jobs", "job_steps", "usage_accounts", "usage_reservations"];
    for (const [owner, own, other] of [[OWNER_A, a, b], [OWNER_B, b, a]] as const) {
      await asRole(db, "authenticated", owner, async () => {
        for (const table of tables) {
          expect((await db.query(`select owner_id from public.${table}`)).rows, table).toEqual([{ owner_id: owner }]);
        }
        expect((await db.query("select name from storage.objects")).rows).toEqual([{ name: own.path }]);
        for (const target of [own.asset, other.asset]) {
          await expect(db.query("update public.assets set liked=true,saved=true,used=true where id=$1 returning id", [target])).rejects.toMatchObject({ code: "42501" });
        }
        await expect(db.query("select public.set_asset_retention($1,0,true,true)", [other.asset])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select public.get_asset_detail($1,'{}')", [other.asset])).rejects.toMatchObject({ code: "P0002" });
        expect((await db.query("delete from storage.objects where name=$1 returning id", [other.path])).rows).toEqual([]);
        await expect(db.query("insert into public.asset_selections(project_id,asset_id,version_id,reason) values($1,$2,$3,'restored')", [own.project, own.asset, other.version])).rejects.toMatchObject({ code: "42501" });
        await expect(db.query("select public.select_asset_version($1,$2,1,1,false)", [own.asset, other.version])).rejects.toMatchObject({ code: "P0002" });
      });
    }
  });

  it("isolates populated reference records, denies raw writes and protects captured history", async () => {
    const tables = ["identity_reference_heads", "identity_references", "identity_reference_reactions", "identity_reference_snapshots"];
    async function referenceTenant(owner: string) {
      const project = (await seedProject(db, owner)).id, asset = randomUUID(), version = randomUUID(), reference = randomUUID();
      // Administrative local metadata only; no actual bytes, import API or source fetch.
      await db.query("insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'qa_reference','reference_media')", [asset, owner, project]);
      await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance,storage_path) values($1,$2,$3,$4,1,1,$5,$5,'image/png','{}',$6)", [version, owner, project, asset, HASH, `${owner}/${project}/${asset}/${version}`]);
      await db.query("insert into public.identity_references(id,owner_id,project_id,asset_id,media_version_id,source,attribution,relevant_elements,tags) values($1,$2,$3,$4,$5,'user_supplied',$6::jsonb,'{logo,colors}','{qa-local}')", [reference, owner, project, asset, version, JSON.stringify({ label: "Explicit local fixture", creator: null, sourceUrl: null, rightsNote: null })]);
      await asRole(db, "authenticated", owner, () => db.query("select public.set_identity_reference_reaction($1,$2,'{\"expectedRevision\":0,\"ensemble\":false,\"elements\":[\"colors\"]}')", [project, reference]));
      // Invoke the private capture as fixture administrator, never via a new grant.
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
      try { await db.query("select fluid_private.capture_identity_reference_snapshot($1,1)", [project]); }
      finally { await db.query("select set_config('request.jwt.claim.sub','',false)"); }
      return { project, reference };
    }
    const a = await referenceTenant(OWNER_A), b = await referenceTenant(OWNER_B);
    for (const [owner, own, other] of [[OWNER_A, a, b], [OWNER_B, b, a]] as const) {
      await asRole(db, "authenticated", owner, async () => {
        for (const table of tables) {
          expect((await db.query(`select owner_id from public.${table}`)).rows, table).toEqual([{ owner_id: owner }]);
          await expect(db.query(`insert into public.${table}(owner_id,project_id) values($1,$2)`, [owner, own.project])).rejects.toMatchObject({ code: "42501" });
          for (const target of [own.project, other.project]) {
            await expect(db.query(`update public.${table} set owner_id=$1 where project_id=$2`, [owner, target])).rejects.toMatchObject({ code: "42501" });
            await expect(db.query(`delete from public.${table} where project_id=$1`, [target])).rejects.toMatchObject({ code: "42501" });
          }
        }
        await expect(db.query("select public.get_identity_references($1,'{}')", [other.project])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select public.set_identity_reference_reaction($1,$2,'{}')", [own.project, other.reference])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select fluid_private.capture_identity_reference_snapshot($1,1)", [own.project])).rejects.toMatchObject({ code: "42501" });
      });
    }
    await asRole(db, "authenticated", null, async () => {
      for (const table of tables) expect((await db.query(`select owner_id from public.${table}`)).rows).toEqual([]);
      await expect(db.query("select public.get_identity_references($1,'{}')", [a.project])).rejects.toMatchObject({ code: "P0002" });
      await expect(db.query("select public.set_identity_reference_reaction($1,$2,'{}')", [a.project, a.reference])).rejects.toMatchObject({ code: "P0002" });
    });
    for (const role of ["anon", "service_role"] as const) await asRole(db, role, OWNER_A, async () => {
      for (const table of tables) {
        await expect(db.query(`select owner_id from public.${table}`)).rejects.toMatchObject({ code: "42501" });
        await expect(db.query(`update public.${table} set owner_id=$1 where project_id=$2`, [OWNER_A, a.project])).rejects.toMatchObject({ code: "42501" });
      }
    });
    await asSubscriptionWorker(db, OWNER_A, async () => {
      for (const table of tables) await expect(db.query(`select owner_id from public.${table}`)).rejects.toMatchObject({ code: "42501" });
    });
    for (const table of ["identity_references", "identity_reference_snapshots"]) {
      await expect(db.query(`update public.${table} set owner_id=owner_id where project_id=$1`, [a.project])).rejects.toMatchObject({ code: "55000" });
      await expect(db.query(`delete from public.${table} where project_id=$1`, [a.project])).rejects.toMatchObject({ code: "55000" });
    }
  });

  it("isolates all populated logo tables and history RPCs without granting raw writes", async () => {
    const tables = ["logo_workspaces", "logo_stage_heads", "logo_stage_revisions", "logo_reference_sources", "logo_reference_snapshots", "logo_workspace_requests"];
    const brief = { name: "Explicit local logo fixture", activity: "", audience: "", personality: "", logoTypes: ["wordmark"] };
    async function logoTenant(owner: string) {
      const workspace = await startLogoFixture(ownerQuery(db, owner), { brief });
      const asset = randomUUID(), version = randomUUID(), reference = randomUUID();
      // Administrator-created local metadata only. No actual upload, source
      // admission, licensed rights, or provider output is claimed by this fixture.
      await db.query("insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'qa_reference','reference_media')", [asset, owner, workspace.projectId]);
      await db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance) values($1,$2,$3,$4,1,1,$5,$5,'image/png','{}')", [version, owner, workspace.projectId, asset, HASH]);
      await db.query("insert into public.logo_reference_sources(reference_id,project_id,owner_id,asset_id,version_id,content_hash,source_kind,rights_evidence_id) values($1,$2,$3,$4,$5,$6,'upload',$7)", [reference, workspace.projectId, owner, asset, version, HASH, randomUUID()]);
      const snapshot = (await db.query<{ id: string }>("select id from public.logo_reference_snapshots where project_id=$1 and owner_id=$2", [workspace.projectId, owner])).rows[0]!.id;
      return { workspace, snapshot };
    }
    const a = await logoTenant(OWNER_A), b = await logoTenant(OWNER_B);
    for (const [owner, own, other] of [[OWNER_A, a, b], [OWNER_B, b, a]] as const) {
      await asRole(db, "authenticated", owner, async () => {
        for (const table of tables) {
          expect((await db.query(`select owner_id from public.${table}`)).rows, table).toEqual([{ owner_id: owner }]);
          await expect(db.query(`insert into public.${table}(owner_id) values($1)`, [owner]), table).rejects.toMatchObject({ code: "42501" });
          for (const target of [own.workspace.projectId, other.workspace.projectId]) {
            await expect(db.query(`update public.${table} set owner_id=$1 where project_id=$2`, [owner, target]), table).rejects.toMatchObject({ code: "42501" });
            await expect(db.query(`delete from public.${table} where project_id=$1`, [target]), table).rejects.toMatchObject({ code: "42501" });
          }
        }
        await expect(db.query("select public.get_logo_workspace($1)", [other.workspace.projectId])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select public.read_logo_workspace_record($1,'stage',$2)", [own.workspace.projectId, other.workspace.stages.brief_references!.id])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select public.read_logo_workspace_record($1,'reference_snapshot',$2)", [own.workspace.projectId, other.snapshot])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select public.list_logo_workspace_records($1,'brief_references','{}')", [other.workspace.projectId])).rejects.toMatchObject({ code: "P0002" });
        await expect(db.query("select public.apply_logo_workspace_command($1,$2)", [other.workspace.projectId, {
          method: "saveLogoBrief", body: { requestKey: randomUUID(), expected: other.workspace.heads, brief },
        }])).rejects.toMatchObject({ code: "P0002" });
      });
    }
    await asRole(db, "authenticated", null, async () => {
      for (const table of tables) expect((await db.query(`select owner_id from public.${table}`)).rows, table).toEqual([]);
    });
    for (const role of ["anon", "service_role"] as const) await asRole(db, role, OWNER_A, async () => {
      for (const table of tables) {
        await expect(db.query(`select owner_id from public.${table}`), table).rejects.toMatchObject({ code: "42501" });
        await expect(db.query(`update public.${table} set owner_id=$1`, [OWNER_A]), table).rejects.toMatchObject({ code: "42501" });
      }
    });
    await asSubscriptionWorker(db, OWNER_A, async () => {
      for (const table of tables) await expect(db.query(`select owner_id from public.${table}`), table).rejects.toMatchObject({ code: "42501" });
    });
    for (const table of ["logo_stage_revisions", "logo_reference_sources", "logo_reference_snapshots", "logo_workspace_requests"]) {
      await expect(db.query(`update public.${table} set owner_id=owner_id`), table).rejects.toMatchObject({ code: "55000" });
      await expect(db.query(`delete from public.${table}`), table).rejects.toMatchObject({ code: "55000" });
    }
  });

  it("fails closed when the authenticated database role has no subject claim", async () => {
    const a = await fullTenant(OWNER_A);
    await asRole(db, "authenticated", null, async () => {
      expect((await db.query("select id from public.projects")).rows).toEqual([]);
      expect((await db.query("select name from storage.objects")).rows).toEqual([]);
      await expect(db.query("select * from public.create_project('naming_only','No identity','{}',$1)", [HASH])).rejects.toThrow(/unauthenticated/);
      await expect(db.query("select public.get_strategy_availability(null)")).rejects.toThrow(/unauthenticated/);
      await expect(db.query("select public.enqueue_strategy_job($1,1,'strategy.reformulate','qa-no-subject-claim',100)", [a.project])).rejects.toThrow(/unauthenticated/);
      await expect(db.query("select public.apply_strategy_job_result($1,$2,1,'qa-step')", [a.project, a.job])).rejects.toThrow(/unauthenticated/);
      await expect(db.query("select public.apply_strategy_job_result_v2($1,$2,1,'qa-step')", [a.project, a.job])).rejects.toThrow(/unauthenticated/);
      await expect(db.query("select public.list_account_assets('{}')")).rejects.toThrow(/unauthenticated/);
      await expect(db.query("select public.get_asset_detail($1,'{}')", [a.asset])).rejects.toThrow(/unauthenticated/);
      await expect(db.query("select public.set_asset_retention($1,0,true,true)", [a.asset])).rejects.toThrow(/unauthenticated/);
      await expect(db.query("select public.select_asset_version($1,$2,1,1,false)", [a.asset, a.version])).rejects.toThrow(/unauthenticated/);
      for (const signature of reviewedLogoAndHomeFunctions) {
        // Typed NULL arguments probe the reviewed exact overload, even if a
        // future overload has the same name and a different argument type.
        const invocation = signature.replace(/\((.*)\)$/, (_, types: string) =>
          `(${types ? types.split(", ").map(type => `null::${type}`).join(", ") : ""})`);
        await expect(db.query(`select ${invocation}`), signature).rejects.toMatchObject({ code: "42501", message: "unauthenticated" });
      }
      // All authenticated-only RPCs introduced by the manual Ideas, standalone
      // and logo migrations must reject a missing UID before processing input.
      for (const sql of [
        "select public.create_idea(null,null)",
        "select public.update_idea(null,null,null,null)",
        "select public.get_idea(null)",
        "select public.list_ideas(null,null,null,null,null)",
        "select public.create_idea_brand(null,null,null,null,null)",
        "select public.get_project_idea_source(null)",
        "select public.get_standalone_workspace(null)",
        "select public.get_standalone_import(null)",
        "select public.save_standalone_workspace(null,null,null,null,null)",
        "select public.get_logo_workspace(null)",
        "select public.read_logo_workspace_record(null,null,null)",
        "select public.list_logo_workspace_records(null,null,null)",
        "select public.apply_logo_workspace_command(null,null)",
      ]) {
        await expect(db.query(sql), sql).rejects.toMatchObject({ code: "42501", message: "unauthenticated" });
      }
    });
  });

  it("keeps private helpers and all worker functions unavailable to client roles", async () => {
    const principal = await asSubscriptionWorker(db, OWNER_A, async () => (await db.query<{ login: string }>("select session_user as login")).rows[0]!.login);
    const grants = await db.query<{ signature: string; anonymous: boolean; authenticated: boolean; worker: boolean; subscription_worker: boolean }>(
      "select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature,has_function_privilege('anon',p.oid,'execute') as anonymous,has_function_privilege('authenticated',p.oid,'execute') as authenticated,has_function_privilege('service_role',p.oid,'execute') as worker,has_function_privilege($1,p.oid,'execute') as subscription_worker from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','fluid_private')", [principal],
    );
    // Exact reviewed signatures: a newly introduced overload must not inherit an
    // allowlist entry merely because it shares the name of a safe client RPC.
    // The four worker RLS helpers reveal only the actual session's binding (or null)
    // and an owner-scoped boolean used by the job_steps policies. They confer no
    // execution authority. 20261110160000 revoked them from PUBLIC and anon; the
    // signed-in role, service_role and worker logins keep explicit grants because
    // those roles evaluate the job_steps policies.
    const publicFunctions = new Set([
      "public.subscription_worker_owner()",
      "public.subscription_worker_can_read_step(uuid, uuid)",
      // Actual-session identity and owner-scoped RLS predicate only; no mutation.
      "public.api_text_worker_owner()",
      "public.api_text_worker_can_read_step(uuid, uuid)",
    ]);
    // 20261007022000 grants only this exact private RLS predicate to the
    // authenticated role. It is not a public RPC: private-schema USAGE remains
    // absent, and direct invocation is denied below even for an authenticated UID.
    const authenticatedPolicyFunctions = new Set([
      "fluid_private.owner_staging_object_allowed(text, text)",
    ]);
    const userFunctions = new Set([
      ...publicFunctions,
      ...reviewedLogoAndHomeFunctions,
      ...reviewedAccountWorkflowFunctions,
      ...authenticatedWrapperFunctions,
      ...authenticatedPolicyFunctions,
      "public.create_project(text, text, jsonb, text)",
      "public.append_project_revision(uuid, integer, jsonb, text, text)",
      "public.expand_project_scope(uuid, integer)",
      "public.request_job_cancel(uuid)",
      "public.get_strategy_availability(uuid)",
      "public.enqueue_strategy_job(uuid, integer, text, text, bigint)",
      // 20261017090000: explicit operator-bound local prototype admission and
      // owner-scoped readiness. Worker actions and metadata remain ungranted.
      "public.get_local_strategy_availability(uuid)",
      "public.enqueue_local_strategy_job(uuid, integer, text, text, bigint)",
      "public.ensure_local_naming_brain_run(uuid, jsonb)",
      "public.enqueue_subscription_strategy_job(uuid, integer, text, text, text)",
      "public.apply_strategy_job_result(uuid, uuid, integer, text)",
      "public.apply_strategy_job_result_v2(uuid, uuid, integer, text)",
      "public.save_naming_preferences(uuid, integer, jsonb)",
      "public.save_naming_view(uuid, integer, jsonb)",
      "public.set_name_retention(uuid, uuid, integer, boolean, boolean)",
      "public.get_naming_availability(uuid)",
      "public.get_naming_batch(uuid, uuid)",
      "public.enqueue_subscription_naming_job(uuid, integer, integer, integer, text, text)",
      "public.import_local_name(uuid, integer, jsonb, jsonb, text, text)",
      "public.persist_name_transform(uuid, uuid, uuid, jsonb, jsonb, text)",
      "public.select_project_name(uuid, uuid, integer, boolean)",
      "public.create_brand_from_project_name(uuid, uuid, integer, text, boolean, text)",
      "public.get_project_name(uuid, uuid)",
      "public.get_project_name_transform(uuid, uuid)",
      "public.get_naming_batches(uuid, jsonb)",
      "public.get_project_naming(uuid, jsonb)",
      "public.get_account_names(jsonb)",
      // 20261016180000: exactly the authenticated owner-scoped Naming surface.
      "public.append_prepared_naming_set(uuid, uuid)",
      "public.ensure_naming_brain_run(uuid, jsonb)",
      "public.get_naming_brain_candidate_source(uuid, uuid)",
      "public.get_naming_brain_candidate_sources(uuid, jsonb)",
      "public.get_naming_brain_job_accounting(uuid)",
      "public.get_naming_brain_run(uuid, uuid)",
      "public.get_naming_feed(uuid, jsonb)",
      "public.steer_naming_feed(uuid, jsonb)",
      "public.stop_naming_feed(uuid, jsonb)",
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
      // Public selection/refinement remain executable guards: every owned call
      // raises55000 before writes. The trusted helpers have no client grant.
      "public.select_identity_system(uuid, jsonb)",
      "public.refine_identity_component(uuid, jsonb)",
      // 20261005221000_manual_ideas: auth.uid()-derived owners, immutable source
      // links, and no anonymous, service-role or subscription-worker grants.
      "public.create_idea(uuid, jsonb)",
      "public.update_idea(uuid, integer, uuid, jsonb)",
      "public.get_idea(uuid)",
      "public.list_ideas(timestamp with time zone, uuid, integer, text, text)",
      "public.create_idea_brand(uuid, integer, uuid, jsonb, text)",
      "public.get_project_idea_source(uuid)",
      // 20261006010000_standalone_workspaces: owned manual drafts/imports only.
      "public.get_standalone_workspace(text)",
      "public.get_standalone_import(uuid)",
      "public.save_standalone_workspace(text, integer, uuid, jsonb, jsonb)",
      // 20261006130000_logo_workspace_v2: owner-checked manual history and CAS;
      // no generation, upload, provider execution or broader worker access.
      // 20261109100000 retired its logo-only project start and readers.
      "public.get_logo_workspace(uuid)",
      "public.read_logo_workspace_record(uuid, text, uuid)",
      "public.list_logo_workspace_records(uuid, text, jsonb)",
      "public.apply_logo_workspace_command(uuid, jsonb)",
    ]);
    const workerFunctions = new Set([
      ...publicFunctions,
      "public.enqueue_job(uuid, uuid, text, integer, text, jsonb, text, bigint, integer)",
      "public.claim_job(text, integer)",
      "public.heartbeat_job(uuid, uuid, integer)",
      "public.report_job_progress(uuid, uuid, integer)",
      "public.register_job_plan(uuid, uuid, jsonb)",
      "public.begin_job_step(uuid, uuid, text, text, bigint)",
      "public.complete_job_step(uuid, uuid, text, text, bigint, jsonb, text)",
      "public.finish_job(uuid, uuid, text, text)",
      "public.expire_job_leases()",
      "public.report_strategy_worker_ready(text, jsonb, integer)",
    ]);
    const subscriptionFunctions = new Set([
      ...publicFunctions,
      "public.heartbeat_job(uuid, uuid, integer)",
      "public.register_job_plan(uuid, uuid, jsonb)",
      "public.begin_job_step(uuid, uuid, text, text, bigint)",
      "public.complete_job_step(uuid, uuid, text, text, bigint, jsonb, text)",
      "public.finish_job(uuid, uuid, text, text)",
      "public.expire_job_leases()",
      "public.configure_subscription_runtime(uuid, text, jsonb, boolean)",
      // Opt-in execute grants belong only to the disposable local worker fixture.
      "public.configure_subscription_runtime(uuid, jsonb)",
      "public.complete_naming_job_step(uuid, uuid, text, text, bigint, jsonb, text)",
      "public.get_subscription_runtime_bindings()",
      "public.report_subscription_worker_ready(uuid, text, text, jsonb, integer)",
      "public.disable_subscription_runtime(uuid, text)",
      "public.claim_subscription_job(text, uuid, text, integer)",
      "public.append_subscription_partial(uuid, uuid, text)",
    ]);
    expect(grants.rows.length).toBeGreaterThan(10);
    expect(new Set(grants.rows.filter(grant => grant.authenticated).map(grant => grant.signature))).toEqual(userFunctions);
    expect(new Set(grants.rows.filter(grant => grant.worker).map(grant => grant.signature))).toEqual(workerFunctions);
    expect(new Set(grants.rows.filter(grant => grant.subscription_worker).map(grant => grant.signature))).toEqual(subscriptionFunctions);
    for (const grant of grants.rows) {
      expect(grant.anonymous, grant.signature).toBe(false);
      expect(grant.authenticated, grant.signature).toBe(userFunctions.has(grant.signature));
      expect(grant.worker, grant.signature).toBe(workerFunctions.has(grant.signature));
      expect(grant.subscription_worker, grant.signature).toBe(subscriptionFunctions.has(grant.signature));
    }
    await asRole(db, "authenticated", OWNER_A, async () => {
      await expect(db.query("select public.local_strategy_job_action($1,'finish','[]')", [randomUUID()])).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select * from public.read_local_strategy_steps($1,$2,$3,null)", [randomUUID(), OWNER_A, randomUUID()])).rejects.toMatchObject({ code: "42501" });
    });
    expect((await db.query("select has_schema_privilege('authenticated','fluid_private','USAGE') as usage")).rows).toEqual([{ usage: false }]);
    for (const signature of [...authenticatedPolicyFunctions, ...authenticatedWrapperFunctions]) {
      expect((await db.query("select has_function_privilege('authenticated',$1,'EXECUTE WITH GRANT OPTION') as grantable", [signature])).rows).toEqual([{ grantable: false }]);
    }
    for (const owner of [OWNER_A, null]) await asRole(db, "authenticated", owner, async () => {
      await expect(db.query("select fluid_private.owner_staging_object_allowed('fluid-assets','unlisted')")).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select fluid_private.create_project_with_request(null,null,null,null,null)")).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select fluid_private.save_names_workspace(null,null,null)")).rejects.toMatchObject({ code: "42501" });
    });
    const columns = await db.query<{ column_name: string }>(
      "select attname as column_name from pg_attribute where attrelid='public.job_steps'::regclass and attnum>0 and not attisdropped and has_column_privilege($1,attrelid,attnum,'select') order by attname", [principal],
    );
    expect(columns.rows.map(row => row.column_name)).toEqual(["job_id", "owner_id", "project_id", "request_key", "reserved_cost_microusd", "state", "step_key"]);
  });

  it("rejects foreign project reads across the new logo and Home client surface in both directions", async () => {
    const a = await seedProject(db, OWNER_A), b = await seedProject(db, OWNER_B);
    // Each target is a real project owned by the other subject, not a guessed
    // absent UUID. Project-scoped readers must fence it before looking up data.
    const projectReads = [
      "select public.read_logo_current_vector($1)",
      "select public.list_logo_vector_history($1,'{}')",
      "select public.read_logo_request($1,null)",
      "select public.read_logo_vector_edit_request($1,null)",
      "select public.read_logo_capabilities($1)",
      "select public.reconcile_logo_request($1,null)",
      "select public.read_logo_deliverable_sources($1)",
      "select public.get_logo_deliverables($1,'{}')",
      "select public.get_project_idea_attachments($1,null,20)",
      "select public.get_standalone_promotion_source($1)",
      "select public.get_standalone_promotion_snapshot($1)",
      "select public.read_logo_input_request($1,null)",
      "select public.list_logo_input_references($1,'{\"limit\":20}')",
      "select public.list_logo_input_fonts($1)",
      "select public.list_logo_input_requests($1,'{\"limit\":10}')",
    ];
    for (const [owner, own, other] of [[OWNER_A, a, b], [OWNER_B, b, a]] as const) {
      await asRole(db, "authenticated", owner, async () => {
        for (const sql of projectReads) await expect(db.query(sql, [other.id]), sql).rejects.toMatchObject({ code: "P0002" });
        const ownSource = await db.query<{ value: unknown }>("select public.get_standalone_promotion_snapshot($1) as value", [own.id]);
        expect(ownSource.rows).toEqual([{ value: { ownerId: owner, projectId: own.id, source: null, snapshot: null } }]);
        const ownFonts = await db.query<{ value: unknown }>("select public.list_logo_input_fonts($1) as value", [own.id]);
        expect(ownFonts.rows).toEqual([{ value: [] }]);
        const ownCapabilities = await db.query<{ value: { observedAt: string } }>("select public.read_logo_capabilities($1) as value", [own.id]);
        expect(ownCapabilities.rows).toEqual([{ value: {
          ownerId: owner, projectId: own.id, observedAt: expect.any(String),
          operations: {
            "identity.logo_concept": { status: "unavailable" },
            "identity.logo_refine": { status: "unavailable" },
            "identity.logo_vectorize": { status: "unavailable" },
            "identity.logo_directions": { status: "unavailable" },
            "identity.logo_export": { status: "unavailable" },
          },
        } }]);
        expect(Number.isFinite(Date.parse(ownCapabilities.rows[0]!.value.observedAt))).toBe(true);
      });
    }
  });

  it("denies foreign-project input cancellation before creating any request or tombstone", async () => {
    const a = await seedProject(db, OWNER_A), b = await seedProject(db, OWNER_B);
    for (const [owner, own, other] of [[OWNER_A, a, b], [OWNER_B, b, a]] as const) {
      await asRole(db, "authenticated", owner, async () => {
        const workspace = (await db.query<{ value: LogoWorkspaceV2 }>("select public.get_logo_workspace($1) as value", [own.id])).rows[0]!.value;
        // Fully valid metadata reaches the owned-project lock. An invalid body
        // could fail earlier and leave a missing authorization check undetected.
        const request = {
          kind: "reference_upload",
          input: { requestKey: randomUUID(), expected: workspace.heads, aspects: ["shape"], rightsDeclaration: "Explicit local fixture rights" },
          file: { contentHash: HASH, mimeType: "image/png", byteLength: 24 },
        };
        await expect(db.query("select public.cancel_logo_input_request($1,$2)", [other.id, request])).rejects.toMatchObject({ code: "P0002" });
      });
    }
    expect((await db.query("select owner_id,project_id,request_key from public.logo_input_requests")).rows).toEqual([]);
    expect((await db.query("select owner_id,project_id,request_key from public.logo_input_rejections")).rows).toEqual([]);
  });

  it("scopes vector-edit cancellation and its populated proof to the owning project through RPCs only", async () => {
    const a = await seedProject(db, OWNER_A), b = await seedProject(db, OWNER_B);
    const saved: { owner_id: string; project_id: string; request_key: string }[] = [];
    for (const [owner, own, other] of [[OWNER_A, a, b], [OWNER_B, b, a]] as const) {
      await asRole(db, "authenticated", owner, async () => {
        const workspace = (await db.query<{ value: LogoWorkspaceV2 }>("select public.get_logo_workspace($1) as value", [own.id])).rows[0]!.value;
        const command = {
          method: "saveLogoEdit",
          body: { requestKey: randomUUID(), expected: workspace.heads, baseVectorRevisionId: randomUUID(), edit: { kind: "locks", componentIds: [] } },
        };
        // Valid passive metadata must reach the ownership check without creating
        // an unauthorized tombstone, even before an edit has been admitted.
        await expect(db.query("select public.cancel_logo_vector_edit($1,$2)", [other.id, command])).rejects.toMatchObject({ code: "P0002" });
        const expected = { status: "cancelled", ownerId: owner, projectId: own.id, requestKey: command.body.requestKey, command };
        expect((await db.query("select public.cancel_logo_vector_edit($1,$2) as value", [own.id, command])).rows).toEqual([{ value: expected }]);
        expect((await db.query("select public.read_logo_vector_edit_request($1,$2) as value", [own.id, command.body.requestKey])).rows).toEqual([{ value: expected }]);
        await expect(db.query("select owner_id,command from public.logo_vector_edit_cancellations")).rejects.toMatchObject({ code: "42501" });
        saved.push({ owner_id: owner, project_id: own.id, request_key: command.body.requestKey });
      });
    }
    for (const [owner, foreign] of [[OWNER_A, saved[1]!], [OWNER_B, saved[0]!]] as const) {
      await asRole(db, "authenticated", owner, async () => {
        await expect(db.query("select public.read_logo_vector_edit_request($1,$2)", [foreign.project_id, foreign.request_key])).rejects.toMatchObject({ code: "P0002" });
      });
    }
    // Exactly the two legitimate proofs exist; both foreign cancellations were inert.
    expect((await db.query("select owner_id,project_id,request_key from public.logo_vector_edit_cancellations order by owner_id")).rows).toEqual(saved);
  });

  it("denies direct calls to renamed base readers while the authenticated wrappers still work", async () => {
    const project = await seedProject(db);
    async function attackBaseReaders() {
      await expect(db.query("select public.read_logo_workspace_base_record($1,'stage',$2)", [project.id, randomUUID()])).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select public.list_logo_workspace_base_records($1,'brief_references','{}')", [project.id])).rejects.toMatchObject({ code: "42501" });
    }
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      await asRole(db, role, OWNER_A, attackBaseReaders);
    }
    await asSubscriptionWorker(db, OWNER_A, attackBaseReaders);
    await asRole(db, "authenticated", OWNER_A, async () => {
      const page = await db.query<{ value: { items: unknown[] } }>("select public.list_logo_workspace_records($1,'brief_references','{}') as value", [project.id]);
      expect(page.rows[0]!.value.items).toEqual([]);
      // Reaching the checked not-found result proves wrapper -> private base
      // delegation still works without exposing the base function to clients.
      await expect(db.query("select public.read_logo_workspace_record($1,'stage',$2)", [project.id, randomUUID()])).rejects.toMatchObject({ code: "P0002" });
    });
  });

  it("keeps authenticated strategy RPCs owner-scoped and denies client policy mutation", async () => {
    const a = await fullTenant(OWNER_A);
    await asRole(db, "authenticated", OWNER_B, async () => {
      await expect(db.query("select public.get_strategy_availability($1)", [a.project])).rejects.toThrow(/not_found/);
      await expect(db.query("select public.enqueue_strategy_job($1,1,'strategy.reformulate','qa-foreign-owner-job',100)", [a.project])).rejects.toThrow(/not_found/);
      await expect(db.query("select public.apply_strategy_job_result($1,$2,1,'qa-step')", [a.project, a.job])).rejects.toThrow(/not_found/);
      await expect(db.query("select public.apply_strategy_job_result_v2($1,$2,1,'qa-step')", [a.project, a.job])).rejects.toThrow(/not_found/);
      await expect(db.query("select public.report_strategy_worker_ready('strategy.reformulate','{}'::jsonb,60)")).rejects.toThrow(/permission denied/);
      await expect(db.query("update fluid_private.strategy_runtime_policy set enabled=true")).rejects.toThrow(/permission denied/);
    });
  });

  it("prevents user and worker DML on immutable history and accounting", async () => {
    const a = await fullTenant(OWNER_A);
    for (const role of ["authenticated", "service_role"] as const) {
      await asRole(db, role, role === "authenticated" ? OWNER_A : null, async () => {
        await expect(db.query("update public.asset_versions set content='{}' where id=$1", [a.version])).rejects.toThrow(/permission denied/);
        await expect(db.query("update public.asset_heads set selection_revision=0 where asset_id=$1", [a.asset])).rejects.toMatchObject({ code: "42501" });
        await expect(db.query("update public.asset_selection_receipts set accepted_stale_basis=true where asset_id=$1", [a.asset])).rejects.toMatchObject({ code: "42501" });
        await expect(db.query("delete from public.project_revisions where project_id=$1", [a.project])).rejects.toThrow(/permission denied/);
        await expect(db.query("update public.job_steps set output='{}' where job_id=$1", [a.job])).rejects.toThrow(/permission denied/);
        await expect(db.query("update public.usage_accounts set reserved_microusd=0")).rejects.toThrow(/permission denied/);
        await expect(db.query("delete from public.usage_reservations where job_id=$1", [a.job])).rejects.toThrow(/permission denied/);
      });
    }
  });

  it("rejects cross-project version selection within the same owner", async () => {
    const a = await fullTenant(OWNER_A);
    const otherProject = await seedProject(db, OWNER_A);
    const otherAsset = randomUUID();
    await db.query("insert into public.assets(id,owner_id,project_id,kind) values($1,$2,$3,'qa_fixture')", [otherAsset, OWNER_A, otherProject.id]);
    await asRole(db, "authenticated", OWNER_A, async () => {
      await expect(db.query("insert into public.asset_selections(project_id,asset_id,version_id,reason) values($1,$2,$3,'restored')", [otherProject.id, otherAsset, a.version])).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("select public.select_asset_version($1,$2,1,0,false)", [otherAsset, a.version])).rejects.toMatchObject({ code: "P0002" });
    });
    await expect(db.query("insert into public.asset_selections(owner_id,project_id,asset_id,version_id,reason) values($1,$2,$3,$4,'restored')", [OWNER_A, otherProject.id, otherAsset, a.version])).rejects.toMatchObject({ code: "23503" });
    expect((await db.query("select current_selection_id,selection_revision from public.asset_heads where asset_id=$1", [otherAsset])).rows).toEqual([{ current_selection_id: null, selection_revision: 0 }]);
  });

  it("rolls back malformed enqueue reservations and keeps same-key requests scoped to one owner", async () => {
    const a = await seedProject(db), b = await seedProject(db, OWNER_B);
    await expect(enqueue(db, a.id, "invalid-attempts", 900, OWNER_A, 11)).rejects.toThrow(/check constraint/);
    expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ reserved_microusd: 0 }]);
    const first = await enqueue(db, a.id, "shared-request-key", 50);
    const second = await enqueue(db, b.id, "shared-request-key", 50, OWNER_B);
    expect(second.id).not.toBe(first.id);
    await asRole(db, "service_role", null, async () => {
      await expect(db.query("select * from public.enqueue_job($1,$2,'strategy',1,$3,'{}','shared-request-key',50,3)", [OWNER_A, b.id, HASH])).rejects.toThrow(/idempotency_conflict/);
    });
  });

  // 20261110160000_harden_database_api.sql. Anonymous visitors can reach any function that
  // anon or PUBLIC may execute; new functions must start private.
  describe("database API hardening", () => {
    const rlsHelpers = [
      "public.api_text_worker_owner()",
      "public.api_text_worker_can_read_step(uuid,uuid)",
      "public.subscription_worker_owner()",
      "public.subscription_worker_can_read_step(uuid,uuid)",
    ] as const;
    const executable = async (role: string, signature: string) =>
      (await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).rows[0]!.allowed;

    it("lets anonymous visitors execute no SECURITY DEFINER function in public, directly or through PUBLIC", async () => {
      const definers = await db.query<{ signature: string; anon: boolean; public_grant: boolean }>(
        `select p.oid::regprocedure::text as signature, has_function_privilege('anon',p.oid,'EXECUTE') as anon,
           exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_grant
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef`);
      expect(definers.rows.length).toBeGreaterThan(100);
      expect(definers.rows.filter(row => row.anon || row.public_grant)).toEqual([]);
      await asRole(db, "anon", null, async () => {
        for (const sql of [
          "select public.api_text_worker_owner()", "select public.api_text_worker_can_read_step(null, null)",
          "select public.subscription_worker_owner()", "select public.subscription_worker_can_read_step(null, null)",
        ]) await expect(db.query(sql), sql).rejects.toMatchObject({ code: "42501" });
      });
    });

    it("keeps the worker RLS helpers working for the roles that read job_steps, and anonymous reads still stop at the table", async () => {
      for (const signature of rlsHelpers) {
        expect(await executable("authenticated", signature), signature).toBe(true);
        expect(await executable("service_role", signature), signature).toBe(true);
        expect(await executable("fixture_subscription_worker_a", signature), signature).toBe(true);
      }
      // The job_steps policies call these helpers as the reading role, so a revoked helper would break these reads.
      await asRole(db, "authenticated", OWNER_A, async () => {
        expect((await db.query("select job_id from public.job_steps")).rows).toEqual([]);
      });
      await asSubscriptionWorker(db, OWNER_A, async () => {
        expect((await db.query("select job_id from public.job_steps")).rows).toEqual([]);
      });
      // anon holds no privilege on job_steps (foundation migration), so its policies are never evaluated.
      await asRole(db, "anon", null, async () => {
        await expect(db.query("select job_id from public.job_steps")).rejects.toMatchObject({ code: "42501" });
      });
    });

    it("no longer lets any API role execute set_project_deleted, which the app does not call", async () => {
      const signature = "public.set_project_deleted(uuid,integer,integer,boolean)";
      for (const role of ["anon", "authenticated", "service_role"]) expect(await executable(role, signature), role).toBe(false);
      const project = await seedProject(db);
      await asRole(db, "authenticated", OWNER_A, async () => {
        await expect(db.query("select public.set_project_deleted($1,1,0,true)", [project.id])).rejects.toMatchObject({ code: "42501" });
      });
      // The supported owner path is untouched.
      expect(await executable("authenticated", "public.request_project_deletion(uuid,integer,integer)")).toBe(true);
    });

    it("keeps a newly created function private until it is explicitly granted", async () => {
      await db.exec("create role qa_hardening_fresh nologin");
      try {
        await db.exec(`create function public.qa_hardening_probe() returns integer language sql as 'select 1';
          create function public.qa_hardening_definer() returns integer language sql security definer set search_path='' as 'select 1';
          create function fluid_private.qa_hardening_probe() returns integer language sql as 'select 1';`);
        const probes = ["public.qa_hardening_probe()", "public.qa_hardening_definer()", "fluid_private.qa_hardening_probe()"];
        for (const signature of probes) {
          // qa_hardening_fresh stands in for PUBLIC: it has no grants of its own.
          for (const role of ["anon", "authenticated", "qa_hardening_fresh"]) expect(await executable(role, signature), `${role} ${signature}`).toBe(false);
          expect(await executable("postgres", signature), signature).toBe(true);
          expect((await db.query<{ grantees: string[] | null }>(
            "select array_agg(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) grantees from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid=$1::regprocedure and a.grantee<>p.proowner", [signature])).rows[0]!.grantees ?? [])
            .not.toContain("PUBLIC");
        }
        // An explicit grant still works, and grants only what it names.
        await db.exec("grant execute on function public.qa_hardening_probe() to authenticated");
        expect(await executable("authenticated", "public.qa_hardening_probe()")).toBe(true);
        expect(await executable("anon", "public.qa_hardening_probe()")).toBe(false);
        expect(await executable("qa_hardening_fresh", "public.qa_hardening_probe()")).toBe(false);
      } finally {
        await db.exec("drop function if exists public.qa_hardening_probe(); drop function if exists public.qa_hardening_definer(); drop function if exists fluid_private.qa_hardening_probe(); drop role if exists qa_hardening_fresh");
      }
    });
  });
});
