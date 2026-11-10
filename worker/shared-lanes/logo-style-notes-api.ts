import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ClaimedJob, StepOutcome } from "../../src/domain/jobs";
import { logoStyleNoteApiPolicySchema, logoStyleNoteJobInputSchema, logoStyleNoteObservationSchema,
 type LogoStyleNoteApiPolicy, type LogoStyleNoteObservation } from "../../src/domain/logo-jobs";
import { logoVectorProposalUsageSchema, logoVectorProposalUsageCost } from "../../src/domain/logo-vector-proposal-jobs";
import { logoStyleNoteSchema } from "../../src/domain/logo-style-notes";
import { createOpenAIResponsesTransport, OpenAITransportError, type OpenAIResponsesTransport } from "../../src/server/ai/openai-transport";

import { createStyleNoteRequest, type StyleNoteImage } from "../../src/server/ai/style-note-request";
export { createStyleNoteRequest, type StyleNoteImage };
export type StyleNoteDispatch = { job: ClaimedJob; beforeDispatch(job: ClaimedJob): Promise<void> };
export type StyleNoteProvider = { describe(image: StyleNoteImage, signal: AbortSignal, dispatch: StyleNoteDispatch): Promise<{ outcome: StepOutcome; observation: LogoStyleNoteObservation }> };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** No fallback transport, tools or provider retry. Only the exact frozen job and
 * policy may issue one response; actual observed usage is always returned. */
export function createSharedStyleNoteProvider(options: { ownerId: string; policy: LogoStyleNoteApiPolicy; apiKey: string; acceptingWork: () => boolean; transport?: OpenAIResponsesTransport }): StyleNoteProvider {
 const policy = logoStyleNoteApiPolicySchema.parse(options.policy);
 if (!options.apiKey || typeof options.acceptingWork !== "function") throw Error("style_note_provider_unavailable");
 const ownerId = z.uuid().parse(options.ownerId), acceptingWork = options.acceptingWork;
 const transport = options.transport ?? createOpenAIResponsesTransport({ apiKey: options.apiKey });
 const count = transport.countInputTokens.bind(transport), create = transport.createResponse.bind(transport);
 return { async describe(image, signal, dispatch) {
  let invoked = false, claim!: ClaimedJob, request!: ReturnType<typeof createStyleNoteRequest>;
  let observation: LogoStyleNoteObservation = { version: 3, kind: "logo_style_note_text", billingMode: "openai_api", spendControl: "uncapped", apiPolicy: policy,
   provider: "openai", model: policy.model, providerRequestId: null, responseId: null, responseHash: null, responseComplete: false, observedAt: new Date().toISOString(),
   artifactHash: null, usage: null, serviceTier: null, toolCalls: null, billing: { status: "unknown", confirmedMicrousd: null } };
  const finish = (outcome: StepOutcome) => ({ outcome, observation: logoStyleNoteObservationSchema.parse(observation) });
  const no = () => finish({ status: "failed", code: "not_dispatched", costMicrousd: 0, providerRequestId: null });
  const current = AbortSignal.any([signal, AbortSignal.timeout(policy.deadlineMs)]);
  const accepting = () => { const value: unknown = acceptingWork(); if (value !== true) { void Promise.resolve(value).catch(() => {}); throw Error("style_note_stopped"); } };
  const fence = async () => {
   current.throwIfAborted(); accepting(); if (!isDeepStrictEqual(dispatch.job, claim)) throw Error("style_note_stopped");
   await dispatch.beforeDispatch(structuredClone(claim)); current.throwIfAborted();
   accepting(); if (!isDeepStrictEqual(dispatch.job, claim)) throw Error("style_note_stopped");
  };
  try {
   const frozen = logoStyleNoteJobInputSchema.parse(dispatch.job.input); claim = structuredClone(dispatch.job);
   if (claim.ownerId !== ownerId || claim.ownerId !== frozen.ownerId || claim.projectId !== frozen.projectId || claim.operation !== frozen.operation
    || claim.reservedCostMicrousd !== 0 || claim.actualCostMicrousd !== 0 || !isDeepStrictEqual(frozen.apiPolicy, policy)) return no();
   request = createStyleNoteRequest(image, policy); await fence();
   const counted = await count(request, current);
   if (!Number.isSafeInteger(counted) || counted < 0 || counted > policy.maxInputTokens) return no();
   await fence();
  } catch { return no(); }
  const common = () => ({ costMicrousd: observation.billing.status === "recorded" ? observation.billing.confirmedMicrousd : 0, providerRequestId: observation.providerRequestId });
  const uncertain = () => finish({ status: "needs_reconciliation", code: "provider_outcome_unknown", ...common() });
  try {
   await fence(); current.throwIfAborted(); invoked = true;
   const response = await create(request, hash(JSON.stringify({ jobId: claim.id, input: claim.input, request })), current);
   const body = record(response.body), serialized = JSON.stringify(response.body);
   observation.providerRequestId = z.string().min(1).max(200).safeParse(response.requestId).success ? response.requestId : null; observation.responseHash = hash(serialized);
   if (!body || Buffer.byteLength(serialized) > policy.maxStreamBytes) return uncertain();
   observation.responseId = typeof body.id === "string" && /^resp_[A-Za-z0-9_-]{1,194}$/u.test(body.id) ? body.id : null;
   observation.model = z.string().min(1).max(150).regex(/^[A-Za-z0-9._:-]+$/u).safeParse(body.model).success ? body.model as string : "unknown";
   observation.serviceTier = z.string().min(1).max(100).safeParse(body.service_tier).success ? body.service_tier as string : null;
   observation.responseComplete = body.status === "completed" && body.error == null && body.incomplete_details == null && observation.responseId !== null;
   const usage = record(body.usage), details = record(usage?.input_tokens_details);
   const parsedUsage = logoVectorProposalUsageSchema.safeParse({ inputTokens: usage?.input_tokens, cachedInputTokens: details?.cached_tokens,
    cacheWriteInputTokens: details?.cache_write_tokens, outputTokens: usage?.output_tokens });
   if (parsedUsage.success && usage?.total_tokens === parsedUsage.data.inputTokens + parsedUsage.data.outputTokens) observation.usage = parsedUsage.data;
   let text = "", tools = 0;
   if (!Array.isArray(body.output) || body.output.length > 100) return uncertain();
   for (const rawItem of body.output) {
    const item = record(rawItem); if (item?.type === "reasoning") continue;
    if (item?.type !== "message" || item.role !== "assistant" || item.status !== "completed" || !Array.isArray(item.content)) { tools++; continue; }
    for (const rawContent of item.content) { const content = record(rawContent); if (content?.type !== "output_text" || typeof content.text !== "string") { tools++; continue; } text += content.text; }
   }
   observation.toolCalls = tools;
   if (observation.usage && tools === 0 && observation.model === policy.model && observation.serviceTier === policy.serviceTier)
    observation.billing = { status: "recorded", confirmedMicrousd: logoVectorProposalUsageCost(observation.usage) };
   observation = logoStyleNoteObservationSchema.parse(observation);
   if (!observation.responseComplete || !observation.usage || observation.usage.inputTokens > policy.maxInputTokens || observation.usage.outputTokens > policy.maxOutputTokens
    || observation.billing.status !== "recorded" || Buffer.byteLength(text) > policy.maxOutputBytes || current.aborted) return uncertain();
   // A complete, billed answer that is not a usable note is a definite failure, not an uncertain outcome.
   const note = logoStyleNoteSchema.safeParse((() => { try { return JSON.parse(text); } catch { return null; } })());
   if (!note.success || note.data.symbol === null && note.data.lettering === null) return finish({ status: "failed", code: "invalid_output", ...common() });
   return finish({ status: "succeeded", result: note.data, ...common() });
  } catch (error) {
   if (!invoked) return no();
   if (error instanceof OpenAITransportError) observation.providerRequestId = error.requestId;
   return uncertain();
  }
 } };
}
