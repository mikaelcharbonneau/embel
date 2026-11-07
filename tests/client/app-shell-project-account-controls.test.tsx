// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/workspace/app-shell";
import { useAccountSession } from "@/components/workspace/account-session";
import { DEFAULT_PROFILE_VALUES } from "@/domain/account-profile";

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useSelectedLayoutSegment: () => null,
  useSelectedLayoutSegments: () => [],
}));
vi.mock("@/components/naming/use-names-store", () => ({ useNamesStore: () => ({ data: { ui: { tab: "assistant" } } }) }));

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const dialogMethods = ["showModal", "close"] as const;
const originalDialogMethods = dialogMethods.map(name => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name));
let host: HTMLDivElement, root: Root, account: ReturnType<typeof useAccountSession>;
let sessionRead: () => Promise<Response>, jobsRead: () => Promise<Response>, currentOwner: string, fetcher: ReturnType<typeof vi.fn>;
function Probe() {
  const value = useAccountSession();
  useLayoutEffect(() => { account = value; });
  return value.session.status === "ready" ? <p>Private workspace for {value.session.userId}</p> : null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function activity(ownerId: string, projectTitle: string) {
  return Response.json({ ownerId, active: [{
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", ownerId, projectId: project, projectTitle,
    operation: "naming.generate", state: "running", progress: 20, createdAt: "2026-10-20T00:00:00Z", finishedAt: null,
  }], recent: [] });
}
async function render() {
  await act(async () => root.render(<AppShell auth={null}><Probe /></AppShell>));
  await act(async () => { await vi.advanceTimersByTimeAsync(2); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2); });
}
const menu = () => host.querySelector<HTMLDetailsElement>("details.workspace-account-menu")!;
const summary = () => menu().querySelector<HTMLElement>("summary")!;
const checkAccount = () => menu().querySelector<HTMLButtonElement>(".account-check");
const settingsLink = () => menu().querySelector<HTMLAnchorElement>('a[href="/settings"]');
const activityButton = () => menu().querySelector<HTMLButtonElement>(".generation-activity-trigger");
const label = () => menu().querySelector<HTMLSpanElement>(".workspace-account-label")!;
const sessionCalls = () => fetcher.mock.calls.filter(([path]) => path === "/api/session");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
  route.pathname = `/brands/account/${project}`;
  currentOwner = owner;
  sessionRead = async () => Response.json({ user: { id: currentOwner } });
  jobsRead = async () => activity(currentOwner, `Private activity for ${currentOwner}`);
  fetcher = vi.fn(async (path: string) => {
    if (path === "/api/session") return sessionRead();
    if (path === "/api/jobs") return jobsRead();
    if (path === "/api/account/profile") return Response.json({ profile: {
      ownerId: currentOwner, email: "fixture@example.invalid", revision: 1, updatedAt: "2026-10-20T00:00:00Z",
      values: { ...DEFAULT_PROFILE_VALUES, fullName: `Private name for ${currentOwner}` },
    } });
    throw new Error(`Unexpected fixture request ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  dialogMethods.forEach((name, index) => {
    const original = originalDialogMethods[index];
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  });
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("project account and activity controls", () => {
  it.each([
    `/brands/${project}`, `/brands/account/${project}`, `/brands/account/${project}/naming`,
    `/brands/account/${project}/logo`, `/brands/account/${project}/logo/directions`,
    `/brands/account/${project}/logo/deliverables`,
  ])("keeps native account disclosure, settings, activity and sign-out on %s", async pathname => {
    route.pathname = pathname; await render();
    expect(host.querySelector(".concept-project-workspace")).not.toBeNull();
    expect(menu().open).toBe(false);
    expect(host.querySelectorAll(".workspace-account-avatar")).toHaveLength(1);
    expect(host.querySelector(".workspace-avatar")).toBeNull();
    expect(menu().querySelector('[aria-label="Account actions"]')).not.toBeNull();
    expect(menu().textContent).toContain("Account settings");
    expect(menu().textContent).toContain("Generation activity");
    expect(summary().getAttribute("aria-label")).toBe("Account menu");
    expect(summary().getAttribute("aria-busy")).toBe("false");
    // A verified owner has no manual connection check; routine checks run on their own.
    expect(checkAccount()).toBeNull();
    expect(menu().textContent).not.toMatch(/Refresh connection|Check account/);
    expect(menu().textContent).toContain("Sign out");
    expect(settingsLink()).not.toBeNull();
    expect(activityButton()).not.toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/jobs")).toHaveLength(0);

    // Native summary activation opens the disclosure without custom key handling.
    summary().focus(); expect(document.activeElement).toBe(summary());
    await act(async () => summary().click());
    expect(menu().open).toBe(true);
    settingsLink()!.focus();
    await act(async () => settingsLink()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(menu().open).toBe(false);
    expect(document.activeElement).toBe(summary());
  });

  it("retains the same menu and controls but dismisses it on project navigation", async () => {
    route.pathname = "/"; await render();
    const original = menu(), trigger = summary(), settings = settingsLink()!, activity = activityButton();
    await act(async () => trigger.click()); settings.focus();
    for (const pathname of [`/brands/account/${project}`, `/brands/account/${project}/naming`, `/brands/account/${project}/logo`, "/assets", "/"]) {
      route.pathname = pathname; await render();
      expect(menu()).toBe(original); expect(summary()).toBe(trigger); expect(settingsLink()).toBe(settings);
      expect(activityButton()).toBe(activity); expect(menu().open).toBe(false);
    }
    expect(sessionCalls()).toHaveLength(1);
  });

  it.each([500, 503])("offers honest project controls after a %s session response", async status => {
    const initial = deferred<Response>(); sessionRead = () => initial.promise;
    await render();
    await act(async () => summary().click());
    expect(summary().getAttribute("aria-busy")).toBe("true");
    expect(label().textContent).toBe("Checking account…");
    expect(checkAccount()).toBeNull(); expect(activityButton()).toBeNull();
    expect(menu().querySelector('a[href="/sign-in"]')).toBeNull();
    expect(host.textContent).not.toContain("Private");

    await act(async () => initial.resolve(new Response(null, { status })));
    expect(label().textContent).toBe("Account");
    expect(summary().getAttribute("aria-busy")).toBe("false");
    expect(checkAccount()!.disabled).toBe(false);
    expect(menu().querySelector('a[href="/sign-in"]')).not.toBeNull();
    expect(activityButton()).toBeNull(); expect(host.textContent).not.toContain("Private");
    const retry = deferred<Response>(); sessionRead = () => retry.promise;
    await act(async () => {
      checkAccount()!.click();
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(sessionCalls()).toHaveLength(2);
    expect(checkAccount()).toBeNull();
    expect(label().textContent).toBe("Checking account…");
    await act(async () => retry.resolve(Response.json({ user: { id: owner } })));
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(activityButton()).not.toBeNull();
    expect(label().textContent).toBe(`Private name for ${owner}`);
  });

  it.each([
    ["a signed-out answer", () => Response.json({ authenticated: false })],
    ["a 401", () => new Response(null, { status: 401 })],
  ])("swaps the account menu for Sign in and Create account after %s", async (_, response) => {
    const initial = deferred<Response>(); sessionRead = () => initial.promise;
    await render();
    expect(menu()).not.toBeNull(); expect(host.querySelector('header a[href="/sign-in"]')).toBeNull();
    await act(async () => initial.resolve(response()));
    expect(host.querySelector("details.workspace-account-menu")).toBeNull();
    expect(host.querySelector('header a[href="/sign-in"]')?.textContent).toBe("Sign in");
    expect(host.querySelector('header a[href="/sign-up"]')?.textContent).toBe("Create account");
    expect(host.textContent).not.toContain("Private"); expect(sessionCalls()).toHaveLength(1);
  });

  it("lets an activity dialog own Escape without collapsing or stealing focus from it", async () => {
    await render(); await act(async () => summary().click());
    await act(async () => activityButton()!.click());
    const dialog = menu().querySelector<HTMLDialogElement>(".generation-activity-dialog")!;
    const close = dialog.querySelector<HTMLButtonElement>("header button")!;
    expect(dialog.open).toBe(true); expect(dialog.textContent).toContain(`Private activity for ${owner}`);
    close.focus();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => close.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(false);
    expect(menu().open).toBe(true); expect(document.activeElement).toBe(close);
    await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(dialog.open).toBe(false); expect(menu().open).toBe(true);
  });

  it("removes private identity and activity on recheck, ignores old activity and reveals only the verified new owner", async () => {
    await render(); await act(async () => summary().click());
    const oldActivity = deferred<Response>(); jobsRead = () => oldActivity.promise;
    await act(async () => activityButton()!.click());
    const recheck = deferred<Response>(); sessionRead = () => recheck.promise;
    await act(async () => account.refresh());
    expect(host.textContent).not.toContain("Private");
    expect(activityButton()).toBeNull();
    expect(menu().querySelector(".generation-activity-dialog")).toBeNull();
    expect(label().textContent).toBe("Checking account…");

    currentOwner = other;
    await act(async () => recheck.resolve(Response.json({ user: { id: other } })));
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    jobsRead = async () => activity(other, "Current owner activity");
    await act(async () => activityButton()!.click());
    await act(async () => oldActivity.resolve(activity(owner, "Old owner activity")));
    expect(label().textContent).toBe(`Private name for ${other}`);
    expect(host.textContent).toContain("Current owner activity");
    expect(host.textContent).not.toContain(owner);
    expect(host.textContent).not.toContain("Old owner activity");
    expect(account.session).toMatchObject({ status: "ready", userId: other });
  });
});
