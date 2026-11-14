// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCard } from "@/components/workspace/project-card";
import { useProjectCardPreview } from "@/components/workspace/use-project-card-preview";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { LifecycleProject } from "@/components/workspace/project-deletion-client";
import { logoFixtureId as id } from "../fixtures/logo-creation";

// A card starts its private reads only once it is on screen. Those reads must start for every card on screen,
// whatever the order in which the page renders, and even when the browser holds back observer notifications
// (a page loaded in a background tab or hidden pane renders few or no frames).
const drafts = createAccountDraftMemory();
const mock = vi.hoisted(() => ({ session: null as VerifiedAccount | null, project: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({
    session: mock.session,
    drafts,
    isCurrent: (value: VerifiedAccount) =>
      mock.session?.userId === value.userId && mock.session.generation === value.generation,
    expire: vi.fn(),
  }),
}));
vi.mock("@/components/identity/account-logo-client", () => ({
  createAccountLogoClient: () => ({ dispose: vi.fn(), previewAsset: vi.fn() }),
}));
vi.mock("@/components/workspace/account-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/workspace/account-api")>()),
  accountRequest: (...args: unknown[]) => mock.project(...args),
}));

const account: VerifiedAccount = { status: "ready", userId: id(1), generation: 1 };
const project = (n: number): LifecycleProject => ({
  id: id(10 + n),
  owner_id: id(1),
  title: `Brand ${n}`,
  scope: "complete_brand",
  current_revision: 1,
  lifecycle_version: 0,
  created_at: "2026-10-20T00:00:00Z",
  deleted_at: null,
  deletion_requested_at: null,
  deletion_state: "active",
});
const reads = () => mock.project.mock.calls.map(([path]) => String(path));

/** An observer whose notifications the test delivers (or withholds), like a browser that is not rendering. */
let observers: { callback: IntersectionObserverCallback; targets: Element[]; disconnected: boolean }[];
function notify(target: Element) {
  for (const observer of observers)
    if (!observer.disconnected && observer.targets.includes(target))
      observer.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        {} as unknown as IntersectionObserver,
      );
}
/** Lays out cards like a grid: the box comes from the card's `data-top`, and a `hidden` card has no box. */
function layout() {
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    const shown = this.isConnected && !this.closest("[hidden]");
    return (shown ? [{}] : []) as unknown as DOMRectList;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const top = Number((this as HTMLElement).dataset.top ?? 0);
    return { top, bottom: top + 300, left: 0, right: 400, width: 400, height: 300 } as DOMRect;
  });
}

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private record: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, targets: [], disconnected: false };
        observers.push(this.record);
      }
      observe(target: Element) {
        this.record.targets.push(target);
      }
      disconnect() {
        this.record.disconnected = true;
      }
    },
  );
  mock.session = account;
  mock.project
    .mockReset()
    .mockImplementation(
      (_path: string, _schema: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
        ),
    );
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project card visibility", () => {
  it("reads the cards on screen when the observer's notifications never arrive", async () => {
    layout();
    const cards = [project(1), project(2), project(3)];
    await act(async () =>
      root.render(
        <>
          {cards.map((value, index) => (
            <ProjectCard key={value.id} project={value} account={account} actions={null} hidden={index === 2} />
          ))}
        </>,
      ),
    );
    // Put the second card far below the fold (the box stub reads data-top from the rendered article).
    host.querySelectorAll("article")[1]!.dataset.top = "4000";
    expect([...host.querySelectorAll("article")].every((card) => card.getAttribute("aria-busy") === "true")).toBe(true);
    expect(reads()).toEqual([]);
    // The page comes to the front; the browser has still not delivered any observer notification.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // The card on screen is read; the one below the fold and the one a search hides wait.
    expect(reads()).toEqual([`/api/projects/${cards[0]!.id}`]);
  });

  it("follows the element the card actually rendered when it changes", async () => {
    let swap!: () => void;
    function Card() {
      const [element, setElement] = useState(0);
      swap = () => setElement((value) => value + 1);
      const { target } = useProjectCardPreview(account, project(4).id, 1, true, false);
      // A new element for the same mounted card, with the account and project unchanged.
      return <article key={element} ref={target} data-element={element} />;
    }
    await act(async () => root.render(<Card />));
    await act(async () => swap());
    const rendered = host.querySelector("article")!;
    expect(rendered.dataset.element).toBe("1");
    await act(async () => notify(rendered));
    expect(reads()).toEqual([`/api/projects/${project(4).id}`]);
  });

  it("still waits for a card that is not on screen", async () => {
    layout();
    await act(async () => root.render(<ProjectCard project={project(5)} account={account} actions={null} />));
    host.querySelector("article")!.dataset.top = "4000";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(reads()).toEqual([]);
    // Scrolled into view, the observer reports it.
    await act(async () => notify(host.querySelector("article")!));
    expect(reads()).toEqual([`/api/projects/${project(5).id}`]);
  });
});
