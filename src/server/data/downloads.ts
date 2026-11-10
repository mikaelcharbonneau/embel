import "server-only";
import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

const baseMime = (value: string) => value.split(";", 1)[0]!.trim().toLowerCase();
const extensions = new Map([
  ["image/svg+xml", "svg"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["application/pdf", "pdf"],
  ["application/zip", "zip"],
  ["application/json", "json"],
  ["text/plain", "txt"],
]);

/** Authenticated, short-lived link to a persisted private object; never implies export production. */
export async function getPrivateAssetDownload(auth: AuthenticatedContext, versionId: string) {
  const { path, contentHash, mimeType } = await readVerifiedPrivateAsset(auth, versionId);
  // Supabase applies the authenticated user's Storage SELECT policy when signing.
  // Storage paths are extensionless IDs. Supply the extension from the verified
  // MIME so a browser saves a file that opens in the appropriate application.
  const extension = extensions.get(mimeType);
  const filename = extension ? `embel-${versionId.slice(0, 8)}.${extension}` : true;
  const result = await auth.client.storage.from("fluid-assets").createSignedUrl(path, 60, { download: filename });
  if (result.error || !result.data?.signedUrl) throw new ApiError("not_found");
  return { url: result.data.signedUrl, versionId, contentHash, mimeType, expiresInSeconds: 60 };
}

/** Server-only common boundary for downloads and inline raster previews. */
export async function readVerifiedPrivateAsset(
  auth: AuthenticatedContext,
  versionId: string,
  allowedMimeTypes?: readonly string[],
) {
  if (!z.uuid().safeParse(versionId).success) throw new ApiError("not_found");
  const { data, error } = await auth.client
    .from("asset_versions")
    .select("id,owner_id,project_id,asset_id,storage_path,content_hash,mime_type")
    .eq("id", versionId)
    .eq("owner_id", auth.userId)
    .maybeSingle();
  if (error) throw new ApiError("integration_unavailable");
  if (!data || !data.storage_path) throw new ApiError("not_found");
  if (!z.uuid().safeParse(data.project_id).success || !z.uuid().safeParse(data.asset_id).success)
    throw new ApiError("not_found");
  const expectedPath = `${auth.userId}/${data.project_id}/${data.asset_id}/${versionId}`;
  if (data.owner_id !== auth.userId || data.id !== versionId || data.storage_path !== expectedPath)
    throw new ApiError("not_found");
  if (!/^[0-9a-f]{64}$/.test(data.content_hash) || typeof data.mime_type !== "string") throw new ApiError("not_found");
  const mimeType = baseMime(data.mime_type);
  if (allowedMimeTypes && !allowedMimeTypes.includes(mimeType)) throw new ApiError("not_found");
  // Confirm stored bytes match the immutable manifest before granting a download.
  // The bucket is limited to 50 MiB; no user-supplied URL is fetched here.
  const stored = await auth.client.storage.from("fluid-assets").download(expectedPath);
  if (stored.error || !stored.data) throw new ApiError("not_found");
  await verifyAssetBlob(stored.data, data.content_hash, data.mime_type);
  return { blob: stored.data, path: expectedPath, contentHash: data.content_hash as string, mimeType };
}

export async function verifyAssetBlob(blob: Blob, expectedHash: string, expectedMime: string): Promise<void> {
  if (
    blob.size === 0 ||
    blob.size > 52_428_800 ||
    !/^[0-9a-f]{64}$/.test(expectedHash) ||
    !baseMime(expectedMime) ||
    baseMime(blob.type) !== baseMime(expectedMime)
  )
    throw new ApiError("not_found");
  const actual = createHash("sha256")
    .update(new Uint8Array(await blob.arrayBuffer()))
    .digest();
  if (!timingSafeEqual(actual, Buffer.from(expectedHash, "hex"))) throw new ApiError("not_found");
}
