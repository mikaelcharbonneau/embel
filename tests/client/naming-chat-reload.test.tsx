// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { NamingApproachWidgets } from "@/components/naming/naming-approach-widgets";
import { namingGenerationFeedSchema, type NamingGenerationFeed, type NamingRunState } from "@/domain/naming-generation";
import type { NamingChatCheckpoint } from "@/domain/naming-chat-checkpoint";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import type { NamingPreferenceRevision } from "@/domain/project-naming";
import { contextSnapshotSchema } from "@/domain/projects";
import {
  confirmNamingChatQuestion,
  initialNamingChatProgress,
  namingChatCheckpoint,
  namingChatQuestions,
} from "@/components/naming/naming-chat-progress";

const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { userId: id(1), generation: 1 },
  projectId = id(2),
  when = "2026-10-18T03:00:00Z";
const context = contextSnapshotSchema.parse({ description: "Synthetic reload continuity project" });
const preferences: NamingPreferenceRevision = {
  ownerId: account.userId,
  projectId,
  version: 4,
  createdAt: when,
  preferences: {
    ...initialNamingPreferencesV2(context),
    approaches: ["real_words", "other_languages"],
    directness: "all",
    creativeLocale: "fr",
    maximumGraphemes: 12,
    excludedText: ["Synthetic excluded fragment"],
  },
};
function feed(state: NamingRunState | null = "running"): NamingGenerationFeed {
  return namingGenerationFeedSchema.parse({
    version: 2,
    projectId,
    availability: { status: "available" },
    entries: [],
    nextCursor: null,
    run: state
      ? {
          runId: id(3),
          jobId: id(4),
          kind: "initial",
          state,
          target: 100,
          savedCount: 20,
          errorCode: state === "failed" ? "response_failed" : null,
          usage: null,
          createdAt: when,
          finishedAt: state === "running" ? null : when,
        }
      : null,
  });
}
function fixture() {
  const request = vi.fn(),
    write = vi.fn();
  const memory = createNamingBrainMemory({
    request,
    storage: () => ({ getItem: () => null, setItem: write, removeItem: vi.fn() }),
  });
  memory.bind(account);
  const load = (value = feed()) =>
    memory.setFeed(account, projectId, (previous) => ({ ...previous, feed: value, status: "ready" }));
  return { memory, request, write, load };
}
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(
  memory: ReturnType<typeof createNamingBrainMemory>,
  saved = preferences,
  options: {
    savedChat?: NamingChatCheckpoint;
    onSaveProgress?: (checkpoint: NamingChatCheckpoint) => Promise<boolean>;
    exploring?: boolean;
  } = {},
) {
  const start = vi.fn(async () => true);
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
        exploring: options.exploring ?? true,
        savedChat: options.savedChat,
        onContinue: start,
        onSaveProgress: options.onSaveProgress ?? (async () => true),
      }),
    ),
  );
  return start;
}
const heading = () => host.querySelector("#project-naming-preferences-heading")?.textContent;

for (const state of ["running", "failed"] as const)
  for (const order of ["preferences first", "run first"] as const) {
    it(`restores all three completed answers from a saved ${state} run after a cold reload (${order})`, async () => {
      const f = fixture(),
        original = structuredClone(preferences);
      if (order === "run first") f.load(feed(state));
      f.memory.connectPreferences(account, projectId, preferences, context);
      if (order === "preferences first") f.load(feed(state));
      const start = await render(f.memory);
      expect(heading()).toBe("Your naming direction");
      expect(host.querySelectorAll(".guided-choice-answer")).toHaveLength(3);
      expect(host.querySelector('[aria-label="Creative language"]')).toBeNull();
      expect(f.memory.get(account, projectId)?.preferences?.saved).toEqual(original);
      expect(f.memory.hasUnsaved()).toBe(false);
      expect(f.request).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    });
  }

it.each(["en", "fr"])(
  "keeps autosaved but unconfirmed %s follow-ups incomplete when no run has started",
  async (creativeLocale) => {
    const f = fixture(),
      saved = { ...preferences, preferences: { ...preferences.preferences, creativeLocale } };
    f.load(feed(null));
    await render(f.memory, saved);
    expect(heading()).toBe("Any length limits or text to include or avoid?");
    expect(f.memory.get(account, projectId)?.preferences?.draft.creativeLocale).toBe(creativeLocale);
    expect(host.querySelectorAll(".guided-choice-answer")).toHaveLength(2);
    expect(f.memory.get(account, projectId)?.chatProgress?.confirmed.language).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
  },
);

it("does not infer completion from another project's run", async () => {
  const f = fixture();
  f.load(namingGenerationFeedSchema.parse({ ...feed(), projectId: id(9) }));
  await render(f.memory);
  expect(heading()).toBe("Any length limits or text to include or avoid?");
  expect(host.querySelectorAll(".guided-choice-answer")).toHaveLength(2);
  expect(f.request).not.toHaveBeenCalled();
});

it("keeps an explicitly reopened answer open through later run polls and same-owner verification", async () => {
  const f = fixture();
  f.load();
  await render(f.memory);
  expect(heading()).toBe("Your naming direction");
  const edit = host.querySelector<HTMLButtonElement>(
    '[aria-label="Edit answer: Any length limits or text to include or avoid?"]',
  )!;
  await act(async () => edit.click());
  await act(async () => f.load());
  expect(heading()).toBe("Any length limits or text to include or avoid?");
  const verified = { ...account, generation: 2 };
  await act(async () => {
    f.memory.bind(null);
    f.memory.bind(verified);
    f.memory.setFeed(verified, projectId, (previous) => ({ ...previous, feed: feed() }));
  });
  expect(f.memory.get(verified, projectId)?.chatProgress?.activeStep).toBe("length");
  f.memory.setFeed(account, projectId, (previous) => ({ ...previous, feed: feed() }));
  expect(f.memory.get(verified, projectId)?.chatProgress?.activeStep).toBe("length");
});

it("does not interrupt a choice opened before the saved run arrives", () => {
  const f = fixture();
  f.memory.connectPreferences(account, projectId, preferences, context);
  const progress = f.memory.get(account, projectId)!.chatProgress!;
  f.memory.setChatProgress(account, projectId, { ...progress, activeStep: "length" });
  f.load();
  expect(f.memory.get(account, projectId)?.chatProgress?.activeStep).toBe("length");
  expect(f.memory.get(account, projectId)?.chatProgress?.confirmed.language).toBeUndefined();
});

async function continueAnswer() {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === "Continue",
  )!;
  expect(button).toBeDefined();
  await act(async () => button.click());
}
const defaultChoices: NamingPreferenceRevision = {
  ...preferences,
  preferences: { ...initialNamingPreferencesV2(context), approaches: ["invented"], directness: "suggestive" },
};

it("restores explicitly accepted default answers after a cold reload before any exploration run", async () => {
  let durable: NamingChatCheckpoint | undefined;
  const saveProgress = vi.fn(async (value: NamingChatCheckpoint) => {
    durable = structuredClone(value);
    return true;
  });
  const f = fixture();
  f.load(feed(null));
  const start = await render(f.memory, defaultChoices, { exploring: false, onSaveProgress: saveProgress });
  expect(heading()).toBe("Any length limits or text to include or avoid?");
  for (const next of ["Your naming direction"]) {
    await continueAnswer();
    expect(heading()).toBe(next);
  }
  expect(saveProgress).toHaveBeenCalledTimes(1);
  expect(durable).toMatchObject({
    version: 1,
    preferencesVersion: 4,
    confirmed: { length: "[null,null]", fragments: "[[],[]]" },
  });
  expect(f.request).not.toHaveBeenCalled();
  expect(start).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  root = createRoot(host);
  const cold = fixture();
  cold.load(feed(null));
  await render(cold.memory, defaultChoices, { exploring: false, savedChat: durable });
  expect(heading()).toBe("Your naming direction");
  expect(host.querySelectorAll(".guided-choice-answer")).toHaveLength(3);
  expect(host.textContent).toContain("Flexible length");
  expect(host.textContent).toContain("No required text");
  expect(cold.request).not.toHaveBeenCalled();
  expect(cold.memory.hasUnsaved()).toBe(false);
});

it("resumes the next question from a partially completed saved checkpoint", async () => {
  let durable: NamingChatCheckpoint | undefined;
  const f = fixture();
  await render(f.memory, defaultChoices, {
    onSaveProgress: async (value) => {
      durable = value;
      return true;
    },
  });
  await continueAnswer();
  expect(heading()).toBe("Your naming direction");
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(fixture().memory, defaultChoices, { savedChat: durable });
  expect(heading()).toBe("Your naming direction");
  expect(host.querySelectorAll(".guided-choice-answer")).toHaveLength(3);
});

it("waits for the durable acknowledgement and does not advance on an uncertain view save", async () => {
  let finish!: (saved: boolean) => void, durable: NamingChatCheckpoint | undefined;
  const f = fixture();
  const start = await render(f.memory, defaultChoices, {
    onSaveProgress: (value) => {
      durable = value;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await continueAnswer();
  expect(heading()).toBe("Any length limits or text to include or avoid?");
  expect(f.memory.get(account, projectId)?.chatProgress?.confirmed.language).toBeUndefined();
  await act(async () => finish(false));
  expect(heading()).toBe("Any length limits or text to include or avoid?");
  expect(host.textContent).toContain("This answer could not be confirmed as saved");
  expect(start).not.toHaveBeenCalled();
  // A lost ACK may nevertheless have committed. A fresh owned read is authority.
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(fixture().memory, defaultChoices, { savedChat: durable });
  expect(heading()).toBe("Your naming direction");
});

it("does not publish a checkpoint acknowledgement after the verified account changes", async () => {
  let finish!: (saved: boolean) => void;
  const f = fixture();
  await render(f.memory, defaultChoices, {
    onSaveProgress: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await continueAnswer();
  const other = { userId: id(8), generation: 2 };
  await act(async () => f.memory.bind(other));
  await act(async () => finish(true));
  expect(f.memory.get(other, projectId)).toBeNull();
  expect(f.memory.get(account, projectId)).toBeNull();
});

it.each(["notes", "language", "length", "fragments"] as const)(
  "keeps unchanged acknowledged defaults after a later %s edit and reload",
  async (edit) => {
    const value = defaultChoices.preferences;
    if (value.version !== 2) throw new Error("Expected V2 fixture");
    const complete = namingChatQuestions().reduce(
      (progress, question) => confirmNamingChatQuestion(progress, question, value),
      initialNamingChatProgress(value),
    );
    const checkpoint = namingChatCheckpoint(complete, value, defaultChoices.version);
    const changed = {
      ...value,
      ...(edit === "notes"
        ? { notes: "A quieter naming direction" }
        : edit === "language"
          ? { creativeLocale: "fr" }
          : edit === "length"
            ? { maximumGraphemes: 12 }
            : { excludedText: ["new fragment"] }),
    };
    await render(fixture().memory, { ...defaultChoices, version: 5, preferences: changed }, { savedChat: checkpoint });
    expect(heading()).toBe(
      edit === "notes" || edit === "language"
        ? "Your naming direction"
        : "Any length limits or text to include or avoid?",
    );
    const record = host.querySelectorAll(".guided-choice-answer");
    expect(record).toHaveLength(edit === "notes" || edit === "language" ? 3 : 2);
  },
);
