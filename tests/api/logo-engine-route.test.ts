import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: doubles.auth }));
import { GET } from "../../src/app/api/projects/[projectId]/logo/engine/route";

const owner = "aaaaaaaa-1111-4111-8111-111111111111",
  project = "bbbbbbbb-2222-4222-8222-222222222222";
const params = () => ({ params: Promise.resolve({ projectId: project }) });
const catalog = (enabled: boolean) => ({
  data: {
    plans: [],
    kinds: ["logo.concepts", "logo.refine", "logo.style_note"].map((kind) => ({ kind, credits: 1, enabled })),
  },
  error: null,
});
function query(rows: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "like", "not", "order", "limit"]) builder[method] = () => builder;
  builder.then = (resolve: (value: unknown) => void) => resolve({ data: rows, error: null });
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  doubles.auth.mockResolvedValue({ userId: owner, client: { rpc: doubles.rpc, from: doubles.from } });
});

describe("GET /api/projects/[id]/logo/engine", () => {
  it("reports the old path, and reads no runs, while any Logo kind is disabled", async () => {
    doubles.rpc.mockResolvedValue(catalog(false));
    const response = await GET(new Request(`https://fluid.example/api/projects/${project}/logo/engine`), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ engine: false, runs: [] });
    expect(doubles.from).not.toHaveBeenCalled();
  });
  it("reports the engine and the latest Logo runs once all three are enabled", async () => {
    doubles.rpc.mockResolvedValue(catalog(true));
    doubles.from
      .mockReturnValueOnce(
        query([
          {
            id: "cccccccc-3333-4333-8333-333333333333",
            owner_id: owner,
            project_id: project,
            kind: "logo.concepts",
            status: "running",
            credits: 6,
            workflow_run_id: "wrun_1",
            error_code: null,
            cancel_requested_at: null,
            created_at: "2026-11-09T20:00:00Z",
            finished_at: null,
            input_revision: 1,
          },
        ]),
      )
      .mockReturnValueOnce(query([]));
    const response = await GET(new Request(`https://fluid.example/api/projects/${project}/logo/engine`), params());
    const body = await response.json();
    expect(body.engine).toBe(true);
    expect(body.runs).toEqual([expect.objectContaining({ kind: "logo.concepts", status: "running", outputs: [] })]);
    expect(JSON.stringify(body)).not.toContain("wrun_1");
  });
});
