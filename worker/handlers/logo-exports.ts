import type { ClaimedJob, StepOutcome } from "../../src/domain/jobs";
import { logoExportJobInputSchema } from "../../src/domain/logo-jobs";
import type { ApprovedDeliverableSnapshot } from "../../src/domain/logo-deliverables";
import type { JobHandler } from "../runner";
import { buildLogoExport, LogoExportPreparationError } from "../../src/features/identity-deliverables/server/package";
import { assertExportJobSnapshot, publishPreparedLogoExport, publishPartialLogoExport, type ExportPublicationDependencies } from "../../src/features/identity-deliverables/server/publish";
import { assertSupportedExportRuntime, LOGO_RENDER_POLICY, LOGO_ENGINE_VERSIONS, sha256 } from "../../src/features/identity-deliverables/server/render-policy";
import { canonicalIdentityInput } from "../../src/features/identity-directions/model/font-check-binding";
import type { GuidelinesDependencies } from "../../src/features/identity-deliverables/server/guidelines";

export const LOGO_EXPORT_HANDLER_VERSION = "logo-export-v1";
/** Persist this exact identity at separately authorized runtime configuration. */
export const LOGO_EXPORT_POLICY_IDENTITY = sha256(canonicalIdentityInput({ handlerVersion: LOGO_EXPORT_HANDLER_VERSION, renderPolicy: LOGO_RENDER_POLICY, engineVersions: LOGO_ENGINE_VERSIONS }));
export type LogoExportsDependencies = {
  loadInput(job: ClaimedJob): Promise<ApprovedDeliverableSnapshot>;
  assertReady(job: ClaimedJob): Promise<void>;
  publication: ExportPublicationDependencies;
  guidelines?: GuidelinesDependencies;
};
export function createLogoExportsHandler(dependencies: LogoExportsDependencies): JobHandler {
  assertSupportedExportRuntime();
  return { steps(job) {
    const input = logoExportJobInputSchema.parse(job.input);
    if (input.operation !== job.operation || input.ownerId !== job.ownerId || input.projectId !== job.projectId || input.handlerVersion !== LOGO_EXPORT_HANDLER_VERSION || input.policyIdentity !== LOGO_EXPORT_POLICY_IDENTITY) throw new Error("Unsupported export handler policy");
    return [{ key: "prepare-export", maximumCostMicrousd: 0, timeoutMs: 900_000,
      async execute({ job, signal }): Promise<StepOutcome> {
        let publicationStarted = false;
        try {
          signal.throwIfAborted();
          const snapshot = assertExportJobSnapshot(job, await dependencies.loadInput(job));
          await dependencies.assertReady(job); signal.throwIfAborted();
          let prepared;
          try { prepared = await buildLogoExport(snapshot, signal, dependencies.guidelines); }
          catch (error) {
            if (!(error instanceof LogoExportPreparationError) || !error.files.length || signal.aborted) throw error;
            publicationStarted = true;
            const receipt = await publishPartialLogoExport(job, snapshot, error, dependencies.publication, signal);
            return { status: "failed", code: `export_${error.code}`, result: { version: 2, kind: "logo_export_partial", publicationId: receipt.id }, costMicrousd: 0, providerRequestId: null };
          }
          signal.throwIfAborted(); publicationStarted = true;
          const receipt = await publishPreparedLogoExport(job, snapshot, prepared, dependencies.publication, signal);
          return { status: "succeeded", result: { version: 2, kind: "logo_export", publicationId: receipt.id }, costMicrousd: 0, providerRequestId: null };
        } catch {
          return publicationStarted
            ? { status: "needs_reconciliation", code: "export_publication_unknown", costMicrousd: 0, providerRequestId: null }
            : { status: "failed", code: signal.aborted ? "export_cancelled" : "export_unavailable_or_invalid", costMicrousd: 0, providerRequestId: null };
        }
      },
    }];
  } };
}
