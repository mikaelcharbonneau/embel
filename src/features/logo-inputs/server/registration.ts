import "server-only";
import { createHash } from "node:crypto";
import { fontRecordSchema, type FontRecord } from "@/domain/logo-directions";
import {
  committedIdentityAssetReceiptSchema,
  type IdentityAssetReceipt,
  type IdentityUploadIntent,
} from "@/domain/logo-deliverables";
import type { LogoReferenceRegistration } from "@/domain/logo-workspace";
import { inspectFontBytes } from "@/features/identity-directions/server/font-inspection";
import {
  describeUploadedFontRights,
  readFreeCatalogFont,
  type CatalogFontBytes,
} from "@/features/identity-directions/server/fonts";
import { inspectIdentityRaster } from "@/features/logo-vector/server/converter";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import type { IdentityAssetStore, IdentityAssetWrite } from "@/server/data/identity-asset-store";
import { logoOwner, logoId, parseLogoInput } from "@/server/data/logo-transaction";
import { canonicalIdentityInput } from "@/features/identity-directions/model/font-check-binding";
import { logoInputRequestSchema, type LogoInputRequest, type LogoInputRequestState } from "../model/contracts";

type LogoInputEvidence = { family: string; licenseText: string; licenseSourceUrl: string | null } | null;
export interface LogoInputRegistry {
  prepare(
    auth: AuthenticatedContext,
    projectId: string,
    request: LogoInputRequest,
    signal?: AbortSignal,
  ): Promise<LogoInputRequestState>;
  commit(
    auth: AuthenticatedContext,
    projectId: string,
    request: LogoInputRequest,
    receipt: IdentityAssetReceipt,
    evidence: LogoInputEvidence,
    signal?: AbortSignal,
  ): Promise<LogoInputRequestState>;
}
export class LogoInputUncertainCommitError extends ApiError {
  constructor(
    readonly projectId: string,
    readonly requestKey: string,
  ) {
    super("integration_unavailable");
    this.name = "LogoInputUncertainCommitError";
  }
}
export const inputHash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const activeLogoInput = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new ApiError("integration_unavailable");
};
function catalogDeclaration(id: string, licenseHash: string): string {
  return `Reviewed free-commercial catalog ${id}; exact license SHA-256 ${licenseHash}.`;
}
/** Supplies the existing store's required non-raster validator. No catalog lookup,
 * network, permission escalation, fallback format or metadata-only acceptance. */
export async function validateLogoInputBytes(
  write: IdentityAssetWrite,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const mime = write.kind === "upload" ? write.intent.mimeType : write.publication.mimeType;
  if (mime === "font/ttf" || mime === "font/otf") {
    try {
      await inspectFontBytes(bytes, mime, signal);
    } catch {
      activeLogoInput(signal);
      throw new ApiError("invalid_input");
    }
  } else if (!["image/png", "image/jpeg", "image/webp", "image/svg+xml", "application/json"].includes(mime))
    throw new ApiError("invalid_input");
}
function verifiedReceipt(
  auth: AuthenticatedContext,
  projectId: string,
  request: LogoInputRequest,
  value: IdentityAssetReceipt,
): IdentityAssetReceipt {
  const parsed = committedIdentityAssetReceiptSchema.safeParse(value),
    owner = logoOwner(auth);
  if (!parsed.success) throw new ApiError("integration_unavailable");
  const receipt = parsed.data;
  if (
    receipt.reference.ownerId !== owner ||
    receipt.reference.projectId !== projectId ||
    receipt.reference.contentHash !== request.file.contentHash ||
    receipt.verification.mimeType !== request.file.mimeType ||
    receipt.verification.byteLength !== request.file.byteLength ||
    receipt.rightsEvidenceId === null ||
    receipt.purpose !== (request.kind === "reference_upload" ? "reference_media" : "brand_asset")
  )
    throw new ApiError("not_found");
  return receipt;
}
function result(
  auth: AuthenticatedContext,
  projectId: string,
  request: LogoInputRequest,
  state: LogoInputRequestState,
): LogoReferenceRegistration | FontRecord | null {
  if (
    state.status === "not_found" ||
    state.ownerId !== logoOwner(auth) ||
    state.projectId !== projectId ||
    state.requestKey !== request.input.requestKey ||
    canonicalIdentityInput(state.request) !== canonicalIdentityInput(request)
  )
    throw new ApiError("integration_unavailable");
  if (state.status === "rejected") throw new ApiError("conflict");
  if (state.status !== "succeeded") return null;
  const value = state.result;
  if (request.kind === "reference_upload") {
    if (
      !("referenceId" in value) ||
      value.sourceKind !== "upload" ||
      canonicalIdentityInput(value.aspects) !== canonicalIdentityInput(request.input.aspects)
    )
      throw new ApiError("integration_unavailable");
  } else if (
    !("rights" in value) ||
    value.source !== (request.kind === "font_catalog" ? "free_catalog" : "user_upload")
  )
    throw new ApiError("integration_unavailable");
  return value;
}
/** Immutable registry finalization is independent of selecting a reference or font. */
export function createLogoInputRegistration(
  dependencies: { assets: IdentityAssetStore; registry: LogoInputRegistry } | null,
) {
  return async (
    auth: AuthenticatedContext,
    projectId: string,
    input: LogoInputRequest,
    originalBytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<LogoReferenceRegistration | FontRecord> => {
    logoOwner(auth);
    projectId = logoId(projectId);
    activeLogoInput(signal);
    const request = parseLogoInput(logoInputRequestSchema, input);
    if (!dependencies) throw new ApiError("integration_unavailable");
    if (!(originalBytes instanceof Uint8Array) || originalBytes.byteLength !== request.file.byteLength)
      throw new ApiError("invalid_input");
    const bytes = Uint8Array.from(originalBytes);
    if (inputHash(bytes) !== request.file.contentHash) throw new ApiError("invalid_input");
    let catalog: CatalogFontBytes | null = null,
      evidence: LogoInputEvidence = null;
    try {
      if (request.kind === "reference_upload") await inspectIdentityRaster(bytes, request.file.mimeType, signal);
      else {
        const inspected = await inspectFontBytes(bytes, request.file.mimeType, signal);
        if (request.kind === "font_catalog") {
          catalog = await readFreeCatalogFont(request.input.catalogFontId);
          if (
            inputHash(bytes) !== catalog.contentHash ||
            inspected.family !== catalog.family ||
            request.file.mimeType !== catalog.mimeType
          )
            throw new ApiError("not_found");
          evidence = {
            family: inspected.family,
            licenseText: catalog.licenseText,
            licenseSourceUrl: catalog.rights.sourceUrl,
          };
        } else
          evidence = {
            family: inspected.family,
            licenseText: request.input.licenseText,
            licenseSourceUrl: request.input.licenseSourceUrl,
          };
      }
    } catch (error) {
      activeLogoInput(signal);
      if (error instanceof ApiError) throw error;
      throw new ApiError("invalid_input");
    }
    activeLogoInput(signal);
    const existing = result(
      auth,
      projectId,
      request,
      await dependencies.registry.prepare(auth, projectId, request, signal),
    );
    if (existing) return existing;
    const intent: IdentityUploadIntent = {
      requestKey: request.input.requestKey,
      usage: request.kind === "reference_upload" ? "logo_reference" : "font",
      mimeType: request.file.mimeType,
      contentHash: request.file.contentHash,
      rightsDeclaration:
        request.kind === "font_catalog"
          ? catalogDeclaration(request.input.catalogFontId, catalog!.rights.licenseTextHash)
          : request.input.rightsDeclaration,
    };
    let receipt: IdentityAssetReceipt;
    try {
      receipt = verifiedReceipt(
        auth,
        projectId,
        request,
        await dependencies.assets.publishOwnedUpload(auth, projectId, intent, bytes, signal),
      );
    } catch (error) {
      if (error instanceof ApiError && error.name !== "IdentityAssetUncertainPublicationError") throw error;
      throw new LogoInputUncertainCommitError(projectId, request.input.requestKey);
    }
    activeLogoInput(signal);
    const registered = result(
      auth,
      projectId,
      request,
      await dependencies.registry.commit(auth, projectId, request, receipt, evidence, signal),
    );
    if (!registered) throw new LogoInputUncertainCommitError(projectId, request.input.requestKey);
    // Independently compare rights returned by the registry to the inspected source.
    if (request.kind !== "reference_upload") {
      const font = fontRecordSchema.parse(registered);
      const rights =
        request.kind === "font_catalog"
          ? { ...catalog!.rights, id: receipt.rightsEvidenceId }
          : describeUploadedFontRights({
              id: receipt.rightsEvidenceId!,
              fontContentHash: request.file.contentHash,
              licenseText: evidence!.licenseText,
              sourceUrl: evidence!.licenseSourceUrl,
            });
      if (
        font.id !== receipt.reference.versionId ||
        canonicalIdentityInput(font.asset) !== canonicalIdentityInput(receipt.reference) ||
        font.family !== evidence!.family ||
        canonicalIdentityInput(font.rights) !== canonicalIdentityInput(rights)
      )
        throw new LogoInputUncertainCommitError(projectId, request.input.requestKey);
    } else if (
      !("referenceId" in registered) ||
      registered.rightsEvidenceId !== receipt.rightsEvidenceId ||
      canonicalIdentityInput(registered.asset) !== canonicalIdentityInput(receipt.reference)
    )
      throw new LogoInputUncertainCommitError(projectId, request.input.requestKey);
    return registered;
  };
}
