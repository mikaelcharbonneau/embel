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
async function click(label: string) { const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.startsWith(label)); expect(button).toBeDefined(); await act(async () => button!.click()); }
it("lets several approaches coexist with one directness choice and inherits personality", async () => {
  const memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
  await act(async () => root.render(createElement(NamingApproachWidgets, { memory, account, projectId, context, saved: null, blocked: false, runtimeReady: false, onContinue: async () => true })));
  expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
  expect(host.querySelector('.naming-save-status')?.textContent).not.toBe("Saved");
  expect(host.textContent).toContain("Apple, BlackBerry, Jaguar"); expect(host.textContent).toMatch(/metaphor, symbolism and unexpected associations/i);
  expect(host.querySelectorAll('input[type="range"]')).toHaveLength(0); expect(host.textContent).toContain("Saved brand personality");
  await click("Real words"); await click("Invented words"); await click("Direct"); await click("Suggestive");
  expect(memory.get(account, projectId)?.preferences?.draft).toMatchObject({ approaches: ["real_words", "invented"], directness: "suggestive" });
  const selected = host.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')!;
  await act(async () => selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(memory.get(account, projectId)?.preferences?.draft.directness).toBe("open_ended");
  await click("Other languages"); expect(host.querySelector('[aria-label="Source languages"]')).not.toBeNull();
});
it("Continue waits for the acknowledged preference save without dropping later edits", async () => {
  let finish!: (value: unknown) => void; const requests: unknown[] = [];
  const request = vi.fn((_path, _schema, options) => { requests.push(options.body); return new Promise(resolve => { finish = resolve; }); });
  const memory = createNamingBrainMemory({ storage: () => null, request: request as never }); memory.bind(account);
  const start = vi.fn(async () => true);
  await act(async () => root.render(createElement(NamingApproachWidgets, { memory, account, projectId, context, saved: null, blocked: false, runtimeReady: true, onContinue: start })));
  await click("Real words"); await click("Explore all"); await click("Continue");
  expect(start).not.toHaveBeenCalled(); expect(host.textContent).toContain("Saving");
  const body = requests[0] as { preferences: unknown };
  await act(async () => finish({ session: { ownerId: owner, projectId }, preferences: { ownerId: owner, projectId, version: 1, preferences: body.preferences, createdAt: "2026-10-16T12:00:00Z" } }));
  expect(start).toHaveBeenCalledTimes(1); expect(host.textContent).toContain("Saved");
});
