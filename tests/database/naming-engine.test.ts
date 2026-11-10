import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { asRole } from "./local-supabase";
import { createSharedWorkerFixture, OWNER_A, OWNER_B } from "./shared-worker-fixture";
import { brainPreferences, brainReadinessFingerprint, brainRpc } from "./naming-brain-fixture";
import { sharedSlotLeaseSchema, type SharedExecution } from "../../worker/shared-pool/contracts";
import { namingClaimSchema, namingGenerationFeedSchema } from "../../src/domain/naming-generation";
import { namingStrategyBasis, namingStrategyBasisSchema, namingStrategyKeyFromBasis } from "../../src/domain/project-naming";
import { contextSnapshotSchema } from "../../src/domain/projects";

// Naming on the generation engine (migration 20261110140000) in disposable PostgreSQL, installed
// the way production has it: every migration, then the live Naming packets, then this migration
// again (it widens the name origin only once the brainstorm origin exists). No provider is called.
const migration = () => readFile(new URL("../../supabase/migrations/20261110140000_naming_engine.sql", import.meta.url), "utf8");
const candidates = (name: string) => readFile(new URL(`../../supabase/candidates/${name}`, import.meta.url), "utf8");
const policy = { version: 2, operation: "naming.generate", model: "gpt-6-luna", reasoningEffort: "low" };
const name = (value: string, approach = "real_words") => ({ value, rationale: `Why ${value} works.`, primaryApproach: approach, identityKey: value.toLowerCase().replace(/[\p{P}\s]/gu, "") });
const output = (names: unknown[], extra: Record<string, unknown> = {}) => ({ state: "saved", round: 1, request: 1, model: "gpt-6-luna", usage: { inputTokens: 900, outputTokens: 2400, totalTokens: 3300 }, proposed: names.length, names, ...extra });

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const f = await createSharedWorkerFixture({ probe: false }), db = f.db;
  await f.seedUser(OWNER_A); await f.seedUser(OWNER_B);
  for (const packet of ["shared_worker_naming.sql", "shared_naming_brainstorm.sql", "shared_naming_generation.sql"]) await db.exec(await candidates(packet));
  await db.exec(await migration());
  const policyIdentity = (await db.query<{ h: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h", [JSON.stringify(policy)])).rows[0]!.h;
  const slot = await f.seedSlot({ lane: "naming", policies: [{ operation: "naming.generate", policyIdentity, policy }] });
  await db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
  await db.query("insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)", [slot.slotId, JSON.stringify(brainReadinessFingerprint)]);
  const lease = sharedSlotLeaseSchema.parse(await f.lease(slot));
  const action = async (actionName: string, args: unknown, execution: SharedExecution | null = null) => f.asSlot(slot, async () => (await db.query<{ v: { execution: SharedExecution | null; result: unknown } }>(
    "select public.shared_naming_worker_action($1,$2,$3,$4) v", [lease, execution, actionName, JSON.stringify(args)])).rows[0]!.v);
  await action("qualify", { policy });
  async function project(owner = OWNER_A) {
    const id = (await brainRpc<{ id: string }>(db, "create_project", ["complete_brand", "Naming engine fixture", { description: "A neighborhood kitchen" }, "a".repeat(64)], owner)).id;
    await brainRpc(db, "save_naming_preferences", [id, 0, brainPreferences], owner);
    return id;
  }
  /** One finished old-path run with the given names. */
  async function legacyRun(projectId: string, names: unknown[]) {
    await brainRpc(db, "start_naming_run", [projectId, { version: 2, kind: "initial", expectedProjectRevision: 1, expectedPreferencesVersion: 1, seedIds: [], instruction: null, idempotencyKey: "legacy-fixture-key-0001" }]);
    const claimed = await action("claim", { workerId: "fixture-worker", leaseSeconds: 120 });
    const execution = claimed.execution!, claim = namingClaimSchema.parse(claimed.result);
    await action("round_begin", { round: 1, request: { model: "gpt-6-luna", input: "Synthetic" } }, execution);
    await action("round_sent", { round: 1, responseId: "resp_legacy1", requestId: null }, execution);
    await action("round_saved", { round: 1, responseId: "resp_legacy1", model: "gpt-6-luna", usage: null, candidates: names }, execution);
    await action("finish", {}, execution);
    return claim;
  }
  const engineInput = (kind = "initial") => ({ version: 1, kind, revision: 1, policy, exclusions: [],
    brief: { version: 1, contextRevision: 1, preferencesVersion: 1, preferences: brainPreferences, likedExamples: [], strongSeeds: [], recentExamples: [], steeringInstruction: null,
      strategyBasis: namingStrategyBasis(contextSnapshotSchema.parse({ description: "A neighborhood kitchen" })) } });
  let keys = 0;
  async function startEngine(projectId: string, owner = OWNER_A, input: unknown = engineInput()) {
    return brainRpc<{ id: string; status: string }>(db, "start_generation", [projectId, "naming.generate", `engine-fixture-key-${String(++keys).padStart(4, "0")}`, input], owner);
  }
  async function asEngine<T>(run: () => Promise<T>): Promise<T> {
    await db.exec("grant connect on database postgres to embel_engine; set session authorization embel_engine");
    try { return await run(); } finally { await db.exec("set session authorization postgres"); }
  }
  const engine = {
    claim: (runId: string) => asEngine(async () => (await db.query<{ r: Record<string, unknown> }>("select fluid_private.engine_claim($1, 'wrun_naming_fixture') as r", [runId])).rows[0]!.r),
    save: (runId: string, key: string, value: unknown, responseId = "resp_engine1", cost = 1_500) => asEngine(async () =>
      (await db.query<{ r: { saved: boolean; inserted: string[]; savedCount: number } }>("select fluid_private.engine_save_names($1, $2, $3::jsonb, $4, $5) as r", [runId, key, JSON.stringify(value), responseId, cost])).rows[0]!.r),
    finish: (runId: string, status: string) => asEngine(async () => (await db.query("select fluid_private.engine_finish($1, $2, null)", [runId, status])).rows[0]),
  };
  /** The server adds strategyKey from each frozen basis, as here. */
  async function feed(projectId: string, owner = OWNER_A, after: { createdAt: string; id: string } | null = null, limit = 100) {
    const raw = await brainRpc<{ entries: { entry: { candidate: Record<string, unknown> } }[] }>(db, "get_name_feed", [projectId, after?.createdAt ?? null, after?.id ?? null, limit], owner);
    for (const row of raw.entries) row.entry.candidate.strategyKey = namingStrategyKeyFromBasis(namingStrategyBasisSchema.parse(row.entry.candidate.strategyBasis));
    return namingGenerationFeedSchema.parse(raw);
  }
  return { f, db, project, legacyRun, startEngine, engineInput, engine, feed, asEngine };
}

let x: Fixture;
beforeAll(async () => {
  x = await fixture();
  await x.db.exec("update fluid_private.generation_kinds set enabled = true where kind = 'naming.generate'");
}, 180_000);
afterAll(async () => { await x?.f.close(); });

describe("the naming.generate kind", () => {
  it("is added disabled at one credit per round, and the migration can run again", async () => {
    const fresh = await createSharedWorkerFixture({ probe: false });
    try {
      expect((await fresh.db.query("select credits, enabled, max_per_day from fluid_private.generation_kinds where kind = 'naming.generate'")).rows)
        .toEqual([{ credits: 1, enabled: false, max_per_day: 30 }]);
      await fresh.db.exec(await migration());
      expect((await fresh.db.query("select count(*)::int n from fluid_private.generation_kinds where kind = 'naming.generate'")).rows[0]).toEqual({ n: 1 });
    } finally { await fresh.close(); }
  }, 120_000);
});

describe("saving an engine run's names", () => {
  it("adds checked names once, skips names the project has, and keeps every save idempotent", async () => {
    const p = await x.project();
    await x.legacyRun(p, [name("Lantern"), name("Hearth Row", "phrases")]);
    const run = await x.startEngine(p);
    expect(await x.engine.claim(run.id)).toMatchObject({ status: "running", kind: "naming.generate" });
    const first = await x.engine.save(run.id, "round.1.1", output([name("Brasa"), name("lantern"), name("Brasa"), name("Mesa Alta", "phrases")]));
    expect(first).toEqual({ saved: true, inserted: ["brasa", "mesaalta"], savedCount: 2 });
    // A replayed step changes nothing and reports the same names.
    expect(await x.engine.save(run.id, "round.1.1", output([name("Other")]))).toEqual({ saved: false, inserted: ["brasa", "mesaalta"], savedCount: 2 });
    const stored = (await x.db.query<{ origin: Record<string, unknown>; batch_id: string | null; context_revision: number }>(
      "select origin, batch_id, context_revision from public.name_candidates where identity_key = 'brasa' and project_id = $1", [p])).rows[0]!;
    expect(stored).toMatchObject({ batch_id: null, context_revision: 1, origin: { kind: "brainstorm", version: 2, runId: run.id, outputKey: "round.1.1", responseId: "resp_engine1", primaryApproach: "real_words" } });
    const outputs = (await x.db.query("select output_key, cost_microusd::int cost, provider_response_id from public.generation_outputs where run_id = $1", [run.id])).rows;
    expect(outputs).toEqual([{ output_key: "round.1.1", cost: 1_500, provider_response_id: "resp_engine1" }]);

    const view = await x.feed(p);
    expect(view.availability).toEqual({ status: "available" });
    expect(view.run).toMatchObject({ runId: run.id, jobId: run.id, kind: "initial", state: "running", savedCount: 2 });
    expect(view.entries.map(row => [row.entry.candidate.value, row.primaryApproach, row.runId === run.id])).toEqual([
      ["Lantern", "real_words", false], ["Hearth Row", "phrases", false], ["Brasa", "real_words", true], ["Mesa Alta", "phrases", true]]);
    const page = await x.feed(p, OWNER_A, null, 3);
    expect(page.entries).toHaveLength(3);
    expect((await x.feed(p, OWNER_A, page.nextCursor)).entries.map(row => row.entry.candidate.value)).toEqual(["Mesa Alta"]);

    await x.engine.finish(run.id, "succeeded");
    expect((await x.feed(p)).run).toMatchObject({ runId: run.id, state: "succeeded", savedCount: 2 });
    await expect(x.engine.save(run.id, "round.2.1", output([name("Late")]))).rejects.toThrow(/run_not_running/u);
  });

  it("keeps at most 100 names per run and refuses malformed names whole", async () => {
    const p = await x.project();
    const run = await x.startEngine(p);
    await x.engine.claim(run.id);
    await expect(x.engine.save(run.id, "round.1.1", output([{ ...name("Bad"), primaryApproach: "unknown" }]))).rejects.toThrow(/invalid_input/u);
    await expect(x.engine.save(run.id, "round.1.1", output([{ ...name("Bad"), extra: true }]))).rejects.toThrow(/invalid_input/u);
    await expect(x.engine.save(run.id, "attempt.1", output([name("Fine")]))).rejects.toThrow(/invalid_input/u);
    expect((await x.db.query("select count(*)::int n from public.generation_outputs where run_id = $1", [run.id])).rows[0]).toEqual({ n: 0 });
    const many = (offset: number) => Array.from({ length: 60 }, (_, index) => name(`Fixture${offset + index}`, "invented"));
    expect((await x.engine.save(run.id, "round.1.1", output(many(0)))).savedCount).toBe(60);
    const second = await x.engine.save(run.id, "round.1.2", output(many(60)), "resp_engine2");
    expect(second.savedCount).toBe(100);
    expect(second.inserted).toHaveLength(40);
  });

  it("is only for the engine login, and only for naming runs", async () => {
    const p = await x.project();
    const run = await x.startEngine(p);
    await x.engine.claim(run.id);
    await expect(brainRpc(x.db, "start_generation", [p, "engine.probe", "probe-fixture-key-0001", {}])).resolves.toBeTruthy();
    const probe = (await x.db.query<{ id: string }>("select id from public.generation_runs where kind = 'engine.probe' and project_id = $1", [p])).rows[0]!;
    await x.engine.claim(probe.id);
    await expect(x.engine.save(probe.id, "round.1.1", output([name("Probe")]))).rejects.toThrow(/invalid_input/u);
    await expect(asRole(x.db, "authenticated", OWNER_A, () => x.db.query("select fluid_private.engine_save_names($1, 'round.1.1', '{}'::jsonb, 'resp_x', 0)", [run.id])))
      .rejects.toThrow(/permission denied/u);
    await expect(x.asEngine(() => x.db.query("select public.get_name_feed($1)", [p]))).rejects.toThrow(/permission denied/u);
  });

  it("refuses an engine name without its run", async () => {
    const p = await x.project();
    const origin = { kind: "brainstorm", version: 2, profile: "brainstorm_v1" };
    await expect(x.db.query(`insert into public.name_candidates(owner_id, project_id, value, identity_key, context_revision, strategy_basis, origin)
      values ($1, $2, 'Orphan', 'orphan', 1, '{}'::jsonb, $3::jsonb)`, [OWNER_A, p, JSON.stringify(origin)])).rejects.toThrow(/name_candidates_check1/u);
  });
});

describe("the engine Naming feed", () => {
  it("shows only the owner's project and reports when the kind is off", async () => {
    const p = await x.project();
    await expect(x.feed(p, OWNER_B)).rejects.toThrow(/not_found/u);
    await expect(brainRpc(x.db, "get_name_feed", [p, null, null, 0])).rejects.toThrow(/invalid_naming_request/u);
    expect((await x.feed(p)).run).toBeNull();
    await x.db.exec("update fluid_private.generation_kinds set enabled = false where kind = 'naming.generate'");
    try { expect((await x.feed(p)).availability).toEqual({ status: "unavailable", code: "generation_unavailable" }); }
    finally { await x.db.exec("update fluid_private.generation_kinds set enabled = true where kind = 'naming.generate'"); }
  });

  it("shows a cancel request and the refunded cancelled run, with the names it saved", async () => {
    const p = await x.project();
    const run = await x.startEngine(p, OWNER_A, x.engineInput("more"));
    await x.engine.claim(run.id);
    await x.engine.save(run.id, "round.1.1", output([name("Quarry")]));
    await brainRpc(x.db, "cancel_generation", [run.id]);
    expect((await x.feed(p)).run).toMatchObject({ kind: "more", state: "cancel_requested", savedCount: 1 });
    await x.engine.finish(run.id, "cancelled");
    expect((await x.feed(p)).run).toMatchObject({ state: "cancelled", savedCount: 1 });
    expect((await x.db.query("select kind, delta from public.credit_entries where run_id = $1 order by id", [run.id])).rows).toEqual([{ kind: "charge", delta: -1 }, { kind: "refund", delta: 1 }]);
  });
});
