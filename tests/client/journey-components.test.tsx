// @vitest-environment jsdom
import { act, createElement, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => createElement("a", props, children) }));

import { JOURNEY, journeyPartLabel, journeyStepOfPath, journeySteps, projectJourney } from "@/domain/journey";
import { AnswerSummary, EarlierAnswerLink } from "@/components/journey/answer-summary";
import { ChoiceCard } from "@/components/journey/choice-card";
import { Composer } from "@/components/journey/composer";
import { EmbelMessage, UserMessage } from "@/components/journey/embel-message";
import { FloatingNav } from "@/components/journey/floating-nav";
import { ProgressCard } from "@/components/journey/progress-card";
import { ProjectCapsule } from "@/components/journey/project-capsule";
import { LogoGenerationAction } from "@/components/logo-creation/generation-action";
import type { GenerationEstimate } from "@/components/logo-creation/use-generation-estimate";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
const render = (element: ReactElement) => act(async () => root.render(element));
const key = (target: Element, init: KeyboardEventInit) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

describe("journey model", () => {
  it("keeps the confirmed four steps and their parts", () => {
    expect(JOURNEY.map(step => step.label)).toEqual(["Strategy", "Voice", "Identity", "Assets"]);
    expect(JOURNEY.map(step => step.parts)).toEqual([
      ["Competitors", "Audience", "Positioning"], ["Personality", "Name", "Slogan"],
      ["Inspiration", "Logo", "Creative direction"], ["Brand images", "Brand guidelines", "Design system"],
    ]);
  });
  it("derives step status only from what the caller marks as done", () => {
    const steps = journeySteps("identity", new Set(["strategy", "voice"]), { strategy: "/s", voice: "/v" });
    expect(steps.map(step => step.status)).toEqual(["done", "done", "current", "upcoming"]);
    expect(steps[0]).toMatchObject({ number: 1, href: "/s" });
  });
  it("labels a part with its position", () => {
    expect(journeyPartLabel("strategy", "Audience")).toBe("Audience · 2 of 3");
    expect(journeyPartLabel("voice", "Unknown")).toBe("Unknown");
  });
});

describe("project journey from saved work", () => {
  const id = "11111111-1111-4111-8111-111111111111", base = `/brands/account/${id}`;
  const view = (scope: "complete_brand" | "naming_only" | "visual_identity_only", pathname: string, nextHref: string | null) =>
    projectJourney({ projectId: id, scope, pathname, nextHref }).map(step => `${step.number}:${step.id}:${step.status}${step.href ? `->${step.href.replace(base, "")}` : ""}`);

  it("maps each project page to its step", () => {
    expect([base, `${base}/naming`, `${base}/inspiration`, `${base}/logo`, `${base}/logo/directions`, `${base}/logo/deliverables`, `${base}/identity`]
      .map(path => journeyStepOfPath(id, path))).toEqual(["strategy", "voice", "identity", "identity", "identity", "assets", "identity"]);
    expect(journeyStepOfPath(id, "/brands/account/22222222-2222-4222-8222-222222222222/naming")).toBe("strategy");
  });
  it("marks steps before the verified next action as done and links the next one", () => {
    expect(view("complete_brand", `${base}/naming`, `${base}/logo/directions`)).toEqual([
      "1:strategy:done->?view=strategy", "2:voice:current->/naming", "3:identity:upcoming->/logo/directions", "4:assets:upcoming"]);
    expect(view("complete_brand", base, `${base}?view=strategy#strategy-audience`)).toEqual([
      "1:strategy:current->?view=strategy#strategy-audience", "2:voice:upcoming", "3:identity:upcoming", "4:assets:upcoming"]);
  });
  it("highlights the step the conversation reports, such as Voice once naming continues inline", () => {
    expect(projectJourney({ projectId: id, scope: "complete_brand", pathname: base, nextHref: `${base}/naming`, shown: "voice" })
      .map(step => `${step.id}:${step.status}`)).toEqual(["strategy:done", "voice:current", "identity:upcoming", "assets:upcoming"]);
  });
  it("claims nothing as done while the next action is unknown", () => {
    expect(view("complete_brand", `${base}/logo`, null)).toEqual(["1:strategy:upcoming", "2:voice:upcoming", "3:identity:current", "4:assets:upcoming"]);
  });
  it("shows only the steps a project type has, numbered from one", () => {
    expect(view("naming_only", `${base}/naming`, `${base}/naming`)).toEqual(["1:voice:current->/naming"]);
    expect(view("visual_identity_only", `${base}/logo/deliverables`, `${base}/logo/deliverables`)).toEqual(["1:identity:done->/logo", "2:assets:current->/logo/deliverables"]);
  });
});

describe("ChoiceCard", () => {
  it("selects when anywhere on the card is clicked and reflects the checked state", async () => {
    const change = vi.fn();
    await render(createElement(ChoiceCard, { type: "checkbox", name: "competitors", value: "a", checked: false, onChange: change, title: "Milk & More", badge: "Recommended" }, "Doorstep delivery"));
    host.querySelector("label")!.click();
    expect(change).toHaveBeenCalledWith(true);
    expect(host.textContent).toContain("Recommended");
    await render(createElement(ChoiceCard, { type: "radio", name: "p", value: "a", checked: true, onChange: change, title: "Warm neighbour" }));
    expect(host.querySelector("[data-checked='true'] input[type='radio']")).not.toBeNull();
  });
  it("does not change when disabled", async () => {
    const change = vi.fn();
    await render(createElement(ChoiceCard, { type: "radio", name: "p", value: "a", checked: false, onChange: change, title: "A", disabled: true }));
    host.querySelector("label")!.click();
    expect(change).not.toHaveBeenCalled();
  });
});

describe("Composer", () => {
  it("sends trimmed text on Enter and keeps Shift+Enter for a new line", async () => {
    const submit = vi.fn();
    await render(createElement(Composer, { label: "Message Embel", placeholder: "Reply…", value: "  Make it bolder  ", onChange: vi.fn(), onSubmit: submit }));
    const field = host.querySelector("textarea")!;
    await key(field, { key: "Enter", shiftKey: true });
    expect(submit).not.toHaveBeenCalled();
    await key(field, { key: "Enter" });
    expect(submit).toHaveBeenCalledWith("Make it bolder");
    expect(host.querySelector("label")!.textContent).toBe("Message Embel");
  });
  it("cannot send empty text and names what a change applies to", async () => {
    const clear = vi.fn(), submit = vi.fn();
    await render(createElement(Composer, { label: "Refine", placeholder: "Describe…", value: "   ", onChange: vi.fn(), onSubmit: submit, target: "Concept 3", onClearTarget: clear }));
    expect(host.querySelector<HTMLButtonElement>("button[type='submit']")!.disabled).toBe(true);
    await key(host.querySelector("textarea")!, { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Changing Concept 3");
    host.querySelector<HTMLButtonElement>("button[aria-label='Stop changing Concept 3']")!.click();
    expect(clear).toHaveBeenCalledOnce();
  });
});

describe("conversation pieces", () => {
  it("labels Embel's turn with the journey part and shows the person's message", async () => {
    await render(createElement("div", null, createElement(UserMessage, null, "A refill pantry"), createElement(EmbelMessage, { meta: "Competitors · 1 of 3" } as ComponentProps<typeof EmbelMessage>, "Here are brands…")));
    expect(host.textContent).toContain("You");
    expect(host.textContent).toContain("Embel · Competitors · 1 of 3");
  });
  it("collapses an answer with a named edit action", async () => {
    const edit = vi.fn<() => void>();
    await render(createElement("div", null, createElement(AnswerSummary, { question: "Who should feel it was made for them?", onEdit: () => edit() } as ComponentProps<typeof AnswerSummary>, "Households who cook most days"),
      createElement(EarlierAnswerLink, { href: "/strategy", label: "Strategy", value: "The pantry that comes to you" })));
    expect(host.querySelector("section")!.getAttribute("aria-label")).toBe("Your answer: Who should feel it was made for them?");
    host.querySelector<HTMLButtonElement>("button[aria-label='Edit your answer: Who should feel it was made for them?']")!.click();
    expect(edit).toHaveBeenCalledOnce();
    expect(host.querySelector("a[href='/strategy']")!.textContent).toBe("StrategyThe pantry that comes to you");
  });
  it("shows real progress with a stop action that can be disabled", async () => {
    const stop = vi.fn();
    await render(createElement(ProgressCard, { title: "Researching your competitors", description: "Finding relevant brands and the sources behind them.", onStop: stop }));
    expect(host.querySelector("[role='status']")!.textContent).toContain("Researching your competitors");
    host.querySelector("button")!.click();
    expect(stop).toHaveBeenCalledOnce();
    await render(createElement(ProgressCard, { title: "Researching", description: "…", onStop: stop, stopping: true }));
    expect(host.querySelector("button")!.disabled).toBe(true);
    expect(host.querySelector("button")!.textContent).toBe("Stopping…");
  });
});

describe("navigation", () => {
  const items = [{ href: "/", label: "Home" }, { href: "/brands", label: "Projects" }, { href: "/assets", label: "Library" }];
  const tools = [{ href: "/names", label: "Names" }, { href: "/domains", label: "Domains" }];
  it("marks the current page and closes the Tools menu after choosing or Escape", async () => {
    await render(createElement(FloatingNav, { pathname: "/brands/123", items, tools }));
    host.addEventListener("click", event => event.preventDefault());
    expect(host.querySelector("a[aria-current='page']")!.textContent).toBe("Projects");
    const details = host.querySelector("details")!;
    details.open = true;
    host.querySelector<HTMLAnchorElement>("a[href='/names']")!.click();
    expect(details.open).toBe(false);
    details.open = true;
    await key(details, { key: "Escape" });
    expect(details.open).toBe(false);
  });
  it("shows the four steps, the current one and confirmed save state inside a project", async () => {
    await render(createElement(ProjectCapsule, { projectName: "Untitled brand", saveState: "saved", steps: journeySteps("voice", new Set(["strategy"]), { strategy: "/p/strategy" }) }));
    expect(host.querySelector("nav[aria-label='Brand journey'] [aria-current='step']")!.textContent).toBe("Voice");
    expect(host.querySelector("a[href='/p/strategy']")!.textContent).toBe("Strategy, complete");
    expect(host.querySelector("[role='status']")!.textContent).toBe("Saved");
    expect(host.textContent).toContain("Untitled brand");
    await render(createElement(ProjectCapsule, { projectName: "x", saveState: "saving", steps: journeySteps("strategy", new Set()) }));
    expect(host.querySelector("[role='status']")!.textContent).toBe("Saving…");
    await render(createElement(ProjectCapsule, { projectName: "x", saveState: null, steps: journeySteps("voice", new Set(), { strategy: "/p/strategy#audience" }) }));
    expect(host.querySelector("a[href='/p/strategy#audience']")!.textContent).toBe("1Strategy, next step");
    expect(host.querySelector("[role='status']")).toBeNull();
    await render(createElement(ProjectCapsule, { projectName: "", saveState: null, steps: [] }));
    expect(host.querySelector("[role='status']")!.textContent).toBe("Loading project…");
    expect(host.querySelector("nav[aria-label='Brand journey']")).toBeNull();
  });
});

describe("decisions that must not regress", () => {
  function styleFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(entry => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? styleFiles(path) : path.endsWith(".css") ? [path] : [];
    });
  }
  it("uses no magenta accent anywhere in the app styles", () => {
    const offenders = styleFiles(join(process.cwd(), "src")).filter(path => /--magenta|accent-text|#ff00f4|#990091|#fff0fd|#ffd4fa|#a300ad/i.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("never shows a generation cost, even when the server's quote carries one", async () => {
    const estimate = { quote: { estimatedCostMicrousd: 175932, maxCostMicrousd: 400000, expiresAt: new Date(Date.now() + 60000).toISOString() }, canStart: true, loading: false, expired: false, error: null, busy: false, enabled: true, refresh: vi.fn(), start: vi.fn() } as unknown as GenerationEstimate;
    await render(createElement(LogoGenerationAction, { estimate, label: "Generate six concepts" }));
    expect(host.textContent).not.toMatch(/\$|cost|estimat/i);
    host.querySelector<HTMLButtonElement>("button")!.click();
    expect(estimate.start).toHaveBeenCalledOnce();
  });
});
