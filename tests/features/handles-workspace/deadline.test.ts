import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  checkHandleEntry,
  handleCheckDeadlineMs,
  HandleCheckTimeoutError,
} from "@/features/handles-workspace/adapters";
import { appendEvidence, createEntry } from "@/features/handles-workspace/domain";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it("bounds a hung adapter, aborts it and ignores a late response", async () => {
  let signal: AbortSignal | undefined, settle: ((value: unknown) => void) | undefined;
  const entry = createEntry("instagram", "morrow");
  const result = checkHandleEntry(entry, {
    availability: "ready",
    label: "Fixture",
    check: (_entry, abort) => {
      signal = abort;
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  });
  const assertion = expect(result).rejects.toBeInstanceOf(HandleCheckTimeoutError);
  await vi.advanceTimersByTimeAsync(handleCheckDeadlineMs);
  await assertion;
  expect(signal?.aborted).toBe(true);
  const error = await result.then(
    () => {
      throw new Error("Expected timeout");
    },
    (cause) => {
      if (!(cause instanceof HandleCheckTimeoutError)) throw cause;
      return cause;
    },
  );
  expect(error.entry.evidence).toEqual([
    expect.objectContaining({ outcome: "failed", checkedAt: null, method: "Adapter request timed out" }),
  ]);
  settle?.({ outcome: "confirmed_available" });
  await vi.runAllTimersAsync();
  expect(error.entry.evidence).toHaveLength(1);
  expect(entry.evidence).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it("cancellation settles even if an adapter ignores abort and never resolves", async () => {
  const controller = new AbortController();
  const entry = createEntry("instagram", "morrow");
  const pending = checkHandleEntry(
    entry,
    { availability: "ready", label: "Fixture", check: () => new Promise(() => {}) },
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();
  expect(await pending).toBe(entry);
  expect(vi.getTimerCount()).toBe(0);
});
it("clears the deadline when a response completes", async () => {
  await checkHandleEntry(createEntry("instagram", "morrow"), {
    availability: "ready",
    label: "Fixture",
    check: async () => ({}),
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not dispatch if cancelled before the queued adapter call", async () => {
  const controller = new AbortController(),
    check = vi.fn(() => new Promise(() => {}));
  const entry = createEntry("instagram", "morrow");
  const pending = checkHandleEntry(entry, { availability: "ready", label: "Fixture", check }, controller.signal);
  controller.abort();
  expect(await pending).toBe(entry);
  expect(check).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("settles the deadline even if wall-clock rollback invalidates retained evidence", async () => {
  vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  const entry = appendEvidence(createEntry("instagram", "morrow"), {
    platform: "instagram",
    handle: "morrow",
    outcome: "confirmed_available",
    authority: "platform_api",
    source: "Synthetic fixture",
    sourceUrl: null,
    method: "Fixture",
    checkedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    detail: "",
  });
  const pending = checkHandleEntry(entry, {
    availability: "ready",
    label: "Fixture",
    check: () => new Promise(() => {}),
  });
  const assertion = expect(pending).rejects.toThrow("took too long");
  vi.setSystemTime(new Date("2026-10-05T11:59:00Z"));
  await vi.advanceTimersByTimeAsync(handleCheckDeadlineMs);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
  expect(entry.evidence).toHaveLength(1);
});
