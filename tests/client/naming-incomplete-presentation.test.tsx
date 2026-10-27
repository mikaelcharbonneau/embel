// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NamingFeedTail } from "@/components/naming/naming-feed-results";
import type { useNamingFeed } from "@/components/naming/use-naming-feed";

it.each([false, true])("shows the persisted 85/100 partial count and reviews names without dispatch (saved continuation=%s)", async canResumeSaved => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const resume = vi.fn(), retry = vi.fn(), review = vi.fn();
  const feed = { entries: [], canResume: false, resume, retry, state: { status: "incomplete", outcome: null,
    feed: { paused: canResumeSaved, preparedSetId: canResumeSaved ? "saved-set" : null, availability: { status: "available" },
      activeRun: { state: "partial", canResume: false, canResumeSaved,
        fulfillment: { status: "partial", acceptedCount: 85, targetCount: 100, missingCount: 15, coverageSatisfied: false, message: "85 of 100 names are saved. Exploration continues while the remaining names are reviewed." } } } } } as unknown as ReturnType<typeof useNamingFeed>;
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(createElement(NamingFeedTail, { feed, blocked: false, onModify: vi.fn(), onReviewSaved: review })));
    expect(host.textContent).toContain("Incomplete exploration.");
    expect(host.textContent).toContain("85 of 100 names saved.");
    expect(host.textContent).not.toMatch(/being generated|Exploring your next names/);
    expect(host.textContent).not.toContain("Exploration continues");
    expect(resume).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "View saved names")!.click());
    expect(review).toHaveBeenCalledOnce(); expect(resume).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("replaces stale running copy with terminal facts and reviews choices without restarting", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const modify = vi.fn(), resume = vi.fn();
  const run = { state: "partial", canResume: false, runId: "run", revision: 2 };
  const fulfillment = { status: "partial", acceptedCount: 95, targetCount: 100, missingCount: 5, coverageSatisfied: false };
  const feed = { canResume: false, resume, state: { status: "incomplete", outcome: { status: "incomplete", run, fulfillment, message: "Exploration continues while the remaining names are reviewed." }, feed: { availability: { status: "available" }, activeRun: run } } } as unknown as ReturnType<typeof useNamingFeed>;
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(createElement(NamingFeedTail, { feed, blocked: false, onModify: modify })));
    expect(host.textContent).toContain("95 of 100 names saved.");
    expect(host.textContent).toContain("This exploration ended");
    expect(host.textContent).not.toContain("Exploration continues");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Review Naming choices")!.click());
    expect(modify).toHaveBeenCalledOnce(); expect(resume).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});

it("does not present 100 saved names with missing approach coverage as complete", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const feed = { state: { feed: { availability: { status: "available" }, activeRun: { state: "partial", canResume: false,
    fulfillment: { status: "partial", acceptedCount: 100, targetCount: 100, missingCount: 0, coverageSatisfied: false, message: "Coverage is incomplete." } } } } } as unknown as ReturnType<typeof useNamingFeed>;
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(createElement(NamingFeedTail, { feed, blocked: false, onModify: vi.fn() })));
    expect(host.textContent).toContain("Incomplete exploration.");
    expect(host.textContent).toContain("100 of 100 names saved.");
    expect(host.textContent).toContain("Some selected naming approaches are still missing.");
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
