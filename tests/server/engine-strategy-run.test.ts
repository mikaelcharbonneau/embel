import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { FatalError, RetryableError } from "workflow";
import { initializeGuidedInterview } from "../../src/domain/guided-interview";
import { contextSnapshotSchema, type GuidedStage } from "../../src/domain/projects";
import { strategyJobResultSchema, type StrategyOperation } from "../../src/domain/strategy-jobs";
import {
  createEngineOpenAI,
  EngineProviderError,
  type BackgroundResponse,
  type EngineOpenAI,
} from "../../src/server/engine/openai";
import { enginePolicyIdentity, engineStrategyPolicy, strategyRunInputSchema } from "../../src/server/engine/strategy";
import {
  attemptRequest,
  createStrategyAttempt,
  pollStrategyAttempt,
  prepareStrategyAttempt,
  readStrategyRun,
  settleStrategyAttempt,
  stopStrategyAttempt,
  StrategyRunError,
  type ClaimedStrategyRun,
  type StrategyRunDeps,
} from "../../src/server/engine/strategy-run";

// Synthetic transports and responses only; no live inference.
const owner = "aaaaaaaa-1111-4111-8111-111111111111",
  project = "bbbbbbbb-2222-4222-8222-222222222222",
  runId = "cccccccc-3333-4333-8333-333333333333";
const now = "2026-11-09T20:00:00.000Z";

function claimed(
  stage: GuidedStage = "competitors",
  revision = 2,
  overrides: { policy?: unknown } = {},
): ClaimedStrategyRun {
  const operation: StrategyOperation = `strategy.${stage}`;
  const context = initializeGuidedInterview(
    contextSnapshotSchema.parse({
      description: "Synthetic bakery brief",
      intake: {
        conversation: [
          { id: "first-message", kind: "user_message", text: "Office bread subscriptions", createdAt: now },
        ],
      },
    }),
    {
      id: "current-turn",
      userMessageId: "first-message",
      stage,
      purpose: stage === "competitors" ? "research" : "propose",
      inputRevision: revision,
    },
  );
  const policy = overrides.policy ?? engineStrategyPolicy(operation);
  const input = {
    revision,
    request: {
      version: 3,
      context,
      policy,
      assistantHistory: { entries: [], truncated: false },
      spendControl: "uncapped",
      policyIdentity: enginePolicyIdentity(operation),
    },
  };
  return { id: runId, ownerId: owner, projectId: project, kind: operation, input };
}

const competitor = {
  name: "Synthetic Bakery",
  relevance: "Delivers bread to offices",
  url: "https://example.com/",
  sourceUrls: ["https://example.com/"],
};
function choices(payload: unknown = competitor) {
  return {
    kind: "choices",
    targetStage: null,
    message: "Here are brands you compete with.",
    question: "Which should we compare against?",
    selection: null,
    options: [
      {
        label: "Synthetic Bakery",
        description: "A useful explanation",
        recommended: true,
        recommendationReason: "Closest offer",
        payload,
      },
    ],
  };
}
function response(text: string, status = "completed", search = true) {
  return {
    id: "resp_synthetic_engine",
    model: "gpt-6.1-sol",
    service_tier: "default",
    status,
    usage: {
      input_tokens: 20_000,
      output_tokens: 800,
      total_tokens: 20_800,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    },
    output: [
      ...(search
        ? [
            {
              type: "web_search_call",
              status: "completed",
              action: {
                type: "search",
                sources: [{ type: "url", url: "https://example.com/", title: "Synthetic source" }],
              },
            },
          ]
        : []),
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
  };
}
const background = (body: { id: string; status: string }): BackgroundResponse => ({
  id: body.id,
  status: body.status as BackgroundResponse["status"],
  body,
  requestId: "req_synthetic",
});

function openai(
  overrides: Partial<EngineOpenAI> = {},
): EngineOpenAI & { [K in keyof EngineOpenAI]: ReturnType<typeof vi.fn> } {
  return {
    countInputTokens: vi.fn(async () => 1_200),
    create: vi.fn(async () => background({ id: "resp_synthetic_engine", status: "queued" })),
    retrieve: vi.fn(async () => background(response(JSON.stringify(choices())))),
    cancel: vi.fn(async () => background({ ...response("", "cancelled"), status: "cancelled" })),
    ...overrides,
  } as never;
}
function deps(provider: EngineOpenAI, check = { status: "running", cancelRequested: false, paused: false }) {
  const save = vi.fn<StrategyRunDeps["save"]>(async () => true);
  return { openai: provider, check: vi.fn(async () => check), save } satisfies StrategyRunDeps;
}

describe("reading a Strategy run's frozen input", () => {
  it("accepts the hosted guided policy and binds the run's revision", () => {
    const { operation, job } = readStrategyRun(claimed());
    expect(operation).toBe("strategy.competitors");
    expect(job).toMatchObject({
      id: runId,
      ownerId: owner,
      projectId: project,
      inputRevision: 2,
      reservedCostMicrousd: 0,
    });
  });
  it("refuses another model or limit, and malformed input", () => {
    const changed = { ...engineStrategyPolicy("strategy.competitors"), maxOutputTokens: 99_999 };
    expect(() => readStrategyRun(claimed("competitors", 2, { policy: changed }))).toThrow(StrategyRunError);
    expect(() => readStrategyRun({ ...claimed(), input: { revision: 2 } })).toThrow("invalid_run_input");
    expect(() => readStrategyRun({ ...claimed(), kind: "engine.probe" })).toThrow("invalid_run_input");
  });
  it("keeps the request inside start_generation's input limit for a fresh project", () => {
    expect(
      new TextEncoder().encode(JSON.stringify(strategyRunInputSchema.parse(claimed().input))).byteLength,
    ).toBeLessThan(56_000);
  });
});

describe("preparing and creating a background response", () => {
  it("builds the exact request once, with free token counting and a stable request key", async () => {
    const provider = openai();
    const prepared = await prepareStrategyAttempt(claimed(), provider);
    expect(provider.countInputTokens).toHaveBeenCalledOnce();
    expect(prepared.request).toMatchObject({
      model: "gpt-6.1-sol",
      tool_choice: "required",
      max_tool_calls: 2,
      service_tier: "default",
    });
    expect(prepared.requestKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(await prepareStrategyAttempt(claimed(), openai())).toEqual(prepared);
  });
  it("retries a token count outage and refuses a turn that doesn't match the run", async () => {
    await expect(
      prepareStrategyAttempt(
        claimed(),
        openai({
          countInputTokens: vi.fn(async () => {
            throw new Error("offline");
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(EngineProviderError);
    const stale = claimed();
    stale.input = { ...(stale.input as object), revision: 3 };
    await expect(prepareStrategyAttempt(stale, openai())).rejects.toThrow("guided_request_mismatch");
  });
  it("re-prompts once with the unusable reply and an instruction, under its own request key", async () => {
    const provider = openai();
    const prepared = await prepareStrategyAttempt(claimed(), provider);
    await createStrategyAttempt(provider, prepared, 1, null);
    await createStrategyAttempt(provider, prepared, 2, { code: "provider_invalid_output", previousText: "{not json" });
    expect(provider.create.mock.calls[0]).toEqual([prepared.request, prepared.requestKey]);
    const [second, key] = provider.create.mock.calls[1]!;
    expect(key).toBe(`${prepared.requestKey}:2`);
    expect(second.input).toEqual([
      ...(prepared.request.input as unknown[]),
      { role: "assistant", content: "{not json" },
      { role: "user", content: expect.stringContaining("Reply again with JSON") },
    ]);
    expect(attemptRequest(prepared, { code: "provider_research_missing", previousText: null }).input).toHaveLength(
      (prepared.request.input as unknown[]).length + 1,
    );
  });
});

describe("polling, settling and stopping", () => {
  it("stops before polling when the run was cancelled or the engine paused", async () => {
    const provider = openai();
    expect(
      await pollStrategyAttempt(
        deps(provider, { status: "running", cancelRequested: true, paused: false }),
        runId,
        "resp_synthetic_engine",
      ),
    ).toEqual({ state: "stop", code: "cancelled" });
    expect(
      await pollStrategyAttempt(
        deps(provider, { status: "running", cancelRequested: false, paused: true }),
        runId,
        "resp_synthetic_engine",
      ),
    ).toEqual({ state: "stop", code: "generation_paused" });
    expect(provider.retrieve).not.toHaveBeenCalled();
  });
  it("reports pending until the response finishes", async () => {
    const provider = openai({
      retrieve: vi.fn(async () => background({ id: "resp_synthetic_engine", status: "in_progress" })),
    });
    expect(await pollStrategyAttempt(deps(provider), runId, "resp_synthetic_engine")).toEqual({ state: "pending" });
    expect(await pollStrategyAttempt(deps(openai()), runId, "resp_synthetic_engine")).toEqual({ state: "terminal" });
  });
  it("saves a verified result once, with its response id and cost from usage", async () => {
    const run = deps(openai());
    expect(await settleStrategyAttempt(run, claimed(), "resp_synthetic_engine", 1)).toEqual({ state: "succeeded" });
    const [savedRun, key, output, responseId, cost] = run.save.mock.calls[0]!;
    expect([savedRun, key, responseId]).toEqual([runId, "result", "resp_synthetic_engine"]);
    expect(strategyJobResultSchema.parse(output).guidance).toMatchObject({
      kind: "choices",
      turnId: "current-turn",
      options: [{ payload: { origin: "research" } }],
    });
    // 20,000 input tokens at $2/M plus 800 output at $10/M plus one search at $0.01.
    expect(cost).toBe(40_000 + 8_000 + 10_000);
  });
  it("records an unusable reply as a correctable attempt and a refusal as final", async () => {
    const invalid = deps(openai({ retrieve: vi.fn(async () => background(response("{not json"))) }));
    expect(await settleStrategyAttempt(invalid, claimed(), "resp_synthetic_engine", 1)).toEqual({
      state: "failed",
      code: "provider_invalid_output",
      correctable: true,
      previousText: "{not json",
    });
    expect(invalid.save).toHaveBeenCalledWith(
      runId,
      "attempt.1",
      { code: "provider_invalid_output" },
      "resp_synthetic_engine",
      58_000,
    );
    const refusal = response("");
    refusal.output[1] = {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "refusal", refusal: "No." }],
    } as never;
    const refused = deps(openai({ retrieve: vi.fn(async () => background(refusal)) }));
    expect(await settleStrategyAttempt(refused, claimed(), "resp_synthetic_engine", 2)).toMatchObject({
      state: "failed",
      code: "provider_refusal",
      correctable: false,
    });
  });
  it("cancels the open response at OpenAI and keeps what it cost", async () => {
    const provider = openai();
    const run = deps(provider);
    expect(await stopStrategyAttempt(run, claimed(), "resp_synthetic_engine", 1, "cancelled")).toEqual({
      state: "stopped",
      code: "cancelled",
    });
    expect(provider.cancel).toHaveBeenCalledWith("resp_synthetic_engine");
    expect(run.save).toHaveBeenCalledWith(runId, "attempt.1", { code: "cancelled" }, "resp_synthetic_engine", 58_000);
    const gone = deps(
      openai({
        cancel: vi.fn(async () => {
          throw new EngineProviderError("rejected", 404);
        }),
      }),
    );
    expect(await stopStrategyAttempt(gone, claimed(), "resp_synthetic_engine", 1, "provider_timeout")).toEqual({
      state: "failed",
      code: "provider_timeout",
      correctable: false,
      previousText: null,
    });
    expect(gone.save).toHaveBeenCalledWith(
      runId,
      "attempt.1",
      { code: "provider_timeout" },
      "resp_synthetic_engine",
      0,
    );
  });
});

describe("OpenAI background helper", () => {
  const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const client = (fetcher: typeof fetch) => createEngineOpenAI({ apiKey: "sk-synthetic-engine-key", fetch: fetcher });
  const failure = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      return error as EngineProviderError;
    }
    throw new Error("Expected a failure");
  };

  it("creates in background mode without storing, and reads the id", async () => {
    const fetcher = vi.fn(async () => reply(200, { id: "resp_created", status: "queued" }));
    expect(await client(fetcher as never).create({ model: "gpt-6.1-sol" }, "key-1")).toMatchObject({
      id: "resp_created",
      status: "queued",
    });
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "gpt-6.1-sol",
      background: true,
      store: false,
      stream: false,
    });
    expect(init.redirect).toBe("error");
  });
  it("retries 429 and 5xx, never re-sends an uncertain create, and refuses other 4xx", async () => {
    expect(
      await failure(() => client(vi.fn(async () => reply(429, {}, { "retry-after": "7" })) as never).create({}, "k")),
    ).toMatchObject({ disposition: "retry", status: 429, retryAfterMs: 7000 });
    expect(await failure(() => client(vi.fn(async () => reply(503)) as never).create({}, "k"))).toMatchObject({
      disposition: "retry",
    });
    expect(await failure(() => client(vi.fn(async () => reply(400)) as never).create({}, "k"))).toMatchObject({
      disposition: "rejected",
    });
    expect(await failure(() => client(vi.fn(async () => reply(504)) as never).create({}, "k"))).toMatchObject({
      disposition: "uncertain",
    });
    expect(await failure(() => client(vi.fn(async () => reply(504)) as never).retrieve("resp_x"))).toMatchObject({
      disposition: "retry",
    });
    expect(
      await failure(() => client(vi.fn(async () => reply(200, { nope: true })) as never).create({}, "k")),
    ).toMatchObject({ disposition: "uncertain" });
  });
  it("retries a connection that never opened but not one dropped after sending", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    expect(
      await failure(() =>
        client(
          vi.fn(async () => {
            throw refused;
          }) as never,
        ).create({}, "k"),
      ),
    ).toMatchObject({ disposition: "retry" });
    expect(
      await failure(() =>
        client(
          vi.fn(async () => {
            throw reset;
          }) as never,
        ).create({}, "k"),
      ),
    ).toMatchObject({ disposition: "uncertain" });
    expect(
      await failure(() =>
        client(
          vi.fn(async () => {
            throw reset;
          }) as never,
        ).cancel("resp_x"),
      ),
    ).toMatchObject({ disposition: "retry" });
  });
});

describe("workflow step decisions", () => {
  it("turns provider dispositions into retry or fail-now for the workflow", async () => {
    const thrown = { error: new EngineProviderError("retry", 429, 3000) as Error };
    vi.doMock("../../src/server/engine/openai", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      engineOpenAI: () =>
        openai({
          create: vi.fn(async () => {
            throw thrown.error;
          }),
        }),
    }));
    const { createStrategyResponse } = await import("../../src/workflows/strategy-steps");
    const prepared = { request: { model: "gpt-6.1-sol" }, requestKey: "a".repeat(64) };
    await expect(createStrategyResponse(prepared, 1, null)).rejects.toBeInstanceOf(RetryableError);
    thrown.error = new EngineProviderError("uncertain", null);
    await expect(createStrategyResponse(prepared, 1, null)).rejects.toThrow(new FatalError("provider_outcome_unknown"));
    thrown.error = new EngineProviderError("rejected", 400);
    await expect(createStrategyResponse(prepared, 1, null)).rejects.toThrow("provider_request_rejected");
    vi.doUnmock("../../src/server/engine/openai");
  });
});
