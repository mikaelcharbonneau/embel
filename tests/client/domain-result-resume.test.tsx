// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DomainResultTools, type DomainReadOutcome } from "@/features/domain-workspace/result-tools";
import { type DomainSearchAdapter } from "@/features/domain-workspace/model";
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T18:00:00Z")); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === name)!;
const rows = Array.from({ length: 33 }, (_, index) => ({ domain: `fixture${index + 1}.com`, check: null, quote: null }));
const adapter: DomainSearchAdapter = { status: "ready", provider: "Synthetic quota fixture", quotesWithCheck: true, check: async () => null };
it("resumes all remaining candidates after the 30-per-minute gate without rechecking the first thirty", async () => {
  let windowStart = Date.now(), count = 0;
  const check = vi.fn<(_row: typeof rows[number], _signal: AbortSignal) => Promise<DomainReadOutcome>>(async () => {
    if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); count = 0; }
    if (count >= 30) return { status: "rate_limited", retryAfterSeconds: 60 };
    count++; return "completed";
  });
  await act(async () => root.render(<DomainResultTools rows={rows} visibleRows={rows} adapter={adapter} check={check}>{() => <span>Synthetic domains</span>}</DomainResultTools>));
  await act(async () => button("Check availability & prices").click());
  expect(check).toHaveBeenCalledTimes(31);
  expect(host.textContent).toContain("30 of 33 checks completed");
  expect(host.textContent).toContain("Wait 60 seconds");
  expect(button("Continue remaining checks (3)").disabled).toBe(true);
  await act(async () => button("Continue remaining checks (3)").click());
  expect(check).toHaveBeenCalledTimes(31);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(button("Continue remaining checks (3)").disabled).toBe(false);
  await act(async () => button("Continue remaining checks (3)").click());
  expect(check).toHaveBeenCalledTimes(34);
  expect(check.mock.calls.map(call => call[0].domain)).toEqual([...rows.slice(0, 31), ...rows.slice(30)].map(row => row.domain));
  expect(host.textContent).toContain("3 of 3 checks completed");
  expect(host.textContent).not.toContain("Continue remaining checks");
});
it("retains the failed candidate and tail for explicit continuation after a transport failure", async () => {
  const check = vi.fn<(_row: typeof rows[number], _signal: AbortSignal) => Promise<DomainReadOutcome>>().mockResolvedValueOnce("completed").mockResolvedValueOnce("failed").mockResolvedValue("completed");
  await act(async () => root.render(<DomainResultTools rows={rows.slice(0, 3)} visibleRows={rows.slice(0, 3)} adapter={adapter} check={check}>{() => null}</DomainResultTools>));
  await act(async () => button("Check availability & prices").click());
  expect(check).toHaveBeenCalledTimes(2); expect(button("Continue remaining checks (2)")).toBeDefined();
  await act(async () => button("Continue remaining checks (2)").click());
  expect(check.mock.calls.map(call => call[0].domain)).toEqual(["fixture1.com", "fixture2.com", "fixture2.com", "fixture3.com"]);
});
