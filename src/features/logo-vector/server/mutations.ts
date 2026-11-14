import "server-only";
import { isDeepStrictEqual } from "node:util";
import {
  logoVectorDetailSchema,
  type LogoVectorDetail,
  type VerifiedAssetBytes,
} from "../../../domain/logo-deliverables";
import {
  logoManualCommandSchema,
  logoWorkspaceV2Schema,
  logoStageRevisionSchema,
  type LogoWorkspaceV2,
  type LogoStageRevision,
  type LogoStage,
  type LogoExpectedHeads,
} from "../../../domain/logo-workspace";
import type { AuthenticatedContext } from "../../../server/auth/context";
import type { IdentityAssetStore } from "../../../server/data/identity-asset-store";
import { logoOwner, logoId, type LogoMutationProducers } from "../../../server/data/logo-transaction";
import { ApiError } from "../../../server/http/errors";
import { LogoVectorError } from "../model/errors";
import { assertLogoComponentLocks } from "../model/locks";
import { assertLogoConversionNotAborted } from "./converter";
import { canonicalLogoDocumentBytes, verifyLogoVectorRevision } from "./revisions";

type LogoVectorMutationDependencies = {
  assetStore: IdentityAssetStore;
  readVectorDetail(
    auth: AuthenticatedContext,
    projectId: string,
    vectorRevisionId: string,
    signal?: AbortSignal,
  ): Promise<LogoVectorDetail>;
  getWorkspace(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal): Promise<LogoWorkspaceV2>;
  readCurrentVectorRevisionId(
    auth: AuthenticatedContext,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<string | null>;
  readStageRevision(
    auth: AuthenticatedContext,
    projectId: string,
    stage: LogoStage,
    revisionId: string,
    signal?: AbortSignal,
  ): Promise<LogoStageRevision>;
};
const mismatch = (): never => {
  throw new LogoVectorError("source_mismatch", "The saved vector and its exact source files could not be verified.");
};
const snapshot = (file: VerifiedAssetBytes): VerifiedAssetBytes => ({
  ...file,
  reference: { ...file.reference },
  verification: { ...file.verification },
  bytes: Uint8Array.from(file.bytes),
});

/** Authoritative producer for the existing P1 CAS transaction. All file I/O and
 * geometry work happen before BEGIN; no browser proof, AI dispatch or approval
 * can enter the evidence. Restoring vector or refinement stages depends on it. */
export function createLogoVectorMutationProducers(deps: LogoVectorMutationDependencies): LogoMutationProducers {
  async function stage(
    auth: AuthenticatedContext,
    projectId: string,
    kind: LogoStage,
    id: string,
    signal: AbortSignal,
  ) {
    const record = logoStageRevisionSchema.parse(await deps.readStageRevision(auth, projectId, kind, id, signal));
    assertLogoConversionNotAborted(signal);
    if (
      record.id !== id ||
      record.stage !== kind ||
      record.ownerId !== logoOwner(auth) ||
      record.projectId !== projectId
    )
      return mismatch();
    return record;
  }
  async function load(auth: AuthenticatedContext, projectId: string, id: string, signal: AbortSignal) {
    const detail = logoVectorDetailSchema.parse(await deps.readVectorDetail(auth, projectId, id, signal));
    assertLogoConversionNotAborted(signal);
    const revision = detail.revision;
    if (revision.id !== id || revision.ownerId !== logoOwner(auth) || revision.projectId !== logoId(projectId))
      return mismatch();
    const documentFile = snapshot(await deps.assetStore.readOwnedAsset(auth, revision.documentAsset, signal));
    assertLogoConversionNotAborted(signal);
    const svgFile = snapshot(await deps.assetStore.readOwnedAsset(auth, revision.svgAsset, signal));
    assertLogoConversionNotAborted(signal);
    const document = await verifyLogoVectorRevision({ revision, document: documentFile, svg: svgFile }, signal);
    if (
      !Buffer.from(canonicalLogoDocumentBytes(document)).equals(
        Buffer.from(canonicalLogoDocumentBytes(detail.document)),
      )
    )
      return mismatch();
    return { revision, document };
  }
  async function current(
    auth: AuthenticatedContext,
    projectId: string,
    expected: LogoExpectedHeads,
    signal: AbortSignal,
  ) {
    const workspace = logoWorkspaceV2Schema.parse(await deps.getWorkspace(auth, projectId, signal));
    assertLogoConversionNotAborted(signal);
    if (workspace.ownerId !== logoOwner(auth) || workspace.projectId !== projectId) return mismatch();
    if (!isDeepStrictEqual(workspace.heads, expected)) throw new ApiError("conflict");
    const id = await deps.readCurrentVectorRevisionId(auth, projectId, signal);
    assertLogoConversionNotAborted(signal);
    return id ? load(auth, projectId, logoId(id), signal) : null;
  }
  function selectionLocks(base: Awaited<ReturnType<typeof current>>, target: Awaited<ReturnType<typeof load>> | null) {
    if (!base) return;
    if (!target) {
      if (base.revision.locks.length)
        throw new LogoVectorError(
          "locked_component_changed",
          "Restore would remove a locked vector. Save an explicit unlock first.",
        );
      return;
    }
    assertLogoComponentLocks(base.document, target.document, base.revision.locks);
    if (base.revision.locks.some((lock) => !target.revision.locks.some((saved) => isDeepStrictEqual(lock, saved)))) {
      throw new LogoVectorError(
        "locked_component_changed",
        "Selecting this candidate would remove a saved lock. Save an explicit unlock first.",
      );
    }
  }
  return {
    async acceptLogoVector(auth, projectId, rawCommand, optionalSignal) {
      const signal = optionalSignal ?? new AbortController().signal,
        command = logoManualCommandSchema.parse(rawCommand);
      assertLogoConversionNotAborted(signal);
      if (command.method !== "acceptLogoVector") return mismatch();
      const base = await current(auth, projectId, command.body.expected, signal);
      const target = await load(auth, projectId, command.body.vectorRevisionId, signal);
      selectionLocks(base, target);
      assertLogoConversionNotAborted(signal);
      return {
        vectorRevisionId: target.revision.id,
        currentVectorRevisionId: base?.revision.id ?? null,
        expected: command.body.expected,
      };
    },
    async restoreLogoStage(auth, projectId, rawCommand, optionalSignal) {
      const signal = optionalSignal ?? new AbortController().signal,
        command = logoManualCommandSchema.parse(rawCommand);
      assertLogoConversionNotAborted(signal);
      if (command.method !== "restoreLogoStage" || !["vector", "refinements"].includes(command.body.stage))
        return mismatch();
      const base = await current(auth, projectId, command.body.expected, signal);
      const targetStage = await stage(auth, projectId, command.body.stage, command.body.revisionId, signal);
      const targetId = "vectorRevisionId" in targetStage.payload ? targetStage.payload.vectorRevisionId : null;
      const target = targetId ? await load(auth, projectId, targetId, signal) : null;
      selectionLocks(base, target);
      assertLogoConversionNotAborted(signal);
      return {
        targetStageRevisionId: targetStage.id,
        currentVectorRevisionId: base?.revision.id ?? null,
        targetVectorRevisionId: targetId,
        expected: command.body.expected,
      };
    },
  };
}
