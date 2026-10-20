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

describe("automatic account verification single flight", () => {
  it("shares only an in-flight check and immediately fences the first focus event", async () => {
    await focusAndVisible(); expect(reads).toHaveLength(1);
    await resolveRead(0); const previous = account.session as VerifiedAccount;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      expect(account.isCurrent(previous)).toBe(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(reads).toHaveLength(2); expect(reads[1]!.signal.aborted).toBe(false);
    expect(account.session).toEqual({ status: "checking", generation: 2 });
    expect(host.textContent).toBe("Account hidden");
    await focusAndVisible(); expect(reads).toHaveLength(2);
    await resolveRead(1); expect(account.session).toMatchObject({ status: "ready", generation: 2, userId: owner });
    await focusAndVisible(); expect(reads).toHaveLength(3);
    expect(account.session.status).toBe("checking");
  });

  it("explicit refresh supersedes automatic reads and stale cleanup cannot clear its replacement", async () => {
    await resolveRead(0); await focusAndVisible();
    await act(async () => account.refresh());
    expect(reads).toHaveLength(3); expect(reads[1]!.signal.aborted).toBe(true);
    await resolveRead(1, other); await focusAndVisible();
    expect(reads).toHaveLength(3); expect(host.textContent).toBe("Account hidden");
    await resolveRead(2); expect(account.session).toMatchObject({ status: "ready", generation: 3, userId: owner });
  });

  it.each(["blur", "hidden"] as const)("supersedes an unresolved read after a genuine %s/return activation", async (departure) => {
    await resolveRead(0); await focusAndVisible();
    await act(async () => {
      if (departure === "blur") window.dispatchEvent(new Event("blur"));
      else {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      }
    });
    expect(reads[1]!.signal.aborted).toBe(true);
    expect(host.textContent).toBe("Account hidden");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await focusAndVisible(); expect(reads).toHaveLength(3);
    await resolveRead(1); expect(account.session.status).toBe("checking");
    await focusAndVisible(); expect(reads).toHaveLength(3);
    await resolveRead(2, other);
    expect(account.session).toMatchObject({ status: "ready", userId: other, generation: 3 });
    expect(host.textContent).not.toContain(owner);
  });

  it("does not let an explicit read while inactive consume the return fence", async () => {
    await resolveRead(0);
    await act(async () => window.dispatchEvent(new Event("blur")));
    await act(async () => account.refresh()); expect(reads).toHaveLength(2);
    await focusAndVisible(); expect(reads).toHaveLength(3);
    expect(reads[1]!.signal.aborted).toBe(true);
    await resolveRead(1); expect(account.session.status).toBe("checking");
    await resolveRead(2, other); expect(account.session).toMatchObject({ status: "ready", userId: other });
  });

  it("supersedes startup verification begun in an initially hidden document", async () => {
    await act(async () => root.unmount());
    reads = [];
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    root = createRoot(host);
    await act(async () => root.render(<AccountSessionProvider><Probe /></AccountSessionProvider>));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(reads).toHaveLength(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await focusAndVisible(); expect(reads).toHaveLength(2); expect(reads[0]!.signal.aborted).toBe(true);
    await resolveRead(0); expect(account.session.status).toBe("checking");
    await resolveRead(1, other); expect(account.session).toMatchObject({ status: "ready", userId: other, generation: 2 });
  });

  it("sign-in supersedes verification and prevents automatic checks during the authentication fence", async () => {
    await resolveRead(0); await focusAndVisible();
    let finish!: () => void; const authentication = new Promise<void>(resolve => { finish = resolve; });
    let result!: ReturnType<typeof account.signIn>;
    await act(async () => { result = account.signIn(() => authentication); });
    expect(reads[1]!.signal.aborted).toBe(true); await focusAndVisible(); expect(reads).toHaveLength(2);
    await resolveRead(1); expect(host.textContent).toBe("Account hidden");
    await act(async () => { finish(); await result; });
    expect(reads).toHaveLength(3); await resolveRead(2, other);
    expect(account.session).toMatchObject({ status: "ready", userId: other });
    expect(host.textContent).not.toContain(owner);
  });

  it("sign-out cannot be undone by a late verification and does not leave automatic checks locked", async () => {
    await resolveRead(0); await focusAndVisible();
    await act(async () => { expect(await account.signOut()).toEqual({ ok: true }); });
    expect(reads[1]!.signal.aborted).toBe(true); expect(account.session.status).toBe("signed_out");
    await resolveRead(1); expect(account.session.status).toBe("signed_out");
    await focusAndVisible(); expect(reads).toHaveLength(3); expect(host.textContent).toBe("Account hidden");
    await act(async () => reads[2]!.resolve(new Response(null, { status: 401 })));
    expect(account.session.status).toBe("signed_out");
  });

  it("bounds non-abortable stalled checks, ignores their late result, and permits a new check", async () => {
    await resolveRead(0); await focusAndVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(account.session.status).toBe("error"); expect(reads[1]!.signal.aborted).toBe(true);
    await focusAndVisible(); expect(reads).toHaveLength(3);
    await resolveRead(1, other); expect(account.session.status).toBe("checking");
    expect(host.textContent).toBe("Account hidden");
    await resolveRead(2); expect(account.session).toMatchObject({ status: "ready", userId: owner, generation: 3 });
  });
});
