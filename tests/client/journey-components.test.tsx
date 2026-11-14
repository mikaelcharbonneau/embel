// @vitest-environment jsdom
import { act, createElement, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => createElement("a", props, children),
}));

import {
  JOURNEY,
  journeyPartLabel,
  journeyProgress,
  journeyStepOfPath,
  journeySteps,
  projectJourney,
  type JourneyEvidence,
  type JourneyProgress,
} from "@/domain/journey";
import { contextSnapshotSchema, type ContextSnapshot } from "@/domain/projects";
import { FloatingNav } from "@/components/journey/floating-nav";
import { ProjectCapsule } from "@/components/journey/project-capsule";
import { LogoGenerationAction } from "@/components/logo-creation/generation-action";
import type { GenerationEstimate } from "@/components/logo-creation/use-generation-estimate";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});
const render = (element: ReactElement) => act(async () => root.render(element));

describe("journey model", () => {
  it("keeps the confirmed four steps and their parts", () => {
    expect(JOURNEY.map((step) => step.label)).toEqual(["Strategy", "Voice", "Identity", "Assets"]);
    expect(JOURNEY.map((step) => step.parts)).toEqual([
      ["Competitors", "Audience", "Positioning"],
      ["Personality", "Name", "Slogan"],
      ["Inspiration", "Logo", "Creative direction"],
      ["Brand images", "Brand guidelines", "Design system"],
    ]);
  });
  it("derives step status only from what the caller marks as done", () => {
    const steps = journeySteps("identity", new Set(["strategy", "voice"]), { strategy: "/s", voice: "/v" });
    expect(steps.map((step) => step.status)).toEqual(["done", "done", "current", "upcoming"]);
    expect(steps[0]).toMatchObject({ number: 1, href: "/s" });
  });
  it("labels a part with its position", () => {
    expect(journeyPartLabel("strategy", "Audience")).toBe("Audience · 2 of 3");
    expect(journeyPartLabel("voice", "Unknown")).toBe("Unknown");
  });
});

describe("project journey from saved work", () => {
  const id = "11111111-1111-4111-8111-111111111111",
    base = `/brands/account/${id}`,
    when = "2026-11-14T00:00:00Z";
  /** Strategy and Personality confirmed in a finished conversation; `change` reopens or adds to it. */
  const saved = (change: (context: ContextSnapshot) => void = () => {}) => {
    const context = contextSnapshotSchema.parse({
      description: "A repairable lighting studio",
      competitorReviewComplete: true,
      audienceSegments: [
        {
          id: "11111111-1111-4111-8111-111111111112",
          label: "Small homes",
          needs: [],
          reason: "Compact",
          selected: true,
          origin: "user",
        },
      ],
      personality: { sincerity: 60, excitement: 30, competence: 70, sophistication: 40, ruggedness: 20 },
      positioning: "Repairable lights for small homes",
      selectedName: "Luma",
      intake: {
        audienceReviewedAt: when,
        personalityReviewedAt: when,
        positioningReviewedAt: when,
        guidedInterview: { version: 1, stage: "complete", turns: [], answers: [] },
      },
    });
    change(context);
    return context;
  };
  const progress = (context: ContextSnapshot, evidence?: JourneyEvidence) =>
    journeyProgress({ project: { id, scope: "complete_brand", context }, evidence });
  const view = (pathname: string, read: JourneyProgress | null) =>
    projectJourney({ projectId: id, pathname, progress: read }).map(
      (step) => `${step.number}:${step.id}:${step.status}${step.href ? `->${step.href.replace(base, "")}` : ""}`,
    );

  it("maps each project page to its step", () => {
    expect(
      [
        base,
        `${base}/naming`,
        `${base}/inspiration`,
        `${base}/logo`,
        `${base}/logo/directions`,
        `${base}/logo/deliverables`,
        `${base}/identity`,
      ].map((path) => journeyStepOfPath(id, path)),
    ).toEqual(["strategy", "voice", "identity", "identity", "identity", "assets", "identity"]);
    expect(journeyStepOfPath(id, "/brands/account/22222222-2222-4222-8222-222222222222/naming")).toBe("strategy");
  });
  it("marks steps before the verified next action as done and links the next one", () => {
    const chosen: JourneyEvidence = { logo: "chosen", brandKit: false, directions: 0, directionsPending: false };
    expect(view(`${base}/naming`, progress(saved(), chosen))).toEqual([
      "1:strategy:done->?view=strategy",
      "2:voice:current->/naming",
      "3:identity:upcoming->/logo/directions",
      "4:assets:upcoming",
    ]);
    const audienceOpen = saved((context) => void (context.intake.audienceReviewedAt = null));
    expect(view(base, progress(audienceOpen, { logo: "none" }))).toEqual([
      "1:strategy:current->?view=strategy#journey-strategy",
      "2:voice:upcoming",
      "3:identity:upcoming",
      "4:assets:upcoming",
    ]);
  });
  it("highlights the step the conversation reports, such as Voice once naming continues inline", () => {
    const unnamed = progress(
      saved((context) => void (context.selectedName = null)),
      { logo: "none" },
    );
    expect(
      projectJourney({ projectId: id, pathname: base, progress: unnamed, shown: "voice" }).map(
        (step) => `${step.id}:${step.status}`,
      ),
    ).toEqual(["strategy:done", "voice:current", "identity:upcoming", "assets:upcoming"]);
  });
  it("claims nothing as done while the project is unknown, and only the saved answers while the logo work is unread", () => {
    expect(view(`${base}/logo`, null)).toEqual([
      "1:strategy:upcoming",
      "2:voice:upcoming",
      "3:identity:current",
      "4:assets:upcoming",
    ]);
    expect(view(`${base}/logo`, progress(saved()))).toEqual([
      "1:strategy:done->?view=strategy",
      "2:voice:done->/naming",
      "3:identity:current",
      "4:assets:upcoming",
    ]);
  });
  it("always shows all four steps, numbered from one", () => {
    expect(view(`${base}/logo/deliverables`, progress(saved(), { logo: "chosen", brandKit: true }))).toEqual([
      "1:strategy:done->?view=strategy",
      "2:voice:done->/naming",
      "3:identity:done->/logo",
      "4:assets:current->/logo/deliverables",
    ]);
  });
});

describe("navigation", () => {
  const items = [
    { href: "/", label: "Home", icon: "house" },
    { href: "/brands", label: "Projects", icon: "folder" },
    { href: "/assets", label: "Library", icon: "library" },
  ] as const;
  it("marks the current page and offers no Tools menu", async () => {
    await render(createElement(FloatingNav, { pathname: "/brands/123", items }));
    expect(host.querySelector("a[aria-current='page']")!.textContent).toBe("Projects");
    expect(host.querySelector("details")).toBeNull();
    // At phone width the labels are hidden and each link shows its icon, so no destination disappears.
    expect(
      [...host.querySelectorAll("a.e-nav__item")].map((link) =>
        link.querySelector(".e-nav__icon")?.getAttribute("data-icon"),
      ),
    ).toEqual(["house", "folder", "library"]);
    expect(host.textContent).not.toContain("Tools");
  });
  it("shows the four steps, the current one and confirmed save state inside a project", async () => {
    await render(
      createElement(ProjectCapsule, {
        projectName: "Untitled brand",
        saveState: "saved",
        steps: journeySteps("voice", new Set(["strategy"]), { strategy: "/p/strategy" }),
      }),
    );
    expect(host.querySelector("nav[aria-label='Brand journey'] [aria-current='step']")!.textContent).toBe("Voice");
    expect(host.querySelector("a[href='/p/strategy']")!.textContent).toBe("Strategy, complete");
    expect(host.querySelector("[role='status']")!.textContent).toBe("Saved");
    expect(host.textContent).toContain("Untitled brand");
    await render(
      createElement(ProjectCapsule, {
        projectName: "x",
        saveState: "saving",
        steps: journeySteps("strategy", new Set()),
      }),
    );
    expect(host.querySelector("[role='status']")!.textContent).toBe("Saving…");
    await render(
      createElement(ProjectCapsule, {
        projectName: "x",
        saveState: null,
        steps: journeySteps("voice", new Set(), { strategy: "/p/strategy#audience" }),
      }),
    );
    expect(host.querySelector("a[href='/p/strategy#audience']")!.textContent).toBe("1Strategy, next step");
    expect(host.querySelector("[role='status']")).toBeNull();
    await render(createElement(ProjectCapsule, { projectName: "", saveState: null, steps: [] }));
    expect(host.querySelector("[role='status']")!.textContent).toBe("Loading project…");
    expect(host.querySelector("nav[aria-label='Brand journey']")).toBeNull();
  });
  it("asks the open conversation to show a step instead of reloading it", async () => {
    const href = `${window.location.pathname}?view=strategy#journey-strategy`;
    await render(
      createElement(ProjectCapsule, {
        projectName: "x",
        saveState: null,
        steps: journeySteps("voice", new Set(["strategy"]), { strategy: href }),
      }),
    );
    const link = host.querySelector<HTMLAnchorElement>("nav[aria-label='Brand journey'] a")!;
    const click = () => {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      link.dispatchEvent(event);
      return event;
    };
    // Not on screen: the link opens the conversation at that step.
    expect(click().defaultPrevented).toBe(false);
    const section = document.createElement("section");
    section.id = "journey-strategy";
    document.body.append(section);
    const shown = vi.fn();
    section.addEventListener("embel:journey-section", (event) => shown((event as CustomEvent).detail));
    expect(click().defaultPrevented).toBe(true);
    expect(shown).toHaveBeenCalledExactlyOnceWith("strategy");
  });
});

describe("decisions that must not regress", () => {
  function styleFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? styleFiles(path) : path.endsWith(".css") ? [path] : [];
    });
  }
  it("uses no magenta accent anywhere in the app styles", () => {
    const offenders = styleFiles(join(process.cwd(), "src")).filter((path) =>
      /--magenta|accent-text|#ff00f4|#990091|#fff0fd|#ffd4fa|#a300ad/i.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
  it("never shows a generation cost, even when the server's quote carries one", async () => {
    const estimate = {
      quote: {
        estimatedCostMicrousd: 175932,
        maxCostMicrousd: 400000,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      canStart: true,
      loading: false,
      expired: false,
      error: null,
      busy: false,
      enabled: true,
      refresh: vi.fn(),
      start: vi.fn(),
    } as unknown as GenerationEstimate;
    await render(createElement(LogoGenerationAction, { estimate, label: "Generate six concepts" }));
    expect(host.textContent).not.toMatch(/\$|cost|estimat/i);
    host.querySelector<HTMLButtonElement>("button")!.click();
    expect(estimate.start).toHaveBeenCalledOnce();
  });
  it("explains a refused start once, beside its Try again, and clears the line by the button", async () => {
    const estimate = {
      canStart: false,
      error: "You’ve used this month’s credits. New credits arrive on December 1. Your logos are saved.",
      busy: false,
      refresh: vi.fn(),
      start: vi.fn(),
    } as unknown as GenerationEstimate;
    await render(createElement(LogoGenerationAction, { estimate, label: "More concepts" }));
    expect(host.querySelector('[role="status"]')!.textContent).toBe("");
    expect(host.textContent).not.toContain("Not ready yet.");
    expect(host.textContent!.match(/used this month’s credits/g)).toHaveLength(1);
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toContain("Try again");
  });
});
