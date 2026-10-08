import "server-only";
import type { AuthenticatedContext } from "../auth/context";
import { readVerifiedPrivateAsset } from "./downloads";

const previewTypes = ["image/png", "image/jpeg", "image/webp"] as const;

/** No URL input or signed bearer link; verified immutable raster bytes only. */
export async function getPrivateAssetPreview(auth: AuthenticatedContext, versionId: string): Promise<{
  bytes: Uint8Array<ArrayBuffer>; mimeType: typeof previewTypes[number];
}> {
  const stored = await readVerifiedPrivateAsset(auth, versionId, previewTypes);
  return { bytes: new Uint8Array(await stored.blob.arrayBuffer()), mimeType: stored.mimeType as typeof previewTypes[number] };
}
