import { vi } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { strategyPolicy } from "../../src/server/ai/config";
import type { ClaimedJob } from "../../src/domain/jobs";
import type { StrategyJobInput, StrategyOperation } from "../../src/domain/strategy-jobs";
import type { OpenAIResponsesTransport } from "../../src/server/ai/openai-transport";

// Synthetic transport fixtures only. Never presented as real model or research output.
export const reformulationFixture = {
  message: "Synthetic reformulation fixture",
  activity: "Workshop",
  offering: "Classes",
  knownAudience: "",
  questions: [],
};
export function inputFixture(operation: StrategyOperation = "strategy.reformulate"): StrategyJobInput {
  const policy = strategyPolicy(operation);
  return {
    version: 1,
    context: contextSnapshotSchema.parse({ description: "Synthetic workshop fixture" }),
    policy,
    acceptedMaxCostMicrousd: policy.maximumCostMicrousd,
  };
}
export function jobFixture(operation: StrategyOperation = "strategy.reformulate"): ClaimedJob {
  const input = inputFixture(operation);
  return {
    id: "4d01417c-342d-4d02-8211-c5fec00e3749",
    projectId: "6d01417c-342d-4d02-8211-c5fec00e3749",
    ownerId: "5d01417c-342d-4d02-8211-c5fec00e3749",
    operation,
    input,
    inputRevision: 1,
    leaseToken: "7d01417c-342d-4d02-8211-c5fec00e3749",
    status: "running",
    actualCostMicrousd: 0,
    reservedCostMicrousd: input.policy.maximumCostMicrousd,
  };
}
export function responseFixture(proposal: unknown = reformulationFixture) {
  return {
    id: "resp_synthetic_fixture",
    model: "gpt-6.1-sol",
    service_tier: "default",
    status: "completed",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 10, cache_write_tokens: 20 },
    },
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(proposal), annotations: [] }],
      },
    ] as Array<Record<string, unknown>>,
  };
}
export function transportFixture(body: unknown = responseFixture()): OpenAIResponsesTransport {
  return {
    countInputTokens: vi.fn(async () => 200),
    createResponse: vi.fn(async () => ({ body, requestId: "req_synthetic_fixture" })),
  };
}
