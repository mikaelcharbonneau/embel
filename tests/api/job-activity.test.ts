import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), list: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock("../../src/server/data/job-activity", () => ({ listJobActivity: mocks.list }));
import { GET } from "../../src/app/api/jobs/route";
import { ApiError } from "../../src/server/http/errors";

describe("owned activity HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it("does not query activity without a verified session", async () => {
    mocks.auth.mockRejectedValue(new ApiError("unauthenticated"));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("uses only server-authenticated identity and makes the response private", async () => {
    const auth = { userId: "verified-account", client: {} };
    mocks.auth.mockResolvedValue(auth);
    mocks.list.mockResolvedValue({ ownerId: auth.userId, active: [], recent: [] });
    const response = await GET();
    expect(mocks.list).toHaveBeenCalledWith(auth);
    expect(await response.json()).toEqual({ ownerId: auth.userId, active: [], recent: [] });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });
  it("never serializes raw database failures", async () => {
    mocks.auth.mockResolvedValue({ userId: "verified-account" });
    mocks.list.mockRejectedValue(new Error("sensitive database detail"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("sensitive database detail");
  });
});
