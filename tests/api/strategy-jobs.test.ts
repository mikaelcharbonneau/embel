import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRATEGY_OPERATIONS } from "../../src/server/engine/strategy";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: doubles.auth }));
import * as overviewRoute from "../../src/app/api/projects/[projectId]/strategy/route";
import { GET as getJob, DELETE as cancel } from "../../src/app/api/projects/[projectId]/strategy/[jobId]/route";
import { GET as runtime } from "../../src/app/api/strategy/route";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const output = {
  version: 1,
  operation: "strategy.reformulate",
  provider: "openai",
  model: "fixture-model",
  responseId: "local-fixture-response",
  requestId: null,
  generatedAt: "2026-10-03T12:00:00Z",
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 },
  proposal: {
    message: "A saved earlier reply, not live output",
    activity: "Fixture activity",
    offering: "Fixture offering",
    knownAudience: "",
    questions: [],
  },
};
const job = {
  id: jobId,
  owner_id: ownerId,
  project_id: projectId,
  operation: "strategy.reformulate",
  input_revision: 1,
  state: "succeeded",
  progress: 100,
  reserved_cost_microusd: 0,
  actual_cost_microusd: 0,
  error_code: null,
  cancel_requested_at: null,
  created_at: "2026-10-03T12:00:00Z",
  finished_at: "2026-10-03T12:01:00Z",
};

/** A Supabase client double: RPC answers by name, and table reads return fixed rows. */
function client(kinds: { kind: string; enabled: boolean }[], options: { jobs?: unknown[]; steps?: unknown[] } = {}) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "get_generation_catalog") return { data: { kinds }, error: null };
    if (name === "get_strategy_job_summaries") return { data: options.jobs ?? [job], error: null };
    if (name === "request_job_cancel") return { data: null, error: null };
    return { data: null, error: { code: "PGRST202", message: "unexpected rpc " + name } };
  });
  const rows: Record<string, unknown> = { projects: { id: projectId }, job_steps: options.steps ?? [] };
  const from = vi.fn((table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      in: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: rows[table], error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: rows[table], error: null }),
    };
    return query;
  });
  return { rpc, from };
}
const enabled = (on: boolean) => STRATEGY_OPERATIONS.map((kind) => ({ kind, enabled: on }));
const params = { params: Promise.resolve({ projectId }) };

describe("Strategy on the generation engine", () => {
  beforeEach(() => {
    doubles.auth.mockReset();
    vi.stubEnv("APP_ORIGIN", "http://localhost:3105");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("offers every operation while all Strategy kinds are enabled and lists earlier old-system requests", async () => {
    const supabase = client(enabled(true), {
      steps: [
        { job_id: jobId, owner_id: ownerId, project_id: projectId, step_key: "reply", state: "succeeded", output },
      ],
    });
    doubles.auth.mockResolvedValue({ client: supabase, userId: ownerId });
    const response = await overviewRoute.GET(new Request("http://127.0.0.1/api"), params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.engine).toBe(true);
    expect(body.availability.status).toBe("available");
    expect(body.availability.operations.map((item: { operation: string }) => item.operation)).toEqual(
      STRATEGY_OPERATIONS,
    );
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].results).toEqual([{ stepKey: "reply", output }]);
  });

  it("shows the step as unavailable when any Strategy kind is turned off, and never falls back", async () => {
    const kinds = enabled(true).map((kind) =>
      kind.kind === "strategy.competitors" ? { ...kind, enabled: false } : kind,
    );
    const supabase = client(kinds);
    doubles.auth.mockResolvedValue({ client: supabase, userId: ownerId });
    const body = await (await overviewRoute.GET(new Request("http://127.0.0.1/api"), params)).json();
    expect(body.availability).toEqual({ status: "unavailable", operations: [], reason: "generation_unavailable" });
    expect(body.engine).toBe(true);
    const account = await (await runtime()).json();
    expect(account.availability).toEqual({ status: "unavailable", operations: [], reason: "generation_unavailable" });
    expect(supabase.rpc.mock.calls.map(([name]) => name)).not.toContain("get_strategy_availability");
  });

  it("starts nothing through the Strategy routes: new requests go through /generations", () => {
    expect("POST" in overviewRoute).toBe(false);
  });

  it("reads one earlier request and stops one that never finished", async () => {
    const supabase = client(enabled(true));
    doubles.auth.mockResolvedValue({ client: supabase, userId: ownerId });
    const jobParams = { params: Promise.resolve({ projectId, jobId }) };
    const read = await getJob(new Request("http://127.0.0.1/api"), jobParams);
    expect((await read.json()).job.id).toBe(jobId);
    const stopped = await cancel(
      new Request("http://127.0.0.1/api", { method: "DELETE", headers: { origin: "http://localhost:3105" } }),
      jobParams,
    );
    expect(stopped.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith("request_job_cancel", { p_job_id: jobId });
  });

  it("refuses a foreign request row", async () => {
    const supabase = client(enabled(true), { jobs: [{ ...job, owner_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }] });
    doubles.auth.mockResolvedValue({ client: supabase, userId: ownerId });
    const response = await overviewRoute.GET(new Request("http://127.0.0.1/api"), params);
    expect(response.status).toBe(404);
  });
});
