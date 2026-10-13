import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { strategyPolicy, type OpenAIStrategyConfiguration } from "../../src/server/ai/config";
import { handleApiTextReadiness, readApiTextWorkerReadiness } from "../../worker/hosting/readiness";

function fixture() {
  const query = vi.fn<(sql: string, values: unknown[]) => Promise<{ rows: Array<{ operation?: unknown; ready?: unknown }> }>>()
    .mockResolvedValue({ rows: [{ operation: "strategy.reformulate", ready: true }] });
  const database = vi.fn(() => ({ query }));
  const configuration: OpenAIStrategyConfiguration = { apiKey: "synthetic-never-used",
    policies: new Map([["strategy.reformulate", strategyPolicy("strategy.reformulate")]]) };
  return { query, database, configuration, deploymentId: "dpl_qualified", signal: new AbortController().signal };
}
afterEach(() => vi.useRealTimers());

describe("non-dispatch worker qualification", () => {
  it("queries only existing exact runtime approvals without a caller-supplied owner or budget", async () => {
    const f = fixture();
    expect(await readApiTextWorkerReadiness(f)).toEqual({ version: 1, deploymentId: "dpl_qualified", operations: ["strategy.reformulate"] });
    expect(f.query).toHaveBeenCalledTimes(1);
    const [sql, args] = f.query.mock.calls[0]!;
    expect(sql).toBe("select operation, public.check_api_text_runtime(operation, policy, $2) as ready from jsonb_to_recordset($1::jsonb) as candidate(operation text, policy jsonb)");
    expect(args).toEqual([JSON.stringify([{ operation: "strategy.reformulate", policy: strategyPolicy("strategy.reformulate") }]), "dpl_qualified"]);
  });
  it("reports only approved operations from the exact four-operation allowlist", async () => {
    const f = fixture();
    for (const operation of ["strategy.competitors", "strategy.audience", "strategy.personality", "strategy.positioning"] as const) {
      (f.configuration.policies as Map<string, unknown>).set(operation, strategyPolicy(operation));
    }
    (f.configuration.policies as Map<string, unknown>).set("naming.generate", strategyPolicy("strategy.reformulate"));
    f.query.mockResolvedValue({ rows: [
      { operation: "strategy.reformulate", ready: true }, { operation: "strategy.audience", ready: true },
      { operation: "strategy.personality", ready: false }, { operation: "strategy.positioning", ready: true },
    ] });
    expect((await readApiTextWorkerReadiness(f)).operations).toEqual(["strategy.audience", "strategy.positioning", "strategy.reformulate"]);
    expect(JSON.parse(f.query.mock.calls[0]![1]![0] as string)).toHaveLength(4);
  });
  it("uses the separately granted multi-account qualification only after explicit opt-in", async () => {
    const f = fixture();
    expect((await readApiTextWorkerReadiness({ ...f, multiAccount: true })).operations).toEqual(["strategy.reformulate"]);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls[0]![0]).toBe("select operation, ready from public.api_text_multi_account_readiness($1::jsonb,$2)");
    expect(f.query.mock.calls[0]![1]).toEqual([JSON.stringify([{ operation: "strategy.reformulate", policy: strategyPolicy("strategy.reformulate") }]), "dpl_qualified"]);
  });
  it("returns no readiness without approved provider configuration and never opens a database", async () => {
    const f = fixture();
    expect(await readApiTextWorkerReadiness({ ...f, configuration: null })).toEqual({ version: 1, deploymentId: "dpl_qualified", operations: [] });
    expect(f.database).not.toHaveBeenCalled();
  });
  it("does not query research or a changed cost/handler policy", async () => {
    const f = fixture();
    f.configuration.policies = new Map([
      ["strategy.competitors", strategyPolicy("strategy.competitors")],
      ["strategy.reformulate", { ...strategyPolicy("strategy.reformulate"), maximumCostMicrousd: 1 }],
    ]);
    expect((await readApiTextWorkerReadiness(f)).operations).toEqual([]);
    expect(f.database).not.toHaveBeenCalled();
  });
  it("keeps a disabled/mismatched owner, policy, budget or deployment unavailable", async () => {
    const f = fixture(); f.query.mockResolvedValue({ rows: [{ operation: "strategy.reformulate", ready: false }] });
    expect((await readApiTextWorkerReadiness(f)).operations).toEqual([]);
  });
  it.each([
    [], [{ operation: "strategy.reformulate", ready: "true" }],
    [{ operation: "strategy.competitors", ready: true }],
    [{ operation: "strategy.reformulate", ready: true }, { operation: "strategy.reformulate", ready: true }],
  ])("rejects incomplete, duplicate or malformed runtime rows (%#)", async (...rows) => {
    const f = fixture(); f.query.mockResolvedValue({ rows });
    await expect(readApiTextWorkerReadiness(f)).rejects.toThrow("Runtime unavailable");
  });
  it("stops a stalled database read and never follows it with another operation", async () => {
    vi.useFakeTimers(); const f = fixture(); f.query.mockImplementation(() => new Promise(() => {}));
    const outcome = readApiTextWorkerReadiness(f).catch(() => "unavailable");
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await outcome).toBe("unavailable"); expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("does not open a database after caller cancellation or with an invalid deployment identity", async () => {
    const f = fixture();
    await expect(readApiTextWorkerReadiness({ ...f, signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(readApiTextWorkerReadiness({ ...f, deploymentId: "alias" })).rejects.toThrow();
    expect(f.database).not.toHaveBeenCalled();
  });
});

describe("protected qualification HTTP endpoint", () => {
  function endpoint() {
    const verify = vi.fn(async () => {});
    const inspect = vi.fn(async () => ({ version: 1 as const, deploymentId: "dpl_qualified", operations: ["strategy.reformulate" as const] }));
    return { verify, inspect };
  }
  it("requires the existing exact publisher authentication before database inspection", async () => {
    const f = endpoint(); f.verify.mockRejectedValue(new Error("synthetic-private-auth-detail"));
    const response = await handleApiTextReadiness(new Request("https://worker.invalid/api/readiness"), f);
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it("accepts GET with no input and reports only qualified operations with no cache", async () => {
    const f = endpoint();
    const response = await handleApiTextReadiness(new Request("https://worker.invalid/api/readiness", { headers: { authorization: "Bearer synthetic" } }), f);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: 1, deploymentId: "dpl_qualified", operations: ["strategy.reformulate"] });
    expect(f.verify).toHaveBeenCalledWith("Bearer synthetic");
  });
  it("rejects POST and query arguments without dispatching any inspection", async () => {
    const f = endpoint();
    expect((await handleApiTextReadiness(new Request("https://worker.invalid/api/readiness", { method: "POST", body: "{}" }), f)).status).toBe(405);
    expect((await handleApiTextReadiness(new Request("https://worker.invalid/api/readiness?owner=forged"), f)).status).toBe(400);
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it("sanitizes a refused or failed database read", async () => {
    const f = endpoint(); f.inspect.mockRejectedValue(new Error("synthetic-private-database-detail"));
    const response = await handleApiTextReadiness(new Request("https://worker.invalid/api/readiness"), f);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "runtime_unavailable" });
  });
  it("bounds authentication before starting inspection", async () => {
    vi.useFakeTimers(); const f = endpoint(); let release: (() => void) | undefined;
    f.verify.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const work = handleApiTextReadiness(new Request("https://worker.invalid/api/readiness"), f);
    await vi.advanceTimersByTimeAsync(4_001); expect((await work).status).toBe(401);
    release?.(); await vi.advanceTimersByTimeAsync(1); expect(f.inspect).not.toHaveBeenCalled();
  });
  it("bounds inspection without returning fabricated readiness", async () => {
    vi.useFakeTimers(); const f = endpoint(); f.inspect.mockImplementation(() => new Promise(() => {}));
    const work = handleApiTextReadiness(new Request("https://worker.invalid/api/readiness"), f);
    await vi.advanceTimersByTimeAsync(5_001); expect((await work).status).toBe(503);
  });
});
