import "server-only";
import { isDeepStrictEqual } from "node:util";
import { moneySchema, type ClaimedJob } from "../src/domain/jobs";
import { logoUuidSchema } from "../src/domain/logo-vector";
import { logoConceptJobInputSchema, logoRefinementJobInputSchema } from "../src/domain/logo-jobs";
import { identityAssetPublicationSchema } from "../src/domain/logo-deliverables";
import { createIdentityAssetStore, createPostgresIdentityAssetBackend, type IdentityAssetReservation, type IdentityAssetStore } from "../src/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "../src/server/data/logo-jobs";
import { IMAGE_INPUT_LIMITS } from "../src/server/logo-creation/openai-image-transport";
import { qualifiedLogoGenerativeStorageCapability, type LogoGenerativeStorageAuthorization, type LogoGenerativeStorageRead, type LogoGenerativeStorageWrite } from "./logo-generative-storage-authorization";
const unavailable = () => new Error("Logo generative assets are unavailable.");
/** Per-call composition only: metadata and exact-object capabilities never live
 * in a shared mutable registry. Source reads must already be committed; staged
 * output readback is available only inside its own immutable publication call.
 * No construction I/O, owner/browser API, credential lookup or activation.
 */
export function createLogoGenerativeAssetStore(input: { connection: LogoWorkerConnection | null; authorization: LogoGenerativeStorageAuthorization | null } | null = null): IdentityAssetStore | null {
  if (!input || typeof input.connection?.query !== "function" || !input.authorization
    || typeof input.authorization.authorizeRead !== "function" || typeof input.authorization.authorizeWrite !== "function"
    || typeof input.authorization.assertAvailable !== "function") return null;
  const capability = qualifiedLogoGenerativeStorageCapability(input.authorization.capability), owner = logoUuidSchema.safeParse(input.authorization.ownerId);
  if (!capability || !owner.success) return null;
  const authorization = { ownerId: owner.data, capability, assertAvailable: input.authorization.assertAvailable.bind(input.authorization),
    authorizeRead: input.authorization.authorizeRead.bind(input.authorization), authorizeWrite: input.authorization.authorizeWrite.bind(input.authorization) };
  const connection: LogoWorkerConnection = { query: input.connection.query.bind(input.connection) };
  const backend = createPostgresIdentityAssetBackend({ owned: null, worker: connection });
  const denied = async (): Promise<never> => { throw unavailable(); };
  function snapshot(raw: ClaimedJob) {
    const job = structuredClone(raw);
    if (job.operation !== authorization.capability.operation || job.ownerId !== authorization.ownerId || job.status !== "running"
      || !logoUuidSchema.safeParse(job.id).success || !logoUuidSchema.safeParse(job.leaseToken).success
      || !Number.isSafeInteger(job.inputRevision) || job.inputRevision < 1
      || !moneySchema.safeParse(job.reservedCostMicrousd).success || !moneySchema.safeParse(job.actualCostMicrousd).success
      || job.reservedCostMicrousd > authorization.capability.maxCostMicrousd || job.actualCostMicrousd > job.reservedCostMicrousd) throw unavailable();
    const frozen = job.operation === "identity.logo_concept" ? logoConceptJobInputSchema.parse(job.input) : logoRefinementJobInputSchema.parse(job.input);
    if (frozen.ownerId !== job.ownerId || frozen.projectId !== job.projectId || frozen.policyIdentity !== capability!.policyIdentity || frozen.handlerVersion !== capability!.handlerVersion
      || frozen.operation === "identity.logo_refine" && frozen.source.kind !== "preview") throw unavailable();
    job.input = frozen;
    return { job, sourceId: frozen.operation === "identity.logo_concept" ? frozen.attemptId : frozen.rasterRevisionId };
  }
  return Object.freeze({ stageOwnedAsset: denied, publishOwnedUpload: denied, readOwnedAsset: denied,
    async publishLeasedAsset(raw, publication, bytes, signal) {
      const { job, sourceId } = snapshot(raw), p = identityAssetPublicationSchema.parse(publication);
      if (p.source.kind !== "concept" || p.source.sourceId !== sourceId || p.requestKey !== sourceId || p.mimeType !== "image/png" || p.byteLength > IMAGE_INPUT_LIMITS.outputBytes) throw unavailable();
      let row: IdentityAssetReservation | undefined, object: LogoGenerativeStorageWrite | undefined;
      const exact = async (path: string, current?: AbortSignal) => {
        if (!row || row.storagePath !== path || signal?.aborted || current?.aborted) throw unavailable();
        return object ??= await authorization.authorizeWrite({ job, reservation: row, publication: p }, signal);
      };
      const store = createIdentityAssetStore({ backend: { ...backend, async prepare(access, write, current) {
        if (signal?.aborted || current?.aborted) throw unavailable();
        await authorization.assertAvailable(job);
        return row = await backend.prepare(access, write, current);
      } }, storage: {
        async putIfAbsent(path, value, mimeType, current) { await (await exact(path, current)).putIfAbsent(value, mimeType, current); },
        async read(path, current) { return (await exact(path, current)).read(current); },
      } });
      return store.publishLeasedAsset(job, p, bytes, signal);
    },
    async readLeasedAsset(raw, reference, signal) {
      const { job } = snapshot(raw); let row: IdentityAssetReservation | undefined, object: LogoGenerativeStorageRead | undefined;
      const store = createIdentityAssetStore({ backend: { ...backend, async resolve(access, ref, current) {
        if (signal?.aborted || current?.aborted) throw unavailable();
        await authorization.assertAvailable(job);
        const resolved = await backend.resolve(access, ref, current);
        if (resolved.publicationState !== "committed" || row && !isDeepStrictEqual(resolved, row)) throw unavailable();
        // Retain a private snapshot so mutable injected ports cannot change the
        // authority compared after I/O, including purpose/source/rights fields.
        row ??= structuredClone(resolved);
        return resolved;
      } }, storage: { putIfAbsent: denied, async read(path, current) {
        if (!row || row.storagePath !== path || signal?.aborted || current?.aborted) throw unavailable();
        object ??= await authorization.authorizeRead({ job, reservation: row }, signal);
        return object.read(current);
      } } });
      return store.readLeasedAsset(job, reference, signal);
    },
  } satisfies IdentityAssetStore);
}
