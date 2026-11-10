import "server-only";
import { z } from "zod";
import { inputTokenCountRequest, readBoundedJson, safeRequestId, type ResponsesRequest } from "../ai/openai-transport";
import { engineOpenAIOrigin, OPENAI_ORIGIN } from "./provider-origin";

// OpenAI Responses in background mode for the generation engine (docs/generation-engine.md).
// A create returns at once with a response id; the workflow sleeps and polls by id, so an
// uncertain outcome is looked up, never re-sent. Calls never retry here: the workflow step
// that makes them decides, using the disposition of each failure.

export const backgroundStatusSchema = z.enum([
  "queued",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "incomplete",
]);
export type BackgroundStatus = z.infer<typeof backgroundStatusSchema>;
const TERMINAL: ReadonlySet<BackgroundStatus> = new Set(["completed", "failed", "cancelled", "incomplete"]);
export const isTerminal = (status: BackgroundStatus) => TERMINAL.has(status);
const envelopeSchema = z.object({
  id: z.string().regex(/^resp_[A-Za-z0-9_-]{1,194}$/u),
  status: backgroundStatusSchema,
});
export type BackgroundResponse = { id: string; status: BackgroundStatus; body: unknown; requestId: string | null };

/**
 * - `retry`: OpenAI didn't accept the request, or asked us to try again (429, 500, 502, 503,
 *   or a connection that never opened). Safe to send again.
 * - `rejected`: OpenAI refused the request itself (other 4xx). Sending it again won't help.
 * - `uncertain`: a create may have been accepted (timeout, dropped connection, 504). Never
 *   re-sent, because a second create could be a second paid response.
 */
export type ProviderDisposition = "retry" | "rejected" | "uncertain";
export class EngineProviderError extends Error {
  constructor(
    readonly disposition: ProviderDisposition,
    readonly status: number | null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`provider_${disposition}`);
    this.name = "EngineProviderError";
  }
}

const RETRY_STATUSES = new Set([429, 500, 502, 503]);
const UNCERTAIN_STATUSES = new Set([408, 409, 504]);
// undici reports these when no connection was ever made, so nothing reached OpenAI.
const CONNECT_ERRORS = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const REQUEST_TIMEOUT_MS = 30_000;

function connectFailure(error: unknown): boolean {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && CONNECT_ERRORS.has(code);
}

function retryAfter(headers: Headers): number | null {
  const ms = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 60_000);
  const seconds = Number(headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 60_000) : null;
}

export interface EngineOpenAI {
  countInputTokens(request: ResponsesRequest): Promise<number>;
  create(request: ResponsesRequest, requestKey: string): Promise<BackgroundResponse>;
  retrieve(responseId: string): Promise<BackgroundResponse>;
  cancel(responseId: string): Promise<BackgroundResponse>;
}

/** The official origin unless a test origin is given (src/server/engine/provider-origin.ts), no
 * redirects. `idempotent` calls (reads, cancel, counting) treat an unknown outcome as retryable;
 * a create never does. */
export function createEngineOpenAI(options: { apiKey: string; fetch?: typeof fetch; origin?: string }): EngineOpenAI {
  const fetcher = options.fetch ?? fetch;
  const responsesUrl = `${options.origin ?? OPENAI_ORIGIN}/v1/responses`;
  async function call(
    method: "GET" | "POST",
    url: string,
    body: ResponsesRequest | undefined,
    idempotent: boolean,
    requestKey?: string,
  ) {
    const unknown = idempotent ? "retry" : "uncertain";
    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          ...(requestKey ? { "X-Client-Request-Id": requestKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new EngineProviderError(connectFailure(error) ? "retry" : unknown, null);
    }
    const requestId = safeRequestId(response.headers.get("x-request-id"));
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const disposition = RETRY_STATUSES.has(response.status)
        ? "retry"
        : UNCERTAIN_STATUSES.has(response.status)
          ? unknown
          : "rejected";
      throw new EngineProviderError(disposition, response.status, retryAfter(response.headers));
    }
    try {
      return { body: await readBoundedJson(response), requestId };
    } catch {
      throw new EngineProviderError(unknown, response.status);
    }
  }
  async function background(
    method: "GET" | "POST",
    url: string,
    body: ResponsesRequest | undefined,
    idempotent: boolean,
    requestKey?: string,
  ): Promise<BackgroundResponse> {
    const result = await call(method, url, body, idempotent, requestKey);
    const envelope = envelopeSchema.safeParse(result.body);
    // An accepted create whose id can't be read is exactly the outcome we can't look up.
    if (!envelope.success) throw new EngineProviderError(idempotent ? "retry" : "uncertain", 200);
    return { id: envelope.data.id, status: envelope.data.status, body: result.body, requestId: result.requestId };
  }
  const responseUrl = (id: string) => {
    if (!envelopeSchema.shape.id.safeParse(id).success) throw new EngineProviderError("rejected", null);
    return `${responsesUrl}/${id}`;
  };
  return {
    async countInputTokens(request) {
      const { body } = await call("POST", `${responsesUrl}/input_tokens`, inputTokenCountRequest(request), true);
      const parsed = z.object({ input_tokens: z.number().int().nonnegative().max(10_000_000) }).safeParse(body);
      if (!parsed.success) throw new EngineProviderError("retry", 200);
      return parsed.data.input_tokens;
    },
    create: (request, requestKey) =>
      background(
        "POST",
        responsesUrl,
        { ...request, background: true, store: false, stream: false },
        false,
        requestKey,
      ),
    // Include is request-scoped: polling must ask for the same research evidence as creation.
    retrieve: (id) =>
      background("GET", `${responseUrl(id)}?include%5B%5D=web_search_call.action.sources`, undefined, true),
    cancel: (id) => background("POST", `${responseUrl(id)}/cancel`, {}, true),
  };
}

let shared: EngineOpenAI | null = null;
/** The engine's OpenAI client from OPENAI_API_KEY; a missing key is a configuration error. */
export function engineOpenAI(): EngineOpenAI {
  if (shared) return shared;
  const key = z
    .string()
    .trim()
    .min(16)
    .max(500)
    .regex(/^[^\s]+$/u)
    .safeParse(process.env.OPENAI_API_KEY);
  if (!key.success) throw new Error("provider_unconfigured");
  shared = createEngineOpenAI({ apiKey: key.data, origin: engineOpenAIOrigin() });
  return shared;
}

const tokens = z.number().int().nonnegative().max(100_000_000);
const usageSchema = z.object({
  input_tokens: tokens,
  output_tokens: tokens,
  input_tokens_details: z
    .object({ cached_tokens: tokens.default(0), cache_write_tokens: tokens.default(0) })
    .default({ cached_tokens: 0, cache_write_tokens: 0 }),
});
export type ResponseUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
};
/** Usage and web searches of any response, including a cancelled or failed one. Null when
 * OpenAI reported no usage, in which case its cost is unknown and recorded as zero. */
export function responseUsage(body: unknown): { usage: ResponseUsage; searchCalls: number } | null {
  const value = body && typeof body === "object" ? (body as { usage?: unknown; output?: unknown }) : {};
  const usage = usageSchema.safeParse(value.usage);
  if (!usage.success) return null;
  const details = usage.data.input_tokens_details;
  if (details.cached_tokens + details.cache_write_tokens > usage.data.input_tokens) return null;
  const searchCalls = Array.isArray(value.output)
    ? value.output.filter(
        (item) =>
          item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "web_search_call" &&
          (item as { action?: { type?: unknown } }).action?.type === "search",
      ).length
    : 0;
  return {
    usage: {
      ...usage.data,
      total_tokens: usage.data.input_tokens + usage.data.output_tokens,
      input_tokens_details: details,
    },
    searchCalls,
  };
}
