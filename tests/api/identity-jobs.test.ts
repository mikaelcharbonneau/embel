import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn(), rpc: vi.fn(), eq: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
// Creative directions with the engine kind off: the step is unavailable (tests/server/identity-engine-switch.test.ts covers it on).
vi.mock("../../src/server/engine/identity", async (original) => ({
  ...(await original<object>()),
  identityEngineEnabled: async () => false,
  findIdentityDirectionsRun: async () => null,
}));
import { POST } from "../../src/app/api/projects/[projectId]/identity/batches/route";
import { getIdentityAvailability } from "../../src/server/data/identity-jobs";
import { ApiError } from "../../src/server/http/errors";
import { IMAGE_MODEL } from "../../src/domain/providers";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  foreign = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const intent = {
  expectedProjectRevision: 1,
  expectedReferenceRevision: 1,
  expectedPreferencesRevision: 0,
  idempotencyKey: "identity-local-fixture-001",
  acceptedPolicyIdentity: "a".repeat(64),
  acceptedMaxCostMicrousd: 0,
};
const params = (id = projectId) => ({ params: Promise.resolve({ projectId: id }) });
function request(body: unknown = intent, origin = "https://fluid.example") {
  return new Request(`https://fluid.example/api/projects/${projectId}/identity/batches`, {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
describe("Identity unavailable admission boundary — local fixtures", () => {
  let data: unknown;
  let error: unknown;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("APP_ORIGIN", "https://fluid.example");
    data = { id: projectId, owner_id: owner };
    error = null;
    const query = {
      select: () => query,
      eq: (...args: unknown[]) => {
        mocks.eq(...args);
        return query;
      },
      maybeSingle: async () => ({ data, error }),
    };
    mocks.from.mockReturnValue(query);
    mocks.auth.mockResolvedValue({ userId: owner, client: { from: mocks.from, rpc: mocks.rpc } });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("reports the exact requested image model without claiming account access", async () => {
    expect(await getIdentityAvailability(await mocks.auth(), projectId)).toEqual({
      ownerId: owner,
      projectId,
      status: "unavailable",
      operation: "identity.image",
      requestedModel: IMAGE_MODEL,
      reason: "runtime_unavailable",
    });
    expect(mocks.eq).toHaveBeenCalledWith("owner_id", owner);
  });
  it("returns503 for a valid intent and never admits or dispatches a job", async () => {
    const response = await POST(request(), params());
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("projects");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("canonicalizes an uppercase project UUID before ownership checks", async () => {
    const response = await POST(request(), params(projectId.toUpperCase()));
    expect(response.status).toBe(503);
    expect(mocks.eq).toHaveBeenCalledWith("id", projectId);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(await getIdentityAvailability(await mocks.auth(), projectId.toUpperCase())).toMatchObject({
      projectId,
      status: "unavailable",
    });
  });
  it("requires authentication before reading projects", async () => {
    mocks.auth.mockRejectedValue(new ApiError("unauthenticated"));
    expect((await POST(request(), params())).status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it.each([null, { id: projectId, owner_id: foreign }, { id: foreign, owner_id: owner }])(
    "hides absent or mismatched projects",
    async (record) => {
      data = record;
      expect((await POST(request(), params())).status).toBe(404);
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("rejects an invalid path without database access", async () => {
    expect((await POST(request(), params("invalid"))).status).toBe(404);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("requires same-origin mutations", async () => {
    expect((await POST(request(intent, "https://other.invalid"), params())).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("rejects injected model/owner/output without admission", async () => {
    expect(
      (await POST(request({ ...intent, model: "unapproved", ownerId: foreign, systems: [] }), params())).status,
    ).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("bounds the request body before any owned resource read", async () => {
    expect((await POST(request({ ...intent, notes: "x".repeat(5000) }), params())).status).toBe(413);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("sanitizes database failures without pretending that an empty batch completed", async () => {
    error = { message: "private database detail" };
    const response = await POST(request(), params());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private database detail");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
