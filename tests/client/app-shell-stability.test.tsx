// @vitest-environment jsdom
import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/workspace/app-shell";
import { useAccountSession } from "@/components/workspace/account-session";
import { DEFAULT_PROFILE_VALUES } from "@/domain/account-profile";

const route = vi.hoisted(() => ({ pathname: "/", auth: null as string | null, background: [] as string[] }));
vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useSelectedLayoutSegment: () => route.auth,
  useSelectedLayoutSegments: () => route.background,
}));
vi.mock("@/components/naming/use-names-store", () => ({
  useNamesStore: () => ({ data: { ui: { tab: "assistant" } } }),
}));
vi.mock("@/components/workspace/generation-activity", () => ({ ActivityDialog: () => null }));

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let host: HTMLDivElement, root: Root, account: ReturnType<typeof useAccountSession>;
let sessionRead: () => Promise<Response>,
  profileRead: (() => Promise<Response>) | null,
  fetcher: ReturnType<typeof vi.fn>;
function Probe() {
  const value = useAccountSession();
  useLayoutEffect(() => {
    account = value;
  });
  return value.session.status === "ready" ? <p>Private fixture content</p> : null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function render(children: ReactNode = null) {
  await act(async () =>
    root.render(
      <AppShell auth={null}>
        <Probe />
        {children}
      </AppShell>,
    ),
  );
}
async function until(assertion: () => void) {
  let error: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    try {
      assertion();
      return;
    } catch (cause) {
      error = cause;
    }
  }
  throw error;
}
const trigger = () => host.querySelector<HTMLButtonElement>("[data-account-menu-trigger]")!;
const menu = () => document.getElementById(trigger().getAttribute("aria-controls")!)!;
const isOpen = () => trigger().getAttribute("aria-expanded") === "true";
const rows = () => [...menu().querySelectorAll<HTMLElement>('[role="menuitem"]')];
const summary = () => menu().querySelector<HTMLElement>(".e-menu__summary");
const mainNav = () => host.querySelector<HTMLElement>('nav[aria-label="Main navigation"]')!;
const navLinks = () => [...mainNav().querySelectorAll<HTMLAnchorElement>(":scope > ul > li > a")];
const brandMark = () => mainNav().querySelector<HTMLElement>(".e-nav__brand .e-mark");
const sessionCalls = () => fetcher.mock.calls.filter(([path]) => path === "/api/session");
async function openMenu() {
  if (!isOpen()) await act(async () => trigger().click());
  expect(isOpen()).toBe(true);
}
async function press(target: Element, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  return event;
}
async function pointerDown(target: Element) {
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.assign(route, { pathname: "/", auth: null, background: [] });
  profileRead = null;
  sessionRead = async () => Response.json({ user: { id: owner } });
  fetcher = vi.fn(async (path: string) => {
    if (path === "/api/session") return sessionRead();
    if (path === "/api/billing")
      return Response.json({
        billing: { planId: "pro", balance: 112, periodEnd: "2026-12-01T00:00:00Z", subscription: null, plans: [] },
      });
    if (path === "/api/account/profile")
      return profileRead
        ? profileRead()
        : Response.json({
            profile: {
              ownerId: owner,
              email: "fixture@example.invalid",
              revision: 1,
              updatedAt: "2026-10-20T00:00:00Z",
              values: { ...DEFAULT_PROFILE_VALUES, fullName: "Private fixture name" },
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
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("persistent workspace shell", () => {
  it("keeps the floating navigation, mark and focus across route changes", async () => {
    await render();
    await until(() => expect(trigger().textContent).toBe("PN"));
    const links = navLinks();
    const mark = brandMark(),
      generation = account.session.generation;
    expect(host.querySelector("header .e-nav")).not.toBeNull();
    expect(links.map((link) => link.textContent)).toEqual(["Home", "Projects", "Library"]);
    links.forEach((link) => expect(link.classList).toContain("e-nav__item"));
    // The mark is a CSS mask, not an image.
    expect(mark).not.toBeNull();
    expect(mark!.getAttribute("aria-hidden")).toBe("true");
    expect(mainNav().querySelector("img")).toBeNull();
    expect(mainNav().querySelector("details")).toBeNull();
    links[1]!.focus();
    const routes = ["/brands", "/assets", "/settings", "/sign-in", "/sign-up", "/"];
    for (const pathname of routes) {
      route.pathname = pathname;
      await render();
      navLinks().forEach((link, index) => {
        expect(link).toBe(links[index]);
        const href = link.getAttribute("href")!;
        expect(link.getAttribute("aria-current")).toBe(
          (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`)) ? "page" : null,
        );
      });
      expect(brandMark()).toBe(mark);
      expect(document.activeElement).toBe(links[1]);
      expect(account.session.generation).toBe(generation);
    }
    expect(host.querySelector('aside, .mobile-menu, [aria-label="Open navigation"]')).toBeNull();
    expect(sessionCalls()).toHaveLength(1);
  });

  it("becomes the project bar inside a project and keeps the same account menu", async () => {
    await render();
    await until(() => expect(trigger().textContent).toBe("PN"));
    const button = trigger(),
      panel = menu(),
      frame = host.querySelector("header");
    route.pathname = "/brands/account/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await render();
    expect(host.querySelector('nav[aria-label="Main navigation"]')).toBeNull();
    expect(host.querySelector("header")?.textContent).toContain("Loading project…");
    expect(trigger()).toBe(button);
    expect(menu()).toBe(panel);
    expect(host.querySelector("header")).toBe(frame);
    route.pathname = "/";
    await render();
    expect(mainNav()).not.toBeNull();
    expect(trigger()).toBe(button);
    expect(menu()).toBe(panel);
  });

  it("keeps the underlying page highlighted when an auth dialog opens over it", async () => {
    route.pathname = "/brands";
    await render(<div className="projects-page">Loading projects</div>);
    const links = navLinks(),
      mark = brandMark();
    route.pathname = "/sign-in";
    route.auth = "(.)sign-in";
    route.background = ["brands"];
    await render(<div className="projects-page projects-empty">No projects</div>);
    navLinks().forEach((link, index) => expect(link).toBe(links[index]));
    expect(links[1]!.getAttribute("aria-current")).toBe("page");
    expect(brandMark()).toBe(mark);
    expect(mainNav().querySelector(".e-nav__brand")?.getAttribute("href")).toBe("/");
  });

  it("closes the account menu on an outside press without passing that press through, then lets presses through again", async () => {
    const pressed = vi.fn();
    await render(
      <button type="button" data-outside>
        Outside control
      </button>,
    );
    await until(() => expect(account.session.status).toBe("ready"));
    const outside = host.querySelector<HTMLButtonElement>("[data-outside]")!;
    outside.addEventListener("pointerdown", pressed);
    const generation = account.session.generation;
    await openMenu();
    const closing = await pointerDown(outside);
    expect(isOpen()).toBe(false);
    expect(menu().hidden).toBe(true);
    expect(closing.defaultPrevented).toBe(true);
    expect(pressed).not.toHaveBeenCalled();
    // The menu does not pull focus back to its button when closed by a press elsewhere.
    outside.focus();
    expect(document.activeElement).toBe(outside);
    // Once closed, the next press reaches the control as usual.
    const next = await pointerDown(outside);
    expect(next.defaultPrevented).toBe(false);
    expect(pressed).toHaveBeenCalledOnce();
    expect(account.session.generation).toBe(generation);
    expect(sessionCalls()).toHaveLength(1);
  });

  it("closes the account menu when keyboard focus leaves it, by Tab or by focus moving elsewhere", async () => {
    await render(
      <button type="button" data-outside>
        Outside control
      </button>,
    );
    await until(() => expect(trigger().textContent).toBe("PN"));
    const outside = host.querySelector<HTMLButtonElement>("[data-outside]")!;
    await openMenu();
    expect(document.activeElement).toBe(rows()[0]);
    await press(rows()[0]!, "Tab");
    expect(isOpen()).toBe(false);
    await openMenu();
    await act(async () => outside.focus());
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(outside);
    // Escape from inside returns focus to the menu button.
    await openMenu();
    await press(rows()[0]!, "Escape");
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it.each([false, true])(
    "dismisses the account menu on actual navigation without remounting it (intercepted: %s)",
    async (intercepted) => {
      await render();
      await until(() => expect(trigger().textContent).toBe("PN"));
      const button = trigger(),
        panel = menu();
      await openMenu();
      route.pathname = intercepted ? "/sign-in" : "/assets";
      if (intercepted) {
        route.auth = "(.)sign-in";
        route.background = [];
      }
      await render();
      expect(trigger()).toBe(button);
      expect(menu()).toBe(panel);
      expect(isOpen()).toBe(false);
      expect(rows()).toHaveLength(0);
    },
  );

  it("keeps the menu open for presses inside it and on its button, which toggles it closed", async () => {
    await render(
      <button type="button" data-outside>
        Outside control
      </button>,
    );
    await until(() => expect(trigger().textContent).toBe("PN"));
    await openMenu();
    for (const inside of [summary()!, rows()[1]!, trigger()]) {
      const event = await pointerDown(inside);
      expect(event.defaultPrevented).toBe(false);
      expect(isOpen()).toBe(true);
    }
    // An unrelated key inside the menu is left alone.
    const other = await press(rows()[0]!, "a");
    expect(other.defaultPrevented).toBe(false);
    expect(isOpen()).toBe(true);
    await act(async () => trigger().click());
    expect(isOpen()).toBe(false);
    expect(menu().hidden).toBe(true);
  });

  it("shows a neutral checking placeholder, not signed-out controls or a stale private identity", async () => {
    const initial = deferred<Response>();
    sessionRead = () => initial.promise;
    await render();
    const button = trigger();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Account menu, checking your account");
    expect(button.textContent).toBe("");
    await openMenu();
    expect(summary()?.textContent).toBe("Checking your account…");
    expect(rows()).toHaveLength(0);
    expect(host.textContent).not.toContain("Sign in");
    expect(host.textContent).not.toContain("Private fixture");
    expect(host.querySelector('header a[href="/sign-in"]')).toBeNull();
    await act(async () => initial.resolve(Response.json({ user: { id: owner } })));
    await until(() => expect(button.textContent).toBe("PN"));
    expect(trigger()).toBe(button);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Account menu");
    await until(() => expect(summary()?.textContent).toContain("fixture@example.invalid"));

    const recheck = deferred<Response>();
    sessionRead = () => recheck.promise;
    // Explicit verification fences private content; ordinary tab focus deliberately does not.
    await act(async () => account.refresh());
    expect(trigger()).toBe(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("");
    await openMenu();
    expect(summary()?.textContent).toBe("Checking your account…");
    expect(host.textContent).not.toContain("fixture@example.invalid");
    expect(host.textContent).not.toContain("Private fixture");
    expect(host.textContent).not.toContain("Sign in");
    expect(host.querySelector('header a[href="/sign-in"]')).toBeNull();
    await act(async () => recheck.resolve(Response.json({ authenticated: false })));
    // Signed out, the pill offers the two ways in instead of an account menu.
    await until(() => expect(host.querySelector('header a[href="/sign-in"]')?.textContent).toBe("Sign in"));
    expect(host.querySelector('header a[href="/sign-up"]')?.textContent).toBe("Create account");
    expect(host.querySelector("[data-account-menu-trigger]")).toBeNull();
    expect(host.textContent).not.toContain("Private fixture");
    expect(host.textContent).not.toContain("fixture@example.invalid");
    // Every shell check asks for the ordinary signed-out answer.
    expect(sessionCalls()).toHaveLength(2);
    for (const [, init] of sessionCalls())
      expect((init as RequestInit).headers).toMatchObject({ "X-Embel-Session-State": "1" });
  });

  it("shows the owner's initials and email with the plan, falling back to the email's first letter", async () => {
    await render();
    await until(() => expect(trigger().textContent).toBe("PN"));
    await openMenu();
    await until(() => expect(summary()?.textContent).toContain("112 credits left this month"));
    expect(summary()!.firstElementChild?.textContent).toBe("fixture@example.invalid");
    expect(summary()!.textContent).toContain("Pro");
    await act(async () => root.unmount());
    root = createRoot(host);
    profileRead = async () =>
      Response.json({
        profile: {
          ownerId: owner,
          email: "fixture@example.invalid",
          revision: 1,
          updatedAt: "2026-10-20T00:00:00Z",
          values: { ...DEFAULT_PROFILE_VALUES, fullName: "" },
        },
      });
    await render();
    await until(() => expect(trigger().textContent).toBe("F"));
    await openMenu();
    expect(summary()!.firstElementChild?.textContent).toBe("fixture@example.invalid");
    expect(menu().textContent).not.toMatch(/Refresh connection|Check account/);
  });

  it("keeps the same neutral button while the first verified profile loads", async () => {
    const profile = deferred<Response>();
    profileRead = () => profile.promise;
    await render();
    await until(() => expect(account.session.status).toBe("ready"));
    const button = trigger();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Account menu, checking your account");
    expect(button.textContent).toBe("");
    await openMenu();
    expect(summary()?.textContent).toBe("Checking your account…");
    expect(menu().textContent).not.toContain("fixture@example.invalid");
    // The session itself is verified, so its own account rows are already offered.
    expect(rows().map((row) => row.textContent)).toEqual(["Settings", "Plans", "Activity", "Sign out"]);
    await act(async () => profile.resolve(new Response(null, { status: 503 })));
    await until(() => expect(button.hasAttribute("aria-busy")).toBe(false));
    expect(trigger()).toBe(button);
    expect(button.getAttribute("aria-label")).toBe("Account menu");
    // No name or email to show: the generic account icon, never a guessed identity.
    expect(button.textContent).toBe("");
    expect(button.querySelector('[data-icon="user"]')).not.toBeNull();
    expect(rows().map((row) => row.textContent)).toEqual(["Settings", "Plans", "Activity", "Sign out"]);
  });

  it.each([500, 503])(
    "does not call an unavailable account signed out after a %s verification failure",
    async (status) => {
      sessionRead = async () => new Response(null, { status });
      await render();
      await until(() => expect(trigger().hasAttribute("aria-busy")).toBe(false));
      expect(trigger().getAttribute("aria-label")).toBe("Account menu");
      expect(host.querySelector('header a[href="/sign-up"]')).toBeNull();
      await openMenu();
      expect(summary()?.textContent).toContain("Your account couldn’t be checked.");
      expect(rows().map((row) => row.textContent)).toEqual(["Check account", "Sign in"]);
      expect(host.textContent).not.toContain("Private fixture");
    },
  );
});

it("reaches every destination from the pill without a separate mobile menu or Tools menu", async () => {
  await render();
  await until(() => expect(trigger().textContent).toBe("PN"));
  expect(navLinks().map((link) => link.getAttribute("href"))).toEqual(["/", "/brands", "/assets"]);
  expect(mainNav().querySelector("details")).toBeNull();
  await openMenu();
  expect(rows().map((row) => row.getAttribute("href"))).toEqual(["/settings", "/plans", null, null]);
  expect(sessionCalls()).toHaveLength(1);
});
