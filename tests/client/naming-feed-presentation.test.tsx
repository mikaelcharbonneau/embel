// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NamingFeedResults, NamingFeedStatus } from "@/components/naming/naming-feed-results";
import { NAMING_BRAINSTORM_CAUTION } from "@/domain/naming-brainstorm";
import { contextSnapshotSchema } from "@/domain/projects";
import {
  nameIdentityKey,
  namingStrategyBasis,
  namingStrategyKey,
  type ProjectNameEntry,
} from "@/domain/project-naming";
import type { NamingFeed } from "@/components/naming/use-naming-feed";

const context = contextSnapshotSchema.parse({ description: "Synthetic presentation fixture" }),
  ownerId = "a0000000-0000-4000-8000-000000000001",
  projectId = "b0000000-0000-4000-8000-000000000001",
  createdAt = "2026-10-29T18:00:00Z";
function brainstorm(n: number, value = `Juniper ${n}`): ProjectNameEntry {
  const candidateId = `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    candidate: {
      id: candidateId,
      ownerId,
      projectId,
      value,
      identityKey: nameIdentityKey(value),
      rationale: "A proposed nature association.",
      caution: NAMING_BRAINSTORM_CAUTION,
      verificationNotes: [],
      contextRevision: 1,
      strategyBasis: namingStrategyBasis(context),
      strategyKey: namingStrategyKey(context),
      createdAt,
      origin: {
        kind: "brainstorm",
        version: 1,
        profile: "brainstorm_v1",
        ownerId,
        projectId,
        candidateId,
        contextRevision: 1,
        value,
        batchId: candidateId,
        jobId: candidateId,
        runId: candidateId,
        callId: candidateId,
        responseId: "resp_synthetic",
        requestId: null,
        model: "synthetic-model",
        generatedAt: createdAt,
      },
    },
    retention: { ownerId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null },
  };
}
function feedOf(status: NamingFeed["status"], savedCount = 0) {
  return {
    status,
    state: {
      feed: {
        run: { target: 100, savedCount, state: status.kind === "active" ? "running" : "succeeded" },
      },
    },
    canMore: status.kind !== "active",
    more: vi.fn(async () => true),
    canStop: status.kind === "active",
    stop: vi.fn(async () => true),
    retry: vi.fn(),
    refresh: vi.fn(),
  } as unknown as NamingFeed;
}
async function mount(element: ReturnType<typeof createElement>, check: (host: HTMLElement) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"),
    root = createRoot(host);
  document.body.append(host);
  try {
    await act(async () => root.render(element));
    await check(host);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
}
const results = (props: Partial<Parameters<typeof NamingFeedResults>[0]>) =>
  createElement(NamingFeedResults, {
    entries: [],
    feed: feedOf({ kind: "idle" }),
    strategyKey: namingStrategyKey(context),
    pending: false,
    blocked: false,
    onRetain: vi.fn(),
    onSelect: vi.fn(),
    onInspect: vi.fn(),
    ...props,
  });

it("keeps favorite feedback usable while names are written, filling the page with their shape", async () => {
  const onRetain = vi.fn();
  const entries = Array.from({ length: 12 }, (_, index) => brainstorm(index + 1));
  const feed = feedOf({ kind: "active", message: "Generating names… 12 of 100", savedCount: 12 }, 12);
  await mount(results({ entries, feed, onRetain }), async (host) => {
    const favorite = host.querySelector<HTMLButtonElement>('[aria-label="Favorite Juniper 1"]')!;
    expect(favorite.disabled).toBe(false);
    await act(async () => favorite.click());
    expect(onRetain).toHaveBeenCalledWith(entries[0], "favorite");
    // 12 names and 28 cards in their final shape: the first 40 of this run.
    expect(host.querySelectorAll('[role="radiogroup"] input[type="radio"]')).toHaveLength(12);
    expect(host.querySelectorAll(".e-name-card--skeleton")).toHaveLength(28);
    expect(host.textContent).not.toMatch(/Generate \d+|Regenerate|Load more|\$/);
    const more = [...host.querySelectorAll("button")].find((button) => button.textContent === "Suggest more names")!;
    expect(more.disabled).toBe(true);
  });
});

it("shows 40 names a page as one-row cards, the whole name the choice, with Details and the heart", async () => {
  const onSelect = vi.fn(),
    onInspect = vi.fn(),
    onRetain = vi.fn();
  const entries = Array.from({ length: 100 }, (_, index) => brainstorm(index + 1));
  const feed = feedOf({ kind: "idle" }, 100);
  await mount(
    results({ entries, feed, onSelect, onInspect, onRetain, selectedId: entries[1]!.candidate.id }),
    async (host) => {
      const radios = () => [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
      expect(radios()).toHaveLength(40);
      expect(host.textContent).toContain("All 100");
      expect(radios()[1]!.checked).toBe(true);
      expect(host.querySelector("#project-name-" + entries[1]!.candidate.id)?.hasAttribute("data-selected")).toBe(true);
      // Compact cards show only the name: no domain status and no brainstorm label (both live in Details).
      const card = host.querySelector(".e-name-card")!;
      expect(card.textContent).toBe("Juniper 1");
      expect(host.querySelector('[role="radiogroup"]')?.textContent).not.toMatch(/\.com|domain|Unchecked brainstorm/i);
      await act(async () => radios()[4]!.click());
      expect(onSelect).toHaveBeenCalledWith(entries[4]);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Details for Juniper 3"]')!.click());
      expect(onInspect).toHaveBeenCalledWith(entries[2]);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Favorite Juniper 2"]')!.click());
      expect(onRetain).toHaveBeenCalledWith(entries[1], "favorite");
      const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
      await act(async () => button("Show 40 more names").click());
      expect(radios()).toHaveLength(80);
      await act(async () => button("Show 20 more names").click());
      expect(radios()).toHaveLength(100);
      expect(button("Suggest more names").disabled).toBe(false);
      await act(async () => button("Suggest more names").click());
      expect(feed.more).toHaveBeenCalledOnce();
    },
  );
});

it("says how to keep names when none are saved, and offers all names again", async () => {
  const entries = Array.from({ length: 3 }, (_, index) => brainstorm(index + 1));
  await mount(results({ entries }), async (host) => {
    const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
    await act(async () => button("Saved 0").click());
    expect(host.textContent).toContain("No saved names yet.");
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    await act(async () => button("Show all 3 names").click());
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  });
});

it("shows progress with Stop in the chat while names are written", async () => {
  const feed = feedOf({ kind: "active", message: "Generating names… 40 of 100", savedCount: 40 }, 40);
  await mount(createElement(NamingFeedStatus, { feed, blocked: false }), async (host) => {
    expect(host.textContent).toBe("Generating names… 40 of 100Stop");
    expect(host.querySelector(".e-progress__track")).not.toBeNull();
    await act(async () => host.querySelector("button")!.click());
    expect(feed.stop).toHaveBeenCalledOnce();
  });
  await mount(createElement(NamingFeedStatus, { feed, blocked: false, stopInReplyBox: true }), async (host) => {
    expect(host.querySelector("button")).toBeNull();
  });
});
it.each([
  [{ kind: "stopped", message: "Stopped. 40 names saved." }, "Stopped. 40 names saved.", []],
  [
    { kind: "failed", message: "Name generation was interrupted before it started. Try again." },
    "Name generation was interrupted before it started. Try again.",
    ["Try again"],
  ],
  [
    { kind: "error", message: "Name generation couldn’t be confirmed. Try again." },
    "Name generation couldn’t be confirmed. Try again.",
    ["Try again"],
  ],
  [
    { kind: "unavailable", message: "AI name generation is unavailable right now." },
    "AI name generation is unavailable right now.",
    ["Check again"],
  ],
  [{ kind: "idle" }, "", []],
] as const)("shows plain generation status %# with only its own action", async (status, text, buttons) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const retry = vi.fn(async () => true),
    feed = { status, canStop: false, stop: vi.fn(), retry, refresh: vi.fn() } as unknown as NamingFeed;
  const host = document.createElement("div"),
    root = createRoot(host);
  document.body.append(host);
  try {
    await act(async () => root.render(createElement(NamingFeedStatus, { feed, blocked: false })));
    expect(host.textContent).toBe(text + buttons.join(""));
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual(buttons);
    if (buttons[0] === "Try again") {
      await act(async () => host.querySelector("button")!.click());
      expect(retry).toHaveBeenCalledOnce();
    }
    expect(host.textContent).not.toMatch(/\$|reconciliation|prepared|unresolved|Resume/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

// docs/state-machines.md, "The same server situation": one answer for the three AI step screens.
it("keeps progress and Stop under a quiet note when updates are delayed", async () => {
  const note = "Updates are delayed. Still working, and checking again.";
  const feed = feedOf({ kind: "active", message: "Generating names… 40 of 100", savedCount: 40, note }, 40);
  await mount(createElement(NamingFeedStatus, { feed, blocked: false }), async (host) => {
    expect(host.textContent).toBe(`Generating names… 40 of 100Stop${note}`);
    expect(host.querySelector(".e-progress__track")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
it("offers no Try again for a refusal that would be refused again", async () => {
  const message = "You’ve reached today’s limit for name generation. Try again tomorrow. Your names are saved.";
  const feed = feedOf({ kind: "error", message, retry: false });
  await mount(createElement(NamingFeedStatus, { feed, blocked: false }), async (host) => {
    expect(host.textContent).toBe(message);
    expect(host.querySelector("button")).toBeNull();
  });
});
it("keeps progress and Stop when Stop couldn't be confirmed, with Try again for the Stop", async () => {
  const feed = feedOf(
    {
      kind: "active",
      message: "Generating names… 40 of 100",
      savedCount: 40,
      stopUnconfirmed: "Stop couldn’t be confirmed.",
    },
    40,
  );
  await mount(createElement(NamingFeedStatus, { feed, blocked: false }), async (host) => {
    expect(host.textContent).toBe("Generating names… 40 of 100StopStop couldn’t be confirmed.Try again");
    expect(host.querySelector(".e-progress__track")).not.toBeNull();
    const [stop, again] = [...host.querySelectorAll("button")];
    expect(stop!.disabled).toBe(false);
    await act(async () => again!.click());
    expect(feed.retry).toHaveBeenCalledOnce();
  });
  // With Stop in the reply box the progress and Try again still show here.
  await mount(createElement(NamingFeedStatus, { feed, blocked: false, stopInReplyBox: true }), async (host) => {
    expect(host.textContent).toBe("Generating names… 40 of 100Stop couldn’t be confirmed.Try again");
  });
});
it("says there are no credits left where the other steps say it, and offers no Try again that would be refused", async () => {
  const note = "You have no credits left this month. New credits arrive on December 1. See plans";
  const at = { noCredits: true, startRefused: true, creditsPeriodEnd: "2026-12-01T00:00:00Z" };
  await mount(
    createElement(NamingFeedStatus, { feed: { ...feedOf({ kind: "idle" }), ...at }, blocked: false }),
    async (host) => {
      expect(host.textContent).toBe(note);
      expect(host.querySelector('a[href="/plans"]')).not.toBeNull();
      expect(host.textContent).not.toMatch(/\$/);
    },
  );
  const failed = { kind: "failed", message: "Name generation couldn’t finish. Try again." } as const;
  await mount(createElement(NamingFeedStatus, { feed: { ...feedOf(failed), ...at }, blocked: false }), async (host) => {
    expect(host.textContent).toBe(failed.message + note);
    expect(host.querySelector("button")).toBeNull();
  });
  // The out-of-credits message already says it, and a run still working needs no note yet.
  const used = "You’ve used this month’s credits. They renew on December 1. Your names are saved.";
  for (const status of [
    { kind: "error", message: used, retry: false },
    { kind: "active", message: "Generating names… 40 of 100", savedCount: 40 },
  ] as const)
    await mount(createElement(NamingFeedStatus, { feed: { ...feedOf(status), ...at }, blocked: false }), async (host) =>
      expect(host.textContent).not.toContain("You have no credits left"),
    );
});
