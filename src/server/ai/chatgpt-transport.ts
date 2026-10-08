import "server-only";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

// SIWC preview contract checked 2026-10-03. OAuth creation/refresh belongs to the
// local session manager. This module never reads an API key or changes billing.
const API_ORIGIN = "https://api.openai.com/v1";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
export type ChatGPTSession = { accountId: string; accessToken: string; expiresAt: number; scopes: readonly string[] };
export type ChatGPTModel = { slug: string; displayName: string };
export type ChatGPTHistoryItem = { role: "user" | "assistant"; content: string };
export type ChatGPTResponseRequest = {
  model: string; instructions: string; input: ChatGPTHistoryItem[];
  text?: { format: { type: "json_schema"; name: string; strict: true; schema: Record<string, unknown> } };
  tools?: Array<{ type: "web_search"; search_context_size: "low"; return_token_budget: "default" }>;
  tool_choice?: "none" | "required";
  include?: Array<"web_search_call.action.sources">;
};
export type ChatGPTRecovery = "sign_in" | "enable_plan_usage" | "view_usage" | "retry_later" | "review_policy" | "fix_request" | "manual_review" | "none";
export type ChatGPTFailure = {
  code: string; providerCode: string | null; providerParam: string | null;
  httpStatus: number | null; bodyShape: "error" | "detail" | "unrecognized" | "empty";
  requestId: string | null; responseId: string | null; dispatched: boolean; recovery: ChatGPTRecovery;
};
export type ChatGPTStreamOutcome =
  | { status: "completed"; response: unknown; partialText: string; requestId: string | null; responseId: string; accountId: string }
  | { status: "failed" | "incomplete" | "interrupted" | "cancelled" | "unavailable"; failure: ChatGPTFailure; partialText: string };
export type ChatGPTStreamLimits = { maxInputBytes: number; maxOutputBytes: number; maxStreamBytes: number; deadlineMs: number; maxObservedWebSearchCalls: number };
export const CHATGPT_STREAM_LIMITS: Readonly<ChatGPTStreamLimits> = Object.freeze({
  maxInputBytes: 131_072, maxOutputBytes: 262_144, maxStreamBytes: 2_097_152,
  deadlineMs: 240_000, maxObservedWebSearchCalls: 2,
});
export interface ChatGPTTransport {
  listModels(signal: AbortSignal): Promise<{ accountId: string; models: ChatGPTModel[] }>;
  streamResponse(request: ChatGPTResponseRequest, options: {
    expectedAccountId: string; signal: AbortSignal; limits?: Partial<ChatGPTStreamLimits>;
    onTextDelta?: (delta: string) => void | Promise<void>;
    beforeDispatch?: () => void | Promise<void>;
    /** Optional synchronous host fence, captured before preflight and checked
     * once at physical dispatch. Omission preserves existing callers. */
    acceptingWork?: () => boolean;
  }): Promise<ChatGPTStreamOutcome>;
}

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.:-]+$/);
const modelId = z.string().min(1).max(150).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const sessionSchema = z.object({ accountId: id, accessToken: z.string().min(16).max(16_384).regex(/^[a-zA-Z0-9._~+/-]+=*$/),
  expiresAt: z.number().int().positive(), scopes: z.array(z.string()).max(100) });
const requestSchema = z.strictObject({
  model: modelId, instructions: z.string().min(1).max(30_000),
  input: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().max(131_072) })).min(1).max(100),
  text: z.strictObject({ format: z.strictObject({ type: z.literal("json_schema"), name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), strict: z.literal(true), schema: z.record(z.string(), z.unknown()) }) }).optional(),
  tools: z.array(z.strictObject({ type: z.literal("web_search"), search_context_size: z.literal("low"), return_token_budget: z.literal("default") })).max(1).optional(),
  tool_choice: z.enum(["none", "required"]).optional(), include: z.array(z.literal("web_search_call.action.sources")).max(1).optional(),
});
const limitsSchema = z.strictObject({
  maxInputBytes: z.number().int().min(1).max(CHATGPT_STREAM_LIMITS.maxInputBytes),
  maxOutputBytes: z.number().int().min(1).max(CHATGPT_STREAM_LIMITS.maxOutputBytes),
  maxStreamBytes: z.number().int().min(1).max(CHATGPT_STREAM_LIMITS.maxStreamBytes),
  deadlineMs: z.number().int().min(1).max(CHATGPT_STREAM_LIMITS.deadlineMs),
  maxObservedWebSearchCalls: z.number().int().min(0).max(CHATGPT_STREAM_LIMITS.maxObservedWebSearchCalls),
});
const object = z.record(z.string(), z.unknown());
const outputItem = z.object({ id, type: z.string().min(1).max(100) }).passthrough();
const outputIndex = z.number().int().min(0).max(99);
function outputTextBytes(item: Record<string, unknown>): number {
  if (!Array.isArray(item.content)) return 0;
  return item.content.reduce((bytes: number, part: unknown) => {
    const content = object.safeParse(part);
    return bytes + (content.success && content.data.type === "output_text" && typeof content.data.text === "string" ? Buffer.byteLength(content.data.text, "utf8") : 0);
  }, 0);
}
function completedAssistantText(item: Record<string, unknown>): string {
  if (item.type !== "message" || item.role !== "assistant" || item.status !== "completed" || !Array.isArray(item.content)) return "";
  return item.content.map((part: unknown) => {
    const content = object.safeParse(part);
    return content.success && content.data.type === "output_text" && typeof content.data.text === "string" ? content.data.text : "";
  }).join("");
}
const safeCode = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_]{0,159}$/.test(value) ? value : null;
const safeParam = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.[\]-]{1,200}$/.test(value) ? value : null;
const safeId = (value: unknown) => id.safeParse(value).success ? value as string : null;

function recoveryFor(code: string, status: number | null): ChatGPTRecovery {
  if (code === "subscription_sharing_usage_limit_exceeded") return "view_usage";
  if (["subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable"].includes(code)) return "retry_later";
  if (code === "subscription_sharing_unsupported_capability") return "fix_request";
  if (["plan_permission_required"].includes(code)) return "enable_plan_usage";
  if (["sign_in_required", "session_expired", "subscription_sharing_invalid_user"].includes(code) || status === 401) return "sign_in";
  if (["subscription_sharing_user_not_eligible", "subscription_sharing_route_not_supported", "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context"].includes(code) || status === 403) return "review_policy";
  if (status === 503) return "retry_later";
  if (["request_invalid", "input_limit_exceeded", "model_unavailable"].includes(code)) return "fix_request";
  if (code === "cancelled") return "none";
  return "manual_review";
}

export class ChatGPTTransportError extends Error {
  constructor(readonly failure: ChatGPTFailure) { super(failure.code); }
}
function failure(code: string, overrides: Partial<ChatGPTFailure> = {}): ChatGPTFailure {
  const status = overrides.httpStatus ?? null;
  return { code, providerCode: null, providerParam: null, httpStatus: null, bodyShape: "empty",
    requestId: null, responseId: null, dispatched: false, recovery: recoveryFor(code, status), ...overrides };
}
function providerFailure(raw: unknown, base: Partial<ChatGPTFailure>): ChatGPTFailure {
  const parsed = object.safeParse(raw);
  const body = parsed.success ? parsed.data : {};
  const parsedError = object.safeParse(body.error);
  const error = parsedError.success ? parsedError.data : body;
  const code = safeCode(error.code);
  const bodyShape = raw === undefined ? "empty" : parsedError.success || code ? "error" : typeof body.detail === "string" ? "detail" : "unrecognized";
  return failure(code ?? "provider_error", { ...base, providerCode: code, providerParam: safeParam(error.param), bodyShape });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(new Error("Cancelled")); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error("Cancelled")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function boundedJson(response: Response, maximumBytes = 1_048_576): Promise<unknown> {
  if (!response.body) throw new Error("Missing body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0; let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw new Error("Body exceeds limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createChatGPTTransport(options: {
  getSession: () => Promise<ChatGPTSession>; fetch?: typeof fetch; now?: () => number;
  // Server-owned evidence only, scoped to the selected registration by the
  // worker. This must never be populated from a browser model-name parameter.
  getVerifiedModels?: (accountId: string) => Promise<ChatGPTModel[]>;
}): ChatGPTTransport {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const session = async (): Promise<ChatGPTSession> => {
    let raw: unknown;
    try { raw = await options.getSession(); }
    catch (error) {
      const reported = error && typeof error === "object" && "code" in error ? safeCode(error.code) : null;
      const code = reported && ["sign_in_required", "plan_permission_required", "session_unavailable", "invalid_client"].includes(reported) ? reported : "session_unavailable";
      throw new ChatGPTTransportError(failure(code));
    }
    const parsed = sessionSchema.safeParse(raw);
    if (!parsed.success || parsed.data.accessToken.startsWith("sk-")) throw new ChatGPTTransportError(failure("sign_in_required"));
    if (!parsed.data.scopes.includes(DIRECT_SCOPE)) throw new ChatGPTTransportError(failure("plan_permission_required"));
    if (parsed.data.expiresAt <= now()) throw new ChatGPTTransportError(failure("session_expired"));
    return parsed.data;
  };
  const accountStillSelected = async (expected: ChatGPTSession, requireSameToken = false) => {
    const current = await session();
    if (current.accountId !== expected.accountId || (requireSameToken && current.accessToken !== expected.accessToken)) {
      throw new ChatGPTTransportError(failure("account_changed"));
    }
  };
  const modelsFor = async (selected: ChatGPTSession, signal: AbortSignal): Promise<ChatGPTModel[]> => {
    const response = await abortable(fetcher(`${API_ORIGIN}/models`, { method: "GET", redirect: "error", signal,
      headers: { Authorization: `Bearer ${selected.accessToken}`, Accept: "application/json" } }), signal);
    const requestId = safeId(response.headers.get("x-request-id"));
    let body: unknown;
    try { body = await abortable(boundedJson(response), signal); }
    catch { throw new ChatGPTTransportError(failure("model_catalog_unavailable", { httpStatus: response.status, requestId, bodyShape: "unrecognized" })); }
    if (!response.ok) throw new ChatGPTTransportError(providerFailure(body, { httpStatus: response.status, requestId, dispatched: false }));
    const catalog = z.object({ models: z.array(z.object({ slug: modelId, display_name: z.string().trim().min(1).max(200), visibility: z.string() })).max(500) }).safeParse(body);
    if (!catalog.success) throw new ChatGPTTransportError(failure("model_catalog_invalid", { requestId }));
    const providerSlugs = new Set(catalog.data.models.map(model => model.slug));
    if (providerSlugs.size !== catalog.data.models.length) throw new ChatGPTTransportError(failure("model_catalog_invalid", { requestId }));
    const visible = catalog.data.models.filter(model => model.visibility === "list");
    const models = visible.map(model => ({ slug: model.slug, displayName: model.display_name }));
    if (!options.getVerifiedModels) return models;
    const verified = z.array(z.strictObject({ slug: modelId, displayName: z.string().trim().min(1).max(200) })).max(100)
      .safeParse(await abortable(options.getVerifiedModels(selected.accountId), signal));
    if (!verified.success || new Set(verified.data.map(model => model.slug)).size !== verified.data.length) {
      throw new ChatGPTTransportError(failure("model_catalog_invalid", { requestId }));
    }
    // Any explicit provider entry wins, including hidden/unsupported entries.
    // Supplemental records only repair omissions, never provider access rules.
    return [...models, ...verified.data.filter(model => !providerSlugs.has(model.slug))];
  };

  return {
    async listModels(signal) {
      try {
        const selected = await abortable(session(), signal);
        const models = await modelsFor(selected, signal);
        await abortable(accountStillSelected(selected, true), signal);
        if (signal.aborted) throw new ChatGPTTransportError(failure("cancelled"));
        return { accountId: selected.accountId, models };
      } catch (error) {
        if (error instanceof ChatGPTTransportError) throw error;
        throw new ChatGPTTransportError(failure(signal.aborted ? "cancelled" : "model_catalog_unavailable"));
      }
    },
    async streamResponse(rawRequest, streamOptions) {
      const acceptingWork = streamOptions.acceptingWork;
      let partialText = ""; let requestId: string | null = null; let responseId: string | null = null;
      let completedPartialText = "";
      let dispatched = false; let deadlineExceeded = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const controller = new AbortController();
      const abort = () => controller.abort();
      streamOptions.signal.addEventListener("abort", abort, { once: true });
      if (streamOptions.signal.aborted) abort();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const stop = (status: Exclude<ChatGPTStreamOutcome["status"], "completed">, error: ChatGPTFailure): ChatGPTStreamOutcome => ({
        status, failure: { ...error, requestId: error.requestId ?? requestId, responseId: error.responseId ?? responseId, dispatched },
        // Completed item text is still only partial evidence without a terminal
        // response. Preserve it if deltas were omitted/truncated, keeping any
        // already observed continuation. Never concatenate answer copies.
        partialText: completedPartialText && !partialText.startsWith(completedPartialText) ? completedPartialText : partialText,
      });
      try {
        const request = requestSchema.safeParse(rawRequest);
        const parsedLimits = limitsSchema.safeParse({ ...CHATGPT_STREAM_LIMITS, ...streamOptions.limits });
        if (!request.success || !parsedLimits.success || !id.safeParse(streamOptions.expectedAccountId).success) return stop("unavailable", failure("request_invalid"));
        const limits = parsedLimits.data;
        const body = JSON.stringify({ ...request.data, store: false, stream: true });
        if (Buffer.byteLength(body, "utf8") > limits.maxInputBytes) return stop("unavailable", failure("input_limit_exceeded"));
        deadline = setTimeout(() => { deadlineExceeded = true; controller.abort(); }, limits.deadlineMs);
        deadline.unref();
        const selected = await abortable(session(), controller.signal);
        if (selected.accountId !== streamOptions.expectedAccountId) return stop("unavailable", failure("account_changed"));
        const models = await modelsFor(selected, controller.signal);
        if (!models.some(model => model.slug === request.data.model)) return stop("unavailable", failure("model_unavailable"));
        try { await abortable(Promise.resolve(streamOptions.beforeDispatch?.()), controller.signal); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          return stop("unavailable", failure("runtime_policy_unavailable"));
        }
        await abortable(accountStillSelected(selected, true), controller.signal);
        if (controller.signal.aborted) return stop("cancelled", failure(deadlineExceeded ? "deadline_exceeded" : "cancelled"));
        if (acceptingWork !== undefined) {
          try {
            const allowed: unknown = acceptingWork();
            if (allowed !== true) {
              // A mistakenly async guard is never permission. Observe a rejected
              // promise solely to avoid an unhandled rejection; never await it.
              void Promise.resolve(allowed).catch(() => {});
              return stop("unavailable", failure("runtime_policy_unavailable"));
            }
          } catch { return stop("unavailable", failure("runtime_policy_unavailable")); }
          if (controller.signal.aborted) return stop("cancelled", failure(deadlineExceeded ? "deadline_exceeded" : "cancelled"));
        }
        // No await separates this synchronous fence from the actual request.
        // Never reevaluate it after dispatch: retain real streamed evidence.
        dispatched = true;
        const response = await abortable(fetcher(`${API_ORIGIN}/responses`, { method: "POST", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${selected.accessToken}`, "Content-Type": "application/json", Accept: "text/event-stream" }, body }), controller.signal);
        requestId = safeId(response.headers.get("x-request-id"));
        if (!response.ok) {
          let errorBody: unknown;
          try { errorBody = await abortable(boundedJson(response, 65_536), controller.signal); }
          catch { errorBody = undefined; }
          if (controller.signal.aborted) return stop("cancelled", failure(deadlineExceeded ? "deadline_exceeded" : "cancelled"));
          const error = providerFailure(errorBody, { httpStatus: response.status, requestId, dispatched: true });
          // A known admission/quota rejection is terminal. An unexplained timeout,
          // conflict or server failure can follow acceptance and remains uncertain.
          const knownAdmission = response.status === 503 && (error.bodyShape === "detail" || ["subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable"].includes(error.providerCode ?? ""));
          const uncertain = [408, 409].includes(response.status) || (response.status >= 500 && !knownAdmission);
          return stop(uncertain ? "interrupted" : "failed", error);
        }
        // The subscription route can omit Content-Type on a real SSE response.
        // Missing metadata still requires bounded SSE parsing and completion;
        // an explicit incompatible media type never opts into that fallback.
        const contentType = response.headers.get("content-type");
        if ((contentType !== null && contentType.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") || !response.body) return stop("interrupted", failure("stream_invalid"));
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let buffer = ""; let dataLines: string[] = []; let streamBytes = 0; let outputBytes = 0;
        const observedSearches = new Set<string>();
        const itemIdentities = new Map<number, { id: string; type: string }>();
        const itemIndexes = new Map<string, number>();
        const completedItems = new Map<number, z.infer<typeof outputItem>>();
        let completedOutputBytes = 0;
        const dispatchEvent = async (): Promise<ChatGPTStreamOutcome | null> => {
          if (!dataLines.length) return null;
          const data = dataLines.join("\n"); dataLines = [];
          if (data === "[DONE]") return stop("interrupted", failure("stream_missing_completion"));
          const event = object.parse(JSON.parse(data));
          const type = typeof event.type === "string" ? event.type : "";
          if (event.response_id !== undefined) {
            const explicitId = safeId(event.response_id);
            if (!explicitId || (responseId && explicitId !== responseId)) return stop("interrupted", failure("stream_response_mismatch"));
            responseId = explicitId;
          }
          const eventResponse = object.safeParse(event.response);
          if (eventResponse.success) {
            const incomingId = safeId(eventResponse.data.id);
            if (incomingId && responseId && incomingId !== responseId) return stop("interrupted", failure("stream_response_mismatch"));
            responseId = incomingId ?? responseId;
          }
          if (type === "response.output_text.delta") {
            if (typeof event.delta !== "string") return stop("interrupted", failure("stream_invalid"));
            outputBytes += Buffer.byteLength(event.delta, "utf8");
            if (outputBytes > limits.maxOutputBytes) return stop("interrupted", failure("output_limit_exceeded"));
            await abortable(accountStillSelected(selected), controller.signal);
            if (controller.signal.aborted) return stop("cancelled", failure(deadlineExceeded ? "deadline_exceeded" : "cancelled"));
            partialText += event.delta;
            await abortable(Promise.resolve(streamOptions.onTextDelta?.(event.delta)), controller.signal);
          } else if (type === "response.output_item.added" || type === "response.output_item.done") {
            const item = object.safeParse(event.item);
            if (item.success && item.data.type === "web_search_call") {
              const toolId = safeId(item.data.id);
              if (!toolId) return stop("interrupted", failure("stream_invalid"));
              observedSearches.add(toolId);
              if (observedSearches.size > limits.maxObservedWebSearchCalls) return stop("interrupted", failure("observed_tool_limit_exceeded"));
            }
            const index = outputIndex.safeParse(event.output_index);
            const output = outputItem.safeParse(event.item);
            if (!index.success || !output.success) return stop("interrupted", failure("stream_invalid_output_item"));
            const previous = itemIdentities.get(index.data);
            const previousIndex = itemIndexes.get(output.data.id);
            if ((previous && (previous.id !== output.data.id || previous.type !== output.data.type)) ||
                (previousIndex !== undefined && previousIndex !== index.data) || completedItems.has(index.data)) return stop("interrupted", failure("stream_output_mismatch"));
            itemIdentities.set(index.data, { id: output.data.id, type: output.data.type });
            itemIndexes.set(output.data.id, index.data);
            if (type === "response.output_item.done") {
              if (output.data.status !== undefined && output.data.status !== "completed") return stop("interrupted", failure("stream_invalid_output_item"));
              completedOutputBytes += outputTextBytes(output.data);
              if (completedOutputBytes > limits.maxOutputBytes) return stop("interrupted", failure("output_limit_exceeded"));
              completedItems.set(index.data, output.data);
              completedPartialText = [...completedItems].sort(([left], [right]) => left - right)
                .map(([, item]) => completedAssistantText(item)).join("");
            }
          } else if (type === "response.completed") {
            if (!eventResponse.success || eventResponse.data.status !== "completed" || !responseId) return stop("interrupted", failure("stream_invalid_completion"));
            let finalResponse = eventResponse.data;
            const terminalOutput = finalResponse.output;
            if (terminalOutput !== undefined && !Array.isArray(terminalOutput)) return stop("interrupted", failure("stream_invalid_completion"));
            if (Array.isArray(terminalOutput) && terminalOutput.length > 0) {
              const finalItems = z.array(outputItem).max(100).safeParse(terminalOutput);
              if (!finalItems.success) return stop("interrupted", failure("stream_invalid_output_item"));
              if (new Set(finalItems.data.map(item => item.id)).size !== finalItems.data.length || [...itemIdentities].some(([index, item]) =>
                finalItems.data[index]?.id !== item.id || finalItems.data[index]?.type !== item.type) || [...completedItems].some(([index, item]) =>
                !isDeepStrictEqual(item, finalItems.data[index]))) return stop("interrupted", failure("stream_output_mismatch"));
              if (finalItems.data.reduce((bytes, item) => bytes + outputTextBytes(item), 0) > limits.maxOutputBytes) return stop("interrupted", failure("output_limit_exceeded"));
            } else if (itemIdentities.size > 0) {
              // Some subscription streams omit output in response.completed.
              // Only complete, contiguous done events may supply that payload;
              // text deltas and unfinished added items cannot become results.
              if (completedItems.size !== itemIdentities.size) return stop("interrupted", failure("stream_output_mismatch"));
              const ordered = Array.from({ length: completedItems.size }, (_, index) => completedItems.get(index));
              if (ordered.some(item => item === undefined)) return stop("interrupted", failure("stream_output_mismatch"));
              finalResponse = { ...finalResponse, output: ordered };
            }
            await abortable(accountStillSelected(selected), controller.signal);
            if (controller.signal.aborted) return stop("cancelled", failure(deadlineExceeded ? "deadline_exceeded" : "cancelled"));
            return { status: "completed", response: finalResponse, partialText, requestId, responseId, accountId: selected.accountId };
          } else if (type === "response.failed") {
            return stop("failed", providerFailure(eventResponse.success ? eventResponse.data : event, { responseId, requestId, dispatched: true }));
          } else if (type === "response.incomplete") {
            return stop("incomplete", failure("provider_incomplete"));
          } else if (type === "error") {
            return stop("failed", providerFailure(event, { responseId, requestId, dispatched: true }));
          }
          return null;
        };
        while (true) {
          const chunk = await abortable(reader.read(), controller.signal);
          if (chunk.done) break;
          streamBytes += chunk.value.byteLength;
          if (streamBytes > limits.maxStreamBytes) return stop("interrupted", failure("stream_limit_exceeded"));
          buffer += decoder.decode(chunk.value, { stream: true });
          while (true) {
            const newline = /\r\n|\r|\n/.exec(buffer);
            if (!newline || (newline[0] === "\r" && newline.index === buffer.length - 1)) break;
            const line = buffer.slice(0, newline.index); buffer = buffer.slice(newline.index + newline[0].length);
            if (!line) { const terminal = await dispatchEvent(); if (terminal) return terminal; }
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
          }
          if (controller.signal.aborted) return stop("cancelled", failure(deadlineExceeded ? "deadline_exceeded" : "cancelled"));
        }
        // EOF, an unterminated event, or [DONE] alone cannot establish success.
        return stop("interrupted", failure("stream_missing_completion"));
      } catch (error) {
        if (controller.signal.aborted) return stop("cancelled", failure(deadlineExceeded ? "deadline_exceeded" : "cancelled"));
        if (error instanceof ChatGPTTransportError) return stop(dispatched ? "interrupted" : "unavailable", error.failure);
        return stop(dispatched ? "interrupted" : "unavailable", failure(dispatched ? "stream_interrupted" : "connection_unavailable"));
      } finally {
        clearTimeout(deadline);
        streamOptions.signal.removeEventListener("abort", abort);
        controller.abort();
        if (reader) {
          // Cleanup must not replace the already observed provider outcome.
          try { void reader.cancel().catch(() => {}); } catch { /* Best effort. */ }
          try { reader.releaseLock(); } catch { /* Best effort. */ }
        }
      }
    },
  };
}
