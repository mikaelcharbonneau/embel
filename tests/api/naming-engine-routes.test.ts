import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), from: vi.fn(), start: vi.fn(), buildInput: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("../../src/workflows/probe", () => ({ probeGeneration: function probeGeneration() {} }));
vi.mock("../../src/workflows/strategy", () => ({ strategyGeneration: function strategyGeneration() {} }));
vi.mock("../../src/workflows/naming", () => ({ namingGeneration: function namingGeneration() {} }));
vi.mock("../../src/server/engine/naming", async importOriginal => ({ ...await importOriginal<object>(), buildNamingRunInput: mocks.buildInput }));
import { GET as feedRoute } from "../../src/app/api/projects/[projectId]/naming/feed/route";
import { POST as ensureRoute } from "../../src/app/api/projects/[projectId]/naming/feed/ensure/route";
import { POST as stopRoute } from "../../src/app/api/projects/[projectId]/naming/feed/stop/route";
import { POST as steeringRoute } from "../../src/app/api/projects/[projectId]/naming/steering/route";
import { NAMING_GENERATION_CAUTION, namingGenerationFeedSchema } from "../../src/domain/naming-generation";
import { nameIdentityKey, namingStrategyBasis } from "../../src/domain/project-naming";
import { contextSnapshotSchema } from "../../src/domain/projects";

// The Naming routes while naming.generate is enabled. Synthetic rows only; no workflow runs.
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222", candidate = "44444444-4444-4444-8444-444444444444", legacyJob = "66666666-6666-4666-8666-666666666666";
const at = "2026-11-09T12:00:00.123456+00:00", context = contextSnapshotSchema.parse({ description: "Synthetic naming engine route fixture" });
const engineRun = (state = "running", kind = "initial") => ({ runId, jobId: runId, kind, state, target: 100, savedCount: 1, errorCode: null, usage: null, createdAt: at, finishedAt: null });
/** A name an engine run saved: brainstorm origin version 2, no old batch. */
const engineEntry = () => ({ runId, primaryApproach: "invented", entry: {
  candidate: { id: candidate, ownerId: owner, projectId: project, value: "Brasa", identityKey: nameIdentityKey("Brasa"), rationale: "A synthetic proposal.", caution: NAMING_GENERATION_CAUTION,
    contextRevision: 3, strategyBasis: namingStrategyBasis(context), createdAt: at,
    origin: { kind: "brainstorm", version: 2, profile: "brainstorm_v1", ownerId: owner, projectId: project, candidateId: candidate, contextRevision: 3, value: "Brasa",
      runId, outputKey: "round.1.1", responseId: "resp_synthetic", model: "gpt-6-luna", primaryApproach: "invented", generatedAt: at } },
  retention: { ownerId: owner, projectId: project, candidateId: candidate, revision: 0, favorite: false, saved: false, updatedAt: null } } });
const feedRow = (run: unknown = engineRun()) => ({ version: 2, projectId: project, availability: { status: "available" }, run, entries: [engineEntry()], nextCursor: null });
const generationRow = (overrides: Record<string, unknown> = {}) => ({ id: runId, owner_id: owner, project_id: project, kind: "naming.generate", status: "queued", credits: 1,
  workflow_run_id: null, error_code: null, cancel_requested_at: null, created_at: at, finished_at: null, input: { revision: 3 }, ...overrides });
const startBody = (overrides: Record<string, unknown> = {}) => ({ version: 2, kind: "initial", expectedProjectRevision: 3, expectedPreferencesVersion: 2, seedIds: [], instruction: null, idempotencyKey: "synthetic-start-key-0001", ...overrides });
const params = () => ({ params: Promise.resolve({ projectId: project }) });
function request(body?: unknown, method = "POST") {
  return new Request(`https://fluid.example/api/projects/${project}/naming`, { method,
    headers: { origin: "https://fluid.example", "content-type": "application/json", "x-embel-account": owner }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const rpcCalls = (name: string) => mocks.rpc.mock.calls.filter(([called]) => called === name);
/** Answers each table read with `rows[table]`. */
let rows: Record<string, unknown>;
function table(name: string) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) query[method] = () => query;
  query.maybeSingle = async () => ({ data: rows[name] ?? null, error: null });
  query.then = (resolve: (value: unknown) => void) => resolve({ data: rows[name] ?? [], error: null });
  return query;
}
let failure: { name: string; message: string } | null;

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "https://fluid.example");
  rows = {}; failure = null;
  mocks.auth.mockResolvedValue({ userId: owner, client: { rpc: mocks.rpc, from: mocks.from } });
  mocks.from.mockImplementation(table);
  mocks.start.mockResolvedValue({ runId: "wrun_fixture" });
  mocks.buildInput.mockResolvedValue({ version: 1, kind: "initial", revision: 3 });
  mocks.rpc.mockImplementation(async (name: string) => {
    if (failure?.name === name) return { data: null, error: { message: failure.message, code: "P0001", details: "private detail" } };
    if (name === "get_generation_catalog") return { data: { plans: [], kinds: [{ kind: "naming.generate", credits: 1, enabled: true }] }, error: null };
    if (name === "get_name_feed") return { data: feedRow(), error: null };
    if (name === "start_generation") return { data: generationRow(), error: null };
    if (name === "cancel_generation") return { data: generationRow({ status: "running", cancel_requested_at: at }), error: null };
    return { data: null, error: null };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("the Naming routes on the generation engine", () => {
  it("read the feed of old and engine names through get_name_feed and mark it as the engine's", async () => {
    const response = await feedRoute(request(undefined, "GET"), params());
    expect(response.status).toBe(200);
    const { feed } = await response.json();
    expect(namingGenerationFeedSchema.parse(feed)).toMatchObject({ engine: true, run: { runId, state: "running" } });
    expect(feed.entries[0].entry.candidate.origin).toMatchObject({ kind: "brainstorm", version: 2, runId });
    expect(rpcCalls("get_name_feed")).toEqual([["get_name_feed", { p_project: project, p_after_created_at: null, p_after_id: null, p_limit: 100 }]]);
    expect(rpcCalls("get_naming_generation")).toHaveLength(0);
  });

  it("start the first names as one engine run: the server freezes the input and starts the Naming workflow once", async () => {
    const response = await ensureRoute(request(startBody()), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ run: { runId, kind: "initial", state: "running" }, reused: false, feed: { engine: true } });
    expect(mocks.buildInput).toHaveBeenCalledWith(expect.objectContaining({ userId: owner }), project,
      { kind: "initial", expectedProjectRevision: 3, expectedPreferencesVersion: 2, seedIds: [], instruction: null });
    expect(rpcCalls("start_generation")).toEqual([["start_generation", { p_project_id: project, p_kind: "naming.generate", p_idempotency_key: "synthetic-start-key-0001", p_input: { version: 1, kind: "initial", revision: 3 } }]]);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.start.mock.calls[0]![0].name).toBe("namingGeneration");
    expect(rpcCalls("start_naming_run")).toHaveLength(0);
  });

  it("start a steered run through the steering route", async () => {
    mocks.rpc.mockImplementation(async (name: string) => name === "get_generation_catalog" ? { data: { plans: [], kinds: [{ kind: "naming.generate", credits: 1, enabled: true }] }, error: null }
      : name === "get_name_feed" ? { data: feedRow(engineRun("queued", "steer")), error: null } : { data: generationRow(), error: null });
    const seed = "77777777-7777-4777-8777-777777777777";
    const response = await steeringRoute(request(startBody({ kind: "steer", seedIds: [seed], instruction: "Warmer" })), params());
    expect(response.status).toBe(200);
    expect(mocks.buildInput.mock.calls[0]![2]).toEqual({ kind: "steer", expectedProjectRevision: 3, expectedPreferencesVersion: 2, seedIds: [seed], instruction: "Warmer" });
  });

  it("replay a key without rebuilding its input, and start a workflow that never started", async () => {
    rows.generation_runs = generationRow({ input_revision: 3 });
    const response = await ensureRoute(request(startBody()), params());
    expect(response.status).toBe(200);
    expect((await response.json()).reused).toBe(true);
    expect(mocks.buildInput).not.toHaveBeenCalled();
    expect(rpcCalls("start_generation")[0]![1]).toMatchObject({ p_input: {} });
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it.each([
    ["insufficient_credits", 402], ["daily_limit", 429], ["generation_active", 409], ["generation_unavailable", 503], ["generation_paused", 503],
  ])("map %s from admission to %i without leaking details or starting a workflow", async (message, status) => {
    failure = { name: "start_generation", message };
    const response = await ensureRoute(request(startBody()), params());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("answer an admitted run whose workflow didn't start as unconfirmed, so Try again repeats the same key", async () => {
    mocks.start.mockRejectedValueOnce(new Error("private queue outage"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await ensureRoute(request(startBody()), params());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private");
  });

  it("stop the working engine run, which returns its credit", async () => {
    rows.generation_runs = [{ id: runId }];
    const response = await stopRoute(request({}), params());
    expect(response.status).toBe(200);
    expect(rpcCalls("cancel_generation")).toEqual([["cancel_generation", { p_run_id: runId }]]);
    expect(rpcCalls("stop_naming_run")).toHaveLength(0);
    expect((await response.json()).feed.engine).toBe(true);
  });

  it("stop an old-path run that is still working when the engine was switched on", async () => {
    rows.jobs = [{ id: legacyJob }];
    expect((await stopRoute(request({}), params())).status).toBe(200);
    expect(rpcCalls("cancel_generation")).toHaveLength(0);
    expect(rpcCalls("stop_naming_run")).toEqual([["stop_naming_run", { p_project: project }]]);
  });
});
