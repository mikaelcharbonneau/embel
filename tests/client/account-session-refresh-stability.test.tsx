// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let host: HTMLDivElement, root: Root, account: ReturnType<typeof useAccountSession>;
let reads: { signal: AbortSignal; resolve: (response: Response) => void }[];
function Probe() {
  const value = useAccountSession(); useLayoutEffect(() => { account = value; });
  return <p>{value.session.status === "ready" ? `Private ${value.session.userId}` : "Account hidden"}</p>;
}
async function resolveRead(index: number, ownerId = owner) {
  await act(async () => reads[index]!.resolve(Response.json({ user: { id: ownerId } })));
}
async function focusAndVisible() {
  await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); reads = [];
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("fetch", vi.fn((path: string, init: RequestInit) => {
    if (path === "/api/auth/sign-out") return Promise.resolve(Response.json({ authenticated: false }));
    expect(path).toBe("/api/session");
    return new Promise<Response>(resolve => reads.push({ signal: init.signal!, resolve }));
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AccountSessionProvider><Probe /></AccountSessionProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("automatic account verification without remounting", () => {
  it("coalesces focus/visibility and retains the same verified session for the same owner", async () => {
    await focusAndVisible(); expect(reads).toHaveLength(1);
    await resolveRead(0); const before = account.session;
    const node = host.querySelector("p");
    await focusAndVisible(); expect(reads).toHaveLength(2);
    expect(account.session).toBe(before); expect(host.querySelector("p")).toBe(node);
    await focusAndVisible(); expect(reads).toHaveLength(2);
    await resolveRead(1); expect(account.session).toBe(before);
    expect(host.querySelector("p")).toBe(node);
  });
  it("fences and replaces the owner when background verification confirms a different account", async () => {
    await resolveRead(0); const before = account.session as VerifiedAccount;
    await focusAndVisible(); await resolveRead(1, other);
    expect(account.isCurrent(before)).toBe(false);
    expect(account.session).toMatchObject({ userId: other, generation: 2 });
    expect(host.textContent).not.toContain(owner);
  });
  it("explicit account refresh still hides private content and rejects stale responses", async () => {
    await resolveRead(0); await focusAndVisible();
    await act(async () => account.refresh());
    expect(reads[1]!.signal.aborted).toBe(true);
    expect(host.textContent).toBe("Account hidden");
    await resolveRead(1, other); expect(account.session.status).toBe("checking");
    await resolveRead(2); expect(account.session).toMatchObject({ userId: owner, generation: 2 });
  });
  it.each(["blur", "hidden"] as const)("invalidates a pending background read on %s and checks again on return", async departure => {
    await resolveRead(0); const before = account.session;
    await focusAndVisible();
    await act(async () => {
      if (departure === "blur") window.dispatchEvent(new Event("blur"));
      else { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); }
    });
    expect(reads[1]!.signal.aborted).toBe(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await focusAndVisible(); expect(reads).toHaveLength(3);
    await resolveRead(1, other); expect(account.session).toBe(before);
    await resolveRead(2); expect(account.session).toBe(before);
  });
  it("hides account content if background verification reports signed out", async () => {
    await resolveRead(0); const before = account.session as VerifiedAccount;
    await focusAndVisible(); await act(async () => reads[1]!.resolve(new Response(null, { status: 401 })));
    expect(account.session.status).toBe("signed_out"); expect(account.isCurrent(before)).toBe(false);
    expect(host.textContent).toBe("Account hidden");
  });
  it("bounds stalled verification and ignores its eventual response", async () => {
    await resolveRead(0); await focusAndVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(account.session.status).toBe("error"); expect(host.textContent).toBe("Account hidden");
    await resolveRead(1, other); expect(account.session.status).toBe("error");
    await focusAndVisible(); await resolveRead(2); expect(account.session).toMatchObject({ status: "ready", userId: owner });
  });
  it("cannot undo explicit sign-out with a late background response", async () => {
    await resolveRead(0); await focusAndVisible();
    await act(async () => { expect(await account.signOut()).toEqual({ ok: true }); });
    expect(reads[1]!.signal.aborted).toBe(true);
    await resolveRead(1); expect(account.session.status).toBe("signed_out");
    expect(host.textContent).toBe("Account hidden");
  });
});
