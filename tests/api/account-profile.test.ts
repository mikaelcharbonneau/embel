import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), save: vi.fn() }));
vi.mock("@/server/data/account-profile", () => ({
  getProfileContext: mock.auth,
  readAccountProfile: mock.read,
  saveAccountProfile: mock.save,
}));
import { GET, PATCH } from "@/app/api/account/profile/route";
import { ApiError } from "@/server/http/errors";
import { DEFAULT_PROFILE_VALUES } from "@/domain/account-profile";
const auth = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "verified@example.invalid", client: {} };
const body = { expectedRevision: 0, values: DEFAULT_PROFILE_VALUES };
const request = (payload: unknown = body, origin = "http://localhost:3105", query = "") =>
  new Request("http://localhost:3105/api/account/profile" + query, {
    method: "PATCH",
    headers: { origin, "content-type": "application/json", "X-Embel-Account": auth.userId },
    body: JSON.stringify(payload),
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", "http://localhost:3105");
  mock.auth.mockResolvedValue(auth);
  mock.read.mockResolvedValue({});
  mock.save.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());
describe("profile HTTP boundary", () => {
  it.each([undefined, "invalid", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])(
    "rejects a missing or mismatched captured account before profile mutation: %s",
    async (expectedOwner) => {
      const req = request();
      if (expectedOwner) req.headers.set("X-Embel-Account", expectedOwner);
      else req.headers.delete("X-Embel-Account");
      expect((await PATCH(req)).status).toBe(401);
      expect(mock.save).not.toHaveBeenCalled();
    },
  );
  it("uses verified identity and private responses for reads and writes", async () => {
    const response = await GET(new Request("http://localhost:3105/api/account/profile"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(mock.read).toHaveBeenCalledWith(auth);
    expect(
      (
        await PATCH(
          request({ expectedRevision: 1, values: { ...DEFAULT_PROFILE_VALUES, fullName: "  Taylor Example  " } }),
        )
      ).status,
    ).toBe(200);
    expect(mock.save).toHaveBeenCalledWith(auth, {
      expectedRevision: 1,
      values: { ...DEFAULT_PROFILE_VALUES, fullName: "Taylor Example" },
    });
  });
  it("rejects cross-site and missing origins before auth or persistence", async () => {
    expect((await PATCH(request(body, "https://foreign.invalid"))).status).toBe(403);
    const absent = request();
    absent.headers.delete("origin");
    expect((await PATCH(absent)).status).toBe(403);
    const crossSite = request();
    crossSite.headers.set("sec-fetch-site", "cross-site");
    expect((await PATCH(crossSite)).status).toBe(403);
    expect(mock.auth).not.toHaveBeenCalled();
    expect(mock.save).not.toHaveBeenCalled();
  });
  it("bounds streamed bodies and excludes caller ownership, email, unknown preferences, and query filters", async () => {
    for (const value of [
      { ...body, ownerId: auth.userId },
      { ...body, email: "x@example.invalid" },
      { ...body, values: { ...DEFAULT_PROFILE_VALUES, defaultModel: "fake" } },
      { ...body, expectedRevision: -1 },
    ]) {
      expect((await PATCH(request(value))).status).toBe(422);
    }
    expect((await PATCH(request({ text: "x".repeat(2049) }))).status).toBe(413);
    expect((await PATCH(request(body, "http://localhost:3105", "?ownerId=foreign"))).status).toBe(422);
    expect((await GET(new Request("http://localhost:3105/api/account/profile?ownerId=foreign"))).status).toBe(422);
    expect(mock.auth).not.toHaveBeenCalled();
    expect(mock.save).not.toHaveBeenCalled();
  });
  it("requires a verified account for both methods and hides database errors", async () => {
    mock.auth.mockRejectedValue(new ApiError("unauthenticated"));
    expect((await GET(new Request("http://localhost:3105/api/account/profile"))).status).toBe(401);
    expect((await PATCH(request())).status).toBe(401);
    mock.auth.mockResolvedValue(auth);
    mock.save.mockRejectedValue(new ApiError("conflict"));
    expect((await PATCH(request())).status).toBe(409);
    mock.save.mockRejectedValue(new Error("PRIVATE DATABASE DETAIL"));
    const failure = await PATCH(request());
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain("PRIVATE");
  });
});
