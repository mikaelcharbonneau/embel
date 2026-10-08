import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createFontResolver } from "@/features/identity-directions/server/fonts";
import type { AuthenticatedContext } from "@/server/auth/context";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
import { fontFixture, fontBytes, licenseText } from "../identity-directions/fixtures";

describe("font resolver byte ownership", () => {
  it("returns an independent byte snapshot even when the store supplies a Node Buffer", async () => {
    const record = fontFixture(), original = fontBytes(), supplied = Buffer.from(original);
    const store = { readOwnedAsset: async () => ({ reference: record.asset, bytes: supplied, mimeType: "font/ttf", verification: { status: "verified", checkedAt: "2026-10-07T00:00:00Z", contentHash: record.asset.contentHash, mimeType: "font/ttf", byteLength: supplied.length } }) } as unknown as IdentityAssetStore;
    const resolve = createFontResolver({ store, loadRecord: async () => record, loadRightsEvidence: async () => ({ licenseText: licenseText(), sourceUrl: record.rights.sourceUrl! }) });
    const font = await resolve({ userId: record.asset.ownerId } as AuthenticatedContext, record.id, "render");
    supplied.fill(0);
    expect(createHash("sha256").update(font.bytes).digest("hex")).toBe(record.asset.contentHash);
  });
});
