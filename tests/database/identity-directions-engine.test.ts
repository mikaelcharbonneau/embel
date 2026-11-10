import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  identityBatchStateSchema,
  logoBoardAvailabilitySchema,
  type IdentitySystemSpecification,
} from "../../src/domain/identity-jobs";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import {
  createIdentityTransactionService,
  type IdentityConnectionFactory,
} from "../../src/server/data/identity-transaction";
import {
  ENGINE_IDENTITY_POLICY_IDENTITY,
  ENGINE_IDENTITY_TEXT_POLICY,
  engineIdentityJobInputSchema,
} from "../../src/server/engine/identity-input";
import { qualifySharedHttpConnection } from "../../src/server/shared-account/qualification";
import { syntheticPng } from "../features/logo-vector/raster-fixtures";
import { specification } from "../fixtures/identity-generation";
import {
  asRole,
  createTestDatabase,
  OWNER_A as MIGRATIONS_OWNER,
  resetFixture,
  seedProject,
  type TestDatabase,
} from "./local-supabase";
import { sharedHttpRoles } from "./shared-account-fixture";
import {
  createSharedIdentityFixture,
  hash,
  OWNER_A,
  OWNER_B,
  type SharedIdentityFixture,
} from "./shared-identity-generation-fixture";

// Migration 20261110170000_identity_directions_engine: Creative directions on the
// generation engine. Rounds are written into the Creative direction tables of the
// shared packets, so the same readers, evidence check and selection accept them.

const PUBLIC_FUNCTIONS = [
  "public.get_identity_directions_availability(uuid)",
  "public.start_identity_directions(uuid,jsonb)",
  "public.cancel_identity_directions(uuid,uuid)",
  "public.close_identity_directions_intent(uuid,jsonb)",
];
const ENGINE_FUNCTIONS = [
  "fluid_private.engine_identity_begin(uuid)",
  "fluid_private.engine_identity_save_board(uuid,integer,jsonb,text,bigint)",
];
const PRIVATE_FUNCTIONS = [
  "fluid_private.engine_identity_policy()",
  "fluid_private.engine_identity_customer(uuid)",
  "fluid_private.engine_identity_close_job(public.generation_runs)",
  "fluid_private.engine_identity_cancel(uuid,uuid,uuid)",
];
async function failure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error as { message: string; code?: string };
  }
  throw new Error("Expected a failure");
}

describe("identity directions engine on a database built from migrations alone", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 180_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await resetFixture(db);
  });

  it("adds the kind disabled, with its credits, daily limit and running time", async () => {
    expect(
      (
        await db.query(
          "select kind, credits, enabled, max_per_day, max_running_minutes from fluid_private.generation_kinds where kind = 'identity.directions'",
        )
      ).rows,
    ).toEqual([{ kind: "identity.directions", credits: 3, enabled: false, max_per_day: 10, max_running_minutes: 35 }]);
  });

  it("grants the person-facing functions to signed-in people and the round writers to the engine login only", async () => {
    const grants = async (signature: string) =>
      (
        await db.query<Record<string, boolean>>(
          "select has_function_privilege('anon',$1,'EXECUTE') anon, has_function_privilege('authenticated',$1,'EXECUTE') authenticated, has_function_privilege('service_role',$1,'EXECUTE') service, has_function_privilege('embel_engine',$1,'EXECUTE') engine",
          [signature],
        )
      ).rows[0];
    for (const signature of PUBLIC_FUNCTIONS)
      expect(await grants(signature), signature).toEqual({
        anon: false,
        authenticated: true,
        service: false,
        engine: false,
      });
    for (const signature of ENGINE_FUNCTIONS)
      expect(await grants(signature), signature).toEqual({
        anon: false,
        authenticated: false,
        service: false,
        engine: true,
      });
    for (const signature of [...PRIVATE_FUNCTIONS, "fluid_private.finish_generation_run(uuid,text,text)"])
      expect(await grants(signature), signature).toEqual({
        anon: false,
        authenticated: false,
        service: false,
        engine: false,
      });
    // No PUBLIC entry on any of them: privileges are explicit, not inherited defaults.
    for (const signature of [
      ...PUBLIC_FUNCTIONS,
      ...ENGINE_FUNCTIONS,
      ...PRIVATE_FUNCTIONS,
      "fluid_private.finish_generation_run(uuid,text,text)",
    ]) {
      expect(
        (
          await db.query(
            "select exists(select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::regprocedure and a.grantee = 0) public_grant",
            [signature],
          )
        ).rows,
        signature,
      ).toEqual([{ public_grant: false }]);
    }
  });

  it("pins the policy identity the server computes", async () => {
    const policy = (
      await db.query<{ value: { policyIdentity: string; textPolicy: unknown; requestedModel: string } }>(
        "select fluid_private.engine_identity_policy() value",
      )
    ).rows[0]!.value;
    expect(policy).toEqual({
      policyIdentity: ENGINE_IDENTITY_POLICY_IDENTITY,
      textPolicy: ENGINE_IDENTITY_TEXT_POLICY,
      requestedModel: "gpt-image-2.6-sunburst",
    });
  });

  it("refuses rounds outside a verified PostgREST session, even with the kind on", async () => {
    await db.exec("update fluid_private.generation_kinds set enabled = true where kind = 'identity.directions'");
    const project = await seedProject(db, MIGRATIONS_OWNER);
    for (const sql of [
      "select public.get_identity_directions_availability($1)",
      "select public.start_identity_directions($1, '{}'::jsonb)",
      "select public.cancel_identity_directions($1, gen_random_uuid())",
      "select public.close_identity_directions_intent($1, '{}'::jsonb)",
    ]) {
      // The fixture's owner is a direct database session, not the authenticator login.
      const error = await asRole(db, "authenticated", MIGRATIONS_OWNER, () =>
        failure(() => db.query(sql, [project.id])),
      );
      expect(error, sql).toMatchObject({ code: "42501", message: "shared_identity_verified_account_required" });
      expect(
        await asRole(db, "authenticated", null, () => failure(() => db.query(sql, [project.id]))),
        sql,
      ).toMatchObject({ code: "42501", message: "unauthenticated" });
    }
    expect((await db.query("select count(*)::int n from public.generation_runs")).rows).toEqual([{ n: 0 }]);
  });

  it("replaces finish_generation_run so a round closes its job and keeps a credit per delivered board", async () => {
    const body = (
      await db.query<{ body: string }>(
        "select prosrc body from pg_proc where oid='fluid_private.finish_generation_run(uuid,text,text)'::regprocedure",
      )
    ).rows[0]!.body;
    expect(body).toContain("engine_identity_close_job");
    expect(body).toContain("'logo.concepts', 'logo.refine', 'identity.directions'");
  });
});

describe("identity directions engine with the selected-logo board packet", () => {
  let f: SharedIdentityFixture;
  beforeAll(async () => {
    f = await createSharedIdentityFixture();
  }, 120_000);
  afterAll(async () => {
    await f?.db.close();
  });
  beforeEach(async () => {
    await f.db.exec(
      "update fluid_private.engine_settings set paused = false, global_daily_cost_cap_microusd = 50000000",
    );
    await f.db.exec("update fluid_private.generation_kinds set enabled = true where kind = 'identity.directions'");
  });

  async function asEngine<T>(run: () => Promise<T>): Promise<T> {
    await f.db.exec("grant connect on database postgres to embel_engine; set session authorization embel_engine");
    try {
      return await run();
    } finally {
      await f.db.exec("set session authorization postgres");
    }
  }
  const engine = <T = Record<string, unknown>>(name: string, args: unknown[]) =>
    asEngine(
      async () =>
        (
          await f.db.query<{ value: T }>(
            `select fluid_private.${name}(${args.map((_, n) => `$${n + 1}`).join(",")}) as value`,
            args.map((arg) => (typeof arg === "object" && arg !== null ? JSON.stringify(arg) : arg)),
          )
        ).rows[0]!.value,
    );
  const balance = async (owner: string) => (await f.rpc<{ balance: number }>(owner, "get_credit_summary", [])).balance;

  /** A synthetic selected logo, as in selected-logo-boards.test.ts. */
  async function selectLogo(p: { owner: string; projectId: string }, n = 1) {
    const owner = p.owner,
      project = p.projectId,
      id = randomUUID(),
      aid = randomUUID(),
      vid = randomUUID(),
      pub = randomUUID(),
      job = randomUUID(),
      provider = randomUUID(),
      batch = randomUUID(),
      slot = randomUUID(),
      attempt = randomUUID();
    const bytes = syntheticPng(8, 8, (x, y) => [x * 20, y * 20, n * 30, 255]),
      digest = hash(bytes),
      path = `${owner}/${project}/${aid}/${vid}`;
    const existing = logoWorkspaceV2Schema.parse(await f.rpc(owner, "get_logo_workspace", [project]));
    let briefId = existing.stages.brief_references?.id;
    if (!briefId) {
      await f.db.query(
        "insert into public.logo_reference_snapshots(id,project_id,owner_id,revision,snapshot) values($1,$2,$3,1,$4)",
        [
          id,
          project,
          owner,
          JSON.stringify({ version: 2, id, ownerId: owner, projectId: project, revision: 1, references: [] }),
        ],
      );
      briefId = (
        await f.db.query<{ value: { id: string } }>("select fluid_private.logo_append_brief($1,$2,$3,$4,'[]') value", [
          owner,
          project,
          JSON.stringify({
            name: "Fixture",
            activity: "Synthetic company",
            audience: "Founders",
            personality: "Calm",
            logoTypes: ["wordmark"],
          }),
          id,
        ])
      ).rows[0]!.value.id;
    }
    const brief = (
      await f.db.query<{ record: { id: string; revision: number; payload: { referenceSnapshotId: string } } }>(
        "select record from public.logo_stage_revisions where id=$1",
        [briefId],
      )
    ).rows[0]!.record;
    const inputs = [{ stage: "brief_references", id: brief.id, revision: brief.revision }];
    await f.db.query(
      "insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd) values($1,$2,$3,'identity.logo_concept',1,$4,'{}',$5,'succeeded',0)",
      [job, owner, project, "a".repeat(64), randomUUID()],
    );
    await f.db.query(
      "insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'Synthetic selected logo','brand_asset')",
      [aid, owner, project],
    );
    await f.db.query(
      "insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,storage_path,provenance) values($1,$2,$3,$4,1,1,$5,$6,'image/png',$7,$8)",
      [vid, owner, project, aid, "a".repeat(64), digest, path, JSON.stringify({ publicationId: pub })],
    );
    const verification = {
      status: "verified",
      checkedAt: new Date().toISOString(),
      contentHash: digest,
      mimeType: "image/png",
      byteLength: bytes.length,
    };
    await f.db.query(
      "insert into public.logo_asset_publications(id,owner_id,project_id,request_key,request,asset_id,version_id,content_hash,mime_type,byte_length,purpose,source_receipt_id,source_kind,state,verification,input_revision,input_hash) values($1,$2,$3,$4,'{}',$5,$6,$7,'image/png',$8,'brand_asset',$4,'concept','committed',$9,1,$10)",
      [pub, owner, project, attempt, aid, vid, digest, bytes.length, JSON.stringify(verification), "a".repeat(64)],
    );
    const preview = (
      await f.db.query<{ value: unknown }>(
        "select fluid_private.logo_asset_receipt(r) value from public.logo_asset_publications r where id=$1",
        [pub],
      )
    ).rows[0]!.value;
    await f.db.query(
      "insert into public.logo_provider_responses(id,owner_id,project_id,job_id,lease_token,observation) values($1,$2,$3,$4,$5,'{}')",
      [provider, owner, project, job, randomUUID()],
    );
    await f.db.query("insert into public.logo_raster_results values($1,$2,$3,$4,$5)", [
      job,
      owner,
      project,
      JSON.stringify(preview),
      provider,
    ]);
    await f.db.query(
      "insert into public.logo_concept_batches(id,owner_id,project_id,request_key,brief_revision_id,reference_snapshot_id,plan,input_revisions) values($1,$2,$3,$4,$5,$6,fluid_private.logo_plan('[\"wordmark\"]',0),$7)",
      [batch, owner, project, randomUUID(), brief.id, brief.payload.referenceSnapshotId, JSON.stringify(inputs)],
    );
    await f.db.query("insert into public.logo_concept_slots values($1,$2,$3,$4,0,'wordmark','open_geometry')", [
      slot,
      batch,
      owner,
      project,
    ]);
    await f.db.query(
      "insert into public.logo_concept_attempts(id,owner_id,project_id,slot_id,job_id,request_key,attempt_number,input_hash) values($1,$2,$3,$4,$5,$6,1,$7)",
      [attempt, owner, project, slot, job, randomUUID(), "a".repeat(64)],
    );
    await f.db.query("select fluid_private.logo_append_stage($1,$2,'concepts',$3,$4)", [
      owner,
      project,
      JSON.stringify({
        batchIds: [batch],
        selected: { kind: "concept", batchId: batch, slotId: slot, attemptId: attempt },
      }),
      JSON.stringify(inputs),
    ]);
  }
  async function prepared(owner = OWNER_A) {
    const p = await f.project(owner);
    await selectLogo(p);
    const availability = logoBoardAvailabilitySchema.parse(
      await f.rpc(owner, "get_identity_directions_availability", [p.projectId]),
    );
    const intent = {
      version: 3 as const,
      spendControl: "uncapped" as const,
      sourceLogo: availability.sourceLogo.source,
      expectedLogoRevision: availability.expectedLogoRevision,
      expectedProjectRevision: availability.expectedProjectRevision,
      expectedReferenceRevision: availability.expectedReferenceRevision,
      expectedPreferencesRevision: availability.expectedPreferencesRevision,
      expectedIdentityRevision: availability.expectedIdentityRevision,
      idempotencyKey: `directions-${randomUUID()}`,
      acceptedPolicyIdentity: availability.policyIdentity,
    };
    return { ...p, availability, intent };
  }
  type Started = {
    replayed: boolean;
    run: { id: string; credits: number; status: string; input: { batchId: string; jobId: string } };
    batch: unknown;
  };
  async function start(p: Awaited<ReturnType<typeof prepared>>, intent: Record<string, unknown> = p.intent) {
    const started = await f.rpc<Started>(p.owner, "start_identity_directions", [p.projectId, intent]);
    return { replayed: started.replayed, run: started.run, batch: identityBatchStateSchema.parse(started.batch) };
  }
  async function claimed(p: Awaited<ReturnType<typeof prepared>>) {
    const started = await start(p);
    await engine("engine_claim", [started.run.id, `wrun_${started.run.id}`]);
    return started;
  }
  const batchState = async (owner: string, projectId: string, batchId: string) =>
    identityBatchStateSchema.parse(await f.rpc(owner, "get_shared_identity_batch", [projectId, batchId, null]));
  function boardSpecification(n: number): IdentitySystemSpecification {
    const value = specification(n);
    value.components.colors.swatches.push(
      { key: "background", name: "Background", hex: "#FFFFFF" },
      { key: "text", name: "Text", hex: "#111111" },
    );
    value.components.typography.styles[0]!.family = ["Lora", "Manrope", "Fraunces"][n - 1]!;
    return {
      ...value,
      applicationDesign: {
        version: 1,
        graphic: (["rounded_shapes", "fine_lines", "bold_blocks"] as const)[n - 1]!,
        layout: (["editorial", "centered", "split"] as const)[n - 1]!,
        paletteRoles: { primary: "primary", accent: "primary", background: "background", text: "text" },
        headingStyleKey: "body",
        bodyStyleKey: "body",
      },
    };
  }
  /** The engine stores the bytes first; the database then requires the object. */
  async function board(owner: string, projectId: string, n: number, stored = true) {
    const assetId = randomUUID(),
      versionId = randomUUID(),
      bytes = syntheticPng(8, 8, (x, y) => [x * 10, y * 10, n * 70, 255]);
    if (stored)
      await f.db.query("insert into storage.objects(bucket_id, name) values ('fluid-assets', $1)", [
        `${owner}/${projectId}/${assetId}/${versionId}`,
      ]);
    const spec = boardSpecification(n);
    return {
      state: "succeeded",
      specification: { components: spec.components, applicationDesign: spec.applicationDesign },
      image: { assetId, versionId, mimeType: "image/png", byteLength: bytes.byteLength, contentHash: hash(bytes) },
    };
  }

  it("offers a round under the engine's policy and starts it once per request", async () => {
    const p = await prepared();
    expect(p.availability).toMatchObject({
      status: "available",
      version: 3,
      policyIdentity: ENGINE_IDENTITY_POLICY_IDENTITY,
      estimatedCostMicrousd: null,
      requestedModel: "gpt-image-2.6-sunburst",
    });
    const before = await balance(OWNER_A);
    const first = await start(p);
    expect(first.run).toMatchObject({
      credits: 3,
      status: "queued",
      input: { version: 1, batchId: first.batch.batchId },
    });
    expect(first.batch).toMatchObject({
      status: "running",
      terminal: false,
      fulfillment: { status: "pending", acceptedCount: 0 },
      sourceLogoCurrent: true,
    });
    expect(await balance(OWNER_A)).toBe(before - 3);
    // A replay returns the same round and charges nothing.
    const replay = await start(p);
    expect(replay.run.id).toBe(first.run.id);
    expect([first.replayed, replay.replayed]).toEqual([false, true]);
    expect(replay.batch.batchId).toBe(first.batch.batchId);
    expect(await balance(OWNER_A)).toBe(before - 3);
    // The batch's job is the engine's: running under the run's lease, no shared admission.
    const job = (
      await f.db.query<{ state: string; lease_token: string; input: unknown; admitted: boolean }>(
        "select j.state, j.lease_token, j.input, exists(select 1 from fluid_private.shared_job_admissions a where a.job_id=j.id) admitted from public.jobs j where j.id=$1",
        [first.run.input.jobId],
      )
    ).rows[0]!;
    expect(job).toMatchObject({ state: "running", lease_token: first.run.id, admitted: false });
    expect(engineIdentityJobInputSchema.safeParse(job.input).success).toBe(true);
    // One round at a time: a second request waits.
    expect(await failure(() => start(p, { ...p.intent, idempotencyKey: `directions-${randomUUID()}` }))).toMatchObject({
      code: "PT409",
    });
    await f.rpc(OWNER_A, "cancel_identity_directions", [p.projectId, first.batch.batchId]);
  });

  it("refuses a request whose inputs or policy changed, another person's project, and a disabled kind", async () => {
    const p = await prepared();
    expect(await failure(() => start(p, { ...p.intent, acceptedPolicyIdentity: "b".repeat(64) }))).toMatchObject({
      code: "PT409",
      message: "identity_generation_policy_changed",
    });
    expect(
      await failure(() => start(p, { ...p.intent, expectedLogoRevision: p.intent.expectedLogoRevision + 1 })),
    ).toMatchObject({ code: "PT409" });
    expect(await failure(() => f.rpc(OWNER_B, "start_identity_directions", [p.projectId, p.intent]))).toMatchObject({
      code: "P0002",
    });
    await f.db.exec("update fluid_private.generation_kinds set enabled = false where kind = 'identity.directions'");
    expect(await failure(() => start(p))).toMatchObject({ code: "55000", message: "generation_unavailable" });
    expect(
      (
        await f.db.query(
          "select count(*)::int n from public.identity_batches b join public.identity_input_snapshots i on i.id=b.input_id where b.project_id=$1",
          [p.projectId],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  });

  it("records delivered and failed boards as Creative direction records, readable and selectable unchanged", async () => {
    const p = await prepared(),
      before = await balance(OWNER_A),
      { run, batch } = await claimed(p);
    const begun = await engine<{ pending: number[]; prior: unknown[]; job: unknown }>("engine_identity_begin", [
      run.id,
    ]);
    expect(begun).toMatchObject({ pending: [1, 2, 3], prior: [], batchId: batch.batchId, jobId: run.input.jobId });
    // The bytes must be in Storage under the owner's path before the board is recorded.
    expect(await failure(() => engine("engine_identity_save_board", [run.id, 1, null, null, 0]))).toMatchObject({
      code: "22023",
    });
    const unstored = await board(OWNER_A, p.projectId, 1, false);
    expect(
      (await failure(() => engine("engine_identity_save_board", [run.id, 1, unstored, "req_1", 40_000]))).message,
    ).toContain("image_not_stored");
    const first = await engine<{ state: string; systemId: string }>("engine_identity_save_board", [
      run.id,
      1,
      await board(OWNER_A, p.projectId, 1),
      "req_1",
      40_000,
    ]);
    expect(first).toMatchObject({ state: "succeeded" });
    // A replay returns the same output and adds nothing.
    expect(
      await engine("engine_identity_save_board", [run.id, 1, await board(OWNER_A, p.projectId, 1), "req_1", 40_000]),
    ).toEqual(first);
    expect(
      await engine("engine_identity_save_board", [run.id, 2, { state: "failed", code: "provider_rejected" }, null, 0]),
    ).toEqual({ state: "failed", code: "provider_rejected" });
    // The same direction twice in one round is not a second direction.
    const twin = await board(OWNER_A, p.projectId, 1);
    expect(await engine("engine_identity_save_board", [run.id, 3, twin, "req_3", 39_000])).toEqual({
      state: "failed",
      code: "duplicate_identity_direction",
    });

    const state = await batchState(OWNER_A, p.projectId, batch.batchId);
    expect(state).toMatchObject({ status: "running", fulfillment: { status: "partial", acceptedCount: 1 } });
    expect(state.systems[0]).toMatchObject({
      id: first.systemId,
      source: { kind: "generated", batchId: batch.batchId, stepKey: "identity-system-v1:1" },
      applicationDesign: boardSpecification(1).applicationDesign,
      board: { asset: { ownerId: OWNER_A, projectId: p.projectId, purpose: "brand_asset" } },
    });
    // The engine's later begin skips saved directions and passes their components on.
    expect(await engine("engine_identity_begin", [run.id])).toMatchObject({
      pending: [],
      prior: [boardSpecification(1).components],
    });

    // The run keeps one credit per delivered board and closes its job.
    expect(await engine("engine_finish", [run.id, "succeeded", "provider_rejected"])).toMatchObject({
      status: "succeeded",
    });
    expect(await balance(OWNER_A)).toBe(before - 1);
    const closed = await batchState(OWNER_A, p.projectId, batch.batchId);
    expect(closed).toMatchObject({
      status: "partial",
      terminal: true,
      fulfillment: { status: "partial", acceptedCount: 1 },
      usage: { status: "recorded" },
    });
    const job = (
      await f.db.query<{ actual: string; lease: string | null }>(
        "select actual_cost_microusd::text actual, lease_token lease from public.jobs where id=$1",
        [run.input.jobId],
      )
    ).rows[0]!;
    expect(job).toEqual({ actual: "79000", lease: null });

    // The direction is selectable through the existing selection transaction.
    const selected = await selectSystem({ owner: OWNER_A, projectId: p.projectId }, first.systemId);
    expect(selected.currentSelection.selection.systemVersionId).toBe(first.systemId);
    // A replay after the round ended returns the saved output.
    expect(
      await engine("engine_identity_save_board", [run.id, 3, await board(OWNER_A, p.projectId, 3), "req_late", 1]),
    ).toEqual({ state: "failed", code: "duplicate_identity_direction" });
  });

  it("delivers all three boards as a succeeded batch", async () => {
    const p = await prepared(),
      before = await balance(OWNER_A),
      { run, batch } = await claimed(p);
    for (const n of [1, 2, 3])
      expect(
        await engine("engine_identity_save_board", [run.id, n, await board(OWNER_A, p.projectId, n), `req_${n}`, 1000]),
      ).toMatchObject({ state: "succeeded" });
    await engine("engine_finish", [run.id, "succeeded", null]);
    expect(await balance(OWNER_A)).toBe(before - 3);
    expect(await batchState(OWNER_A, p.projectId, batch.batchId)).toMatchObject({
      status: "succeeded",
      terminal: true,
      fulfillment: { status: "complete", acceptedCount: 3 },
    });
  });

  it("stops a round: Stop cancels the run, delivered boards stay, a late board is discarded and undelivered credits return", async () => {
    const p = await prepared(),
      before = await balance(OWNER_A),
      { run, batch } = await claimed(p);
    await engine("engine_identity_save_board", [run.id, 1, await board(OWNER_A, p.projectId, 1), "req_1", 1000]);
    const stopping = identityBatchStateSchema.parse(
      await f.rpc(OWNER_A, "cancel_identity_directions", [p.projectId, batch.batchId]),
    );
    expect(stopping).toMatchObject({ status: "cancel_requested", terminal: false });
    expect(await engine("engine_check", [run.id])).toMatchObject({ status: "running", cancelRequested: true });
    await engine("engine_finish", [run.id, "cancelled", "cancelled"]);
    expect(
      await engine("engine_identity_save_board", [run.id, 2, await board(OWNER_A, p.projectId, 2), "req_2", 2000]),
    ).toEqual({ state: "discarded", code: "run_stopped" });
    expect(await balance(OWNER_A)).toBe(before - 1);
    expect(await batchState(OWNER_A, p.projectId, batch.batchId)).toMatchObject({
      status: "cancelled",
      terminal: true,
      fulfillment: { status: "partial", acceptedCount: 1 },
    });
    // Another person can't stop it.
    expect(
      await failure(() => f.rpc(OWNER_B, "cancel_identity_directions", [p.projectId, batch.batchId])),
    ).toBeTruthy();
  });

  it("returns every credit of a round that delivered nothing, and ends a round that ran too long", async () => {
    const p = await prepared(),
      before = await balance(OWNER_A),
      { run, batch } = await claimed(p);
    expect(await engine("engine_finish", [run.id, "succeeded", null])).toMatchObject({
      status: "failed",
      errorCode: "no_boards_delivered",
    });
    expect(await balance(OWNER_A)).toBe(before);
    expect(await batchState(OWNER_A, p.projectId, batch.batchId)).toMatchObject({
      status: "failed",
      terminal: true,
      fulfillment: { status: "none" },
    });

    const late = await claimed({ ...p, intent: { ...p.intent, idempotencyKey: `directions-${randomUUID()}` } });
    await engine("engine_identity_save_board", [late.run.id, 1, await board(OWNER_A, p.projectId, 1), "req_1", 1000]);
    await f.db.query("update public.generation_runs set started_at = now() - interval '36 minutes' where id=$1", [
      late.run.id,
    ]);
    // Any later request ends the overdue round first, with a refund for what it didn't deliver.
    await f.rpc(OWNER_A, "cancel_identity_directions", [p.projectId, late.batch.batchId]);
    expect(
      (await f.db.query("select status, error_code from public.generation_runs where id=$1", [late.run.id])).rows,
    ).toEqual([{ status: "failed", error_code: "run_timed_out" }]);
    expect(await batchState(OWNER_A, p.projectId, late.batch.batchId)).toMatchObject({
      status: "partial",
      terminal: true,
      fulfillment: { acceptedCount: 1 },
    });
    expect(await balance(OWNER_A)).toBe(before - 1);
  });

  it("closes an unconfirmed request: a tombstone before admission, a stop after it", async () => {
    const p = await prepared();
    const closed = await f.rpc<{ status: string }>(OWNER_A, "close_identity_directions_intent", [
      p.projectId,
      p.intent,
    ]);
    expect(closed).toMatchObject({ status: "not_admitted" });
    expect(await failure(() => start(p))).toMatchObject({
      code: "PT409",
      message: "identity_generation_intent_closed",
    });
    const admitted = { ...p.intent, idempotencyKey: `directions-${randomUUID()}` },
      started = await start(p, admitted);
    const stopped = await f.rpc<{ status: string; batch: unknown }>(OWNER_A, "close_identity_directions_intent", [
      p.projectId,
      admitted,
    ]);
    expect(stopped.status).toBe("admitted");
    expect(identityBatchStateSchema.parse(stopped.batch).batchId).toBe(started.batch.batchId);
    // A queued run that never started ends at once with a full refund.
    expect((await f.db.query("select status from public.generation_runs where id=$1", [started.run.id])).rows).toEqual([
      { status: "cancelled" },
    ]);
    expect(await batchState(OWNER_A, p.projectId, started.batch.batchId)).toMatchObject({
      status: "cancelled",
      terminal: true,
    });
  });

  it("checks every board the way readers do, and only for the run's own batch", async () => {
    const p = await prepared(),
      { run } = await claimed(p);
    const bad = await board(OWNER_A, p.projectId, 1);
    bad.specification.applicationDesign = {
      ...bad.specification.applicationDesign!,
      paletteRoles: { primary: "missing", accent: "primary", background: "background", text: "text" },
    };
    expect(await failure(() => engine("engine_identity_save_board", [run.id, 1, bad, "req_bad", 0]))).toMatchObject({
      code: "22023",
    });
    const foreign = await board(OWNER_B, p.projectId, 2);
    expect(
      (await failure(() => engine("engine_identity_save_board", [run.id, 2, foreign, "req_foreign", 0]))).message,
    ).toContain("image_not_stored");
    const outOfRange = await board(OWNER_A, p.projectId, 1);
    expect(await failure(() => engine("engine_identity_save_board", [run.id, 4, outOfRange, null, 0]))).toMatchObject({
      code: "22023",
    });
    expect(
      await failure(() =>
        asRole(f.db, "authenticated", OWNER_A, () =>
          f.db.query("select fluid_private.engine_identity_begin($1)", [run.id]),
        ),
      ),
    ).toMatchObject({ code: "42501" });
    await engine("engine_finish", [run.id, "failed", "generation_failed"]);
  });

  async function selectSystem(p: { owner: string; projectId: string }, systemVersionId: string, identityRevision = 0) {
    const availability = logoBoardAvailabilitySchema.parse(
      await f.rpc(p.owner, "get_identity_directions_availability", [p.projectId]),
    );
    const request = {
      systemVersionId,
      expectedProjectRevision: availability.expectedProjectRevision,
      expectedReferenceRevision: availability.expectedReferenceRevision,
      expectedPreferencesRevision: availability.expectedPreferencesRevision,
      expectedIdentityRevision: identityRevision,
      acceptEarlierBasis: false,
    };
    const token = await f.issue(p.owner, "identity", "identity", [p.projectId, request, false]),
      role = sharedHttpRoles.identity;
    const oid = (await f.db.query<{ oid: number }>("select oid::int oid from pg_roles where rolname=$1", [role]))
      .rows[0]!.oid;
    const factory: IdentityConnectionFactory = {
      async acquire() {
        return {
          binding: { ownerId: p.owner, roleName: role, roleOid: oid },
          connection: {
            async query(sql, parameters = []) {
              if (sql.includes("set_config('request.jwt.claim.sub'")) return { rows: [] };
              if (sql.includes("prepare_identity_transaction"))
                return f.db.query("select public.prepare_shared_identity_request($1,$2,$3,$4) value", [
                  token.token,
                  ...parameters,
                ]);
              if (sql.includes("commit_identity_transaction"))
                return f.db.query("select public.commit_shared_identity_request($1,$2,$3) value", [...parameters]);
              if (sql === "COMMIT") await f.db.query("select public.finish_shared_identity_request()");
              return f.db.query(sql, [...parameters]);
            },
            release() {},
            discard() {},
          },
        };
      },
    };
    return f.asSession(role, async () => {
      await qualifySharedHttpConnection(
        { query: (sql, args) => f.db.query(sql, [...(args ?? [])]), release() {}, discard() {} },
        "identity",
        { roleName: role, roleOid: oid, host: "inert", port: 5432, tls: true, user: role, password: "inert" },
        "https://fricsfwqibyhemknqgyf.supabase.co",
      );
      return createIdentityTransactionService(factory).select({ userId: p.owner }, p.projectId, request);
    });
  }
});
