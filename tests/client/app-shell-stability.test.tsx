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
vi.mock("@/components/naming/use-names-store", () => ({ useNamesStore: () => ({ data: { ui: { tab: "assistant" } } }) }));
vi.mock("@/components/workspace/generation-activity", () => ({ GenerationActivity: () => null }));

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let host: HTMLDivElement, root: Root, account: ReturnType<typeof useAccountSession>;
let sessionRead: () => Promise<Response>, profileRead: (() => Promise<Response>) | null, fetcher: ReturnType<typeof vi.fn>;
function Probe() {
  const value = useAccountSession();
  useLayoutEffect(() => { account = value; });
  return value.session.status === "ready" ? <p>Private fixture content</p> : null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function render(children: ReactNode = null) {
  await act(async () => root.render(<AppShell auth={null}><Probe />{children}</AppShell>));
}
async function until(assertion: () => void) {
  let error: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    try { assertion(); return; } catch (cause) { error = cause; }
  }
  throw error;
}
const accountLabel = () => host.querySelector<HTMLSpanElement>(".workspace-account-label")!;
const mainNav = () => host.querySelector<HTMLElement>('nav[aria-label="Main navigation"]')!;
const navLinks = () => [...mainNav().querySelectorAll<HTMLAnchorElement>(":scope > ul > li > a")];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.assign(route, { pathname: "/", auth: null, background: [] });
  profileRead = null;
  sessionRead = async () => Response.json({ user: { id: owner } });
  fetcher = vi.fn(async (path: string) => {
    if (path === "/api/session") return sessionRead();
    if (path === "/api/account/profile") return profileRead ? profileRead() : Response.json({ profile: {
      ownerId: owner, email: "fixture@example.invalid", revision: 1, updatedAt: "2026-10-20T00:00:00Z",
      values: { ...DEFAULT_PROFILE_VALUES, fullName: "Private fixture name" },
    } });
    throw new Error(`Unexpected fixture request ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren(); vi.unstubAllGlobals();
});

describe("persistent workspace shell", () => {
  it("keeps the floating navigation, logo and focus across route changes", async () => {
    await render(); await until(() => expect(accountLabel().textContent).toBe("Private fixture name"));
    const links = navLinks();
    const logo = mainNav().querySelector("img"), generation = account.session.generation;
    expect(links.map(link => link.textContent)).toEqual(["Home", "Projects", "Library"]);
    expect(mainNav().querySelector("details")).toBeNull();
    links[1]!.focus();
    const routes = ["/brands", "/assets", "/settings", "/sign-in", "/sign-up", "/"];
    for (const pathname of routes) {
      route.pathname = pathname; await render();
      navLinks().forEach((link, index) => {
        expect(link).toBe(links[index]);
        const href = link.getAttribute("href")!;
        expect(link.getAttribute("aria-current")).toBe((href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`)) ? "page" : null);
      });
      expect(mainNav().querySelector("img")).toBe(logo);
      expect(document.activeElement).toBe(links[1]);
      expect(account.session.generation).toBe(generation);
    }
    expect(host.querySelector('aside, .mobile-menu, [aria-label="Open navigation"]')).toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/session")).toHaveLength(1);
  });

  it("becomes the project bar inside a project and keeps the same account menu", async () => {
    await render(); await until(() => expect(accountLabel().textContent).toBe("Private fixture name"));
    const accountMenu = host.querySelector(".workspace-account-menu"), frame = host.querySelector("header");
    route.pathname = "/brands/account/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; await render();
    expect(host.querySelector('nav[aria-label="Main navigation"]')).toBeNull();
    expect(host.querySelector("header")?.textContent).toContain("Loading project…");
    expect(host.querySelector(".workspace-account-menu")).toBe(accountMenu);
    expect(host.querySelector("header")).toBe(frame);
    route.pathname = "/"; await render();
    expect(mainNav()).not.toBeNull();
    expect(host.querySelector(".workspace-account-menu")).toBe(accountMenu);
  });

  it("keeps the underlying page highlighted when an auth dialog opens over it", async () => {
    route.pathname = "/brands"; await render(<div className="projects-page">Loading projects</div>);
    const links = navLinks();
    route.pathname = "/sign-in"; route.auth = "(.)sign-in"; route.background = ["brands"];
    await render(<div className="projects-page projects-empty">No projects</div>);
    navLinks().forEach((link, index) => expect(link).toBe(links[index]));
    expect(links[1]!.getAttribute("aria-current")).toBe("page");
    expect(mainNav().querySelector("img")?.getAttribute("src")).toBe("/embel-mark.svg");
  });

  it("dismisses the account menu on an outside pointer without stealing the clicked control's focus or action", async () => {
    const clicked = vi.fn();
    await render(<button type="button" data-outside onClick={clicked}>Outside control</button>);
    await until(() => expect(account.session.status).toBe("ready"));
    const menu = host.querySelector<HTMLDetailsElement>(".workspace-account-menu")!;
    const summary = menu.querySelector("summary")!, outside = host.querySelector<HTMLButtonElement>("[data-outside]")!;
    const generation = account.session.generation;
    await act(async () => summary.click());
    expect(menu.open).toBe(true);
    await act(async () => {
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      outside.focus(); outside.click();
    });
    expect(menu.open).toBe(false); expect(document.activeElement).toBe(outside); expect(clicked).toHaveBeenCalledOnce();
    expect(account.session.generation).toBe(generation);
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/session")).toHaveLength(1);
  });

  it("dismisses the account menu on Escape even after keyboard focus has left the details subtree", async () => {
    await render(<button type="button" data-outside>Outside control</button>);
    const menu = host.querySelector<HTMLDetailsElement>(".workspace-account-menu")!;
    const summary = menu.querySelector("summary")!, outside = host.querySelector<HTMLButtonElement>("[data-outside]")!;
    await act(async () => summary.click());
    outside.focus();
    await act(async () => outside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(menu.open).toBe(false); expect(document.activeElement).toBe(summary);
  });

  it.each([false, true])("dismisses the account menu on actual navigation without remounting it (intercepted: %s)", async intercepted => {
    await render();
    const menu = host.querySelector<HTMLDetailsElement>(".workspace-account-menu")!;
    await act(async () => menu.querySelector("summary")!.click());
    route.pathname = intercepted ? "/sign-in" : "/assets";
    if (intercepted) { route.auth = "(.)sign-in"; route.background = []; }
    await render();
    expect(host.querySelector(".workspace-account-menu")).toBe(menu); expect(menu.open).toBe(false);
  });

  it("leaves inside interactions and open nested dialogs in control of their own dismissal", async () => {
    await render(<button type="button" data-outside>Outside control</button>);
    const menu = host.querySelector<HTMLDetailsElement>(".workspace-account-menu")!;
    const summary = menu.querySelector("summary")!;
    await act(async () => summary.click());
    await act(async () => menu.querySelector(".workspace-account-panel")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(menu.open).toBe(true);
    const modal = document.createElement("dialog"), control = document.createElement("button");
    modal.open = true; modal.append(control); menu.append(modal); control.focus();
    await act(async () => control.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(menu.open).toBe(true); expect(modal.open).toBe(true); expect(document.activeElement).toBe(control);
    await act(async () => host.querySelector("[data-outside]")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(menu.open).toBe(true);
    modal.remove();
    await act(async () => summary.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(menu.open).toBe(false); expect(document.activeElement).toBe(summary);
  });

  it("shows a neutral checking placeholder, not signed-out controls or a stale private identity", async () => {
    const initial = deferred<Response>(); sessionRead = () => initial.promise;
    await render();
    const label = accountLabel();
    expect(label.getAttribute("aria-busy")).toBe("true");
    expect(label.textContent).toBe("Checking account…");
    expect(host.textContent).not.toContain("Sign in");
    expect(host.textContent).not.toContain("Private fixture");
    expect(host.querySelector('header a[href="/sign-in"]')).toBeNull();
    await act(async () => initial.resolve(Response.json({ user: { id: owner } })));
    await until(() => expect(label.textContent).toBe("Private fixture name"));
    expect(accountLabel()).toBe(label);

    const recheck = deferred<Response>(); sessionRead = () => recheck.promise;
    // Explicit verification fences private content; ordinary tab focus deliberately does not.
    await act(async () => account.refresh());
    expect(accountLabel()).toBe(label); expect(label.getAttribute("aria-busy")).toBe("true");
    expect(host.textContent).not.toContain("Private fixture");
    expect(host.textContent).not.toContain("Sign in");
    expect(host.querySelector('header a[href="/sign-in"]')).toBeNull();
    await act(async () => recheck.resolve(Response.json({ authenticated: false })));
    // Signed out, the pill offers the two ways in instead of an account menu.
    await until(() => expect(host.querySelector('header a[href="/sign-in"]')?.textContent).toBe("Sign in"));
    expect(host.querySelector('header a[href="/sign-up"]')?.textContent).toBe("Create account");
    expect(host.querySelector(".workspace-account-menu")).toBeNull();
    expect(host.textContent).not.toContain("Private fixture");
    // Every shell check asks for the ordinary signed-out answer.
    const sessionCalls = fetcher.mock.calls.filter(([path]) => path === "/api/session");
    expect(sessionCalls).toHaveLength(2);
    for (const [, init] of sessionCalls) expect((init as RequestInit).headers).toMatchObject({ "X-Embel-Session-State": "1" });
  });

  it("shows the owner's initials, name and email, falling back to the email's first letter", async () => {
    await render(); await until(() => expect(accountLabel().textContent).toBe("Private fixture name"));
    expect(host.querySelector(".workspace-account-avatar")?.textContent).toBe("PN");
    expect(host.querySelector(".workspace-account-identity strong")?.textContent).toBe("Private fixture name");
    expect(host.querySelector(".workspace-account-identity span")?.textContent).toBe("fixture@example.invalid");
    await act(async () => root.unmount()); root = createRoot(host);
    profileRead = async () => Response.json({ profile: {
      ownerId: owner, email: "fixture@example.invalid", revision: 1, updatedAt: "2026-10-20T00:00:00Z", values: { ...DEFAULT_PROFILE_VALUES, fullName: "" },
    } });
    await render(); await until(() => expect(accountLabel().textContent).toBe("fixture@example.invalid"));
    expect(host.querySelector(".workspace-account-avatar")?.textContent).toBe("F");
    expect(host.querySelector(".workspace-account-identity strong")?.textContent).toBe("fixture@example.invalid");
    expect(host.querySelector(".workspace-account-identity span")).toBeNull();
    expect(host.querySelector(".workspace-account-panel")?.textContent).not.toMatch(/Refresh connection|Check account/);
  });

  it("keeps the same neutral label while the first verified profile loads", async () => {
    const profile = deferred<Response>(); profileRead = () => profile.promise;
    await render(); await until(() => expect(account.session.status).toBe("ready"));
    const label = accountLabel();
    expect(label.getAttribute("aria-busy")).toBe("true");
    expect(label.textContent).toBe("Checking account…");
    expect(label.textContent).not.toContain("My account");
    await act(async () => profile.resolve(new Response(null, { status: 503 })));
    await until(() => expect(label.textContent).toBe("My account"));
    expect(accountLabel()).toBe(label); expect(label.getAttribute("aria-busy")).toBe("false");
  });

  it.each([500, 503])("does not call an unavailable account signed out after a %s verification failure", async status => {
    sessionRead = async () => new Response(null, { status });
    await render(); await until(() => expect(accountLabel().textContent).toBe("Account"));
    expect(accountLabel().getAttribute("aria-busy")).toBe("false");
    expect(host.textContent).not.toContain("Private fixture");
  });
});

it("reaches every destination from the pill without a separate mobile menu or Tools menu", async () => {
  await render(); await until(() => expect(accountLabel().textContent).toBe("Private fixture name"));
  expect(host.querySelector(".workspace-account-avatar")?.textContent).toBe("PN");
  expect(navLinks().map(link => link.getAttribute("href"))).toEqual(["/", "/brands", "/assets"]);
  expect(mainNav().querySelector("details")).toBeNull();
  expect(fetcher.mock.calls.filter(([path]) => path === "/api/session")).toHaveLength(1);
});

