import "server-only";
import type { ClaimedJob } from "../src/domain/jobs";
import { logoUuidSchema } from "../src/domain/logo-vector";
import { identityAssetPublicationSchema } from "../src/domain/logo-deliverables";
import { createIdentityAssetStore, createPostgresIdentityAssetBackend, type IdentityAssetReservation, type IdentityAssetStore } from "../src/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "../src/server/data/logo-jobs";
import { validateLogoExportAssetBytes } from "../src/features/identity-deliverables/server/validate-assets";
import { validateLogoVectorDocument } from "../src/features/logo-vector/model/geometry";
import { canonicalLogoDocumentBytes } from "../src/features/logo-vector/model/canonical";
import { qualifiedLogoProductionStorageCapability, type LogoProductionStorageAuthorization, type LogoProductionStorageRead, type LogoProductionStorageWrite } from "./logo-production-storage-authorization";
const unavailable = () => new Error("Logo production assets are unavailable.");
/** Every call owns its metadata and exact object capability. No mutable cross-job
 * path registry, default storage, owner/browser API, or unrestricted transport.
 * Construction performs no I/O, provisioning, credential lookup or activation. */
export function createLogoProductionAssetStore(input: { connection: LogoWorkerConnection | null; authorization: LogoProductionStorageAuthorization | null } | null = null): IdentityAssetStore | null {
  if (!input || typeof input.connection?.query !== "function" || !input.authorization
    || typeof input.authorization.authorizeRead !== "function" || typeof input.authorization.authorizeWrite !== "function" || typeof input.authorization.authorizeReadback !== "function"
    || typeof input.authorization.assertAvailable !== "function") return null;
  const capability = qualifiedLogoProductionStorageCapability(input.authorization.capability), owner = logoUuidSchema.safeParse(input.authorization.ownerId);
  if (!capability || !owner.success) return null;
  const authorization = { ownerId: owner.data, capability, assertAvailable: input.authorization.assertAvailable.bind(input.authorization),
    authorizeRead: input.authorization.authorizeRead.bind(input.authorization), authorizeReadback: input.authorization.authorizeReadback.bind(input.authorization), authorizeWrite: input.authorization.authorizeWrite.bind(input.authorization) };
  const connection: LogoWorkerConnection = { query: input.connection.query.bind(input.connection) };
  const backend = createPostgresIdentityAssetBackend({ owned: null, worker: connection });
  const denied = async (): Promise<never> => { throw unavailable(); };
  function snapshot(raw: ClaimedJob) {
    const job = structuredClone(raw);
    if (job.operation !== authorization.capability.operation || job.ownerId !== authorization.ownerId || job.status !== "running"
      || job.reservedCostMicrousd !== 0 || job.actualCostMicrousd !== 0) throw unavailable();
    return job;
  }
  return Object.freeze({ stageOwnedAsset: denied, publishOwnedUpload: denied, readOwnedAsset: denied,
    async publishLeasedAsset(raw, publication, bytes, signal) {
      const job = snapshot(raw), p = identityAssetPublicationSchema.parse(publication);
      if (p.source.kind !== (job.operation === "identity.logo_vectorize" ? "vector" : "export") || p.source.sourceId !== job.id
        || !(job.operation === "identity.logo_vectorize" ? ["application/json", "image/svg+xml"] : ["image/png", "image/svg+xml", "application/pdf", "application/zip"]).includes(p.mimeType)) throw unavailable();
      let row: IdentityAssetReservation | undefined, object: LogoProductionStorageWrite | undefined;
      const exact = async (path: string, current?: AbortSignal) => {
        if (!row || row.storagePath !== path || signal?.aborted || current?.aborted) throw unavailable();
        return object ??= await authorization.authorizeWrite({ job, reservation: row, publication: p }, signal);
      };
      const store = createIdentityAssetStore({ backend: { ...backend, async prepare(access, write, current) {
        await authorization.assertAvailable(job); return row = await backend.prepare(access, write, current);
      } }, storage: {
        async putIfAbsent(path, value, mimeType, current) { await (await exact(path, current)).putIfAbsent(value, mimeType, current); },
        async read(path, current) { return (await exact(path, current)).read(current); },
      }, async validateBytes(write, value, current) {
        const mime = write.kind === "stage" ? write.publication.mimeType : "";
        if (mime === "application/pdf" || mime === "application/zip") await validateLogoExportAssetBytes(write, value, current);
        else if (mime === "application/json") {
          const document = validateLogoVectorDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)));
          if (!Buffer.from(canonicalLogoDocumentBytes(document)).equals(Buffer.from(value))) throw unavailable();
        }
      } });
      return store.publishLeasedAsset(job, p, bytes, signal);
    },
    async readLeasedAsset(raw, reference, signal) {
      const job = snapshot(raw); let row: IdentityAssetReservation | undefined, object: LogoProductionStorageRead | undefined;
      const store = createIdentityAssetStore({ backend: { ...backend, async resolve(access, ref, current) {
        await authorization.assertAvailable(job); return row = await backend.resolve(access, ref, current);
      } }, storage: { putIfAbsent: denied, async read(path, current) {
        if (!row || row.storagePath !== path || signal?.aborted || current?.aborted) throw unavailable();
        object ??= row.publicationState === "staged"
          ? await authorization.authorizeReadback({ job, reservation: row }, signal)
          : await authorization.authorizeRead({ job, reservation: row }, signal);
        return object.read(current);
      } } });
      return store.readLeasedAsset(job, reference, signal);
    },
  } satisfies IdentityAssetStore);
}
