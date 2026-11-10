import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ context: vi.fn(), remove: vi.fn() }));
vi.mock("@/server/account/deletion", async importOriginal => {
  const actual = await importOriginal<typeof import("@/server/account/deletion")>();
  return { ...actual, getDeletionContext: mock.context, deleteSignedInAccount: mock.remove };
});
import { POST } from "@/app/api/account/deletion/route";
import { ApiError } from "@/server/http/errors";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const context = { client: {}, user: { id: A, email: "owner@example.invalid" }, claims: {} };
const request = (body: unknown = { confirmEmail: "owner@example.invalid" }, headers: Record<string, string> = {}, query = "") =>
  new Request(`http://localhost:3105/api/account/deletion${query}`, { method: "POST",
    headers: { origin: "http://localhost:3105", "content-type": "application/json", "X-Embel-Account": A, ...headers }, body: JSON.stringify(body) });

beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "http://localhost:3105"); mock.context.mockResolvedValue(context); mock.remove.mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllEnvs());

describe("account deletion route", () => {
  it("deletes the verified session's own account and answers privately", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ deleted: true });
    expect(mock.remove).toHaveBeenCalledWith(context, "owner@example.invalid");
  });

  it("never deletes another account: a different captured account is refused, and no owner can be named in the request", async () => {
    expect((await POST(request(undefined, { "X-Embel-Account": B }))).status).toBe(401);
    expect((await POST(request({ confirmEmail: "owner@example.invalid", ownerId: B }))).status).toBe(422);
    expect((await POST(request(undefined, {}, `?ownerId=${B}`))).status).toBe(422);
    expect(mock.remove).not.toHaveBeenCalled();
  });

  it("refuses cross-site and missing origins before reading the session", async () => {
    expect((await POST(request(undefined, { origin: "https://foreign.invalid" }))).status).toBe(403);
    expect((await POST(request(undefined, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    const absent = request(); absent.headers.delete("origin");
    expect((await POST(absent)).status).toBe(403);
    expect(mock.context).not.toHaveBeenCalled();
  });

  it("passes on confirmation, freshness and partial-failure answers without details", async () => {
    for (const [code, status] of [["confirmation_mismatch", 422], ["reauthentication_required", 403], ["deletion_incomplete", 503], ["unauthenticated", 401]] as const) {
      mock.remove.mockRejectedValueOnce(new ApiError(code));
      const response = await POST(request());
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    }
    mock.remove.mockRejectedValueOnce(new Error("PRIVATE STORAGE DETAIL"));
    const hidden = await POST(request());
    expect(hidden.status).toBe(500);
    expect(await hidden.text()).not.toContain("PRIVATE");
  });
});
