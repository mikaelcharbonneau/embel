import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { runNamingCreatorPool } from "../../src/server/ai/naming-brain/creator-pool";

describe("Naming three-slot Creator scheduling", () => {
  it("runs at most three assignments concurrently and retains stable assignment order", async () => {
    let active = 0, maximum = 0;
    const finish = new Map<string, () => void>();
    const tasks = Array.from({ length: 5 }, (_, index) => ({ assignmentKey: `assignment-${index}`, sessionLimitCents: 30, execute: async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => finish.set(`assignment-${index}`, resolve)); active--;
      return { status: "completed", index };
    } }));
    const pending = runNamingCreatorPool(tasks, { maximumTotalCents: 150, signal: new AbortController().signal, stopAfter: result => result.status !== "completed" });
    await vi.waitFor(() => expect(finish.size).toBe(3));
    finish.get("assignment-2")!();
    await vi.waitFor(() => expect(finish.size).toBe(4));
    finish.get("assignment-0")!();
    await vi.waitFor(() => expect(finish.size).toBe(5));
    finish.get("assignment-4")!(); finish.get("assignment-1")!(); finish.get("assignment-3")!();
    const result = await pending;
    expect(maximum).toBe(3);
    expect(result.results.map(row => row.value.index)).toEqual([0, 1, 2, 3, 4]);
    expect(result.notStarted).toEqual([]);
  });

  it("stops unstarted assignments on an unknown outcome and cooperatively cancels active siblings", async () => {
    let resolveUnknown!: (value: { status: string }) => void;
    const started: string[] = [];
    const tasks = Array.from({ length: 5 }, (_, index) => ({ assignmentKey: `assignment-${index}`, sessionLimitCents: 30, execute: (signal: AbortSignal) => {
      started.push(`assignment-${index}`);
      return new Promise<{ status: string }>(resolve => { if (index === 0) resolveUnknown = resolve; else signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true }); });
    } }));
    const pending = runNamingCreatorPool(tasks, { maximumTotalCents: 150, signal: new AbortController().signal, stopAfter: result => result.status === "unresolved" });
    await vi.waitFor(() => expect(started).toHaveLength(3));
    resolveUnknown({ status: "unresolved" });
    const result = await pending;
    expect(started).toEqual(["assignment-0", "assignment-1", "assignment-2"]);
    expect(result.notStarted).toEqual(["assignment-3", "assignment-4"]);
    expect(result.stopped).toBe(true);
  });

  it("refuses overallocated or repeated assignments before executing any task", async () => {
    let calls = 0;
    const task = { assignmentKey: "same-assignment", sessionLimitCents: 100, execute: async () => { calls++; return "done"; } };
    await expect(runNamingCreatorPool([task, task], { maximumTotalCents: 150, signal: new AbortController().signal, stopAfter: () => false })).rejects.toThrow("invalid_creator_plan");
    expect(calls).toBe(0);
  });

  it("does not reinterpret provisional estimates as reusable allowance", async () => {
    let calls = 0;
    const tasks = Array.from({ length: 4 }, (_, index) => ({ assignmentKey: `assignment-${index}`, sessionLimitCents: 50, execute: async () => { calls++; return { estimatedCostMicrousd: 0 }; } }));
    await expect(runNamingCreatorPool(tasks, { maximumTotalCents: 150, signal: new AbortController().signal, stopAfter: () => false })).rejects.toThrow("invalid_creator_plan");
    expect(calls).toBe(0);
  });

  it("does not admit tasks appended after the allocation was checked", async () => {
    const ran: string[] = [];
    const tasks = [{ assignmentKey: "first", sessionLimitCents: 50, execute: async () => {
      ran.push("first");
      tasks.push({ assignmentKey: "unplanned", sessionLimitCents: 100, execute: async () => { ran.push("unplanned"); return "done"; } });
      return "done";
    } }, { assignmentKey: "second", sessionLimitCents: 50, execute: async () => { ran.push("second"); return "done"; } }];
    await runNamingCreatorPool(tasks, { maximumTotalCents: 100, signal: new AbortController().signal, stopAfter: () => false });
    expect(ran).toEqual(["first", "second"]);
  });
});
