import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), preview: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock("../../src/server/data/asset-previews", () => ({ getPrivateAssetPreview: mocks.preview }));
import { GET } from "../../src/app/api/assets/[versionId]/preview/route";
import { ApiError } from "../../src/server/http/errors";
const versionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const request = () => new Request(`https://fluid.example/api/assets/${versionId}/preview`);
const params = () => ({ params: Promise.resolve({ versionId }) });

describe("private preview response", () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it("requires verified authentication before reading an object", async () => {
    mocks.auth.mockRejectedValue(new ApiError("unauthenticated"));
    const response = await GET(request(), params());
    expect(response.status).toBe(401);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it("returns verified bytes with private cache, no-sniff and same-origin policies", async () => {
    const auth = { userId: "server-verified" };
    const bytes = new Uint8Array([1, 2, 3]);
    mocks.auth.mockResolvedValue(auth);
    mocks.preview.mockResolvedValue({ bytes, mimeType: "image/png" });
    const response = await GET(request(), params());
    expect(mocks.preview).toHaveBeenCalledWith(auth, versionId);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
  });
  it("returns a private sanitized error instead of a file when verification fails", async () => {
    mocks.auth.mockResolvedValue({ userId: "server-verified" });
    mocks.preview.mockRejectedValue(new ApiError("not_found"));
    const response = await GET(request(), params());
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});
