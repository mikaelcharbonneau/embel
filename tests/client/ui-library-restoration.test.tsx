// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { NameCandidateCard } from "@/components/naming/name-candidate-card";
import type { NameCandidate } from "@/components/naming/local-names";
import { IdeasWorkspace } from "@/components/ideas/ideas-workspace";
import { createIdeaDraftMemory } from "@/components/ideas/ideas-draft-memory";
import { emptyIdeaContent } from "@/components/ideas/ideas-client";
const fixture = vi.hoisted(() => ({ memory: null as ReturnType<typeof createIdeaDraftMemory> | null, push: vi.fn() }));
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: fixture.push }) }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: { status: "ready", userId: owner, generation: 1 }, ideaDrafts: fixture.memory, isCurrent: () => true, expire: vi.fn() }), AccountStatus: () => null }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
 Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); fixture.memory = createIdeaDraftMemory();
 host = document.createElement("div"); document.body.append(host); root = createRoot(host);
 vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ownerId: owner, items: [], nextCursor: null })));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const candidate: NameCandidate = { source: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", value: "Fixture name", createdAt: "2026-10-07T00:00:00Z", origin: "manual", history: [] }, runId: null, context: contextSnapshotSchema.parse({ description: "A synthetic naming brief" }), explanation: "Entered manually", favorite: false, saved: false };
describe("original library composition with current behavior", () => {
 it("renders a names row without losing compare, favorite, save, seed or provenance controls", async () => {
  const favorite = vi.fn(), save = vi.fn(), compare = vi.fn(), seed = vi.fn(), promote = vi.fn();
  await act(async () => root.render(createElement(NameCandidateCard, { row: true, candidate, compared: false, comparisonFull: false, onFavorite: favorite, onSave: save, onCompare: compare, onSeed: seed, onCreateBrand: promote })));
  expect(host.querySelector(".names-candidate-row")).not.toBeNull();
  for (const label of ["Compare Fixture name", "Favorite Fixture name", "Save Fixture name"]) await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Use as seed"))!.click());
  expect(compare).toHaveBeenCalledOnce(); expect(favorite).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledOnce(); expect(seed).toHaveBeenCalledOnce();
  expect(host.querySelector("details")?.textContent).toContain("A synthetic naming brief");
  expect(host.querySelector("details")?.textContent).toContain("Create brand");
 });
 it("keeps new Ideas capture collapsed while the library is the primary view", async () => {
  await act(async () => root.render(createElement(IdeasWorkspace)));
  expect(host.querySelector<HTMLDivElement>("#idea-capture-panel")!.hidden).toBe(true);
  const toggle = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Add idea"))!;
  await act(async () => toggle.click());
  expect(host.querySelector<HTMLDivElement>("#idea-capture-panel")!.hidden).toBe(false);
  await act(async () => fixture.memory!.setCapture({ ownerId: owner, generation: 1, content: { ...emptyIdeaContent(), title: "Retained typed idea" }, intent: null }));
  await act(async () => toggle.click()); await act(async () => toggle.click());
  expect(host.querySelector<HTMLInputElement>('#idea-capture-panel input')?.value).toBe("Retained typed idea");
 });
 it("automatically reopens retained capture on remount", async () => {
  fixture.memory!.setCapture({ ownerId: owner, generation: 1, content: { ...emptyIdeaContent(), title: "Recovered idea" }, intent: null });
  await act(async () => root.render(createElement(IdeasWorkspace)));
  expect(host.querySelector<HTMLDivElement>("#idea-capture-panel")!.hidden).toBe(false);
  expect(host.querySelector<HTMLInputElement>('#idea-capture-panel input')?.value).toBe("Recovered idea");
 });
});
