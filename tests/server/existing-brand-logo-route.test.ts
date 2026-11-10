import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const f = vi.hoisted(() => ({ auth: vi.fn(), initialize: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: f.auth }));
vi.mock("@/server/data/existing-brand-logo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/data/existing-brand-logo")>()),
  initializeExistingBrandLogo: f.initialize,
}));
import { LogoInitializationRejectedError } from "@/server/data/existing-brand-logo";
import { initializeExistingBrandLogoInputSchema } from "@/features/logo-creation/model/existing-brand";
import { ApiError } from "@/server/http/errors";
import { POST } from "@/app/api/projects/[projectId]/logo/initialize/route";
const id = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = { params: Promise.resolve({ projectId: id(2) }) };
const body = {
  requestKey: id(3),
  expected: {
    projectRevision: 1,
    referenceRevision: 0,
    preferencesRevision: 0,
    workspaceRevision: 0,
    stageRevisions: { brief_references: 0, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 },
  },
  brief: { name: "Fictional", activity: "Studio", audience: "Founders", personality: "Clear", logoTypes: ["wordmark"] },
};
const request = (value: unknown, origin = "https://fluid.invalid") =>
  new Request("https://fluid.invalid/api", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", "https://fluid.invalid");
  f.auth.mockResolvedValue({ userId: id(1), client: {} });
  f.initialize.mockResolvedValue({ fixture: "receipt" });
});
afterEach(() => vi.unstubAllEnvs());
it("initializes only the exact authenticated route project with bounded source heads", async () => {
  const req = request(body);
  const response = await POST(req, context);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(f.initialize.mock.calls[0]!.slice(1)).toEqual([id(2), body, req.signal]);
});
it("rejects foreign origin and extra owner fields before initialization", async () => {
  expect((await POST(request(body, "https://foreign.invalid"), context)).status).toBe(403);
  expect((await POST(request({ ...body, ownerId: id(9) }), context)).status).toBe(422);
  expect(f.initialize).not.toHaveBeenCalled();
});

it("exposes only exact committed initialization rejection proofs", async () => {
  const input = initializeExistingBrandLogoInputSchema.parse(body),
    rejected = new LogoInitializationRejectedError(id(1), id(2), input);
  f.initialize.mockRejectedValue(rejected);
  const response = await POST(request(body), context);
  expect(response.status).toBe(409);
  expect((await response.json()).rejection).toEqual(rejected.rejection);
  for (const failure of [
    new ApiError("conflict"),
    new LogoInitializationRejectedError(id(9), id(2), input),
    new LogoInitializationRejectedError(id(1), id(2), { ...input, brief: { ...input.brief, name: "Different" } }),
  ]) {
    f.initialize.mockRejectedValue(failure);
    expect((await (await POST(request(body), context)).json()).rejection).toBeUndefined();
  }
});
