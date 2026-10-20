// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ErrorBoundaryHandler } from "next/dist/client/components/error-boundary";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RouteError from "@/app/error";
import ProjectError from "@/app/brands/account/[projectId]/error";
import GlobalError from "@/app/global-error";
import { AppShell } from "@/components/workspace/app-shell";
import { useAccountSession } from "@/components/workspace/account-session";
import { accountProjectSchema } from "@/domain/project-api";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";

vi.mock("next/navigation", () => ({ usePathname: () => "/brands", useSelectedLayoutSegment: () => null, useSelectedLayoutSegments: () => ["brands"] }));
vi.mock("@/components/naming/use-names-store", () => ({ useNamesStore: () => ({ data: { ui: { tab: "assistant" } } }) }));
vi.mock("@/components/workspace/generation-activity", () => ({ GenerationActivity: () => null }));
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const project = accountProjectSchema.parse({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", owner_id: owner, scope: "naming_only", title: "Fixture", current_revision: 1, created_at: "2026-10-20T00:00:00Z", context: {} });
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("recoverable rendering errors", () => {
  it("announces a safe fallback, focuses its heading and retries only on user action", async () => {
    const retry = vi.fn();
    await act(async () => root.render(<RouteError error={new Error("secret token and private records")} retry={retry} />));
    expect(host.querySelector('[role="alert"]')?.getAttribute("aria-labelledby")).toBe("route-error-title");
    expect(document.activeElement).toBe(host.querySelector("h1"));
    expect(host.textContent).not.toContain("secret token");
    expect(host.textContent).toContain("Recent changes may not have saved");
    expect(retry).not.toHaveBeenCalled();
    const button = host.querySelector("button")!;
    button.focus(); expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    expect(retry).toHaveBeenCalledTimes(1);
    const home = host.querySelector("a")!;
    home.focus(); expect(document.activeElement).toBe(home);
    expect(home.getAttribute("href")).toBe("/");
    expect(ProjectError).toBe(RouteError);
  });

  it("survives an actual Next child boundary failure without remounting the account or losing another project's draft", async () => {
    const fetcher = vi.fn(async (path: string) => path === "/api/session" ? Response.json({ user: { id: owner } }) : new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    // React reports caught test exceptions; the fallback must not log/display them itself.
    vi.spyOn(console, "error").mockImplementation(() => {});
    let account!: ReturnType<typeof useAccountSession>;
    function Probe() { const value = useAccountSession(); useLayoutEffect(() => { account = value; }); return null; }
    let throws = false;
    function Page() { if (throws) throw new Error("Private fixture render failure"); return <p>Working page</p>; }
    const refresh = vi.fn();
    const router = { refresh } as unknown as AppRouterInstance;
    const render = () => root.render(<AppRouterContext.Provider value={router}><AppShell auth={null}><Probe /><ErrorBoundaryHandler pathname="/brands" errorComponent={RouteError}><Page /></ErrorBoundaryHandler></AppShell></AppRouterContext.Provider>);
    await act(async () => render());
    // Session/profile hydration can finish after the first act. Settle initial
    // reads before measuring requests caused by error recovery.
    for (let attempt = 0; attempt < 100 && !fetcher.mock.calls.some(([path]) => path === "/api/account/profile"); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    expect(account.session.status).toBe("ready");
    expect(fetcher.mock.calls.some(([path]) => path === "/api/account/profile")).toBe(true);
    const drafts = account.drafts;
    const draft = { ...accountProjectDraft(project), namingNotes: "Unacknowledged edit in another project" };
    drafts.set({ generation: account.session.generation, ownerId: owner, saved: project, draft, conflict: false });
    const sidebar = host.querySelector("aside");
    const requests = fetcher.mock.calls.length;
    throws = true; await act(async () => render());
    expect(host.textContent).toContain("This page couldn’t load");
    expect(host.textContent).not.toContain("Private fixture render failure");
    expect(host.querySelector("aside")).toBe(sidebar);
    expect(account.drafts).toBe(drafts);
    expect(drafts.get(project.id)?.draft).toBe(draft);
    expect(refresh).not.toHaveBeenCalled();
    // A persistent failure stays recoverable; it never spins or retries itself.
    await act(async () => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("This page couldn’t load");
    throws = false;
    await act(async () => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(host.textContent).toContain("Working page");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(host.querySelector("aside")).toBe(sidebar);
    expect(account.drafts).toBe(drafts);
    expect(drafts.get(project.id)?.draft).toBe(draft);
    expect(fetcher.mock.calls).toHaveLength(requests);
  });

  it.each(["401: Sign in to continue", "404: Project not found", "503: Could not save. Retry save."])("leaves handled API state to the page: %s", async state => {
    await act(async () => root.render(<ErrorBoundaryHandler pathname="/brands" errorComponent={RouteError}><p>{state}</p></ErrorBoundaryHandler>));
    expect(host.textContent).toBe(state);
    expect(host.querySelector("#route-error-title")).toBeNull();
  });

  it("provides a standalone global document with no private error details or provider dependencies", async () => {
    const retry = vi.fn();
    const error = Object.assign(new Error("private message"), { digest: "private digest", stack: "private stack" });
    const markup = renderToStaticMarkup(<GlobalError error={error} retry={retry} />);
    expect(markup).toContain('<html lang="en">');
    expect(markup).toContain("<body style=");
    expect(markup).toContain("Unable to load · Embel");
    expect(markup).not.toContain("private");
    expect(markup).toContain("may lose unsaved changes");
    expect(retry).not.toHaveBeenCalled();
    const frame = document.createElement("iframe"); document.body.append(frame);
    const doc = frame.contentDocument!;
    const documentRoot = createRoot(doc);
    try {
      await act(async () => documentRoot.render(<GlobalError error={error} retry={retry} />));
      expect(doc.activeElement).toBe(doc.querySelector("h1"));
      expect(doc.querySelector('[role="alert"]')).not.toBeNull();
      await act(async () => doc.querySelector("button")!.click());
      expect(retry).toHaveBeenCalledTimes(1);
      expect(doc.querySelector("a")?.getAttribute("href")).toBe("/");
    } finally { await act(async () => documentRoot.unmount()); frame.remove(); }
  });
});
