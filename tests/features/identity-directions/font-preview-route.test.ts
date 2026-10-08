import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const f = vi.hoisted(() => ({ auth: vi.fn(), services: vi.fn(), record: vi.fn(), bytes: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: f.auth }));
vi.mock("@/server/runtime/logo-request-services", () => ({ resolveLogoRequestServices: f.services }));
import { POST } from "@/app/api/projects/[projectId]/logo/fonts/[fontVersionId]/preview/route";
import { ApiError } from "@/server/http/errors";
import { fontFixture, fontBytes, id } from "./fixtures";
import { FONT_PREVIEW_REQUEST_BYTES } from "@/features/identity-directions/model/font-preview";
const auth = { userId: id(1) };
const scope = { params: Promise.resolve({ projectId: id(2), fontVersionId: id(50) }) };
const input = () => ({ fontContentHash: fontFixture().asset.contentHash, rightsEvidenceId: fontFixture().rights.id, sampleText: "Fluid", weight: 400, style: "normal", sizePx: 20, lineHeight: 1.4 });
const request = (body: unknown = input(), headers = {}, query = "") => new Request(`https://fluid.invalid/api/preview${query}`, { method: "POST", headers: { Origin: "https://fluid.invalid", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "https://fluid.invalid");
  f.auth.mockResolvedValue(auth); f.record.mockResolvedValue(fontFixture());
  const record = fontFixture(), bytes = fontBytes();
  f.bytes.mockResolvedValue({ reference: record.asset, bytes, mimeType: "font/ttf", verification: { status: "verified", checkedAt: "2026-10-07T00:00:00Z", contentHash: record.asset.contentHash, mimeType: "font/ttf", byteLength: bytes.byteLength } });
  f.services.mockResolvedValue({ workspace: { readLogoFontRecord: f.record }, assets: { readOwnedAsset: f.bytes } });
});
afterEach(() => vi.unstubAllEnvs());
describe("authenticated read-only font specimen route", () => {
  it("uses the existing owner-scoped asset service and returns only private passive specimen paths", async () => {
    const req = request(), result = await POST(req, scope), body = await result.json();
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store"); expect(result.headers.get("vary")).toBe("Cookie");
    expect(body).toMatchObject({ ownerId: id(1), projectId: id(2), fontVersionId: id(50), input: input(), result: { status: "ready" } });
    expect(f.services).toHaveBeenCalledWith(auth, id(2), req.signal); expect(f.record).toHaveBeenCalledWith(auth, id(50), req.signal);
    expect(body.result.document.components[0].editingKind).toBe("geometry"); expect(body).not.toHaveProperty("bytes");
  });
  it("rejects unauthenticated and cross-origin calls before reading private sources", async () => {
    f.auth.mockRejectedValueOnce(new ApiError("unauthenticated")); expect((await POST(request(), scope)).status).toBe(401);
    expect((await POST(request(input(), { Origin: "https://foreign.invalid" }), scope)).status).toBe(403); expect(f.services).not.toHaveBeenCalled();
  });
  it("rejects unknown fields, query parameters and invalid IDs without source reads", async () => {
    expect((await POST(request({ ...input(), ownerId: id(99) }), scope)).status).toBe(422);
    expect((await POST(request(input(), {}, "?fontUrl=https://foreign.invalid/font.ttf"), scope)).status).toBe(422);
    expect((await POST(request(), { params: Promise.resolve({ projectId: "bad", fontVersionId: id(50) }) })).status).toBe(422); expect(f.services).not.toHaveBeenCalled();
  });
  it("bounds actual request bytes despite a false content-length", async () => {
    expect((await POST(request({ ...input(), sampleText: "x".repeat(FONT_PREVIEW_REQUEST_BYTES) }, { "Content-Length": "1" }), scope)).status).toBe(413); expect(f.services).not.toHaveBeenCalled();
  });
  it("does not read a different project's font bytes", async () => {
    f.record.mockResolvedValue({ ...fontFixture(), asset: { ...fontFixture().asset, projectId: id(99) } });
    expect((await POST(request(), scope)).status).toBe(404); expect(f.bytes).not.toHaveBeenCalled();
  });
  it("returns unavailable when configured owned storage cannot read bytes, without any fallback", async () => {
    f.bytes.mockRejectedValue(new ApiError("integration_unavailable"));
    const result = await POST(request(), scope); expect(result.status).toBe(503); expect(await result.json()).toEqual({ error: { code: "integration_unavailable", message: "This integration is not configured or is unavailable." } });
  });
});
