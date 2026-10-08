import "server-only";
import { z } from "zod";
import type { ClaimedJob } from "../../src/domain/jobs";
import { logoVectorizeJobInputSchema } from "../../src/domain/logo-jobs";
import { logoHashSchema, logoRevisionSchema, logoUuidSchema } from "../../src/domain/logo-vector";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import { loadLogoVectorInput, readLeasedLogoRecord, type LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { LogoVectorError } from "../../src/features/logo-vector/model/errors";
import { assertLogoConversionNotAborted, verifyLogoRasterSource } from "../../src/features/logo-vector/server/converter";
import { publishLogoVectorResult } from "../../src/features/logo-vector/server/publication";
import { freezeLogoWorkerManifest, type LogoWorkerCapability } from "../logo-readiness";
import { LOGO_VECTOR_HANDLER_VERSION, type LogoVectorHandlerDependencies } from "./handler";
import { QUALIFIED_VTRACER } from "./engine";

export type LogoVectorRuntimeAdapterInput = {
  ownerId: string;
  policyIdentity: string;
  connection: LogoWorkerConnection | null;
  assets: IdentityAssetStore | null;
  /** Independently verify the injected, separately authorized storage/runtime.
   * This must not provision access, discover credentials or call a provider. */
  assertAvailable: ((job: ClaimedJob) => Promise<void>) | null;
};
export type LogoVectorRuntimeAdapter = Readonly<{
  capability: LogoWorkerCapability;
  dependencies: Readonly<LogoVectorHandlerDependencies>;
}>;
const configurationSchema = z.strictObject({ ownerId: logoUuidSchema, policyIdentity: logoHashSchema });
const jobSchema = z.strictObject({
  id: logoUuidSchema, ownerId: logoUuidSchema, projectId: logoUuidSchema, operation: z.literal("identity.logo_vectorize"),
  input: logoVectorizeJobInputSchema, inputRevision: logoRevisionSchema, leaseToken: logoUuidSchema,
  status: z.enum(["running", "partial"]), reservedCostMicrousd: z.literal(0), actualCostMicrousd: z.literal(0),
});
const unavailable = () => new LogoVectorError("engine_unavailable", "The exact owner-bound vector runtime is unavailable.");

/** Pure construction only. No default store, environment lookup, pool, probe,
 * credential, timer, provider or SQL grant. A descriptor is not proof of live
 * access. The parent must explicitly inject this into the separate logo runtime;
 * the text worker must never receive the connection or asset capabilities.
 */
export function createLogoVectorRuntimeAdapter(input: LogoVectorRuntimeAdapterInput | null = null): LogoVectorRuntimeAdapter | null {
  if (!input) return null;
  const configuration = configurationSchema.safeParse({ ownerId: input.ownerId, policyIdentity: input.policyIdentity });
  if (!configuration.success || typeof input.connection?.query !== "function" || typeof input.assets?.readLeasedAsset !== "function"
    || typeof input.assets?.publishLeasedAsset !== "function" || typeof input.assertAvailable !== "function") return null;
  const { ownerId, policyIdentity } = configuration.data;
  const connection: LogoWorkerConnection = { query: input.connection.query.bind(input.connection) };
  const assets: IdentityAssetStore = { ...input.assets, readLeasedAsset: input.assets.readLeasedAsset.bind(input.assets),
    publishLeasedAsset: input.assets.publishLeasedAsset.bind(input.assets) };
  const assertAvailable = input.assertAvailable;
  const capability = freezeLogoWorkerManifest([{ operation: "identity.logo_vectorize", policyIdentity,
    handlerVersion: LOGO_VECTOR_HANDLER_VERSION, provider: null, model: null, maxCostMicrousd: 0,
    engine: { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm } }])[0]!;
  function snapshot(raw: ClaimedJob): ClaimedJob {
    const result = jobSchema.safeParse(raw);
    if (!result.success) throw unavailable();
    const job = result.data, frozen = job.input;
    if (job.ownerId !== ownerId || frozen.ownerId !== ownerId || frozen.projectId !== job.projectId
      || frozen.policyIdentity !== policyIdentity || frozen.handlerVersion !== capability.handlerVersion
      || frozen.engine.id !== capability.engine!.id || frozen.engine.version !== capability.engine!.version
      || frozen.engine.artifactHash !== capability.engine!.artifactHash) throw unavailable();
    return job;
  }
  const dependencies: LogoVectorHandlerDependencies = {
    async assertReady(rawJob) {
      const job = snapshot(rawJob);
      await assertAvailable(structuredClone(job));
      // SQL validates the exact current session_user/OID, owner, job, lease and
      // persisted policy/readiness. Only a boolean acknowledgement is accepted.
      if (await readLeasedLogoRecord(connection, job, "runtime_readiness") !== true) throw unavailable();
    },
    async loadInput(rawJob, signal) {
      assertLogoConversionNotAborted(signal);
      const job = snapshot(rawJob);
      const loaded = await loadLogoVectorInput(connection, assets, job, signal);
      assertLogoConversionNotAborted(signal);
      const source = { ...loaded.source, reference: { ...loaded.source.reference }, verification: { ...loaded.source.verification },
        bytes: Uint8Array.from(loaded.source.bytes) };
      verifyLogoRasterSource(source);
      return { ...loaded, source };
    },
    async publish(rawJob, result, signal) {
      assertLogoConversionNotAborted(signal);
      const job = snapshot(rawJob);
      // Reloads the exact source, verifies canonical paths and hashes, stages
      // both immutable members, then binds the group under this lease. Only the
      // runner's completeStep may create review_required; this never accepts it.
      // Do not retry or convert an uncertain acknowledgement into failure here.
      return publishLogoVectorResult(connection, assets, job, result, signal);
    },
  };
  return Object.freeze({ capability, dependencies: Object.freeze(dependencies) });
}
