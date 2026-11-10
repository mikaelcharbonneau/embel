import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { asRole, createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { brainPreferences, brainRpc } from "./naming-brain-fixture";
import { namingGenerationFeedSchema } from "../../src/domain/naming-generation";
import { namingStrategyBasis, namingStrategyBasisSchema, namingStrategyKeyFromBasis } from "../../src/domain/project-naming";
import { contextSnapshotSchema } from "../../src/domain/projects";

// Naming on the generation engine in disposable PostgreSQL on the baseline migration, with one
// project that already has a finished run. No provider is called.
const policy = { version: 2, operation: "naming.generate", model: "gpt-6-luna", reasoningEffort: "low" };
const name = (value: string, approach = "real_words") => ({ value, rationale: `Why ${value} works.`, primaryApproach: approach, identityKey: value.toLowerCase().replace(/[\p{P}\s]/gu, "") });
const output = (names: unknown[], extra: Record<string, unknown> = {}) => ({ state: "saved", round: 1, request: 1, model: "gpt-6-luna", usage: { inputTokens: 900, outputTokens: 2400, totalTokens: 3300 }, proposed: names.length, names, ...extra });

async function project(db: TestDatabase, owner = OWNER_A) {
  const id = (await brainRpc<{ id: string }>(db, "create_project", ["complete_brand", "Naming engine fixture", { description: "A neighborhood kitchen" }, "a".repeat(64)], owner)).id;
  await brainRpc(db, "save_naming_preferences", [id, 0, brainPreferences], owner);
  return id;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const db = await createTestDatabase();
  await db.query("insert into auth.users(id, email_confirmed_at) values ($1, clock_timestamp()), ($2, clock_timestamp())", [OWNER_A, OWNER_B]);
  await db.exec("update fluid_private.generation_kinds set enabled = true where kind = 'naming.generate'");
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
  // One finished earlier run, so a project already has Lantern and Hearth Row.
  const legacyProject = await project(db);
  const earlier = await startEngine(legacyProject);
  await engine.claim(earlier.id);
  await engine.save(earlier.id, "round.1.1", output([name("Lantern"), name("Hearth Row", "phrases")]), "resp_earlier1");
  await engine.finish(earlier.id, "succeeded");
  return { db, legacyProject, project: (owner = OWNER_A) => project(db, owner), startEngine, engineInput, engine, feed, asEngine };
}

let x: Fixture;
beforeAll(async () => { x = await fixture(); }, 180_000);
afterAll(async () => { await x?.db.exec("set session authorization postgres"); await x?.db.close(); });

describe("the naming.generate kind", () => {
  it("is installed disabled at one credit per round", async () => {
    const fresh = await createTestDatabase();
    try {
      expect((await fresh.query("select credits, enabled, max_per_day from fluid_private.generation_kinds where kind = 'naming.generate'")).rows)
        .toEqual([{ credits: 1, enabled: false, max_per_day: 30 }]);
    } finally { await fresh.close(); }
  }, 120_000);
});

describe("saving an engine run's names", () => {
  it("adds checked names once, skips names the project has, and keeps every save idempotent", async () => {
    // This project has a finished earlier run with Lantern and Hearth Row.
    const p = x.legacyProject;
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

  it("shows a cancel request and the cancelled run, which keeps its credit for the names it saved", async () => {
    const p = await x.project();
    const run = await x.startEngine(p, OWNER_A, x.engineInput("more"));
    await x.engine.claim(run.id);
    await x.engine.save(run.id, "round.1.1", output([name("Quarry")]));
    await brainRpc(x.db, "cancel_generation", [run.id]);
    expect((await x.feed(p)).run).toMatchObject({ kind: "more", state: "cancel_requested", savedCount: 1 });
    await x.engine.finish(run.id, "cancelled");
    expect((await x.feed(p)).run).toMatchObject({ state: "cancelled", savedCount: 1 });
    expect((await x.db.query("select kind, delta from public.credit_entries where run_id = $1 order by id", [run.id])).rows).toEqual([{ kind: "charge", delta: -1 }]);
  });

  it("refunds a cancelled run that delivered no names, and a failed run even with names", async () => {
    const credits = async (runId: string) => (await x.db.query("select kind, delta from public.credit_entries where run_id = $1 order by id", [runId])).rows;
    const empty = await x.startEngine(await x.project(), OWNER_A, x.engineInput("more"));
    await x.engine.claim(empty.id);
    await brainRpc(x.db, "cancel_generation", [empty.id]);
    await x.engine.finish(empty.id, "cancelled");
    expect(await credits(empty.id)).toEqual([{ kind: "charge", delta: -1 }, { kind: "refund", delta: 1 }]);
    const failed = await x.startEngine(await x.project(), OWNER_A, x.engineInput("more"));
    await x.engine.claim(failed.id);
    await x.engine.save(failed.id, "round.1.1", output([name("Ledger")]));
    await x.engine.finish(failed.id, "failed");
    expect(await credits(failed.id)).toEqual([{ kind: "charge", delta: -1 }, { kind: "refund", delta: 1 }]);
  });
});
