// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, Fragment, useLayoutEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsWorkspace } from "@/components/workspace/settings-workspace";
import * as accountApi from "@/components/workspace/account-api";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { RecordedUsage } from "@/domain/recorded-usage";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mock = vi.hoisted(() => ({
  session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as VerifiedAccount | { status: "checking" | "signed_out" | "unavailable" | "error"; generation: number },
  current: vi.fn(), expire: vi.fn(), ai: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire }),
  AccountStatus: () => null,
}));
vi.mock("@/components/workspace/account-profile-editor", () => ({ AccountProfileEditor: () => null }));
vi.mock("@/components/workspace/account-access", () => ({ AccountAccess: () => null }));
vi.mock("@/components/workspace/strategy-runtime-settings", () => ({ StrategyRuntimeSettings: () => { mock.ai(); return null; } }));
vi.mock("@/components/workspace/local-chatgpt-settings", () => ({ LocalChatGPTSettings: () => null }));
vi.mock("@/components/workspace/browser-local-date", () => ({ BrowserLocalDate: ({ dateTime }: { dateTime: string }) => createElement("time", { dateTime }, dateTime) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => createElement("a", props, children) }));

type Request = { resolve(response: Response): void; reject(error: unknown): void; signal: AbortSignal };
let root: Root, host: HTMLDivElement, requests: Request[], fetcher: ReturnType<typeof vi.fn>;
let committedRowCounts: number[];
let commitAction: (() => void) | null;
function snapshot(count = 20, ownerId = owner): RecordedUsage {
  return { ownerId, limit: 20, entries: Array.from({ length: count }, (_, index) => ({
    id: `cccccccc-cccc-4ccc-8ccc-${String(index + 1).padStart(12, "0")}`,
    operation: "naming.generate", completedAt: "2026-10-19T12:00:00Z",
    tokens: { inputTokens: index, outputTokens: 2, totalTokens: index + 2 },
  })) };
}
function CommitProbe() {
  useLayoutEffect(() => {
    committedRowCounts.push(host.querySelectorAll(".recorded-usage-entry").length);
    const action = commitAction; commitAction = null; action?.();
  });
  return null;
}
const tree = () => createElement(Fragment, null, createElement(SettingsWorkspace), createElement(CommitProbe));
const render = () => act(async () => root.render(tree()));
const tab = (id: string) => host.querySelector<HTMLButtonElement>(`#settings-tab-${id}`)!;
const select = (id: string) => act(async () => tab(id).click());
const settle = (index: number, body = snapshot(), status = 200) => act(async () => requests[index]!.resolve(Response.json(body, { status })));
const refresh = () => host.querySelector<HTMLButtonElement>(".recorded-usage-refresh")!;
const rows = () => [...host.querySelectorAll(".recorded-usage-entry")];
function expectSameRows(original: Element[]) {
  expect(rows()).toHaveLength(original.length);
  rows().forEach((row, index) => expect(row).toBe(original[index]));
}
async function loaded() { await render(); await select("billing"); await settle(0); }
function replaceClient() {
  mock.current = vi.fn((account: VerifiedAccount) => mock.session.status === "ready" && mock.session.userId === account.userId && mock.session.generation === account.generation);
  mock.expire = vi.fn(() => { mock.session = { status: "signed_out", generation: 2 }; root.render(tree()); });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.session = { status: "ready", userId: owner, generation: 1 };
  replaceClient(); mock.ai.mockReset();
  requests = []; committedRowCounts = []; commitAction = null;
  fetcher = vi.fn((_path: string, init: RequestInit) => new Promise<Response>((resolve, reject) => requests.push({ resolve, reject, signal: init.signal as AbortSignal })));
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  for (const [path, init] of fetcher.mock.calls) {
    expect(path).toBe("/api/usage"); expect(init.method).toBe("GET"); expect(init.body).toBeUndefined();
  }
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("Settings Usage tab lifetime", () => {
  it("does not mount Usage or AI reads before their categories are visited", async () => {
    await render(); await select("workspace"); await select("integrations");
    expect(fetcher).not.toHaveBeenCalled(); expect(mock.ai).not.toHaveBeenCalled();
    expect(host.querySelector(".recorded-usage")).toBeNull();
    await select("billing"); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mock.ai).not.toHaveBeenCalled();
  });

  it("preserves all row and button nodes on return while honestly revalidating once", async () => {
    await loaded(); const original = rows(), button = refresh();
    await select("workspace"); expectSameRows(original);
    expect(button.disabled).toBe(true);
    await select("billing");
    expectSameRows(original); expect(refresh()).toBe(button);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Checking recorded usage… Previous recorded usage is still shown.");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await select("billing"); await act(async () => button.click());
    expect(fetcher).toHaveBeenCalledTimes(2);
    const updated = snapshot(); updated.entries[0]!.tokens = null;
    await settle(1, updated); expectSameRows(original);
    expect(original[0]!.textContent).toContain("Total tokensUnknown");
    expect(host.textContent).toContain("Recorded usage loaded.");
  });

  it("revalidates once on every actual return but performs no hidden reads or captured-button actions", async () => {
    vi.useFakeTimers(); await loaded(); const original = rows(), button = refresh();
    for (let index = 1; index <= 3; index++) {
      await select("workspace");
      await act(async () => { button.click(); await vi.advanceTimersByTimeAsync(30_000); });
      expect(fetcher).toHaveBeenCalledTimes(index); expectSameRows(original);
      await select("billing"); expect(fetcher).toHaveBeenCalledTimes(index + 1);
      await settle(index); expectSameRows(original);
    }
  });

  it("aborts the initial read on leave and rejects its late success after return", async () => {
    await render(); await select("billing"); await select("workspace");
    expect(requests[0]!.signal.aborted).toBe(true);
    await select("billing"); expect(fetcher).toHaveBeenCalledTimes(2);
    await settle(0); expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("Loading recorded usage…");
    await settle(1, snapshot(1)); expect(rows()).toHaveLength(1);
  });

  it.each(["success", "network", "503", "401", "wrong-owner"] as const)("ignores a disposed refresh's late %s and finally without unlocking the replacement read", async outcome => {
    await loaded(); const original = rows();
    await act(async () => refresh().click());
    await select("workspace"); expect(requests[1]!.signal.aborted).toBe(true);
    await select("billing"); expect(fetcher).toHaveBeenCalledTimes(3);
    if (outcome === "network") await act(async () => requests[1]!.reject(new Error("OLD_PRIVATE_ERROR")));
    else await settle(1, snapshot(1, outcome === "wrong-owner" ? other : owner), outcome === "401" ? 401 : outcome === "503" ? 503 : 200);
    expectSameRows(original); expect(mock.expire).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Recorded usage could not"); expect(host.textContent).not.toContain("OLD_PRIVATE_ERROR");
    expect(refresh().getAttribute("aria-disabled")).toBe("true");
    await act(async () => refresh().click()); expect(fetcher).toHaveBeenCalledTimes(3);
    await settle(2); expectSameRows(original);
    expect(refresh().getAttribute("aria-disabled")).toBe("false");
  });

  it.each(["inactive", "provider"].flatMap(change => (["401", "wrong-owner"] as const).map(outcome => ({ change, outcome }))))("fences a $outcome completion during the $change commit before passive cleanup", async ({ change, outcome }) => {
    await loaded();
    // A deliberately synchronous thenable delivers the completion from a sibling
    // layout effect. This isolates the commit-to-passive-cleanup interval that
    // ordinary act-flushed Promise fixtures would otherwise skip.
    let complete!: (reply: RecordedUsage) => void, fail!: (error: unknown) => void, finish!: () => void;
    const chain = {
      then(callback: typeof complete) { complete = callback; return chain; },
      catch(callback: typeof fail) { fail = callback; return chain; },
      finally(callback: typeof finish) { finish = callback; return chain; },
    };
    const transport = vi.spyOn(accountApi, "accountRequest").mockReturnValueOnce(chain as unknown as ReturnType<typeof accountApi.accountRequest>);
    await act(async () => refresh().click());
    const signal = transport.mock.calls[0]![2].signal;
    const previousExpire = mock.expire;
    const delivered = vi.fn();
    commitAction = () => {
      delivered();
      expect(signal.aborted).toBe(false);
      if (outcome === "401") fail(new accountApi.AccountRequestError(401));
      else complete(snapshot(1, other));
      finish();
    };
    if (change === "inactive") await act(async () => { tab("workspace").click(); root.render(tree()); });
    else { replaceClient(); await render(); }
    expect(delivered).toHaveBeenCalledOnce(); expect(commitAction).toBeNull();
    expect(previousExpire).not.toHaveBeenCalled(); expect(mock.expire).not.toHaveBeenCalled();
    if (change === "inactive") await select("billing");
    expect(refresh().getAttribute("aria-disabled")).toBe("true");
    await settle(1, snapshot(1)); expect(rows()).toHaveLength(1);
  });

  it("clears the abandoned read timeout while inactive", async () => {
    vi.useFakeTimers(); await loaded();
    await act(async () => refresh().click()); expect(vi.getTimerCount()).toBe(1);
    await select("workspace"); expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await select("billing"); expect(vi.getTimerCount()).toBe(1);
    await settle(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["checking", "signed_out", "unavailable", "error"] as const)("removes private rows even from the inactive DOM when the account becomes %s", async status => {
    await loaded(); await select("workspace");
    const previousCommits = committedRowCounts.length;
    mock.session = { status, generation: 2 }; await render();
    expect(rows()).toHaveLength(0); expect(refresh()).toBeNull();
    expect(committedRowCounts.slice(previousCommits).every(count => count === 0)).toBe(true);
    expect(host.textContent).not.toContain("2026-10-19");
    await select("billing"); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".recorded-usage-pending-frame") !== null).toBe(status === "checking");
    expect(host.textContent).toContain(status === "checking" ? "Checking your account…" : status === "signed_out" ? "Sign in to view recorded usage." : "Verify your account to view recorded usage.");
  });

  it.each([owner, other])("does not reuse a previous generation's hidden snapshot for %s", async nextOwner => {
    await loaded(); await select("workspace");
    mock.session = { status: "ready", userId: nextOwner, generation: 2 }; await render();
    expect(rows()).toHaveLength(0); expect(fetcher).toHaveBeenCalledTimes(1);
    await select("billing"); expect(rows()).toHaveLength(0);
    await settle(1, snapshot(1, nextOwner)); expect(rows()).toHaveLength(1);
  });

  it.each([true, false].flatMap(active => (["both callbacks", "isCurrent", "expire", "account object"] as const).map(changed => ({ active, changed }))))("discards the same-owner/generation snapshot before the first commit after $changed replacement (active=$active)", async ({ active, changed }) => {
    await loaded(); await act(async () => refresh().click());
    if (!active) await select("workspace");
    const previousCommits = committedRowCounts.length;
    if (changed === "both callbacks") replaceClient();
    else if (changed === "isCurrent") mock.current = vi.fn(mock.current.getMockImplementation()!);
    else if (changed === "expire") mock.expire = vi.fn(mock.expire.getMockImplementation()!);
    else mock.session = { ...mock.session };
    await render();
    expect(rows()).toHaveLength(0); expect(requests[1]!.signal.aborted).toBe(true);
    expect(committedRowCounts.slice(previousCommits).every(count => count === 0)).toBe(true);
    await settle(1); expect(rows()).toHaveLength(0);
    if (!active) { expect(fetcher).toHaveBeenCalledTimes(2); await select("billing"); }
    await settle(2, snapshot(1)); expect(rows()).toHaveLength(1);
  });

  it.each(["401", "wrong-owner"] as const)("still expires a current return read on %s", async outcome => {
    await loaded(); await select("workspace"); await select("billing");
    await settle(1, snapshot(1, outcome === "wrong-owner" ? other : owner), outcome === "401" ? 401 : 200);
    expect(mock.expire).toHaveBeenCalledOnce(); expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("Sign in to view recorded usage.");
  });

  it("retains labelled previous rows after return failure and permits one explicit retry", async () => {
    await loaded(); const original = rows();
    await select("workspace"); await select("billing"); await settle(1, snapshot(), 503);
    expectSameRows(original); expect(host.textContent).toContain("could not be refreshed. Previous recorded usage is still shown.");
    await act(async () => { refresh().click(); refresh().click(); });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await settle(2, snapshot(0));
    expect(rows()).toHaveLength(0); expect(host.textContent).toContain("No completed Strategy or Naming requests");
  });

  it("keeps unique tab targets and only one exposed, non-inert panel during keyboard navigation", async () => {
    await loaded(); await select("workspace");
    const hidden = host.querySelector<HTMLElement>("#settings-panel-billing")!;
    expect(hidden.hidden).toBe(true); expect(hidden.hasAttribute("inert")).toBe(true);
    expect(hidden.getAttribute("aria-hidden")).toBe("true"); expect(hidden.tabIndex).toBe(-1);
    expect(host.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
    expect(readFileSync("src/styles/settings-guided.css", "utf8")).toMatch(/\.settings-guided \.sg-content\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
    await act(async () => tab("workspace").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(tab("ai"));
    await act(async () => tab("ai").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(tab("billing")); expect(hidden.hidden).toBe(false);
    expect(hidden.hasAttribute("inert")).toBe(false);
    for (const button of host.querySelectorAll('[role="tab"]')) {
      expect(host.querySelectorAll(`[id="${button.getAttribute("aria-controls")}"]`)).toHaveLength(1);
    }
    expect(host.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
    await settle(1);
  });
});
