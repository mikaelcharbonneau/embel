import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { logoConceptBatchSchema, logoRasterRefinementSchema } from "../../src/domain/logo-jobs";
import {
  logoMutationReceiptSchema,
  logoWorkspaceV2Schema,
  type LogoWorkspaceV2,
} from "../../src/domain/logo-workspace";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "./local-supabase";
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";

// The Logo kinds, delivery-based refunds, and the engine's Logo records on the baseline.
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 180_000);
beforeEach(async () => {
  await resetFixture(db);
  await db.exec("update fluid_private.engine_settings set paused = false, global_daily_cost_cap_microusd = 50000000");
  await db.exec("update fluid_private.generation_kinds set enabled = false where kind like 'logo.%'");
});

const hex = (seed: string) => seed.repeat(64).slice(0, 64);
const brief = {
  name: "Lumen",
  activity: "Neighbourhood bakery",
  audience: "Office teams",
  personality: "Warm and honest",
  logoTypes: ["wordmark", "pictorial"],
};
const rpc = (owner: string, name: string, args: unknown[]) =>
  asRole(
    db,
    "authenticated",
    owner,
    async () =>
      (
        await db.query<{ value: unknown }>(
          `select public.${name}(${args.map((_, n) => `$${n + 1}`).join(",")}) as value`,
          args.map((arg) => (typeof arg === "object" && arg !== null ? JSON.stringify(arg) : arg)),
        )
      ).rows[0]!.value,
  );
const cancel = (owner: string, runId: string) =>
  asRole(
    db,
    "authenticated",
    owner,
    async () =>
      (
        await db.query<{ status: string; error_code: string | null }>(
          "select status, error_code from public.cancel_generation($1)",
          [runId],
        )
      ).rows[0]!,
  );
async function failure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error as { message: string; code?: string };
  }
  throw new Error("Expected a failure");
}
/** Logs in as the engine role the way production does; no passwords in the fixture. */
async function asEngine<T>(run: () => Promise<T>): Promise<T> {
  await db.exec("grant connect on database postgres to embel_engine; set session authorization embel_engine");
  try {
    return await run();
  } finally {
    await db.exec("set session authorization postgres");
  }
}
const engine = <T = Record<string, unknown>>(name: string, args: unknown[]) =>
  asEngine(
    async () =>
      (
        await db.query<{ value: T }>(
          `select fluid_private.${name}(${args.map((_, n) => `$${n + 1}`).join(",")}) as value`,
          args.map((arg) => (typeof arg === "object" && arg !== null ? JSON.stringify(arg) : arg)),
        )
      ).rows[0]!.value,
  );

async function project(owner = OWNER_A): Promise<LogoWorkspaceV2> {
  return logoWorkspaceV2Schema.parse(
    await startLogoFixture(ownerQuery(db, owner), { requestKey: randomUUID(), brief }),
  );
}
const workspace = async (owner: string, projectId: string) =>
  logoWorkspaceV2Schema.parse(await rpc(owner, "get_logo_workspace", [projectId]));
async function startRun(owner: string, projectId: string, kind: string, input: Record<string, unknown>) {
  return asRole(
    db,
    "authenticated",
    owner,
    async () =>
      (
        await db.query<{ id: string; credits: number; status: string }>(
          "select * from public.start_generation($1, $2, $3, $4::jsonb)",
          [projectId, kind, `logo-test:${randomUUID()}`, JSON.stringify(input)],
        )
      ).rows[0]!,
  );
}
async function conceptsRun(w: LogoWorkspaceV2, extra: Record<string, unknown> = {}, owner = OWNER_A) {
  const ref = w.stages.brief_references!;
  const run = await startRun(owner, w.projectId, "logo.concepts", {
    version: 1,
    revision: w.heads.projectRevision,
    operation: "concepts",
    expected: w.heads,
    brief: { id: ref.id, revision: ref.revision },
    batchId: randomUUID(),
    ...extra,
  });
  await engine("engine_claim", [run.id, `wrun_${run.id}`]);
  return run;
}
/** The engine stores the bytes first; the database then requires the object. */
async function stored(owner: string, projectId: string) {
  const assetId = randomUUID(),
    versionId = randomUUID();
  await db.query("insert into storage.objects(bucket_id, name) values ('fluid-assets', $1)", [
    `${owner}/${projectId}/${assetId}/${versionId}`,
  ]);
  return { assetId, versionId };
}
async function drawn(owner: string, projectId: string, seed: string) {
  return {
    state: "succeeded",
    image: {
      ...(await stored(owner, projectId)),
      contentHash: hex(seed),
      byteLength: 2048,
      mimeType: "image/png",
      normalizedPixelHash: hex(seed === "a" ? "b" : seed === "b" ? "c" : "d"),
    },
    provider: {
      model: "gpt-image-2.6-sunburst",
      providerRequestId: `req_${seed}`,
      responseHash: hex("e"),
      observedAt: new Date().toISOString(),
    },
  };
}
const balance = async (owner: string) => ((await rpc(owner, "get_credit_summary", [])) as { balance: number }).balance;
const batchOf = async (owner: string, projectId: string, batchId: string) =>
  logoConceptBatchSchema.parse(await rpc(owner, "read_logo_workspace_record", [projectId, "concept_batch", batchId]));

describe("Logo generation kinds", () => {
  it("lists the three Logo kinds disabled, with their credits and limits, and refuses them until enabled", async () => {
    const kinds = (
      await db.query<{
        kind: string;
        credits: number;
        enabled: boolean;
        max_per_day: number;
        max_running_minutes: number;
      }>(
        "select kind, credits, enabled, max_per_day, max_running_minutes from fluid_private.generation_kinds where kind like 'logo.%' order by kind",
      )
    ).rows;
    expect(kinds).toEqual([
      { kind: "logo.concepts", credits: 6, enabled: false, max_per_day: 20, max_running_minutes: 20 },
      { kind: "logo.refine", credits: 1, enabled: false, max_per_day: 60, max_running_minutes: 15 },
      { kind: "logo.style_note", credits: 0, enabled: false, max_per_day: 30, max_running_minutes: 10 },
    ]);
    const w = await project();
    expect((await failure(() => startRun(OWNER_A, w.projectId, "logo.concepts", { version: 1 }))).message).toContain(
      "generation_unavailable",
    );
    await db.exec("update fluid_private.generation_kinds set enabled = true where kind like 'logo.%'");
    expect((await startRun(OWNER_A, w.projectId, "logo.concepts", { version: 1 })).credits).toBe(6);
    expect(await balance(OWNER_A)).toBe(24);
  });

  it("lets only the engine login call the Logo engine functions", async () => {
    for (const signature of [
      "fluid_private.engine_logo_begin(uuid)",
      "fluid_private.engine_logo_save_image(uuid,text,jsonb,text,bigint)",
    ]) {
      const grants = (
        await db.query<{ anon: boolean; authenticated: boolean; service: boolean; engine: boolean }>(
          "select has_function_privilege('anon',$1,'EXECUTE') anon, has_function_privilege('authenticated',$1,'EXECUTE') authenticated, has_function_privilege('service_role',$1,'EXECUTE') service, has_function_privilege('embel_engine',$1,'EXECUTE') engine",
          [signature],
        )
      ).rows[0];
      expect(grants).toEqual({ anon: false, authenticated: false, service: false, engine: true });
    }
  });
});

describe("Logo concepts on the engine", () => {
  beforeEach(async () => {
    await db.exec("update fluid_private.generation_kinds set enabled = true where kind like 'logo.%'");
  });

  it("opens a round as a concept batch of six planned slots, once", async () => {
    const w = await project(),
      run = await conceptsRun(w);
    const begun = await engine<{
      batchId: string;
      slots: { ordinal: number; slotId: string; type: string; directionId: string }[];
      plan: { coveredTypes: string[] };
    }>("engine_logo_begin", [run.id]);
    expect(begun.slots.map((slot) => slot.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(begun.slots.map((slot) => slot.type))).toEqual(new Set(["wordmark", "pictorial"]));
    expect(await engine("engine_logo_begin", [run.id])).toEqual(begun);
    const batch = await batchOf(OWNER_A, w.projectId, begun.batchId);
    expect(batch).toMatchObject({ requestKey: run.id, briefRevisionId: w.stages.brief_references!.id });
    expect(batch.slots.every((slot) => slot.attempts.length === 0)).toBe(true);
    const outputs = (
      await db.query<{ output_key: string; output: unknown }>(
        "select output_key, output from public.generation_outputs where run_id=$1",
        [run.id],
      )
    ).rows;
    expect(outputs).toEqual([{ output_key: "batch", output: { batchId: begun.batchId } }]);
  });

  it("refuses a brief that is not the person's own", async () => {
    const mine = await project(OWNER_A),
      theirs = await project(OWNER_B);
    const run = await startRun(OWNER_A, mine.projectId, "logo.concepts", {
      version: 1,
      revision: 1,
      operation: "concepts",
      expected: mine.heads,
      brief: { id: theirs.stages.brief_references!.id, revision: 1 },
      batchId: randomUUID(),
    });
    await engine("engine_claim", [run.id, "wrun_theirs"]);
    expect((await failure(() => engine("engine_logo_begin", [run.id]))).message).toContain("invalid_run_input");
  });

  it("records drawn and failed images as attempts the Logo screens show, select and retry", async () => {
    const w = await project(),
      run = await conceptsRun(w);
    const { batchId, slots } = await engine<{ batchId: string; slots: { slotId: string }[] }>("engine_logo_begin", [
      run.id,
    ]);
    // The bytes must be in Storage under the owner's path before the image is recorded.
    const missing = { ...(await drawn(OWNER_A, w.projectId, "a")) };
    missing.image = { ...missing.image, versionId: randomUUID() };
    expect(
      (await failure(() => engine("engine_logo_save_image", [run.id, "image.0", missing, "req_a", 31_000]))).message,
    ).toContain("image_not_stored");
    const first = await engine<{ state: string; attemptId: string }>("engine_logo_save_image", [
      run.id,
      "image.0",
      await drawn(OWNER_A, w.projectId, "a"),
      "req_a",
      31_000,
    ]);
    expect(first).toMatchObject({ state: "succeeded", ordinal: 0, batchId });
    // A replay returns the same output and adds nothing.
    expect(
      await engine("engine_logo_save_image", [
        run.id,
        "image.0",
        await drawn(OWNER_A, w.projectId, "a"),
        "req_a",
        31_000,
      ]),
    ).toEqual(first);
    // The same picture twice in one round is a failed concept, not a second one.
    const twin = await drawn(OWNER_A, w.projectId, "f");
    twin.image.normalizedPixelHash = hex("b");
    expect(await engine("engine_logo_save_image", [run.id, "image.1", twin, "req_f", 30_000])).toMatchObject({
      state: "failed",
      code: "duplicate_preview",
    });
    expect(
      await engine("engine_logo_save_image", [
        run.id,
        "image.2",
        { state: "failed", code: "provider_outcome_unknown" },
        null,
        0,
      ]),
    ).toMatchObject({ state: "failed" });

    const batch = await batchOf(OWNER_A, w.projectId, batchId);
    const [zero, one, two] = batch.slots;
    expect(zero!.attempts).toHaveLength(1);
    expect(zero!.attempts[0]).toMatchObject({
      id: first.attemptId,
      state: "succeeded",
      billing: { status: "recorded", confirmedMicrousd: 31_000 },
      requestKey: run.id,
    });
    expect(zero!.attempts[0]!.preview).toMatchObject({
      publicationState: "committed",
      purpose: "brand_asset",
      reference: { ownerId: OWNER_A, projectId: w.projectId },
    });
    expect(one!.attempts[0]).toMatchObject({
      state: "failed",
      reason: "duplicate_preview",
      billing: { status: "recorded", confirmedMicrousd: 30_000 },
    });
    expect(two!.attempts[0]).toMatchObject({
      state: "failed",
      reason: "provider_outcome_unknown",
      billing: { status: "recorded", confirmedMicrousd: 0 },
    });
    expect(batch.slots.slice(3).every((slot) => slot.attempts.length === 0)).toBe(true);
    // The person can download the image: its version row points at the stored object.
    const version = (
      await db.query<{ storage_path: string }>("select storage_path from public.asset_versions where id=$1", [
        zero!.attempts[0]!.preview!.reference.versionId,
      ])
    ).rows[0]!;
    expect(version.storage_path).toBe(
      `${OWNER_A}/${w.projectId}/${zero!.attempts[0]!.preview!.reference.assetId}/${zero!.attempts[0]!.preview!.reference.versionId}`,
    );

    // Selecting the drawn concept works exactly as for the shared worker's.
    const current = await workspace(OWNER_A, w.projectId);
    const selected = logoMutationReceiptSchema.parse(
      await rpc(OWNER_A, "apply_logo_workspace_command", [
        w.projectId,
        {
          method: "selectLogoConcept",
          body: {
            requestKey: randomUUID(),
            expected: current.heads,
            batchId,
            slotId: slots[0]!.slotId,
            attemptId: first.attemptId,
          },
        },
      ]),
    );
    expect(selected.revision.payload).toMatchObject({
      batchIds: [batchId],
      selected: { kind: "concept", attemptId: first.attemptId },
    });

    // Finishing keeps one credit per delivered image and returns the other five.
    expect(await engine("engine_finish", [run.id, "succeeded", null])).toMatchObject({ status: "succeeded" });
    expect(await balance(OWNER_A)).toBe(29);
    const refund = (
      await db.query("select delta, note from public.credit_entries where run_id=$1 and kind='refund'", [run.id])
    ).rows;
    expect(refund).toEqual([{ delta: 5, note: "Images that were not delivered" }]);

    // A later round retries only the slots whose last attempt failed.
    const later = await workspace(OWNER_A, w.projectId);
    const retry = await conceptsRun(later, {
      operation: "retry_failed",
      batchId,
      slotIds: [slots[1]!.slotId, slots[2]!.slotId],
    });
    const again = await engine<{ slots: { ordinal: number }[] }>("engine_logo_begin", [retry.id]);
    expect(again.slots.map((slot) => slot.ordinal)).toEqual([1, 2]);
    const second = await engine<{ attemptId: string }>("engine_logo_save_image", [
      retry.id,
      "image.1",
      await drawn(OWNER_A, w.projectId, "9"),
      "req_9",
      30_000,
    ]);
    expect(
      (await batchOf(OWNER_A, w.projectId, batchId)).slots[1]!.attempts.map((attempt) => [
        attempt.attemptNumber,
        attempt.state,
        attempt.id,
      ]),
    ).toEqual([
      [1, "failed", one!.attempts[0]!.id],
      [2, "succeeded", second.attemptId],
    ]);
    expect(
      (
        await failure(() =>
          engine("engine_logo_save_image", [
            retry.id,
            "image.3",
            { state: "failed", code: "provider_rejected" },
            null,
            0,
          ]),
        )
      ).message,
    ).toContain("invalid_input");
    await engine("engine_finish", [retry.id, "succeeded", null]);
    const retryOfSucceeded = await conceptsRun(await workspace(OWNER_A, w.projectId), {
      operation: "retry_failed",
      batchId,
      slotIds: [slots[0]!.slotId],
    });
    expect((await failure(() => engine("engine_logo_begin", [retryOfSucceeded.id]))).message).toContain(
      "logo_retry_requires_confirmed_failure",
    );
  });

  it("keeps usage but not the picture of an image that finishes after the run was stopped", async () => {
    const w = await project(),
      run = await conceptsRun(w);
    await engine("engine_logo_begin", [run.id]);
    await engine("engine_logo_save_image", [
      run.id,
      "image.0",
      await drawn(OWNER_A, w.projectId, "a"),
      "req_a",
      31_000,
    ]);
    expect(await cancel(OWNER_A, run.id)).toMatchObject({ status: "running" });
    expect(await engine("engine_finish", [run.id, "cancelled", "cancelled"])).toMatchObject({ status: "cancelled" });
    expect(
      await engine("engine_logo_save_image", [
        run.id,
        "image.1",
        await drawn(OWNER_A, w.projectId, "b"),
        "req_b",
        30_000,
      ]),
    ).toEqual({ state: "discarded", code: "run_stopped" });
    const outputs = (
      await db.query<{ output_key: string; cost_microusd: string }>(
        "select output_key, cost_microusd from public.generation_outputs where run_id=$1 order by output_key",
        [run.id],
      )
    ).rows;
    expect(outputs.map((row) => [row.output_key, Number(row.cost_microusd)])).toEqual([
      ["batch", 0],
      ["image.0", 31_000],
      ["image.1", 30_000],
    ]);
    // One delivered image is kept; the rest of the six credits come back.
    expect(await balance(OWNER_A)).toBe(29);
    expect(
      (await db.query("select count(*)::int n from public.logo_concept_attempts where request_key=$1", [run.id])).rows,
    ).toEqual([{ n: 1 }]);
  });

  it("returns every credit of a round that delivered nothing, and fails it", async () => {
    const w = await project(),
      run = await conceptsRun(w);
    await engine("engine_logo_begin", [run.id]);
    await engine("engine_logo_save_image", [
      run.id,
      "image.0",
      { state: "failed", code: "provider_rejected" },
      null,
      0,
    ]);
    expect(await engine("engine_finish", [run.id, "succeeded", null])).toMatchObject({
      status: "failed",
      errorCode: "no_images_delivered",
    });
    expect(await balance(OWNER_A)).toBe(30);
  });

  it("refunds undelivered images of a round that stopped reporting", async () => {
    const w = await project(),
      run = await conceptsRun(w);
    await engine("engine_logo_begin", [run.id]);
    await engine("engine_logo_save_image", [
      run.id,
      "image.0",
      await drawn(OWNER_A, w.projectId, "a"),
      "req_a",
      31_000,
    ]);
    await engine("engine_logo_save_image", [
      run.id,
      "image.1",
      await drawn(OWNER_A, w.projectId, "b"),
      "req_b",
      31_000,
    ]);
    await db.query("update public.generation_runs set started_at = now() - interval '21 minutes' where id=$1", [
      run.id,
    ]);
    expect(await cancel(OWNER_A, run.id)).toMatchObject({ status: "failed", error_code: "run_timed_out" });
    expect(await balance(OWNER_A)).toBe(28);
  });

  it("keeps refunds unchanged for other kinds", async () => {
    await db.exec("update fluid_private.generation_kinds set enabled = true where kind = 'strategy.audience'");
    const w = await project();
    const failed = await startRun(OWNER_A, w.projectId, "strategy.audience", { revision: 1 });
    await engine("engine_claim", [failed.id, "wrun_strategy_1"]);
    await engine("engine_finish", [failed.id, "failed", "provider_rejected"]);
    const succeeded = await startRun(OWNER_A, w.projectId, "strategy.audience", { revision: 1 });
    await engine("engine_claim", [succeeded.id, "wrun_strategy_2"]);
    await engine("engine_finish", [succeeded.id, "succeeded", null]);
    expect(await balance(OWNER_A)).toBe(29);
  });
});

describe("Logo refinements on the engine", () => {
  beforeEach(async () => {
    await db.exec("update fluid_private.generation_kinds set enabled = true where kind like 'logo.%'");
  });

  async function chosenConcept() {
    const w = await project(),
      run = await conceptsRun(w);
    const { batchId, slots } = await engine<{ batchId: string; slots: { slotId: string }[] }>("engine_logo_begin", [
      run.id,
    ]);
    const saved = await engine<{ attemptId: string }>("engine_logo_save_image", [
      run.id,
      "image.0",
      await drawn(OWNER_A, w.projectId, "a"),
      "req_a",
      31_000,
    ]);
    await engine("engine_finish", [run.id, "succeeded", null]);
    const source = { kind: "concept", batchId, slotId: slots[0]!.slotId, attemptId: saved.attemptId };
    await rpc(OWNER_A, "apply_logo_workspace_command", [
      w.projectId,
      {
        method: "selectLogoConcept",
        body: {
          requestKey: randomUUID(),
          expected: (await workspace(OWNER_A, w.projectId)).heads,
          batchId,
          slotId: slots[0]!.slotId,
          attemptId: saved.attemptId,
        },
      },
    ]);
    return { w: await workspace(OWNER_A, w.projectId), source };
  }

  it("records a refined image, moves the refinements head and lets the person select it", async () => {
    const { w, source } = await chosenConcept();
    const ref = w.stages.brief_references!;
    const run = await startRun(OWNER_A, w.projectId, "logo.refine", {
      version: 1,
      revision: w.heads.projectRevision,
      expected: w.heads,
      brief: { id: ref.id, revision: ref.revision },
      source,
      instruction: "Bolder lettering",
    });
    await engine("engine_claim", [run.id, `wrun_${run.id}`]);
    const saved = await engine<{ state: string; rasterRevisionId: string }>("engine_logo_save_image", [
      run.id,
      "image.refine",
      await drawn(OWNER_A, w.projectId, "8"),
      "req_8",
      40_000,
    ]);
    expect(saved.state).toBe("succeeded");
    const record = logoRasterRefinementSchema.parse(
      await rpc(OWNER_A, "read_logo_workspace_record", [w.projectId, "raster_refinement", saved.rasterRevisionId]),
    );
    expect(record).toMatchObject({
      requestKey: run.id,
      source,
      logoType: expect.any(String),
      state: "succeeded",
      preview: { publicationState: "committed" },
    });
    const after = await workspace(OWNER_A, w.projectId);
    const refinements = (await rpc(OWNER_A, "read_logo_workspace_record", [
      w.projectId,
      "stage",
      after.stages.refinements!.id,
    ])) as { payload: { rasterRevisionIds: string[]; sourceRequestKey: string } };
    expect(refinements.payload).toMatchObject({
      rasterRevisionIds: [saved.rasterRevisionId],
      sourceRequestKey: run.id,
    });
    logoMutationReceiptSchema.parse(
      await rpc(OWNER_A, "apply_logo_workspace_command", [
        w.projectId,
        {
          method: "selectLogoRaster",
          body: {
            requestKey: randomUUID(),
            expected: after.heads,
            source: { kind: "refinement", rasterRevisionId: saved.rasterRevisionId },
          },
        },
      ]),
    );
    await engine("engine_finish", [run.id, "succeeded", null]);
    expect(await balance(OWNER_A)).toBe(30 - 1 - 1);
  });

  it("returns the credit of a refinement that failed", async () => {
    const { w, source } = await chosenConcept();
    const ref = w.stages.brief_references!;
    const run = await startRun(OWNER_A, w.projectId, "logo.refine", {
      version: 1,
      revision: w.heads.projectRevision,
      expected: w.heads,
      brief: { id: ref.id, revision: ref.revision },
      source,
      instruction: "x",
    });
    await engine("engine_claim", [run.id, `wrun_${run.id}`]);
    await engine("engine_logo_save_image", [
      run.id,
      "image.refine",
      { state: "failed", code: "chromatic_output" },
      "req_x",
      40_000,
    ]);
    expect(await engine("engine_finish", [run.id, "succeeded", null])).toMatchObject({ status: "failed" });
    expect(await balance(OWNER_A)).toBe(30 - 1);
  });
});

describe("logo types after the first concepts", () => {
  beforeEach(async () => {
    await db.exec("update fluid_private.generation_kinds set enabled = true where kind like 'logo.%'");
  });

  it("keeps concepts current when only the logo types change, and not otherwise", async () => {
    const w = await project(),
      run = await conceptsRun(w);
    const { batchId, slots } = await engine<{ batchId: string; slots: { slotId: string }[] }>("engine_logo_begin", [
      run.id,
    ]);
    const saved = await engine<{ attemptId: string }>("engine_logo_save_image", [
      run.id,
      "image.0",
      await drawn(OWNER_A, w.projectId, "a"),
      "req_a",
      31_000,
    ]);
    await rpc(OWNER_A, "apply_logo_workspace_command", [
      w.projectId,
      {
        method: "selectLogoConcept",
        body: {
          requestKey: randomUUID(),
          expected: (await workspace(OWNER_A, w.projectId)).heads,
          batchId,
          slotId: slots[0]!.slotId,
          attemptId: saved.attemptId,
        },
      },
    ]);
    await rpc(OWNER_A, "apply_logo_workspace_command", [
      w.projectId,
      {
        method: "saveLogoBrief",
        body: {
          requestKey: randomUUID(),
          expected: (await workspace(OWNER_A, w.projectId)).heads,
          brief: { ...brief, logoTypes: ["emblem"] },
        },
      },
    ]);
    expect((await workspace(OWNER_A, w.projectId)).staleStages).toEqual([]);
    await rpc(OWNER_A, "apply_logo_workspace_command", [
      w.projectId,
      {
        method: "saveLogoBrief",
        body: {
          requestKey: randomUUID(),
          expected: (await workspace(OWNER_A, w.projectId)).heads,
          brief: { ...brief, logoTypes: ["emblem"], name: "Lumen Bakery" },
        },
      },
    ]);
    expect((await workspace(OWNER_A, w.projectId)).staleStages.map((stale) => stale.stage)).toContain("concepts");
  });

  it("keeps the brief comparison helper private", async () => {
    expect(
      (
        await db.query(
          "select has_function_privilege('authenticated','fluid_private.logo_brief_same_except_types(uuid,uuid,uuid,uuid)','EXECUTE') as granted",
        )
      ).rows,
    ).toEqual([{ granted: false }]);
  });
});

describe("a database built from migrations alone, with the Logo kinds disabled", () => {
  it("has none of the unapplied style-note objects, so the old path must not read them", async () => {
    const present = (
      await db.query<{ table: string | null; reader: string | null }>(
        "select to_regclass('public.logo_style_notes')::text as table, to_regprocedure('public.read_logo_style_note_jobs(uuid)')::text as reader",
      )
    ).rows[0];
    expect(present).toEqual({ table: null, reader: null });
    const catalog = (await rpc(OWNER_A, "get_generation_catalog", [])) as {
      kinds: { kind: string; enabled: boolean }[];
    };
    expect(
      catalog.kinds.filter((kind) => kind.kind.startsWith("logo.")).map((kind) => [kind.kind, kind.enabled]),
    ).toEqual([
      ["logo.concepts", false],
      ["logo.refine", false],
      ["logo.style_note", false],
    ]);
  });
});
