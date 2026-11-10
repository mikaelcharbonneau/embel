import "server-only";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { identityReferenceEntrySchema } from "@/domain/identity-references";
import { logoInputRequestSchema, logoInputRequestStateSchema } from "@/features/logo-inputs/model/contracts";
import { identityReferenceUploadMetadataSchema } from "@/domain/identity-reference-uploads";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

/** Register the authenticated customer's exact raster-upload intent. This has no
 * byte-attestation authority and does not create a Logo brief or stage. */
export async function prepareIdentityReferenceUpload(
  auth: AuthenticatedContext,
  projectId: string,
  input: unknown,
  bytes: Uint8Array,
  mimeType: string,
) {
  const request = logoInputRequestSchema.safeParse({
    kind: "reference_upload",
    input,
    file: { contentHash: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, mimeType },
  });
  if (!request.success) throw new ApiError("invalid_input");
  const { data, error } = await auth.client.rpc("prepare_shared_identity_reference_upload", {
    p_project_id: projectId,
    p_request: request.data,
  });
  if (error) {
    if (["PT409", "23505", "40001"].includes(String(error.code))) throw new ApiError("conflict");
    if (["42501", "P0002", "PT404"].includes(String(error.code))) throw new ApiError("not_found");
    if (["22023", "PT422"].includes(String(error.code))) throw new ApiError("invalid_input");
    throw new ApiError("integration_unavailable");
  }
  const state = logoInputRequestStateSchema.safeParse(data);
  if (
    !state.success ||
    state.data.status === "not_found" ||
    state.data.ownerId !== auth.userId ||
    state.data.projectId !== projectId ||
    !isDeepStrictEqual(state.data.request, request.data)
  )
    throw new ApiError("integration_unavailable");
  if (state.data.status === "rejected") throw new ApiError("conflict");
  return state.data;
}

/** The customer RPC resolves committed, byte-observed immutable media. Caller
 * metadata cannot select an asset, storage path, owner or automatic reaction. */
export async function identityReferenceUploadRecord(
  auth: AuthenticatedContext,
  projectId: string,
  requestKey: string,
  metadata?: unknown,
) {
  const parsed = metadata === undefined ? null : identityReferenceUploadMetadataSchema.safeParse(metadata);
  if (parsed && !parsed.success) throw new ApiError("invalid_input");
  const args = {
    p_project_id: projectId,
    p_upload_request_key: requestKey,
    ...(parsed?.success ? { p_metadata: parsed.data } : {}),
  };
  const { data, error } = await auth.client.rpc(
    metadata === undefined ? "read_shared_identity_reference_upload" : "register_shared_identity_reference",
    args,
  );
  if (error) {
    if (["PT409", "23505", "40001"].includes(String(error.code))) throw new ApiError("conflict");
    if (["42501", "P0002", "PT404"].includes(String(error.code))) throw new ApiError("not_found");
    if (["22023", "PT422"].includes(String(error.code))) throw new ApiError("invalid_input");
    throw new ApiError("integration_unavailable");
  }
  if (metadata === undefined && data === null) return null;
  const entry = identityReferenceEntrySchema.safeParse(data);
  if (
    !entry.success ||
    entry.data.reference.ownerId !== auth.userId ||
    entry.data.reference.projectId !== projectId ||
    entry.data.reference.source !== "user_supplied"
  )
    throw new ApiError("integration_unavailable");
  if (
    parsed?.success &&
    !isDeepStrictEqual(parsed.data, {
      attribution: entry.data.reference.attribution,
      relevantElements: entry.data.reference.relevantElements,
      tags: entry.data.reference.tags,
    })
  )
    throw new ApiError("integration_unavailable");
  return entry.data;
}
