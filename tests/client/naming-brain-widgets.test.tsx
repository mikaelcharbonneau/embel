// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NamingApproachWidgets } from "@/components/naming/naming-approach-widgets";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { NAMING_APPROACHES, initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import type { NamingPreferenceRevision } from "@/domain/project-naming";
import { contextSnapshotSchema } from "@/domain/projects";
const owner = "a0000000-0000-4000-8000-000000000001",
  projectId = "b0000000-0000-4000-8000-000000000001",
  account = { userId: owner, generation: 1 };
const context = contextSnapshotSchema.parse({
  description: "A synthetic coffee studio",
  personality: { sincerity: 60, excitement: 30, competence: 40, sophistication: 20, ruggedness: 10 },
});
const retiredQuestions = [
  "Any languages or roots to draw from?",
  "Any people or places to draw from?",
  "Any stories or cultural references to explore?",
];
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function button(label: string) {
  const item = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.startsWith(label),
  );
  expect(item, label).toBeDefined();
  return item!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function receipt(body: { expectedPreferencesVersion: number; preferences: unknown }) {
  return {
    session: { ownerId: owner, projectId },
    preferences: {
      ownerId: owner,
      projectId,
      version: body.expectedPreferencesVersion + 1,
      preferences: body.preferences,
      createdAt: "2026-10-16T12:00:00Z",
    },
  };
}
function memoryWithSave() {
  const request = vi.fn(async (_path, _schema, options) => receipt(options.body));
  const memory = createNamingBrainMemory({ storage: () => null, request: request as never });
  memory.bind(account);
  return { memory, request };
}
async function render(
  memory: ReturnType<typeof createNamingBrainMemory>,
  start = vi.fn(async () => true),
  exploring = false,
) {
  await act(async () =>
    root.render(
      createElement(NamingApproachWidgets, {
        memory,
        account,
        projectId,
        context,
        saved: null,
        blocked: false,
        runtimeReady: true,
        onContinue: start,
        onSaveProgress: async () => true,
        exploring,
      }),
    ),
  );
  return start;
}

it("focuses the next question on commit without a later animation frame stealing a keyboard choice", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  const { memory } = memoryWithSave();
  await render(memory);
  expect(
    [...host.querySelectorAll("a")]
      .find((link) => link.textContent === "Open the Strategy conversation")
      ?.getAttribute("href"),
  ).toBe(`/brands/account/${projectId}?view=strategy`);
  await click("Real words");
  await act(async () => {
    button("Continue").focus();
    button("Continue").click();
  });
  const choice = button("Explore all");
  choice.focus();
  await act(async () => {
    for (const frame of frames.splice(0)) frame(16);
  });
  expect(document.activeElement).toBe(choice);
  await act(async () => (document.activeElement as HTMLButtonElement).click());
  expect(choice.getAttribute("aria-checked")).toBe("true");
  await act(async () => {
    button("Continue").focus();
    button("Continue").click();
  });
  expect(document.activeElement).toBe(host.querySelector("#project-naming-preferences-heading"));
  expect(host.querySelector("#project-naming-preferences-heading")?.textContent).toBe(
    "Any length limits or text to include or avoid?",
  );
});

it("does not take focus from a composer used while an answer save is pending", async () => {
  let finish!: (value: unknown) => void;
  const request = vi.fn(
    (_path, _schema, options) =>
      new Promise((resolve) => {
        finish = () => resolve(receipt(options.body));
      }),
  );
  const memory = createNamingBrainMemory({ storage: () => null, request: request as never });
  memory.bind(account);
  await render(memory);
  await click("Real words");
  await act(async () => {
    button("Continue").focus();
    button("Continue").click();
  });
  const composer = host.querySelector<HTMLTextAreaElement>("form textarea")!;
  composer.focus();
  await act(async () => {
    finish(undefined);
  });
  await act(async () => {
    vi.advanceTimersByTime(32);
  });
  expect(host.querySelectorAll('[role="radio"]')).toHaveLength(4);
  expect(document.activeElement).toBe(composer);
});

it("asks one decision at a time, preserves every approach, and revisits without admitting work", async () => {
  const { memory } = memoryWithSave(),
    start = await render(memory);
  expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
  expect(host.querySelectorAll('[role="radio"]')).toHaveLength(0);
  expect(host.querySelector(".naming-save-status")?.textContent).not.toBe("Saved");
  expect(host.textContent).toContain("Apple, BlackBerry, Jaguar");
  expect(host.textContent).toMatch(/metaphor, symbolism and unexpected associations/i);
  expect(host.querySelectorAll('input[type="range"]')).toHaveLength(0);
  expect(host.textContent).toContain("Saved brand personality");
  expect(host.querySelectorAll(".naming-approach-option")).toHaveLength(11);
  await click("Real words");
  await click("Invented words");
  await click("Other languages");
  await click("Continue");
  expect(host.querySelectorAll(".naming-approach-option")).toHaveLength(0);
  expect(host.textContent).toContain("Real words · Invented words · Other languages");
  await click("Direct");
  await click("Suggestive");
  const selected = host.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')!;
  await act(async () => selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(memory.get(account, projectId)?.preferences?.draft.directness).toBe("open_ended");
  await click("Continue");
  expect(host.querySelector("#project-naming-preferences-heading")?.textContent).toBe(
    "Any length limits or text to include or avoid?",
  );
  expect(start).not.toHaveBeenCalled();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Change answer: Which approaches would you like to explore?"]')!
      .click(),
  );
  expect(host.querySelector('[aria-pressed="true"]')?.textContent).toContain("Real words");
  expect(memory.get(account, projectId)?.preferences?.draft.approaches).toEqual([
    "real_words",
    "invented",
    "other_languages",
  ]);
});

it("waits for each acknowledged answer before advancing and starts generation on the final acknowledged answer", async () => {
  let finish!: (value: unknown) => void;
  let held = true;
  const request = vi.fn((_path, _schema, options) =>
    held
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(receipt(options.body)),
  );
  const memory = createNamingBrainMemory({ storage: () => null, request: request as never });
  memory.bind(account);
  const start = await render(memory);
  await click("Real words");
  await click("Continue");
  expect(start).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Saving");
  expect(host.querySelectorAll('[role="radio"]')).toHaveLength(0);
  const body = request.mock.calls[0]![2].body;
  held = false;
  await act(async () => finish(receipt(body)));
  expect(host.querySelectorAll('[role="radio"]')).toHaveLength(4);
  await click("Explore all");
  await click("Continue");
  await click("Continue");
  expect(host.textContent).toContain("Your naming direction");
  expect(start).toHaveBeenCalledTimes(1);
});

it("keeps the same conversation and unsent composer draft across the results transition", async () => {
  const { memory } = memoryWithSave();
  const start = await render(memory);
  await click("Real words");
  await click("Continue");
  await act(async () =>
    memory.setSteeringDraft(account, projectId, (draft) => ({
      ...draft,
      instruction: "Synthetic quiet and warm direction",
    })),
  );
  const composer = host.querySelector("form textarea");
  await render(memory, start, true);
  expect(host.querySelector("form textarea")).toBe(composer);
  expect((composer as HTMLTextAreaElement).value).toBe("Synthetic quiet and warm direction");
  expect(host.querySelectorAll('[role="radio"]')).toHaveLength(4);
  expect(host.textContent).toContain("Real words");
});

it("saves real guidance before clearing the composer and never admits a run", async () => {
  const { memory, request } = memoryWithSave();
  const start = await render(memory);
  await act(async () =>
    memory.setSteeringDraft(account, projectId, (draft) => ({
      ...draft,
      instruction: "Synthetic quiet and warm direction",
    })),
  );
  await act(async () => host.querySelector<HTMLButtonElement>('button[title="Save naming guidance"]')!.click());
  expect(request).toHaveBeenCalledTimes(1);
  expect(memory.get(account, projectId)?.preferences?.saved?.preferences.notes).toBe(
    "Synthetic quiet and warm direction",
  );
  expect(memory.get(account, projectId)?.steeringDraft.instruction).toBe("");
  expect(host.textContent).toContain("Saved with your Naming choices");
  expect(start).not.toHaveBeenCalled();
});

it("resumes the unconfirmed language follow-up after remount and same-owner verification", async () => {
  const { memory } = memoryWithSave(),
    start = await render(memory);
  await click("Other languages");
  await click("Continue");
  await click("Explore all");
  await click("Continue");
  const question = "Any length limits or text to include or avoid?";
  expect(host.querySelector("#project-naming-preferences-heading")?.textContent).toBe(question);
  const saved = memory.get(account, projectId)!.preferences!.saved;
  await act(async () => root.unmount());
  root = createRoot(host);
  memory.bind(null);
  const verified = { ...account, generation: 2 };
  memory.bind(verified);
  await act(async () =>
    root.render(
      createElement(NamingApproachWidgets, {
        memory,
        account: verified,
        projectId,
        context,
        saved,
        blocked: false,
        runtimeReady: true,
        onContinue: start,
        onSaveProgress: async () => true,
      }),
    ),
  );
  expect(host.querySelector("#project-naming-preferences-heading")?.textContent).toBe(question);
  for (const unseen of [
    question,
    "Do you have a length in mind?",
    "Any text to include or avoid?",
    ...retiredQuestions,
  ])
    expect(host.querySelector(`[aria-label="Your answer: ${unseen}"]`)).toBeNull();
  expect([...host.querySelectorAll("button")].some((item) => item.textContent === "Start exploring")).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

it("a fresh memory conservatively asks unseen follow-ups with saved values, then starts on the final answer", async () => {
  const first = memoryWithSave(),
    start = await render(first.memory);
  await click("Other languages");
  await click("Continue");
  await click("Explore all");
  await click("Continue");
  const saved = first.memory.get(account, projectId)!.preferences!.saved!;
  await act(async () => root.unmount());
  root = createRoot(host);
  const fresh = memoryWithSave();
  await act(async () =>
    root.render(
      createElement(NamingApproachWidgets, {
        memory: fresh.memory,
        account,
        projectId,
        context,
        saved,
        blocked: false,
        runtimeReady: true,
        onContinue: start,
        onSaveProgress: async () => true,
      }),
    ),
  );
  expect(host.querySelector("#project-naming-preferences-heading")?.textContent).toBe(
    "Any length limits or text to include or avoid?",
  );
  expect(fresh.memory.get(account, projectId)?.preferences?.draft).toEqual(saved.preferences);
  expect(fresh.request).not.toHaveBeenCalled();
  await click("Continue");
  expect(host.querySelector("#project-naming-preferences-heading")?.textContent).toBe("Your naming direction");
  expect(start).toHaveBeenCalledTimes(1);
});

it("keeps confirmed choices complete when newly selected approaches used to add inspiration questions", async () => {
  const { memory } = memoryWithSave(),
    start = await render(memory);
  await click("Real words");
  await click("Continue");
  await click("Explore all");
  await click("Continue");
  await click("Continue");
  expect(host.querySelector("#project-naming-preferences-heading")?.textContent).toBe("Your naming direction");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Change answer: Which approaches would you like to explore?"]')!
      .click(),
  );
  await click("Other languages");
  await click("Classical roots");
  await click("People & places");
  await click("Stories & culture");
  await click("Continue");
  expect(host.querySelector("#project-naming-preferences-heading")?.textContent).toBe("Your naming direction");
  for (const question of retiredQuestions) expect(host.textContent).not.toContain(question);
  expect(memory.get(account, projectId)?.preferences?.saved?.preferences).toMatchObject({
    approaches: ["real_words", "other_languages", "classical_roots", "people_places", "stories_culture"],
  });
  expect(start).toHaveBeenCalledTimes(1);
});

it("never asks retired inspiration questions or renders their answers and preserves every saved field", async () => {
  const { memory, request } = memoryWithSave(),
    start = vi.fn(async () => true);
  const saved: NamingPreferenceRevision = {
    ownerId: owner,
    projectId,
    version: 4,
    createdAt: "2026-10-16T12:00:00Z",
    preferences: {
      ...initialNamingPreferencesV2(context),
      approaches: NAMING_APPROACHES.map((approach) => approach.id),
      directness: "all",
      sourceLanguages: ["French", "Latin"],
      heritageNotes: "Synthetic saved family place",
      culturalNotes: "Synthetic saved story reference",
    },
  };
  await act(async () =>
    root.render(
      createElement(NamingApproachWidgets, {
        memory,
        account,
        projectId,
        context,
        saved,
        blocked: false,
        runtimeReady: true,
        onContinue: start,
        onSaveProgress: async () => true,
      }),
    ),
  );
  expect(host.querySelector("#project-naming-preferences-heading")?.textContent).toBe(
    "Any length limits or text to include or avoid?",
  );
  expect(request).not.toHaveBeenCalled();
  for (const question of retiredQuestions) expect(host.textContent).not.toContain(question);
  await act(async () =>
    memory.editPreferences(account, projectId, {
      ...memory.get(account, projectId)!.preferences!.draft,
      creativeLocale: "fr",
    }),
  );
  for (const next of ["Your naming direction"]) {
    await click("Continue");
    expect(host.querySelector("#project-naming-preferences-heading")?.textContent).toBe(next);
    for (const question of retiredQuestions) expect(host.textContent).not.toContain(question);
  }
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![2].body.preferences).toEqual({ ...saved.preferences, creativeLocale: "fr" });
  expect(memory.get(account, projectId)?.preferences?.saved?.preferences).toEqual({
    ...saved.preferences,
    creativeLocale: "fr",
  });
  expect(start).toHaveBeenCalledTimes(1);
});
