import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createOpenAIResponsesTransport, OpenAITransportError } from "../../src/server/ai/openai-transport";

describe("OpenAI HTTPS transport (mock fetch only)", () => {
  it("uses the official fixed origin, disables redirects and uses tracing without claiming external idempotency", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ fixture: true }), { headers: { "x-request-id": "req_fixture" } }));
    const transport = createOpenAIResponsesTransport({ apiKey: "synthetic-test-credential", fetch: fetcher });
    const controller = new AbortController();
    expect(await transport.createResponse({ model: "gpt-6.1-sol" }, "fixture-trace-id", controller.signal)).toEqual({ body: { fixture: true }, requestId: "req_fixture" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(options).toMatchObject({ method: "POST", redirect: "error", signal: controller.signal });
    expect(options?.headers).toHaveProperty("X-Client-Request-Id", "fixture-trace-id");
    expect(options?.headers).not.toHaveProperty("Idempotency-Key");
  });

  it("counts tokens with the same request components without an inference call", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ input_tokens: 125 })));
    const transport = createOpenAIResponsesTransport({ apiKey: "synthetic-test-credential", fetch: fetcher });
    expect(await transport.countInputTokens({ model: "gpt-6.1-sol", input: "Synthetic fixture" }, new AbortController().signal)).toBe(125);
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses/input_tokens");
  });

  it.each([400, 401, 403, 404, 413, 422, 429])("sanitizes definite rejection %s without retrying", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("synthetic private provider error", { status, headers: { "x-request-id": "req_fixture" } }));
    const transport = createOpenAIResponsesTransport({ apiKey: "synthetic-test-credential", fetch: fetcher });
    await expect(transport.createResponse({}, "trace", new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected", message: "request_rejected", requestId: "req_fixture" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([408, 409, 500, 502, 503, 504])("quarantines ambiguous HTTP %s", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private error", { status }));
    const transport = createOpenAIResponsesTransport({ apiKey: "synthetic-test-credential", fetch: fetcher });
    await expect(transport.createResponse({}, "trace", new AbortController().signal)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never exposes a transport failure's private error message or repeats its request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("synthetic-private-credential"));
    const transport = createOpenAIResponsesTransport({ apiKey: "synthetic-test-credential", fetch: fetcher });
    const error = await transport.createResponse({}, "trace", new AbortController().signal).catch(error => error);
    expect(error).toBeInstanceOf(OpenAITransportError);
    expect(String(error)).not.toContain("synthetic-private-credential");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds successful response bodies and treats unreadable JSON as an uncertain billed result", async () => {
    for (const body of ["not-json", JSON.stringify({ text: "x".repeat(1_048_576) })]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      const transport = createOpenAIResponsesTransport({ apiKey: "synthetic-test-credential", fetch: fetcher });
      await expect(transport.createResponse({}, "trace", new AbortController().signal)).rejects.toMatchObject({ code: "outcome_unknown" });
    }
  });
});
