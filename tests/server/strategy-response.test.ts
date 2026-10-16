import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { executeStrategyResponse } from "../../src/server/ai/strategy-response";
import { strategyJobResultSchema } from "../../src/domain/strategy-jobs";
import { guidedJobFixture } from "../worker/guided-strategy-fixtures";
import { responseFixture, transportFixture } from "./openai-fixtures";

/** Synthetic reproduction of the retained diagnostic shape, not a replay of
 * the original provider envelope. All names, URLs and text are invented here. */
function unusableResearch(kind: "website" | "source" = "website") {
  const observed = [1, 2, 3, 4].map(index => ({ url: `https://example.com/source/${index}`, title: `Synthetic source ${index}` }));
  const options = observed.map((source, index) => ({
    label: `Synthetic competitor ${index + 1}`, description: "A comparable synthetic offering", recommended: index < 2,
    recommendationReason: index < 2 ? "A relevant comparison for the synthetic project" : null,
    payload: { name: `Synthetic competitor ${index + 1}`, relevance: "Synthetic overlap",
      url: index === 1 && kind === "website" ? "https://unobserved.example/" : source.url,
      sourceUrls: [index === 1 && kind === "source" ? "https://unobserved.example/source" : source.url],
    },
  }));
  const reply = { kind: "choices", targetStage: null, message: "Synthetic competitor research", question: "Which competitors matter?", selection: null, options };
  const response = responseFixture(reply);
  response.usage = { input_tokens: 23838, output_tokens: 1197, total_tokens: 25035,
    input_tokens_details: { cached_tokens: 5441, cache_write_tokens: 1459 } };
  response.output.unshift(
    { type: "web_search_call", status: "completed", action: { type: "search", sources: observed.slice(0, 2) } },
    { type: "reasoning", summary: [{ text: "Synthetic private reasoning must not be retained" }] },
    { type: "web_search_call", status: "completed", action: { type: "search", sources: observed.slice(2) } },
  );
  return response;
}

async function execute(response = unusableResearch(), job = guidedJobFixture()) {
  const transport = transportFixture(response);
  const outcome = await executeStrategyResponse({ job, input: job.input, operation: "strategy.competitors", transport,
    signal: new AbortController().signal, now: () => "2026-10-16T00:40:15.000Z" });
  return { outcome, transport };
}

describe("completed research source rejection (synthetic provider responses)", () => {
  it.each(["website", "source"] as const)("fails bounded completed research with an unobserved %s without accepting output or retrying", async kind => {
    const { outcome, transport } = await execute(unusableResearch(kind));
    expect(outcome).toMatchObject({ status: "failed", code: "provider_research_unusable", costMicrousd: 70038,
      providerRequestId: "resp_synthetic_fixture", result: { observedSourcesTruncated: false,
        usage: { inputTokens: 23838, outputTokens: 1197, cachedInputTokens: 5441, cacheWriteInputTokens: 1459, webSearchCalls: 2 },
        outputDiagnostics: { responseStatus: "completed", outputItemCount: 4, toolCalls: 2, completedToolCalls: 2,
          completedSearchCalls: 2, searchAttemptAtLimitIndex: null, issueCount: 0, issuesTruncated: false, usageExceeded: false },
      },
    });
    expect(strategyJobResultSchema.safeParse(outcome.result).success).toBe(false);
    expect(outcome.result).not.toHaveProperty("proposal");
    expect(outcome.result).not.toHaveProperty("guidance");
    expect(JSON.stringify(outcome)).not.toContain("Synthetic private reasoning");
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
  });

  it("also classifies a completed response below the tool-call maximum as a known failed answer", async () => {
    const response = unusableResearch();
    response.output.splice(2, 1);
    expect((await execute(response)).outcome).toMatchObject({ status: "failed", code: "provider_research_unusable", costMicrousd: 60038 });
  });

  it("accounts for a previous observed charge when the remaining reservation still covers this response", async () => {
    const job = guidedJobFixture(); job.actualCostMicrousd = 100;
    expect((await execute(unusableResearch(), job)).outcome).toMatchObject({ status: "failed", code: "provider_research_unusable", costMicrousd: 70038 });
  });

  it.each(["truncated sources", "truncated text", "unfinished tool", "unsupported tool", "nonterminal envelope", "malformed usage", "wrong model", "wrong tier", "invalid JSON", "invalid schema"])("preserves reconciliation for %s", async variant => {
    const response = unusableResearch();
    if (variant === "truncated sources") response.output[0]!.action = { type: "search", sources: Array.from({ length: 221 }, (_, i) => ({ url: `https://example.com/extra/${i}` })) };
    if (variant === "truncated text") {
      const content = response.output[3]!.content as Array<{ text: string }>;
      const reply = JSON.parse(content[0]!.text);
      reply.message = "Synthetic explanation ".repeat(250);
      reply.options = Array.from({ length: 12 }, () => ({ ...reply.options[1], description: "Synthetic description ".repeat(90) }));
      content[0]!.text = JSON.stringify(reply);
      expect(content[0]!.text.length).toBeGreaterThan(32_000);
    }
    if (variant === "unfinished tool") response.output[2]!.status = "searching";
    if (variant === "unsupported tool") response.output.splice(2, 0, { type: "code_interpreter_call", status: "completed" });
    if (variant === "nonterminal envelope") response.status = "incomplete";
    if (variant === "malformed usage") response.usage.total_tokens = 1;
    if (variant === "wrong model") response.model = "unapproved-model";
    if (variant === "wrong tier") response.service_tier = "unapproved-tier";
    if (variant === "invalid JSON" || variant === "invalid schema") response.output[3]!.content = [
      { type: "output_text", text: variant === "invalid JSON" ? "not JSON" : JSON.stringify({ kind: "choices" }) },
    ];
    const { outcome, transport } = await execute(response);
    expect(outcome.status).toBe("needs_reconciliation");
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
  });

  it.each(["input tokens", "output tokens", "extra completed tool", "policy cost", "remaining reservation"])("retains the hold when completed research exceeds its %s bound", async limit => {
    const response = unusableResearch(), job = guidedJobFixture();
    if (limit === "input tokens") response.usage.input_tokens = job.input.policy.maxInputTokens + 1;
    if (limit === "output tokens") response.usage.output_tokens = job.input.policy.maxOutputTokens + 1;
    if (limit === "extra completed tool") response.output.unshift({ type: "web_search_call", status: "completed", action: { type: "search", sources: [] } });
    if (limit === "policy cost") job.input.policy.maximumCostMicrousd = 70037;
    if (limit === "remaining reservation") job.actualCostMicrousd = job.reservedCostMicrousd - 70037;
    response.usage.total_tokens = response.usage.input_tokens + response.usage.output_tokens;
    expect((await execute(response, job)).outcome.status).toBe("needs_reconciliation");
  });
});
