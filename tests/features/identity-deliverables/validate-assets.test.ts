import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { zipSync, strToU8 } from "fflate";
import { validateLogoExportAssetBytes } from "../../../src/features/identity-deliverables/server/validate-assets";
import { id, hashBytes } from "./fixtures";
const write = (bytes: Uint8Array, mimeType: string) => ({ kind: "stage" as const, publication: { requestKey: id(900), inputRevisions: [], mimeType, contentHash: hashBytes(bytes), byteLength: bytes.byteLength, source: { kind: "export" as const, sourceId: id(901) } } });
describe("export storage format validation", () => {
  it("rejects renamed PDF content and ZIP traversal entries", async () => {
    const fake = strToU8("%PDF-1.7 invented");
    await expect(validateLogoExportAssetBytes(write(fake, "application/pdf"), fake, new AbortController().signal)).rejects.toThrow();
    const traversal = zipSync({ "../private.txt": strToU8("synthetic") });
    await expect(validateLogoExportAssetBytes(write(traversal, "application/zip"), traversal, new AbortController().signal)).rejects.toThrow();
  });
});
