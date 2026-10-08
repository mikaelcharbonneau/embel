import "server-only";
import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { z } from "zod";
import type { LogoConceptStorageAuthorization } from "./logo-concept-startup";
import { logoAssetReferenceSchema, logoUuidSchema } from "../src/domain/logo-vector";
import { ASSET_MAX_FILE_BYTES } from "../src/domain/asset-library";
import { createSupabasePrivateAssetStorage } from "../src/server/runtime/private-asset-storage";

const ORIGIN = "https://fricsfwqibyhemknqgyf.supabase.co";
const unavailable = () => new Error("Logo Storage is unavailable.");
const configurationSchema = z.strictObject({
  ownerId: logoUuidSchema, authUserId: logoUuidSchema,
  workerRoleName: z.string().max(63).regex(/^fluid_logo_worker(?:_[a-z0-9_]+)?$/),
  workerRoleOid: z.number().int().min(1).max(4_294_967_295), workerId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  publishableKey: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{1,500}$/),
  accessToken: z.string().max(16_384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
}).refine(c => c.ownerId !== c.authUserId);
const sessionSchema = z.strictObject({ ownerId: logoUuidSchema, authUserId: logoUuidSchema, sessionId: logoUuidSchema,
  workerRoleName: z.string(), workerRoleOid: z.number().int(), workerId: z.string() });
const reservationSchema = z.strictObject({ id: logoUuidSchema, requestKey: logoUuidSchema, reference: logoAssetReferenceSchema,
  storagePath: z.string().max(147), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), byteLength: z.number().int().min(1).max(ASSET_MAX_FILE_BYTES),
  purpose: z.literal("brand_asset"), sourceReceiptId: logoUuidSchema, rightsEvidenceId: z.null(), publicationState: z.literal("staged") });
const scopeSchema = z.strictObject({ ownerId: logoUuidSchema, projectId: logoUuidSchema, jobId: logoUuidSchema, leaseToken: logoUuidSchema, reservation: reservationSchema });
const grantSchema = sessionSchema.extend({ jobId: logoUuidSchema, leaseToken: logoUuidSchema, reservation: reservationSchema });
export type LogoStorageAuthorization = LogoConceptStorageAuthorization & { close(): void };
export type LogoStorageDependencies = { fetch: typeof fetch; now?: () => number };

/** Dedicated, already approved, short-lived Auth session injection only. No
 * discovery, login, refresh, persistence, owner-token forwarding or activation.
 * The fixed project and publishable key cannot bypass RLS. Decoded JWT fields
 * are just preflight constraints until this exact token is verified by Auth and
 * the RPC derives its own principal from the provider's verified JWT context.
 */
export function createLogoStorageAuthorization(configuration: unknown = null,
  dependencies: LogoStorageDependencies = { fetch: globalThis.fetch }): LogoStorageAuthorization | null {
  const parsed = configurationSchema.safeParse(configuration);
  if (!parsed.success || typeof dependencies.fetch !== "function") return null;
  const c = parsed.data, now = dependencies.now ?? Date.now;
  let sessionId: string, expires: number;
  try {
    const claims = decodeJwt(c.accessToken);
    sessionId = logoUuidSchema.parse(claims.session_id);
    if (claims.sub !== c.authUserId || claims.role !== "authenticated" || claims.aud !== "authenticated"
      || claims.iss !== `${ORIGIN}/auth/v1` || claims.is_anonymous !== false
      || !Number.isSafeInteger(claims.exp) || claims.exp! <= 0) return null;
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
  const rpc = (name: "logo_storage_session" | "authorize_logo_storage_reservation", body: object, signal: AbortSignal) =>
    json(`${ORIGIN}/rest/v1/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, signal);
  function matchingSession(raw: unknown) {
    const result = sessionSchema.parse(raw);
    if (result.ownerId !== c.ownerId || result.authUserId !== c.authUserId || result.sessionId !== sessionId
      || result.workerRoleName !== c.workerRoleName || result.workerRoleOid !== c.workerRoleOid || result.workerId !== c.workerId) throw unavailable();
  }
  async function verifyAuth(signal: AbortSignal) {
    const user = z.object({ id: z.literal(c.authUserId), is_anonymous: z.literal(false) }).parse(await json(`${ORIGIN}/auth/v1/user`, { method: "GET" }, signal));
    if (user.id !== c.authUserId) throw unavailable();
  }
  return Object.freeze({
    close() { lifetime.abort(); },
    async assertAvailable(scope) {
      if (scope.ownerId !== c.ownerId || scope.operation !== "identity.logo_concept") throw unavailable();
      await bounded(undefined, async signal => { await verifyAuth(signal); matchingSession(await rpc("logo_storage_session", {}, signal)); });
    },
    async authorize(input, callerSignal) {
      return bounded(callerSignal, async signal => {
        // Zod clones before awaiting; each capability retains its own reservation.
        const scope = scopeSchema.parse(input), row = scope.reservation, ref = row.reference;
        if (scope.ownerId !== c.ownerId || ref.ownerId !== scope.ownerId || ref.projectId !== scope.projectId
          || row.storagePath !== `${ref.ownerId}/${ref.projectId}/${ref.assetId}/${ref.versionId}`) throw unavailable();
        await verifyAuth(signal);
        const grant = grantSchema.parse(await rpc("authorize_logo_storage_reservation", { p_job: scope.jobId, p_lease: scope.leaseToken, p_reservation: row.id }, signal));
        const { jobId, leaseToken, reservation, ...session } = grant; matchingSession(session);
        if (jobId !== scope.jobId || leaseToken !== scope.leaseToken || JSON.stringify(reservation) !== JSON.stringify(row)) throw unavailable();
        const url = `${ORIGIN}/storage/v1/object/fluid-assets/${row.storagePath}`;
        const storage = createSupabasePrivateAssetStorage({ scope: { kind: "identity", ownerId: scope.ownerId, projectId: scope.projectId }, maxFileBytes: row.byteLength,
          transport: async (target, init) => {
            if (target !== url || !["POST", "GET"].includes(init.method ?? "") || !init.signal
              || init.method === "POST" && new Headers(init.headers).get("x-upsert") !== "false") throw unavailable();
            return request(target, init, init.signal);
          },
        });
        const check = (bytes: Uint8Array, mime: string) => {
          if (!(bytes instanceof Uint8Array) || bytes.byteLength !== row.byteLength || mime !== row.mimeType
            || createHash("sha256").update(bytes).digest("hex") !== ref.contentHash) throw unavailable();
        };
        return Object.freeze({
          async putIfAbsent(input: Uint8Array, mime: string, currentSignal?: AbortSignal) {
            active(callerSignal); if (!(input instanceof Uint8Array)) throw unavailable();
            const bytes = new Uint8Array(input); check(bytes, mime);
            await bounded(AbortSignal.any([...(callerSignal ? [callerSignal] : []), ...(currentSignal ? [currentSignal] : [])]), s => storage.putIfAbsent(row.storagePath, bytes, mime, s));
          },
          async read(currentSignal?: AbortSignal) {
            active(callerSignal);
            return bounded(AbortSignal.any([...(callerSignal ? [callerSignal] : []), ...(currentSignal ? [currentSignal] : [])]), async s => {
              const result = await storage.read(row.storagePath, s); check(result.bytes, result.mimeType); return result;
            });
          },
        });
      });
    },
  } satisfies LogoStorageAuthorization);
}
