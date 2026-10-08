import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decodeJwt } from "jose";
import { z } from "zod";
import type { ClaimedJob } from "../src/domain/jobs";
import { ASSET_MAX_FILE_BYTES } from "../src/domain/asset-library";
import { logoAssetReferenceSchema, logoUuidSchema } from "../src/domain/logo-vector";
import { logoExportJobInputSchema, logoVectorizeJobInputSchema } from "../src/domain/logo-jobs";
import { identityAssetPublicationSchema, type IdentityAssetPublication } from "../src/domain/logo-deliverables";
import type { IdentityAssetReservation } from "../src/server/data/identity-asset-store";
import { createSupabasePrivateAssetStorage } from "../src/server/runtime/private-asset-storage";
import { inspectIdentityRaster } from "../src/features/logo-vector/server/converter";
import { validateLogoVectorDocument } from "../src/features/logo-vector/model/geometry";
import { canonicalLogoDocumentBytes } from "../src/features/logo-vector/model/canonical";
import { validateLogoVectorSvg } from "../src/features/logo-vector/model/svg";
import { validateLogoExportAssetBytes } from "../src/features/identity-deliverables/server/validate-assets";
import { LOGO_EXPORT_POLICY_IDENTITY, LOGO_EXPORT_HANDLER_VERSION } from "./handlers/logo-exports";
import { QUALIFIED_VTRACER } from "./logo-vector/engine";
import { freezeLogoWorkerManifest, type LogoWorkerCapability } from "./logo-readiness";

const ORIGIN = "https://fricsfwqibyhemknqgyf.supabase.co";
const unavailable = () => new Error("Logo production Storage is unavailable.");
const configurationSchema = z.strictObject({
  ownerId: logoUuidSchema, authUserId: logoUuidSchema,
  workerRoleName: z.string().max(63).regex(/^fluid_logo_worker(?:_[a-z0-9_]+)?$/),
  workerRoleOid: z.number().int().min(1).max(4_294_967_295), workerId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  publishableKey: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{1,500}$/),
  accessToken: z.string().max(16_384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/), capability: z.unknown(),
}).refine(c => c.ownerId !== c.authUserId);
const sessionSchema = z.strictObject({ ownerId: logoUuidSchema, authUserId: logoUuidSchema, sessionId: logoUuidSchema,
  workerRoleName: z.string(), workerRoleOid: z.number().int(), workerId: z.string() });
const reservationSchema = z.strictObject({ id: logoUuidSchema, requestKey: logoUuidSchema, reference: logoAssetReferenceSchema,
  storagePath: z.string().max(147), mimeType: z.string().max(150), byteLength: z.number().int().min(1).max(ASSET_MAX_FILE_BYTES),
  purpose: z.literal("brand_asset"), sourceReceiptId: logoUuidSchema, rightsEvidenceId: logoUuidSchema.nullable(), publicationState: z.enum(["staged", "committed"]) });
const jobBasis = { id: logoUuidSchema, ownerId: logoUuidSchema, projectId: logoUuidSchema, inputRevision: z.number().int().positive(),
  leaseToken: logoUuidSchema, status: z.literal("running"), reservedCostMicrousd: z.literal(0), actualCostMicrousd: z.literal(0) };
const jobSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...jobBasis, operation: z.literal("identity.logo_vectorize"), input: logoVectorizeJobInputSchema }),
  z.strictObject({ ...jobBasis, operation: z.literal("identity.logo_export"), input: logoExportJobInputSchema }),
]);
const grantSchema = sessionSchema.extend({ capability: z.unknown(), jobId: logoUuidSchema, leaseToken: logoUuidSchema,
  inputRevision: z.number().int().positive(), jobInput: z.unknown(), mode: z.enum(["probe", "read", "write", "readback"]), reservation: reservationSchema.nullable(), publication: identityAssetPublicationSchema.nullable() });
const rasterMimes = ["image/png", "image/jpeg", "image/webp"];
export type LogoProductionStorageScope = Readonly<{ job: ClaimedJob; reservation: Readonly<IdentityAssetReservation> }>;
export type LogoProductionStorageRead = Readonly<{ read(signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> }>;
export type LogoProductionStorageWrite = LogoProductionStorageRead & Readonly<{ putIfAbsent(bytes: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<void> }>;
export interface LogoProductionStorageAuthorization {
  readonly ownerId: string;
  readonly capability: LogoWorkerCapability;
  assertAvailable(job: ClaimedJob): Promise<void>;
  authorizeRead(scope: LogoProductionStorageScope, signal?: AbortSignal): Promise<LogoProductionStorageRead>;
  /** GET-only reuse of an existing exact write grant; cannot grant source access. */
  authorizeReadback(scope: LogoProductionStorageScope, signal?: AbortSignal): Promise<LogoProductionStorageRead>;
  authorizeWrite(scope: LogoProductionStorageScope & Readonly<{ publication: IdentityAssetPublication }>, signal?: AbortSignal): Promise<LogoProductionStorageWrite>;
  close(): void;
}
export type LogoProductionStorageDependencies = { fetch: typeof fetch; now?: () => number };
/** Pure descriptor validation; never evidence that access exists. Shared by the
 * two constructors so an unqualified injected port cannot broaden the broker. */
export function qualifiedLogoProductionStorageCapability(input: unknown): LogoWorkerCapability | null {
  try {
    const cap = freezeLogoWorkerManifest([input])[0]!;
    if (cap.provider !== null || cap.model !== null || cap.maxCostMicrousd !== 0 || cap.billingMode !== undefined || cap.policy !== undefined) return null;
    if (cap.operation === "identity.logo_vectorize") {
      if (cap.handlerVersion !== "1" || !isDeepStrictEqual(cap.engine, { id: "vtracer", version: QUALIFIED_VTRACER.version, artifactHash: QUALIFIED_VTRACER.wasm })) return null;
    } else if (cap.operation !== "identity.logo_export" || cap.handlerVersion !== LOGO_EXPORT_HANDLER_VERSION || cap.policyIdentity !== LOGO_EXPORT_POLICY_IDENTITY || cap.engine !== null) return null;
    return cap;
  } catch { return null; }
}
/** Distinct from concept authorization: injection of an already authorized
 * short-lived dedicated session and ONE reviewed operation. No login, refresh,
 * environment lookup, grant, policy, pool or activation. The SQL RPC derives
 * owner/session from verified Auth and resolves frozen members/reservations.
 * Caller hashes and decoded claims are preflight checks, never ownership proof.
 */
export function createLogoProductionStorageAuthorization(configuration: unknown = null,
  dependencies: LogoProductionStorageDependencies = { fetch: globalThis.fetch }): LogoProductionStorageAuthorization | null {
  const parsed = configurationSchema.safeParse(configuration);
  if (!parsed.success || typeof dependencies.fetch !== "function") return null;
  const c = parsed.data, now = dependencies.now ?? Date.now, capability = qualifiedLogoProductionStorageCapability(c.capability);
  if (!capability) return null;
  let sessionId: string, expires: number;
  try {
    const claims = decodeJwt(c.accessToken); sessionId = logoUuidSchema.parse(claims.session_id);
    if (claims.sub !== c.authUserId || claims.role !== "authenticated" || claims.aud !== "authenticated" || claims.iss !== `${ORIGIN}/auth/v1`
      || claims.is_anonymous !== false || !Number.isSafeInteger(claims.exp) || claims.exp! <= 0) return null;
    expires = claims.exp! * 1000;
  } catch { return null; }
  const lifetime = new AbortController();
  const active = (signal?: AbortSignal) => { if (lifetime.signal.aborted || signal?.aborted || now() >= expires) throw unavailable(); };
  function discard(response: Response) { try { void response.body?.cancel().catch(() => {}); } catch { /* Cleanup only. */ } }

  async function bounded<T>(caller: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    active(caller);
    const controller = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, ...(caller ? [caller] : []), controller.signal]);
    let reject!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, fail) => { reject = fail; });
    const stop = () => reject(unavailable());
    combined.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const pending = (async () => { active(combined); const result = await run(combined); active(combined); return result; })();
      return await Promise.race([pending, stopped]);
    } catch { controller.abort(); throw unavailable(); }
    finally { clearTimeout(timer); combined.removeEventListener("abort", stop); }
  }
  async function request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    active(signal);
    const headers = new Headers(init.headers);
    if (headers.has("authorization") || headers.has("apikey")) throw unavailable();
    headers.set("authorization", `Bearer ${c.accessToken}`); headers.set("apikey", c.publishableKey);
    const response = await dependencies.fetch(url, { ...init, headers, signal, redirect: "error", credentials: "omit", cache: "no-store" });
    try {
      active(signal);
      if (!(response instanceof Response) || response.redirected || response.url && response.url !== url
        || response.status >= 300 && response.status < 400) throw unavailable();
      return response;
    } catch { discard(response); throw unavailable(); }
  }
  async function json(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const response = await request(url, init, signal);
    if (response.status !== 200 || !response.body) { discard(response); throw unavailable(); }
    const reader = response.body.getReader(), bytes = new Uint8Array(16_384);
    let length = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        active(signal); const part = await reader.read(); active(signal);
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || part.value.length > bytes.length - length) throw unavailable();
        bytes.set(part.value, length); length += part.value.length;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    } catch { cancel(); throw unavailable(); }
    finally { signal.removeEventListener("abort", cancel); try { reader.releaseLock(); } catch { /* Settling cancellation. */ } }
  }
  const combined = (...signals: (AbortSignal | undefined)[]) => AbortSignal.any([lifetime.signal, ...signals.filter((s): s is AbortSignal => s !== undefined)]);
  async function verifyAuth(signal: AbortSignal) {
    z.object({ id: z.literal(c.authUserId), is_anonymous: z.literal(false) }).parse(await json(`${ORIGIN}/auth/v1/user`, { method: "GET" }, signal));
  }
  function snapshot(raw: ClaimedJob) {
    const job = jobSchema.parse(raw), input = job.input;
    if (job.ownerId !== c.ownerId || input.ownerId !== job.ownerId || input.projectId !== job.projectId || job.operation !== capability!.operation
      || input.policyIdentity !== capability!.policyIdentity || input.handlerVersion !== capability!.handlerVersion
      || job.operation === "identity.logo_vectorize" && !isDeepStrictEqual(job.input.engine, capability!.engine)) throw unavailable();
    return job;
  }
  function publicationFor(job: ClaimedJob, row: IdentityAssetReservation, raw: unknown) {
    const write = identityAssetPublicationSchema.parse(raw);
    if (row.publicationState !== "staged" || row.rightsEvidenceId !== null || row.sourceReceiptId !== job.id || write.source.sourceId !== job.id
      || write.source.kind !== (job.operation === "identity.logo_vectorize" ? "vector" : "export") || write.requestKey !== row.requestKey
      || write.contentHash !== row.reference.contentHash || write.mimeType !== row.mimeType || write.byteLength !== row.byteLength
      || !(job.operation === "identity.logo_vectorize" ? ["application/json", "image/svg+xml"] : ["image/svg+xml", "image/png", "application/pdf", "application/zip"]).includes(row.mimeType)) throw unavailable();
    return write;
  }
  async function grant(job: ClaimedJob, row: IdentityAssetReservation | null, mode: "probe" | "read" | "write" | "readback", signal: AbortSignal,
    expectedPublication?: IdentityAssetPublication | null) {
    const raw = await json(`${ORIGIN}/rest/v1/rpc/authorize_logo_production_storage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ p_job: job.id, p_lease: job.leaseToken, p_reservation: row?.id ?? null, p_mode: mode }) }, signal);
    const result = grantSchema.parse(raw);
    if (result.ownerId !== c.ownerId || result.authUserId !== c.authUserId || result.sessionId !== sessionId || result.workerRoleName !== c.workerRoleName
      || result.workerRoleOid !== c.workerRoleOid || result.workerId !== c.workerId || result.jobId !== job.id || result.leaseToken !== job.leaseToken
      || result.inputRevision !== job.inputRevision || result.mode !== mode || !isDeepStrictEqual(result.jobInput, job.input)
      || !isDeepStrictEqual(result.capability, capability) || !isDeepStrictEqual(result.reservation, row)) throw unavailable();
    if (mode === "write" || mode === "readback") {
      if (!row || !result.publication) throw unavailable();
      publicationFor(job, row, result.publication);
      if (expectedPublication !== undefined && !isDeepStrictEqual(result.publication, expectedPublication)) throw unavailable();
    } else if (result.publication !== null) throw unavailable();
    return result.publication;
  }
  async function authorize(raw: LogoProductionStorageScope, publication: IdentityAssetPublication | null, caller?: AbortSignal, readback = false) {
    return bounded(caller, async signal => {
      const job = snapshot(raw.job), row = reservationSchema.parse(raw.reservation), ref = row.reference, mode = readback ? "readback" : publication ? "write" : "read";
      if (ref.ownerId !== job.ownerId || ref.projectId !== job.projectId || row.storagePath !== `${ref.ownerId}/${ref.projectId}/${ref.assetId}/${ref.versionId}`) throw unavailable();
      const supplied = publication ? publicationFor(job, row, publication) : null;
      if (readback) {
        if (row.publicationState !== "staged" || row.rightsEvidenceId !== null || row.sourceReceiptId !== job.id
          || !(job.operation === "identity.logo_vectorize" ? ["application/json", "image/svg+xml"] : ["image/svg+xml", "image/png", "application/pdf", "application/zip"]).includes(row.mimeType)) throw unavailable();
      } else if (!supplied && (row.publicationState !== "committed" || !(job.operation === "identity.logo_vectorize" ? rasterMimes : [...rasterMimes, "application/json", "image/svg+xml"]).includes(row.mimeType))) throw unavailable();
      await verifyAuth(signal);
      // Readback receives the immutable original publication from SQL. It never
      // accepts a browser-supplied publication or creates a new write grant.
      const write = await grant(job, row, mode, signal, readback ? undefined : supplied);
      const url = `${ORIGIN}/storage/v1/object/fluid-assets/${row.storagePath}`;
      const storage = createSupabasePrivateAssetStorage({ scope: { kind: "identity", ownerId: job.ownerId, projectId: job.projectId }, maxFileBytes: row.byteLength,
        transport: (target, init) => {
          if (target !== url || !init.signal || !(mode === "write" ? ["POST", "GET"] : ["GET"]).includes(init.method ?? "")
            || init.method === "POST" && new Headers(init.headers).get("x-upsert") !== "false") throw unavailable();
          return request(target, init, init.signal);
        } });
      async function validate(bytes: Uint8Array, mime: string, signal: AbortSignal) {
        active(signal);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== row.byteLength || mime !== row.mimeType || createHash("sha256").update(bytes).digest("hex") !== ref.contentHash) throw unavailable();
        if (rasterMimes.includes(mime)) await inspectIdentityRaster(bytes, mime, signal);
        else if (mime === "image/svg+xml") validateLogoVectorSvg(bytes);
        else if (mime === "application/json") {
          const document = validateLogoVectorDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
          if (!Buffer.from(canonicalLogoDocumentBytes(document)).equals(Buffer.from(bytes))) throw unavailable();
        } else if (write && (mime === "application/pdf" || mime === "application/zip")) await validateLogoExportAssetBytes({ kind: "stage", publication: write }, bytes, signal);
        else throw unavailable();
        active(signal);
      }
      const read = (current?: AbortSignal) => bounded(combined(caller, current), async s => {
        await grant(job, row, mode, s, write); const value = await storage.read(row.storagePath, s);
        await validate(value.bytes, value.mimeType, s); await grant(job, row, mode, s, write); return value;
      });
      if (mode !== "write") return { mode: "read" as const, object: Object.freeze({ read }) };
      return { mode: "write" as const, object: Object.freeze({ read, putIfAbsent: (input: Uint8Array, mime: string, current?: AbortSignal) => bounded(combined(caller, current), async s => {
        if (!(input instanceof Uint8Array)) throw unavailable(); const bytes = new Uint8Array(input);
        await validate(bytes, mime, s); await grant(job, row, mode, s, write); await storage.putIfAbsent(row.storagePath, bytes, mime, s); await grant(job, row, mode, s, write);
      }) }) };
    });
  }
  return Object.freeze({ ownerId: c.ownerId, capability,
    close() { lifetime.abort(); },
    assertAvailable: (raw: ClaimedJob) => bounded(undefined, async signal => { const job = snapshot(raw); await verifyAuth(signal); await grant(job, null, "probe", signal); }),
    authorizeRead: async (scope: LogoProductionStorageScope, signal?: AbortSignal) => {
      const result = await authorize(scope, null, signal); if (result.mode !== "read") throw unavailable(); return result.object;
    },
    authorizeReadback: async (scope: LogoProductionStorageScope, signal?: AbortSignal) => {
      const result = await authorize(scope, null, signal, true); if (result.mode !== "read") throw unavailable(); return result.object;
    },
    authorizeWrite: async (scope: LogoProductionStorageScope & { publication: IdentityAssetPublication }, signal?: AbortSignal) => {
      const result = await authorize(scope, scope.publication, signal); if (result.mode !== "write") throw unavailable(); return result.object;
    },
  });
}
