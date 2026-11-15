// @vitest-environment jsdom
import { act, createElement, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import type { GenerationRun } from "@/domain/generations";
import type { StrategyOverview } from "@/domain/strategy-jobs";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { engineStrategyJob, strategyCreditsMessage } from "@/components/workspace/account-strategy-client";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { useStrategyJobs } from "@/components/workspace/use-strategy-jobs";
import type { VerifiedAccount } from "@/components/workspace/account-session";

// The Strategy screens on the generation engine: runs come from /generations (synthetic fixtures).
const mock = vi.hoisted(() => ({
  memory: null as ReturnType<typeof createAccountDraftMemory> | null,
  current: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ drafts: mock.memory, isCurrent: mock.current, expire: mock.expire }),
}));
const projectId = "bbbbbbbb-1111-4111-8111-111111111111",
  runId = "cccccccc-1111-4111-8111-111111111111",
  when = "2026-11-09T20:00:00Z";
const identity = "a".repeat(64);
const allowance = { billingMode: "openai_api" as const, spendControl: "uncapped" as const, policyIdentity: identity };
const engineAvailability: StrategyOverview["availability"] = {
  status: "available",
  operations: ["strategy.competitors", "strategy.audience"].map((operation) => ({
    operation: operation as "strategy.competitors",
    billingMode: "openai_api" as const,
    spendControl: "uncapped" as const,
    policyIdentity: identity,
    interviewVersion: 1 as const,
  })),
};
const result = {
  version: 1,
  provider: "openai",
  operation: "strategy.competitors",
  model: "gpt-6.1-sol",
  responseId: "resp_synthetic",
  requestId: null,
  generatedAt: when,
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 1 },
  proposal: { message: "Synthetic research", competitors: [] },
};
const run = (overrides: Partial<GenerationRun> = {}): GenerationRun => ({
  id: runId,
  kind: "strategy.competitors",
  status: "running",
  credits: 1,
  errorCode: null,
  cancelRequested: false,
  createdAt: when,
  finishedAt: null,
  inputRevision: 1,
  outputs: [],
  ...overrides,
});

let root: Root | null, host: HTMLDivElement, api: ReturnType<typeof useStrategyJobs>, account: VerifiedAccount;
let overview: StrategyOverview, runs: GenerationRun[], fetcher: ReturnType<typeof vi.fn>;
function Harness() {
  const workspace = useSyncExternalStore(mock.memory!.subscribe, () => mock.memory!.get(projectId)!);
  const value = useStrategyJobs({ account, workspace, blocked: false, guided: true });
  useLayoutEffect(() => {
    api = value;
  });
  return null;
}
async function render() {
  await act(async () => root!.render(createElement(Harness)));
}
const calls = (method: string, path?: string) =>
  fetcher.mock.calls.filter(
    ([url, init]) => (init.method ?? "GET") === method && (!path || String(url).startsWith(path)),
  );
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  account = { status: "ready", userId: crypto.randomUUID(), generation: 1 };
  mock.current
    .mockReset()
    .mockImplementation(
      (value: VerifiedAccount) => value.userId === account.userId && value.generation === account.generation,
    );
  mock.expire.mockReset();
  mock.memory = createAccountDraftMemory();
  const project = accountProjectSchema.parse({
    id: projectId,
    owner_id: account.userId,
    title: "Engine fixture",
    scope: "complete_brand",
    current_revision: 1,
    created_at: when,
    context: { description: "A neighborhood bakery" },
  });
  mock.memory.set({
    ownerId: account.userId,
    generation: 1,
    saved: project,
    draft: accountProjectDraft(project),
    conflict: false,
  });
  overview = { engine: true, availability: engineAvailability, jobs: [] };
  runs = [];
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === "GET" && path === `/api/projects/${projectId}/strategy`) return Response.json(overview);
    if (init.method === "GET" && path === `/api/projects/${projectId}/generations?step=strategy`)
      return Response.json({ runs });
    throw new Error(`Unexpected fixture request ${init.method} ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Strategy on the generation engine", () => {
  it("shows engine runs as Strategy jobs and polls only their status every 3 s while one runs", async () => {
    runs = [run()];
    await render();
    expect(api.overview?.jobs).toEqual([
      expect.objectContaining({
        id: runId,
        operation: "strategy.competitors",
        input_revision: 1,
        state: "running",
        results: [],
      }),
    ]);
    const before = {
      overview: calls("GET", `/api/projects/${projectId}/strategy`).length,
      runs: calls("GET", `/api/projects/${projectId}/generations`).length,
    };
    runs = [
      run({
        status: "succeeded",
        finishedAt: when,
        outputs: [
          { key: "attempt.1", output: { code: "provider_invalid_output" } },
          { key: "result", output: result },
        ],
      }),
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(calls("GET", `/api/projects/${projectId}/generations`).length).toBe(before.runs + 1);
    expect(calls("GET", `/api/projects/${projectId}/strategy`).length).toBe(before.overview);
    expect(api.overview?.jobs[0]).toMatchObject({
      state: "succeeded",
      results: [{ stepKey: "result", output: { proposal: { message: "Synthetic research" } } }],
    });
  });

  it("starts a request with the revision only, under one key per revision and operation", async () => {
    await render();
    fetcher.mockImplementation(async (path: string, init: RequestInit) =>
      init.method === "POST"
        ? ((runs = [run({ status: "queued" })]), Response.json({ run: runs[0] }, { status: 202 }))
        : path.includes("/generations")
          ? Response.json({ runs })
          : Response.json(overview),
    );
    await act(async () => {
      await api.enqueue("strategy.competitors", 1, allowance);
    });
    const [path, init] = calls("POST")[0]!;
    expect(path).toBe(`/api/projects/${projectId}/generations`);
    expect(JSON.parse(init.body)).toEqual({
      kind: "strategy.competitors",
      idempotencyKey: `strategy.engine.v1:${projectId}:1:strategy.competitors`,
      input: { expectedRevision: 1 },
    });
    expect(calls("POST", `/api/projects/${projectId}/strategy`)).toHaveLength(0);
    expect(api.actionError).toBeNull();
    expect(api.overview?.jobs[0]).toMatchObject({ id: runId, state: "queued" });
  });

  it("cancels an engine run through its own route", async () => {
    runs = [run()];
    await render();
    fetcher.mockImplementation(async (path: string, init: RequestInit) =>
      init.method === "POST"
        ? ((runs = [run({ cancelRequested: true })]), Response.json({ run: runs[0] }))
        : path.includes("/generations")
          ? Response.json({ runs })
          : Response.json(overview),
    );
    await act(async () => {
      await api.cancel(api.overview!.jobs[0]!);
    });
    expect(calls("POST")[0]![0]).toBe(`/api/projects/${projectId}/generations/${runId}/cancel`);
    expect(api.overview?.jobs[0]).toMatchObject({ state: "cancel_requested" });
  });

  it("explains running out of credits with the renewal date, never a price", async () => {
    await render();
    fetcher.mockImplementation(async (path: string, init: RequestInit) =>
      init.method === "POST"
        ? Response.json({ error: { code: "insufficient_credits" } }, { status: 402 })
        : path === "/api/credits"
          ? Response.json({ credits: { planId: "free", balance: 0, periodEnd: "2026-12-01T00:00:00+00:00" } })
          : path.includes("/generations")
            ? Response.json({ runs })
            : Response.json(overview),
    );
    await act(async () => {
      await api.enqueue("strategy.competitors", 1, allowance);
    });
    expect(api.actionError).toBe(
      "You’ve used this month’s credits. They renew on December 1. Your conversation is saved.",
    );
    expect(api.actionError).not.toMatch(/\$/u);
  });

  it("re-sends the same request once for a run whose workflow never started", async () => {
    runs = [run({ status: "queued", createdAt: new Date(Date.now() - 60_000).toISOString() })];
    fetcher.mockImplementation(async (path: string, init: RequestInit) =>
      init.method === "POST"
        ? Response.json({ run: runs[0] }, { status: 202 })
        : path.includes("/generations")
          ? Response.json({ runs })
          : Response.json(overview),
    );
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(calls("POST")).toHaveLength(1);
    expect(JSON.parse(calls("POST")[0]![1].body)).toMatchObject({
      idempotencyKey: `strategy.engine.v1:${projectId}:1:strategy.competitors`,
    });
  });
});

describe("Strategy handles a run like the other step screens", () => {
  const answer = (post: () => Response) => (path: string, init: RequestInit) =>
    Promise.resolve(
      init.method === "POST"
        ? post()
        : path === "/api/credits"
          ? Response.json({ credits: { planId: "free", balance: 0, periodEnd: "2026-12-01T00:00:00+00:00" } })
          : path.includes("/generations")
            ? Response.json({ runs })
            : Response.json(overview),
    );

  it("keeps progress, Stop and the 3 s pace when a status check fails while a run works", async () => {
    runs = [run()];
    await render();
    expect(api.view).toMatchObject({ working: true, canStop: true, message: null });
    fetcher.mockImplementation(async (path: string) => {
      if (path.includes("/generations")) return new Response(null, { status: 500 });
      return Response.json(overview);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(api.readError).not.toBeNull();
    expect(api.overview?.jobs[0]).toMatchObject({ id: runId, state: "running" });
    expect(api.view).toMatchObject({ working: true, canStop: true, message: "updates_delayed" });
    expect(api.view.sentence).toBe(api.readError);
    // It keeps checking at the working pace instead of dropping to every 15 s.
    const before = calls("GET", `/api/projects/${projectId}/generations`).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(calls("GET", `/api/projects/${projectId}/generations`).length).toBe(before + 1);
  });

  it.each([
    [402, "out_of_credits"],
    [429, "daily_limit"],
  ])("offers no Try again after a %s, which would be refused again", async (status, message) => {
    await render();
    fetcher.mockImplementation(answer(() => Response.json({ error: { code: "refused" } }, { status })));
    await act(async () => {
      await api.enqueue("strategy.competitors", 1, allowance);
    });
    expect(api.view).toMatchObject({ message, retry: null, keepRequest: false, working: false });
    expect(api.view.sentence).toBe(api.actionError);
    expect(api.actionError).not.toMatch(/\$/u);
  });

  it("keeps an unanswered start, and Try again repeats the same request under the same key", async () => {
    await render();
    fetcher.mockImplementation(answer(() => new Response(null, { status: 503 })));
    await act(async () => {
      await api.enqueue("strategy.competitors", 1, allowance);
    });
    expect(api.view).toMatchObject({
      message: "start_unconfirmed",
      retry: "start",
      keepRequest: true,
      canStart: false,
    });
    // No matching run appeared, so the message stays until the person retries.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(api.view.message).toBe("start_unconfirmed");
    fetcher.mockImplementation(
      answer(
        () => (
          (runs = [run({ status: "queued", createdAt: new Date().toISOString() })]),
          Response.json({ run: runs[0] }, { status: 202 })
        ),
      ),
    );
    await act(async () => {
      await api.enqueue("strategy.competitors", 1, allowance);
    });
    const keys = calls("POST").map(([, init]) => JSON.parse(init.body).idempotencyKey);
    expect(keys).toEqual(Array(2).fill(`strategy.engine.v1:${projectId}:1:strategy.competitors`));
    expect(api.view).toMatchObject({ working: true, message: null });
    expect(api.actionError).toBeNull();
  });

  it("clears an unanswered start once a status check finds the one run it made", async () => {
    await render();
    fetcher.mockImplementation(
      answer(() => ((runs = [run({ status: "queued", createdAt: new Date().toISOString() })]), Response.error())),
    );
    await act(async () => {
      await api.enqueue("strategy.competitors", 1, allowance);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls("POST")).toHaveLength(1);
    expect(api.actionError).toBeNull();
    expect(api.view).toMatchObject({ working: true, canStop: true, message: null });
  });

  it("does not ask to stop a run that is already stopping, and says so", async () => {
    runs = [run({ cancelRequested: true })];
    await render();
    expect(api.view).toMatchObject({ working: true, stopping: true, canStop: false, message: "stopping" });
    await act(async () => {
      await api.cancel(api.overview!.jobs[0]!);
    });
    expect(calls("POST")).toHaveLength(0);
  });

  it("reports a Stop that could not be confirmed, with the run still working", async () => {
    runs = [run()];
    await render();
    fetcher.mockImplementation(answer(() => new Response(null, { status: 500 })));
    await act(async () => {
      await api.cancel(api.overview!.jobs[0]!);
    });
    expect(api.pending).toBe(false);
    expect(api.view).toMatchObject({ working: true, canStop: true, retry: "stop", message: "stop_unconfirmed" });
    expect(api.view.sentence).toBe(api.actionError);
  });
});

describe("engine run mapping", () => {
  it("keeps only a verified result, and none for a run that did not succeed", () => {
    const ownerId = "aaaaaaaa-1111-4111-8111-111111111111";
    expect(
      engineStrategyJob(run({ status: "succeeded", outputs: [{ key: "result", output: result }] }), ownerId, projectId)
        ?.results,
    ).toHaveLength(1);
    expect(
      engineStrategyJob(
        run({ status: "failed", errorCode: "provider_refusal", outputs: [{ key: "result", output: result }] }),
        ownerId,
        projectId,
      ),
    ).toMatchObject({ state: "failed", error_code: "provider_refusal", results: [] });
    expect(
      engineStrategyJob(
        run({
          status: "succeeded",
          outputs: [{ key: "result", output: { ...result, operation: "strategy.audience" } }],
        }),
        ownerId,
        projectId,
      )?.results,
    ).toEqual([]);
    expect(engineStrategyJob(run({ kind: "engine.probe" }), ownerId, projectId)).toBeNull();
    expect(engineStrategyJob(run({ inputRevision: null }), ownerId, projectId)).toBeNull();
    expect(strategyCreditsMessage(null)).toBe("You’ve used this month’s credits. Your conversation is saved.");
  });
});
