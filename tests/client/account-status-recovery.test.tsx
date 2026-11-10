// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountSessionProvider,
  AccountStatus,
  useAccountSession,
  type VerifiedAccount,
} from "@/components/workspace/account-session";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let host: HTMLDivElement, root: Root, account: ReturnType<typeof useAccountSession>;
let reads: { signal: AbortSignal; resolve: (response: Response) => void }[];
let signOutResponse: Promise<Response>;
function Probe() {
  const value = useAccountSession();
  useLayoutEffect(() => {
    account = value;
  });
  return (
    <>
      <AccountStatus retainedEdits />
      {value.session.status === "ready" ? <p>Private content for {value.session.userId}</p> : null}
    </>
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const retry = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Check account");
async function resolveRead(index: number, response: Response) {
  await act(async () => reads[index]!.resolve(response));
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reads = [];
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  signOutResponse = Promise.resolve(new Response(null, { status: 500 }));
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init: RequestInit) => {
      if (path === "/api/auth/sign-out") return signOutResponse;
      expect(path).toBe("/api/session");
      return new Promise<Response>((resolve) => reads.push({ signal: init.signal!, resolve }));
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <AccountSessionProvider>
        <Probe />
      </AccountSessionProvider>,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("inline account verification recovery", () => {
  it("does not offer a retry or sign-in while checking, and removes the notice for a verified owner", async () => {
    expect(host.textContent).toContain("Checking your account…");
    expect(retry()).toBeUndefined();
    expect(host.querySelector('a[href="/sign-in"]')).toBeNull();
    await resolveRead(0, Response.json({ user: { id: owner } }));
    expect(host.querySelector(".account-notice")).toBeNull();
    expect(host.textContent).toBe(`Private content for ${owner}`);
  });

  it.each([500, 503])(
    "retries a %s failure exactly once per activation and permits another retry after a new failure",
    async (status) => {
      await resolveRead(0, new Response(null, { status }));
      expect(host.textContent).toContain(
        status === 503 ? "Account saving is unavailable" : "Your account session could not be verified",
      );
      expect(host.textContent).toContain("Unsaved account edits are held in this tab");
      const button = retry()!;
      expect(button).toBeDefined();
      expect(button.type).toBe("button");
      await act(async () => {
        button.click();
        button.click();
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(reads).toHaveLength(2);
      expect(account.session.status).toBe("checking");
      expect(retry()).toBeUndefined();
      expect(host.textContent).not.toContain("Private");
      await resolveRead(1, new Response(null, { status }));
      await act(async () => retry()!.click());
      expect(reads).toHaveLength(3);
      await resolveRead(2, Response.json({ user: { id: owner } }));
      expect(host.querySelector(".account-notice")).toBeNull();
    },
  );

  it.each([
    ["a signed-out answer", () => Response.json({ authenticated: false })],
    ["a 401", () => new Response(null, { status: 401 })],
  ])("invites a visitor in after %s, distinct from retryable service errors", async (_, response) => {
    await resolveRead(0, response());
    expect(host.querySelector(".account-invite > p")?.textContent).toBe("Sign in to see and save your work.");
    expect(host.querySelector('a.button[href="/sign-in"]')?.textContent).toBe("Sign in");
    expect(host.querySelector('a.button[href="/sign-up"]')?.textContent).toBe("Create account");
    expect(host.textContent).not.toMatch(/verified account session/i);
    expect(retry()).toBeUndefined();
    expect(reads).toHaveLength(1);
  });

  it("fences the old owner through a failed check, explicit retry and a different verified owner", async () => {
    await resolveRead(0, Response.json({ user: { id: owner } }));
    const previous = account.session as VerifiedAccount;
    await act(async () => account.refresh());
    expect(account.isCurrent(previous)).toBe(false);
    expect(host.textContent).not.toContain(owner);
    await resolveRead(1, new Response(null, { status: 503 }));
    expect(host.textContent).not.toContain(owner);
    await act(async () => retry()!.click());
    expect(reads).toHaveLength(3);
    expect(host.textContent).not.toContain("Private");
    await resolveRead(2, Response.json({ user: { id: other } }));
    expect(host.textContent).toBe(`Private content for ${other}`);
    expect(host.textContent).not.toContain(owner);
  });

  it("does not bypass a pending sign-in and allows explicit recovery only after the failure", async () => {
    await resolveRead(0, Response.json({ user: { id: owner } }));
    const attempt = deferred<void>();
    let result!: ReturnType<typeof account.signIn>;
    await act(async () => {
      result = account.signIn(async () => {
        await attempt.promise;
        throw new Error("Synthetic sign-in failure");
      });
    });
    expect(host.textContent).toContain("Signing in…");
    expect(retry()).toBeUndefined();
    expect(host.textContent).not.toContain(owner);
    await act(async () => {
      attempt.resolve();
      await result;
    });
    expect(retry()).toBeDefined();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(reads).toHaveLength(1);
    await act(async () => retry()!.click());
    expect(reads).toHaveLength(2);
    await resolveRead(1, new Response(null, { status: 401 }));
    expect(account.session.status).toBe("signed_out");
  });

  it("does not interrupt sign-out and offers explicit recovery after an unconfirmed outcome", async () => {
    await resolveRead(0, Response.json({ user: { id: owner } }));
    const pending = deferred<Response>();
    signOutResponse = pending.promise;
    let result!: ReturnType<typeof account.signOut>;
    await act(async () => {
      result = account.signOut();
    });
    expect(host.textContent).toContain("Signing out…");
    expect(retry()).toBeUndefined();
    expect(host.textContent).not.toContain(owner);
    await act(async () => {
      pending.resolve(new Response(null, { status: 500 }));
      await result;
    });
    expect(host.textContent).toContain("Account content remains hidden until your session is verified.");
    expect(retry()).toBeDefined();
    await act(async () => retry()!.click());
    expect(reads).toHaveLength(2);
    expect(host.textContent).not.toContain(owner);
    await resolveRead(1, Response.json({ user: { id: owner } }));
    expect(host.textContent).toBe(`Private content for ${owner}`);
  });
});
