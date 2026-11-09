// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetDetailDialog } from "@/components/assets/asset-detail";
import { GenerationActivity } from "@/components/workspace/generation-activity";
import { AccountAccess } from "@/components/workspace/account-access";
import { SignInDialog } from "@/components/auth/sign-in-dialog";
import type { AssetLibraryItem } from "@/domain/asset-library";
import type { AccountAssetsClient } from "@/components/assets/account-assets-client";

const mocks = vi.hoisted(() => ({ back: vi.fn(), signOut: vi.fn(), request: vi.fn(), current: () => true, expire: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ back: mocks.back }) }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: { status: "ready", userId: "owner", generation: 1 }, signOut: mocks.signOut, isCurrent: mocks.current, expire: mocks.expire }) }));
vi.mock("@/components/workspace/account-api", () => ({ accountRequest: mocks.request, AccountRequestError: class extends Error {} }));
vi.mock("@/components/assets/asset-preview", () => ({ AssetPreview: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.back.mockReset(); mocks.signOut.mockReset().mockResolvedValue({ ok: false, reason: "confirmation_required" });
  mocks.request.mockReset().mockResolvedValue({ ownerId: "owner", active: [], recent: [] });
  // jsdom has no native dialog implementation. These shims exercise React's
  // close/cancel wiring, not native browser focus restoration or hit-testing.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event("close")); } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const kinds = ["asset", "activity", "sign-out", "sign-in"] as const;
type Kind = typeof kinds[number];
async function mount(kind: Kind) {
  const dismissed = vi.fn();
  await act(async () => {
    if (kind === "asset") root.render(<AssetDetailDialog item={{ asset: {}, project: { title: "Fixture" } } as AssetLibraryItem} client={{ detail: () => new Promise(() => {}), current: () => true } as unknown as AccountAssetsClient} onClose={dismissed} onSelected={vi.fn()} />);
    else if (kind === "activity") root.render(<GenerationActivity />);
    else if (kind === "sign-out") root.render(<AccountAccess />);
    else root.render(<SignInDialog><h2 id="auth-overlay-title">Sign in</h2></SignInDialog>);
  });
  if (kind === "activity" || kind === "sign-out") await act(async () => {
    const trigger = Array.from(host.querySelectorAll("button")).find(button => kind === "activity" ? button.getAttribute("aria-label") === "Activity" : button.textContent === ({ "sign-out": "Sign out" } as Record<string, string>)[kind]);
    trigger!.click();
  });
  const dialog = host.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  return { dialog, wasDismissed: () => kind === "asset" ? dismissed.mock.calls.length > 0 : kind === "sign-in" ? mocks.back.mock.calls.length > 0 : !dialog.open };
}

for (const width of [390, 1440]) for (const pointerType of ["mouse", "touch"]) describe(`${width}px ${pointerType} click fixture`, () => {
  it.each(kinds)("protects %s padding, descendants, edges and scrollbar gutter; dismisses only the backdrop", async kind => {
    const { dialog, wasDismissed } = await mount(kind);
    const left = 20, top = 30, right = width - 20, bottom = 500;
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} });
    async function click(target: Element, x: number, y: number) {
      const event = new MouseEvent("click", { bubbles: true, clientX: x, clientY: y });
      Object.defineProperty(event, "pointerType", { value: pointerType });
      await act(async () => { target.dispatchEvent(event); });
    }
    for (const [x, y] of [[left + 2, top + 2], [right - 5, 150], [left, top], [right, bottom], [width / 2, 250]]) {
      await click(dialog, x!, y!); expect(wasDismissed()).toBe(false);
    }
    // A descendant must not count as backdrop, even with unusual coordinates.
    await click(dialog.querySelector("h2")!, 0, 0); expect(wasDismissed()).toBe(false);
    await click(dialog, left - 1, top + 10); expect(wasDismissed()).toBe(true);
    expect(mocks.signOut.mock.calls).toEqual(kind === "sign-out" ? [[false]] : []);
    expect(mocks.request.mock.calls.every(call => call[0] === "/api/jobs")).toBe(true);
  });
});

it.each(kinds)("keeps %s Escape cancel wiring", async kind => {
  const { dialog, wasDismissed } = await mount(kind);
  await act(async () => { dialog.dispatchEvent(new Event("cancel", { cancelable: true })); });
  expect(wasDismissed()).toBe(true);
  expect(mocks.signOut.mock.calls).toEqual(kind === "sign-out" ? [[false]] : []);
});
it.each(["activity", "sign-out"] as const)("syncs %s native close state and can reopen", async kind => {
  const { dialog, wasDismissed } = await mount(kind);
  await act(async () => dialog.close()); expect(wasDismissed()).toBe(true);
  await act(async () => Array.from(host.querySelectorAll("button")).find(button => kind === "activity" ? button.getAttribute("aria-label") === "Activity" : button.textContent === "Sign out")!.click());
  expect(dialog.open).toBe(true);
});
it.each(kinds)("preserves %s explicit close or keep-editing action", async kind => {
  const { wasDismissed } = await mount(kind);
  const label = { asset: "Close asset details", activity: "Close", "sign-out": "Keep editing", "sign-in": "Close sign-in" }[kind];
  const button = Array.from(host.querySelectorAll("button")).find(element => element.getAttribute("aria-label") === label || element.textContent === label)!;
  await act(async () => button.click()); expect(wasDismissed()).toBe(true);
  expect(mocks.signOut.mock.calls).toEqual(kind === "sign-out" ? [[false]] : []);
});
it("only the explicit discard action confirms unsaved-edit sign-out", async () => {
  await mount("sign-out");
  await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Discard edits and sign out")!.click());
  expect(mocks.signOut.mock.calls).toEqual([[false], [true]]);
});

