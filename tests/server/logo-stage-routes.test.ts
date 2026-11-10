import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const f = vi.hoisted(() => ({ resolve: vi.fn(), auth: vi.fn(), save: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: f.auth }));
vi.mock("../../src/server/data/logo-workspace", () => ({
  restoreLogoStage: f.save,
  selectLogoConcept: f.save,
  selectLogoRaster: f.save,
  saveLogoEdit: f.save,
  acceptLogoVector: f.save,
  selectIdentityDirectionComponents: f.save,
  approveIdentityDirection: f.save,
  prepareLogoVariants: f.save,
  reviewLogoVariants: f.save,
}));
vi.mock("@/server/runtime/logo-request-services", () => ({ resolveLogoRequestServices: f.resolve }));
import { ApiError } from "../../src/server/http/errors";
const routes = {
  "concepts/selection": () => import("../../src/app/api/projects/[projectId]/logo/concepts/selection/route"),
  "rasters/selection": () => import("../../src/app/api/projects/[projectId]/logo/rasters/selection/route"),
  "directions/selection": () => import("../../src/app/api/projects/[projectId]/logo/directions/selection/route"),
  "directions/approval": () => import("../../src/app/api/projects/[projectId]/logo/directions/approval/route"),
  "variants/prepare": () => import("../../src/app/api/projects/[projectId]/logo/variants/prepare/route"),
  "variants/review": () => import("../../src/app/api/projects/[projectId]/logo/variants/review/route"),
};
const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = { params: Promise.resolve({ projectId: id(2) }) };
const req = (body: unknown, origin = "https://fluid.invalid") =>
  new Request("https://fluid.invalid/api/logo", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", "https://fluid.invalid");
  f.auth.mockResolvedValue({ userId: id(1), client: {} });
  f.resolve.mockResolvedValue({
    workspace: {
      restoreLogoStage: f.save,
      saveLogoEdit: f.save,
      acceptLogoVector: f.save,
      selectIdentityDirectionComponents: f.save,
      approveIdentityDirection: f.save,
      prepareLogoVariants: f.save,
      reviewLogoVariants: f.save,
    },
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("explicit logo stage mutation routes", () => {
  it.each(Object.keys(routes) as (keyof typeof routes)[])(
    "%s enforces authentication, origin and strict input before mutation",
    async (path) => {
      const route = await routes[path]();
      expect((await route.POST(req({ ownerId: id(1) }), context)).status).toBe(422);
      expect((await route.POST(req({}, "https://evil.invalid"), context)).status).toBe(403);
      f.auth.mockRejectedValueOnce(new ApiError("unauthenticated"));
      expect((await route.POST(req({}), context)).status).toBe(401);
      expect(f.save).not.toHaveBeenCalled();
    },
  );
  it("passes an explicit concept selection to the owned service without approving it", async () => {
    const route = await import("../../src/app/api/projects/[projectId]/logo/concepts/selection/route");
    const input = {
      requestKey: id(3),
      batchId: id(4),
      slotId: id(5),
      attemptId: id(6),
      expected: {
        projectRevision: 1,
        referenceRevision: 0,
        preferencesRevision: 0,
        workspaceRevision: 1,
        stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 },
      },
    };
    f.save.mockResolvedValue({ fixture: "saved-selection" });
    const response = await route.POST(req(input), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(f.save.mock.calls[0]!.slice(1)).toEqual([id(2), input]);
  });
});

const expected = {
  projectRevision: 1,
  referenceRevision: 0,
  preferencesRevision: 0,
  workspaceRevision: 1,
  stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 },
};
const trustedBodies = {
  "directions/selection": {
    approvedLogoId: id(4),
    paletteVersionId: id(5),
    typographyVersionId: id(6),
    graphicsVersionId: id(7),
  },
  "directions/approval": { directionSelectionId: id(4), consistencyHash: "a".repeat(64) },
  "variants/prepare": { approvedLogoId: id(4), directionApprovalId: id(5) },
  "variants/review": {
    approvedLogoId: id(4),
    directionApprovalId: id(5),
    variantSetId: id(6),
    acceptedVariantIds: [id(7)],
  },
};
it.each(Object.keys(trustedBodies) as (keyof typeof trustedBodies)[])(
  "%s resolves fresh request capabilities and forwards exact signal/body",
  async (path) => {
    const input = { requestKey: id(3), expected, ...trustedBodies[path] },
      request = req(input);
    f.save.mockResolvedValue({ fixture: "owned-receipt" });
    const response = await (await routes[path]()).POST(request, context);
    expect(response.status).toBe(200);
    expect(f.resolve).toHaveBeenCalledWith(expect.objectContaining({ userId: id(1) }), id(2), request.signal);
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ userId: id(1) }), id(2), input, request.signal);
  },
);
