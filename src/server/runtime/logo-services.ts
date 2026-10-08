import "server-only";
import type { IdentityConnectionFactory } from "@/server/data/identity-transaction";
import { createIdentityAssetStore, createPostgresIdentityAssetBackend, type IdentityAssetStorage, type IdentityAssetStoreDependencies } from "@/server/data/identity-asset-store";
import { createLogoTransactionService } from "@/server/data/logo-transaction";
import { validateLogoExportAssetBytes } from "@/features/identity-deliverables/server/validate-assets";
import { validateLogoInputBytes } from "@/features/logo-inputs/server/registration";
import { ApiError } from "@/server/http/errors";
import { createLogoInputService } from "@/server/data/logo-inputs";
import { createLogoWorkspaceService } from "@/server/data/logo-workspace";
import { createLogoVectorMutationProducers } from "@/features/logo-vector/server/mutations";
import { verifyLogoVectorRevision } from "@/features/logo-vector/server/revisions";
import { prepareDirectionEvidence } from "@/features/identity-directions/server/evidence-producer";
import { createLogoDeliverablesService } from "@/features/identity-deliverables/server/persistence";
import { createLogoDeliverableProducers } from "@/features/identity-deliverables/server/manual";
import { createFontResolver } from "@/features/identity-directions/server/fonts";
import { logoBriefRevisionSchema } from "@/domain/logo-workspace";

export type LogoServiceDependencies = {
  connections: IdentityConnectionFactory;
  storage: IdentityAssetStorage;
  worker?: Parameters<typeof createPostgresIdentityAssetBackend>[0]["worker"];
  validateBytes?: IdentityAssetStoreDependencies["validateBytes"];
};
/** One explicit server composition boundary. It does not read environment values,
 * create credentials, configure policies, connect pools, or report live readiness.
 * The caller must separately qualify private storage and the restricted login. */
export function createLogoServices(dependencies: LogoServiceDependencies | null) {
  const assets = createIdentityAssetStore(dependencies ? {
    backend: createPostgresIdentityAssetBackend({ owned: dependencies.connections, worker: dependencies.worker ?? null }),
    storage: dependencies.storage,
    validateBytes: async (write, bytes, signal) => {
      const mime = write.kind === "upload" ? write.intent.mimeType : write.publication.mimeType;
      // Built-in formats were already inspected by the immutable asset store.
      if (mime === "font/ttf" || mime === "font/otf") await validateLogoInputBytes(write, bytes, signal);
      else if (mime === "application/pdf" || mime === "application/zip") await validateLogoExportAssetBytes(write, bytes, signal);
      else if (!["image/png", "image/jpeg", "image/webp", "image/svg+xml", "application/json"].includes(mime)) throw new ApiError("integration_unavailable");
      // Optional qualification may further restrict, never replace validation.
      if (dependencies.validateBytes) await dependencies.validateBytes(structuredClone(write), new Uint8Array(bytes), signal);
    },
  } : null);
  const readWorkspace = createLogoWorkspaceService({ assetStore: assets, verifyVectorRevision: verifyLogoVectorRevision });
  const inputs = createLogoInputService(dependencies ? { assets, connections: dependencies.connections } : null);
  const deliverables = createLogoDeliverablesService({ assets });
  const vectorProducers = createLogoVectorMutationProducers({
    assetStore: assets,
    readVectorDetail: readWorkspace.readLogoVectorDetail,
    getWorkspace: readWorkspace.getLogoWorkspace,
    readCurrentVectorRevisionId: readWorkspace.readLogoCurrentVectorRevisionId,
    readStageRevision: readWorkspace.getLogoStageRevision,
    ...(dependencies ? { textEdits: {
      readBriefRevision: async (auth, projectId, revisionId, signal) => logoBriefRevisionSchema.parse(
        await readWorkspace.getLogoStageRevision(auth, projectId, "brief_references", revisionId, signal),
      ),
      readConceptBatch: readWorkspace.readLogoConceptBatch,
      readRasterRefinement: readWorkspace.readLogoRasterRefinement,
      listFonts: inputs.listLogoFonts,
      resolveFont: createFontResolver({ loadRecord: readWorkspace.readLogoFontRecord, store: assets }),
    } } : {}),
  });
  const transactions = createLogoTransactionService(dependencies?.connections ?? null, {
    ...vectorProducers,
    selectIdentityDirectionComponents: prepareDirectionEvidence,
    approveIdentityDirection: prepareDirectionEvidence,
    ...createLogoDeliverableProducers({ assets, service: deliverables }),
  });
  const workspace = createLogoWorkspaceService({ assetStore: assets, transactions, verifyVectorRevision: verifyLogoVectorRevision });
  return { configured: dependencies !== null, assets, workspace, transactions, deliverables, inputs };
}
