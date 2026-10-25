import { z } from "zod";

/** A new protocol contract. Historical Agents requests/receipts never parse as
 * this version and must continue through their original recovery adapter. */
export const NAMING_RESPONSES_HANDLER = "naming-responses-v1";
export const NAMING_RESPONSES_MAXIMUM_NANO_USD = 5_000_000_000;
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const key = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const identifier = z.string().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().max(131_072);

export const namingResponsesJobInputSchema = z.strictObject({ version: z.literal(3), handlerVersion: z.literal(NAMING_RESPONSES_HANDLER),
  protocol: z.literal("openai_responses"), runId: z.uuid(), model: z.literal("gpt-6-luna"), reasoningEffort: z.literal("xhigh"), targetCount: z.literal(100) });
export type NamingResponsesJobInput = z.infer<typeof namingResponsesJobInputSchema>;

const textMessage = z.strictObject({ type: z.literal("message"), role: z.enum(["user", "assistant", "developer", "system"]), content: z.array(z.strictObject({ type: z.literal("input_text"), text })).min(1).max(20) });
const functionCall = z.strictObject({ type: z.literal("function_call"), id: identifier.optional(), call_id: identifier, name: z.literal("read_reference"), arguments: text,
  status: z.enum(["in_progress", "completed", "incomplete"]).optional() });
const functionOutput = z.strictObject({ type: z.literal("function_call_output"), id: identifier.optional(), call_id: identifier, output: text, status: z.enum(["in_progress", "completed", "incomplete"]).optional() });
const reasoningItem = z.strictObject({ type: z.literal("reasoning"), id: identifier, summary: z.array(z.strictObject({ type: z.literal("summary_text"), text })).max(100), encrypted_content: text.nullable().optional(),
  content: z.array(z.strictObject({ type: z.literal("reasoning_text"), text })).max(100).optional(), status: z.enum(["in_progress", "completed", "incomplete"]).optional() });
const webSearch = z.strictObject({ type: z.literal("web_search"), search_context_size: z.literal("low"), filters: z.strictObject({ allowed_domains: z.array(z.string().regex(/^[a-z0-9.-]+$/u)).min(1).max(30) }) });
const readReference = z.strictObject({ type: z.literal("function"), name: z.literal("read_reference"), description: z.string().min(1).max(2000), parameters: z.record(z.string(), z.json()), strict: z.literal(true) });
export const namingResponsesWireSchema = z.strictObject({
  model: z.literal("gpt-6-luna"), reasoning: z.strictObject({ effort: z.literal("xhigh"), mode: z.literal("standard") }), service_tier: z.literal("default"),
  prompt_cache_options: z.strictObject({ mode: z.literal("explicit"), ttl: z.literal("30m") }),
  input: z.union([text, z.array(z.union([textMessage, functionCall, functionOutput, reasoningItem])).min(1).max(200)]), instructions: text,
  max_output_tokens: z.number().int().min(1).max(32_768), max_tool_calls: z.number().int().min(1).max(20).optional(),
  tools: z.array(z.union([webSearch, readReference])).max(2), tool_choice: z.literal("auto"), parallel_tool_calls: z.literal(false),
  background: z.literal(true), store: z.literal(true), stream: z.literal(true), truncation: z.literal("disabled"),
  include: z.array(z.enum(["reasoning.encrypted_content", "web_search_call.action.sources"])).min(1).max(2),
  text: z.strictObject({ verbosity: z.literal("low"), format: z.strictObject({ type: z.literal("json_schema"), name: key, strict: z.literal(true), schema: z.record(z.string(), z.json()) }) }),
  metadata: z.record(z.string().regex(/^[a-zA-Z0-9_]{1,64}$/u), z.string().max(512)),
}).superRefine((body, ctx) => {
  const searches = body.tools.filter(tool => tool.type === "web_search").length;
  if (searches > 1 || body.tools.filter(tool => tool.type === "function").length > 1 || Boolean(searches) !== (body.max_tool_calls !== undefined)) ctx.addIssue({ code: "custom", message: "Hosted tool caps must bind the exact available tools" });
  // Breakpoints on content would activate cache writes despite explicit mode.
  const forbidden = (value: unknown): boolean => Boolean(value && typeof value === "object" && (Array.isArray(value) ? value.some(forbidden) : Object.entries(value).some(([field, child]) => field === "prompt_cache_breakpoint" || forbidden(child))));
  if (forbidden(body)) ctx.addIssue({ code: "custom", message: "Cache breakpoints are not qualified" });
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 131_072) ctx.addIssue({ code: "custom", message: "Frozen Responses input exceeds its byte envelope" });
});
export type NamingResponsesWire = z.infer<typeof namingResponsesWireSchema>;

export const namingResponsesQuoteSchema = z.strictObject({ rateCardId: key, qualificationId: key, validUntil: z.iso.datetime({ offset: true }),
  maximumInputTokens: safeInteger.refine(value => value > 0), maximumOutputTokens: z.number().int().min(1).max(32_768), maximumToolCalls: z.number().int().min(0).max(20),
  maximumCostNanoUsd: z.number().int().min(1).max(NAMING_RESPONSES_MAXIMUM_NANO_USD) });
export type NamingResponsesQuote = z.infer<typeof namingResponsesQuoteSchema>;
export const namingResponsesRequestSchema = z.strictObject({ version: z.literal(1), protocol: z.literal("openai_responses"), runId: z.uuid(), dispatchKey: key,
  requestHash: hash, body: namingResponsesWireSchema, quote: namingResponsesQuoteSchema,
}).superRefine((request, ctx) => {
  if (request.body.metadata.embel_run !== request.runId || request.body.metadata.embel_dispatch !== request.dispatchKey || request.body.metadata.embel_contract !== NAMING_RESPONSES_HANDLER
    || request.quote.maximumOutputTokens !== request.body.max_output_tokens || request.quote.maximumToolCalls !== (request.body.max_tool_calls ?? 0)) ctx.addIssue({ code: "custom", message: "Frozen identity and caps must agree" });
});
export type NamingResponsesRequest = z.infer<typeof namingResponsesRequestSchema>;

export const namingResponsesDispatchSchema = z.strictObject({ request: namingResponsesRequestSchema, state: z.enum(["reserved", "dispatching", "accepted", "rejected", "terminal"]),
  responseId: identifier.nullable(), terminalResponse: z.record(z.string(), z.json()).nullable(), observations: z.array(z.json()).max(101),
  executionDeadlineAt: z.iso.datetime({ offset: true }), observationDeadlineAt: z.iso.datetime({ offset: true }) });
export type NamingResponsesDispatch = z.infer<typeof namingResponsesDispatchSchema>;
export const namingResponsesRunSchema = z.strictObject({ runId: z.uuid(), allocatedCostNanoUsd: safeInteger.max(NAMING_RESPONSES_MAXIMUM_NANO_USD), maximumCostNanoUsd: z.literal(NAMING_RESPONSES_MAXIMUM_NANO_USD), dispatches: z.array(namingResponsesDispatchSchema).max(100) });
export type NamingResponsesRun = z.infer<typeof namingResponsesRunSchema>;
