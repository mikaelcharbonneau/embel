// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { NamingApproachWidgets } from "@/components/naming/naming-approach-widgets";
import { namingFeedSchema, type NamingBrainRunSummary, type NamingFeed } from "@/domain/naming-brain";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import type { NamingPreferenceRevision } from "@/domain/project-naming";
import { contextSnapshotSchema } from "@/domain/projects";

const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { userId: id(1), generation: 1 }, projectId = id(2), when = "2026-10-18T03:00:00Z";
const context = contextSnapshotSchema.parse({ description: "Synthetic reload continuity project" });
const preferences: NamingPreferenceRevision = { ownerId: account.userId, projectId, version: 4, createdAt: when,
  preferences: { ...initialNamingPreferencesV2(context), approaches: ["real_words", "other_languages"], directness: "all", creativeLocale: "fr", maximumGraphemes: 12, excludedText: ["Synthetic excluded fragment"] } };
function feed(state: NamingBrainRunSummary["state"] | null = "running"): NamingFeed {
  return namingFeedSchema.parse({ version: 1, ownerId: account.userId, projectId, projectRevision: 5, preferencesVersion: 4,
    feedbackRevision: 0, steeringRevision: 0, demandSequence: 1, entries: [], nextCursor: null, consumedThrough: null,
    preparedSetId: null, paused: false, state: "active", availability: { status: "available", handlerVersion: "naming-brain-v1", protocol: "openai_agents", acceptedPolicyIdentity: "a".repeat(64) },
    activeRun: state ? { version: 1, ownerId: account.userId, projectId, runId: id(3), jobId: id(4), batchId: id(5), revision: 1,
      resumedFromRunId: null, canResume: state === "failed", state, projectRevision: 5, preferencesVersion: 4,
      feedbackRevision: 0, steeringRevision: 0, demandSequence: 1, snapshotHash: "b".repeat(64), acceptedPolicyIdentity: "a".repeat(64),
      progress: 20, preparedSetId: null, fulfillment: null, accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null }, createdAt: when, updatedAt: when } : null });
}
function fixture() {
  const request = vi.fn(), write = vi.fn();
  const memory = createNamingBrainMemory({ request, storage: () => ({ getItem: () => null, setItem: write, removeItem: vi.fn() }) });
  memory.bind(account);
  const load = (value = feed()) => memory.setFeed(account, projectId, previous => ({ ...previous, feed: value, status: "ready" }));
  return { memory, request, write, load };
}
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(memory: ReturnType<typeof createNamingBrainMemory>, saved = preferences) {
  const start = vi.fn(async () => true);
  await act(async () => root.render(createElement(NamingApproachWidgets, { memory, account, projectId, context, saved,
    blocked: false, runtimeReady: true, exploring: true, onContinue: start })));
  return start;
}
const heading = () => host.querySelector("#project-naming-preferences-heading")?.textContent;

for (const state of ["running", "failed"] as const) for (const order of ["preferences first", "run first"] as const) {
  it(`restores all five completed answers from a saved ${state} run after a cold reload (${order})`, async () => {
    const f = fixture(), original = structuredClone(preferences);
    if (order === "run first") f.load(feed(state));
    f.memory.connectPreferences(account, projectId, preferences, context);
    if (order === "preferences first") f.load(feed(state));
    const start = await render(f.memory);
    expect(heading()).toBe("Ready to explore your names?");
    expect(host.querySelectorAll(".guided-choice-answer")).toHaveLength(5);
    expect(host.querySelector('[aria-label="Your answer: Which language should the names work in?"]')?.textContent).toContain("fr");
    expect(f.memory.get(account, projectId)?.preferences?.saved).toEqual(original);
    expect(f.memory.hasUnsaved()).toBe(false); expect(f.request).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
}

it.each(["en", "fr"])("keeps autosaved but unconfirmed %s follow-ups incomplete when no run has started", async creativeLocale => {
  const f = fixture(), saved = { ...preferences, preferences: { ...preferences.preferences, creativeLocale } };
  f.load(feed(null)); await render(f.memory, saved);
  expect(heading()).toBe("Which language should the names work in?");
  expect(host.querySelector<HTMLInputElement>('[aria-label="Creative language"]')?.value).toBe(creativeLocale);
  expect(host.querySelectorAll(".guided-choice-answer")).toHaveLength(2);
  expect(f.memory.get(account, projectId)?.chatProgress?.confirmed.language).toBeUndefined();
  expect(f.request).not.toHaveBeenCalled();
});

it.each(["older preferences", "older project", "other owner", "other project"] as const)("does not infer completion from a run with %s", async mismatch => {
  const f = fixture(), value = feed();
  if (mismatch === "older preferences") value.activeRun!.preferencesVersion = 3;
  if (mismatch === "older project") value.activeRun!.projectRevision = 4;
  if (mismatch === "other owner") { value.ownerId = id(8); value.activeRun!.ownerId = id(8); }
  if (mismatch === "other project") { value.projectId = id(9); value.activeRun!.projectId = id(9); }
  f.load(namingFeedSchema.parse(value)); await render(f.memory);
  expect(heading()).toBe("Which language should the names work in?");
  expect(host.querySelectorAll(".guided-choice-answer")).toHaveLength(2); expect(f.request).not.toHaveBeenCalled();
});

it("keeps an explicitly reopened answer open through later run polls and same-owner verification", async () => {
  const f = fixture(); f.load(); await render(f.memory);
  expect(heading()).toBe("Ready to explore your names?");
  const edit = host.querySelector<HTMLButtonElement>('[aria-label="Edit answer: Which language should the names work in?"]')!;
  await act(async () => edit.click());
  await act(async () => f.load());
  expect(heading()).toBe("Which language should the names work in?");
  const verified = { ...account, generation: 2 };
  await act(async () => { f.memory.bind(null); f.memory.bind(verified); f.memory.setFeed(verified, projectId, previous => ({ ...previous, feed: feed() })); });
  expect(f.memory.get(verified, projectId)?.chatProgress?.activeStep).toBe("language");
  f.memory.setFeed(account, projectId, previous => ({ ...previous, feed: feed() }));
  expect(f.memory.get(verified, projectId)?.chatProgress?.activeStep).toBe("language");
});

it("does not interrupt a choice opened before the saved run arrives", () => {
  const f = fixture(); f.memory.connectPreferences(account, projectId, preferences, context);
  const progress = f.memory.get(account, projectId)!.chatProgress!;
  f.memory.setChatProgress(account, projectId, { ...progress, activeStep: "length" }); f.load();
  expect(f.memory.get(account, projectId)?.chatProgress?.activeStep).toBe("length");
  expect(f.memory.get(account, projectId)?.chatProgress?.confirmed.language).toBeUndefined();
});
