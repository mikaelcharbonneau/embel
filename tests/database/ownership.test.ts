import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  asRole,
  claim,
  createTestDatabase,
  enqueue,
  HASH,
  OWNER_A,
  OWNER_B,
  registerPlan,
  resetFixture,
  seedProject,
  type TestDatabase,
} from "./local-supabase";
import { beginStep } from "./retired-worker-fixture";

// Explicitly reviewed additions, not an inventory copied from pg_class. The flag
// records the SELECT grant intended by the named migration's final ACL block.
const reviewedLogoAndHomeTables = [
  // 20261007010000: committed publications and immutable vector/font evidence.
  ["logo_asset_publications", true],
  ["logo_vector_revisions", true],
  ["logo_approvals", true],
  ["logo_font_records", true],
  // 20261007011000: admission/provider records are accessible only through RPCs.
  ["logo_cost_quotes", false],
  ["logo_operation_requests", false],
  ["logo_operation_rejections", false],
  ["logo_concept_batches", false],
  ["logo_concept_slots", false],
  ["logo_concept_attempts", false],
  ["logo_raster_refinements", false],
  ["logo_provider_responses", false],
  ["logo_raster_results", false],
  // 20261007012000: staged inputs/publications stay private; owned results are readable.
  ["logo_direction_inputs", false],
  ["logo_direction_publications", false],
  ["logo_direction_records", true],
  ["logo_direction_font_checks", true],
  // 20261007013000: only immutable variants/reviews/manifests have owner SELECT.
  ["logo_variant_sets", true],
  ["logo_variant_reviews", true],
  ["logo_export_manifests", true],
  ["logo_export_inputs", false],
  ["logo_export_publications", false],
  // 20261007015000: Home request recovery. The idea and standalone sources of
  // local20261007014000 went with the old worker objects (20261110180000).
  ["home_attachments", true],
  ["home_attachment_project_requests", true],
  // local20261007017000: byte/rights registration records stay behind checked RPCs.
  ["logo_input_requests", false],
  ["logo_input_rejections", false],
  ["logo_input_rights", false],
  ["logo_input_receipts", false],
  // 20261007018000: immutable edit-cancellation proofs are RPC-only.
  ["logo_vector_edit_cancellations", false],
] as const;

// Explicit review of the integrated project handoffs: these public tables have
// owner-filtered SELECT only; all writes go through their narrow checked RPCs.
const reviewedWorkflowTables = [
  ["project_inspiration_heads", true],
  ["project_inspiration_choices", true],
  ["project_visual_directions", true],
  ["project_screening_records", true],
] as const;
const reviewedAccountNamesTables = [
  // 20261013190229: job policy, lease and partial text have no raw client read.
  ["standalone_name_jobs", false],
] as const;
// 20261110090000: generation engine (docs/generation-engine.md). Owners read their own
// credits and runs; only start_generation/cancel_generation and the engine login write them.
const reviewedEngineTables = [
  ["credit_accounts", true],
  ["credit_entries", true],
  ["generation_runs", true],
  ["generation_outputs", true],
] as const;
const reviewedReadOnlyTables = [
  ...reviewedLogoAndHomeTables,
  ...reviewedWorkflowTables,
  ...reviewedAccountNamesTables,
  ...reviewedEngineTables,
];

describe("local PostgreSQL ownership boundaries (not live Supabase)", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 300_000); // Cold local engine/migration setup, not an application deadline.
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await resetFixture(db);
  });

  it("keeps every owned table under RLS and denies anonymous access", async () => {
    const tables = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'",
    );
    expect(new Set(tables.rows.map((table) => table.relname))).toEqual(
      new Set([
        "account_profiles",
        "projects",
        "project_revisions",
        "assets",
        "asset_versions",
        "asset_selections",
        "asset_heads",
        "asset_selection_receipts",
        "identity_reference_heads",
        "identity_references",
        "identity_reference_reactions",
        "identity_reference_snapshots",
        "identity_sessions",
        "identity_preferences",
        "identity_input_snapshots",
        "identity_system_versions",
        "identity_batches",
        "identity_generated_roots",
        "identity_system_files",
        "identity_selections",
        "identity_component_changes",
        "asset_usages",
        "jobs",
        "job_steps",
        "usage_accounts",
        "usage_reservations",
        "subscription_job_partials",
        "naming_sessions",
        "naming_preferences",
        "naming_batches",
        "naming_batch_results",
        "name_candidates",
        "name_transforms",
        "name_retention",
        "name_selections",
        // Reviewed manual persistence migrations; each retains forced owner RLS.
        "ideas",
        "idea_revisions",
        "logo_workspaces",
        "logo_stage_revisions",
        "logo_stage_heads",
        "logo_reference_sources",
        "logo_reference_snapshots",
        "logo_workspace_requests",
        ...reviewedReadOnlyTables.map(([table]) => table),
      ]),
    );
    for (const table of tables.rows) {
      expect(table.relrowsecurity, `${table.relname} RLS`).toBe(true);
      expect(table.relforcerowsecurity, `${table.relname} forced RLS`).toBe(true);
    }
    await asRole(db, "anon", null, async () => {
      for (const table of tables.rows) {
        await expect(db.query(`select owner_id from public.${table.relname}`), table.relname).rejects.toMatchObject({
          code: "42501",
        });
      }
      await expect(
        db.query("select * from public.create_project('complete_brand','No','{}',$1)", [HASH]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("keeps reviewed logo, Home and workflow tables read-only for clients and inaccessible to unrelated workers", async () => {
    // A login with no grants of its own, like the retired worker logins were.
    const principal = "fixture_subscription_worker_a";
    for (const [table, authenticatedRead] of reviewedReadOnlyTables) {
      for (const role of ["anon", "authenticated", "service_role", principal]) {
        const grants = await db.query<{ read: boolean; column_read: boolean; mutate: boolean; column_mutate: boolean }>(
          "select has_table_privilege($1,$2,'SELECT') as read,has_any_column_privilege($1,$2,'SELECT') as column_read,has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as mutate,has_any_column_privilege($1,$2,'INSERT,UPDATE,REFERENCES') as column_mutate",
          [role, `public.${table}`],
        );
        expect(grants.rows, `${role}: ${table}`).toEqual([
          {
            read: role === "authenticated" && authenticatedRead,
            column_read: role === "authenticated" && authenticatedRead,
            mutate: false,
            column_mutate: false,
          },
        ]);
      }
    }
    // A nominal authenticated role without a verified subject sees no owned
    // rows; internal tables deny SELECT outright even to authenticated clients.
    await asRole(db, "authenticated", null, async () => {
      for (const [table, authenticatedRead] of reviewedReadOnlyTables) {
        if (authenticatedRead) expect((await db.query(`select owner_id from public.${table}`)).rows, table).toEqual([]);
        else
          await expect(db.query(`select owner_id from public.${table}`), table).rejects.toMatchObject({
            code: "42501",
          });
        await expect(db.query(`update public.${table} set owner_id=owner_id`), table).rejects.toMatchObject({
          code: "42501",
        });
        await expect(db.query(`delete from public.${table}`), table).rejects.toMatchObject({ code: "42501" });
      }
    });
  });

  it("derives project ownership from authenticated identity and hides other users' rows", async () => {
    const a = await seedProject(db);
    const b = await seedProject(db, OWNER_B);
    await asRole(db, "authenticated", OWNER_A, async () => {
      expect((await db.query<{ id: string }>("select id from public.projects")).rows).toEqual([{ id: a.id }]);
      expect((await db.query("select * from public.project_revisions where project_id=$1", [b.id])).rows).toEqual([]);
      await expect(
        db.query("update public.projects set title='Attack' where id=$1 returning id", [b.id]),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query("update public.projects set owner_id=$1 where id=$2", [OWNER_B, a.id])).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        db.query("insert into public.projects(owner_id,scope,title) values($1,'naming_only','Forged')", [OWNER_B]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("lets only the owner's own engine round write Creative directions, through functions only", async () => {
    // 20261110170000: rounds are written by the engine login into the existing Creative
    // direction tables; clients keep read-only access and never write them directly.
    const a = await seedProject(db);
    const runId = (
      await db.query<{ id: string }>(
        `insert into public.generation_runs(owner_id,project_id,kind,status,idempotency_key,input,credits)
      values($1,$2,'identity.directions','running',$3,$4,3) returning id`,
        [
          OWNER_A,
          a.id,
          `directions-${randomUUID()}`,
          JSON.stringify({ version: 1, revision: 1, batchId: randomUUID(), jobId: randomUUID() }),
        ],
      )
    ).rows[0]!.id;
    for (const owner of [OWNER_A, OWNER_B])
      await asRole(db, "authenticated", owner, async () => {
        await expect(
          db.query("select fluid_private.engine_identity_save_board($1,1,'{}',null,0)", [runId]),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(db.query("select fluid_private.engine_identity_begin($1)", [runId])).rejects.toMatchObject({
          code: "42501",
        });
        for (const table of ["identity_batches", "identity_system_versions", "identity_generated_roots", "job_steps"]) {
          await expect(db.query(`delete from public.${table}`), table).rejects.toMatchObject({ code: "42501" });
        }
        expect((await db.query("select id from public.generation_runs where id=$1", [runId])).rows).toEqual(
          owner === OWNER_A ? [{ id: runId }] : [],
        );
      });
    for (const role of ["anon", "service_role"]) {
      for (const signature of [
        "public.start_identity_directions(uuid,jsonb)",
        "public.cancel_identity_directions(uuid,uuid)",
        "fluid_private.engine_identity_save_board(uuid,integer,jsonb,text,bigint)",
      ]) {
        expect(
          (await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows,
          `${role} ${signature}`,
        ).toEqual([{ allowed: false }]);
      }
    }
  });

  it("appends revisions with optimistic concurrency and immutable history", async () => {
    const a = await seedProject(db);
    await asRole(db, "authenticated", OWNER_A, async () => {
      const next = await db.query<{ revision: number }>(
        "select * from public.append_project_revision($1,1,'{" + '"description":"Changed"' + "}'::jsonb,$2)",
        [a.id, HASH],
      );
      expect(next.rows[0]?.revision).toBe(2);
      await expect(
        db.query("select * from public.append_project_revision($1,1,'{}',$2)", [a.id, HASH]),
      ).rejects.toThrow(/revision_conflict/);
    });
    await asRole(db, "authenticated", OWNER_B, async () => {
      await expect(
        db.query("select * from public.append_project_revision($1,2,'{}',$2)", [a.id, HASH]),
      ).rejects.toThrow(/not_found/);
    });
    await expect(
      db.query("update public.project_revisions set context='{}' where project_id=$1", [a.id]),
    ).rejects.toThrow(/immutable_history/);
    expect((await db.query("select * from public.project_revisions where project_id=$1", [a.id])).rows).toHaveLength(2);
  });

  it("enforces cross-owner references even for a privileged insertion", async () => {
    const a = await seedProject(db);
    // 20261015232500's content lifecycle guard rejects the mismatched owned
    // project before the composite foreign key is reached.
    await expect(
      db.query("insert into public.assets(owner_id,project_id,kind) values($1,$2,'logo')", [OWNER_B, a.id]),
    ).rejects.toMatchObject({ code: "P0002", message: "project_not_found" });
    await expect(
      db.query(
        `insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts)
      values($1,$2,'strategy',1,$3,'{}','foreign-job',100,3)`,
        [OWNER_B, a.id, HASH],
      ),
    ).rejects.toMatchObject({ code: "P0002", message: "project_not_found" });
    for (const table of ["assets", "jobs", "usage_reservations"])
      expect((await db.query(`select * from public.${table}`)).rows, table).toEqual([]);
  });

  it("restricts jobs, steps and reservations to their owner", async () => {
    const a = await seedProject(db);
    const job = await enqueue(db, a.id);
    const leased = await claim(db);
    await registerPlan(db, leased, [{ key: "tenant-private-step", maximumCostMicrousd: 50 }]);
    await beginStep(db, leased, "tenant-private-step", "fixture", 50);
    await asRole(db, "authenticated", OWNER_A, async () => {
      expect((await db.query("select * from public.job_steps")).rows).toHaveLength(1);
      expect((await db.query("select * from public.usage_reservations")).rows).toHaveLength(1);
      await expect(db.query("select lease_token from public.jobs where id=$1", [job.id])).rejects.toThrow(
        /permission denied/,
      );
      const cancelled = await db.query<{ status: Record<string, unknown> }>(
        "select public.request_job_cancel($1) as status",
        [job.id],
      );
      expect(cancelled.rows[0]?.status.state).toBe("cancel_requested");
      for (const key of ["lease_token", "lease_expires_at", "worker_id", "input", "idempotency_key"]) {
        expect(cancelled.rows[0]?.status).not.toHaveProperty(key);
      }
    });
    await asRole(db, "authenticated", OWNER_B, async () => {
      for (const table of ["jobs", "job_steps", "usage_reservations"]) {
        expect((await db.query(`select owner_id from public.${table}`)).rows).toEqual([]);
      }
      expect((await db.query<{ owner_id: string }>("select owner_id from public.usage_accounts")).rows).toEqual([
        { owner_id: OWNER_B },
      ]);
      await expect(db.query("select * from public.request_job_cancel($1)", [job.id])).rejects.toThrow(/not_found/);
    });
    await asRole(db, "service_role", null, async () => {
      await expect(db.query("update public.jobs set state='succeeded' where id=$1", [job.id])).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.query("update public.usage_accounts set limit_microusd=10000000")).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it("makes versions and restores append-only and blocks a foreign version selection", async () => {
    const a = await seedProject(db);
    const b = await seedProject(db, OWNER_B);
    const asset = randomUUID(),
      version = randomUUID();
    await db.query("insert into public.assets(id,owner_id,project_id,kind) values($1,$2,$3,'logo')", [
      asset,
      OWNER_A,
      a.id,
    ]);
    await db.query(
      "insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance) values($1,$2,$3,$4,1,1,$5,$5,'application/json','{" +
        '"source":"local_fixture"' +
        "}')",
      [version, OWNER_A, a.id, asset, HASH],
    );
    await asRole(db, "authenticated", OWNER_A, async () => {
      await expect(
        db.query(
          "insert into public.asset_selections(project_id,asset_id,version_id,reason) values($1,$2,$3,'selected')",
          [a.id, asset, version],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await db.query("select public.select_asset_version($1,$2,1,0,false)", [asset, version]);
      await db.query("select public.select_asset_version($1,$2,1,1,false)", [asset, version]);
      await expect(
        db.query("select public.select_asset_version($1,$2,1,1,false)", [asset, version]),
      ).rejects.toMatchObject({ code: "PT409" });
      expect((await db.query("select * from public.asset_selections")).rows).toHaveLength(2);
      expect((await db.query("select * from public.asset_selection_receipts")).rows).toHaveLength(2);
      expect(
        (
          await db.query("select selection_revision,current_version_id from public.asset_heads where asset_id=$1", [
            asset,
          ])
        ).rows,
      ).toEqual([{ selection_revision: 2, current_version_id: version }]);
    });
    await asRole(db, "authenticated", OWNER_B, async () => {
      expect((await db.query("select * from public.asset_versions")).rows).toEqual([]);
      expect((await db.query("select * from public.asset_heads")).rows).toEqual([]);
      expect((await db.query("select * from public.asset_selection_receipts")).rows).toEqual([]);
      await expect(
        db.query(
          "insert into public.asset_selections(project_id,asset_id,version_id,reason) values($1,$2,$3,'restored')",
          [b.id, asset, version],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        db.query("select public.select_asset_version($1,$2,1,2,false)", [asset, version]),
      ).rejects.toMatchObject({ code: "P0002" });
    });
    await expect(
      db.query(
        "insert into public.asset_selections(owner_id,project_id,asset_id,version_id,reason) values($1,$2,$3,$4,'restored')",
        [OWNER_B, b.id, asset, version],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(db.query("update public.asset_versions set content='{}' where id=$1", [version])).rejects.toThrow(
      /immutable_history/,
    );
    await expect(db.query("delete from public.asset_selections")).rejects.toThrow(/immutable_history/);
    await expect(db.query("delete from public.asset_selection_receipts")).rejects.toThrow(/immutable_history/);
  });

  it("authorizes storage only through the exact owned version manifest; rejects overwrite and path spoofing", async () => {
    const a = await seedProject(db);
    const asset = randomUUID(),
      version = randomUUID();
    const path = `${OWNER_A}/${a.id}/${asset}/${version}`;
    await db.query("insert into public.assets(id,owner_id,project_id,kind) values($1,$2,$3,'logo')", [
      asset,
      OWNER_A,
      a.id,
    ]);
    await db.query(
      "insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance,storage_path) values($1,$2,$3,$4,1,1,$5,$5,'image/png','{}',$6)",
      [version, OWNER_A, a.id, asset, HASH, path],
    );
    await asRole(db, "authenticated", OWNER_A, async () => {
      await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [
        path,
        OWNER_A,
      ]);
      expect((await db.query("select * from storage.objects")).rows).toHaveLength(1);
      expect((await db.query("update storage.objects set name='replacement' returning id")).rows).toEqual([]);
      await expect(
        db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [
          `${OWNER_A}/unknown`,
          OWNER_A,
        ]),
      ).rejects.toThrow(/row-level security/);
    });
    await asRole(db, "authenticated", OWNER_B, async () => {
      expect((await db.query("select * from storage.objects")).rows).toEqual([]);
      await expect(
        db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [path, OWNER_B]),
      ).rejects.toThrow(/row-level security/);
    });
    expect(
      (await db.query<{ public: boolean }>("select public from storage.buckets where id='fluid-assets'")).rows[0]
        ?.public,
    ).toBe(false);
  });
});
