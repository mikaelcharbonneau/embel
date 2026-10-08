import "server-only";
import { z } from "zod";
import type { ClaimedJob } from "../../src/domain/jobs";
import { logoExportJobInputSchema } from "../../src/domain/logo-jobs";
import { logoRevisionSchema, logoUuidSchema } from "../../src/domain/logo-vector";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import { readLeasedLogoRecord, type LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { createExportPublicationDependencies, loadLogoExportInputs } from "../../src/features/identity-deliverables/server/persistence";
import type { GuidelinesDependencies } from "../../src/features/identity-deliverables/server/guidelines";
import { assertSupportedExportRuntime, LogoFileError } from "../../src/features/identity-deliverables/server/render-policy";
import { freezeLogoWorkerManifest, type LogoWorkerCapability } from "../logo-readiness";
import { LOGO_EXPORT_HANDLER_VERSION, LOGO_EXPORT_POLICY_IDENTITY, type LogoExportsDependencies } from "../handlers/logo-exports";

export type LogoExportsRuntimeAdapterInput = {
  ownerId: string;
  connection: LogoWorkerConnection | null;
  assets: IdentityAssetStore | null;
  /** Independently check separately authorized export storage/runtime. This
   * callback must not create access, discover credentials or call a provider. */
  assertAvailable: ((job: ClaimedJob) => Promise<void>) | null;
  /** Optional reviewed font capability. Without it, existing catalog/licensing
   * checks remain authoritative and unavailable specimens stay unavailable. */
  guidelines?: GuidelinesDependencies;
};
export type LogoExportsRuntimeAdapter = Readonly<{
  capability: LogoWorkerCapability;
  dependencies: Readonly<LogoExportsDependencies>;
}>;
const jobSchema = z.strictObject({
  id: logoUuidSchema, ownerId: logoUuidSchema, projectId: logoUuidSchema, operation: z.literal("identity.logo_export"),
  input: logoExportJobInputSchema, inputRevision: logoRevisionSchema, leaseToken: logoUuidSchema,
  status: z.enum(["running", "partial"]), reservedCostMicrousd: z.literal(0), actualCostMicrousd: z.literal(0),
});
const unavailable = () => new LogoFileError("unavailable", "The exact owner-bound export runtime is unavailable.");

/** Construction only: no pool, credential, configuration discovery, provider,
 * storage probe, grant or activation. This belongs exclusively in the dedicated
 * logo runtime; a text worker must never receive these injected capabilities. */
export function createLogoExportsRuntimeAdapter(input: LogoExportsRuntimeAdapterInput | null = null): LogoExportsRuntimeAdapter | null {
  if (!input) return null;
  const owner = logoUuidSchema.safeParse(input.ownerId);
  if (!owner.success || typeof input.connection?.query !== "function" || typeof input.assets?.readLeasedAsset !== "function"
    || typeof input.assets?.publishLeasedAsset !== "function" || typeof input.assertAvailable !== "function") return null;
  if (input.guidelines !== undefined && (!input.guidelines || typeof input.guidelines !== "object"
    || input.guidelines.resolveEmbeddedFont !== undefined && typeof input.guidelines.resolveEmbeddedFont !== "function")) return null;
  try { assertSupportedExportRuntime(); } catch { return null; }
  const ownerId = owner.data, assertAvailable = input.assertAvailable;
  const connection: LogoWorkerConnection = { query: input.connection.query.bind(input.connection) };
  const assets: IdentityAssetStore = { ...input.assets, readLeasedAsset: input.assets.readLeasedAsset.bind(input.assets),
    publishLeasedAsset: input.assets.publishLeasedAsset.bind(input.assets) };
  const guidelines: GuidelinesDependencies = Object.freeze(input.guidelines?.resolveEmbeddedFont
    ? { resolveEmbeddedFont: input.guidelines.resolveEmbeddedFont.bind(input.guidelines) } : {});
  const capability = freezeLogoWorkerManifest([{ operation: "identity.logo_export", policyIdentity: LOGO_EXPORT_POLICY_IDENTITY,
    handlerVersion: LOGO_EXPORT_HANDLER_VERSION, provider: null, model: null, engine: null, maxCostMicrousd: 0 }])[0]!;
  function snapshot(raw: ClaimedJob): ClaimedJob {
    const result = jobSchema.safeParse(raw);
    if (!result.success) throw unavailable();
    const job = result.data, frozen = job.input;
    if (job.ownerId !== ownerId || frozen.ownerId !== ownerId || frozen.projectId !== job.projectId
      || frozen.policyIdentity !== LOGO_EXPORT_POLICY_IDENTITY || frozen.handlerVersion !== LOGO_EXPORT_HANDLER_VERSION) throw unavailable();
    return job;
  }
  const publication = createExportPublicationDependencies(connection, assets);
  const dependencies: LogoExportsDependencies = {
    async loadInput(rawJob) {
      // The existing handler contract supplies no signal during this read.
      // Its execute path fences cancellation before rendering/publication; the
      // loader/store still check exact lease and frozen metadata before return.
      return loadLogoExportInputs(connection, assets, snapshot(rawJob));
    },
    async assertReady(rawJob) {
      const job = snapshot(rawJob);
      await assertAvailable(structuredClone(job));
      if (await readLeasedLogoRecord(connection, job, "runtime_readiness") !== true) throw unavailable();
    },
    publication: Object.freeze({
      assets,
      assertCurrentLease: (rawJob: ClaimedJob) => publication.assertCurrentLease(snapshot(rawJob)),
      stage: (rawJob, source, receipts, signal, details) => {
        signal.throwIfAborted();
        // Existing staging rereads frozen approval/variant metadata, checks all
        // member hashes, and retains an uncertain acknowledgement for the handler.
        return publication.stage(snapshot(rawJob), source, receipts, signal, details);
      },
    }),
    guidelines,
  };
  return Object.freeze({ capability, dependencies: Object.freeze(dependencies) });
}
