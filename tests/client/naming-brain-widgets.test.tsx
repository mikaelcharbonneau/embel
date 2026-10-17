// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NamingApproachWidgets } from "@/components/naming/naming-approach-widgets";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { contextSnapshotSchema } from "@/domain/projects";
const owner = "a0000000-0000-4000-8000-000000000001", projectId = "b0000000-0000-4000-8000-000000000001", account = { userId: owner, generation: 1 };
const context = contextSnapshotSchema.parse({ description: "A synthetic coffee studio", personality: { sincerity: 60, excitement: 30, competence: 40, sophistication: 20, ruggedness: 10 } });
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function button(label: string) { const item = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.startsWith(label)); expect(item, label).toBeDefined(); return item!; }
async function click(label: string) { await act(async () => button(label).click()); }
function receipt(body: { expectedPreferencesVersion: number; preferences: unknown }) { return { session: { ownerId: owner, projectId }, preferences: { ownerId: owner, projectId, version: body.expectedPreferencesVersion + 1, preferences: body.preferences, createdAt: "2026-10-16T12:00:00Z" } }; }
function memoryWithSave() { const request = vi.fn(async (_path, _schema, options) => receipt(options.body)); const memory = createNamingBrainMemory({ storage: () => null, request: request as never }); memory.bind(account); return { memory, request }; }
async function render(memory: ReturnType<typeof createNamingBrainMemory>, start = vi.fn(async () => true), exploring = false) { await act(async () => root.render(createElement(NamingApproachWidgets, { memory, account, projectId, context, saved: null, blocked: false, runtimeReady: true, onContinue: start, exploring }))); return start; }

it("asks one decision at a time, preserves every approach, and revisits without admitting work", async () => {
  const { memory } = memoryWithSave(), start = await render(memory);
  expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
  expect(host.querySelectorAll('[role="radio"]')).toHaveLength(0);
  expect(host.querySelector('.naming-save-status')?.textContent).not.toBe("Saved");
  expect(host.textContent).toContain("Apple, BlackBerry, Jaguar"); expect(host.textContent).toMatch(/metaphor, symbolism and unexpected associations/i);
  expect(host.querySelectorAll('input[type="range"]')).toHaveLength(0); expect(host.textContent).toContain("Saved brand personality");
  expect(host.querySelectorAll('.naming-approach-option')).toHaveLength(11);
  await click("Real words"); await click("Invented words"); await click("Other languages"); await click("Continue");
  expect(host.querySelectorAll('.naming-approach-option')).toHaveLength(0);
  expect(host.textContent).toContain("Real words · Invented words · Other languages");
  await click("Direct"); await click("Suggestive");
  const selected = host.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')!;
  await act(async () => selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(memory.get(account, projectId)?.preferences?.draft.directness).toBe("open_ended");
  await click("Continue"); expect(host.querySelector('textarea')?.closest('label')?.textContent).toContain("Source languages");
  expect(start).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Edit answer: Which approaches would you like to explore?"]')!.click());
  expect(host.querySelector('[aria-pressed="true"]')?.textContent).toContain("Real words");
  expect(memory.get(account, projectId)?.preferences?.draft.approaches).toEqual(["real_words", "invented", "other_languages"]);
});

it("waits for each acknowledged answer before advancing and requires final explicit exploration", async () => {
  let finish!: (value: unknown) => void; let held = true;
  const request = vi.fn((_path, _schema, options) => held ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(receipt(options.body)));
  const memory = createNamingBrainMemory({ storage: () => null, request: request as never }); memory.bind(account);
  const start = await render(memory);
  await click("Real words"); await click("Continue");
  expect(start).not.toHaveBeenCalled(); expect(host.textContent).toContain("Saving");
  expect(host.querySelectorAll('[role="radio"]')).toHaveLength(0);
  const body = request.mock.calls[0]![2].body;
  held = false; await act(async () => finish(receipt(body)));
  expect(host.querySelectorAll('[role="radio"]')).toHaveLength(4);
  await click("Explore all"); await click("Continue");
  await click("Continue"); await click("Continue"); await click("Continue");
  expect(start).not.toHaveBeenCalled(); expect(host.textContent).toContain("Ready to explore your names?");
  await click("Start exploring"); expect(start).toHaveBeenCalledTimes(1);
});

it("keeps the same conversation and unsent composer draft across the results transition", async () => {
  const { memory } = memoryWithSave(); const start = await render(memory);
  await click("Real words"); await click("Continue");
  await act(async () => memory.setSteeringDraft(account, projectId, draft => ({ ...draft, instruction: "Synthetic quiet and warm direction" })));
  const composer = host.querySelector('form textarea');
  await render(memory, start, true);
  expect(host.querySelector('form textarea')).toBe(composer);
  expect((composer as HTMLTextAreaElement).value).toBe("Synthetic quiet and warm direction");
  expect(host.querySelectorAll('[role="radio"]')).toHaveLength(4);
  expect(host.textContent).toContain("Real words");
});

it("saves real guidance before clearing the composer and never admits a run", async () => {
  const { memory, request } = memoryWithSave(); const start = await render(memory);
  await act(async () => memory.setSteeringDraft(account, projectId, draft => ({ ...draft, instruction: "Synthetic quiet and warm direction" })));
  await act(async () => host.querySelector<HTMLButtonElement>('button[title="Save naming guidance"]')!.click());
  expect(request).toHaveBeenCalledTimes(1);
  expect(memory.get(account, projectId)?.preferences?.saved?.preferences.notes).toBe("Synthetic quiet and warm direction");
  expect(memory.get(account, projectId)?.steeringDraft.instruction).toBe("");
  expect(host.textContent).toContain("Saved with your Naming choices"); expect(start).not.toHaveBeenCalled();
});

it("resumes the unconfirmed language follow-up after remount and same-owner verification", async () => {
  const { memory } = memoryWithSave(), start = await render(memory);
  await click("Other languages"); await click("Continue"); await click("Explore all"); await click("Continue");
  const question = "Any languages or roots to draw from?";
  expect(host.querySelector('#project-naming-preferences-heading')?.textContent).toBe(question);
  const saved = memory.get(account, projectId)!.preferences!.saved;
  await act(async () => root.unmount()); root = createRoot(host);
  memory.bind(null); const verified = { ...account, generation: 2 }; memory.bind(verified);
  await act(async () => root.render(createElement(NamingApproachWidgets, { memory, account: verified, projectId, context, saved, blocked: false, runtimeReady: true, onContinue: start })));
  expect(host.querySelector('#project-naming-preferences-heading')?.textContent).toBe(question);
  for (const unseen of [question, "Which language should the names work in?", "Do you have a length in mind?", "Any text to include or avoid?"]) expect(host.querySelector(`[aria-label="Your answer: ${unseen}"]`)).toBeNull();
  expect([...host.querySelectorAll('button')].some(item => item.textContent === "Start exploring")).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

it("a fresh memory conservatively asks unseen follow-ups with saved values, then requires final exploration", async () => {
  const first = memoryWithSave(), start = await render(first.memory);
  await click("Other languages"); await click("Continue"); await click("Explore all"); await click("Continue");
  const saved = first.memory.get(account, projectId)!.preferences!.saved!;
  await act(async () => root.unmount()); root = createRoot(host);
  const fresh = memoryWithSave();
  await act(async () => root.render(createElement(NamingApproachWidgets, { memory: fresh.memory, account, projectId, context, saved, blocked: false, runtimeReady: true, onContinue: start })));
  expect(host.querySelector('#project-naming-preferences-heading')?.textContent).toBe("Any languages or roots to draw from?");
  expect(fresh.memory.get(account, projectId)?.preferences?.draft).toEqual(saved.preferences);
  expect(fresh.request).not.toHaveBeenCalled();
  await click("Continue"); await click("Continue"); await click("Continue"); await click("Continue");
  expect(host.querySelector('#project-naming-preferences-heading')?.textContent).toBe("Ready to explore your names?");
  expect(start).not.toHaveBeenCalled(); await click("Start exploring"); expect(start).toHaveBeenCalledTimes(1);
});

it("asks a newly relevant follow-up after editing a completed approach answer", async () => {
  const { memory } = memoryWithSave(), start = await render(memory);
  await click("Real words"); await click("Continue"); await click("Explore all");
  await click("Continue"); await click("Continue"); await click("Continue"); await click("Continue");
  expect(host.querySelector('#project-naming-preferences-heading')?.textContent).toBe("Ready to explore your names?");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Edit answer: Which approaches would you like to explore?"]')!.click());
  await click("Other languages"); await click("Continue");
  expect(host.querySelector('#project-naming-preferences-heading')?.textContent).toBe("Any languages or roots to draw from?");
  expect(host.querySelector('[aria-label="Your answer: Any languages or roots to draw from?"]')).toBeNull();
  expect(start).not.toHaveBeenCalled();
});
