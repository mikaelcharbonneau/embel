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

  it.each(["outcome", "exception"] as const)("drains already-started local work after a sibling %s without starting more assignments", async failure => {
    const started: number[] = [], signals: AbortSignal[] = [], finish = new Map<number, (value: { status: string; index: number }) => void>();
    let fail!: () => void, settled = false;
    const tasks = Array.from({ length: 5 }, (_, index) => ({ assignmentKey: `assignment-${index}`, sessionLimitCents: 30, execute: (signal: AbortSignal) => {
      started.push(index); signals.push(signal);
      return new Promise<{ status: string; index: number }>((resolve, reject) => {
        finish.set(index, resolve);
        if (index === 0) fail = () => failure === "exception" ? reject(new Error("Synthetic Creator failure")) : resolve({ status: "unresolved", index });
      });
    } }));
    const pending = runNamingCreatorPool(tasks, { maximumTotalCents: 150, localUnlimited: true, signal: new AbortController().signal, stopAfter: result => result.status !== "completed" }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    fail();
    await Promise.resolve(); await Promise.resolve();
    expect(signals.every(signal => !signal.aborted)).toBe(true); expect(settled).toBe(false);
    finish.get(2)!({ status: "completed", index: 2 }); finish.get(1)!({ status: "completed", index: 1 });
    const result = await pending;
    expect(started).toEqual([0, 1, 2]);
    expect(result.results.filter(row => row.value.status === "completed").map(row => row.value.index)).toEqual([1, 2]);
    expect(result.failures).toHaveLength(failure === "exception" ? 1 : 0);
    expect(result.notStarted).toEqual(["assignment-3", "assignment-4"]); expect(result.stopped).toBe(true);
  });

  it("still aborts draining local siblings immediately on explicit parent cancellation", async () => {
    const parent = new AbortController(), started: number[] = [], signals: AbortSignal[] = [];
    let fail!: () => void;
    const tasks = Array.from({ length: 5 }, (_, index) => ({ assignmentKey: `assignment-${index}`, sessionLimitCents: 30, execute: (signal: AbortSignal) => {
      started.push(index); signals.push(signal);
      return new Promise<{ status: string }>(resolve => {
        if (index === 0) fail = () => resolve({ status: "unresolved" });
        else signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      });
    } }));
    const pending = runNamingCreatorPool(tasks, { maximumTotalCents: 150, localUnlimited: true, signal: parent.signal, stopAfter: result => result.status !== "completed" });
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    fail(); await Promise.resolve(); await Promise.resolve();
    expect(signals.every(signal => !signal.aborted)).toBe(true);
    parent.abort();
    const result = await pending;
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(result.results.map(row => row.value.status)).toEqual(["unresolved", "cancelled", "cancelled"]);
    expect(result.notStarted).toEqual(["assignment-3", "assignment-4"]);
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

  it("executes explicitly unlimited local plans while retaining cancellation and duplicate safeguards", async () => {
    let calls = 0;
    const tasks = Array.from({ length: 4 }, (_, index) => ({ assignmentKey: `assignment-${index}`, sessionLimitCents: 500, execute: async () => { calls++; return "done"; } }));
    const options = { maximumTotalCents: 150, localUnlimited: true, signal: new AbortController().signal, stopAfter: () => false };
    expect((await runNamingCreatorPool(tasks, options)).results).toHaveLength(4); expect(calls).toBe(4);
    await expect(runNamingCreatorPool([tasks[0]!, tasks[0]!], options)).rejects.toThrow("invalid_creator_plan");
    const controller = new AbortController(); controller.abort();
    expect((await runNamingCreatorPool(tasks, { ...options, signal: controller.signal })).notStarted).toHaveLength(4);
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
