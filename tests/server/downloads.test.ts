import { createHash } from "node:crypto";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getPrivateAssetDownload, verifyAssetBlob } from "../../src/server/data/downloads";

// These tests verify local bytes only; no Supabase Storage service is connected.
describe("private asset integrity guard", () => {
  const bytes = '{"source":"local_fixture"}';
  const hash = createHash("sha256").update(bytes).digest("hex");
  it("accepts only the matching immutable content hash and MIME type", async () => {
    await expect(
      verifyAssetBlob(new Blob([bytes], { type: "application/json" }), hash, "application/json"),
    ).resolves.toBeUndefined();
    await expect(
      verifyAssetBlob(new Blob([bytes + "changed"], { type: "application/json" }), hash, "application/json"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      verifyAssetBlob(new Blob([bytes], { type: "text/html" }), hash, "application/json"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("rejects absent content and an invalid hash without timing comparison errors", async () => {
    await expect(verifyAssetBlob(new Blob([]), hash, "application/json")).rejects.toMatchObject({ code: "not_found" });
    await expect(
      verifyAssetBlob(new Blob([bytes], { type: "application/json" }), "not-a-hash", "application/json"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("download authorization before signing", () => {
  const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const asset = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const version = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const path = `${owner}/${project}/${asset}/${version}`;
  const bytes = "local fixture bytes";
  const hash = createHash("sha256").update(bytes).digest("hex");
  const record = {
    id: version,
    owner_id: owner,
    project_id: project,
    asset_id: asset,
    storage_path: path,
    content_hash: hash,
    mime_type: "text/plain",
  };
  function fixture(data: unknown, body = bytes, mimeType = "text/plain") {
    const download = vi.fn().mockResolvedValue({ data: new Blob([body], { type: mimeType }), error: null });
    const createSignedUrl = vi
      .fn()
      .mockResolvedValue({ data: { signedUrl: "https://fixture.example/local-signed-link" }, error: null });
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
    };
    const auth = {
      userId: owner,
      client: {
        from: vi.fn().mockReturnValue(query),
        storage: { from: vi.fn().mockReturnValue({ download, createSignedUrl }) },
      },
    } as unknown as AuthenticatedContext;
    return { auth, download, createSignedUrl, query };
  }

  it("never downloads or signs another owner's manifest or an absent version", async () => {
    for (const manifest of [null, { ...record, owner_id: project }, { ...record, storage_path: "other/path" }]) {
      const test = fixture(manifest);
      await expect(getPrivateAssetDownload(test.auth, version)).rejects.toMatchObject({ code: "not_found" });
      expect(test.download).not.toHaveBeenCalled();
      expect(test.createSignedUrl).not.toHaveBeenCalled();
    }
  });

  it("does not sign a modified object; signs matching owned bytes for only 60 seconds", async () => {
    const modified = fixture(record, "modified bytes");
    await expect(getPrivateAssetDownload(modified.auth, version)).rejects.toMatchObject({ code: "not_found" });
    expect(modified.createSignedUrl).not.toHaveBeenCalled();
    const valid = fixture(record);
    await expect(getPrivateAssetDownload(valid.auth, version)).resolves.toMatchObject({
      contentHash: hash,
      mimeType: "text/plain",
      expiresInSeconds: 60,
    });
    expect(valid.query.eq).toHaveBeenCalledWith("owner_id", owner);
    expect(valid.createSignedUrl).toHaveBeenCalledWith(path, 60, { download: "embel-dddddddd.txt" });
  });

  it.each([
    ["image/svg+xml", "svg"],
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
  ])("names %s downloads using the actual saved format", async (mimeType, extension) => {
    const valid = fixture({ ...record, mime_type: mimeType }, bytes, mimeType);
    await expect(getPrivateAssetDownload(valid.auth, version)).resolves.toMatchObject({ mimeType });
    expect(valid.createSignedUrl).toHaveBeenCalledWith(path, 60, { download: `embel-dddddddd.${extension}` });
  });
});
