import "server-only";
import { createHash } from "node:crypto";
import { boundedProviderWork } from "./bounded-request";
import { type ProviderFetch, type ProviderClock, type ProviderJsonFailure } from "./contracts";

/** Only fixed provider adapters construct requests. No URL/header input comes from HTTP clients. */
export async function liveProviderJson(request: Request, fetcher: ProviderFetch, clock: ProviderClock, signal: AbortSignal, allowNotFound = false, decodeJson: (text: string) => unknown = JSON.parse): Promise<{
  status: "ok"; body: unknown; httpStatus: number; observedAt: string; digest: string;
} | ProviderJsonFailure> {
  const result = await boundedProviderWork(async child => {
    const response = await fetcher(new Request(request, { signal: child, redirect: "error", credentials: "omit", cache: "no-store" }));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { if (reader) void reader.cancel().catch(() => {}); else void response.body?.cancel().catch(() => {}); };
    child.addEventListener("abort", cancel, { once: true });
    try {
      const failure = (code: ProviderJsonFailure["code"], retryAfterSeconds: number | null = null) => ({ failed: true as const, code, retryAfterSeconds });
      if (child.aborted) return failure("cancelled");
      if (response.redirected || response.url && response.url !== request.url || response.status >= 300 && response.status < 400) return failure("invalid_response");
      if ([401, 403].includes(response.status)) return failure("not_authorized");
      if (response.status === 429) { const retry = response.headers.get("retry-after"); return failure("rate_limited", retry && /^\d+$/.test(retry) ? Math.min(Number(retry), 86400) : null); }
      if (response.status >= 500) return failure("transport");
      if ((!response.ok && !(allowNotFound && response.status === 404)) || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) return failure("invalid_response");
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      while (!child.aborted) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > 262144 || chunks.length >= 2048) return failure("invalid_response");
        chunks.push(chunk.value);
      }
      if (child.aborted) return failure("cancelled");
      const bytes = Buffer.concat(chunks, size);
      // RFC 7480 §5.3 permits a 404 without an error object. It proves no returned record, never registrability.
      if (allowNotFound && response.status === 404 && size === 0) return { failed: false as const, body: null, httpStatus: response.status, digest: createHash("sha256").update(bytes).digest("hex") };
      try { return { failed: false as const, body: decodeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), httpStatus: response.status, digest: createHash("sha256").update(bytes).digest("hex") }; }
      catch { return failure("invalid_response"); }
    } finally { child.removeEventListener("abort", cancel); cancel(); try { reader?.releaseLock(); } catch {} }
  }, clock, signal);
  if (result.status === "failed") return result;
  return result.value.failed ? { status: "failed", code: result.value.code, retryAfterSeconds: result.value.retryAfterSeconds, observedAt: result.observedAt } :
    { status: "ok", body: result.value.body, httpStatus: result.value.httpStatus, digest: result.value.digest, observedAt: result.observedAt };
}
