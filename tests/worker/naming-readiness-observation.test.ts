import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { startNamingReadiness } from "../../worker/naming-brain-configuration";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { runOneJob } from "../../worker/runner";
import { createInertNamingHarness } from "./naming-brain-handler-fixture";

describe("Naming readiness and retained issued work", () => {
  it.each(["unready", "rejected", "stopped"] as const)("observes unresolved issued calls without replacement when readiness is %s", async state => {
    const test = createInertNamingHarness({ lostCreator: true });
    const report = vi.fn(async () => true), gate = await startNamingReadiness(report);
    const handlers = createNamingBrainHandlers({ store: test.store, assertReady: () => gate.assertReady(), runtime: () => test.runtime });
    try {
      expect(await runOneJob({ store: test.store, handlers, workerId: "synthetic" })).toBe("needs_reconciliation");
      const dispatched = [...test.dispatched], retained = structuredClone(test.stages.get("creation")!.receipts);
      expect(retained.length).toBeGreaterThan(0);
      test.reclaim(); test.setReady(false);
      if (state === "stopped") await gate.stop();
      else {
        if (state === "rejected") report.mockRejectedValue(new Error("synthetic-private-readiness-query-error"));
        else report.mockResolvedValue(false);
        await expect(gate.assertReady()).rejects.toThrow("naming_readiness_unavailable");
      }
      const reports = report.mock.calls.length;
      expect(await runOneJob({ store: test.store, handlers, workerId: "synthetic" })).toBe("needs_reconciliation");
      expect(test.observed.length).toBeGreaterThan(0);
      expect(test.dispatched).toEqual(dispatched);
      expect(test.stages.get("creation")!.receipts).toEqual(retained);
      expect(test.stages.get("creation")!.state).toBe("ambiguous");
      expect(test.prepared()).toBeNull();
      expect(report).toHaveBeenCalledTimes(reports);
      expect(test.log.some(row => row.action === "resume_execution")).toBe(false);
    } finally { await gate.stop(); }
  });

  it.each(["unready", "rejected"] as const)("never dispatches a new provider request when the actual gate is %s", async state => {
    const test = createInertNamingHarness();
    const report = state === "unready" ? async () => false : async () => { throw new Error("synthetic-private-query-error"); };
    const gate = await startNamingReadiness(report);
    const handlers = createNamingBrainHandlers({ store: test.store, assertReady: () => gate.assertReady(), runtime: () => test.runtime });
    try {
      expect(await runOneJob({ store: test.store, handlers, workerId: "synthetic" })).toBe("failed");
      expect(test.dispatched).toEqual([]);
      expect([...test.stages.values()].flatMap(stage => stage.requests)).toEqual([]);
      expect(test.prepared()).toBeNull();
    } finally { await gate.stop(); }
  });
});
