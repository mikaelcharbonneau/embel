// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NamingFeedResults } from "@/components/naming/naming-feed-results";
import { contextSnapshotSchema } from "@/domain/projects";
import { nameIdentityKey, namingStrategyBasis, namingStrategyKey, type ProjectNameEntry } from "@/domain/project-naming";
import type { useNamingFeed } from "@/components/naming/use-naming-feed";
it("keeps favorite feedback usable while generation runs and offers no ordinary regenerate control", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const context = contextSnapshotSchema.parse({ description: "Synthetic presentation fixture" }), ownerId = "a0000000-0000-4000-8000-000000000001", projectId = "b0000000-0000-4000-8000-000000000001", candidateId = "c0000000-0000-4000-8000-000000000001", createdAt = "2026-10-16T12:00:00Z";
  const entry: ProjectNameEntry = { candidate: { id: candidateId, ownerId, projectId, value: "Juniper", identityKey: nameIdentityKey("Juniper"), rationale: "A synthetic creative interpretation.", contextRevision: 1, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), createdAt, origin: { kind: "local_import", ownerId, projectId, candidateId, contextRevision: 1, source: { id: candidateId, value: "Juniper", createdAt, origin: "manual", history: [] }, capturedContext: context } }, retention: { ownerId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null } };
  const feed = { entries: [{ entryId: candidateId, position: 1, entry }], state: { pending: {}, acknowledged: true, outcome: null, steering: null, error: null, status: "pending", feed: { activeRun: { state: "running" }, availability: { status: "available" } } }, canExplore: true, interacting: true, attachSentinel: () => {}, stop: vi.fn(), steer: vi.fn() } as unknown as ReturnType<typeof useNamingFeed>;
  const onRetain = vi.fn(), host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  try {
    await act(async () => root.render(createElement(NamingFeedResults, { feed, strategyKey: namingStrategyKey(context), pending: false, blocked: false, onRetain, onSelect: vi.fn(), onInspect: vi.fn(), onWorkshop: vi.fn(), onModify: vi.fn(), onHistory: vi.fn() })));
    const favorite = host.querySelector<HTMLButtonElement>('[aria-label="Favorite Juniper"]')!;
    expect(favorite.disabled).toBe(false); await act(async () => favorite.click()); expect(onRetain).toHaveBeenCalledWith(entry, "favorite");
    expect(host.textContent).toContain("Exploring your next names"); expect(host.textContent).not.toMatch(/Generate \d+|Regenerate|Load more/);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
