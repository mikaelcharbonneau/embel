// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";

let root: Root;
let account: ReturnType<typeof useAccountSession>;
let sessionReads = 0;
let ownerId = "aaaaaaaa-1111-4111-8111-111111111111";
function Probe() { const current = useAccountSession(); useLayoutEffect(() => { account = current; }); return null; }
async function until(assert: () => void) {
  let error: unknown;
  for (let i = 0; i < 80; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    try { assert(); return; } catch (next) { error = next; }
  }
  throw error;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionReads = 0; ownerId = "aaaaaaaa-1111-4111-8111-111111111111";
  vi.stubGlobal("fetch", vi.fn(async input => {
    expect(input).toBe("/api/session"); sessionReads++;
    return Response.json({ user: { id: ownerId } });
  }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<AccountSessionProvider><Probe /></AccountSessionProvider>); });
  await until(() => expect(account.session.status).toBe("ready"));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("serializes signup with sign-in/sign-out and blocks private refresh until explicit confirmation recovery", async () => {
  const previous = account.session as VerifiedAccount;
  let resolve!: (value: "confirmation_required") => void;
  const pending = new Promise<"confirmation_required">(done => { resolve = done; });
  let result!: ReturnType<typeof account.signIn>;
  const blockedAttempt = vi.fn(async () => undefined);
  await act(async () => { result = account.signIn(() => pending, "sign-up"); });
  expect(account.isCurrent(previous)).toBe(false);
  expect(account.session.status).toBe("checking");
  expect(account.signingIn).toBe(true); expect(account.signingUp).toBe(true);
  expect(await account.signIn(blockedAttempt)).toEqual({ ok: false, reason: "pending" });
  expect(await account.signOut(true)).toEqual({ ok: false, reason: "pending" });
  await act(async () => { account.refresh(); window.dispatchEvent(new Event("focus")); });
  expect(blockedAttempt).not.toHaveBeenCalled(); expect(sessionReads).toBe(1);
  await act(async () => { resolve("confirmation_required"); expect(await result).toEqual({ ok: true, confirmationRequired: true }); });
  expect(account.session.status).toBe("signed_out"); expect(account.awaitingConfirmation).toBe(true);
  expect(account.signingIn).toBe(false); expect(account.signingUp).toBe(false);
  await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(sessionReads).toBe(1); expect(account.isCurrent(previous)).toBe(false);
  await act(async () => account.refresh());
  await until(() => expect(account.session.status).toBe("ready"));
  expect(sessionReads).toBe(2); expect(account.isCurrent(previous)).toBe(false);
});
it("retains failed-auth privacy until explicit recovery, and never automatically retries signup", async () => {
  const attempt = vi.fn(async () => { throw new Error("synthetic failure"); });
  await act(async () => { expect(await account.signIn(attempt, "sign-up")).toMatchObject({ ok: false, reason: "failed" }); });
  expect(account.session.status).toBe("error");
  expect(account.awaitingConfirmation).toBe(false);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(sessionReads).toBe(1); expect(attempt).toHaveBeenCalledOnce();
  await act(async () => account.refresh());
  await until(() => expect(account.session.status).toBe("ready"));
});
it("verifies a provider-issued immediate session afresh and fences the previous owner", async () => {
  const previous = account.session as VerifiedAccount;
  ownerId = "bbbbbbbb-2222-4222-8222-222222222222";
  await act(async () => { expect(await account.signIn(async () => undefined, "sign-up")).toEqual({ ok: true }); });
  await until(() => expect(account.session).toMatchObject({ status: "ready", userId: ownerId }));
  expect(account.isCurrent(previous)).toBe(false); expect(sessionReads).toBe(2);
  expect(account.awaitingConfirmation).toBe(false);
});
