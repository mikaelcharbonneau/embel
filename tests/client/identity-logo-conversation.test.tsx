// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import type { AccountWorkspace } from "@/components/workspace/account-draft-memory";
import { initialGuidedContext } from "@/components/workspace/guided-interview-client";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { LogoCreationPage } from "@/components/logo-creation/logo-creation-page";
import { accountProjectSchema, type AccountProject } from "@/domain/project-api";

// The Logo step inside the project conversation. Inspiration and the logo
// workspace are stand-ins: their own tests cover them. No network or AI calls.
const fixture = vi.hoisted(() => ({
  progress: null as null | { projectId: string; scope: AccountProject["scope"]; nextHref: string | null },
  replace: vi.fn(),
  strategy: {
    overview: { availability: { status: "unavailable", reason: "worker_unavailable", operations: [] }, jobs: [] },
    pending: false, readError: null, actionError: null, refresh: () => undefined, enqueue: () => undefined, cancel: () => undefined,
  },
}));
vi.mock("@/components/workspace/use-strategy-jobs", () => ({ useStrategyJobs: () => fixture.strategy }));
vi.mock("@/components/workspace/project-progress", () => ({ useProjectProgress: () => fixture.progress }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: fixture.replace, push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/inspiration/inspiration-workspace", () => ({
  InspirationWorkspace: ({ onContinue, continueHidden }: { onContinue?: () => void; continueHidden?: boolean }) =>
    <article className="guided-assistant-message" data-inspiration>{!continueHidden && <button type="button" className="inspiration-continue" onClick={onContinue}>Continue</button>}</article>,
}));
vi.mock("@/components/logo-creation/logo-creation-workspace", () => ({
  LogoCreationWorkspace: ({ projectId, onContinue, continueHidden }: { projectId?: string; onContinue?: () => void; continueHidden?: boolean }) =>
    <div data-logo-workspace={projectId}>{onContinue && !continueHidden && <button type="button" className="logo-continue" onClick={onContinue}>Continue</button>}</div>,
}));
vi.mock("@/components/visual-directions/visual-directions-page", () => ({
  VisualDirectionsPage: ({ projectId, variant }: { projectId: string; variant?: string }) => <div data-directions={projectId} data-variant={variant} />,
}));

const account = { status: "ready" as const, userId: "aaaaaaaa-2222-4222-8222-222222222222", generation: 1 };
const projectId = "bbbbbbbb-2222-4222-8222-222222222222", when = "2026-11-07T10:00:00Z";
const LOGO_TOP = 2000, DIRECTIONS_TOP = 3000;
let root: Root, host: HTMLDivElement, workspace: AccountWorkspace;
const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = Math.max(0, options.top ?? 0); });

function area() { return host.querySelector<HTMLDivElement>(".guided-interview-scroll")!; }
function identity() { return host.querySelector<HTMLElement>('[data-journey-section="identity"]'); }
function continueButton() { return host.querySelector<HTMLButtonElement>("button.inspiration-continue"); }
/** Scroll requests that brought the Logo message to the top of the conversation. */
function logoJumps() { return scrollTo.mock.calls.filter(([options]) => options?.top === LOGO_TOP - 24).length; }
function directionsJumps() { return scrollTo.mock.calls.filter(([options]) => options?.top === DIRECTIONS_TOP - 24).length; }
function logoContinue() { return host.querySelector<HTMLButtonElement>("button.logo-continue"); }
async function render() {
  await act(async () => root.render(createElement(AccountGuidedInterview, { account, workspace, busy: false, saveContext: async () => null,
    storage: { kind: "account", saveLabel: "Saved", onUpdate: () => false } })));
}
function progressAt(step: "inspiration" | "logo" | "logo/directions") {
  fixture.progress = { projectId, scope: "complete_brand", nextHref: `/brands/account/${projectId}/${step}` };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  scrollTo.mockClear(); fixture.replace.mockReset(); progressAt("inspiration");
  // Voice is finished: a name is chosen and the slogan question was asked.
  const project = accountProjectSchema.parse({ id: projectId, owner_id: account.userId, title: "Cedar", scope: "complete_brand",
    current_revision: 2, created_at: when, context: { description: "A neighborhood kitchen" } });
  const context = initialGuidedContext(project.context, 1, when), interview = context.intake.guidedInterview!;
  const saved = { ...project, context: { ...context, selectedName: "Cedar", intake: { ...context.intake, guidedInterview: { ...interview, stage: "complete" as const,
    turns: [...interview.turns, { id: "slogan-turn", userMessageId: null, stage: "slogan" as const, purpose: "propose" as const, inputRevision: 2 }] } } } };
  workspace = { ownerId: account.userId, generation: 1, saved, draft: accountProjectDraft(saved), conflict: false };
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("guided-interview-scroll") ? 6000 : 0; });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("guided-interview-scroll") ? 800 : 0; });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const offset = this.id === "journey-logo" ? LOGO_TOP : this.id === "journey-directions" ? DIRECTIONS_TOP : null;
    const top = offset === null ? 0 : offset - (area()?.scrollTop ?? 0);
    return { top, bottom: top, left: 0, right: 0, x: 0, y: top, width: 0, height: 0, toJSON: () => ({}) };
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: scrollTo });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.history.replaceState(null, "", "/");
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("Logo step inside the Identity conversation", () => {
  it("opens below Inspiration after Continue and keeps it in view while images load, until the reader scrolls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render();
    expect(identity()?.querySelector("[data-inspiration]")).not.toBeNull();
    expect(host.querySelector("#journey-logo")).toBeNull();
    scrollTo.mockClear();

    await act(async () => continueButton()!.click());
    const logo = identity()!.querySelector("#journey-logo")!;
    expect(logo.querySelector("[data-logo-workspace]")?.getAttribute("data-logo-workspace")).toBe(projectId);
    expect(continueButton()).toBeNull();
    expect(logoJumps()).toBe(1);

    // Inspiration images finish loading and push the Logo message down.
    area().scrollTop = 0;
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(logoJumps()).toBe(2);

    // Once the reader scrolls, the conversation stays where they put it.
    await act(async () => { area().dispatchEvent(new Event("wheel")); area().scrollTop = 500; vi.advanceTimersByTime(3000); });
    expect(logoJumps()).toBe(2);
    expect(area().scrollTop).toBe(500);
  });

  it("shows the Logo step without Continue once the project has reached it, without moving the reader", async () => {
    progressAt("logo");
    await render();
    expect(identity()!.querySelector("#journey-logo [data-logo-workspace]")).not.toBeNull();
    expect(continueButton()).toBeNull();
    expect(logoJumps()).toBe(0);
  });

  it("opens at the Logo step from a #journey-logo link", async () => {
    window.history.replaceState(null, "", "#journey-logo");
    await render();
    expect(identity()!.querySelector("#journey-logo [data-logo-workspace]")).not.toBeNull();
    expect(logoJumps()).toBe(1);
  });
});

describe("Creative direction inside the Identity conversation", () => {
  it("opens below the Logo step after its Continue and moves to it", async () => {
    progressAt("logo");
    await render();
    expect(host.querySelector("#journey-directions")).toBeNull();
    scrollTo.mockClear();
    await act(async () => logoContinue()!.click());
    const directions = identity()!.querySelector("#journey-directions [data-directions]")!;
    expect(directions.getAttribute("data-directions")).toBe(projectId); expect(directions.getAttribute("data-variant")).toBe("conversation");
    expect(logoContinue()).toBeNull();
    expect(directionsJumps()).toBe(1); expect(logoJumps()).toBe(0);
  });

  it("shows Creative direction without Logo's Continue once the project has reached it, without moving the reader", async () => {
    progressAt("logo/directions");
    await render();
    expect(identity()!.querySelector("#journey-logo [data-logo-workspace]")).not.toBeNull();
    expect(identity()!.querySelector("#journey-directions [data-directions]")).not.toBeNull();
    expect(logoContinue()).toBeNull(); expect(directionsJumps()).toBe(0);
  });

  it("opens at Creative direction from a #journey-directions link, with the Logo step above it", async () => {
    progressAt("inspiration");
    window.history.replaceState(null, "", "#journey-directions");
    await render();
    expect(identity()!.querySelector("#journey-logo [data-logo-workspace]")).not.toBeNull();
    expect(identity()!.querySelector("#journey-directions [data-directions]")).not.toBeNull();
    expect(directionsJumps()).toBe(1); expect(logoJumps()).toBe(0);
  });
});

describe("Old Logo page", () => {
  it("sends a complete brand to its Logo step in the conversation", async () => {
    progressAt("logo");
    await act(async () => root.render(<LogoCreationPage projectId={projectId} />));
    expect(fixture.replace).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}?view=strategy#journey-logo`);
    expect(host.querySelector("[data-logo-workspace]")).toBeNull();
  });

  it("keeps the page for a project without the conversation", async () => {
    fixture.progress = { projectId, scope: "visual_identity_only", nextHref: null };
    await act(async () => root.render(<LogoCreationPage projectId={projectId} />));
    expect(fixture.replace).not.toHaveBeenCalled();
    expect(host.querySelector("[data-logo-workspace]")?.getAttribute("data-logo-workspace")).toBe(projectId);
  });
});
