// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NamingFeedTail } from "@/components/naming/naming-feed-results";
import { NamingApproachWidgets } from "@/components/naming/naming-approach-widgets";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { namingFeedSchema } from "@/domain/naming-brain";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { contextSnapshotSchema } from "@/domain/projects";
import type { useNamingFeed } from "@/components/naming/use-naming-feed";

const account = { userId: "a0000000-0000-4000-8000-000000000001", generation: 1 }, projectId = "b0000000-0000-4000-8000-000000000001";
const context = contextSnapshotSchema.parse({ description: "Synthetic blocked provider fixture" });
const saved = { ownerId: account.userId, projectId, version: 1, createdAt: "2026-10-24T00:00:00Z", preferences: { ...initialNamingPreferencesV2(context), approaches: ["real_words" as const], directness: "all" as const } };

it.each(["provider_budget_control_unavailable", "provider_configuration_rejected", "provider_request_rejected"] as const)("shows actionable persisted %s without generation retry or misleading progress", async code => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const data = namingFeedSchema.parse({ version: 1, ownerId: account.userId, projectId, projectRevision: 1, preferencesVersion: 1,
    feedbackRevision: 0, steeringRevision: 0, demandSequence: 0, entries: [], nextCursor: null, consumedThrough: null, preparedSetId: null, activeRun: null,
    paused: false, state: "active", availability: { status: "unavailable", code: "provider_budget_control_unavailable" }, failure: { code, retryable: false } });
  const memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
  const retry = vi.fn(), resume = vi.fn(), start = vi.fn(), refresh = vi.fn();
  const feed = { state: { feed: data, status: "incomplete", error: null }, entries: [], refresh, retry, resume } as unknown as ReturnType<typeof useNamingFeed>;
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  try {
    await act(async () => root.render(createElement(NamingApproachWidgets, { memory, account, projectId, context, saved, blocked: false, runtimeReady: false,
      generationUnavailable: true, exploring: false, onContinue: start, onSaveProgress: async () => true, generationStatus: createElement(NamingFeedTail, { feed, blocked: false, onModify: vi.fn() }) })));
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Continue")!.click());
    expect(host.textContent).toContain("AI name generation is unavailable");
    expect(host.textContent).toContain("Contact support");
    expect(host.textContent).not.toMatch(/Retry generation|Resume unfinished|0 of 100|being generated/);
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Check generation status")!.click());
    expect(refresh).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
