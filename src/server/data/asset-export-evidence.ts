import "server-only";
import { z } from "zod";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import { logoExportManifestSchema } from "@/domain/logo-deliverables";
import { assetLogoExportResponseSchema } from "@/features/identity-deliverables/model/asset-export-response";
const versionSchema = z.strictObject({ id: z.uuid(), owner_id: z.uuid(), project_id: z.uuid(), asset_id: z.uuid(), content_hash: z.string().regex(/^[a-f0-9]{64}$/), mime_type: z.string().min(1).max(150) });
const active = (signal?: AbortSignal) => { if (signal?.aborted) throw new ApiError("integration_unavailable"); };
/** Read-only immutable provenance lookup. File availability is checked separately
 * by the existing private download boundary; metadata never certifies legal rights. */
export async function getAssetLogoExport(auth: AuthenticatedContext, versionId: string, signal?: AbortSignal) {
  const parsedId = z.uuid().safeParse(versionId);
  if (!parsedId.success) throw new ApiError("not_found");
  versionId = parsedId.data.toLowerCase(); const ownerId = auth.userId.toLowerCase(); active(signal);
  let query = auth.client.from("asset_versions").select("id,owner_id,project_id,asset_id,content_hash,mime_type").eq("id", versionId).eq("owner_id", ownerId);
  if (signal) query = query.abortSignal(signal);
  const stored = await query.maybeSingle(); active(signal);
  if (stored.error) throw new ApiError("integration_unavailable");
  const parsed = versionSchema.safeParse(stored.data);
  if (!parsed.success || parsed.data.id !== versionId || parsed.data.owner_id !== ownerId) throw new ApiError("not_found");
  const version = parsed.data;
  let evidence = auth.client.from("logo_export_manifests").select("record").eq("owner_id", ownerId).eq("project_id", version.project_id)
    .contains("record", { files: [{ asset: { reference: { versionId } } }] }).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1);
  if (signal) evidence = evidence.abortSignal(signal);
  const result = await evidence; active(signal);
  if (result.error) throw new ApiError("integration_unavailable");
  const records = z.array(z.strictObject({ record: logoExportManifestSchema })).max(1).safeParse(result.data);
  if (!records.success) throw new ApiError("integration_unavailable");
  const manifest = records.data[0]?.record ?? null;
  if (manifest && (manifest.ownerId !== ownerId || manifest.projectId !== version.project_id || !manifest.files.some(({ asset }) => {
    const ref = asset.reference;
    return asset.publicationState === "committed" && ref.ownerId === ownerId && ref.projectId === version.project_id && ref.assetId === version.asset_id && ref.versionId === versionId && ref.contentHash === version.content_hash && asset.verification.mimeType === version.mime_type;
  }))) throw new ApiError("integration_unavailable");
  return assetLogoExportResponseSchema.parse({ ownerId, projectId: version.project_id, versionId, manifest });
}
