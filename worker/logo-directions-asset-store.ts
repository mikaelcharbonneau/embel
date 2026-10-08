import "server-only";
import { isDeepStrictEqual } from "node:util";
import type { ClaimedJob } from "../src/domain/jobs";
import { logoUuidSchema } from "../src/domain/logo-vector";
import { logoDirectionsJobInputSchema } from "../src/domain/logo-jobs";
import { createIdentityAssetStore, createPostgresIdentityAssetBackend, type IdentityAssetReservation, type IdentityAssetStore } from "../src/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "../src/server/data/logo-jobs";
import { qualifiedLogoDirectionsStorageCapability, type LogoDirectionsStorageAuthorization, type LogoDirectionsStorageRead } from "./logo-directions-storage-authorization";
const unavailable = () => new Error("Logo directions assets are unavailable.");
/** One resolved immutable reservation and GET-only object capability per call.
 * No shared path registry, default storage, owner capability or writes. */
export function createLogoDirectionsAssetStore(input: { connection: LogoWorkerConnection | null; authorization: LogoDirectionsStorageAuthorization | null } | null = null): IdentityAssetStore | null {
  if (!input || typeof input.connection?.query !== "function" || typeof input.authorization?.authorizeRead !== "function" || typeof input.authorization?.assertAvailable !== "function") return null;
  const capability = qualifiedLogoDirectionsStorageCapability(input.authorization.capability), owner = logoUuidSchema.safeParse(input.authorization.ownerId);
  if (!capability || !owner.success) return null;
  const authorization = { ownerId: owner.data, capability, assertAvailable: input.authorization.assertAvailable.bind(input.authorization), authorizeRead: input.authorization.authorizeRead.bind(input.authorization) };
  const connection: LogoWorkerConnection = { query: input.connection.query.bind(input.connection) }, backend = createPostgresIdentityAssetBackend({ owned: null, worker: connection });
  const denied = async (): Promise<never> => { throw unavailable(); };
  function snapshot(raw: ClaimedJob) {
    const job = structuredClone(raw), frozen = logoDirectionsJobInputSchema.parse(job.input);
    logoUuidSchema.parse(job.id); logoUuidSchema.parse(job.leaseToken);
    if (job.operation !== capability!.operation || job.ownerId !== owner.data || job.status !== "running" || !Number.isSafeInteger(job.inputRevision) || job.inputRevision < 1
      || job.reservedCostMicrousd !== 0 || job.actualCostMicrousd !== 0 || frozen.ownerId !== job.ownerId || frozen.projectId !== job.projectId || frozen.fontVersionIds.length === 0
      || frozen.policyIdentity !== capability!.policyIdentity || frozen.handlerVersion !== capability!.handlerVersion || frozen.billingMode !== "chatgpt_subscription" || !isDeepStrictEqual(frozen.policy, capability!.policy)) throw unavailable();
    job.input = frozen; return job;
  }
  return Object.freeze({ stageOwnedAsset: denied, publishOwnedUpload: denied, readOwnedAsset: denied,
    // The shared runtime checks this method exists; it grants no write authority.
    publishLeasedAsset: denied,
    async readLeasedAsset(raw, reference, signal) {
      const job = snapshot(raw); let row: IdentityAssetReservation | undefined, object: LogoDirectionsStorageRead | undefined;
      const store = createIdentityAssetStore({ backend: { ...backend, async resolve(access, ref, current) {
        await authorization.assertAvailable(structuredClone(job));
        const resolved = await backend.resolve(access, ref, current);
        if (resolved.publicationState !== "committed" || resolved.purpose !== "brand_asset" || !["application/json", "font/ttf", "font/otf"].includes(resolved.mimeType)
          || row && !isDeepStrictEqual(row, resolved)) throw unavailable();
        row ??= structuredClone(resolved); return resolved;
      } }, storage: { putIfAbsent: denied, async read(path, current) {
        if (!row || row.storagePath !== path || signal?.aborted || current?.aborted) throw unavailable();
        object ??= await authorization.authorizeRead({ job: structuredClone(job), reservation: structuredClone(row) }, signal);
        return object.read(current);
      } } });
      return store.readLeasedAsset(job, reference, signal);
    },
  } satisfies IdentityAssetStore);
}
