import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { ClaimedJob } from "../../src/domain/jobs";
import { logoStyleNoteApiPolicySchema, type LogoStyleNoteObservation } from "../../src/domain/logo-jobs";
import { LOGO_STYLE_NOTE_INSTRUCTION } from "../../src/domain/logo-style-notes";
import { logoVectorProposalUsageCost } from "../../src/domain/logo-vector-proposal-jobs";
import { OpenAITransportError, type OpenAIResponsesTransport } from "../../src/server/ai/openai-transport";
import { createSharedStyleNoteProvider, createStyleNoteRequest, type StyleNoteProvider } from "../../worker/shared-lanes/logo-style-notes-api";
import { createLogoStyleNoteHandler, type LogoStyleNoteDependencies } from "../../worker/handlers/logo-style-notes";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const policy = logoStyleNoteApiPolicySchema.parse({ version: 1, billingMode: "openai_api", spendControl: "uncapped", handlerVersion: "logo-style-note-v1",
 adapterVersion: "logo-style-note-openai-v1", model: "gpt-6.1-sol", pricingVersion: "2026-10-03", serviceTier: "default", maxInputTokens: 32768,
 maxOutputTokens: 4096, maxInputBytes: 131072, maxOutputBytes: 32768, maxStreamBytes: 2097152, deadlineMs: 240000, maxTools: 0,
 inputMicrousdPerMillionTokens: 2000000, cachedInputMicrousdPerMillionTokens: 100000, cacheWriteMicrousdPerMillionTokens: 2500000, outputMicrousdPerMillionTokens: 10000000 });
const asset = { ownerId: owner, projectId: project, assetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", versionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", contentHash: "e".repeat(64) };
const input = { version: 3, ownerId: owner, projectId: project, operation: "identity.logo_style_note", requestKey: "11111111-1111-4111-8111-111111111111",
 quoteId: "22222222-2222-4222-8222-222222222222", policyIdentity: "f".repeat(64), handlerVersion: "logo-style-note-v1", inputHash: "a".repeat(64),
 referenceId: "33333333-3333-4333-8333-333333333333", asset, noteVersion: "logo-style-note-v1", billingMode: "openai_api", spendControl: "uncapped", apiPolicy: policy };
const job: ClaimedJob = { id: "44444444-4444-4444-8444-444444444444", ownerId: owner, projectId: project, operation: "identity.logo_style_note", input,
 inputRevision: 1, leaseToken: "55555555-5555-4555-8555-555555555555", status: "running", reservedCostMicrousd: 0, actualCostMicrousd: 0 };
const image = { bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]), mimeType: "image/png" as const };
const usage = { input_tokens: 1447, output_tokens: 61, total_tokens: 1508, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1444 } };
const note = { symbol: "Eight solid square modules around an open center, sharp corners", lettering: null };
function response(text: string, overrides: Record<string, unknown> = {}) {
 return { requestId: "req_note_1", body: { id: "resp_note1", status: "completed", model: "gpt-6.1-sol", service_tier: "default", usage, error: null, incomplete_details: null,
  output: [{ type: "reasoning" }, { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }], ...overrides } };
}
function transport(create: OpenAIResponsesTransport["createResponse"], counted = 1500): OpenAIResponsesTransport & { requests: unknown[] } {
 const requests: unknown[] = [];
 return { requests, async countInputTokens() { return counted; }, async createResponse(request, key, signal) { requests.push(request); return create(request, key, signal); } };
}
const dispatch = { job, beforeDispatch: async () => {} };
const provider = (t: OpenAIResponsesTransport) => createSharedStyleNoteProvider({ ownerId: owner, policy, apiKey: "inert-test-key", acceptingWork: () => true, transport: t });

describe("style note request", () => {
 it("sends the fixed instruction, the image on white and a strict two-part schema, with no tools or storage", () => {
  const request = createStyleNoteRequest(image, policy), content = request.input[0]!.content;
  expect(request).toMatchObject({ model: "gpt-6.1-sol", store: false, tools: [], tool_choice: "none", reasoning: { effort: "low" }, service_tier: "default",
   text: { format: { type: "json_schema", strict: true, schema: { required: ["symbol", "lettering"] } } } });
  expect(content[0]).toEqual({ type: "input_text", text: LOGO_STYLE_NOTE_INSTRUCTION });
  expect(content[1]).toMatchObject({ type: "input_image", detail: "high" });
  expect(content[1]).toHaveProperty("image_url", `data:image/png;base64,${Buffer.from(image.bytes).toString("base64")}`);
 });
 it("refuses an image too large for the input bound", () => {
  expect(() => createStyleNoteRequest({ bytes: new Uint8Array(120_000), mimeType: "image/png" }, policy)).toThrow();
 });
});

describe("style note provider", () => {
 it("returns the parsed note with usage priced exactly as the database checks it", async () => {
  const t = transport(async () => response(JSON.stringify(note)));
  const { outcome, observation } = await provider(t).describe(image, new AbortController().signal, dispatch);
  const cost = logoVectorProposalUsageCost({ inputTokens: 1447, cachedInputTokens: 0, cacheWriteInputTokens: 1444, outputTokens: 61 });
  expect(outcome).toEqual({ status: "succeeded", result: note, costMicrousd: cost, providerRequestId: "req_note_1" });
  expect(observation).toMatchObject({ kind: "logo_style_note_text", responseComplete: true, toolCalls: 0, billing: { status: "recorded", confirmedMicrousd: cost } });
  expect(t.requests).toHaveLength(1);
 });
 it("treats a complete billed answer without a usable note as a definite failure", async () => {
  const { outcome, observation } = await provider(transport(async () => response(JSON.stringify({ symbol: null, lettering: null })))).describe(image, new AbortController().signal, dispatch);
  expect(outcome).toMatchObject({ status: "failed", code: "invalid_output", providerRequestId: "req_note_1" });
  expect(observation.billing.status).toBe("recorded");
 });
 it("never dispatches above the counted input bound", async () => {
  const t = transport(async () => response(JSON.stringify(note)), policy.maxInputTokens + 1);
  const { outcome } = await provider(t).describe(image, new AbortController().signal, dispatch);
  expect(outcome).toEqual({ status: "failed", code: "not_dispatched", costMicrousd: 0, providerRequestId: null });
  expect(t.requests).toHaveLength(0);
 });
 it("leaves an interrupted request for review instead of repeating it", async () => {
  const { outcome, observation } = await provider(transport(async () => { throw new OpenAITransportError("outcome_unknown", "req_lost"); })).describe(image, new AbortController().signal, dispatch);
  expect(outcome).toMatchObject({ status: "needs_reconciliation", code: "provider_outcome_unknown", costMicrousd: 0 });
  expect(observation.providerRequestId).toBe("req_lost");
 });
 it("keeps an incomplete response unbilled and uncertain", async () => {
  const { outcome } = await provider(transport(async () => response(JSON.stringify(note), { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))).describe(image, new AbortController().signal, dispatch);
  expect(outcome.status).toBe("needs_reconciliation");
 });
});

describe("style note handler", () => {
 const recorded = (observation: LogoStyleNoteObservation) => ({ ...observation, id: "66666666-6666-4666-8666-666666666666", ownerId: owner, projectId: project, jobId: job.id, leaseToken: job.leaseToken });
 function deps(overrides: Partial<LogoStyleNoteDependencies> = {}, describe?: StyleNoteProvider["describe"]) {
  const calls: string[] = [];
  const value: LogoStyleNoteDependencies = {
   provider: { describe: describe ?? (async (...args) => provider(transport(async () => response(JSON.stringify(note)))).describe(...args)) },
   assets: { readLeasedAsset: async () => { calls.push("read"); return { reference: asset, bytes: image.bytes, mimeType: "image/png" }; } } as unknown as LogoStyleNoteDependencies["assets"],
   loadInput: async () => { calls.push("input"); return { input, reference: { referenceId: input.referenceId, asset, sourceKind: "upload", rightsEvidenceId: "77777777-7777-4777-8777-777777777777" } }; },
   onWhite: async () => { calls.push("white"); return image; },
   assertReady: async () => { calls.push("ready"); },
   recordResponse: async (_job, observation) => { calls.push("record"); return recorded(observation); },
   stage: async () => { calls.push("stage"); return { version: 1, kind: "logo_style_note_staged", noteId: "88888888-8888-4888-8888-888888888888", providerResponseReceiptId: "66666666-6666-4666-8666-666666666666" }; },
   ...overrides };
  return { value, calls };
 }
 const run = (d: LogoStyleNoteDependencies) => createLogoStyleNoteHandler(d).steps(job)[0]!.execute({ job, signal: new AbortController().signal });

 it("reads the frozen upload, places it on white, records usage, then stores the note", async () => {
  const { value, calls } = deps(), outcome = await run(value);
  expect(outcome).toMatchObject({ status: "succeeded", result: { version: 1, kind: "logo_style_note", noteId: "88888888-8888-4888-8888-888888888888", providerResponseReceiptId: "66666666-6666-4666-8666-666666666666" } });
  // Readiness is checked again at every fence before sending; usage is recorded before the note is stored.
  expect(calls.slice(0, 4)).toEqual(["input", "read", "white", "ready"]);
  expect(calls.filter(call => call !== "ready").slice(3)).toEqual(["record", "stage"]);
  expect(calls.lastIndexOf("ready")).toBeLessThan(calls.indexOf("record"));
 });
 it("records nothing when the upload cannot be read", async () => {
  const { value, calls } = deps({ assets: { readLeasedAsset: async () => { throw new Error("denied"); } } as unknown as LogoStyleNoteDependencies["assets"] });
  expect(await run(value)).toEqual({ status: "failed", code: "not_dispatched", costMicrousd: 0, providerRequestId: null });
  expect(calls).not.toContain("record");
 });
 it("leaves the job for review when its usage cannot be recorded", async () => {
  const { value, calls } = deps({ recordResponse: async () => { throw new Error("lost"); } });
  expect(await run(value)).toEqual({ status: "needs_reconciliation", code: "provider_outcome_unknown", costMicrousd: 0, providerRequestId: null });
  expect(calls).not.toContain("stage");
 });
 it("keeps a billed failure as a failure with its real cost", async () => {
  const { value, calls } = deps({}, async (...args) => provider(transport(async () => response(JSON.stringify({ symbol: null, lettering: null })))).describe(...args));
  const outcome = await run(value);
  expect(outcome).toMatchObject({ status: "failed", code: "invalid_output", providerRequestId: "req_note_1" });
  expect(outcome.costMicrousd).toBeGreaterThan(0);
  expect(calls).toContain("record"); expect(calls).not.toContain("stage");
 });
 it("leaves the job for review when the note cannot be stored", async () => {
  const { value } = deps({ stage: async () => { throw new Error("window closed"); } });
  expect(await run(value)).toMatchObject({ status: "needs_reconciliation", code: "publication_unknown", providerRequestId: "req_note_1" });
 });
});
