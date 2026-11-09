import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
import { GET as feedRoute } from "../../src/app/api/projects/[projectId]/naming/feed/route";
import { POST as ensureRoute } from "../../src/app/api/projects/[projectId]/naming/feed/ensure/route";
import { POST as stopRoute } from "../../src/app/api/projects/[projectId]/naming/feed/stop/route";
import { POST as steeringRoute } from "../../src/app/api/projects/[projectId]/naming/steering/route";
import { NAMING_GENERATION_CAUTION } from "../../src/domain/naming-generation";
import { initialNamingPreferencesV2 } from "../../src/domain/naming-brain-preferences";
import { nameIdentityKey, namingStrategyBasis, namingStrategyKey } from "../../src/domain/project-naming";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { ApiError } from "../../src/server/http/errors";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", project = "11111111-1111-4111-8111-111111111111";
const run = "22222222-2222-4222-8222-222222222222", job = "33333333-3333-4333-8333-333333333333", candidate = "44444444-4444-4444-8444-444444444444", round = "55555555-5555-4555-8555-555555555555";
const at = "2026-11-08T12:00:00.123456+00:00", context = contextSnapshotSchema.parse({ description: "Synthetic naming route fixture" });
const preferences = { ...initialNamingPreferencesV2(context), approaches: ["real_words"], directness: "suggestive" };
const runRow = (state = "running", kind = "initial") => ({ runId: run, jobId: job, kind, state, target: 100, savedCount: 1, errorCode: null, usage: null, createdAt: at, finishedAt: null });
/** The SQL entry omits strategyKey; the server derives it from strategyBasis. */
const entryRow = (overrides: Record<string, unknown> = {}) => ({ runId: run, primaryApproach: "real_words", entry: {
  candidate: { id: candidate, ownerId: owner, projectId: project, value: "Juniper", identityKey: nameIdentityKey("Juniper"), rationale: "A synthetic proposal.", caution: NAMING_GENERATION_CAUTION,
    contextRevision: 1, strategyBasis: namingStrategyBasis(context), createdAt: at,
    origin: { kind: "brainstorm", version: 1, profile: "brainstorm_v1", ownerId: owner, projectId: project, candidateId: candidate, contextRevision: 1, value: "Juniper",
      batchId: run, jobId: job, runId: run, callId: round, responseId: "resp_synthetic", requestId: null, model: "synthetic-model", generatedAt: at }, ...overrides },
  retention: { ownerId: owner, projectId: project, candidateId: candidate, revision: 0, favorite: false, saved: false, updatedAt: null } } });
const feedRow = (overrides: Record<string, unknown> = {}) => ({ version: 2, projectId: project, availability: { status: "available" }, run: runRow(), entries: [entryRow()], nextCursor: null, ...overrides });
const startBody = (overrides: Record<string, unknown> = {}) => ({ version: 2, kind: "initial", expectedProjectRevision: 3, expectedPreferencesVersion: 2, seedIds: [], instruction: null, idempotencyKey: "synthetic-start-key-0001", ...overrides });
const params = (projectId = project) => ({ params: Promise.resolve({ projectId }) });
function request(body?: unknown, { method = "POST", headers = {}, query = "" }: { method?: string; headers?: Record<string, string>; query?: string } = {}) {
  return new Request(`https://fluid.example/api/projects/${project}/naming${query}`, { method,
    headers: { origin: "https://fluid.example", "content-type": "application/json", "x-embel-account": owner, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
let savedPreferences: unknown;
const rpcCalls = (name: string) => mocks.rpc.mock.calls.filter(([called]) => called === name);

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "https://fluid.example");
  savedPreferences = { owner_id: owner, project_id: project, version: 2, preferences };
  mocks.auth.mockResolvedValue({ userId: owner, client: { rpc: mocks.rpc, from: mocks.from } });
  mocks.from.mockImplementation(() => { const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: savedPreferences, error: null }) }; return query; });
  mocks.rpc.mockImplementation(async (name: string, args: { p_request?: { kind: string } }) => ({ error: null,
    data: name === "get_naming_generation" ? feedRow() : name === "start_naming_run" ? { run: runRow("queued", args.p_request!.kind), reused: false } : name === "stop_naming_run" ? { run: runRow("cancel_requested") } : null }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("GET feed", () => {
  it("reads the first page through get_naming_generation and derives each strategy key", async () => {
    const response = await feedRoute(request(undefined, { method: "GET" }), params());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("get_naming_generation", { p_project: project, p_after_created_at: null, p_after_id: null, p_limit: 100 });
    const { feed } = await response.json();
    expect(feed.entries[0].entry.candidate.strategyKey).toBe(namingStrategyKey(context));
    expect(feed.run).toMatchObject({ runId: run, state: "running", savedCount: 1 });
  });
  it("passes a paired cursor and limit, and rejects malformed queries before SQL", async () => {
    await feedRoute(request(undefined, { method: "GET", query: `?cursorCreatedAt=${encodeURIComponent(at)}&cursorId=${candidate}&limit=40` }), params());
    expect(mocks.rpc).toHaveBeenCalledWith("get_naming_generation", { p_project: project, p_after_created_at: at, p_after_id: candidate, p_limit: 40 });
    mocks.rpc.mockClear();
    for (const query of [`?cursorId=${candidate}`, "?limit=101", "?limit=0", "?limit=1&limit=2", "?ownerId=forged", `?cursorCreatedAt=yesterday&cursorId=${candidate}`])
      expect((await feedRoute(request(undefined, { method: "GET", query }), params())).status, query).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect((await feedRoute(request(undefined, { method: "GET" }), params("not-a-uuid"))).status).toBe(404);
  });
  it.each([
    ["another owner's name", feedRow({ entries: [entryRow({ ownerId: other })] })],
    ["another project's name", feedRow({ entries: [(() => { const row = entryRow({ projectId: other });
      return { ...row, entry: { candidate: { ...row.entry.candidate, origin: { ...row.entry.candidate.origin, projectId: other } }, retention: { ...row.entry.retention, projectId: other } } }; })()] })],
    ["another project's feed", feedRow({ projectId: other })],
  ])("hides %s", async (_case, data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    expect((await feedRoute(request(undefined, { method: "GET" }), params())).status).toBe(404);
  });
  it("fails closed on a malformed stored feed", async () => {
    mocks.rpc.mockResolvedValue({ data: feedRow({ run: { ...runRow(), state: "needs_reconciliation" } }), error: null });
    expect((await feedRoute(request(undefined, { method: "GET" }), params())).status).toBe(503);
  });
});

describe("POST feed/ensure", () => {
  it("checks saved choices, starts one run with the exact request and returns the fresh feed", async () => {
    const body = startBody();
    const response = await ensureRoute(request(body), params());
    expect(response.status).toBe(200);
    expect(mocks.from).toHaveBeenCalledWith("naming_preferences");
    expect(rpcCalls("start_naming_run")).toEqual([["start_naming_run", { p_project: project, p_request: body }]]);
    expect(rpcCalls("get_naming_generation")).toHaveLength(1);
    expect(await response.json()).toMatchObject({ run: { runId: run, kind: "initial", state: "queued" }, reused: false, feed: { projectId: project } });
    expect((await ensureRoute(request(startBody({ kind: "more" })), params())).status).toBe(200);
  });
  it("requires same origin, the account header and a signed-in account", async () => {
    expect((await ensureRoute(request(startBody(), { headers: { origin: "https://foreign.example" } }), params())).status).toBe(403);
    expect((await ensureRoute(request(startBody(), { headers: { "x-embel-account": "" } }), params())).status).toBe(401);
    expect((await ensureRoute(request(startBody(), { headers: { "x-embel-account": other } }), params())).status).toBe(401);
    mocks.auth.mockRejectedValueOnce(new ApiError("unauthenticated"));
    expect((await ensureRoute(request(startBody()), params())).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ["a steered run", startBody({ kind: "steer", seedIds: [candidate] })],
    ["seed names on More names", startBody({ kind: "more", seedIds: [candidate] })],
    ["an instruction on the first names", startBody({ instruction: "Shorter" })],
    ["an unknown field", { ...startBody(), ownerId: other }],
    ["an older request version", startBody({ version: 1 })],
    ["a short idempotency key", startBody({ idempotencyKey: "short" })],
  ])("rejects %s before SQL", async (_case, body) => {
    expect((await ensureRoute(request(body), params())).status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("bounds the request body", async () => {
    expect((await ensureRoute(request({ ...startBody(), padding: "x".repeat(5000) }), params())).status).toBe(413);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("refuses incomplete or changed saved choices without starting a run", async () => {
    savedPreferences = { owner_id: owner, project_id: project, version: 2, preferences: { ...preferences, approaches: [] } };
    const incomplete = await ensureRoute(request(startBody()), params());
    expect(incomplete.status).toBe(422); expect((await incomplete.json()).error.code).toBe("preferences_incomplete");
    savedPreferences = null;
    const changed = await ensureRoute(request(startBody()), params());
    expect(changed.status).toBe(409); expect((await changed.json()).error.code).toBe("preferences_changed");
    expect(rpcCalls("start_naming_run")).toHaveLength(0);
  });
  it.each([
    ["40001", "naming_active", 409, "naming_active"],
    ["40001", "project_revision_changed", 409, "project_revision_changed"],
    ["40001", "preferences_changed", 409, "preferences_changed"],
    ["40001", "idempotency_conflict", 409, "conflict"],
    ["22023", "preferences_incomplete", 422, "preferences_incomplete"],
    ["22023", "invalid_naming_request", 422, "invalid_naming_request"],
    ["55000", "naming_unavailable", 503, "naming_unavailable"],
    ["P0002", "not_found", 404, "not_found"],
    ["42501", "unauthenticated", 401, "unauthenticated"],
    ["XX000", "private provider detail", 503, "integration_unavailable"],
  ])("maps SQL %s %s to HTTP %i %s without leaking its text", async (code, message, status, publicCode) => {
    mocks.rpc.mockImplementation(async (name: string) => name === "start_naming_run" ? { data: null, error: { code, message } } : { data: feedRow(), error: null });
    const response = await ensureRoute(request(startBody()), params());
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error.code).toBe(publicCode); expect(JSON.stringify(body)).not.toContain("private provider detail");
  });
  it("fails closed when SQL returns a run of another kind", async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === "start_naming_run" ? { run: runRow("queued", "steer"), reused: true } : feedRow() }));
    expect((await ensureRoute(request(startBody()), params())).status).toBe(503);
  });
});

describe("POST steering", () => {
  it("starts a steered run with More like this names and typed guidance", async () => {
    const body = startBody({ kind: "steer", seedIds: [candidate], instruction: "Softer vowels" });
    const response = await steeringRoute(request(body), params());
    expect(response.status).toBe(200);
    expect(rpcCalls("start_naming_run")).toEqual([["start_naming_run", { p_project: project, p_request: body }]]);
    expect((await response.json()).run.kind).toBe("steer");
    expect((await steeringRoute(request(startBody({ kind: "steer", instruction: "Only guidance" })), params())).status).toBe(200);
  });
  it("accepts only steered requests and keeps the account header requirement", async () => {
    expect((await steeringRoute(request(startBody()), params())).status).toBe(422);
    expect((await steeringRoute(request(startBody({ kind: "steer" })), params())).status).toBe(422);
    expect((await steeringRoute(request(startBody({ kind: "steer", seedIds: [candidate, candidate] })), params())).status).toBe(422);
    expect((await steeringRoute(request(startBody({ kind: "steer", instruction: "Quiet" }), { headers: { "x-embel-account": other } }), params())).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("POST feed/stop", () => {
  it("stops the active run and returns the fresh feed", async () => {
    const response = await stopRoute(request({}), params());
    expect(response.status).toBe(200);
    expect(rpcCalls("stop_naming_run")).toEqual([["stop_naming_run", { p_project: project }]]);
    expect((await response.json()).feed.run.runId).toBe(run);
  });
  it("accepts a project without any run", async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === "stop_naming_run" ? { run: null } : feedRow({ run: null, entries: [] }) }));
    const response = await stopRoute(request({}), params());
    expect(response.status).toBe(200); expect((await response.json()).feed.run).toBeNull();
  });
  it("requires an empty body, same origin and the account header", async () => {
    expect((await stopRoute(request({ runId: run }), params())).status).toBe(422);
    expect((await stopRoute(request({}, { headers: { origin: "null" } }), params())).status).toBe(403);
    expect((await stopRoute(request({}, { headers: { "x-embel-account": "" } }), params())).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "not_found" } });
    expect((await stopRoute(request({}), params())).status).toBe(404);
  });
});
