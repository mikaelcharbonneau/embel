// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
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
  progress: null as null | { projectId: string; nextHref: string | null },
  replace: vi.fn(),
  push: vi.fn(),
  strategy: {
    overview: { availability: { status: "unavailable", reason: "worker_unavailable", operations: [] }, jobs: [] },
    pending: false,
    readError: null,
    actionError: null,
    refresh: () => undefined,
    enqueue: () => undefined,
    cancel: () => undefined,
  },
}));
vi.mock("@/components/workspace/use-strategy-jobs", () => ({ useStrategyJobs: () => fixture.strategy }));
vi.mock("@/components/workspace/project-progress", () => ({ useProjectProgress: () => fixture.progress }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: fixture.replace, push: fixture.push, refresh: vi.fn() }),
}));
vi.mock("@/components/inspiration/inspiration-like-count", () => ({ InspirationLikeCount: () => null }));
vi.mock("@/components/inspiration/inspiration-workspace", () => ({
  InspirationWorkspace: ({
    onContinue,
    continueHidden,
    onLikes,
    variant,
  }: {
    onContinue?: () => void;
    continueHidden?: boolean;
    onLikes?: (count: number) => void;
    variant?: string;
  }) => {
    useEffect(() => onLikes?.(2), [onLikes]);
    return (
      <article data-inspiration data-variant={variant}>
        {!continueHidden && (
          <button type="button" className="inspiration-continue" onClick={onContinue}>
            Continue
          </button>
        )}
      </article>
    );
  },
}));
vi.mock("@/components/logo-creation/logo-creation-workspace", () => ({
  LogoCreationWorkspace: ({
    projectId,
    onContinue,
    continueHidden,
  }: {
    projectId?: string;
    onContinue?: () => void;
    continueHidden?: boolean;
  }) => (
    <div data-logo-workspace={projectId}>
      {onContinue && !continueHidden && (
        <button type="button" className="logo-continue" onClick={onContinue}>
          Continue
        </button>
      )}
    </div>
  ),
}));
// The direction step reports the folded answers and Embel's words for its state through the Workspace slots.
vi.mock("@/components/visual-directions/visual-directions-page", async () => {
  const slots = await import("@/components/workspace/workspace-slots");
  return {
    VisualDirectionsPage: ({
      projectId,
      variant,
      presentation,
    }: {
      projectId: string;
      variant?: string;
      presentation?: string;
    }) => {
      slots.useWorkspaceStepSummary("logo", {
        answer: "Concept 1, version 2",
        thumbnail: { src: "data:image/png;base64,AA==", alt: "Chosen logo concept" },
      });
      slots.useWorkspaceStepSummary("directions", { answer: "Editorial Soft Shapes" });
      slots.useWorkspaceStepMessage("directions", "Here are three directions for Cedar.");
      return <div data-directions={projectId} data-variant={variant} data-presentation={presentation} />;
    },
  };
});

const account = { status: "ready" as const, userId: "aaaaaaaa-2222-4222-8222-222222222222", generation: 1 };
const projectId = "bbbbbbbb-2222-4222-8222-222222222222",
  when = "2026-11-07T10:00:00Z";
let root: Root, host: HTMLDivElement, workspace: AccountWorkspace;
const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
  this.scrollTop = Math.max(0, options.top ?? 0);
});

function identity() {
  return host.querySelector<HTMLElement>('[data-journey-section="identity"]');
}
/** The Workspace's work area, where the step on screen is. */
function work() {
  return host.querySelector<HTMLElement>(".e-workspace__main");
}
/** Send in the reply box: its accessible name says what it does. */
function send() {
  return host.querySelector<HTMLButtonElement>('form[aria-label="Reply"] button[type="submit"]');
}
function chips() {
  return [...host.querySelectorAll('[aria-label="In your reply"] .e-chip')].map((chip) => chip.textContent);
}
function buttonNamed(name: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === name);
}
function logoContinue() {
  return host.querySelector<HTMLButtonElement>("button.logo-continue");
}
async function render() {
  await act(async () =>
    root.render(
      createElement(AccountGuidedInterview, {
        account,
        workspace,
        busy: false,
        saveContext: async () => null,
        storage: { kind: "account", saveLabel: "Saved", onUpdate: () => false },
      }),
    ),
  );
}
function progressAt(step: "inspiration" | "logo" | "logo/directions") {
  fixture.progress = { projectId, nextHref: `/brands/account/${projectId}/${step}` };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  scrollTo.mockClear();
  fixture.replace.mockReset();
  fixture.push.mockReset();
  progressAt("inspiration");
  // Voice is finished: a name is chosen and the slogan question was asked.
  const project = accountProjectSchema.parse({
    id: projectId,
    owner_id: account.userId,
    title: "Cedar",
    scope: "complete_brand",
    current_revision: 2,
    created_at: when,
    context: { description: "A neighborhood kitchen" },
  });
  const context = initialGuidedContext(project.context, 1, when),
    interview = context.intake.guidedInterview!;
  const saved = {
    ...project,
    context: {
      ...context,
      selectedName: "Cedar",
      intake: {
        ...context.intake,
        guidedInterview: {
          ...interview,
          stage: "complete" as const,
          turns: [
            ...interview.turns,
            {
              id: "slogan-turn",
              userMessageId: null,
              stage: "slogan" as const,
              purpose: "propose" as const,
              inputRevision: 2,
            },
          ],
        },
      },
    },
  };
  workspace = { ownerId: account.userId, generation: 1, saved, draft: accountProjectDraft(saved), conflict: false };
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: scrollTo });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Logo step inside the Identity conversation", () => {
  it("shows Inspiration in the work area and opens the Logo step with Send", async () => {
    await render();
    expect(work()?.querySelector("[data-inspiration]")?.getAttribute("data-variant")).toBe("workspace");
    expect(host.querySelector("#journey-logo")).toBeNull();
    // Decision 2: no Continue in the step; its likes go into the reply box and Send moves on.
    expect(host.querySelector("button.inspiration-continue")).toBeNull();
    expect(chips()).toEqual(["Inspiration: 2 liked"]);
    expect(send()!.disabled).toBe(false);
    await act(async () => send()!.click());
    expect(work()!.querySelector("#journey-logo [data-logo-workspace]")?.getAttribute("data-logo-workspace")).toBe(
      projectId,
    );
    expect(work()!.querySelector("[data-inspiration]")).toBeNull();
    // Inspiration folds into the chat, and can be reopened from there.
    const folded = identity()!.querySelector("details")!;
    expect(folded.querySelector("summary")!.textContent).toContain("2 liked");
    await act(async () => buttonNamed("Edit inspiration")!.click());
    expect(work()!.querySelector("[data-inspiration]")).not.toBeNull();
    expect(send()!.getAttribute("aria-label")).toBe("Continue to Logo");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("shows the Logo step once the project has reached it, with Inspiration folded", async () => {
    progressAt("logo");
    await render();
    expect(work()!.querySelector("#journey-logo [data-logo-workspace]")).not.toBeNull();
    expect(identity()!.querySelector("details summary")!.textContent).toContain("Inspiration");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("opens at the Logo step from a #journey-logo link", async () => {
    window.history.replaceState(null, "", "#journey-logo");
    await render();
    expect(work()!.querySelector("#journey-logo [data-logo-workspace]")).not.toBeNull();
  });
});

describe("Creative direction inside the Identity conversation", () => {
  it("opens after the Logo step's Continue", async () => {
    progressAt("logo");
    await render();
    expect(host.querySelector("#journey-directions")).toBeNull();
    await act(async () => logoContinue()!.click());
    const directions = work()!.querySelector("#journey-directions [data-directions]")!;
    expect(directions.getAttribute("data-directions")).toBe(projectId);
    expect(directions.getAttribute("data-variant")).toBe("conversation");
    expect(work()!.querySelector("#journey-logo")).toBeNull();
  });

  it("shows Creative direction once the project has reached it, with the Logo step folded and reopenable", async () => {
    progressAt("logo/directions");
    await render();
    expect(work()!.querySelector("#journey-directions [data-directions]")).not.toBeNull();
    await act(async () => buttonNamed("Change logo")!.click());
    expect(work()!.querySelector("#journey-logo [data-logo-workspace]")).not.toBeNull();
    expect(logoContinue()).toBeNull();
  });

  it("opens at Creative direction from a #journey-directions link", async () => {
    progressAt("inspiration");
    window.history.replaceState(null, "", "#journey-directions");
    await render();
    expect(work()!.querySelector("#journey-directions [data-directions]")).not.toBeNull();
  });

  it("folds the chosen logo with its picture and words Embel's message from the step", async () => {
    progressAt("logo/directions");
    await render();
    const logo = [...identity()!.querySelectorAll("details")].find((entry) =>
      entry.querySelector(".e-answer__question")?.textContent?.includes("Logo"),
    )!;
    expect(logo.querySelector("summary")!.textContent).toContain("Concept 1, version 2");
    expect(logo.querySelector("img")?.getAttribute("alt")).toBe("Chosen logo concept");
    expect(host.querySelector(".e-workspace__log")!.textContent).toContain("Here are three directions for Cedar.");
    expect(work()!.querySelector("[data-directions]")!.getAttribute("data-presentation")).toBe("choose");
  });

  it("shows a finished brand as the brand, with Creative direction folded and reopenable", async () => {
    fixture.progress = { projectId, nextHref: `/brands/account/${projectId}/logo/deliverables` };
    await render();
    expect(work()!.querySelector("[data-directions]")!.getAttribute("data-presentation")).toBe("brand");
    const log = host.querySelector(".e-workspace__log")!;
    expect(log.textContent).toContain(
      "You chose Concept 1, version 2 as your logo and Editorial Soft Shapes as your direction.",
    );
    expect(log.textContent).not.toContain("Here are three directions for Cedar.");
    await act(async () => buttonNamed("Change direction")!.click());
    expect(work()!.querySelector("[data-directions]")!.getAttribute("data-presentation")).toBe("choose");
    expect(buttonNamed("Change direction")).toBeUndefined();
    expect(log.textContent).toContain("Here are three directions for Cedar.");
  });

  it("sends a finished brand on to Assets with Send", async () => {
    fixture.progress = { projectId, nextHref: `/brands/account/${projectId}/logo/deliverables` };
    await render();
    expect(work()!.querySelector("#journey-directions [data-directions]")).not.toBeNull();
    expect(send()!.getAttribute("aria-label")).toBe("Continue to Assets");
    await act(async () => send()!.click());
    expect(fixture.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}/logo/deliverables`);
  });
});

describe("Old Logo page", () => {
  it("sends a complete brand to its Logo step in the conversation", async () => {
    progressAt("logo");
    await act(async () => root.render(<LogoCreationPage projectId={projectId} />));
    expect(fixture.replace).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}?view=strategy#journey-logo`);
    expect(host.querySelector("[data-logo-workspace]")).toBeNull();
  });

  it("keeps the page when the project conversation is not around it", async () => {
    fixture.progress = null;
    await act(async () => root.render(<LogoCreationPage projectId={projectId} />));
    expect(fixture.replace).not.toHaveBeenCalled();
    expect(host.querySelector("[data-logo-workspace]")?.getAttribute("data-logo-workspace")).toBe(projectId);
  });
});
