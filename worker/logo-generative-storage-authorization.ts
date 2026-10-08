import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decodeJwt } from "jose";
import { z } from "zod";
import { moneySchema, type ClaimedJob } from "../src/domain/jobs";
import { IMAGE_MODEL } from "../src/domain/providers";
import { LOGO_MUTATION_MAX_BYTES, logoAssetReferenceSchema, logoUuidSchema } from "../src/domain/logo-vector";
import { logoConceptJobInputSchema, logoRefinementJobInputSchema } from "../src/domain/logo-jobs";
import { identityAssetPublicationSchema, type IdentityAssetPublication } from "../src/domain/logo-deliverables";
import type { IdentityAssetReservation } from "../src/server/data/identity-asset-store";
import { createSupabasePrivateAssetStorage } from "../src/server/runtime/private-asset-storage";
import { inspectIdentityRaster } from "../src/features/logo-vector/server/converter";
import { IMAGE_INPUT_LIMITS } from "../src/server/logo-creation/openai-image-transport";
import { LOGO_IMAGE_HANDLER_VERSION } from "../src/server/logo-creation/openai-logo-provider";
import { freezeLogoWorkerManifest, type LogoWorkerCapability } from "./logo-readiness";

const ORIGIN = "https://fricsfwqibyhemknqgyf.supabase.co";
const unavailable = () => new Error("Logo generative Storage is unavailable.");
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
  storagePath: z.string().max(147), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), byteLength: z.number().int().min(1).max(IMAGE_INPUT_LIMITS.inputBytes),
  purpose: z.enum(["reference_media", "brand_asset"]), sourceReceiptId: logoUuidSchema, rightsEvidenceId: logoUuidSchema.nullable(), publicationState: z.enum(["staged", "committed"]) });
const jobBasis = { id: logoUuidSchema, ownerId: logoUuidSchema, projectId: logoUuidSchema, inputRevision: z.number().int().positive(),
  leaseToken: logoUuidSchema, status: z.literal("running"), reservedCostMicrousd: moneySchema, actualCostMicrousd: moneySchema };
const jobSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...jobBasis, operation: z.literal("identity.logo_concept"), input: logoConceptJobInputSchema }),
  z.strictObject({ ...jobBasis, operation: z.literal("identity.logo_refine"), input: logoRefinementJobInputSchema }),
]);
const grantSchema = sessionSchema.extend({ capability: z.unknown(), jobId: logoUuidSchema, leaseToken: logoUuidSchema,
  inputRevision: z.number().int().positive(), jobInput: z.unknown(), mode: z.enum(["probe", "read", "write"]),
  member: z.enum(["reference", "base", "output"]).nullable(), reservation: reservationSchema.nullable(), publication: identityAssetPublicationSchema.nullable() });
export type LogoGenerativeStorageScope = Readonly<{ job: ClaimedJob; reservation: Readonly<IdentityAssetReservation> }>;
export type LogoGenerativeStorageRead = Readonly<{ read(signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> }>;
export type LogoGenerativeStorageWrite = LogoGenerativeStorageRead & Readonly<{ putIfAbsent(bytes: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<void> }>;
export interface LogoGenerativeStorageAuthorization {
  readonly ownerId: string;
  readonly capability: LogoWorkerCapability;
  assertAvailable(job: ClaimedJob): Promise<void>;
  authorizeRead(scope: LogoGenerativeStorageScope, signal?: AbortSignal): Promise<LogoGenerativeStorageRead>;
  /** The returned capability also reads back only its exact output reservation. */
  authorizeWrite(scope: LogoGenerativeStorageScope & Readonly<{ publication: IdentityAssetPublication }>, signal?: AbortSignal): Promise<LogoGenerativeStorageWrite>;
  close(): void;
}
export type LogoGenerativeStorageDependencies = { fetch: typeof fetch; now?: () => number };
/** Descriptor validation is not proof of live policy, Auth or source authority. */
export function qualifiedLogoGenerativeStorageCapability(input: unknown): LogoWorkerCapability | null {
  try {
    const cap = freezeLogoWorkerManifest([input])[0]!;
    if (!["identity.logo_concept", "identity.logo_refine"].includes(cap.operation) || cap.handlerVersion !== LOGO_IMAGE_HANDLER_VERSION
      || cap.provider !== "openai" || cap.model !== IMAGE_MODEL || cap.engine !== null || cap.maxCostMicrousd <= 0 || cap.billingMode !== undefined || cap.policy !== undefined) return null;
    return cap;
  } catch { return null; }
}
/** A separate, disabled-by-default uploaded-reference/raster-refinement lane.
 * The already-approved dedicated Auth session is injected, never discovered,
 * created, refreshed or persisted. SQL derives actual frozen source membership,
 * upload evidence and lease authority; caller metadata and decoded JWT claims
 * are rejection checks only. Each capability retains one immutable object.
 */
export function createLogoGenerativeStorageAuthorization(configuration: unknown = null,
  dependencies: LogoGenerativeStorageDependencies = { fetch: globalThis.fetch }): LogoGenerativeStorageAuthorization | null {
  const parsed = configurationSchema.safeParse(configuration);
  if (!parsed.success || typeof dependencies.fetch !== "function") return null;
  const c = parsed.data, now = dependencies.now ?? Date.now, capability = qualifiedLogoGenerativeStorageCapability(c.capability);
  if (!capability) return null;
  let sessionId: string, expires: number;
  try {
    const claims = decodeJwt(c.accessToken); sessionId = logoUuidSchema.parse(claims.session_id);
    if (claims.sub !== c.authUserId || claims.role !== "authenticated" || claims.aud !== "authenticated" || claims.iss !== `${ORIGIN}/auth/v1`
      || claims.is_anonymous !== false || !Number.isSafeInteger(claims.exp) || claims.exp! <= 0) return null;
    expires = claims.exp! * 1000;
  } catch { return null; }
  const lifetime = new AbortController(), deadlines = new WeakMap<AbortSignal, number>();
  const active = (signal?: AbortSignal) => {
    if (lifetime.signal.aborted || signal?.aborted || now() >= expires || signal && performance.now() >= (deadlines.get(signal) ?? Infinity)) throw unavailable();
  };
  function discard(response: Response) { try { void response.body?.cancel().catch(() => {}); } catch { /* Cleanup only. */ } }
  async function bounded<T>(caller: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    active(caller);
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, ...(caller ? [caller] : []), controller.signal]);
    deadlines.set(signal, Math.min(performance.now() + 10_000, caller ? deadlines.get(caller) ?? Infinity : Infinity));
    let reject!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, fail) => { reject = fail; });
    const stop = () => reject(unavailable());
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const pending = (async () => { active(signal); const result = await run(signal); active(signal); return result; })();
      return await Promise.race([pending, stopped]);
    } catch { controller.abort(); throw unavailable(); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
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
  async function json(url: string, init: RequestInit, signal: AbortSignal, maximum: number): Promise<unknown> {
    const response = await request(url, init, signal);
    const advertised = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
    if (response.status !== 200 || !response.body || encoding && encoding !== "identity"
      || advertised !== null && (!/^(0|[1-9][0-9]*)$/.test(advertised) || Number(advertised) > maximum)) { discard(response); throw unavailable(); }
    const reader = response.body.getReader(), bytes = new Uint8Array(maximum);
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
      if (!length || advertised !== null && Number(advertised) !== length) throw unavailable();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    } catch { cancel(); throw unavailable(); }
    finally { signal.removeEventListener("abort", cancel); try { reader.releaseLock(); } catch { /* Settling cancellation. */ } }
  }
  const combined = (...signals: (AbortSignal | undefined)[]) => AbortSignal.any([lifetime.signal, ...signals.filter((s): s is AbortSignal => s !== undefined)]);
  async function verifyAuth(signal: AbortSignal) {
    z.object({ id: z.literal(c.authUserId), is_anonymous: z.literal(false) }).parse(await json(`${ORIGIN}/auth/v1/user`, { method: "GET" }, signal, 16_384));
  }
  function snapshot(raw: ClaimedJob) {
    const job = jobSchema.parse(raw), input = job.input;
    if (job.ownerId !== c.ownerId || input.ownerId !== job.ownerId || input.projectId !== job.projectId || job.operation !== capability!.operation
      || input.policyIdentity !== capability!.policyIdentity || input.handlerVersion !== capability!.handlerVersion || job.reservedCostMicrousd > capability!.maxCostMicrousd
      || job.actualCostMicrousd > job.reservedCostMicrousd || job.operation === "identity.logo_refine" && job.input.source.kind !== "preview") throw unavailable();
    return job;
  }
  function publicationFor(job: ReturnType<typeof snapshot>, row: IdentityAssetReservation, raw: unknown) {
    const write = identityAssetPublicationSchema.parse(raw), id = job.operation === "identity.logo_concept" ? job.input.attemptId : job.input.rasterRevisionId;
    if (row.publicationState !== "staged" || row.purpose !== "brand_asset" || row.rightsEvidenceId !== null || row.sourceReceiptId !== id || write.source.sourceId !== id
      || write.source.kind !== "concept" || write.requestKey !== id || row.requestKey !== id || write.contentHash !== row.reference.contentHash
      || write.mimeType !== row.mimeType || write.byteLength !== row.byteLength || row.mimeType !== "image/png" || row.byteLength > IMAGE_INPUT_LIMITS.outputBytes) throw unavailable();
    return write;
  }
  function sourceFor(job: ReturnType<typeof snapshot>, row: IdentityAssetReservation): "reference" | "base" {
    if (row.publicationState !== "committed") throw unavailable();
    if (row.purpose === "reference_media" && row.rightsEvidenceId !== null) {
      if (job.operation === "identity.logo_concept" && !job.input.references.some(ref => isDeepStrictEqual(ref, row.reference))) throw unavailable();
      return "reference";
    }
    if (job.operation === "identity.logo_refine" && row.purpose === "brand_asset" && row.rightsEvidenceId === null) return "base";
    throw unavailable();
  }
  async function grant(job: ReturnType<typeof snapshot>, row: IdentityAssetReservation | null, mode: "probe" | "read" | "write", signal: AbortSignal,
    expectedPublication: IdentityAssetPublication | null = null) {
    // Full bounded domain inputs and publication are echoed. Their individual
    // 32KiB ceilings plus exact context fit under this explicit 128KiB ceiling.
    const raw = await json(`${ORIGIN}/rest/v1/rpc/authorize_logo_generative_storage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ p_job: job.id, p_lease: job.leaseToken, p_reservation: row?.id ?? null, p_mode: mode }) }, signal, 4 * LOGO_MUTATION_MAX_BYTES);
    const result = grantSchema.parse(raw), member = mode === "probe" ? null : mode === "write" ? "output" : row ? sourceFor(job, row) : null;
    if (result.ownerId !== c.ownerId || result.authUserId !== c.authUserId || result.sessionId !== sessionId || result.workerRoleName !== c.workerRoleName
      || result.workerRoleOid !== c.workerRoleOid || result.workerId !== c.workerId || result.jobId !== job.id || result.leaseToken !== job.leaseToken
      || result.inputRevision !== job.inputRevision || result.mode !== mode || result.member !== member || !isDeepStrictEqual(result.jobInput, job.input)
      || !isDeepStrictEqual(result.capability, capability) || !isDeepStrictEqual(result.reservation, row) || !isDeepStrictEqual(result.publication, expectedPublication)) throw unavailable();
    if (mode === "write") { if (!row || !result.publication) throw unavailable(); publicationFor(job, row, result.publication); }
  }
  async function authorize(raw: LogoGenerativeStorageScope, publication: IdentityAssetPublication | null, caller?: AbortSignal) {
    return bounded(caller, async signal => {
      const job = snapshot(raw.job), row = reservationSchema.parse(raw.reservation), ref = row.reference, mode = publication ? "write" : "read";
      if (ref.ownerId !== job.ownerId || ref.projectId !== job.projectId || row.storagePath !== `${ref.ownerId}/${ref.projectId}/${ref.assetId}/${ref.versionId}`) throw unavailable();
      const write = publication ? publicationFor(job, row, publication) : null;
      if (!write) sourceFor(job, row);
      await verifyAuth(signal); await grant(job, row, mode, signal, write);
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
        await inspectIdentityRaster(bytes, mime, signal); active(signal);
      }
      const read = (current?: AbortSignal) => bounded(combined(caller, current), async s => {
        await grant(job, row, mode, s, write); const value = await storage.read(row.storagePath, s);
        await validate(value.bytes, value.mimeType, s); await grant(job, row, mode, s, write); return value;
      });
      if (mode !== "write") return { mode: "read" as const, object: Object.freeze({ read }) };
      return { mode: "write" as const, object: Object.freeze({ read, putIfAbsent: (input: Uint8Array, mime: string, current?: AbortSignal) => bounded(combined(caller, current), async s => {
        if (!(input instanceof Uint8Array) || input.byteLength !== row.byteLength) throw unavailable();
        const bytes = new Uint8Array(input);
        await validate(bytes, mime, s); await grant(job, row, mode, s, write); await storage.putIfAbsent(row.storagePath, bytes, mime, s); await grant(job, row, mode, s, write);
      }) }) };
    });
  }
  return Object.freeze({ ownerId: c.ownerId, capability,
    close() { lifetime.abort(); },
    assertAvailable: (raw: ClaimedJob) => bounded(undefined, async signal => { const job = snapshot(raw); await verifyAuth(signal); await grant(job, null, "probe", signal); }),
    authorizeRead: async (scope: LogoGenerativeStorageScope, signal?: AbortSignal) => {
      const result = await authorize(scope, null, signal); if (result.mode !== "read") throw unavailable(); return result.object;
    },
    authorizeWrite: async (scope: LogoGenerativeStorageScope & { publication: IdentityAssetPublication }, signal?: AbortSignal) => {
      const result = await authorize(scope, scope.publication, signal); if (result.mode !== "write") throw unavailable(); return result.object;
    },
  });
}
