import "server-only";
import { MIMEType } from "node:util";
import { z } from "zod";
import { ASSET_MAX_FILE_BYTES } from "@/domain/asset-library";
import { logoUuidSchema } from "@/domain/logo-vector";
import type { IdentityAssetStorage } from "@/server/data/identity-asset-store";
import { ApiError } from "@/server/http/errors";
import { readDevelopmentConfiguration } from "@/server/development/config";
import { qualifySharedSupabaseOrigin } from "./shared-supabase-origin";

// Hosted calls retain the approved project and private bucket. The separate
// server-owned development seam below accepts only the gated loopback target;
// browser input never selects an endpoint, bucket or credential.
const STORAGE_ORIGIN = "https://fricsfwqibyhemknqgyf.supabase.co";
// Uploads use the object route; reads use the authenticated download route
// (what storage-js download() calls). Owner-staging RLS admits staged reads only
// for the `object.get_authenticated` operation, so the plain GET route is denied.
const uploadEndpoint = (origin: string) => `${origin}/storage/v1/object/fluid-assets/`;
const readEndpoint = (origin: string) => `${origin}/storage/v1/object/authenticated/fluid-assets/`;
const ACK_MAX_BYTES = 16_384;
const HOME_MAX_BYTES = 10_485_760;
const DEFAULT_DEADLINE_MS = 10_000;
const scopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("identity"), ownerId: logoUuidSchema, projectId: logoUuidSchema }),
  z.strictObject({ kind: z.literal("home"), ownerId: logoUuidSchema }),
]);
export type SupabasePrivateAssetScope = z.infer<typeof scopeSchema>;
/** Inject an already-authorized server transport. It must preserve URL, method,
 * body, headers, redirect:error and signal; it must not retry, follow redirects,
 * refresh into a different principal or fall back to privileged credentials.
 * This module never reads, creates or installs authentication material. */
export type SupabasePrivateAssetTransport = (url: string, init: RequestInit) => Promise<Response>;
export type SupabasePrivateAssetStorageDependencies = {
  transport: SupabasePrivateAssetTransport;
  /** Isolated local runtime only; hosted callers cannot select another endpoint. */
  developmentSupabaseUrl?: string;
  /** Server-composed shared target; must match the configured project and strict local/hosted qualification. */
  sharedSupabaseOrigin?: string;
  /** Derived by trusted composition from verified auth/current worker context,
   * never copied from a browser owner field. This is a path fence, not auth. */
  scope: SupabasePrivateAssetScope;
  maxFileBytes?: number;
  deadlineMs?: number;
};
const unavailable = () => new ApiError("integration_unavailable");
function mime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 150 &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)
  );
}
/** HTTP media-type parameters describe the representation, not a different
 * asset MIME. Enforce bounded complete syntax before using the standard parser:
 * MIMEType alone intentionally tolerates malformed/duplicate parameters. Byte
 * validators and the outer immutable reservation still verify the actual data. */
function responseMimeEssence(raw: string | null): string | null {
  if (!raw || raw.length > 512) return null;
  const value = raw.replace(/^[ \t]+|[ \t]+$/g, "");
  const essence = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+/.exec(value);
  if (!essence) return null;
  const parameter =
    /[ \t]*;[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*=[ \t]*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[\t\x20\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*")/y;
  const names = new Set<string>();
  let position = essence[0].length;
  while (position < value.length) {
    parameter.lastIndex = position;
    const match = parameter.exec(value),
      name = match?.[1]?.toLowerCase();
    if (!match || !name || names.has(name) || names.size >= 16) return null;
    names.add(name);
    position = parameter.lastIndex;
  }
  try {
    const parsed = new MIMEType(value).essence;
    return mime(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function discard(response: Response) {
  // Cleanup cannot hold the caller hostage if a transport ignores cancellation.
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    /* Already locked/closed. */
  }
}

/** Concrete Supabase Storage REST semantics, checked against storage-js 2.117.2
 * StorageFileApi.uploadOrUpdate/download and official docs on 2026-10-07:
 * https://supabase.com/docs/guides/storage/uploads/standard-uploads
 * https://supabase.com/docs/guides/storage/debugging/error-codes
 *
 * POST + x-upsert:false is create-only. GET /object/authenticated reads the original private object;
 * no public URL, signed URL, transform, overwrite, delete, or cleanup is exposed.
 * The SDK upload does not expose a per-call AbortSignal, and its ordinary Blob
 * download buffers before bounds can be checked, so this uses the same REST
 * endpoints with bounded streaming and injected authenticated transport.
 *
 * This is NOT tenant or lease authorization. The outer backend must reserve/
 * resolve the exact immutable path using a verified principal/current stored
 * lease, enforce source/rights authorization, and recheck after byte I/O. The
 * outer store MUST read/hash/length/MIME-verify after every put, including a
 * duplicate, before observe/commit. Abort/timeout can leave an orphaned immutable
 * object: publication remains uncertain and only the original reservation/key
 * may be reconciled. No late result grants a receipt or triggers a retry.
 *
 * The non-null read also satisfies HomeAttachmentStorage. Supabase 404/NoSuchKey
 * can mask denied access, so it throws rather than claiming confirmed absence.
 * Injection is not evidence that hosted bucket/RLS/principal setup is qualified.
 */
export function createSupabasePrivateAssetStorage(
  dependencies: SupabasePrivateAssetStorageDependencies | null,
): IdentityAssetStorage {
  const parsed = dependencies ? scopeSchema.safeParse(dependencies.scope) : null;
  if (dependencies && (!parsed?.success || typeof dependencies.transport !== "function")) throw unavailable();
  const scope = parsed?.success ? Object.freeze(parsed.data) : null;
  const transport = dependencies?.transport;
  let storageOrigin = STORAGE_ORIGIN;
  if (dependencies?.sharedSupabaseOrigin !== undefined) {
    if (dependencies.developmentSupabaseUrl !== undefined) throw unavailable();
    storageOrigin = qualifySharedSupabaseOrigin(dependencies.sharedSupabaseOrigin);
  }
  if (dependencies?.developmentSupabaseUrl !== undefined) {
    const development = readDevelopmentConfiguration();
    if (!development || development.supabaseUrl !== dependencies.developmentSupabaseUrl) throw unavailable();
    storageOrigin = development.supabaseUrl;
  }
  const ceiling = scope?.kind === "home" ? HOME_MAX_BYTES : ASSET_MAX_FILE_BYTES;
  const maxBytes = dependencies?.maxFileBytes ?? ceiling;
  const deadlineMs = dependencies?.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > ceiling ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 60_000
  )
    throw unavailable();

  function objectUrl(path: string, mode: "upload" | "read") {
    if (!scope || !transport) throw unavailable();
    if (
      dependencies?.developmentSupabaseUrl !== undefined &&
      readDevelopmentConfiguration()?.supabaseUrl !== dependencies.developmentSupabaseUrl
    )
      throw unavailable();
    if (dependencies?.sharedSupabaseOrigin !== undefined)
      qualifySharedSupabaseOrigin(dependencies.sharedSupabaseOrigin);
    if (typeof path !== "string" || path.length > 147) throw new ApiError("not_found");
    const parts = path.split("/");
    if (
      parts.length !== 4 ||
      parts[0] !== scope.ownerId ||
      parts[1] !== (scope.kind === "home" ? "home" : scope.projectId) ||
      !logoUuidSchema.safeParse(parts[2]).success ||
      !logoUuidSchema.safeParse(parts[3]).success
    )
      throw new ApiError("not_found");
    return (mode === "read" ? readEndpoint : uploadEndpoint)(storageOrigin) + path;
  }

  async function bounded<T>(
    callerSignal: AbortSignal | undefined,
    work: (signal: AbortSignal, active: () => void) => Promise<T>,
  ): Promise<T> {
    if (callerSignal?.aborted) throw unavailable();
    const controller = new AbortController(),
      expires = performance.now() + deadlineMs;
    const active = () => {
      if (controller.signal.aborted || performance.now() >= expires) throw unavailable();
    };
    let rejectStopped!: (reason: ApiError) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = reject;
    });
    const stop = () => {
      controller.abort();
      rejectStopped(unavailable());
    };
    const timer = setTimeout(stop, deadlineMs);
    callerSignal?.addEventListener("abort", stop, { once: true });
    try {
      const running = (async () => {
        active();
        const result = await work(controller.signal, active);
        active();
        return result;
      })();
      return await Promise.race([running, stopped]);
    } catch (error) {
      controller.abort();
      // No raw response, URL, body, credential, error cause, or abort reason escapes.
      throw error instanceof ApiError && error.code === "not_found" ? new ApiError("not_found") : unavailable();
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", stop);
    }
  }

  async function request(url: string, init: RequestInit, signal: AbortSignal, active: () => void) {
    active();
    const response = await transport!(url, {
      ...init,
      signal,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
    try {
      active();
      if (
        !(response instanceof Response) ||
        response.redirected ||
        (response.url && response.url !== url) ||
        (response.status >= 300 && response.status < 400)
      )
        throw unavailable();
      return response;
    } catch (error) {
      discard(response);
      throw error;
    }
  }

  async function readBounded(
    response: Response,
    limit: number,
    signal: AbortSignal,
    active: () => void,
  ): Promise<Uint8Array> {
    const length = response.headers.get("content-length"),
      encoding = response.headers.get("content-encoding");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => {
      try {
        void reader?.cancel().catch(() => {});
      } catch {
        /* Cleanup is best effort. */
      }
    };
    try {
      active();
      if (encoding && encoding !== "identity") throw unavailable();
      if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > limit)) throw unavailable();
      if (!response.body) throw unavailable();
      reader = response.body.getReader();
      signal.addEventListener("abort", cancel, { once: true });
      // Coalesce into a geometrically growing bounded buffer. Retaining each tiny
      // chunk separately would permit large per-object allocation overhead.
      let bytes = new Uint8Array(Math.min(limit, 65_536)),
        total = 0;
      while (true) {
        active();
        const result = await reader.read();
        active();
        if (result.done) break;
        if (!(result.value instanceof Uint8Array) || result.value.byteLength > limit - total) throw unavailable();
        const next = total + result.value.byteLength;
        if (next > bytes.byteLength) {
          const grown = new Uint8Array(Math.min(limit, Math.max(next, bytes.byteLength * 2)));
          grown.set(bytes.subarray(0, total));
          bytes = grown;
        }
        // Copy before the next await: a transport may reuse its Buffer backing store.
        bytes.set(result.value, total);
        total = next;
      }
      if (!total || (length !== null && Number(length) !== total)) throw unavailable();
      active();
      return bytes.slice(0, total);
    } catch (error) {
      if (reader) cancel();
      else discard(response);
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      try {
        reader?.releaseLock();
      } catch {
        /* A transport may still be settling a read. */
      }
    }
  }

  async function acknowledgement(
    response: Response,
    signal: AbortSignal,
    active: () => void,
  ): Promise<Record<string, unknown>> {
    if (responseMimeEssence(response.headers.get("content-type")) !== "application/json") {
      discard(response);
      throw unavailable();
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(response, ACK_MAX_BYTES, signal, active)),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw unavailable();
    return value as Record<string, unknown>;
  }

  return {
    async putIfAbsent(path, input, mimeType, signal) {
      const url = objectUrl(path, "upload");
      if (signal?.aborted) throw unavailable();
      if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > maxBytes || !mime(mimeType))
        throw new ApiError("invalid_input");
      // Uint8Array(input) copies Buffers too; Buffer.slice() does not.
      const bytes = new Uint8Array(input);
      await bounded(signal, async (operationSignal, active) => {
        const response = await request(
          url,
          {
            method: "POST",
            headers: {
              "content-type": mimeType,
              "content-length": String(bytes.byteLength),
              "cache-control": "max-age=0",
              "x-upsert": "false",
              "accept-encoding": "identity",
            },
            body: bytes,
          },
          operationSignal,
          active,
        );
        if (response.status !== 200 && response.status !== 409 && response.status !== 400) {
          discard(response);
          throw unavailable();
        }
        const ack = await acknowledgement(response, operationSignal, active);
        active();
        const existingKey =
          typeof ack.code === "string" &&
          ["ResourceAlreadyExists", "KeyAlreadyExists", "already_exists"].includes(ack.code);
        const conflictStatus = ack.statusCode === "409" || ack.statusCode === 409;
        // Older Storage versions wrap an existing-key 409 in HTTP 400. This permits
        // only original-object readback; it is never an upload or content receipt.
        if (
          existingKey &&
          ((response.status === 409 && (ack.statusCode === undefined || conflictStatus)) ||
            (response.status === 400 && conflictStatus))
        )
          return;
        if (response.status !== 200 || !logoUuidSchema.safeParse(ack.Id).success || ack.Key !== `fluid-assets/${path}`)
          throw unavailable();
      });
    },
    async read(path, signal) {
      const url = objectUrl(path, "read");
      return bounded(signal, async (operationSignal, active) => {
        const response = await request(
          url,
          { method: "GET", headers: { "accept-encoding": "identity" } },
          operationSignal,
          active,
        );
        if (response.status !== 200) {
          discard(response);
          throw response.status === 404 ? new ApiError("not_found") : unavailable();
        }
        const mimeType = responseMimeEssence(response.headers.get("content-type"));
        if (!mimeType) {
          discard(response);
          throw unavailable();
        }
        const bytes = await readBounded(response, maxBytes, operationSignal, active);
        active();
        return { bytes, mimeType };
      });
    },
  };
}
