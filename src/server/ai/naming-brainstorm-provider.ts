import "server-only";
import OpenAI from "openai";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "openai/resources/responses/responses";
import { namingBrainstormRequestIdSchema, namingBrainstormResponseIdSchema, namingBrainstormWireSchema, type NamingBrainstormWire } from "../../domain/naming-brainstorm";

export type NamingBrainstormStream = { events: AsyncIterable<ResponseStreamEvent>; requestId: string | null; close(): void };
export interface NamingBrainstormProvider {
  create(request: NamingBrainstormWire, signal: AbortSignal): Promise<NamingBrainstormStream>;
  retrieve(responseId: string, signal: AbortSignal): Promise<{ response: Record<string, unknown>; requestId: string | null }>;
  cancel(responseId: string, signal: AbortSignal): Promise<void>;
}
export class NamingBrainstormProviderError extends Error {
  constructor(readonly code: "request_rejected" | "outcome_unknown" | "protocol_limit", readonly requestId: string | null = null) { super(code); }
}
const requestId = (value: unknown) => { const parsed = namingBrainstormRequestIdSchema.safeParse(value); return parsed.success ? parsed.data : null; };
function sanitized(error: unknown): NamingBrainstormProviderError {
  if (error instanceof NamingBrainstormProviderError) return error;
  if (error instanceof OpenAI.APIError) return new NamingBrainstormProviderError([400,401,403,404,413,422,429].includes(error.status ?? 0) ? "request_rejected" : "outcome_unknown", requestId(error.requestID));
  return new NamingBrainstormProviderError("outcome_unknown");
}
/** Restrict the SDK to Responses, with bounded bytes before JSON/SSE parsing. */
function boundedFetch(fetcher: typeof fetch): typeof fetch {
  return async (incoming, init) => {
    const request = new Request(incoming, { ...init, redirect: "error" }), url = new URL(request.url);
    const resource = /^\/v1\/responses\/resp_[A-Za-z0-9_-]{1,194}$/u.test(url.pathname), cancellation = /^\/v1\/responses\/resp_[A-Za-z0-9_-]{1,194}\/cancel$/u.test(url.pathname);
    if (url.origin !== "https://api.openai.com" || url.username || url.password || !(request.method === "GET" && resource || request.method === "POST" && (url.pathname === "/v1/responses" || cancellation))) throw new NamingBrainstormProviderError("request_rejected");
    const response = await fetcher(request);
    if (response.redirected || response.url && response.url !== request.url || response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw new NamingBrainstormProviderError("outcome_unknown"); }
    if (!response.body) return response;
    const reader = response.body.getReader(), maximum = response.headers.get("content-type")?.includes("text/event-stream") ? 8_388_608 : 1_048_576;
    let size = 0;
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      try { const chunk = await reader.read(); if (chunk.done) { controller.close(); reader.releaseLock(); return; }
        size += chunk.value.byteLength; if (size > maximum) { await reader.cancel().catch(() => {}); throw new NamingBrainstormProviderError("protocol_limit"); } controller.enqueue(chunk.value);
      } catch (error) { controller.error(sanitized(error)); try { reader.releaseLock(); } catch {} }
    }, async cancel() { await reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} } });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
/** SDK retries are always zero; only the SQL-admitted engine may create work. */
export function createNamingBrainstormProvider(options: { apiKey: string; fetch?: typeof fetch }): NamingBrainstormProvider {
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: "https://api.openai.com/v1", maxRetries: 0, logLevel: "off", organization: null, project: null, fetch: boundedFetch(options.fetch ?? fetch), fetchOptions: { redirect: "error" } });
  async function safe<T>(action: () => Promise<T>): Promise<T> { try { return await action(); } catch (error) { throw sanitized(error); } }
  return {
    create: (body, signal) => safe(async () => {
      const parsed = namingBrainstormWireSchema.parse(body);
      const result = await client.responses.create(parsed as unknown as ResponseCreateParamsStreaming, { signal, maxRetries: 0 }).withResponse();
      return { requestId: requestId(result.response.headers.get("x-request-id")), close: () => result.data.controller.abort(), events: (async function* () { try { for await (const event of result.data) yield event; } catch (error) { throw sanitized(error); } })() };
    }),
    retrieve: (id, signal) => safe(async () => { namingBrainstormResponseIdSchema.parse(id); const result = await client.responses.retrieve(id, { stream: false }, { signal, maxRetries: 0 }).withResponse(); return { response: result.data as unknown as Record<string, unknown>, requestId: requestId(result.response.headers.get("x-request-id")) }; }),
    cancel: (id, signal) => safe(async () => { namingBrainstormResponseIdSchema.parse(id); await client.responses.cancel(id, { signal, maxRetries: 0 }); }),
  };
}
