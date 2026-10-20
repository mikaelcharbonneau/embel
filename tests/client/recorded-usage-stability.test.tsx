// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordedUsageSection } from "@/components/workspace/recorded-usage";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { RecordedUsage } from "@/domain/recorded-usage";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mock = vi.hoisted(() => ({
  session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as VerifiedAccount | { status: "checking" | "signed_out"; generation: number },
  current: vi.fn(), expire: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire }) }));
vi.mock("@/components/workspace/browser-local-date", () => ({ BrowserLocalDate: ({ dateTime }: { dateTime: string }) => createElement("time", { dateTime }, dateTime) }));
type Request = { resolve(response: Response): void; reject(error: unknown): void; signal: AbortSignal };
let root: Root, host: HTMLDivElement, requests: Request[], fetcher: ReturnType<typeof vi.fn>;
function snapshot(count = 20, ownerId = owner): RecordedUsage {
  return { ownerId, limit: 20, entries: Array.from({ length: count }, (_, index) => ({
    id: `cccccccc-cccc-4ccc-8ccc-${String(index + 1).padStart(12, "0")}`,
    operation: "naming.generate", completedAt: "2026-10-19T12:00:00Z",
    tokens: { inputTokens: index, outputTokens: 2, totalTokens: index + 2 },
  })) };
}
const render = () => act(async () => root.render(createElement(RecordedUsageSection)));
const settle = (index: number, body = snapshot(), status = 200) => act(async () => requests[index]!.resolve(Response.json(body, { status })));
const refresh = () => host.querySelector<HTMLButtonElement>(".recorded-usage-refresh")!;
const rows = () => [...host.querySelectorAll(".recorded-usage-entry")];
function expectSameRows(original: Element[]) {
  const current = rows(); expect(current).toHaveLength(original.length);
  current.forEach((row, index) => expect(row).toBe(original[index]));
}
async function loaded() { await render(); await settle(0); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mock.session = { status: "ready", userId: owner, generation: 1 };
  mock.current.mockReset().mockImplementation((account: VerifiedAccount) => mock.session.status === "ready" && mock.session.userId === account.userId && mock.session.generation === account.generation);
  mock.expire.mockReset().mockImplementation(() => { mock.session = { status: "signed_out", generation: 2 }; root.render(createElement(RecordedUsageSection)); });
  requests = []; fetcher = vi.fn((_path: string, init: RequestInit) => new Promise<Response>((resolve, reject) => requests.push({ resolve, reject, signal: init.signal as AbortSignal })));
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Recorded usage refresh continuity", () => {
  it("retains all rows, the refresh trigger and focus through a deduplicated refresh", async () => {
    await loaded(); const original = rows(), button = refresh(); button.focus();
    await act(async () => { button.click(); button.click(); });
    await act(async () => button.click());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expectSameRows(original); expect(rows()).toHaveLength(20);
    expect(refresh()).toBe(button); expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(host.textContent).toContain("Checking recorded usage");
    await settle(1);
    expectSameRows(original); expect(refresh()).toBe(button);
    expect(document.activeElement).toBe(button); expect(button.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("keeps prior rows and the same retry trigger after failure, then updates verified tokens", async () => {
    await loaded(); const original = rows(), button = refresh(); button.focus();
    await act(async () => button.click()); await settle(1, snapshot(), 503);
    expectSameRows(original); expect(refresh()).toBe(button);
    expect(host.textContent).toContain("Previous recorded usage is still shown");
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    const updated = snapshot(); updated.entries[0]!.tokens = { inputTokens: 5, outputTokens: 6, totalTokens: 11 };
    await settle(2, updated);
    expectSameRows(original); expect(original[0]!.textContent).toContain("Total tokens11");
    expect(host.textContent).not.toContain("could not be refreshed");
  });

  it("keeps an initial read failure retryable without inventing history", async () => {
    await render(); await settle(0, snapshot(), 503);
    expect(rows()).toHaveLength(0); expect(host.textContent).toContain("Recorded usage could not be loaded");
    const button = host.querySelector<HTMLButtonElement>("button")!;
    await act(async () => button.click()); await settle(1, snapshot(0));
    expect(rows()).toHaveLength(0); expect(host.textContent).toContain("No completed Strategy or Naming requests");
    expect(host.textContent).not.toContain("could not be loaded");
  });

  it("retains the verified history on a timed-out refresh and permits an explicit retry", async () => {
    vi.useFakeTimers(); await loaded(); const original = rows(), button = refresh();
    await act(async () => button.click());
    requests[1]!.signal.addEventListener("abort", () => requests[1]!.reject(new DOMException("Aborted", "AbortError")), { once: true });
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(requests[1]!.signal.aborted).toBe(true); expectSameRows(original);
    expect(refresh()).toBe(button); expect(button.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => button.click()); await settle(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([owner, other])("removes old history at a new generation and fences its late refresh (%s)", async nextOwner => {
    await loaded(); await act(async () => refresh().click());
    mock.session = { status: "ready", userId: nextOwner, generation: 2 }; await render();
    expect(rows()).toHaveLength(0); expect(requests[1]!.signal.aborted).toBe(true);
    await settle(1); expect(rows()).toHaveLength(0);
    await settle(2, snapshot(1, nextOwner)); expect(rows()).toHaveLength(1);
  });

  it("immediately hides private history during account checking and ignores a late reply", async () => {
    await loaded(); await act(async () => refresh().click());
    mock.session = { status: "checking", generation: 2 }; await render();
    expect(rows()).toHaveLength(0); expect(refresh()).toBeNull();
    await settle(1); expect(rows()).toHaveLength(0); expect(host.textContent).toContain("Checking your account");
  });

  it.each(["unauthorized", "wrong-owner"])("expires rather than retaining readable history on %s", async failure => {
    await loaded(); await act(async () => refresh().click());
    await settle(1, snapshot(1, failure === "wrong-owner" ? other : owner), failure === "unauthorized" ? 401 : 200);
    expect(mock.expire).toHaveBeenCalledOnce(); expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("Sign in to view recorded usage");
  });
});
