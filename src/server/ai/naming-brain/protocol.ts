import "server-only";
import OpenAI from "openai";
import type { AgentSession, AgentSessionEvent, AgentSessionInputParam, AgentSessionItem } from "openai/resources/beta/agents/agents";
import type { SessionCreateParamsStreaming } from "openai/resources/beta/agents/sessions/sessions";
import type { Turn } from "openai/resources/beta/agents/sessions/turns/turns";

export type ManagedCreateRequest = SessionCreateParamsStreaming;
/** The immutable model selects the approved tier; saved Sol calls stay exact. */
export function namingProgressiveServiceTier(model: string): "default" | "priority" {
  return model === "gpt-6-luna" ? "default" : "priority";
}
export type ManagedToolResult = Extract<AgentSessionInputParam, { type: "agent.session.input.tool_result" }>;
export type ManagedEventStream = { events: AsyncIterable<AgentSessionEvent>; requestId: string | null; close(): void };
export type ManagedHistoryPage<T> = { data: T[]; hasMore: boolean; after: string | null };
export interface NamingManagedProtocol {
  createSession(request: ManagedCreateRequest, signal: AbortSignal): Promise<ManagedEventStream>;
  streamSession(sessionId: string, signal: AbortSignal): Promise<ManagedEventStream>;
  retrieveSession(sessionId: string, signal: AbortSignal): Promise<AgentSession>;
  retrieveTurn(sessionId: string, turnId: string, signal: AbortSignal): Promise<Turn>;
  listTurns(sessionId: string, after: string | null, signal: AbortSignal): Promise<ManagedHistoryPage<Turn>>;
  listItems(sessionId: string, turnId: string, after: string | null, signal: AbortSignal): Promise<ManagedHistoryPage<AgentSessionItem>>;
  submitToolResult(sessionId: string, result: ManagedToolResult, requestKey: string, signal: AbortSignal): Promise<void>;
  cancelSession(sessionId: string, signal: AbortSignal): Promise<void>;
}

export class NamingManagedProtocolError extends Error {
  constructor(readonly code: "request_rejected" | "outcome_unknown" | "protocol_limit", readonly requestId: string | null = null,
    readonly diagnostic: NamingManagedDiagnostic | null = null) { super(code); }
}
export type NamingManagedDiagnostic = { status: number | null; providerCode: string | null; parameter: string | null };
const safeRequestId = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(value) ? value : null;
const providerCodes = new Set(["invalid_request_error", "invalid_value", "invalid_parameter", "invalid_json_schema", "unsupported_parameter", "unknown_parameter", "unsupported_value", "unsupported_model", "model_not_found", "not_found", "context_length_exceeded", "insufficient_quota", "rate_limit_exceeded", "invalid_api_key", "permission_denied", "access_terminated", "billing_hard_limit_reached"]);
const providerParameters = new Set(["agent", "agent_id", "input", "environment", "spend_control", "stream", "metadata", "vault_ids", "agent.model", "agent.instructions", "agent.reasoning", "agent.reasoning.effort", "agent.service_tier", "agent.multi_agent", "agent.multi_agent.enabled", "agent.text", "agent.text.verbosity", "agent.text.format", "agent.text.format.type", "agent.text.format.schema", "agent.tools", "environment.type", "spend_control.limit"]);
function diagnostic(error: InstanceType<typeof OpenAI.APIError>): NamingManagedDiagnostic {
  return { status: typeof error.status === "number" && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : null,
    providerCode: typeof error.code === "string" && providerCodes.has(error.code) ? error.code : null,
    parameter: typeof error.param === "string" && providerParameters.has(error.param) ? error.param : null };
}
function sanitized(error: unknown): NamingManagedProtocolError {
  if (error instanceof NamingManagedProtocolError) return error;
  if (error instanceof OpenAI.APIError) return new NamingManagedProtocolError([400, 401, 403, 404, 413, 422, 429].includes(error.status ?? 0) ? "request_rejected" : "outcome_unknown", safeRequestId(error.requestID), diagnostic(error));
  return new NamingManagedProtocolError("outcome_unknown");
}

/** Bounds the SDK's raw parser input; no provider error/body is logged. */
function boundedFetch(fetcher: typeof fetch, localPrototype: boolean): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, { ...init, redirect: "error" });
    const url = new URL(request.url);
    if (url.origin !== "https://api.openai.com" || !url.pathname.startsWith("/v1/agents/sessions") || url.username || url.password) throw new NamingManagedProtocolError("request_rejected");
    const response = await fetcher(request);
    if (response.redirected || response.url && response.url !== request.url || response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw new NamingManagedProtocolError("outcome_unknown"); }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let size = 0;
    // Token/reasoning events repeat session, turn and item framing. Local streams
    // get 256 times the 512-KiB final JSON envelope; item/output bounds and the
    // stage deadline still apply independently. Native streams retain their cap.
    const maximum = response.headers.get("content-type")?.includes("text/event-stream") ? localPrototype ? 134_217_728 : 4_194_304 : 1_048_576;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { controller.close(); reader.releaseLock(); return; }
          size += chunk.value.byteLength;
          if (size > maximum) { await reader.cancel().catch(() => {}); throw new NamingManagedProtocolError("protocol_limit"); }
          controller.enqueue(chunk.value);
        } catch (error) { controller.error(sanitized(error)); try { reader.releaseLock(); } catch {} }
      },
      async cancel() { await reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
function wrapStream(stream: AsyncIterable<AgentSessionEvent> & { controller: AbortController }, requestId: string | null): ManagedEventStream {
  return { requestId, close: () => stream.controller.abort(), events: (async function* () {
    try { for await (const event of stream) yield event; } catch (error) { throw sanitized(error); }
  })() };
}

/** SDK retries are disabled for every method. A diagnostic request ID does not grant create idempotency. */
export function createNamingManagedProtocol(options: { apiKey: string; localPrototype?: boolean; fetch?: typeof fetch; onDiagnostic?: (diagnostic: NamingManagedDiagnostic) => void }): NamingManagedProtocol {
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: "https://api.openai.com/v1", maxRetries: 0, logLevel: "off", organization: null, project: null,
    fetch: boundedFetch(options.fetch ?? fetch, options.localPrototype === true), fetchOptions: { redirect: "error" } });
  const sessions = client.beta.agents.sessions;
  async function safe<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch (error) {
      const failure = sanitized(error);
      if (failure.diagnostic) {
        // Fixed classifications only. Never retain provider messages, headers,
        // request bodies, credentials, or a raw error object in diagnostics.
        try { if (options.onDiagnostic) options.onDiagnostic(failure.diagnostic); else console.warn("[embel:naming-provider]", failure.diagnostic); } catch {}
      }
      throw failure;
    }
  }
  return {
    createSession: (body, signal) => safe(async () => {
      const localUnlimited = body.metadata?.embel_budget_control === "local_unlimited_v1";
      const progressive = body.metadata?.embel_pipeline_version === "2";
      const contractInvalid = body.metadata?.embel_progressive_contract_version !== undefined
        && (body.metadata.embel_progressive_contract_version !== "2" || !progressive || !localUnlimited);
      const cap = body.spend_control?.limit;
      const budgetInvalid = localUnlimited
        ? !options.localPrototype || Object.hasOwn(body, "spend_control")
        : body.metadata?.embel_budget_control !== undefined || typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1 || cap > 150;
      if (budgetInvalid || contractInvalid || body.metadata?.embel_pipeline_version !== undefined && !progressive || progressive && (!localUnlimited || body.agent?.service_tier !== namingProgressiveServiceTier(body.agent?.model ?? "") || body.agent.text?.verbosity !== "low") || body.environment.type !== "none" || body.agent_id || body.vault_ids?.length || !body.agent?.model || !body.input || body.agent.multi_agent?.enabled || Buffer.byteLength(JSON.stringify(body), "utf8") > 131_072) throw new NamingManagedProtocolError("request_rejected");
      const result = await sessions.create(body, { signal, maxRetries: 0 }).withResponse();
      return wrapStream(result.data, safeRequestId(result.response.headers.get("x-request-id")));
    }),
    streamSession: (sessionId, signal) => safe(async () => {
      const result = await sessions.events.stream(sessionId, { signal, maxRetries: 0 }).withResponse();
      return wrapStream(result.data, safeRequestId(result.response.headers.get("x-request-id")));
    }),
    retrieveSession: (sessionId, signal) => safe(() => sessions.retrieve(sessionId, { signal, maxRetries: 0 })),
    retrieveTurn: (sessionId, turnId, signal) => safe(() => sessions.turns.retrieve(turnId, { session_id: sessionId }, { signal, maxRetries: 0 })),
    listTurns: (sessionId, after, signal) => safe(async () => {
      const page = await sessions.turns.list(sessionId, { order: "asc", limit: 100, ...(after ? { after } : {}) }, { signal, maxRetries: 0 });
      return { data: page.data, hasMore: page.has_more, after: page.data.at(-1)?.id ?? null };
    }),
    listItems: (sessionId, turnId, after, signal) => safe(async () => {
      const page = await sessions.turns.items.list(turnId, { session_id: sessionId, order: "asc", limit: 100, ...(after ? { after } : {}) }, { signal, maxRetries: 0 });
      return { data: page.data, hasMore: page.has_more, after: page.last_id || page.data.at(-1)?.id || null };
    }),
    submitToolResult: (sessionId, result, requestKey, signal) => safe(() => sessions.events.create(sessionId, { "Idempotency-Key": requestKey, events: [result] }, { signal, maxRetries: 0 })),
    cancelSession: (sessionId, signal) => safe(() => sessions.events.create(sessionId, { events: [{ type: "agent.session.input.cancel" }] }, { signal, maxRetries: 0 })),
  };
}
