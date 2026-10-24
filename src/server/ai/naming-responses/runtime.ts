import "server-only";
import { isDeepStrictEqual } from "node:util";
import { namingResponsesDispatchSchema, namingResponsesRequestSchema, namingResponsesRunSchema, type NamingResponsesDispatch, type NamingResponsesRequest, type NamingResponsesRun } from "../../../domain/naming-responses";
import { namingHash } from "../naming-brain/identity";
import { createNamingResponsesProtocol, isNamingResponseId, NamingResponsesProtocolError, type NamingResponsesProtocol, type NamingResponsesResponse, type NamingResponsesStream } from "./protocol";

export interface NamingResponsesPersistence {
  load(): Promise<NamingResponsesRun>;
  reserve(request: NamingResponsesRequest): Promise<NamingResponsesDispatch>;
  begin(dispatchKey: string): Promise<boolean>;
  handle(dispatchKey: string, responseId: string): Promise<NamingResponsesDispatch>;
  observe(dispatchKey: string, response: NamingResponsesResponse, requestId: string | null): Promise<NamingResponsesDispatch>;
  reject(dispatchKey: string, requestId: string, code: "provider_request_rejected"): Promise<NamingResponsesDispatch>;
}
export type NamingResponsesOutcome =
  | { status: "completed"; responseId: string; response: NamingResponsesResponse; output: unknown | null; requiresExplicitContinuation: boolean }
  | { status: "terminal"; state: "failed" | "cancelled" | "incomplete"; responseId: string; response: NamingResponsesResponse }
  | { status: "blocked" | "pending" | "unresolved"; code: string; responseId: string | null };
type Hooks = { signal: AbortSignal; observeOnly?: boolean };
const terminal = new Set(["completed", "failed", "cancelled", "incomplete"]);
const safeCode = (error: unknown) => error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/u.test(error.message) ? error.message : "responses_outcome_unknown";
const stopped = (status: "blocked" | "pending" | "unresolved", code: string, responseId: string | null = null): NamingResponsesOutcome => ({ status, code, responseId });
const record = (value: unknown): value is NamingResponsesResponse => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Identity is checked before binding a newly observed response ID. An invalid
 * foreign-metadata event never grants cancellation of that response. */
function assertIdentity(response: NamingResponsesResponse, request: NamingResponsesRequest, knownId: string | null) {
  if (!isNamingResponseId(response.id) || knownId !== null && response.id !== knownId || response.object !== "response"
    || !isDeepStrictEqual(response.metadata, request.body.metadata)) throw Error("responses_identity_mismatch");
}
function assertResponse(response: NamingResponsesResponse, request: NamingResponsesRequest, knownId: string | null) {
  assertIdentity(response, request, knownId);
  const body = request.body;
  if (response.model !== body.model || response.max_output_tokens !== body.max_output_tokens
    || (response.max_tool_calls ?? undefined) !== body.max_tool_calls || response.service_tier !== "default"
    || !isDeepStrictEqual(response.reasoning, body.reasoning) || !isDeepStrictEqual(response.prompt_cache_options, body.prompt_cache_options)
    || !isDeepStrictEqual(response.tools, body.tools) || !isDeepStrictEqual(response.text, body.text) || response.background !== true
    || response.previous_response_id != null || response.conversation != null
    || !["queued", "in_progress", "completed", "failed", "cancelled", "incomplete"].includes(String(response.status))) throw Error("responses_configuration_mismatch");
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > 2_097_152) throw Error("responses_output_limit");
  if (!Array.isArray(response.output) || response.output.some(item => !record(item) || !["message", "reasoning", "function_call", "web_search_call"].includes(String(item.type)))) throw Error("responses_tool_output_invalid");
  const web = response.output.filter(item => record(item) && item.type === "web_search_call");
  const functions = response.output.filter(item => record(item) && item.type === "function_call");
  if (web.length > request.quote.maximumToolCalls || web.length && !body.tools.some(tool => tool.type === "web_search")
    || functions.some(item => item.name !== "read_reference" || !body.tools.some(tool => tool.type === "function" && tool.name === item.name))) throw Error("responses_tool_output_invalid");
  const usage = response.usage;
  if (usage != null) {
    if (!record(usage) || !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)
      || Number(usage.input_tokens) < 0 || Number(usage.output_tokens) < 0) throw Error("responses_usage_invalid");
    if (Number(usage.input_tokens) > request.quote.maximumInputTokens || Number(usage.output_tokens) > request.quote.maximumOutputTokens) throw Error("responses_observed_bound_exceeded");
    const details = usage.input_tokens_details;
    if (details != null && (!record(details) || ["cached_tokens", "cache_write_tokens", "cache_creation_tokens"].some(field => details[field] != null && details[field] !== 0))) throw Error("responses_cache_behavior_mismatch");
  }
}
/** Stored observations are append-only. A later clean snapshot cannot erase an
 * earlier identity-bound configuration or cost violation. SQL independently
 * quarantines the run from these same retained observations. */
function unsafeStoredObservation(row: NamingResponsesDispatch): string | null {
  for (const value of [...row.observations, ...(row.terminalResponse ? [row.terminalResponse] : [])]) {
    if (record(value) && typeof value.unsafeReason === "string") {
      if (value.unsafeReason === "responses_output_limit" || value.unsafeReason === "responses_terminal_conflict") return value.unsafeReason;
      return "responses_observation_quarantined";
    }
    const marker = record(value) && record(value.response) ? value.response : value;
    if (record(marker) && marker.kind === "oversize_response") return marker.responseId === row.responseId ? "responses_output_limit" : "responses_identity_mismatch";
    const response = record(value) && record(value.response) ? value.response : record(value) && value.object === "response" ? value : null;
    if (!response) continue;
    try { assertResponse(response, row.request, row.responseId); } catch (error) { return safeCode(error); }
  }
  return null;
}
function finalOutcome(response: NamingResponsesResponse): NamingResponsesOutcome {
  const responseId = String(response.id), status = String(response.status);
  if (status === "failed" || status === "cancelled" || status === "incomplete") return { status: "terminal", state: status, responseId, response };
  if (status !== "completed") return stopped("pending", "responses_in_progress", responseId);
  if (!Array.isArray(response.output)) return stopped("unresolved", "responses_output_invalid", responseId);
  const items = response.output;
  const calls = items.filter(item => record(item) && item.type === "function_call");
  if (calls.length) {
    if (calls.some(item => item.name !== "read_reference" || item.status !== "completed" || typeof item.call_id !== "string" || typeof item.arguments !== "string")) return stopped("unresolved", "responses_tool_output_invalid", responseId);
    return { status: "completed", responseId, response, output: null, requiresExplicitContinuation: true };
  }
  const messages = items.filter(item => record(item) && item.type === "message" && item.role === "assistant" && item.status === "completed" && item.phase !== "commentary");
  if (messages.length !== 1 || !Array.isArray(messages[0]!.content) || !messages[0]!.content.length) return stopped("unresolved", "responses_output_invalid", responseId);
  const content: unknown[] = messages[0]!.content;
  if (content.some(part => !record(part) || part.type !== "output_text" || typeof part.text !== "string")) return stopped("unresolved", "responses_output_invalid", responseId);
  try {
    const output: unknown = JSON.parse(content.map(part => (part as NamingResponsesResponse).text).join(""));
    return record(output) ? { status: "completed", responseId, response, output, requiresExplicitContinuation: false } : stopped("unresolved", "responses_output_invalid", responseId);
  } catch { return stopped("unresolved", "responses_output_invalid", responseId); }
}

/** Each explicit request has its own durable reservation and one-shot begin.
 * Recovery never reserves, begins or creates. Usage remains observational and no
 * outcome here certifies final expense or releases allocated maxima. */
export function createNamingResponsesRuntime(options: { apiKey?: string; protocol?: NamingResponsesProtocol; persistence: NamingResponsesPersistence; now?: () => number }) {
  if (!options.protocol && !options.apiKey) throw Error("responses_runtime_unavailable");
  const protocol = options.protocol ?? createNamingResponsesProtocol({ apiKey: options.apiKey! });
  const persistence = options.persistence, now = options.now ?? Date.now;
  function checkedRequest(value: unknown) {
    const request = namingResponsesRequestSchema.parse(value);
    if (namingHash({ ...request, requestHash: "0".repeat(64) }) !== request.requestHash) throw Error("responses_request_hash_mismatch");
    return request;
  }
  async function loadRun(): Promise<NamingResponsesRun> {
    const run = namingResponsesRunSchema.parse(await persistence.load());
    for (const row of run.dispatches) { checkedRequest(row.request); if (row.request.runId !== run.runId) throw Error("responses_run_mismatch"); }
    return run;
  }
  async function load(dispatchKey: string): Promise<NamingResponsesDispatch | null> { return (await loadRun()).dispatches.find(value => value.request.dispatchKey === dispatchKey) ?? null; }
  function checkedRow(value: unknown, request: NamingResponsesRequest): NamingResponsesDispatch {
    const row = namingResponsesDispatchSchema.parse(value);
    if (!isDeepStrictEqual(row.request, request)) throw Error("responses_saved_request_mismatch");
    return row;
  }
  function observationSignal(row: NamingResponsesDispatch) {
    const remaining = Date.parse(row.observationDeadlineAt) - now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw Error("responses_observation_deadline_exceeded");
    return AbortSignal.timeout(Math.max(1, Math.min(5_000, remaining)));
  }
  async function observe(row: NamingResponsesDispatch, response: NamingResponsesResponse, requestId: string | null) {
    // Retain an owned raw mismatch before interpreting policy/usage. Otherwise a
    // later, smaller counter could falsely clear a known observed overrun.
    assertIdentity(response, row.request, row.responseId);
    const next = checkedRow(await persistence.observe(row.request.dispatchKey, response, requestId), row.request);
    if (next.responseId !== response.id) throw Error("responses_handle_mismatch");
    const unsafe = unsafeStoredObservation(next);
    if (unsafe) throw Error(unsafe);
    assertResponse(response, row.request, row.responseId);
    return next;
  }
  async function retrieve(row: NamingResponsesDispatch): Promise<NamingResponsesOutcome> {
    if (row.terminalResponse) {
      const unsafe = unsafeStoredObservation(row);
      if (unsafe) throw Error(unsafe);
      assertResponse(row.terminalResponse, row.request, row.responseId);
      return finalOutcome(row.terminalResponse);
    }
    if (!row.responseId) return stopped("unresolved", "responses_identity_unknown");
    const read = await protocol.retrieve(row.responseId, observationSignal(row));
    await observe(row, read.response, read.requestId);
    return finalOutcome(read.response);
  }
  async function resume(dispatchKey: string, hooks: Hooks): Promise<NamingResponsesOutcome> {
    // Execution signals never turn an observer into a cancellation or replay.
    // The independent persisted observation deadline bounds this GET-only path.
    void hooks;
    let row: NamingResponsesDispatch | null = null;
    try {
      row = await load(dispatchKey);
      if (!row) return stopped("blocked", "responses_dispatch_missing");
      if (row.state === "rejected") return stopped("blocked", "provider_request_rejected");
      if (!row.responseId) return stopped(row.state === "reserved" ? "blocked" : "unresolved", row.state === "reserved" ? "responses_dispatch_not_started" : "responses_identity_unknown");
      // A new bounded observer intentionally ignores an already-aborted
      // execution signal. It can only GET retained history, never resume work.
      return await retrieve(row);
    } catch (error) { return stopped("unresolved", row && unsafeStoredObservation(row) || safeCode(error), row?.responseId ?? null); }
  }
  async function cancel(dispatchKey: string, hooks: Hooks): Promise<NamingResponsesOutcome> {
    let row: NamingResponsesDispatch | null = null;
    try {
      row = await load(dispatchKey);
      if (!row || !row.responseId) return stopped("unresolved", "responses_identity_unknown");
      if (row.terminalResponse || hooks.signal.aborted || hooks.observeOnly) return await retrieve(row);
      const signal = observationSignal(row);
      try { await protocol.cancel(row.responseId, signal); } catch {}
      // The cancellation return value is never a terminal witness.
      return await retrieve(row);
    } catch (error) { return stopped("unresolved", row && unsafeStoredObservation(row) || safeCode(error), row?.responseId ?? null); }
  }
  async function run(raw: NamingResponsesRequest, hooks: Hooks): Promise<NamingResponsesOutcome> {
    let request: NamingResponsesRequest;
    try { request = checkedRequest(raw); } catch { return stopped("blocked", "responses_request_invalid"); }
    let row: NamingResponsesDispatch | null = null, stream: NamingResponsesStream | undefined, createInvoked = false, executionSignal: AbortSignal | undefined;
    try {
      const savedRun = await loadRun();
      row = savedRun.dispatches.find(value => value.request.dispatchKey === request.dispatchKey) ?? null;
      if (row) {
        checkedRow(row, request);
        if (row.state !== "reserved" || row.responseId || row.terminalResponse) return await resume(request.dispatchKey, hooks);
      }
      if (savedRun.dispatches.some(value => unsafeStoredObservation(value))) return stopped("blocked", "responses_run_quarantined", row?.responseId ?? null);
      if (hooks.signal.aborted || hooks.observeOnly) return stopped("blocked", "responses_readonly");
      protocol.assertCreateAvailable();
      if (now() >= Date.parse(request.quote.validUntil)) return stopped("blocked", "responses_rate_qualification_expired");
      row = checkedRow(await persistence.reserve(request), request);
      const remaining = Date.parse(row.executionDeadlineAt) - now();
      if (!Number.isFinite(remaining) || remaining <= 0) return stopped("blocked", "responses_execution_deadline_exceeded");
      const signal = AbortSignal.any([hooks.signal, AbortSignal.timeout(remaining)]);
      executionSignal = signal;
      // Do not catch/retry an uncertain begin acknowledgement. If it was lost,
      // the DB's one-shot transition remains consumed and no create is invoked.
      if (!await persistence.begin(request.dispatchKey)) return stopped("unresolved", "responses_begin_not_granted", row.responseId);
      if (signal.aborted) return stopped("unresolved", "responses_cancelled_before_create");
      createInvoked = true;
      stream = await protocol.create(request.body, signal);
      for await (const event of stream.events) {
        if (!record(event) || !record(event.response)) continue;
        const response = event.response;
        assertIdentity(response, request, row.responseId);
        if (!row.responseId) {
          row = checkedRow(await persistence.handle(request.dispatchKey, String(response.id)), request);
          if (row.responseId !== response.id) throw Error("responses_handle_mismatch");
        }
        row = await observe(row, response, stream.requestId);
        if (terminal.has(String(response.status))) return finalOutcome(response);
      }
      // SDK streams can end normally when aborted rather than throwing. A known
      // active execution still needs cancellation and independent GET evidence.
      if (row.responseId && executionSignal.aborted) return await cancel(request.dispatchKey, { signal: AbortSignal.timeout(5_000) });
      return row.responseId ? await retrieve(row) : stopped("unresolved", "responses_stream_identity_missing");
    } catch (error) {
      if (!createInvoked) return stopped(error instanceof NamingResponsesProtocolError && error.code === "creation_unavailable" ? "blocked" : "unresolved", safeCode(error), row?.responseId ?? null);
      if (!row?.responseId && error instanceof NamingResponsesProtocolError && error.code === "request_rejected" && error.requestId && /^req_[A-Za-z0-9_-]+$/u.test(error.requestId)) {
        try { await persistence.reject(request.dispatchKey, error.requestId, "provider_request_rejected"); return stopped("blocked", "provider_request_rejected"); } catch {}
      }
      // Reload only durable state after any lost stream/DB acknowledgement.
      // A known handle grants observation, never a second begin/create.
      try { row = await load(request.dispatchKey) ?? row; } catch {}
      if (row?.responseId) {
        const unsafe = unsafeStoredObservation(row) || ["responses_configuration_mismatch", "responses_observed_bound_exceeded", "responses_cache_behavior_mismatch", "responses_usage_invalid", "responses_output_limit", "responses_tool_output_invalid"].includes(safeCode(error));
        if (executionSignal?.aborted || hooks.signal.aborted || now() >= Date.parse(row.executionDeadlineAt) || unsafe) {
          // A fresh issued execution honors cancellation with a separate bounded
          // control signal. A resumed/read-only observer never reaches this path.
          return await cancel(request.dispatchKey, { signal: AbortSignal.timeout(5_000) });
        }
        try { return await retrieve(row); } catch {}
      }
      return stopped("unresolved", safeCode(error), row?.responseId ?? null);
    } finally { stream?.close(); }
  }
  return { run, resume, cancel };
}
