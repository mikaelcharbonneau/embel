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
vi.mock("@/components/naming/use-names-store", () => ({
  useNamesStore: () => ({ data: { ui: { tab: "assistant" } } }),
}));

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const dialogMethods = ["showModal", "close"] as const;
const originalDialogMethods = dialogMethods.map((name) =>
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
);
let host: HTMLDivElement, root: Root, account: ReturnType<typeof useAccountSession>;
let sessionRead: () => Promise<Response>,
  jobsRead: () => Promise<Response>,
  billingRead: () => Promise<Response>,
  currentOwner: string,
  fetcher: ReturnType<typeof vi.fn>;
function Probe() {
  const value = useAccountSession();
  useLayoutEffect(() => {
    account = value;
  });
  return value.session.status === "ready" ? <p>Private workspace for {value.session.userId}</p> : null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function activity(ownerId: string, projectTitle: string) {
  return Response.json({
    ownerId,
    active: [
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        ownerId,
        projectId: project,
        projectTitle,
        operation: "naming.generate",
        state: "running",
        progress: 20,
        createdAt: "2026-10-20T00:00:00Z",
        finishedAt: null,
      },
    ],
    recent: [],
  });
}
function billing(balance: number, periodEnd = "2026-12-01T00:00:00Z") {
  return Response.json({ billing: { planId: "pro", balance, periodEnd, subscription: null, plans: [] } });
}
/** Each fixture owner has their own email, so one owner's address can be looked for after a switch. */
const emailOf = (ownerId: string) => `${ownerId.slice(0, 8)}@example.invalid`;
async function render() {
  await act(async () =>
    root.render(
      <AppShell auth={null}>
        <Probe />
      </AppShell>,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2);
  });
}
const trigger = () => host.querySelector<HTMLButtonElement>("[data-account-menu-trigger]")!;
const menu = () => document.getElementById(trigger().getAttribute("aria-controls")!)!;
const isOpen = () => trigger().getAttribute("aria-expanded") === "true";
const rows = () => [...menu().querySelectorAll<HTMLElement>('[role="menuitem"]')];
const rowLabels = () => rows().map((row) => row.textContent);
const row = (label: string) => rows().find((item) => item.textContent === label) ?? null;
const summary = () => menu().querySelector<HTMLElement>(".e-menu__summary");
const activityDialog = () =>
  [...document.querySelectorAll<HTMLDialogElement>("dialog")].find(
    (dialog) => dialog.querySelector("h2")?.textContent === "Activity",
  ) ?? null;
const calls = (path: string) => fetcher.mock.calls.filter(([called]) => called === path);
async function openMenu() {
  if (!isOpen()) await act(async () => trigger().click());
  expect(isOpen()).toBe(true);
}
async function press(key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => document.activeElement!.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  route.pathname = `/brands/account/${project}`;
  currentOwner = owner;
  sessionRead = async () => Response.json({ user: { id: currentOwner } });
  jobsRead = async () => activity(currentOwner, `Private activity for ${currentOwner}`);
  billingRead = async () => billing(currentOwner === owner ? 112 : 40);
  fetcher = vi.fn(async (path: string) => {
    if (path === "/api/session") return sessionRead();
    if (path === "/api/jobs") return jobsRead();
    if (path === "/api/billing") return billingRead();
    if (path === "/api/account/profile")
      return Response.json({
        profile: {
          ownerId: currentOwner,
          email: emailOf(currentOwner),
          revision: 1,
          updatedAt: "2026-10-20T00:00:00Z",
          values: { ...DEFAULT_PROFILE_VALUES, fullName: `Private name for ${currentOwner}` },
        },
      });
    throw new Error(`Unexpected fixture request ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  dialogMethods.forEach((name, index) => {
    const original = originalDialogMethods[index];
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  });
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("project account and activity controls", () => {
  it.each([
    `/brands/${project}`,
    `/brands/account/${project}`,
    `/brands/account/${project}/naming`,
    `/brands/account/${project}/logo`,
    `/brands/account/${project}/logo/directions`,
    `/brands/account/${project}/logo/deliverables`,
  ])("keeps one keyboard-usable account menu with settings, plans, activity and sign-out on %s", async (pathname) => {
    route.pathname = pathname;
    await render();
    expect(host.querySelector(".concept-project-workspace")).not.toBeNull();
    expect(host.querySelectorAll("[data-account-menu-trigger]")).toHaveLength(1);
    const button = trigger();
    expect(button.tagName).toBe("BUTTON");
    expect(button.classList).toContain("e-avatar");
    expect(button.getAttribute("aria-label")).toBe("Account menu");
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // The verified owner's initials, never the name itself.
    expect(button.textContent).toBe("PA");
    // Closed, the menu is hidden and holds no rows.
    expect(menu().getAttribute("role")).toBe("menu");
    expect(menu().hidden).toBe(true);
    expect(menu().childElementCount).toBe(0);
    expect(calls("/api/jobs")).toHaveLength(0);

    await act(async () => button.click());
    expect(isOpen()).toBe(true);
    expect(menu().hidden).toBe(false);
    expect(summary()?.textContent).toContain(emailOf(owner));
    expect(summary()?.textContent).toContain("Pro");
    expect(summary()?.textContent).toContain("112 credits left this month");
    expect(summary()?.textContent).not.toContain("New credits arrive");
    expect(rowLabels()).toEqual(["Settings", "Plans", "Activity", "Sign out"]);
    expect(row("Settings")!.getAttribute("href")).toBe("/settings");
    expect(row("Plans")!.getAttribute("href")).toBe("/plans");
    expect(row("Activity")!.tagName).toBe("BUTTON");
    expect(row("Sign out")!.tagName).toBe("BUTTON");
    // A verified owner has no manual connection check; routine checks run on their own.
    expect(menu().textContent).not.toMatch(/Refresh connection|Check account|Sign in/);
    // Opening never reads activity; only the Activity dialog does.
    expect(calls("/api/jobs")).toHaveLength(0);

    // Focus moves into the menu; the arrow keys wrap, Home and End jump to the ends.
    expect(document.activeElement).toBe(row("Settings"));
    for (const [key, label] of [
      ["ArrowDown", "Plans"],
      ["ArrowDown", "Activity"],
      ["ArrowDown", "Sign out"],
      ["ArrowDown", "Settings"],
      ["ArrowUp", "Sign out"],
      ["Home", "Settings"],
      ["End", "Sign out"],
    ] as const) {
      expect((await press(key)).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(row(label));
    }
    // Escape closes it and returns focus to the button.
    expect((await press("Escape")).defaultPrevented).toBe(true);
    expect(isOpen()).toBe(false);
    expect(menu().hidden).toBe(true);
    expect(rows()).toHaveLength(0);
    expect(document.activeElement).toBe(button);
  });

  it("keeps the same menu button and panel across pages but closes the menu on each page change", async () => {
    route.pathname = "/";
    await render();
    const button = trigger(),
      panel = menu();
    for (const pathname of [
      `/brands/account/${project}`,
      `/brands/account/${project}/naming`,
      `/brands/account/${project}/logo`,
      "/assets",
      "/",
    ]) {
      await openMenu();
      expect(rowLabels()).toEqual(["Settings", "Plans", "Activity", "Sign out"]);
      route.pathname = pathname;
      await render();
      expect(trigger()).toBe(button);
      expect(menu()).toBe(panel);
      expect(isOpen()).toBe(false);
      expect(panel.hidden).toBe(true);
      expect(rows()).toHaveLength(0);
    }
    expect(calls("/api/session")).toHaveLength(1);
    // The plan and balance are read once per verified account, not on every page.
    expect(calls("/api/billing")).toHaveLength(1);
  });

  it("says when new credits arrive and offers plans first when the balance is spent", async () => {
    billingRead = async () => billing(0, "2026-12-01T12:00:00Z");
    await render();
    await openMenu();
    expect(summary()?.textContent).toContain("0 credits left this month");
    expect(summary()?.textContent).toContain("New credits arrive on December 1");
    expect(rowLabels()).toEqual(["See plans", "Settings", "Activity", "Sign out"]);
    expect(row("See plans")!.getAttribute("href")).toBe("/plans");
    expect(document.activeElement).toBe(row("See plans"));
    // Credits only: no money anywhere in the menu.
    expect(menu().textContent).not.toMatch(/\$|USD/);
  });

  it("says the plan can't be shown when the balance can't be read, without inventing one", async () => {
    billingRead = async () => new Response(null, { status: 503 });
    await render();
    await openMenu();
    expect(summary()?.textContent).toContain(emailOf(owner));
    expect(summary()?.textContent).toContain("Your plan can’t be shown right now.");
    expect(summary()?.textContent).not.toMatch(/credits left|Pro|Free/);
    expect(rowLabels()).toEqual(["Settings", "Plans", "Activity", "Sign out"]);
  });

  it.each([500, 503])("offers honest account controls after a %s session response", async (status) => {
    const initial = deferred<Response>();
    sessionRead = () => initial.promise;
    await render();
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(trigger().getAttribute("aria-label")).toBe("Account menu, checking your account");
    expect(trigger().textContent).toBe("");
    await openMenu();
    expect(summary()?.textContent).toBe("Checking your account…");
    expect(rows()).toHaveLength(0);
    expect(host.textContent).not.toContain("Private");
    expect(calls("/api/billing")).toHaveLength(0);

    await act(async () => initial.resolve(new Response(null, { status })));
    expect(trigger().hasAttribute("aria-busy")).toBe(false);
    expect(trigger().getAttribute("aria-label")).toBe("Account menu");
    expect(trigger().querySelector('[data-icon="user"]')).not.toBeNull();
    expect(summary()?.textContent).toBe("Your account couldn’t be checked. Check your connection and try again.");
    expect(rowLabels()).toEqual(["Check account", "Sign in"]);
    expect(row("Check account")!.tagName).toBe("BUTTON");
    expect(row("Check account")!.hasAttribute("aria-disabled")).toBe(false);
    expect(row("Sign in")!.getAttribute("href")).toBe("/sign-in");
    expect(row("Activity")).toBeNull();
    expect(host.querySelector('header a[href="/sign-up"]')).toBeNull();
    expect(host.textContent).not.toContain("Private");

    const retry = deferred<Response>();
    sessionRead = () => retry.promise;
    await act(async () => {
      row("Check account")!.click();
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(calls("/api/session")).toHaveLength(2);
    // Choosing the row closes the menu; reopened while checking, it offers nothing to repeat.
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
    await openMenu();
    expect(row("Check account")).toBeNull();
    expect(summary()?.textContent).toBe("Checking your account…");
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    await act(async () => retry.resolve(Response.json({ user: { id: owner } })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(trigger().textContent).toBe("PA");
    expect(rowLabels()).toEqual(["Settings", "Plans", "Activity", "Sign out"]);
    expect(summary()?.textContent).toContain(emailOf(owner));
  });

  it.each([
    ["a signed-out answer", () => Response.json({ authenticated: false })],
    ["a 401", () => new Response(null, { status: 401 })],
  ])("swaps the account menu for Sign in and Create account after %s", async (_, response) => {
    const initial = deferred<Response>();
    sessionRead = () => initial.promise;
    await render();
    expect(trigger()).not.toBeNull();
    expect(host.querySelector('header a[href="/sign-in"]')).toBeNull();
    await act(async () => initial.resolve(response()));
    expect(host.querySelector("[data-account-menu-trigger]")).toBeNull();
    const signIn = host.querySelector<HTMLAnchorElement>('header a[href="/sign-in"]')!;
    const signUp = host.querySelector<HTMLAnchorElement>('header a[href="/sign-up"]')!;
    expect(signIn.textContent).toBe("Sign in");
    expect(signIn.classList).toContain("e-nav__item");
    expect(signUp.textContent).toBe("Create account");
    expect(signUp.classList).toContain("e-button");
    expect(host.textContent).not.toContain("Private");
    expect(calls("/api/session")).toHaveLength(1);
    expect(calls("/api/billing")).toHaveLength(0);
  });

  it("opens Activity in its own dialog outside the menu, which owns Escape and returns focus to the menu button", async () => {
    await render();
    await openMenu();
    await act(async () => row("Activity")!.click());
    // Choosing Activity closes the menu; the dialog is not part of it.
    expect(isOpen()).toBe(false);
    const dialog = activityDialog()!;
    expect(dialog.open).toBe(true);
    expect(menu().contains(dialog)).toBe(false);
    expect(dialog.textContent).toContain(`Private activity for ${owner}`);
    const close = dialog.querySelector<HTMLButtonElement>("header button")!;
    close.focus();
    const escape = await press("Escape");
    // The menu does not take the dialog's Escape or its focus.
    expect(escape.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(close);
    expect(isOpen()).toBe(false);
    await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(activityDialog()).toBeNull();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("removes private identity and activity on recheck, ignores old activity and reveals only the verified new owner", async () => {
    await render();
    await openMenu();
    expect(summary()?.textContent).toContain(emailOf(owner));
    expect(summary()?.textContent).toContain("112 credits left this month");
    const oldActivity = deferred<Response>();
    jobsRead = () => oldActivity.promise;
    await act(async () => row("Activity")!.click());
    expect(activityDialog()).not.toBeNull();
    const recheck = deferred<Response>();
    sessionRead = () => recheck.promise;
    await act(async () => account.refresh());
    expect(host.textContent).not.toContain("Private");
    expect(activityDialog()).toBeNull();
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(trigger().getAttribute("aria-label")).toBe("Account menu, checking your account");
    expect(trigger().textContent).toBe("");
    await openMenu();
    expect(summary()?.textContent).toBe("Checking your account…");
    expect(rows()).toHaveLength(0);
    expect(host.textContent).not.toContain(emailOf(owner));
    expect(host.textContent).not.toContain("credits left");

    currentOwner = other;
    await act(async () => recheck.resolve(Response.json({ user: { id: other } })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(trigger().textContent).toBe("PC");
    expect(summary()?.textContent).toContain(emailOf(other));
    expect(summary()?.textContent).toContain("40 credits left this month");
    expect(host.textContent).not.toContain(emailOf(owner));
    expect(host.textContent).not.toContain("112 credits");
    expect(calls("/api/billing")).toHaveLength(2);
    jobsRead = async () => activity(other, "Current owner activity");
    await act(async () => row("Activity")!.click());
    await act(async () => oldActivity.resolve(activity(owner, "Old owner activity")));
    expect(host.textContent).toContain("Current owner activity");
    expect(host.textContent).not.toContain(owner);
    expect(host.textContent).not.toContain("Old owner activity");
    expect(account.session).toMatchObject({ status: "ready", userId: other });
  });
});
