import "server-only";
import { z } from "zod";
import type { InputTokenCountParams } from "openai/resources/responses/input-tokens";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_RESPONSE_BYTES = 1_048_576;
// /input_tokens accepts the prompt-bearing subset of a Responses create request.
// Keep the SDK contract exhaustive so a dependency update prompts a review here.
const INPUT_TOKEN_COUNT_FIELDS = {
  conversation: true, input: true, instructions: true, model: true,
  parallel_tool_calls: true, personality: true, previous_response_id: true,
  reasoning: true, text: true, tool_choice: true, tools: true, truncation: true,
} satisfies Record<keyof InputTokenCountParams, true>;
export type ResponsesRequest = Record<string, unknown>;
export type OpenAITransportResponse = { body: unknown; requestId: string | null };
export interface OpenAIResponsesTransport {
  countInputTokens(request: ResponsesRequest, signal: AbortSignal): Promise<number>;
  createResponse(request: ResponsesRequest, requestKey: string, signal: AbortSignal): Promise<OpenAITransportResponse>;
  retrieveResponse?(responseId: string, signal: AbortSignal): Promise<OpenAITransportResponse>;
  cancelResponse?(responseId: string, signal: AbortSignal): Promise<OpenAITransportResponse>;
}

/** Exposes only operational classification; never retain or log raw provider errors. */
export class OpenAITransportError extends Error {
  constructor(readonly code: "request_rejected" | "outcome_unknown", readonly requestId: string | null = null) {
    super(code);
  }
}

export function safeRequestId(value: string | null): string | null {
  return value && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : null;
}

/** The prompt-bearing subset of a create request that /input_tokens accepts. */
export function inputTokenCountRequest(request: ResponsesRequest): ResponsesRequest {
  return Object.fromEntries(Object.entries(request).filter(([field]) => Object.hasOwn(INPUT_TOKEN_COUNT_FIELDS, field)));
}

/** Bounded, strict UTF-8 JSON body read; never buffers more than 1 MiB. */
export async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Response exceeds limit");
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Fixed official origin, no redirects and no retries, including after timeouts. */
export function createOpenAIResponsesTransport(options: { apiKey: string; fetch?: typeof fetch }): OpenAIResponsesTransport {
  const fetcher = options.fetch ?? fetch;
  const request = async (method: "GET" | "POST", url: string, body: ResponsesRequest | undefined, signal: AbortSignal, requestKey?: string) => {
    let requestId: string | null = null;
    try {
      const response = await fetcher(url, {
        method, redirect: "error", signal,
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json",
          ...(requestKey ? { "X-Client-Request-Id": requestKey } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      requestId = safeRequestId(response.headers.get("x-request-id"));
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        // A confirmed request rejection did not run inference. Timeout/conflict/server
        // failures can follow acceptance and must retain the reservation.
        const rejected = [400, 401, 403, 404, 413, 422, 429].includes(response.status);
        throw new OpenAITransportError(rejected ? "request_rejected" : "outcome_unknown", requestId);
      }
      return { body: await readBoundedJson(response), requestId };
    } catch (error) {
      if (error instanceof OpenAITransportError) throw error;
      throw new OpenAITransportError("outcome_unknown", requestId);
    }
  };
  const post = (url: string, body: ResponsesRequest, signal: AbortSignal, requestKey?: string) => request("POST", url, body, signal, requestKey);
  const responseUrl = (id: string) => {
    if (!/^resp_[A-Za-z0-9_-]{1,194}$/u.test(id)) throw new Error("Invalid response identity");
    return `${OPENAI_RESPONSES_URL}/${id}`;
  };
  return {
    async countInputTokens(request, signal) {
      const { body } = await post(`${OPENAI_RESPONSES_URL}/input_tokens`, inputTokenCountRequest(request), signal);
      return z.object({ input_tokens: z.number().int().nonnegative().max(10_000_000) }).parse(body).input_tokens;
    },
    createResponse: (request, requestKey, signal) => post(OPENAI_RESPONSES_URL, request, signal, requestKey),
    // Include is request-scoped: polling must request the same research evidence
    // as creation, otherwise completed responses omit consulted source URLs.
    retrieveResponse: (id, signal) => request("GET", `${responseUrl(id)}?include%5B%5D=web_search_call.action.sources`, undefined, signal),
    cancelResponse: (id, signal) => post(`${responseUrl(id)}/cancel`, {}, signal),
  };
}
