import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Pool } from "pg";
import type { ChatGPTTransport } from "../../src/server/ai/chatgpt-transport";
import { expireStandaloneNamesLeases, reportStandaloneNamesReady, runOneStandaloneNamesJob } from "../../worker/standalone-names";
import { other, owner, policy, proposal, workerFixture } from "../fixtures/standalone-names";
function fixture() {
  const input = workerFixture();
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    void _args; // Keep the recorded parameter tuple available for the assertions below.
    if (sql.includes("claim_standalone_names")) return { rows: [{ input }] };
    if (sql.includes("pulse_standalone_names")) return { rows: [{ state: "running" }] };
    if (sql.includes("finish_standalone_names")) return { rows: [{ saved: true }] };
    return { rows: [{ ready: true }] };
  });
  const text = JSON.stringify({ candidates: [proposal] });
  const transport: ChatGPTTransport = { listModels: vi.fn(), streamResponse: vi.fn(async (_request, options) => {
    await options.beforeDispatch?.(); await options.onTextDelta?.(text);
    return { status: "completed" as const, accountId: policy.registrationId, responseId: "fixture-response", requestId: null, partialText: text,
      response: { id: "fixture-response", model: policy.model, status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] } };
  }) };
  const assertReady = vi.fn(async () => {});
  const controller = new AbortController(); const database = { query } as unknown as Pick<Pool, "query">;
  return { input, query, transport, controller, database, assertReady, run: () => runOneStandaloneNamesJob({ database, ownerId: owner, policy: input.policy, transport, signal: controller.signal, assertReady }) };
}
afterEach(() => vi.useRealTimers());
describe("dedicated standalone naming worker", () => {
  it("claims once, fences physical dispatch, retains partial output and publishes one validated result", async () => {
    const f = fixture(); expect(await f.run()).toBe(true);
    expect(f.transport.streamResponse).toHaveBeenCalledOnce();
    const begin = f.query.mock.calls.find(([sql]) => sql.includes("pulse_standalone_names"));
    expect(begin).toBeDefined();
    const finished = f.query.mock.calls.find(([sql]) => sql.includes("finish_standalone_names")) as unknown as [string, unknown[]];
    expect(finished[1][2]).toBe("succeeded"); expect(JSON.parse(finished[1][3] as string).candidates).toEqual([proposal]); expect(finished[1][4]).toContain("Fixture Clay");
  });
  it("never dispatches a foreign-owner or changed-model claim", async () => {
    const f = fixture(); f.input.job.ownerId = other; expect(await f.run()).toBe(false); expect(f.transport.streamResponse).not.toHaveBeenCalled();
  });
  it("keeps an unapplied/disabled standalone runtime from breaking project work", async () => {
    const f = fixture(); f.query.mockRejectedValue(new Error("Fixture missing narrow RPC grant"));
    await expect(expireStandaloneNamesLeases(f.database)).resolves.toBeUndefined();
    expect(await reportStandaloneNamesReady(f.database, policy)).toBe(false); expect(await f.run()).toBe(false); expect(f.transport.streamResponse).not.toHaveBeenCalled();
  });
  it("sweeps expired leases in maintenance mode without selecting a model or dispatching", async () => {
    const f = fixture(); await expireStandaloneNamesLeases(f.database);
    expect(f.query).toHaveBeenCalledExactlyOnceWith("select public.claim_standalone_names(null::jsonb)");
    expect(f.transport.streamResponse).not.toHaveBeenCalled();
  });
  it("does not publish a success after the session changes", async () => {
    const f = fixture(); f.assertReady.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Fixture session changed"));
    expect(await f.run()).toBe(true);
    const finished = f.query.mock.calls.find(([sql]) => sql.includes("finish_standalone_names")) as unknown as [string, unknown[]];
    expect(finished[1][2]).toBe("needs_reconciliation"); expect(finished[1][3]).toBeNull(); expect(f.transport.streamResponse).toHaveBeenCalledOnce();
  });
  it("quarantines a provider that ignores cancellation within five seconds, without retrying", async () => {
    vi.useFakeTimers(); const f = fixture();
    vi.mocked(f.transport.streamResponse).mockImplementation(async (_request, options) => { await options.beforeDispatch?.(); return new Promise(() => {}); });
    const work = f.run(); await vi.advanceTimersByTimeAsync(1); f.controller.abort(); await vi.advanceTimersByTimeAsync(5000);
    expect(await work).toBe(true); expect(f.transport.streamResponse).toHaveBeenCalledOnce();
    const finished = f.query.mock.calls.find(([sql]) => sql.includes("finish_standalone_names")) as unknown as [string, unknown[]]; expect(finished[1][2]).toBe("needs_reconciliation");
  });
});
