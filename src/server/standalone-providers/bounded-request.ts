import "server-only";
import { createHash } from "node:crypto";
import { PROVIDER_PAGE_PAYLOAD_MAX_UTF8_BYTES } from "@/domain/standalone-provider-evidence";
import {
  providerRequestSchema,
  providerTime,
  transportDependenciesSchema,
  PROVIDER_DEADLINE_MS,
  type ProviderRequest,
  type ProviderFetch,
  type ProviderClock,
  type ProviderJsonResult,
  type ProviderJsonFailure,
} from "./contracts";

/** A deadline fences publication even if an injected transport ignores abort. */
export async function boundedProviderWork<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  clock: ProviderClock,
  caller: AbortSignal,
  remainingMs = PROVIDER_DEADLINE_MS,
): Promise<{ status: "done"; value: T; observedAt: string } | ProviderJsonFailure> {
  const start = providerTime(clock);
  if (caller.aborted) return { status: "failed", code: "cancelled", retryAfterSeconds: null, observedAt: start.iso };
  if (remainingMs <= 0) return { status: "failed", code: "timeout", retryAfterSeconds: null, observedAt: start.iso };
  const controller = new AbortController();
  let stop!: (value: { code: "cancelled" | "timeout" }) => void;
  const stopped = new Promise<{ code: "cancelled" | "timeout" }>((resolve) => {
    stop = resolve;
  });
  const cancel = () => {
    stop({ code: "cancelled" });
    controller.abort();
  };
  caller.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    stop({ code: "timeout" });
    controller.abort();
  }, remainingMs);
  try {
    const result = await Promise.race([
      stopped,
      Promise.resolve()
        .then(async () =>
          controller.signal.aborted ? { code: "cancelled" as const } : { value: await operation(controller.signal) },
        )
        .catch(() => ({ code: "transport" as const })),
    ]);
    const end = providerTime(clock);
    if (end.ms < start.ms) throw new RangeError("Invalid provider clock");
    const code = caller.aborted
      ? "cancelled"
      : end.ms - start.ms >= remainingMs
        ? "timeout"
        : "code" in result
          ? (result.code ?? "transport")
          : null;
    if (code !== null) return { status: "failed", code, retryAfterSeconds: null, observedAt: end.iso };
    return { status: "done", value: (result as { value: T }).value, observedAt: end.iso };
  } finally {
    clearTimeout(timer);
    caller.removeEventListener("abort", cancel);
    controller.abort();
  }
}

type Decoded =
  | { body: unknown; responseSha256: string; providerRequestId: string | null }
  | { code: ProviderJsonFailure["code"]; retryAfterSeconds: number | null };
export async function requestProviderJson(
  input: ProviderRequest,
  dependencies: { fetch: ProviderFetch; clock: ProviderClock },
  signal: AbortSignal,
): Promise<ProviderJsonResult> {
  const parsed = providerRequestSchema.safeParse(input),
    deps = transportDependenciesSchema.safeParse(dependencies);
  if (!parsed.success || !deps.success) throw new TypeError("Invalid provider request");
  const request = parsed.data;
  const result = await boundedProviderWork<Decoded>(
    async (operationSignal) => {
      const registrar = request.endpoint === "cloudflare_check";
      const url = registrar
        ? `https://api.cloudflare.com/client/v4/accounts/${request.accountId}/registrar/domain-check`
        : `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(request.handle)}`;
      const response = await deps.data.fetch(
        new Request(url, {
          method: registrar ? "POST" : "GET",
          ...(registrar
            ? { body: JSON.stringify({ domains: [request.domain] }), headers: { "content-type": "application/json" } }
            : {}),
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          signal: operationSignal,
        }),
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancelReader = () => {
        if (reader) {
          void reader.cancel().catch(() => {});
          try {
            reader.releaseLock();
          } catch {}
        } else {
          void response.body?.cancel().catch(() => {});
        }
      };
      operationSignal.addEventListener("abort", cancelReader, { once: true });
      try {
        const invalid = { code: "invalid_response" as const, retryAfterSeconds: null };
        if (operationSignal.aborted) return { code: "cancelled", retryAfterSeconds: null };
        if (
          response.redirected ||
          (response.url && response.url !== url) ||
          (response.status >= 300 && response.status < 400)
        )
          return invalid;
        if (response.status === 401 || response.status === 403)
          return { code: "not_authorized", retryAfterSeconds: null };
        if (response.status === 429) {
          const retry = response.headers.get("retry-after");
          return {
            code: "rate_limited",
            retryAfterSeconds: retry !== null && /^\d+$/.test(retry) ? Math.min(Number(retry), 86_400) : null,
          };
        }
        if (response.status >= 500) return { code: "transport", retryAfterSeconds: null };
        if (
          !response.ok ||
          !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
          !response.body
        )
          return invalid;
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (!operationSignal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > PROVIDER_PAGE_PAYLOAD_MAX_UTF8_BYTES) return invalid;
          chunks.push(chunk.value);
        }
        if (operationSignal.aborted) return { code: "cancelled", retryAfterSeconds: null };
        const bytes = Buffer.concat(chunks, size);
        try {
          const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          const correlation = registrar ? response.headers.get("cf-ray") : null;
          return {
            body,
            responseSha256: createHash("sha256").update(bytes).digest("hex"),
            providerRequestId: correlation && /^[A-Za-z0-9-]{1,200}$/.test(correlation) ? correlation : null,
          };
        } catch {
          return invalid;
        }
      } finally {
        operationSignal.removeEventListener("abort", cancelReader);
        cancelReader();
      }
    },
    deps.data.clock,
    signal,
  );
  if (result.status === "failed") return result;
  if ("code" in result.value) return { status: "failed", ...result.value, observedAt: result.observedAt };
  return { status: "ok", ...result.value, observedAt: result.observedAt };
}
