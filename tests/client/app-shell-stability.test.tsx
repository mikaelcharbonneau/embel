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
const navLinks = () => [...host.querySelectorAll<HTMLAnchorElement>("aside.sidebar .nav-link")];

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
  it("keeps navigation links, icons, logo, toggle, expanded state and focus across route changes", async () => {
    await render(); await until(() => expect(accountLabel().textContent).toBe("Private fixture name"));
    const links = navLinks(), icons = links.map(link => link.querySelector("svg"));
    const logo = host.querySelector("aside.sidebar .app-mark img");
    const toggle = host.querySelector<HTMLButtonElement>(".workspace-sidebar-toggle")!;
    const toggleIcon = toggle.querySelector("svg"), generation = account.session.generation;
    expect(icons.every(Boolean)).toBe(true);
    await act(async () => toggle.click());
    links[1]!.focus();
    const routes = ["/brands", "/assets", "/ideas", "/names", "/handles", "/domains", "/trademarks", "/settings", "/brands/new", "/brands/account/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "/sign-in", "/sign-up", "/"];
    for (const pathname of routes) {
      route.pathname = pathname; await render();
      const currentLinks = navLinks();
      currentLinks.forEach((link, index) => {
        expect(link).toBe(links[index]); expect(link.querySelector("svg")).toBe(icons[index]);
        expect(link.querySelector("img")).toBeNull();
        const href = link.getAttribute("href")!;
        expect(link.getAttribute("aria-current")).toBe((href === "/" ? pathname === "/" : pathname.startsWith(href)) ? "page" : null);
      });
      expect(host.querySelector("aside.sidebar .app-mark img")).toBe(logo);
      expect(host.querySelector(".workspace-sidebar-toggle")).toBe(toggle);
      expect(toggle.querySelector("svg")).toBe(toggleIcon);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(links[1]);
      expect(account.session.generation).toBe(generation);
    }
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/session")).toHaveLength(1);
  });

  it("does not swap navigation artwork when project contents become empty or an auth dialog opens", async () => {
    route.pathname = "/brands"; await render(<div className="projects-page">Loading projects</div>);
    const links = navLinks(), icons = links.map(link => link.querySelector("svg"));
    await render(<div className="projects-page projects-empty">No projects</div>);
    route.pathname = "/sign-in"; route.auth = "(.)sign-in"; route.background = ["brands"];
    await render(<div className="projects-page projects-empty">No projects</div>);
    navLinks().forEach((link, index) => { expect(link).toBe(links[index]); expect(link.querySelector("svg")).toBe(icons[index]); });
    expect(links[1]!.getAttribute("aria-current")).toBe("page");
    expect(host.querySelector("aside.sidebar img")?.getAttribute("src")).toBe("/embel-mark.svg");
  });

  it("shows a neutral checking placeholder, not signed-out controls or a stale private identity", async () => {
    const initial = deferred<Response>(); sessionRead = () => initial.promise;
    await render();
    const label = accountLabel();
    expect(label.getAttribute("aria-busy")).toBe("true");
    expect(label.querySelector(".workspace-account-placeholder")).not.toBeNull();
    expect(host.textContent).not.toContain("Sign in");
    expect(host.textContent).not.toContain("Private fixture");
    expect(host.querySelector('.topbar a[href="/sign-in"]')).toBeNull();
    await act(async () => initial.resolve(Response.json({ user: { id: owner } })));
    await until(() => expect(label.textContent).toBe("Private fixture name"));
    expect(accountLabel()).toBe(label);

    const recheck = deferred<Response>(); sessionRead = () => recheck.promise;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(accountLabel()).toBe(label); expect(label.getAttribute("aria-busy")).toBe("true");
    expect(host.textContent).not.toContain("Private fixture");
    expect(host.textContent).not.toContain("Sign in");
    expect(host.querySelector('.topbar a[href="/sign-in"]')).toBeNull();
    await act(async () => recheck.resolve(new Response(null, { status: 401 })));
    await until(() => expect(label.textContent).toBe("Sign in"));
    expect(accountLabel()).toBe(label); expect(label.getAttribute("aria-busy")).toBe("false");
    expect(host.textContent).not.toContain("Private fixture");
    expect(host.querySelector('.topbar a[href="/sign-in"]')).not.toBeNull();
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
