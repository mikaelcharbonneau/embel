import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  start: vi.fn(),
  from: vi.fn(),
  buildInput: vi.fn(),
  buildNamingInput: vi.fn(),
}));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: doubles.auth }));
vi.mock("workflow/api", () => ({ start: doubles.start }));
vi.mock("../../src/workflows/probe", () => ({ probeGeneration: function probeGeneration() {} }));
vi.mock("../../src/workflows/strategy", () => ({ strategyGeneration: function strategyGeneration() {} }));
vi.mock("../../src/workflows/naming", () => ({ namingGeneration: function namingGeneration() {} }));
vi.mock("../../src/server/engine/strategy", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildStrategyRunInput: doubles.buildInput,
}));
vi.mock("../../src/server/engine/naming", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildNamingRunInput: doubles.buildNamingInput,
}));
import { GET as listRoute, POST as startRoute } from "../../src/app/api/projects/[projectId]/generations/route";
import { POST as cancelRoute } from "../../src/app/api/projects/[projectId]/generations/[runId]/cancel/route";
import { GET as creditsRoute } from "../../src/app/api/credits/route";

const origin = "https://fluid.example";
const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const project = "bbbbbbbb-2222-4222-8222-222222222222";
const runId = "cccccccc-3333-4333-8333-333333333333";
const row = (overrides: Record<string, unknown> = {}) => ({
  id: runId,
  owner_id: owner,
  project_id: project,
  kind: "engine.probe",
  status: "queued",
  credits: 0,
  workflow_run_id: null,
  error_code: null,
  cancel_requested_at: null,
  created_at: "2026-11-09T20:00:00Z",
  finished_at: null,
  ...overrides,
});
const body = { kind: "engine.probe", idempotencyKey: "probe-0123456789abcdef" };
function post(path: string, value: unknown = body, headers: Record<string, string> = {}) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
}
const params = () => ({ params: Promise.resolve({ projectId: project }) });
const runParams = () => ({ params: Promise.resolve({ projectId: project, runId }) });

/** A query builder that records its filters and answers with `rows`. */
function query(rows: unknown, calls: unknown[][] = []) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "like", "not", "order", "limit"])
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  builder.maybeSingle = async () => ({ data: rows, error: null });
  builder.then = (resolve: (value: unknown) => void) => resolve({ data: rows, error: null });
  return builder;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", origin);
  doubles.auth.mockResolvedValue({ userId: owner, client: { rpc: doubles.rpc, from: doubles.from } });
  doubles.rpc.mockResolvedValue({ data: row(), error: null });
  doubles.start.mockResolvedValue({ runId: "wrun_fixture" });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("starting a generation", () => {
  it("admits with the person's own login, then starts the workflow once", async () => {
    const response = await startRoute(post(`/api/projects/${project}/generations`), params());
    expect(response.status).toBe(202);
    const json = await response.json();
    expect(json.run).toMatchObject({ id: runId, status: "queued", outputs: [] });
    expect(json.run).not.toHaveProperty("workflow_run_id");
    expect(doubles.rpc).toHaveBeenCalledWith("start_generation", {
      p_project_id: project,
      p_kind: "engine.probe",
      p_idempotency_key: body.idempotencyKey,
      p_input: {},
    });
    expect(doubles.start).toHaveBeenCalledOnce();
    expect(doubles.start.mock.calls[0]![1]).toEqual([runId]);
  });
  it("doesn't start a second workflow for a replay of a started run", async () => {
    doubles.rpc.mockResolvedValueOnce({
      data: row({ status: "running", workflow_run_id: "wrun_fixture" }),
      error: null,
    });
    expect((await startRoute(post(`/api/projects/${project}/generations`), params())).status).toBe(202);
    expect(doubles.start).not.toHaveBeenCalled();
  });
  it("rejects forged origins, unknown kinds and extra fields before admission", async () => {
    expect(
      (
        await startRoute(
          post(`/api/projects/${project}/generations`, body, { origin: "https://evil.invalid" }),
          params(),
        )
      ).status,
    ).toBe(403);
    expect(
      (await startRoute(post(`/api/projects/${project}/generations`, { ...body, kind: "logo.concept" }), params()))
        .status,
    ).toBe(503);
    expect(
      (await startRoute(post(`/api/projects/${project}/generations`, { ...body, ownerId: owner }), params())).status,
    ).toBe(422);
    expect(doubles.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ["insufficient_credits", 402],
    ["daily_limit", 429],
    ["generation_active", 409],
    ["generation_paused", 503],
    ["not_found", 404],
    ["idempotency_conflict", 409],
  ])("maps %s from the database to %i without leaking details", async (message, status) => {
    doubles.rpc.mockResolvedValueOnce({ data: null, error: { message, code: "P0001", details: "private detail" } });
    const response = await startRoute(post(`/api/projects/${project}/generations`), params());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private");
    expect(doubles.start).not.toHaveBeenCalled();
  });
  it("reports a workflow that failed to start as unavailable", async () => {
    doubles.start.mockRejectedValueOnce(new Error("private queue outage"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await startRoute(post(`/api/projects/${project}/generations`), params());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
  it("refuses a run that belongs to someone else", async () => {
    doubles.rpc.mockResolvedValueOnce({ data: row({ owner_id: "dddddddd-4444-4444-8444-444444444444" }), error: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await startRoute(post(`/api/projects/${project}/generations`), params())).status).toBe(503);
    expect(doubles.start).not.toHaveBeenCalled();
  });
});

describe("Strategy runs", () => {
  const strategyBody = {
    kind: "strategy.competitors",
    idempotencyKey: `strategy.engine.v1:${project}:2:strategy.competitors`,
    input: { expectedRevision: 2 },
  };
  const frozen = { revision: 2, request: { version: 3 } };
  it("freezes the input on the server and ignores anything else the browser sends", async () => {
    doubles.from.mockReturnValue(query(null));
    doubles.buildInput.mockResolvedValue(frozen);
    doubles.rpc.mockResolvedValueOnce({
      data: row({ kind: "strategy.competitors", credits: 1, input: frozen }),
      error: null,
    });
    const response = await startRoute(post(`/api/projects/${project}/generations`, strategyBody), params());
    expect(response.status).toBe(202);
    expect((await response.json()).run).toMatchObject({ kind: "strategy.competitors", inputRevision: 2, credits: 1 });
    expect(doubles.buildInput).toHaveBeenCalledWith(
      expect.objectContaining({ userId: owner }),
      project,
      "strategy.competitors",
      { expectedRevision: 2 },
    );
    expect(doubles.rpc).toHaveBeenCalledWith("start_generation", {
      p_project_id: project,
      p_kind: "strategy.competitors",
      p_idempotency_key: strategyBody.idempotencyKey,
      p_input: frozen,
    });
    expect(doubles.start.mock.calls[0]![0].name).toBe("strategyGeneration");
  });
  it("never rebuilds the input of a replayed request", async () => {
    doubles.from.mockReturnValue(
      query(
        row({ kind: "strategy.competitors", status: "running", workflow_run_id: "wrun_fixture", input_revision: 2 }),
      ),
    );
    doubles.rpc.mockResolvedValueOnce({
      data: row({ kind: "strategy.competitors", status: "running", workflow_run_id: "wrun_fixture", input: frozen }),
      error: null,
    });
    expect((await startRoute(post(`/api/projects/${project}/generations`, strategyBody), params())).status).toBe(202);
    expect(doubles.buildInput).not.toHaveBeenCalled();
    expect(doubles.rpc.mock.calls[0]![1]).toMatchObject({ p_input: {} });
    expect(doubles.start).not.toHaveBeenCalled();
  });
  it("lists one journey step's runs with their revision, never their input", async () => {
    const calls: unknown[][] = [];
    doubles.from
      .mockReturnValueOnce(query([row({ kind: "strategy.audience", status: "succeeded", input_revision: 3 })], calls))
      .mockReturnValueOnce(
        query([{ run_id: runId, output_key: "result", output: { ok: true }, created_at: "2026-11-09T20:01:00Z" }]),
      );
    const response = await listRoute(
      new Request(`${origin}/api/projects/${project}/generations?step=strategy`),
      params(),
    );
    const { runs } = await response.json();
    expect(runs).toEqual([
      expect.objectContaining({
        kind: "strategy.audience",
        inputRevision: 3,
        outputs: [{ key: "result", output: { ok: true } }],
      }),
    ]);
    expect(runs[0]).not.toHaveProperty("input");
    expect(calls).toContainEqual(["like", "kind", "strategy.%"]);
    expect(
      (await listRoute(new Request(`${origin}/api/projects/${project}/generations?step=Strategy%25`), params())).status,
    ).toBe(422);
  });
});

describe("Naming runs", () => {
  const namingBody = {
    kind: "naming.generate",
    idempotencyKey: "naming-key-0123456789",
    input: {
      kind: "initial",
      expectedProjectRevision: 2,
      expectedPreferencesVersion: 1,
      seedIds: [],
      instruction: null,
    },
  };
  it("freezes the input with the Naming builder and starts the Naming workflow", async () => {
    const frozen = { version: 1, kind: "initial", revision: 2 };
    doubles.from.mockReturnValue(query(null));
    doubles.buildNamingInput.mockResolvedValue(frozen);
    doubles.rpc.mockResolvedValueOnce({
      data: row({ kind: "naming.generate", credits: 1, input: frozen }),
      error: null,
    });
    const response = await startRoute(post(`/api/projects/${project}/generations`, namingBody), params());
    expect(response.status).toBe(202);
    expect((await response.json()).run).toMatchObject({ kind: "naming.generate", inputRevision: 2, credits: 1 });
    expect(doubles.buildNamingInput).toHaveBeenCalledWith(
      expect.objectContaining({ userId: owner }),
      project,
      namingBody.input,
    );
    expect(doubles.rpc).toHaveBeenCalledWith("start_generation", {
      p_project_id: project,
      p_kind: "naming.generate",
      p_idempotency_key: namingBody.idempotencyKey,
      p_input: frozen,
    });
    expect(doubles.start.mock.calls[0]![0].name).toBe("namingGeneration");
  });
});

describe("cancelling and credits", () => {
  it("cancels through the owner's own login", async () => {
    doubles.rpc.mockResolvedValueOnce({
      data: row({ status: "cancelled", cancel_requested_at: "2026-11-09T20:01:00Z" }),
      error: null,
    });
    const response = await cancelRoute(post(`/api/projects/${project}/generations/${runId}/cancel`, {}), runParams());
    expect((await response.json()).run).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(doubles.rpc).toHaveBeenCalledWith("cancel_generation", { p_run_id: runId });
  });
  it("returns the plan, balance and renewal date", async () => {
    doubles.rpc.mockResolvedValueOnce({
      data: { planId: "free", balance: 30, periodEnd: "2026-12-01T00:00:00Z" },
      error: null,
    });
    expect(await (await creditsRoute()).json()).toEqual({
      credits: { planId: "free", balance: 30, periodEnd: "2026-12-01T00:00:00Z" },
    });
  });
});
