import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedContext } from "../../src/server/auth/context";
vi.mock("server-only", () => ({}));
import { getPrivateAssetPreview } from "../../src/server/data/asset-previews";

// A local one-pixel fixture. These tests do not upload or access live Storage.
const bytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=",
  "base64",
);
const hash = createHash("sha256").update(bytes).digest("hex");
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const asset = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const version = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const path = `${owner}/${project}/${asset}/${version}`;
const manifest = {
  id: version,
  owner_id: owner,
  project_id: project,
  asset_id: asset,
  storage_path: path,
  content_hash: hash,
  mime_type: "image/png",
};
function fixture(record: unknown = manifest, blob: Blob | null = new Blob([bytes], { type: "image/png" })) {
  const download = vi.fn().mockResolvedValue({ data: blob, error: null });
  const sign = vi.fn();
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: record, error: null }),
  };
  const auth = {
    userId: owner,
    client: {
      from: vi.fn().mockReturnValue(query),
      storage: { from: vi.fn().mockReturnValue({ download, createSignedUrl: sign }) },
    },
  } as unknown as AuthenticatedContext;
  return { auth, download, sign, query };
}
describe("private raster preview", () => {
  it("returns only the verified owned bytes without creating a bearer link", async () => {
    const f = fixture();
    const result = await getPrivateAssetPreview(f.auth, version);
    expect(result.mimeType).toBe("image/png");
    expect(Buffer.from(result.bytes)).toEqual(bytes);
    expect(f.query.eq).toHaveBeenCalledWith("owner_id", owner);
    expect(f.download).toHaveBeenCalledWith(path);
    expect(f.sign).not.toHaveBeenCalled();
  });
  it.each(["IMAGE/PNG", " image/png ", "image/png; charset=binary"])(
    "verifies %s using canonical raster MIME",
    async (mime) => {
      const f = fixture({ ...manifest, mime_type: mime });
      const result = await getPrivateAssetPreview(f.auth, version);
      expect(result.mimeType).toBe("image/png");
      expect(Buffer.from(result.bytes)).toEqual(bytes);
      expect(f.sign).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { ...manifest, owner_id: project },
    { ...manifest, storage_path: "foreign/path" },
    { ...manifest, project_id: "not-a-uuid", storage_path: `${owner}/not-a-uuid/${asset}/${version}` },
  ])("rejects missing or unowned manifests before Storage access", async (record) => {
    const f = fixture(record);
    await expect(getPrivateAssetPreview(f.auth, version)).rejects.toMatchObject({ code: "not_found" });
    expect(f.download).not.toHaveBeenCalled();
  });
  it.each([
    "image/svg+xml",
    " IMAGE/SVG+XML; charset=utf-8",
    "text/html",
    "text/html; image/png",
    "application/pdf",
    "application/json",
  ])("never serves %s inline", async (mime) => {
    const f = fixture({ ...manifest, mime_type: mime }, new Blob([bytes], { type: mime }));
    await expect(getPrivateAssetPreview(f.auth, version)).rejects.toMatchObject({ code: "not_found" });
    expect(f.sign).not.toHaveBeenCalled();
  });
  it.each([null, new Blob(["changed"], { type: "image/png" }), new Blob([bytes], { type: "text/html" })])(
    "rejects missing or mismatched objects",
    async (blob) => {
      const f = fixture(manifest, blob);
      await expect(getPrivateAssetPreview(f.auth, version)).rejects.toMatchObject({ code: "not_found" });
      expect(f.sign).not.toHaveBeenCalled();
    },
  );
});
