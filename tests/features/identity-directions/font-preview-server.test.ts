import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createOwnedFontPreview } from "@/features/identity-directions/server/font-preview";
import { fontPreviewInputSchema, validateFontPreviewGeometry } from "@/features/identity-directions/model/font-preview";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
import type { AuthenticatedContext } from "@/server/auth/context";
import { directionFixture, fontFixture, fontBytes, id, licenseText } from "./fixtures";
const auth = { userId: id(1) } as AuthenticatedContext;
function fixture() {
  const record = fontFixture(), bytes = fontBytes(), style = directionFixture().typography[0]!.styles[0]!;
  const read = vi.fn(async () => ({ reference: record.asset, bytes, mimeType: "font/ttf", verification: { status: "verified", checkedAt: "2026-10-07T00:00:00Z", contentHash: record.asset.contentHash, mimeType: "font/ttf", byteLength: bytes.byteLength } }));
  const input = fontPreviewInputSchema.parse({ sampleText: style.sampleText, weight: style.weight, style: style.style, sizePx: style.sizePx, lineHeight: style.lineHeight, fontContentHash: record.asset.contentHash, rightsEvidenceId: record.rights.id });
  const preview = createOwnedFontPreview({ loadRecord: async () => record, store: { readOwnedAsset: read } as unknown as IdentityAssetStore, loadRightsEvidence: async () => ({ licenseText: licenseText(), sourceUrl: record.rights.sourceUrl! }) });
  return { record, input, read, preview, bytes };
}
describe("owned font specimen service with local licensed bytes", () => {
  it("shapes the exact specimen into passive geometry without embedding font binaries", async () => {
    const f = fixture();
    const output = await f.preview(auth, id(2), f.record.id, f.input, new AbortController().signal);
    expect(output).toMatchObject({ ownerId: id(1), projectId: id(2), fontVersionId: f.record.id, input: f.input, result: { status: "ready" } });
    if (output.result.status !== "ready") throw new Error("Expected local specimen");
    const document = validateFontPreviewGeometry(output.result.document);
    expect(document.components[0]!.paths.length).toBeGreaterThan(5);
    expect(JSON.stringify(output)).not.toMatch(/"bytes"|"textSource"|font-family|data:|https:/);
  });
  it.each(["owner", "project", "version", "hash", "rights"])("rejects a mismatched %s before reading bytes", async mismatch => {
    const f = fixture();
    if (mismatch === "owner") f.record.asset.ownerId = id(90);
    if (mismatch === "project") f.record.asset.projectId = id(90);
    if (mismatch === "version") f.record.id = id(90);
    if (mismatch === "hash") f.input.fontContentHash = "a".repeat(64);
    if (mismatch === "rights") f.input.rightsEvidenceId = id(90);
    await expect(f.preview(auth, id(2), id(50), f.input, new AbortController().signal)).rejects.toMatchObject({ code: "not_found" });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("requires both reviewed render and outline permissions without treating embed or redistribution as display permission", async () => {
    const f = fixture(); f.record.rights.permissions.outline = "denied";
    const output = await f.preview(auth, id(2), id(50), f.input, new AbortController().signal);
    expect(output.result).toEqual({ status: "unavailable", reason: "outline_permission_required" }); expect(f.read).not.toHaveBeenCalled();
    f.record.rights.permissions.outline = "allowed"; f.record.rights.permissions.embed = "denied"; f.record.rights.permissions.redistribute = "denied";
    expect((await f.preview(auth, id(2), id(50), f.input, new AbortController().signal)).result.status).toBe("ready");
  });
  it.each([{ style: "italic" }, { weight: 1000 }])("does not synthesize a different face: %j", async patch => {
    const f = fixture(); const output = await f.preview(auth, id(2), id(50), { ...f.input, ...patch }, new AbortController().signal);
    expect(output.result).toEqual({ status: "unavailable", reason: "style_unsupported" });
  });
  it("reports missing glyphs without falling back to a system font", async () => {
    const f = fixture(); const output = await f.preview(auth, id(2), id(50), { ...f.input, sampleText: "A\u{10ffff}" }, new AbortController().signal);
    expect(output.result).toEqual({ status: "unavailable", reason: "missing_glyphs" });
  });
  it.each(["A\nB", "A".repeat(201), "AБ"])("does not truncate or substitute an unsupported specimen", async sampleText => {
    const f = fixture(); const output = await f.preview(auth, id(2), id(50), { ...f.input, sampleText }, new AbortController().signal);
    expect(output.result).toEqual({ status: "unavailable", reason: "sample_unsupported" });
  });
  it("honors cancellation before reading font bytes", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.preview(auth, id(2), id(50), f.input, controller.signal)).rejects.toBeDefined(); expect(f.read).not.toHaveBeenCalled();
  });
  it("reports an oversized line box as unavailable instead of returning malformed geometry", async () => {
    const f = fixture();
    expect((await f.preview(auth, id(2), id(50), { ...f.input, sizePx: 256, lineHeight: 100 }, new AbortController().signal)).result).toEqual({ status: "unavailable", reason: "sample_unsupported" });
  });
  it("rejects corrupt owned bytes even when permissions advertise display", async () => {
    const f = fixture(); f.bytes[30] = f.bytes[30]! ^ 1;
    await expect(f.preview(auth, id(2), id(50), f.input, new AbortController().signal)).rejects.toMatchObject({ code: "not_found" });
  });
});
