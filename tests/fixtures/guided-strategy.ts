import { initializeGuidedInterview } from "../../src/domain/guided-interview";
import { strategyJobInputSchema, type StrategyAssistantHistory } from "../../src/domain/strategy-jobs";
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { jobFixture, reformulationFixture, responseFixture } from "../server/openai-fixtures";

/** Synthetic owned data and transport results; no model or search requests. */
export function guidedJobFixture() {
  const job = jobFixture("strategy.competitors");
  const previous = strategyJobInputSchema.parse(job.input);
  const policy = guidedStrategyPolicy("strategy.competitors");
  const context = initializeGuidedInterview({ ...previous.context, intake: { ...previous.context.intake,
    conversation: [{ id: "actual-message", kind: "user_message", text: "Synthetic bakery idea", createdAt: "2026-10-14T12:00:00.000Z" }],
  } }, { id: "research-turn", userMessageId: "actual-message", stage: "competitors", purpose: "research", inputRevision: 2 });
  const input = strategyJobInputSchema.parse({ version: 2, context, policy, acceptedMaxCostMicrousd: policy.maximumCostMicrousd,
    assistantHistory: { entries: [], truncated: false } });
  if (input.version !== 2) throw new Error("Invalid guided fixture");
  return { ...job, input, inputRevision: 2, reservedCostMicrousd: policy.maximumCostMicrousd };
}

export function guidedResearchResponse() {
  const response = responseFixture({ kind: "choices", message: "Synthetic research result", question: "Which competitor matters?", selection: null, targetStage: null,
    options: [{ label: "Synthetic Bakery", description: "A local alternative with a comparable offering", recommended: true,
      recommendationReason: "Its offering overlaps the synthetic project", payload: { name: "Synthetic Bakery", relevance: "A comparable bakery", url: "https://example.com/", sourceUrls: ["https://example.com/"] } }],
  });
  response.output.unshift({ type: "web_search_call", status: "completed", action: { type: "search", sources: [{ type: "url", url: "https://example.com/", title: "Synthetic observed source" }] } });
  return response;
}

export function guidedHistoryEntry(): StrategyAssistantHistory["entries"][number] {
  const job = jobFixture();
  return { jobId: "0d01417c-342d-4d02-8211-c5fec00e3749", ownerId: job.ownerId, projectId: job.projectId,
    inputRevision: 1, stepKey: "synthetic-prior-result", completedAt: "2026-10-14T11:00:00.000Z",
    output: { version: 1, provider: "openai", model: "gpt-6.1-sol", operation: "strategy.reformulate", responseId: "resp_prior_synthetic",
      requestId: null, generatedAt: "2026-10-14T11:00:00.000Z", proposal: reformulationFixture,
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10, cacheWriteInputTokens: 20, webSearchCalls: 0 } },
  };
}
