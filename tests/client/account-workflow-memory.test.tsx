// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountSessionProvider,
  useAccountSession,
  type VerifiedAccount,
} from "@/components/workspace/account-session";

const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = "11111111-1111-4111-8111-111111111111",
  selectionId = "22222222-2222-4222-8222-222222222222";
let root: Root, account: ReturnType<typeof useAccountSession>, owner: string, logoutStatus: number;
let fetcher: ReturnType<typeof vi.fn>;
function Probe() {
  const current = useAccountSession();
  useLayoutEffect(() => {
    account = current;
  });
  return null;
}
async function until(assert: () => void) {
  let failure: unknown;
  for (let index = 0; index < 80; index++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    try {
      assert();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
function put(identity: VerifiedAccount, text: string) {
  expect(account.screeningDrafts, "The shared account provider must own the editor's memory").toBeDefined();
  account.screeningDrafts.put(identity, projectId, selectionId, 1, {
    tool: "domains",
    domain: "example.com",
    handle: "",
    platform: "instagram",
    jurisdictions: "",
    niceClasses: "",
    notes: text,
    sources: "",
    observedAt: "",
    acknowledged: false,
    dirty: true,
    pendingInput: null,
  });
}
function read(identity: VerifiedAccount) {
  return account.screeningDrafts.get(identity, projectId, selectionId, 1)?.notes;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  owner = ownerA;
  logoutStatus = 200;
  fetcher = vi.fn(async (path: string) => {
    if (path === "/api/session") return Response.json({ user: { id: owner } });
    expect(path).toBe("/api/auth/sign-out");
    return logoutStatus === 200
      ? Response.json({ authenticated: false })
      : new Response(null, { status: logoutStatus });
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <AccountSessionProvider>
        <Probe />
      </AccountSessionProvider>,
    ),
  );
  await until(() => expect(account.session.status).toBe("ready"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("account lifecycle protects screening drafts", () => {
  it("requires explicit discard for unsaved edits and protects browser unload", async () => {
    put(account.session as VerifiedAccount, "Private unsaved guidance");
    expect(await account.signOut()).toEqual({ ok: false, reason: "confirmation_required" });
    expect(fetcher.mock.calls.some(([path]) => path === "/api/auth/sign-out")).toBe(false);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  it("hides a failed sign-out draft, restores it to the same owner, and clears it after confirmed logout", async () => {
    const previous = account.session as VerifiedAccount;
    put(previous, "Keep until sign-out succeeds");
    logoutStatus = 503;
    await act(async () => {
      expect(await account.signOut(true)).toEqual({ ok: false, reason: "failed" });
    });
    expect(account.screeningDrafts.hasUnsaved()).toBe(true);
    expect(read(previous)).toBeUndefined();
    await act(async () => account.refresh());
    await until(() => expect(account.session.status).toBe("ready"));
    expect(read(account.session as VerifiedAccount)).toBe("Keep until sign-out succeeds");
    logoutStatus = 200;
    await act(async () => {
      expect(await account.signOut(true)).toEqual({ ok: true });
    });
    expect(account.screeningDrafts.hasUnsaved()).toBe(false);
    expect(read(previous)).toBeUndefined();
  });
  it("retains same-owner edits across revalidation while rejecting an old generation's write", async () => {
    const previous = account.session as VerifiedAccount;
    put(previous, "Current draft");
    await act(async () => account.refresh());
    await until(() => expect(account.session.status).toBe("ready"));
    expect(account.isCurrent(previous)).toBe(false);
    expect(read(previous)).toBeUndefined();
    put(previous, "Late obsolete response");
    expect(read(account.session as VerifiedAccount)).toBe("Current draft");
  });
  it("clears private drafts on owner replacement and rejects late writes from the earlier account", async () => {
    const previous = account.session as VerifiedAccount;
    put(previous, "Owner A private draft");
    owner = ownerB;
    await act(async () => account.refresh());
    await until(() => expect(account.session).toMatchObject({ status: "ready", userId: ownerB }));
    put(previous, "Late owner A response");
    expect(account.screeningDrafts.hasUnsaved()).toBe(false);
    expect(read(previous)).toBeUndefined();
    expect(read(account.session as VerifiedAccount)).toBeUndefined();
  });
});
