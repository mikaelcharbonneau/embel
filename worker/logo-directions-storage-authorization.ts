import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decodeJwt } from "jose";
import { z } from "zod";
import type { ClaimedJob } from "../src/domain/jobs";
import { LOGO_GEOMETRY_MAX_BYTES, LOGO_MUTATION_MAX_BYTES, logoAssetReferenceSchema, logoUuidSchema } from "../src/domain/logo-vector";
import { logoDirectionsJobInputSchema } from "../src/domain/logo-jobs";
import { fontRecordSchema } from "../src/domain/logo-directions";
import type { IdentityAssetReservation } from "../src/server/data/identity-asset-store";
import { createSupabasePrivateAssetStorage } from "../src/server/runtime/private-asset-storage";
import { validateLogoVectorDocument } from "../src/features/logo-vector/model/geometry";
import { canonicalLogoDocumentBytes } from "../src/features/logo-vector/model/canonical";
import { fontPurposeAllowed } from "../src/features/identity-directions/model/font-rights";
import { inspectFontBytes, MAX_FONT_BYTES } from "../src/features/identity-directions/server/font-inspection";
import { freezeLogoWorkerManifest, type LogoWorkerCapability } from "./logo-readiness";

const ORIGIN = "https://fricsfwqibyhemknqgyf.supabase.co";
const MAX_RPC_BYTES = 2 * LOGO_MUTATION_MAX_BYTES + 16_384;
const unavailable = () => new Error("Logo directions Storage is unavailable.");
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
  storagePath: z.string().max(147), mimeType: z.enum(["application/json", "font/ttf", "font/otf"]), byteLength: z.number().int().positive().max(MAX_FONT_BYTES),
  purpose: z.literal("brand_asset"), sourceReceiptId: logoUuidSchema, rightsEvidenceId: logoUuidSchema.nullable(), publicationState: z.literal("committed") });
const jobSchema = z.strictObject({ id: logoUuidSchema, ownerId: logoUuidSchema, projectId: logoUuidSchema, operation: z.literal("identity.logo_directions"),
  inputRevision: z.number().int().positive(), leaseToken: logoUuidSchema, status: z.literal("running"), reservedCostMicrousd: z.literal(0), actualCostMicrousd: z.literal(0), input: logoDirectionsJobInputSchema });
const memberSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("logo-document") }), z.strictObject({ kind: z.literal("font"), font: fontRecordSchema })]);
const grantSchema = sessionSchema.extend({ capability: z.unknown(), jobId: logoUuidSchema, leaseToken: logoUuidSchema, inputRevision: z.number().int().positive(),
  jobInput: z.unknown(), mode: z.enum(["probe", "read"]), reservation: reservationSchema.nullable(), member: memberSchema.nullable() });
type Member = z.infer<typeof memberSchema>;
export type LogoDirectionsStorageRead = Readonly<{ read(signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> }>;
export interface LogoDirectionsStorageAuthorization {
  readonly ownerId: string;
  readonly capability: LogoWorkerCapability;
  assertAvailable(job: ClaimedJob): Promise<void>;
  authorizeRead(scope: Readonly<{ job: ClaimedJob; reservation: Readonly<IdentityAssetReservation> }>, signal?: AbortSignal): Promise<LogoDirectionsStorageRead>;
  close(): void;
}
/** Descriptor validation is not live access. SQL independently verifies the full
 * exact registered zero-API policy, quota, readiness and current lease. */
export function qualifiedLogoDirectionsStorageCapability(input: unknown): LogoWorkerCapability | null {
  try {
    const cap = freezeLogoWorkerManifest([input])[0]!;
    if (cap.operation !== "identity.logo_directions" || cap.handlerVersion !== "logo-directions-v1" || cap.provider !== "openai" || cap.engine !== null
      || cap.maxCostMicrousd !== 0 || cap.billingMode !== "chatgpt_subscription" || !cap.policy || cap.model !== cap.policy.model) return null;
    return cap;
  } catch { return null; }
}
/** Already-authorized, short-lived dedicated Auth injection only. No login,
 * refresh, environment lookup, URL discovery, grants or persistent credentials.
 * Decoded claims reject obvious mismatches; verified Auth and SQL establish
 * authority. Per-object closures never share mutable path/job state. */
export function createLogoDirectionsStorageAuthorization(configuration: unknown = null,
  dependencies: { fetch: typeof fetch; now?: () => number } = { fetch: globalThis.fetch }): LogoDirectionsStorageAuthorization | null {
  const parsed = configurationSchema.safeParse(configuration);
  if (!parsed.success || typeof dependencies.fetch !== "function") return null;
  const c = parsed.data, now = dependencies.now ?? Date.now, capability = qualifiedLogoDirectionsStorageCapability(c.capability);
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
    const controller = new AbortController(), signal = AbortSignal.any([lifetime.signal, ...(caller ? [caller] : []), controller.signal]);
    let reject!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, fail) => { reject = fail; });
    const stop = () => reject(unavailable());
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      return await Promise.race([(async () => { active(signal); const result = await run(signal); active(signal); return result; })(), stopped]);
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
      if (!(response instanceof Response) || response.redirected || response.url && response.url !== url || response.status >= 300 && response.status < 400) throw unavailable();
      return response;
    } catch { discard(response); throw unavailable(); }
  }
  async function json(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const response = await request(url, init, signal);
    if (response.status !== 200 || !response.body) { discard(response); throw unavailable(); }
    const reader = response.body.getReader(), bytes = new Uint8Array(MAX_RPC_BYTES); let length = 0;
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
  function snapshot(raw: ClaimedJob) {
    const job = jobSchema.parse(raw), input = job.input;
    if (job.ownerId !== c.ownerId || input.ownerId !== job.ownerId || input.projectId !== job.projectId || input.fontVersionIds.length === 0
      || input.policyIdentity !== capability!.policyIdentity || input.handlerVersion !== capability!.handlerVersion
      || input.billingMode !== "chatgpt_subscription" || !isDeepStrictEqual(input.policy, capability!.policy)) throw unavailable();
    return job;
  }
  function validateMember(job: ReturnType<typeof snapshot>, row: z.infer<typeof reservationSchema>, member: Member) {
    if (member.kind === "logo-document") {
      if (row.mimeType !== "application/json" || row.byteLength > LOGO_GEOMETRY_MAX_BYTES || row.rightsEvidenceId !== null) throw unavailable();
    } else {
      const font = member.font;
      if (!["font/ttf", "font/otf"].includes(row.mimeType) || row.byteLength < 12 || row.byteLength > MAX_FONT_BYTES || font.source !== "free_catalog"
        || !job.input.fontVersionIds.includes(font.id) || !isDeepStrictEqual(font.asset, row.reference) || font.rights.id !== row.rightsEvidenceId || !fontPurposeAllowed(font, "render")) throw unavailable();
    }
  }
  async function grant(job: ReturnType<typeof snapshot>, row: z.infer<typeof reservationSchema> | null, mode: "probe" | "read", signal: AbortSignal, expected?: Member) {
    const raw = await json(`${ORIGIN}/rest/v1/rpc/authorize_logo_directions_storage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ p_job: job.id, p_lease: job.leaseToken, p_reservation: row?.id ?? null, p_mode: mode }) }, signal);
    const result = grantSchema.parse(raw);
    if (result.ownerId !== c.ownerId || result.authUserId !== c.authUserId || result.sessionId !== sessionId || result.workerRoleName !== c.workerRoleName
      || result.workerRoleOid !== c.workerRoleOid || result.workerId !== c.workerId || result.jobId !== job.id || result.leaseToken !== job.leaseToken
      || result.inputRevision !== job.inputRevision || result.mode !== mode || !isDeepStrictEqual(result.jobInput, job.input)
      || !isDeepStrictEqual(result.capability, capability) || !isDeepStrictEqual(result.reservation, row)) throw unavailable();
    if (mode === "probe") { if (result.member !== null) throw unavailable(); }
    else {
      if (!row || !result.member) throw unavailable(); validateMember(job, row, result.member);
      if (expected !== undefined && !isDeepStrictEqual(expected, result.member)) throw unavailable();
    }
    return result.member;
  }
  const verifyAuth = async (signal: AbortSignal) => {
    z.object({ id: z.literal(c.authUserId), is_anonymous: z.literal(false) }).parse(await json(`${ORIGIN}/auth/v1/user`, { method: "GET" }, signal));
  };
  return Object.freeze({ ownerId: c.ownerId, capability,
    close() { lifetime.abort(); },
    assertAvailable: (raw: ClaimedJob) => bounded(undefined, async signal => { const job = snapshot(raw); await verifyAuth(signal); await grant(job, null, "probe", signal); }),
    authorizeRead: (raw, caller) => bounded(caller, async signal => {
      const job = snapshot(raw.job), row = reservationSchema.parse(raw.reservation), ref = row.reference;
      if (ref.ownerId !== job.ownerId || ref.projectId !== job.projectId || row.storagePath !== `${ref.ownerId}/${ref.projectId}/${ref.assetId}/${ref.versionId}`
        || row.mimeType === "application/json" && row.byteLength > LOGO_GEOMETRY_MAX_BYTES || row.mimeType !== "application/json" && row.byteLength < 12) throw unavailable();
      await verifyAuth(signal); const member = (await grant(job, row, "read", signal))!;
      const url = `${ORIGIN}/storage/v1/object/fluid-assets/${row.storagePath}`;
      const storage = createSupabasePrivateAssetStorage({ scope: { kind: "identity", ownerId: job.ownerId, projectId: job.projectId }, maxFileBytes: row.byteLength,
        transport: (target, init) => { if (target !== url || init.method !== "GET" || !init.signal) throw unavailable(); return request(target, init, init.signal); } });
      return Object.freeze({ read: (current?: AbortSignal) => bounded(AbortSignal.any([lifetime.signal, ...(caller ? [caller] : []), ...(current ? [current] : [])]), async s => {
        await grant(job, row, "read", s, member); const value = await storage.read(row.storagePath, s);
        if (!(value.bytes instanceof Uint8Array) || value.bytes.length !== row.byteLength || value.mimeType !== row.mimeType || createHash("sha256").update(value.bytes).digest("hex") !== ref.contentHash) throw unavailable();
        if (member.kind === "logo-document") {
          const document = validateLogoVectorDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value.bytes)));
          if (!Buffer.from(canonicalLogoDocumentBytes(document)).equals(Buffer.from(value.bytes))) throw unavailable();
        } else if ((await inspectFontBytes(value.bytes, value.mimeType, s)).family !== member.font.family) throw unavailable();
        active(s); await grant(job, row, "read", s, member); return value;
      }) });
    }),
  } satisfies LogoDirectionsStorageAuthorization);
}
