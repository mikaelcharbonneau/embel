import "server-only";
import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { namingRequestIdSchema, namingResponseIdSchema } from "../../domain/naming-generation";
import { namingGenerationWireSchema, type NamingGenerationWire } from "../../domain/naming-generation-wire";

/** OpenAI Responses in background mode. `create` only queues the work and returns
 * its receipt number; `retrieve` polls it; `cancel` stops it. The SDK never
 * retries, so only the worker loop decides whether a request is sent. */
export type NamingProviderErrorCode = "request_rejected" | "outcome_unknown" | "protocol_limit";
export class NamingProviderError extends Error {
  constructor(readonly code: NamingProviderErrorCode, readonly requestId: string | null = null, readonly status: number | null = null) { super(code); this.name = "NamingProviderError"; }
}
export type NamingProviderReceipt = { responseId: string; requestId: string | null; status: string };
export interface NamingGenerationProvider {
  create(request: NamingGenerationWire, signal: AbortSignal): Promise<NamingProviderReceipt>;
  retrieve(responseId: string, signal: AbortSignal): Promise<{ response: Record<string, unknown>; requestId: string | null }>;
  cancel(responseId: string, signal: AbortSignal): Promise<void>;
}

export const NAMING_PROVIDER_RESPONSE_BYTES = 1_048_576;
/** OpenAI answers these before any inference starts, so nothing was generated. */
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 413, 422, 429]);
const requestId = (value: unknown) => { const parsed = namingRequestIdSchema.safeParse(value); return parsed.success ? parsed.data : null; };
const status = (value: unknown) => typeof value === "number" && Number.isInteger(value) ? value : null;
/** Only a fixed code, a validated request id and the HTTP status leave this module. */
function sanitized(error: unknown): NamingProviderError {
  if (error instanceof NamingProviderError) return error;
  if (error instanceof OpenAI.APIError) return new NamingProviderError(REJECTED_STATUSES.has(error.status ?? 0) ? "request_rejected" : "outcome_unknown", requestId(error.requestID), status(error.status));
  return new NamingProviderError("outcome_unknown");
}
const RESPONSE_PATH = /^\/v1\/responses\/resp_[A-Za-z0-9_-]{1,194}$/u, CANCEL_PATH = /^\/v1\/responses\/resp_[A-Za-z0-9_-]{1,194}\/cancel$/u;
/** Restrict the SDK to the three Responses calls, with no redirect and a byte
 * bound before any JSON parsing. */
function boundedFetch(fetcher: typeof fetch): typeof fetch {
  return async (incoming, init) => {
    const request = new Request(incoming, { ...init, redirect: "error" }), url = new URL(request.url);
    const allowed = request.method === "GET" && RESPONSE_PATH.test(url.pathname) || request.method === "POST" && (url.pathname === "/v1/responses" || CANCEL_PATH.test(url.pathname));
    if (url.origin !== "https://api.openai.com" || url.username || url.password || url.search || !allowed) throw new NamingProviderError("request_rejected");
    const response = await fetcher(request);
    if (response.redirected || response.url && response.url !== request.url || response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {}); throw new NamingProviderError("outcome_unknown", null, response.status);
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let size = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { controller.close(); reader.releaseLock(); return; }
          size += chunk.value.byteLength;
          if (size > NAMING_PROVIDER_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); throw new NamingProviderError("protocol_limit"); }
          controller.enqueue(chunk.value);
        } catch (error) { controller.error(sanitized(error)); try { reader.releaseLock(); } catch {} }
      },
      async cancel() { await reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export function createNamingGenerationProvider(options: { apiKey: string; fetch?: typeof fetch }): NamingGenerationProvider {
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: "https://api.openai.com/v1", maxRetries: 0, timeout: 60_000, logLevel: "off", organization: null, project: null,
    fetch: boundedFetch(options.fetch ?? fetch), fetchOptions: { redirect: "error" } });
  async function safe<T>(action: () => Promise<T>): Promise<T> { try { return await action(); } catch (error) { throw sanitized(error); } }
  const checkedId = (id: string) => { if (!namingResponseIdSchema.safeParse(id).success) throw new NamingProviderError("request_rejected"); return id; };
  return Object.freeze({
    create: (body: NamingGenerationWire, signal: AbortSignal) => safe(async () => {
      // A request that fails validation is never sent, so it is a rejection.
      const parsed = namingGenerationWireSchema.safeParse(body);
      if (!parsed.success) throw new NamingProviderError("request_rejected");
      const result = await client.responses.create(parsed.data as unknown as ResponseCreateParamsNonStreaming, { signal, maxRetries: 0 }).withResponse();
      const id = namingResponseIdSchema.safeParse(result.data.id), header = requestId(result.response.headers.get("x-request-id"));
      // The request was accepted but its receipt number cannot be used.
      if (!id.success) throw new NamingProviderError("outcome_unknown", header);
      return { responseId: id.data, requestId: header, status: typeof result.data.status === "string" ? result.data.status : "queued" };
    }),
    retrieve: (id: string, signal: AbortSignal) => safe(async () => {
      const result = await client.responses.retrieve(checkedId(id), {}, { signal, maxRetries: 0 }).withResponse();
      return { response: result.data as unknown as Record<string, unknown>, requestId: requestId(result.response.headers.get("x-request-id")) };
    }),
    cancel: (id: string, signal: AbortSignal) => safe(async () => { await client.responses.cancel(checkedId(id), { signal, maxRetries: 0 }); }),
  });
}
