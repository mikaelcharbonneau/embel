import "server-only";
import OpenAI from "openai";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "openai/resources/responses/responses";
import { namingResponsesWireSchema, type NamingResponsesWire } from "../../../domain/naming-responses";
import { namingResponsesProductionReadiness } from "./budget";

export type NamingResponsesResponse = Record<string, unknown>;
export type NamingResponsesStream = { events: AsyncIterable<ResponseStreamEvent>; requestId: string | null; close(): void };
export type NamingResponsesRead = { response: NamingResponsesResponse; requestId: string | null };
export interface NamingResponsesProtocol {
  assertCreateAvailable(): void;
  create(body: NamingResponsesWire, signal: AbortSignal): Promise<NamingResponsesStream>;
  retrieve(responseId: string, signal: AbortSignal): Promise<NamingResponsesRead>;
  stream(responseId: string, afterSequenceNumber: number | null, signal: AbortSignal): Promise<NamingResponsesStream>;
  cancel(responseId: string, signal: AbortSignal): Promise<void>;
}

/** Operational classifications only: no provider message, body, key or header. */
export class NamingResponsesProtocolError extends Error {
  constructor(readonly code: "creation_unavailable" | "request_rejected" | "outcome_unknown" | "protocol_limit", readonly requestId: string | null = null) { super(code); }
}
const safeRequestId = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(value) ? value : null;
export const isNamingResponseId = (value: unknown): value is string => typeof value === "string" && /^resp_[A-Za-z0-9_-]{1,194}$/u.test(value);
function sanitized(error: unknown): NamingResponsesProtocolError {
  if (error instanceof NamingResponsesProtocolError) return error;
  if (error instanceof OpenAI.APIError) return new NamingResponsesProtocolError([400, 401, 403, 404, 413, 422, 429].includes(error.status ?? 0) ? "request_rejected" : "outcome_unknown", safeRequestId(error.requestID));
  return new NamingResponsesProtocolError("outcome_unknown");
}

/** Bounds bytes before the SDK JSON/SSE parser. Redirects and unrelated API
 * methods are rejected even if an SDK/environment default changes. */
function boundedFetch(fetcher: typeof fetch): typeof fetch {
  return async (incoming, init) => {
    const request = new Request(incoming, { ...init, redirect: "error" }), url = new URL(request.url);
    const resource = /^\/v1\/responses\/resp_[A-Za-z0-9_-]{1,194}$/u.test(url.pathname);
    const cancellation = /^\/v1\/responses\/resp_[A-Za-z0-9_-]{1,194}\/cancel$/u.test(url.pathname);
    if (url.origin !== "https://api.openai.com" || url.username || url.password
      || !(request.method === "GET" && resource || request.method === "POST" && (url.pathname === "/v1/responses" || cancellation))) throw new NamingResponsesProtocolError("request_rejected");
    const response = await fetcher(request);
    if (response.redirected || response.url && response.url !== request.url || response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {}); throw new NamingResponsesProtocolError("outcome_unknown");
    }
    if (!response.body) return response;
    const maximum = response.headers.get("content-type")?.includes("text/event-stream") ? 33_554_432 : 2_097_152;
    const reader = response.body.getReader(); let size = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { controller.close(); reader.releaseLock(); return; }
          size += chunk.value.byteLength;
          if (size > maximum) { await reader.cancel().catch(() => {}); throw new NamingResponsesProtocolError("protocol_limit"); }
          controller.enqueue(chunk.value);
        } catch (error) { controller.error(sanitized(error)); try { reader.releaseLock(); } catch {} }
      },
      async cancel() { await reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
function wrapped(stream: AsyncIterable<ResponseStreamEvent> & { controller: AbortController }, requestId: string | null): NamingResponsesStream {
  return { requestId, close: () => stream.controller.abort(), events: (async function* () {
    try { for await (const event of stream) yield event; } catch (error) { throw sanitized(error); }
  })() };
}

/** The injected HTTP seam is for hermetic tests, not a production readiness
 * override. Default creation remains unavailable; known-response reads and
 * cancellation do not create or continue paid model work. */
export function createNamingResponsesProtocol(options: { apiKey: string; fetch?: typeof fetch }): NamingResponsesProtocol {
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: "https://api.openai.com/v1", maxRetries: 0, logLevel: "off", organization: null, project: null,
    fetch: boundedFetch(options.fetch ?? fetch), fetchOptions: { redirect: "error" } });
  function assertCreateAvailable() {
    if (!options.fetch && !namingResponsesProductionReadiness().available) throw new NamingResponsesProtocolError("creation_unavailable");
  }
  function responseIdentity(value: string) { if (!isNamingResponseId(value)) throw new NamingResponsesProtocolError("request_rejected"); }
  async function safe<T>(action: () => Promise<T>): Promise<T> { try { return await action(); } catch (error) { throw sanitized(error); } }
  return {
    assertCreateAvailable,
    create: (body, signal) => safe(async () => {
      assertCreateAvailable();
      const parsed = namingResponsesWireSchema.parse(body);
      const result = await client.responses.create(parsed as unknown as ResponseCreateParamsStreaming, { signal, maxRetries: 0 }).withResponse();
      return wrapped(result.data, safeRequestId(result.response.headers.get("x-request-id")));
    }),
    retrieve: (id, signal) => safe(async () => {
      responseIdentity(id);
      const result = await client.responses.retrieve(id, { include: ["reasoning.encrypted_content", "web_search_call.action.sources"], stream: false }, { signal, maxRetries: 0 }).withResponse();
      return { response: result.data as unknown as NamingResponsesResponse, requestId: safeRequestId(result.response.headers.get("x-request-id")) };
    }),
    stream: (id, after, signal) => safe(async () => {
      responseIdentity(id);
      if (after !== null && (!Number.isSafeInteger(after) || after < 0)) throw new NamingResponsesProtocolError("request_rejected");
      const result = await client.responses.retrieve(id, { stream: true, include: ["reasoning.encrypted_content", "web_search_call.action.sources"], ...(after === null ? {} : { starting_after: after }) }, { signal, maxRetries: 0 }).withResponse();
      return wrapped(result.data, safeRequestId(result.response.headers.get("x-request-id")));
    }),
    cancel: (id, signal) => safe(async () => {
      responseIdentity(id);
      // Cancellation acceptance is deliberately not exposed as terminal proof.
      await client.responses.cancel(id, { signal, maxRetries: 0 });
    }),
  };
}
