import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { executeStrategyResponse } from "../../src/server/ai/strategy-response";
import { strategyJobResultSchema } from "../../src/domain/strategy-jobs";
import { guidedJobFixture } from "../worker/guided-strategy-fixtures";
import { responseFixture, transportFixture } from "./openai-fixtures";

/** Synthetic reproduction of the retained diagnostic shape, not a replay of
 * the original provider envelope. All names, URLs and text are invented here. */
function unusableResearch(kind: "website" | "source" = "website", unverified: "all" | "one" | "none" = "all") {
  const observed = [1, 2, 3, 4].map(index => ({ url: `https://example.com/source/${index}`, title: `Synthetic source ${index}` }));
  const bad = (index: number) => unverified === "all" || (unverified === "one" && index === 1);
  const options = observed.map((source, index) => ({
    label: `Synthetic competitor ${index + 1}`, description: "A comparable synthetic offering", recommended: index < 2,
    recommendationReason: index < 2 ? "A relevant comparison for the synthetic project" : null,
    payload: { name: `Synthetic competitor ${index + 1}`, relevance: "Synthetic overlap",
      url: bad(index) && kind === "website" ? `https://unobserved.example/${index}` : source.url,
      sourceUrls: [bad(index) && kind === "source" ? `https://unobserved.example/source/${index}` : source.url],
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
  it.each(["website", "source"] as const)("keeps only the verified competitors when one cites an unobserved %s", async kind => {
    const { outcome, transport } = await execute(unusableResearch(kind, "one"));
    expect(outcome).toMatchObject({ status: "succeeded", costMicrousd: 70038 });
    const result = strategyJobResultSchema.parse(outcome.result);
    if (result.guidance?.kind !== "choices") throw new Error("Synthetic fixture did not produce choices");
    expect(result.guidance.options.map(option => option.label)).toEqual(["Synthetic competitor 1", "Synthetic competitor 3", "Synthetic competitor 4"]);
    expect(new Set(result.guidance.options.map(option => option.id)).size).toBe(3);
    expect(result.proposal).toMatchObject({ competitors: [{ name: "Synthetic competitor 1" }, { name: "Synthetic competitor 3" }, { name: "Synthetic competitor 4" }] });
    expect(JSON.stringify(result)).not.toContain("unobserved.example");
    // The provider's message may count or name the dropped competitor.
    expect(result.guidance.message).toBe("Here are the competitors research could verify. Choose any that fit, or name others in your own words.");
    expect(transport.createResponse).toHaveBeenCalledTimes(1);
  });

  it("removes inline citation markup from visible text while keeping verified sources", async () => {
    const response = unusableResearch("website", "none");
    const content = response.output[3]!.content as Array<{ text: string }>;
    const reply = JSON.parse(content[0]!.text);
    reply.message = "Here are options ([example.com](https://example.com/source/1)).";
    reply.options[0].description = "Pairs logos with brand kits. ([example.com](https://example.com/source/1?utm_source=openai)) Useful for [comparison](https://example.com/source/1).";
    content[0]!.text = JSON.stringify(reply);
    const result = strategyJobResultSchema.parse((await execute(response)).outcome.result);
    if (result.guidance?.kind !== "choices") throw new Error("Synthetic fixture did not produce choices");
    expect(result.guidance.message).toBe("Here are options.");
    expect(result.guidance.options[0]!.description).toBe("Pairs logos with brand kits. Useful for comparison.");
    expect(result.guidance.options[0]!.payload).toMatchObject({ sources: [{ url: "https://example.com/source/1" }] });
  });

  it.each(["website", "source"] as const)("fails bounded completed research when no competitor's %s was observed, without accepting output or retrying", async kind => {
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
