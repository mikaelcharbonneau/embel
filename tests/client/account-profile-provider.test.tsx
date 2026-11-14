// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountSessionProvider,
  useAccountSession,
  type VerifiedAccount,
} from "@/components/workspace/account-session";
import { AccountProfileProvider, useAccountProfile } from "@/components/workspace/account-profile-provider";
import { AccountProfileEditor } from "@/components/workspace/account-profile-editor";
import { BrowserLocalDate } from "@/components/workspace/browser-local-date";
import { DEFAULT_PROFILE_VALUES, type AccountProfile } from "@/domain/account-profile";

const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fixture = (ownerId = ownerA): AccountProfile => ({
  ownerId,
  email: `${ownerId === ownerA ? "a" : "b"}@example.invalid`,
  revision: 1,
  updatedAt: "2026-10-13T00:00:00Z",
  values: { ...DEFAULT_PROFILE_VALUES, fullName: ownerId === ownerA ? "Saved A" : "Saved B" },
});
let host: HTMLDivElement, root: Root;
let account: ReturnType<typeof useAccountSession>, profile: NonNullable<ReturnType<typeof useAccountProfile>>;
let ownerId: string, saved: AccountProfile, fetcher: ReturnType<typeof vi.fn>, logoutStatus: number;
let readOverride: (() => Promise<Response>) | null,
  saveOverride: ((input: { expectedRevision: number; values: AccountProfile["values"] }) => Promise<Response>) | null;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function Probe() {
  const session = useAccountSession(),
    current = useAccountProfile()!;
  useLayoutEffect(() => {
    account = session;
    profile = current;
  });
  return (
    <>
      <span data-saved-name>{current.workspace?.saved.values.fullName ?? "My account"}</span>
      <AccountProfileEditor />
      <div data-date>
        <BrowserLocalDate dateTime="2026-10-13T00:30:00Z" />
      </div>
    </>
  );
}
async function mount() {
  await act(async () =>
    root.render(
      <AccountSessionProvider>
        <AccountProfileProvider>
          <Probe />
        </AccountProfileProvider>
      </AccountSessionProvider>,
    ),
  );
}
async function until(assert: () => void) {
  let error: unknown;
  for (let i = 0; i < 100; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    try {
      assert();
      return;
    } catch (caught) {
      error = caught;
    }
  }
  throw error;
}
const fullName = () => host.querySelector<HTMLInputElement>('input[autocomplete="name"]')!;
// While the account is rechecked the fields are not drawn at all; when drawn they must not show the old edits.
const shownName = () => host.querySelector<HTMLInputElement>('input[autocomplete="name"]')?.value ?? "";
async function edit(patch: Partial<AccountProfile["values"]>) {
  await act(async () => profile.edit({ ...profile.workspace!.values, ...patch }));
}
async function click(label: string) {
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === label)!.click());
}
// Edits save on their own after a pause (650 ms for the name). Wait past it in real time.
async function autosave() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
}
const patches = () => fetcher.mock.calls.filter(([, init]) => init.method === "PATCH");
const nameStatus = () => host.querySelector("#profile-fullName-status")!;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ownerId = ownerA;
  saved = fixture();
  logoutStatus = 200;
  readOverride = null;
  saveOverride = null;
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path === "/api/session") return Response.json({ user: { id: ownerId } });
    if (path === "/api/auth/sign-out")
      return logoutStatus === 200
        ? Response.json({ authenticated: false })
        : new Response(null, { status: logoutStatus });
    expect(path).toBe("/api/account/profile");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    if (init.method === "PATCH") {
      if (new Headers(init.headers).get("X-Embel-Account") !== ownerId) return new Response(null, { status: 401 });
      const input = JSON.parse(init.body as string);
      if (saveOverride) return saveOverride(input);
      if (input.expectedRevision !== saved.revision) return new Response(null, { status: 409 });
      saved = { ...saved, revision: saved.revision + 1, values: input.values };
      return Response.json({ profile: saved });
    }
    return readOverride ? readOverride() : Response.json({ profile: saved });
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await mount();
  await until(() => expect(profile.workspace?.saved.values.fullName).toBe("Saved A"));
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("real profile and account providers", () => {
  it("sends the captured owner and expires a stale session before its edits reach a cookie-switched account", async () => {
    await edit({ fullName: "Private draft A" });
    ownerId = ownerB;
    saved = fixture(ownerB);
    expect(account.session).toMatchObject({ status: "ready", userId: ownerA });
    await autosave();
    await until(() => expect(account.session.status).toBe("signed_out"));
    const writes = fetcher.mock.calls.filter(([, init]) => init.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(new Headers(writes[0]![1].headers).get("X-Embel-Account")).toBe(ownerA);
    expect(saved).toEqual(fixture(ownerB));
    expect(profile.workspace).toBeNull();
    expect(account.profileDrafts.hasUnsaved()).toBe(true);
  });
  it("saves edits to the account, applies preferences, and restores them in a new session", async () => {
    expect(fullName().value).toBe("Saved A");
    expect(host.querySelector<HTMLInputElement>('input[autocomplete="email"]')?.readOnly).toBe(true);
    await edit({ fullName: "Renée Example", timeZone: "Asia/Tokyo", dateFormat: "iso" });
    expect(host.querySelector("[data-saved-name]")?.textContent).toBe("Saved A");
    // Nothing claims "Saved" before the server confirms.
    expect(nameStatus().textContent).toBe("Your name appears in the account menu.");
    await autosave();
    await until(() => expect(nameStatus().textContent).toBe("Saved"));
    expect(host.querySelector("[data-saved-name]")?.textContent).toBe("Renée Example");
    expect(host.querySelector("[data-date]")?.textContent).toBe("2026-10-13");
    expect(saved.revision).toBe(2);
    expect(account.profileDrafts.hasUnsaved()).toBe(false);
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    await until(() => expect(fullName().value).toBe("Renée Example"));
    expect(profile.workspace?.values.timeZone).toBe("Asia/Tokyo");
    expect(profile.workspace?.values.dateFormat).toBe("iso");
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
  });
  it("confirms unsaved profile sign-out, keeps edits after failure, then clears only after confirmed logout", async () => {
    await edit({ fullName: "Unsaved private name" });
    expect(await account.signOut()).toEqual({ ok: false, reason: "confirmation_required" });
    expect(fetcher.mock.calls.some(([path]) => path === "/api/auth/sign-out")).toBe(false);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    logoutStatus = 503;
    await act(async () => {
      expect(await account.signOut(true)).toEqual({ ok: false, reason: "failed" });
    });
    expect(account.profileDrafts.hasUnsaved()).toBe(true);
    expect(profile.workspace).toBeNull();
    expect(host.textContent).not.toContain("Saved A");
    expect(shownName()).not.toBe("Unsaved private name");
    await act(async () => account.refresh());
    await until(() => expect(fullName().value).toBe("Unsaved private name"));
    logoutStatus = 200;
    await act(async () => {
      expect(await account.signOut(true)).toEqual({ ok: true });
    });
    expect(account.profileDrafts.hasUnsaved()).toBe(false);
    expect(profile.workspace).toBeNull();
    await act(async () => account.refresh());
    await until(() => expect(fullName().value).toBe("Saved A"));
  });
  it("preserves drafts through generation rechecks and rejects stale-memory writes", async () => {
    await edit({ fullName: "Keep my draft" });
    const old = account.session as VerifiedAccount,
      previous = profile.workspace!;
    await act(async () => account.refresh());
    expect(account.profileDrafts.get(old)).toBeNull();
    await until(() => expect(fullName().value).toBe("Keep my draft"));
    expect(account.profileDrafts.set(old, previous)).toBe(false);
    expect(profile.workspace?.values.fullName).toBe("Keep my draft");
  });
  it("clears a different owner's drafts and ignores a delayed save without exposing the earlier name", async () => {
    await edit({ fullName: "Private draft A" });
    const pending = deferred<Response>();
    saveOverride = () => pending.promise;
    await autosave();
    expect(nameStatus().textContent).toBe("Saving");
    const old = account.session as VerifiedAccount;
    const request = fetcher.mock.calls.find(([, init]) => init.method === "PATCH")![1];
    ownerId = ownerB;
    saved = fixture(ownerB);
    saveOverride = null;
    await act(async () => account.refresh());
    expect(host.textContent).not.toContain("Saved A");
    expect(shownName()).not.toContain("Private draft A");
    await until(() => expect(fullName().value).toBe("Saved B"));
    expect(request.signal.aborted).toBe(true);
    await act(async () =>
      pending.resolve(
        Response.json({
          profile: { ...fixture(), revision: 2, values: { ...DEFAULT_PROFILE_VALUES, fullName: "Private draft A" } },
        }),
      ),
    );
    expect(fullName().value).toBe("Saved B");
    expect(host.textContent).not.toContain("Private draft A");
    expect(account.profileDrafts.get(old)).toBeNull();
    expect(account.profileDrafts.hasUnsaved()).toBe(false);
  });
  it("reads the latest settings itself after a conflict and requires an explicit overwrite choice", async () => {
    await edit({ fullName: "My edit" });
    saved = { ...saved, revision: 2, values: { ...saved.values, fullName: "Another session" } };
    await autosave();
    await until(() => expect(host.textContent).toContain("Your settings changed in another session"));
    expect(host.textContent).toContain("Another session");
    expect(saved.values.fullName).toBe("Another session");
    expect(fullName().value).toBe("My edit");
    expect(fullName().disabled).toBe(true);
    // No overwrite until the person chooses.
    await autosave();
    expect(patches()).toHaveLength(1);
    await click("Keep my edits");
    expect(fullName().disabled).toBe(false);
    await autosave();
    await until(() => expect(saved.values.fullName).toBe("My edit"));
    expect(saved.revision).toBe(3);
    await until(() => expect(nameStatus().textContent).toBe("Saved"));
  });
  it("recovers a lost save acknowledgement by reading the stored values without repeating the mutation", async () => {
    await edit({ fullName: "Committed but response lost" });
    saveOverride = async (input) => {
      saved = { ...saved, revision: 2, values: input.values };
      throw new Error("synthetic network failure");
    };
    await autosave();
    await until(() => expect(nameStatus().textContent).toBe("Couldn’t save. Check your connection.Try again"));
    expect(account.profileDrafts.hasUnsaved()).toBe(true);
    // A failed save is never retried on its own: it may have landed.
    await autosave();
    expect(patches()).toHaveLength(1);
    await click("Try again");
    await until(() => expect(nameStatus().textContent).toBe("Saved"));
    expect(fullName().value).toBe("Committed but response lost");
    expect(account.profileDrafts.hasUnsaved()).toBe(false);
    await autosave();
    expect(patches()).toHaveLength(1);
  });
  it("saves again after Try again when the read shows the failed save did not land", async () => {
    await edit({ fullName: "Offline edit" });
    saveOverride = async () => {
      throw new Error("synthetic network failure");
    };
    await autosave();
    await until(() => expect(nameStatus().textContent).toContain("Couldn’t save"));
    // Typing stays possible after a failure; the edits wait for Try again.
    await edit({ fullName: "Offline edit, longer" });
    await autosave();
    expect(patches()).toHaveLength(1);
    expect(nameStatus().textContent).toContain("Couldn’t save");
    saveOverride = null;
    await click("Try again");
    await autosave();
    await until(() => expect(saved.values.fullName).toBe("Offline edit, longer"));
    expect(patches()).toHaveLength(2);
    expect(patches()[1]![1].body).toContain('"expectedRevision":1');
    await until(() => expect(nameStatus().textContent).toBe("Saved"));
  });
  it("keeps edits typed while a save runs and saves them next", async () => {
    await edit({ fullName: "First" });
    const pending = deferred<Response>();
    saveOverride = () => pending.promise;
    await autosave();
    expect(nameStatus().textContent).toBe("Saving");
    expect(fullName().disabled).toBe(false);
    await edit({ fullName: "First and second" });
    saveOverride = null;
    saved = { ...saved, revision: 2, values: { ...saved.values, fullName: "First" } };
    await act(async () => pending.resolve(Response.json({ profile: saved })));
    expect(fullName().value).toBe("First and second");
    expect(nameStatus().textContent).not.toBe("Saved");
    await autosave();
    await until(() => expect(saved.values.fullName).toBe("First and second"));
    expect(saved.revision).toBe(3);
    await until(() => expect(nameStatus().textContent).toBe("Saved"));
  });
  it("rejects a foreign profile response and hides saved names when the profile API rejects the session", async () => {
    readOverride = async () => Response.json({ profile: fixture(ownerB) });
    await act(async () => profile.reload());
    await until(() => expect(account.session.status).toBe("signed_out"));
    expect(profile.workspace).toBeNull();
    expect(host.textContent).not.toContain("Saved B");
    expect(host.textContent).not.toContain("Saved A");
  });
  it("bounds a stalled save and ignores a late acknowledgement after the timeout", async () => {
    vi.useFakeTimers();
    await edit({ fullName: "Pending" });
    const pending = deferred<Response>();
    saveOverride = () => pending.promise;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(nameStatus().textContent).toBe("Saving");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(nameStatus().textContent).toContain("Couldn’t save. Check your connection.");
    expect(profile.workspace?.mustReload).toBe(true);
    await act(async () =>
      pending.resolve(
        Response.json({ profile: { ...saved, revision: 2, values: { ...saved.values, fullName: "Late" } } }),
      ),
    );
    expect(profile.workspace?.saved.values.fullName).toBe("Saved A");
    expect(fullName().value).toBe("Pending");
  });
});
