import "server-only";
import { decodeJwt } from "jose";
import { z } from "zod";

export const storageUnavailable = () => Error("Shared slot Storage is unavailable");
export function storageOrigin(raw: unknown): string {
  const parsed = z.url().safeParse(raw); if (!parsed.success) throw storageUnavailable();
  const url = new URL(parsed.data);
  if (url.origin !== raw || url.username || url.password || !(url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1"
    && Number(url.port) >= 1024 && Number(url.port) <= 65535)) throw storageUnavailable();
  return url.origin;
}
export function storagePublicKey(raw: unknown, origin: string): string {
  const key = z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/u).parse(raw);
  if (/^sb_publishable_[A-Za-z0-9_-]{1,500}$/u.test(key)) return key;
  // Official local CLI fixtures may expose the legacy public anon JWT. This
  // rejection check never authenticates it; Auth/Storage still verify the key.
  if (origin.startsWith("http://127.0.0.1:") && decodeJwt(key).role === "anon") return key;
  throw storageUnavailable();
}
export const slotSessionSchema = z.strictObject({ version: z.literal(1), slotId: z.uuid(), instanceId: z.uuid(), generation: z.number().int().positive(),
  roleName: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u), roleOid: z.number().int().min(1).max(4_294_967_295), authUserId: z.uuid(), sessionId: z.uuid() });
export type SharedStorageSession = Readonly<{ authUserId: string; sessionId: string; tokenProvider(signal?: AbortSignal): Promise<string>; close(): Promise<void> }>;

/** Exact destination and body bounds apply even to an injected transport. No
 * redirect, provider error message, URL, response body or credential escapes. */
export async function storageFetch(transport: typeof fetch, url: string, init: RequestInit, maximum: number): Promise<Response> {
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(init.signal ? [init.signal] : [])]);
  let reject!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, fail) => { reject = fail; });
  const abort = () => reject(storageUnavailable()); signal.addEventListener("abort", abort, { once: true });
  const operation = (async () => {
    signal.throwIfAborted(); let response: Response | undefined;
    try {
      response = await transport(url, { ...init, signal, redirect: "error", cache: "no-store", credentials: "omit" });
      if (signal.aborted || response.redirected || response.url && response.url !== url || response.status >= 300 && response.status < 400) throw storageUnavailable();
      if (!response.body) return new Response(null, { status: response.status, headers: response.headers });
      const reader = response.body.getReader(), parts: Uint8Array[] = []; let length = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener("abort", cancel, { once: true });
      try { while (true) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
        if (!(part.value instanceof Uint8Array) || part.value.byteLength > maximum - length) throw storageUnavailable();
        parts.push(new Uint8Array(part.value)); length += part.value.byteLength; } }
      finally { signal.removeEventListener("abort", cancel); void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Cancel settling. */ } }
      return new Response(Buffer.concat(parts), { status: response.status, headers: response.headers });
    } catch { throw storageUnavailable(); }
    finally { void response?.body?.cancel().catch(() => {}); }
  })();
  try { return await Promise.race([operation, stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}
