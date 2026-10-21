import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createOpenAIResponsesTransport } from "../../src/server/ai/openai-transport";
import { evaluateStrategyResponse } from "../../src/server/ai/strategy-response";
import { guidedJobFixture, guidedResearchResponse } from "../worker/guided-strategy-fixtures";

it("requests consulted sources again when polling, preserving strict research verification", async () => {
  const job = guidedJobFixture();
  const full = guidedResearchResponse();
  const withoutSources = structuredClone(full);
  withoutSources.output[0]!.action = { type: "search" };
  const interpret = (body: unknown) => evaluateStrategyResponse({ job, input: job.input,
    operation: "strategy.competitors", raw: { body, requestId: "req_synthetic" } });
  expect(interpret(withoutSources)).toMatchObject({ status: "failed", code: "provider_research_unusable" });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    expect(init?.method).toBe("GET");
    expect(init).not.toHaveProperty("body");
    const include = new URL(String(url)).searchParams.getAll("include[]");
    return new Response(JSON.stringify(include.includes("web_search_call.action.sources") ? full : withoutSources));
  });
  const transport = createOpenAIResponsesTransport({ apiKey: "synthetic-test-credential", fetch: fetcher });
  const response = await transport.retrieveResponse!(full.id, new AbortController().signal);
  expect(interpret(response.body)).toMatchObject({ status: "succeeded" });
  expect(fetcher).toHaveBeenCalledOnce();
});
