import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
import { GET } from "@/app/api/projects/[projectId]/inspiration/route";
import { PATCH } from "@/app/api/projects/[projectId]/inspiration/[referenceId]/route";
import { ApiError } from "@/server/http/errors";
import { inspirationCatalog, INSPIRATION_CATALOG_VERSION } from "@/domain/inspiration";
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  referenceId = inspirationCatalog[0]!.id;
const overview = {
  ownerId,
  projectId,
  projectTitle: "Fixture",
  projectScope: "complete_brand",
  projectRevision: 1,
  catalogVersion: INSPIRATION_CATALOG_VERSION,
  selectionRevision: 0,
  choices: [],
};
const params = { params: Promise.resolve({ projectId, referenceId }) };
const input = {
  catalogVersion: INSPIRATION_CATALOG_VERSION,
  expectedProjectRevision: 1,
  expectedRevision: 0,
  ensemble: true,
  elements: [],
};
const request = (body: unknown = input, origin = "https://fluid.example.invalid") =>
  new Request(`https://fluid.example.invalid/api/projects/${projectId}/inspiration/${referenceId}`, {
    method: "PATCH",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", "https://fluid.example.invalid");
  mocks.auth.mockResolvedValue({ userId: ownerId, client: { rpc: mocks.rpc } });
  mocks.rpc.mockResolvedValue({ data: overview, error: null });
});
it("returns a private authenticated overview and denies missing or foreign owners", async () => {
  const response = await GET(request(), params);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(mocks.rpc).toHaveBeenCalledWith("get_project_inspiration", { p_project_id: projectId });
  mocks.rpc.mockResolvedValue({ data: { ...overview, ownerId: projectId }, error: null });
  expect((await GET(request(), params)).status).toBe(404);
  mocks.auth.mockRejectedValue(new ApiError("unauthenticated"));
  expect((await GET(request(), params)).status).toBe(401);
});
it("rejects cross-origin writes, forged ownership, irrelevant elements and oversized bodies before RPC", async () => {
  expect((await PATCH(request(input, "https://foreign.example.invalid"), params)).status).toBe(403);
  expect((await PATCH(request({ ...input, ownerId }), params)).status).toBe(422);
  expect((await PATCH(request({ ...input, elements: ["typography"] }), params)).status).toBe(422);
  expect((await PATCH(request({ ...input, unused: "x".repeat(5000) }), params)).status).toBe(413);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("verifies exact write receipts and sanitizes unavailable/conflict database errors", async () => {
  const receipt = {
    ...overview,
    selectionRevision: 1,
    choices: [
      { ownerId, projectId, referenceId, revision: 1, ensemble: true, elements: [], updatedAt: "2026-10-13T00:00:00Z" },
    ],
  };
  mocks.rpc.mockResolvedValue({ data: receipt, error: null });
  expect((await PATCH(request(), params)).status).toBe(200);
  mocks.rpc.mockResolvedValue({ data: overview, error: null });
  expect((await PATCH(request(), params)).status).toBe(503);
  for (const [code, status] of [
    ["PT409", 409],
    ["42P01", 503],
  ] as const) {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "private database details" } });
    const response = await PATCH(request(), params);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private database details");
  }
});
it("retains installed reference capabilities after a successful selection save", async () => {
  const receipt = {
    ...overview,
    selectionRevision: 1,
    choices: [
      { ownerId, projectId, referenceId, revision: 1, ensemble: true, elements: [], updatedAt: "2026-10-13T00:00:00Z" },
    ],
  };
  const installed = inspirationCatalog.map((item) => item.id);
  mocks.rpc.mockImplementation(async (name: string) => ({
    data: name === "get_inspiration_reference_ids" ? installed : receipt,
    error: null,
  }));
  const response = await PATCH(request(), params);
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).toContain(installed.at(-1));
});
it("keeps old references available when the additive catalog migration is absent", async () => {
  mocks.rpc.mockImplementation(async (name: string) =>
    name === "get_inspiration_reference_ids"
      ? { data: null, error: { code: "42883" } }
      : { data: overview, error: null },
  );
  const response = await GET(request(), params);
  expect(response.status).toBe(200);
  const body = JSON.stringify(await response.json());
  expect(body).toContain(referenceId);
  expect(body).not.toContain(inspirationCatalog.find((item) => item.availableSince)!.id);
});
it("does not lose a confirmed selection receipt when optional discovery throws", async () => {
  const receipt = {
    ...overview,
    selectionRevision: 1,
    choices: [
      { ownerId, projectId, referenceId, revision: 1, ensemble: true, elements: [], updatedAt: "2026-10-13T00:00:00Z" },
    ],
  };
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "get_inspiration_reference_ids") throw new Error("connection interrupted");
    return { data: receipt, error: null };
  });
  const response = await PATCH(request(), params);
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).toContain('"selectionRevision":1');
});
