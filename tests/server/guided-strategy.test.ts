import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { contextSnapshotSchema, type GuidedStage } from "../../src/domain/projects";
import { initializeGuidedInterview } from "../../src/domain/guided-interview";
import { strategyJobInputSchema, strategyJobResultSchema, type StrategyAssistantHistory, type StrategyJobInput, type StrategyJobResult, type StrategyOperation } from "../../src/domain/strategy-jobs";
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { createStrategyRequest, executeStrategyResponse } from "../../src/server/ai/strategy-response";
import { jobFixture, responseFixture, transportFixture } from "./openai-fixtures";

const now = "2026-10-14T20:00:00.000Z";
const profile = { sincerity: 80, excitement: 45, competence: 90, sophistication: 30, ruggedness: 10 };
const rawCompetitor = { name: "Synthetic Bakery", relevance: "The same office delivery need", url: "https://example.com/", sourceUrls: ["https://example.com/"] };
const rawAudience = { label: "Small office teams", needs: ["Dependable weekly delivery", "Simple ordering"], reason: "They need regular shared meals" };
const rawPersonality = { profile, traits: ["Warm", "Dependable"], toneExample: "Good bread, right on time.", expression: "Friendly language with calm everyday confidence" };

function guidedInput(stage: GuidedStage = "competitors", purpose: "research" | "message" | "propose" = "research", userText = "Office bread subscriptions", history: StrategyAssistantHistory = { entries: [], truncated: false }): Extract<StrategyJobInput, { version: 2 }> {
  const operation: StrategyOperation = purpose === "message" ? "strategy.reformulate" : `strategy.${stage}`;
  const policy = guidedStrategyPolicy(operation);
  const context = initializeGuidedInterview(contextSnapshotSchema.parse({ description: "Synthetic provider fixture only", intake: { conversation: [{ id: "actual-user-message", kind: "user_message", text: userText, createdAt: now }] } }), {
    id: "current-turn", userMessageId: "actual-user-message", stage, purpose, inputRevision: 3,
  });
  const parsed = strategyJobInputSchema.parse({ version: 2, policy, context, acceptedMaxCostMicrousd: policy.maximumCostMicrousd, assistantHistory: history });
  if (parsed.version !== 2) throw new Error("Expected guided fixture");
  return parsed;
}
function choices(stage: GuidedStage = "competitors") {
  return { kind: "choices", targetStage: null, message: "Synthetic helpful introduction", question: "Which of these best fits?", selection: null, options: [{
    label: stage === "competitors" ? "Synthetic Bakery" : stage === "audience" ? "Small office teams" : "Dependable warmth",
    description: "A useful detailed explanation", recommended: true, recommendationReason: "Matches the user's practical offering",
    payload: stage === "competitors" ? rawCompetitor : stage === "audience" ? rawAudience : rawPersonality,
  }] };
}
function researchResponse(value: unknown = choices()) {
  const response = responseFixture(value);
  response.output.unshift({ type: "web_search_call", status: "completed", action: { type: "search", sources: [{ type: "url", url: "https://example.com/", title: "Synthetic source observed by the tool" }] } });
  return response;
}
async function execute(value: unknown, input = guidedInput(), response = researchResponse(value)) {
  const turn = input.context.intake.guidedInterview!.turns.at(-1)!;
  const operation: StrategyOperation = turn.purpose === "message" ? "strategy.reformulate" : `strategy.${turn.stage}`;
  const transport = transportFixture(response);
  const job = { ...jobFixture(operation), input, inputRevision: turn.inputRevision };
  const outcome = await executeStrategyResponse({ job, input, operation, transport, signal: new AbortController().signal, now: () => now });
  return { outcome, transport };
}
function history(output: StrategyJobResult): StrategyAssistantHistory {
  const job = jobFixture();
  return { entries: [{ jobId: job.id, ownerId: job.ownerId, projectId: job.projectId, stepKey: "proposal", inputRevision: 1, completedAt: now, output }], truncated: false };
}

describe("guided provider contract (synthetic transports, no live inference)", () => {
  it("requires v2 immutable input history and preserves old v1 policies", () => {
    const input = guidedInput();
    expect(strategyJobInputSchema.safeParse({ ...input, version: 1 }).success).toBe(false);
    const missingHistory: Partial<typeof input> = { ...input };
    delete missingHistory.assistantHistory;
    expect(strategyJobInputSchema.safeParse(missingHistory).success).toBe(false);
    expect(input.policy).toMatchObject({ version: 2, handlerVersion: "strategy-openai-guided-v1", pricingVersion: "2026-10-14", maxInputTokens: 3_150_000, maximumCostMicrousd: 15_892_880 });
  });

  it("instructs one focused stage, free-text decisions and mandatory real competitor search", () => {
    const request = createStrategyRequest("strategy.competitors", guidedInput());
    expect(request).toMatchObject({ tool_choice: "required", parallel_tool_calls: false, tools: [{ type: "web_search" }] });
    expect(request.instructions).toContain("one focused question, answer or choice widget");
    expect(request.instructions).toContain("free-text custom answer");
    expect(request.instructions).toContain("in the order competitors, target audience, positioning, brand personality");
    expect(request.instructions).toContain("Never skip ahead, add a stage");
    expect(request.instructions).toContain("at most 2 web tool calls in total, including search, open_page and find_in_page");
    expect(request.instructions).toContain("sources returned by completed calls");
    expect(request.input).toEqual([{ role: "user", content: expect.stringContaining('"currentTurn":{"id":"current-turn"') }]);
  });

  it("normalizes sourced detailed options, recommendations and exact turn binding without selecting", async () => {
    const { outcome } = await execute(choices());
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") throw new Error("Synthetic fixture failed");
    const result = strategyJobResultSchema.parse(outcome.result);
    expect(result.guidance).toMatchObject({ kind: "choices", stage: "competitors", turnId: "current-turn", selectionMode: "multiple", options: [{ recommended: true, recommendationReason: "Matches the user's practical offering", payload: { selected: false, origin: "research", sources: [{ url: "https://example.com/", retrievedAt: now }] } }] });
    expect(result.proposal).toMatchObject({ competitors: [{ selected: false }] });
  });

  it("drops the option that relies on an unfinished search and keeps the two backed by completed searches", async () => {
    const raw = choices();
    const candidates = ["unfinished.example", "example.com", "another.example"].map((host, index) => ({
      ...rawCompetitor, name: `Synthetic candidate ${index + 1}`, url: `https://${host}/`, sourceUrls: [`https://${host}/`],
    }));
    raw.options = candidates.map((payload, index) => ({ ...raw.options[0]!, label: `Synthetic option ${index + 1}`, payload }));
    const response = researchResponse(raw);
    response.usage = { input_tokens: 25693, output_tokens: 711, total_tokens: 26404, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } };
    response.output[0] = { type: "web_search_call", status: "completed", action: { type: "search", sources: [
      { url: "https://example.com/" }, { url: "https://another.example/" },
    ] } };
    response.output.splice(1, 0,
      { type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://example.com/" } },
      { type: "reasoning", summary: [{ text: "Synthetic private reasoning must not be retained" }] },
      { type: "web_search_call", status: "searching", action: { type: "search", sources: candidates.map(candidate => ({ url: candidate.url })) } });
    response.output[4] = { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(raw),
      annotations: candidates.map(candidate => ({ type: "url_citation", url: candidate.url })),
    }] };
    const { outcome, transport } = await execute(raw, guidedInput(), response);
    expect(outcome).toMatchObject({ status: "succeeded", costMicrousd: 78496, providerRequestId: response.id });
    const result = strategyJobResultSchema.parse(outcome.result);
    if (result.guidance?.kind !== "choices") throw new Error("Synthetic fixture did not produce choices");
    // The unfinished attempt never supplies a source or website.
    expect(result.guidance.options.map(option => option.label)).toEqual(["Synthetic option 2", "Synthetic option 3"]);
    expect(JSON.stringify(result)).not.toContain("unfinished.example");
    expect(JSON.stringify(outcome)).not.toContain("Synthetic private reasoning");
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unobserved source", { ...rawCompetitor, sourceUrls: ["https://fabricated.example/"] }, "failed", "provider_research_unusable"],
    ["unobserved website", { ...rawCompetitor, url: "https://fabricated.example/" }, "failed", "provider_research_unusable"],
    ["empty sources", { ...rawCompetitor, sourceUrls: [] }, "needs_reconciliation", "provider_invalid_output"],
  ] satisfies Array<[string, typeof rawCompetitor, string, string]>)("rejects researched competitors with %s", async (_label, payload, status, code) => {
    const raw = choices(); raw.options[0]!.payload = payload;
    expect((await execute(raw)).outcome).toMatchObject({ status, code });
  });

  it("requires an actual search even when the answer includes copied citations", async () => {
    const { outcome } = await execute(choices(), guidedInput(), responseFixture(choices()));
    expect(outcome).toMatchObject({ status: "failed", code: "provider_research_missing" });
  });

  it("asks one focused question when research finds insufficient evidence", async () => {
    const raw = { kind: "question", targetStage: null, message: "The current search did not establish a relevant set.", question: "Which delivery region matters?", options: [], selection: null };
    const { outcome } = await execute(raw);
    expect(outcome).toMatchObject({ status: "succeeded", result: { guidance: { kind: "question", stage: "competitors", question: raw.question }, proposal: { competitors: [] } } });
  });

  it.each(["audience", "personality"] as const)("offers detailed %s choices without search or approval", async stage => {
    const raw = choices(stage);
    const input = guidedInput(stage, "propose");
    const { outcome, transport } = await execute(raw, input, responseFixture(raw));
    expect(outcome.status).toBe("succeeded");
    expect(vi.mocked(transport.createResponse).mock.calls[0]?.[0]).toMatchObject({ tools: [], tool_choice: "none" });
    if (outcome.status !== "succeeded") throw new Error("Synthetic fixture failed");
    const result = strategyJobResultSchema.parse(outcome.result);
    expect(result.guidance).toMatchObject({ kind: "choices", stage, selectionMode: stage === "personality" ? "single" : "multiple" });
    if (stage === "audience") expect(result.guidance).toMatchObject({ options: [{ payload: { selected: false, sources: [], needs: rawAudience.needs, reason: rawAudience.reason } }] });
    else expect(result.guidance).toMatchObject({ options: [{ payload: rawPersonality }] });
  });

  it("keeps a clarification on its existing stage and supplies exact owned prior question/options", async () => {
    const first = await execute(choices("audience"), guidedInput("audience", "propose"), responseFixture(choices("audience")));
    if (first.outcome.status !== "succeeded") throw new Error("Synthetic fixture failed");
    const output = strategyJobResultSchema.parse(first.outcome.result);
    const raw = { kind: "answer", targetStage: null, message: "The first audience has a recurring shared-meal need.", question: null, options: [], selection: null };
    const input = guidedInput("audience", "message", "Why recommend that audience?", history(output));
    const { outcome, transport } = await execute(raw, input, responseFixture(raw));
    expect(outcome).toMatchObject({ status: "succeeded", result: { guidance: { kind: "answer", stage: "audience", turnId: "current-turn" } } });
    const request = vi.mocked(transport.createResponse).mock.calls[0]![0];
    const content = (request.input as { content: string }[])[0]!.content;
    expect(JSON.parse(content).frozenAssistantHistory.entries[0].output).toEqual(output);
    expect(request).toMatchObject({ tools: [], tool_choice: "none" });
  });

  it("resolves a free-text decision referring to an exact previous researched option", async () => {
    const first = await execute(choices());
    if (first.outcome.status !== "succeeded") throw new Error("Synthetic fixture failed");
    const output = strategyJobResultSchema.parse(first.outcome.result);
    if (output.guidance?.kind !== "choices") throw new Error("Expected choices");
    const raw = { kind: "accepted", targetStage: null, message: "Keeping that competitor.", question: null, options: [], selection: { optionIds: [output.guidance.options[0]!.id], customOptions: [] } };
    const { outcome } = await execute(raw, guidedInput("competitors", "message", "Keep the first one", history(output)), responseFixture(raw));
    expect(outcome).toMatchObject({ status: "succeeded", result: { guidance: { kind: "accepted", customText: "Keep the first one", selection: { stage: "competitors", competitors: [{ name: "Synthetic Bakery", origin: "research", selected: false, sources: [{ url: "https://example.com/" }] }] } } } });
  });

  it("preserves proposal origin for a referenced audience and marks a custom audience as user supplied", async () => {
    const first = await execute(choices("audience"), guidedInput("audience", "propose"), responseFixture(choices("audience")));
    if (first.outcome.status !== "succeeded") throw new Error("Synthetic fixture failed");
    const output = strategyJobResultSchema.parse(first.outcome.result);
    if (output.guidance?.kind !== "choices") throw new Error("Expected choices");
    const raw = { kind: "accepted", targetStage: null, message: "Using your target audiences.", question: null, options: [], selection: { optionIds: [output.guidance.options[0]!.id], customOptions: [{ label: "Remote teams", needs: ["Food for team days"], reason: "The user chose occasional gatherings" }] } };
    const { outcome } = await execute(raw, guidedInput("audience", "message", "Use the first audience and remote teams for occasional gatherings", history(output)), responseFixture(raw));
    expect(outcome).toMatchObject({ status: "succeeded", result: { guidance: { kind: "accepted", selection: { audienceSegments: [{ origin: "proposal", selected: false }, { origin: "user", selected: false }] } } } });
  });

  it("turns an explicit custom personality answer into one detailed unapproved profile", async () => {
    const raw = { kind: "accepted", targetStage: null, message: "Using a warm and dependable personality.", question: null, options: [], selection: { optionIds: [], customOptions: [rawPersonality] } };
    const { outcome } = await execute(raw, guidedInput("personality", "message", "Warm and dependable is right for us"), responseFixture(raw));
    expect(outcome).toMatchObject({ status: "succeeded", result: { guidance: { kind: "accepted", stage: "personality", customText: "Warm and dependable is right for us", selection: { personality: profile } } } });
  });

  it("treats explicitly named custom competitors as user data without research claims", async () => {
    const raw = { kind: "accepted", targetStage: null, message: "Using your competitor.", question: null, options: [], selection: { optionIds: [], customOptions: [{ name: "Custom Bakery", relevance: "The user identified it as relevant", url: null, sourceUrls: [] }] } };
    const { outcome } = await execute(raw, guidedInput("competitors", "message", "Use Custom Bakery"), responseFixture(raw));
    expect(outcome).toMatchObject({ status: "succeeded", result: { guidance: { kind: "accepted", customText: "Use Custom Bakery", selection: { competitors: [{ origin: "user", sources: [], selected: false, name: "Custom Bakery" }] } } } });
    expect((await execute(raw, guidedInput("competitors", "message", "Explain the first option"), responseFixture(raw))).outcome).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
  });

  it("rejects invented source provenance or a missing historical choice on nonresearch messages", async () => {
    for (const selection of [{ optionIds: ["not-an-observed-option"], customOptions: [] }, { optionIds: [], customOptions: [rawCompetitor] }]) {
      const raw = { kind: "accepted", targetStage: null, message: "Synthetic interpretation", question: null, options: [], selection };
      expect((await execute(raw, guidedInput("competitors", "message", "Use Synthetic Bakery"), responseFixture(raw))).outcome).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
    }
  });

  it("does not accept an initial project description as a user confirmation", async () => {
    const raw = { kind: "accepted", targetStage: null, message: "Synthetic unsupported acceptance", question: null, options: [], selection: { optionIds: [], customOptions: [rawCompetitor] } };
    expect((await execute(raw)).outcome).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
  });

  it("rejects missing recommendations and contradictory answer/choice fields", async () => {
    const noRecommendation = choices(); noRecommendation.options[0]!.recommended = false;
    for (const raw of [noRecommendation, { ...choices(), selection: { optionIds: [], customOptions: [] } }, { kind: "answer", targetStage: null, message: "Synthetic answer", question: "A second question?", options: [], selection: null }]) {
      expect((await execute(raw)).outcome).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
    }
  });

  it("checks exact target operation/revision and frozen history ownership before any provider request", async () => {
    const first = await execute(choices());
    if (first.outcome.status !== "succeeded") throw new Error("Synthetic fixture failed");
    const output = strategyJobResultSchema.parse(first.outcome.result);
    for (const mismatch of ["owner", "project", "historyRevision", "turnRevision", "operation"] as const) {
      const input = guidedInput("competitors", "message", "Why this one?", history(output));
      if (mismatch === "owner") input.assistantHistory.entries[0]!.ownerId = "00000000-0000-4000-8000-000000000001";
      if (mismatch === "project") input.assistantHistory.entries[0]!.projectId = "00000000-0000-4000-8000-000000000001";
      if (mismatch === "historyRevision") input.assistantHistory.entries[0]!.inputRevision = 3;
      const transport = transportFixture();
      const operation = mismatch === "operation" ? "strategy.audience" : "strategy.reformulate";
      const result = await executeStrategyResponse({ job: { ...jobFixture(), inputRevision: mismatch === "turnRevision" ? 2 : 3 }, operation, input, transport, signal: new AbortController().signal });
      expect(result).toMatchObject({ status: "failed", code: "guided_request_mismatch" });
      expect(transport.countInputTokens).not.toHaveBeenCalled();
      expect(transport.createResponse).not.toHaveBeenCalled();
    }
  });

  it("normalizes an explicit free-text stage change only as a bound reformulate reply", async () => {
    const raw = { kind: "redirect", targetStage: "audience", message: "Let's revisit your audience.", question: null, options: [], selection: null };
    const input = guidedInput("personality", "message", "I want to change our target audience first");
    const { outcome, transport } = await execute(raw, input, responseFixture(raw));
    expect(outcome).toMatchObject({ status: "succeeded", result: { operation: "strategy.reformulate", guidance: { kind: "redirect", turnId: "current-turn", stage: "personality", targetStage: "audience" } } });
    const request = vi.mocked(transport.createResponse).mock.calls[0]![0];
    expect(request).toMatchObject({ tools: [], tool_choice: "none" });
    expect(request.instructions).toContain("latest user message explicitly asks to revisit or change a DIFFERENT strategy stage");
    expect(request.instructions).toContain("never redirect autonomously");
    expect(request.instructions).toContain("merely considering a change or the intended stage is unclear");
    if (outcome.status !== "succeeded") throw new Error("Synthetic fixture failed");
    const result = strategyJobResultSchema.parse(outcome.result);
    expect(strategyJobResultSchema.safeParse({ ...result, operation: "strategy.personality", proposal: { message: raw.message, personality: profile } }).success).toBe(false);
  });

  it("rejects automatic stage changes on research/propose and ambiguous mixed redirect output", async () => {
    const raw = { kind: "redirect", targetStage: "audience", message: "Let's revisit your audience.", question: null, options: [], selection: null };
    expect((await execute(raw)).outcome).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
    expect((await execute(raw, guidedInput("personality", "propose"), responseFixture(raw))).outcome).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
    const input = guidedInput("personality", "message", "I want to change our target audience first");
    for (const change of [
      { targetStage: "personality" }, { targetStage: null }, { targetStage: "naming" },
      { question: "Also choose a personality?" }, { options: choices("personality").options }, { selection: { optionIds: [], customOptions: [] } },
    ]) {
      const invalid = { ...raw, ...change };
      expect((await execute(invalid, input, responseFixture(invalid))).outcome).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
    }
  });

  it("requires explicit null targetStage on all other structured-output kinds", async () => {
    const noTarget: Partial<ReturnType<typeof choices>> = choices();
    delete noTarget.targetStage;
    expect((await execute(noTarget)).outcome).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
    expect((await execute({ ...choices(), targetStage: "audience" })).outcome).toMatchObject({ status: "needs_reconciliation", code: "provider_invalid_output" });
  });

  it("continues real competitor research when the user answers its missing location question", async () => {
    const question = { kind: "question", targetStage: null, message: "I need the delivery area to research relevant alternatives.", question: "Which city?", options: [], selection: null };
    const first = await execute(question);
    if (first.outcome.status !== "succeeded") throw new Error("Synthetic fixture failed");
    const output = strategyJobResultSchema.parse(first.outcome.result);
    const raw = { kind: "redirect", targetStage: "competitors", message: "I'll research competitors in Toronto.", question: null, options: [], selection: null };
    const { outcome, transport } = await execute(raw, guidedInput("competitors", "message", "Toronto", history(output)), responseFixture(raw));
    expect(outcome).toMatchObject({ status: "succeeded", result: { operation: "strategy.reformulate", guidance: { kind: "redirect", turnId: "current-turn", stage: "competitors", targetStage: "competitors" } } });
    expect(outcome).not.toHaveProperty("result.guidance.selection");
    expect(outcome).not.toHaveProperty("result.proposal.competitors");
    expect(vi.mocked(transport.createResponse).mock.calls[0]?.[0]).toMatchObject({ tools: [], tool_choice: "none", instructions: expect.stringContaining("Toronto is a research parameter, never a competitor name or acceptance") });
  });
});
