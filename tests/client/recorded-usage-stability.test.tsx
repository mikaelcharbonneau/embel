// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordedUsageSection } from "@/components/workspace/recorded-usage";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { RECORDED_USAGE_LIMIT, type RecordedUsage } from "@/domain/recorded-usage";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mock = vi.hoisted(() => ({
  session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as VerifiedAccount | { status: "checking" | "signed_out" | "unavailable" | "error"; generation: number },
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
const publicRefreshStatus = "Checking recorded usage… Previous recorded usage is still shown.";
const publicNote = "Unknown means a token count was not recorded or could not be verified.";
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
  it.each([0, 1, 20])("uses the same anonymous public-limit geometry after %i private rows and through the following initial read", async priorCount => {
    await render(); await settle(0, snapshot(priorCount)); await act(async () => refresh().click());
    mock.session = { status: "checking", generation: 2 }; await render();
    const frame = host.querySelector(".recorded-usage-pending-frame")!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(frame.children).toHaveLength(RECORDED_USAGE_LIMIT);
    expect(frame.textContent).toBe("");
    expect(frame.getAttribute("style")).toBeNull();
    expect([...frame.children].every(slot => slot.className === "recorded-usage-pending-slot" && slot.attributes.length === 1)).toBe(true);
    expect(frame.querySelector("article, time, dl, button, a, input, [tabindex]")).toBeNull();
    const footer = host.querySelector(".recorded-usage-footer")!;
    expect(footer).not.toBeNull();
    expect(footer.textContent).toBe(publicNote);
    const action = footer.querySelector(".recorded-usage-action")!;
    expect(action.hasAttribute("inert")).toBe(true);
    expect(action.getAttribute("aria-hidden")).toBe("true");
    expect(action.children).toHaveLength(0);
    expect(footer.querySelector("article, time, dl, button, a, input, [tabindex], [style]")).toBeNull();
    expect(host.querySelector(".recorded-usage-status-sizer")?.textContent).toBe(publicRefreshStatus);
    expect(rows()).toHaveLength(0); expect(refresh()).toBeNull();
    expect(host.textContent).toContain("Checking your account…");
    expect(host.textContent).not.toContain("2026-10-19");
    await settle(1); expect(rows()).toHaveLength(0);
    mock.session = { status: "ready", userId: owner, generation: 2 }; await render();
    expect(host.querySelector(".recorded-usage-pending-frame")?.children).toHaveLength(RECORDED_USAGE_LIMIT);
    expect(host.textContent).toContain("Loading recorded usage…");
    expect(host.querySelector(".recorded-usage-footer")?.querySelector("p")?.textContent).toBe(publicNote);
    expect(refresh().getAttribute("aria-disabled")).toBe("true");
    await settle(2, snapshot(0));
    expect(host.querySelector(".recorded-usage-pending-frame")).toBeNull();
    expect(host.querySelector(".recorded-usage-footer")).not.toBeNull();
    expect(host.textContent).toContain("No completed Strategy or Naming requests");
  });

  it.each(["signed_out", "unavailable", "error"] as const)("does not disguise %s as an indefinite usage loader", async status => {
    await loaded(); mock.session = { status, generation: 2 }; await render();
    expect(rows()).toHaveLength(0); expect(refresh()).toBeNull();
    expect(host.querySelector(".recorded-usage-pending-frame")).toBeNull();
    expect(host.querySelector(".recorded-usage-footer")).toBeNull();
    expect(host.querySelector(".recorded-usage-status-sizer")).toBeNull();
    expect(host.textContent).toContain(status === "signed_out" ? "Sign in to view recorded usage." : "Verify your account to view recorded usage.");
  });

  it("removes the anonymous initial-read frame on failure without inventing an empty account", async () => {
    await render(); expect(host.querySelector(".recorded-usage-pending-frame")).not.toBeNull();
    await settle(0, snapshot(), 503);
    expect(host.querySelector(".recorded-usage-pending-frame")).toBeNull();
    expect(host.textContent).toContain("Recorded usage could not be loaded");
    expect(host.textContent).not.toContain("No completed Strategy");
  });

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

  it("reserves the same public status and footer structure while ordinary refresh keeps the actual button and focus", async () => {
    await loaded();
    const status = host.querySelector(".recorded-usage-status")!;
    expect(status).not.toBeNull();
    const sizer = status.querySelector(".recorded-usage-status-sizer")!;
    const notice = status.querySelector('[role="status"]')!;
    const footer = host.querySelector(".recorded-usage-footer")!;
    const note = footer.querySelector(".recorded-usage-note")!;
    const action = footer.querySelector(".recorded-usage-action")!;
    const button = refresh(); button.focus();
    expect(sizer.textContent).toBe(publicRefreshStatus);
    expect(sizer.getAttribute("aria-hidden")).toBe("true");
    expect(sizer.hasAttribute("inert")).toBe(true);
    expect(sizer.querySelector("button, a, input, [tabindex]")).toBeNull();
    expect(notice.textContent).toBe("Recorded usage loaded.");
    expect(note.textContent).toBe(publicNote);
    expect(action.hasAttribute("inert")).toBe(false);
    expect(action.getAttribute("aria-hidden")).toBeNull();
    await act(async () => button.click());
    expect(host.querySelector(".recorded-usage-status")).toBe(status);
    expect(status.querySelector(".recorded-usage-status-sizer")).toBe(sizer);
    expect(notice.textContent).toBe(publicRefreshStatus);
    expect(host.querySelector(".recorded-usage-footer")).toBe(footer);
    expect(footer.querySelector(".recorded-usage-note")).toBe(note);
    expect(footer.querySelector(".recorded-usage-action")).toBe(action);
    expect(refresh()).toBe(button); expect(document.activeElement).toBe(button);
    await settle(1, snapshot(), 503);
    expect(status.querySelector('[role="alert"]')).toBe(notice);
    expect(notice.textContent).toBe("Recorded usage could not be refreshed. Previous recorded usage is still shown. Check your connection and try again.");
    expect(host.querySelector(".recorded-usage-footer")).toBe(footer);
    expect(refresh()).toBe(button); expect(document.activeElement).toBe(button);
  });

  it("shows complete long recorded labels, dates and token values without padding a sparse result to the public capacity", async () => {
    await render();
    const data = snapshot(1);
    data.entries[0]!.operation = "strategy.competitors";
    data.entries[0]!.completedAt = "2026-10-19T12:00:00+05:30";
    data.entries[0]!.tokens = { inputTokens: Number.MAX_SAFE_INTEGER - 1, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER };
    await settle(0, data);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.querySelector("h3")?.textContent).toBe("Strategy · Competitors");
    expect(rows()[0]!.querySelector("time")?.textContent).toBe(data.entries[0]!.completedAt);
    expect([...rows()[0]!.querySelectorAll("dd")].map(cell => cell.textContent)).toEqual(["9,007,199,254,740,990", "1", "9,007,199,254,740,991"]);
    expect(host.querySelector(".recorded-usage-pending-frame, .recorded-usage-pending-slot")).toBeNull();
    expect(host.querySelector(".recorded-usage-footer")?.querySelector("p")?.textContent).toBe(publicNote);
  });

  it("defines shared public row minima, explicit growing text metrics and reserved status/action slots in scoped CSS", () => {
    // Source contract only: jsdom does not establish browser pixel or scroll equality.
    const css = readFileSync("src/styles/recorded-usage.css", "utf8");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
    const declarations = (selector: string) => rules.filter(match => match[1]!.split(",").some(item => item.trim() === selector)).map(match => match[2]).join(" ");
    for (const selector of [".recorded-usage-entry", ".recorded-usage-pending-slot"]) {
      expect(declarations(selector)).toMatch(/min-block-size:\s*116px;/);
      expect(declarations(selector)).toMatch(/border-top:\s*1px solid var\(--border\);/);
    }
    expect(declarations(".recorded-usage-entry dl")).toMatch(/margin:\s*14px 0 0;/);
    for (const selector of [".recorded-usage-entry h3", ".recorded-usage-entry time", ".recorded-usage-entry dt", ".recorded-usage-entry dd"]) {
      expect(declarations(selector)).toMatch(/line-height:\s*20px;/);
    }
    expect(declarations(".recorded-usage-entry-heading")).toMatch(/flex-wrap:\s*wrap;/);
    expect(declarations(".recorded-usage-entry dd")).toMatch(/overflow-wrap:\s*anywhere;/);
    expect(declarations(".recorded-usage-status")).toMatch(/display:\s*grid;/);
    expect(declarations(".recorded-usage-status-sizer")).toMatch(/visibility:\s*hidden;/);
    expect(declarations(".recorded-usage-status > .recorded-usage-notice")).toMatch(/grid-area:\s*1\s*\/\s*1;/);
    expect(declarations(".recorded-usage-status-sizer")).toMatch(/grid-area:\s*1\s*\/\s*1;/);
    expect(declarations(".recorded-usage .recorded-usage-note")).toMatch(/line-height:\s*20px;/);
    expect(declarations(".recorded-usage-action")).toMatch(/min-block-size:\s*44px;/);
    expect(declarations(".recorded-usage-action")).toMatch(/display:\s*flex;/);
    expect(css).not.toMatch(/(?:^|[;{])\s*(?:height|block-size|max-height|max-block-size)\s*:|overflow:\s*(?:hidden|clip)|text-overflow:\s*ellipsis|line-clamp:/);
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
