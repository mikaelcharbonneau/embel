import { beforeEach, describe, expect, it, vi } from "vitest";

// The Strategy screens' stop switch: with every Strategy kind enabled the overview offers the
// engine's operations; with any kind off the step is unavailable and nothing falls back.
vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: doubles.auth }));
import { GET as overview } from "../../src/app/api/projects/[projectId]/strategy/route";
import { GET as runtime } from "../../src/app/api/strategy/route";
import { strategyOverviewResponseSchema } from "../../src/domain/strategy-jobs";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "11111111-1111-4111-8111-111111111111";
const kinds = ["strategy.audience", "strategy.competitors", "strategy.personality", "strategy.positioning", "strategy.reformulate", "strategy.slogan"];
const params = (id = project) => ({ params: Promise.resolve({ projectId: id }) });
function query(row: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is"]) builder[method] = () => builder;
  builder.maybeSingle = async () => ({ data: row, error: null });
  return builder;
}
function catalog(enabled: boolean) {
  doubles.rpc.mockImplementation(async (name: string) => name === "get_generation_catalog"
    ? { data: { plans: [], kinds: kinds.map(kind => ({ kind, credits: 1, enabled })) }, error: null }
    : name === "get_strategy_job_summaries" ? { data: [], error: null }
    : { data: { status: "unavailable", operations: [], reason: "worker_unavailable" }, error: null });
}

beforeEach(() => {
  vi.resetAllMocks();
  doubles.auth.mockResolvedValue({ userId: owner, client: { rpc: doubles.rpc, from: doubles.from } });
  doubles.from.mockReturnValue(query({ id: project }));
});

describe("the Strategy engine switch", () => {
  it("shows the step as unavailable while any Strategy kind is disabled, without the old worker's readiness", async () => {
    catalog(false);
    const body = strategyOverviewResponseSchema.parse(await (await overview(new Request(`https://fluid.example/api/projects/${project}/strategy`), params())).json());
    expect(body.availability).toEqual({ status: "unavailable", operations: [], reason: "generation_unavailable" });
    expect(doubles.rpc).not.toHaveBeenCalledWith(expect.stringMatching(/strategy_availability$/u), expect.anything());
  });
  it("offers every engine operation and marks the overview once all kinds are enabled", async () => {
    catalog(true);
    const body = strategyOverviewResponseSchema.parse(await (await overview(new Request(`https://fluid.example/api/projects/${project}/strategy`), params())).json());
    expect(body.engine).toBe(true);
    expect(body.availability.status).toBe("available");
    expect(body.availability.operations.map(item => item.operation).sort()).toEqual(kinds);
    expect(JSON.stringify(body)).not.toMatch(/maximumCostMicrousd|Microusd/u);
    expect(doubles.rpc).not.toHaveBeenCalledWith(expect.stringMatching(/strategy_availability$/u), expect.anything());
    const home = await (await runtime()).json();
    expect(home.availability.operations).toHaveLength(6);
  });
  it("still refuses another owner's project in engine mode", async () => {
    catalog(true);
    doubles.from.mockReturnValue(query(null));
    expect((await overview(new Request(`https://fluid.example/api/projects/${project}/strategy`), params())).status).toBe(404);
  });
});
