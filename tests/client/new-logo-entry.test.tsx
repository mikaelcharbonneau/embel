// @vitest-environment jsdom
import { act, createElement, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectForm } from "@/components/workspace/project-editor";
import { clearLocalDrafts } from "@/components/workspace/local-drafts";
import { createHomeInputSession, emptyHomeInputIntent, type HomeInputSession } from "@/features/home-inputs/home-input-session";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mock = vi.hoisted(() => ({
  account: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as VerifiedAccount,
  memory: null as HomeInputSession | null, current: vi.fn(), expire: vi.fn(), navigate: vi.fn(),
  strategy: { pending: false, locked: false, checkingRecovery: false, recoveryBlocked: false, starting: false, notice: "Save your project when ready.", save: vi.fn(), start: vi.fn(), detachPrompt: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.navigate }) }));
vi.mock("next/link", () => ({ default: ({ prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => {
  void prefetch;
  const anchorProps: AnchorHTMLAttributes<HTMLAnchorElement> = { ...props, onClick: event => { props.onClick?.(event); if (!event.defaultPrevented) mock.navigate(props.href); event.preventDefault(); } };
  return createElement("a", anchorProps);
} }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.account, homeInputSession: mock.memory, isCurrent: mock.current, expire: mock.expire }) }));
vi.mock("@/components/workspace/account-strategy-start", () => ({ useAccountStrategyStart: () => mock.strategy }));
let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>;
const render = (home = false) => act(async () => root.render(createElement(NewProjectForm, { initialScope: "complete_brand", home })));
const logoLink = () => host.querySelector<HTMLAnchorElement>('a[href="/brands/logo/new"]');
const writes = () => fetcher.mock.calls.filter(([, init]) => init.method !== "GET");
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); HTMLElement.prototype.scrollTo = vi.fn();
  window.localStorage.clear(); window.sessionStorage.clear(); clearLocalDrafts();
  mock.account = { status: "ready", userId: owner, generation: 1 }; mock.memory = createHomeInputSession(); mock.memory.bind(mock.account);
  mock.current.mockReset().mockImplementation((account: VerifiedAccount) => account.userId === mock.account.userId && account.generation === mock.account.generation);
  mock.navigate.mockReset(); mock.expire.mockReset(); mock.strategy.pending = false; mock.strategy.locked = false;
  mock.strategy.save.mockReset(); mock.strategy.start.mockReset(); mock.strategy.detachPrompt.mockReset();
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith("/capability") && init.method === "GET") return Response.json({ ownerId: owner, policy: null, reason: "Synthetic unavailable storage" });
    throw new Error(`Unexpected fixture request ${path}`);
  }); vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("dedicated new-logo entry", () => {
  it("offers the existing logo route from an empty New project form without creating or transferring anything", async () => {
    await render(); const link = logoLink();
    expect(link?.textContent).toBe("Create a logo"); expect(link?.getAttribute("aria-disabled")).not.toBe("true");
    const before = window.sessionStorage.length;
    await act(async () => link!.click());
    expect(mock.navigate).toHaveBeenCalledExactlyOnceWith("/brands/logo/new");
    expect(writes()).toHaveLength(0); expect(mock.memory!.get(mock.account)).toBeNull();
    expect(window.sessionStorage.length).toBe(before); expect(mock.strategy.save).not.toHaveBeenCalled(); expect(mock.strategy.start).not.toHaveBeenCalled();
  });

  it("leaves Home and its disabled Logo scope contract unchanged", async () => {
    await render(true); expect(logoLink()).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    const logoOption = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent === "LogoIn Projects")!;
    expect(logoOption.disabled).toBe(true); expect(mock.navigate).not.toHaveBeenCalled();
  });

  it("does not discard typed work through the separate-logo link", async () => {
    await render();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "A skincare studio")!.click());
    const input = host.querySelector<HTMLTextAreaElement>("textarea")!, value = input.value;
    expect(value).not.toBe(""); expect(logoLink()?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      logoLink()!.click();
      logoLink()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    });
    expect(mock.navigate).not.toHaveBeenCalled(); expect(input.value).toBe(value); expect(writes()).toHaveLength(0);
    expect(mock.strategy.detachPrompt).not.toHaveBeenCalled();
  });

  it.each(["pending", "locked"] as const)("does not leave a protected %s creation request", async lock => {
    mock.strategy[lock] = true; await render();
    expect(logoLink()?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => logoLink()!.click());
    expect(mock.navigate).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
    expect(mock.strategy.save).not.toHaveBeenCalled(); expect(mock.strategy.start).not.toHaveBeenCalled();
  });

  it("keeps selected file bytes and their exact owner-bound intent intact", async () => {
    const file = new File(["a"], "brief.txt", { type: "text/plain" });
    expect(mock.memory!.set(mock.account, { ...emptyHomeInputIntent(), files: [{ localId: crypto.randomUUID(), file,
      upload: { requestKey: crypto.randomUUID(), name: file.name, mimeType: "text/plain", contentHash: "a".repeat(64) }, receipt: null, outcome: "local" }] })).toBe(true);
    const intent = mock.memory!.get(mock.account); await render();
    expect(logoLink()?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => logoLink()!.click());
    expect(mock.navigate).not.toHaveBeenCalled(); expect(mock.memory!.get(mock.account)).toBe(intent);
    expect(intent!.files[0]!.file).toBe(file); expect(writes()).toHaveLength(0);
  });

  it("keeps a pending file-selection reader and its cancellation path intact", async () => {
    const reader = mock.memory!.beginSelection(mock.account, 1); await render();
    expect(logoLink()?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => logoLink()!.click());
    expect(mock.navigate).not.toHaveBeenCalled(); expect(reader!.current()).toBe(true); expect(writes()).toHaveLength(0);
    await act(async () => reader!.complete());
    expect(logoLink()?.getAttribute("aria-disabled")).not.toBe("true");
  });
});
