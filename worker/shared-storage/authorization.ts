import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, MIMEType } from "node:util";
import { decodeJwt } from "jose";
import { z } from "zod";
import { sharedExecutionSchema, sharedSlotLeaseSchema, type SharedExecution, type SharedSlotLease } from "../shared-pool/contracts";
import { qualifiedLogoGenerativeStorageCapability, type LogoGenerativeStorageAuthorization, type LogoGenerativeStorageScope,
  type LogoGenerativeStorageRead, type LogoGenerativeStorageWrite } from "../logo-generative-storage-authorization";
import { type LogoWorkerCapability } from "../logo-readiness";
import { logoConceptJobInputSchema, logoRefinementJobInputSchema } from "../../src/domain/logo-jobs";
import { identityAssetPublicationSchema, type IdentityAssetPublication } from "../../src/domain/logo-deliverables";
import { logoAssetReferenceSchema } from "../../src/domain/logo-vector";
import { inspectIdentityRaster } from "../../src/features/logo-vector/server/converter";
import { jobStatusSchema, type ClaimedJob } from "../../src/domain/jobs";
import type { IdentityAssetReservation } from "../../src/server/data/identity-asset-store";
import { slotSessionSchema, storageFetch, storageOrigin, storagePublicKey, storageUnavailable, type SharedStorageSession } from "./protocol";

const reservationSchema = z.strictObject({ id: z.uuid(), requestKey: z.uuid(), reference: logoAssetReferenceSchema, storagePath: z.string().max(147),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), byteLength: z.number().int().min(1).max(20_971_520), purpose: z.enum(["reference_media", "brand_asset"]),
  sourceReceiptId: z.uuid(), rightsEvidenceId: z.uuid().nullable(), publicationState: z.enum(["staged", "committed"]) });
const grantSchema = slotSessionSchema.extend({ execution: sharedExecutionSchema, ownerId: z.uuid(), projectId: z.uuid(), jobId: z.uuid(), leaseToken: z.uuid(),
  inputRevision: z.number().int().positive(), jobInput: z.unknown(), capability: z.unknown(), mode: z.enum(["probe", "read", "write", "observe"]),
  member: z.enum(["reference", "base", "output"]).nullable(), reservation: reservationSchema.nullable(), publication: identityAssetPublicationSchema.nullable() });
export type SharedLogoStorageAuthorizationInput = { targetOrigin: string; publishableKey: string; slot(): SharedSlotLease | null; execution: SharedExecution;
  capability: LogoWorkerCapability; session: Pick<SharedStorageSession, "authUserId" | "sessionId" | "tokenProvider"> };
export type SharedLogoObservationScope = { job: Omit<ClaimedJob, "leaseToken"> & { leaseToken: string | null }; observationLeaseToken: string;
  reservation: Readonly<IdentityAssetReservation>; publication: IdentityAssetPublication };
type StorageJob = SharedLogoObservationScope["job"];
export type SharedLogoStorageAuthorization = LogoGenerativeStorageAuthorization & {
  /** Recovery can read only an output whose write grant was issued earlier.
   * SQL proves the frozen reservation/execution; this never starts an upload. */
  authorizeObservedOutput(scope: SharedLogoObservationScope, signal?: AbortSignal): Promise<LogoGenerativeStorageRead>;
};

/** One capability per immutable actual claimed execution. The shared actor has
 * no cached tenant identity; SQL derives owner and path from job/publication.
 * No construction I/O, account creation, admin credential or broad fallback. */
export function createSharedLogoStorageAuthorization(input: SharedLogoStorageAuthorizationInput,
  dependencies: { fetch?: typeof fetch; now?: () => number } = {}): SharedLogoStorageAuthorization {
 try {
  const origin = storageOrigin(input.targetOrigin), publishableKey = storagePublicKey(input.publishableKey, origin), execution = sharedExecutionSchema.parse(input.execution);
  const first = sharedSlotLeaseSchema.parse(input.slot()), capability = qualifiedLogoGenerativeStorageCapability(input.capability);
  const authUserId = z.uuid().parse(input.session.authUserId), sessionId = z.uuid().parse(input.session.sessionId);
  if (!capability || first.lane !== "logo" || execution.lane !== "logo" || first.slotId !== execution.slotId || first.generation < execution.generation
    || first.generation === execution.generation && first.instanceId !== execution.instanceId || execution.operation !== capability.operation
    || execution.policyIdentity !== capability.policyIdentity || authUserId === execution.ownerId || typeof input.session.tokenProvider !== "function") throw storageUnavailable();
  const lifetime = new AbortController(), now = dependencies.now ?? Date.now, transport = dependencies.fetch ?? globalThis.fetch;
  function current(active: boolean) {
   const slot = sharedSlotLeaseSchema.parse(input.slot());
   if (lifetime.signal.aborted || slot.slotId !== first.slotId || slot.roleName !== first.roleName || slot.roleOid !== first.roleOid || slot.lane !== "logo"
    || active && (slot.instanceId !== execution.instanceId || slot.generation !== execution.generation || Date.parse(slot.expiresAt) <= now())) throw storageUnavailable();
  }
  function signal(caller?: AbortSignal) { return AbortSignal.any([lifetime.signal, ...(caller ? [caller] : []), AbortSignal.timeout(10_000)]); }
  async function request(path: string, init: RequestInit, operation: AbortSignal, maximum: number, active: boolean) {
   current(active); operation.throwIfAborted();
   const token = await input.session.tokenProvider(operation), claims = decodeJwt(z.string().max(16_384).parse(token));
   if (claims.sub !== authUserId || claims.session_id !== sessionId || claims.role !== "authenticated" || claims.aud !== "authenticated"
    || claims.iss !== `${origin}/auth/v1` || claims.is_anonymous !== false || !Number.isSafeInteger(claims.exp) || claims.exp! * 1000 <= now()
    || claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf * 1000 > now())) throw storageUnavailable();
   current(active); operation.throwIfAborted(); const headers = new Headers(init.headers);
   if (headers.has("authorization") || headers.has("apikey")) throw storageUnavailable();
   headers.set("authorization", `Bearer ${token}`); headers.set("apikey", publishableKey);
   const result = await storageFetch(transport, `${origin}${path}`, { ...init, signal: operation, headers }, maximum);
   current(active); operation.throwIfAborted(); return result;
  }
  async function verifyAuth(operation: AbortSignal, active: boolean) {
   const response = await request("/auth/v1/user", { method: "GET" }, operation, 16_384, active);
   if (response.status !== 200) throw storageUnavailable();
   z.object({ id: z.literal(authUserId), is_anonymous: z.literal(false), email_confirmed_at: z.string().min(1) }).parse(await response.json());
  }
  function snapshot(raw: StorageJob, observe = false, observationLeaseToken?: string) {
   const job = structuredClone(raw), frozen = execution.operation === "identity.logo_concept" ? logoConceptJobInputSchema.parse(job.input) : logoRefinementJobInputSchema.parse(job.input);
   jobStatusSchema.parse(job.status);
   if (job.id !== execution.jobId || job.ownerId !== execution.ownerId || job.projectId !== execution.projectId
    || (observe ? observationLeaseToken !== execution.leaseToken || job.leaseToken !== null && job.leaseToken !== execution.leaseToken || job.status === "queued"
      : job.leaseToken !== execution.leaseToken || job.status !== "running")
    || job.operation !== execution.operation || frozen.ownerId !== execution.ownerId || frozen.projectId !== execution.projectId
    || frozen.policyIdentity !== execution.policyIdentity || frozen.handlerVersion !== capability!.handlerVersion
    || frozen.operation === "identity.logo_refine" && frozen.source.kind !== "preview") throw storageUnavailable();
   job.input = frozen; return job;
  }
  function member(job: StorageJob, row: IdentityAssetReservation) {
   if (row.publicationState !== "committed") throw storageUnavailable();
   if (row.purpose === "reference_media" && row.rightsEvidenceId !== null) {
    const frozen = job.input as z.infer<typeof logoConceptJobInputSchema>;
    if (job.operation === "identity.logo_concept" && !frozen.references.some(ref => isDeepStrictEqual(ref, row.reference))) throw storageUnavailable();
    return "reference";
   }
   if (job.operation === "identity.logo_refine" && row.purpose === "brand_asset" && row.rightsEvidenceId === null) return "base";
   throw storageUnavailable();
  }
  function publication(job: StorageJob, row: IdentityAssetReservation, raw: IdentityAssetPublication) {
   const p = identityAssetPublicationSchema.parse(raw), frozen = job.input as { attemptId?: string; rasterRevisionId?: string }, source = frozen.attemptId ?? frozen.rasterRevisionId;
   if (row.publicationState !== "staged" || row.purpose !== "brand_asset" || row.rightsEvidenceId !== null || row.sourceReceiptId !== source || row.requestKey !== source
    || p.requestKey !== source || p.source.kind !== "concept" || p.source.sourceId !== source || p.contentHash !== row.reference.contentHash
    || p.byteLength !== row.byteLength || p.mimeType !== row.mimeType || row.mimeType !== "image/png" || row.byteLength > 8_388_608) throw storageUnavailable();
   return p;
  }
  async function grant(job: StorageJob, row: IdentityAssetReservation | null, mode: "probe" | "read" | "write" | "observe", operation: AbortSignal, p: IdentityAssetPublication | null = null) {
   const response = await request("/rest/v1/rpc/authorize_shared_logo_storage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    p_execution: execution.executionId, p_execution_token: execution.executionToken, p_job: execution.jobId, p_lease: execution.leaseToken, p_reservation: row?.id ?? null, p_mode: mode }) }, operation, 131_072, mode !== "observe");
   if (response.status !== 200) throw storageUnavailable(); const result = grantSchema.parse(await response.json());
   const expectedMember = mode === "probe" ? null : mode === "read" ? row ? member(job, row) : null : "output";
   if (result.slotId !== execution.slotId || result.instanceId !== execution.instanceId || result.generation !== execution.generation || result.roleName !== first.roleName
    || result.roleOid !== first.roleOid || result.authUserId !== authUserId || result.sessionId !== sessionId || !isDeepStrictEqual(result.execution, execution)
    || result.ownerId !== execution.ownerId || result.projectId !== execution.projectId || result.jobId !== execution.jobId || result.leaseToken !== execution.leaseToken
    || result.inputRevision !== job.inputRevision || !isDeepStrictEqual(result.jobInput, job.input) || !isDeepStrictEqual(result.capability, capability)
    || result.mode !== mode || result.member !== expectedMember || !isDeepStrictEqual(result.reservation, row) || !isDeepStrictEqual(result.publication, p)) throw storageUnavailable();
  }
  async function authorize(scope: LogoGenerativeStorageScope | SharedLogoObservationScope, raw: IdentityAssetPublication | null, caller: AbortSignal | undefined, observe = false) {
   const operation = signal(caller), job = snapshot(scope.job, observe, "observationLeaseToken" in scope ? scope.observationLeaseToken : undefined), row = reservationSchema.parse(scope.reservation), ref = row.reference;
   if (ref.ownerId !== execution.ownerId || ref.projectId !== execution.projectId || row.storagePath !== `${ref.ownerId}/${ref.projectId}/${ref.assetId}/${ref.versionId}`) throw storageUnavailable();
   const p = raw ? publication(job, row, raw) : null, mode = p ? observe ? "observe" : "write" : "read";
   if (!p) member(job, row);
   await verifyAuth(operation, !observe); await grant(job, row, mode, operation, p);
   async function validate(bytes: Uint8Array, mime: string, s: AbortSignal) {
    s.throwIfAborted(); if (!(bytes instanceof Uint8Array) || bytes.byteLength !== row.byteLength || mime !== row.mimeType || createHash("sha256").update(bytes).digest("hex") !== ref.contentHash) throw storageUnavailable();
    await inspectIdentityRaster(bytes, mime, s); s.throwIfAborted();
   }
   const path = `/storage/v1/object/fluid-assets/${row.storagePath}`;
   const read = async (callerSignal?: AbortSignal) => {
    const s = signal(callerSignal ? AbortSignal.any([operation, callerSignal]) : operation), readMode = p ? "observe" : "read";
    await grant(job, row, readMode, s, p);
    const response = await request(path, { method: "GET", headers: { "accept-encoding": "identity" } }, s, row.byteLength, !p);
    if (response.status !== 200) throw storageUnavailable();
    const mime = new MIMEType(response.headers.get("content-type") ?? "").essence, bytes = new Uint8Array(await response.arrayBuffer());
    await validate(bytes, mime, s); await grant(job, row, readMode, s, p); return { bytes, mimeType: mime };
   };
   const safeRead = (callerSignal?: AbortSignal) => read(callerSignal).catch(() => { throw storageUnavailable(); });
   if (mode !== "write") return Object.freeze({ read: safeRead });
   return Object.freeze({ read: safeRead, putIfAbsent: (value: Uint8Array, mime: string, callerSignal?: AbortSignal) => guarded(async () => {
    if (!(value instanceof Uint8Array) || value.byteLength !== row.byteLength) throw storageUnavailable();
    const s = signal(callerSignal ? AbortSignal.any([operation, callerSignal]) : operation), bytes = new Uint8Array(value);
    await validate(bytes, mime, s); await grant(job, row, "write", s, p);
    const response = await request(path, { method: "POST", headers: { "content-type": mime, "content-length": String(bytes.byteLength),
     "cache-control": "max-age=0", "x-upsert": "false", "accept-encoding": "identity" }, body: bytes }, s, 16_384, true);
    if (![200, 400, 409].includes(response.status)) throw storageUnavailable(); const ack = z.record(z.string(), z.unknown()).parse(await response.json());
    const duplicate = ["ResourceAlreadyExists", "KeyAlreadyExists", "already_exists"].includes(String(ack.code)) && (response.status === 409 || response.status === 400 && String(ack.statusCode) === "409");
    if (!duplicate && (response.status !== 200 || !z.uuid().safeParse(ack.Id).success || ack.Key !== `fluid-assets/${row.storagePath}`)) throw storageUnavailable();
    await grant(job, row, "observe", s, p);
   }) });
  }
  const guarded = <T>(run: () => Promise<T>): Promise<T> => run().catch(() => { throw storageUnavailable(); });
  return Object.freeze({ ownerId: execution.ownerId, capability, close() { lifetime.abort(); },
   assertAvailable: (raw: ClaimedJob) => guarded(async () => { const job = snapshot(raw), s = signal(); await verifyAuth(s, true); await grant(job, null, "probe", s); }),
   authorizeRead: (scope: LogoGenerativeStorageScope, s?: AbortSignal) => guarded(async () => authorize(scope, null, s)) as Promise<LogoGenerativeStorageRead>,
   authorizeWrite: (scope: LogoGenerativeStorageScope & { publication: IdentityAssetPublication }, s?: AbortSignal) => guarded(async () => authorize(scope, scope.publication, s)) as Promise<LogoGenerativeStorageWrite>,
   authorizeObservedOutput: (scope: SharedLogoObservationScope, s?: AbortSignal) => guarded(async () => authorize(scope, scope.publication, s, true)),
  });
 } catch { throw storageUnavailable(); }
}
