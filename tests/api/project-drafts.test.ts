import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), single: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: doubles.auth }));
import { PATCH } from "../../src/app/api/projects/[projectId]/route";
import { ApiError } from "../../src/server/http/errors";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "11111111-1111-4111-8111-111111111111";
const context = contextSnapshotSchema.parse({
  description: "Explicit local API fixture", activity: "Fixture activity", offering: "Fixture offering", reformulationConfirmed: true,
  audienceSegments: [{ id: "22222222-2222-4222-8222-222222222222", label: "a".repeat(180), needs: ["n".repeat(2000)], reason: "User provided", selected: true, origin: "user" }],
  intake: { suppliedName: "Fixture name", namingNotes: "Fixture naming notes", identityNotes: "Fixture identity notes", step: "audience", audienceReviewedAt: "2026-10-02T00:00:00Z", example: true },
});
const hash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
const revision = { project_id: projectId, owner_id: ownerId, revision: 2, context, input_hash: hash, created_at: "2026-10-02T00:00:00Z" };
const expanded = { id: projectId, owner_id: ownerId, current_revision: 2, scope: "complete_brand", title: "Fixture title", context, created_at: "2026-10-02T00:00:00Z" };
const route = (id = projectId) => ({ params: Promise.resolve({ projectId: id }) });
const request = (body: unknown, method = "POST", headers?: Record<string, string>) => new Request(`https://fluid.example/api/projects/${projectId}`, {
  method, headers: { origin: "https://fluid.example", "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

describe("project drafting HTTP contracts and security", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("APP_ORIGIN", "https://fluid.example");
    doubles.auth.mockResolvedValue({ userId: ownerId, client: { rpc: doubles.rpc } });
    doubles.rpc.mockReturnValue({ single: doubles.single });
    doubles.single.mockResolvedValue({ data: expanded, error: null });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("sends the title and complete validated context through one append RPC with the original response envelope", async () => {
    doubles.single.mockResolvedValue({ data: revision, error: null });
    const response = await PATCH(request({ expectedRevision: 1, title: " Edited title ", context }, "PATCH"), route());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision });
    expect(doubles.rpc).toHaveBeenCalledExactlyOnceWith("append_project_revision", {
      p_project_id: projectId, p_expected_revision: 1, p_context: context, p_input_hash: hash, p_title: "Edited title",
    });
  });

  it("omits the title when a legacy context-only update is submitted", async () => {
    doubles.single.mockResolvedValue({ data: revision, error: null });
    expect((await PATCH(request({ expectedRevision: 1, context }, "PATCH"), route())).status).toBe(200);
    expect(doubles.rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_title");
  });

  it.each([{ title: "" }, { title: "t".repeat(161) }, { scope: "complete_brand" }, { ownerId }, { owner_id: ownerId }])("rejects invalid draft fields %j before the RPC", async extra => {
    expect((await PATCH(request({ expectedRevision: 1, context, ...extra }, "PATCH"), route())).status).toBe(422);
    expect(doubles.rpc).not.toHaveBeenCalled();
  });

  it("rejects cross-site writes before authentication and refuses oversized or non-JSON bodies", async () => {
    expect((await PATCH(request({ expectedRevision: 1, context }, "PATCH", { origin: "https://untrusted.example" }), route())).status).toBe(403);
    expect(doubles.auth).not.toHaveBeenCalled();
    expect((await PATCH(request({ expectedRevision: 1, context }, "PATCH", { "sec-fetch-site": "cross-site" }), route())).status).toBe(403);
    expect((await PATCH(request({ expectedRevision: 1, context }, "PATCH", { "content-type": "text/plain" }), route())).status).toBe(422);
    expect((await PATCH(request("x".repeat(32_769), "PATCH"), route())).status).toBe(413);
    expect(doubles.rpc).not.toHaveBeenCalled();
  });

  it("requires a verified session and conceals malformed resource identifiers", async () => {
    doubles.auth.mockRejectedValueOnce(new ApiError("unauthenticated"));
    expect((await PATCH(request({ expectedRevision: 1, context }, "PATCH"), route())).status).toBe(401);
    expect((await PATCH(request({ expectedRevision: 1, context }, "PATCH"), route("not-a-uuid"))).status).toBe(404);
    expect(doubles.rpc).not.toHaveBeenCalled();
  });

  it.each([["P0002", 404], ["40001", 409], ["PT409", 409], ["22023", 422], ["08006", 503]] as const)("maps SQL error %s to safe status %i for draft saves", async (code, status) => {
    doubles.single.mockResolvedValue({ data: null, error: { code, message: "private-database-diagnostic" } });
    for (const response of [await PATCH(request({ expectedRevision: 1, context }, "PATCH"), route())]) {
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain("private-database-diagnostic");
    }
  });
});
