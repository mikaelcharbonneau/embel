// @vitest-environment jsdom
import { act, createElement, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectForm } from "@/components/workspace/project-editor";
import { clearLocalDrafts } from "@/components/workspace/local-drafts";
import { createHomeInputSession, type HomeInputSession } from "@/features/home-inputs/home-input-session";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import HomePage from "@/app/page";
import NewProjectPage from "@/app/brands/new/page";
import NewLogoPage from "@/app/brands/logo/new/page";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mock = vi.hoisted(() => ({
  account: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as VerifiedAccount,
  memory: null as HomeInputSession | null,
  current: vi.fn(),
  expire: vi.fn(),
  navigate: vi.fn(),
  redirect: vi.fn((href: string) => {
    throw new Error(`redirect:${href}`);
  }),
  strategy: {
    pending: false,
    locked: false,
    checkingRecovery: false,
    recoveryBlocked: false,
    starting: false,
    notice: "Save your project when ready.",
    save: vi.fn(),
    start: vi.fn(),
    detachPrompt: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.navigate }), redirect: mock.redirect }));
vi.mock("@/components/workspace/home-workspace", () => ({ HomeWorkspace: () => null }));
vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => {
    void prefetch;
    const anchorProps: AnchorHTMLAttributes<HTMLAnchorElement> = {
      ...props,
      onClick: (event) => {
        props.onClick?.(event);
        if (!event.defaultPrevented) mock.navigate(props.href);
        event.preventDefault();
      },
    };
    return createElement("a", anchorProps);
  },
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({
    session: mock.account,
    homeInputSession: mock.memory,
    isCurrent: mock.current,
    expire: mock.expire,
  }),
}));
vi.mock("@/components/workspace/account-strategy-start", () => ({ useAccountStrategyStart: () => mock.strategy }));
let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>;
const render = (home = false) => act(async () => root.render(createElement(NewProjectForm, { home })));
const logoLink = () => host.querySelector<HTMLAnchorElement>('a[href="/brands/logo/new"]');
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollTo = vi.fn();
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearLocalDrafts();
  mock.account = { status: "ready", userId: owner, generation: 1 };
  mock.memory = createHomeInputSession();
  mock.memory.bind(mock.account);
  mock.current
    .mockReset()
    .mockImplementation(
      (account: VerifiedAccount) =>
        account.userId === mock.account.userId && account.generation === mock.account.generation,
    );
  mock.navigate.mockReset();
  mock.expire.mockReset();
  mock.redirect.mockClear();
  mock.strategy.pending = false;
  mock.strategy.locked = false;
  mock.strategy.save.mockReset();
  mock.strategy.start.mockReset();
  mock.strategy.detachPrompt.mockReset();
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path.endsWith("/capability") && init.method === "GET")
      return Response.json({ ownerId: owner, policy: null, reason: "Synthetic unavailable storage" });
    throw new Error(`Unexpected fixture request ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

// Home starts every project, and every project is a complete brand. The older
// New project and logo routes lead to Home; nothing is created on the way.
describe("new project entry", () => {
  it("sends /brands/new to Home", () => {
    expect(() => NewProjectPage()).toThrow("redirect:/");
    expect(mock.redirect).toHaveBeenCalledExactlyOnceWith("/");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the old logo workflow to Home", () => {
    expect(() => NewLogoPage()).toThrow("redirect:/");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("renders Home without a project type choice", () => {
    expect(HomePage().props).toEqual({});
  });

  it.each([false, true])("offers no project type choice or separate logo route (home: %s)", async (home) => {
    await render(home);
    expect(logoLink()).toBeNull();
    expect(host.textContent).not.toContain("Create a logo");
    expect(host.querySelector(".home-scope")).toBeNull();
    expect(host.textContent).not.toContain("Name only");
    expect(host.textContent).not.toContain("Visual identity");
    expect(mock.navigate).not.toHaveBeenCalled();
    expect(mock.strategy.save).not.toHaveBeenCalled();
    expect(mock.strategy.start).not.toHaveBeenCalled();
  });
});
