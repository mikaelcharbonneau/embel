// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { createIdentityDraftMemory } from "@/components/identity/identity-draft-memory";
import { useProjectIdentity, type IdentityReferenceHint } from "@/components/identity/use-project-identity";
import { IDENTITY_REQUEST_TIMEOUT_MS } from "@/components/identity/account-identity-client";
import type { useAccountSession, VerifiedAccount } from "@/components/workspace/account-session";
import { getIdentityFreshness } from "@/domain/project-identity";
import { IMAGE_MODEL } from "@/domain/providers";
import { fixtureOverview, fixtureOwner, fixtureProject, fixtureSystem } from "./project-identity-fixtures";

type Session = ReturnType<typeof useAccountSession>["session"];
const fixture = vi.hoisted(() => ({
  session: null as unknown as Session,
  drafts: null as unknown as ReturnType<typeof createAccountDraftMemory>,
  identityDrafts: null as unknown as ReturnType<typeof createIdentityDraftMemory>,
  isCurrent: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => fixture }));
let host: HTMLDivElement, root: Root, api: ReturnType<typeof useProjectIdentity>, hint: IdentityReferenceHint;
let reads: { path: string; signal: AbortSignal; resolve: (response: Response) => void }[];
function Harness() {
  const value = useProjectIdentity(fixtureProject, hint);
  useLayoutEffect(() => {
    api = value;
  });
  return null;
}
async function render() {
  await act(async () => root.render(<Harness />));
}
async function tick() {
  await act(async () => vi.advanceTimersByTimeAsync(1));
}
async function resolveRead(index: number, value: unknown, status = 200) {
  await act(async () => reads[index]!.resolve(Response.json(value, { status })));
}
async function start() {
  await render();
  await tick();
  await resolveRead(0, fixtureOverview({ selected: true }));
}
const detail = (system = fixtureSystem()) => {
  const overview = fixtureOverview();
  return {
    ownerId: fixtureOwner,
    projectId: fixtureProject,
    system,
    currentBasis: overview.currentBasis,
    freshness: getIdentityFreshness(system.input.basis, overview.currentBasis),
  };
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reads = [];
  fixture.session = { status: "ready", userId: fixtureOwner, generation: 1 };
  fixture.drafts = createAccountDraftMemory();
  fixture.identityDrafts = createIdentityDraftMemory();
  fixture.isCurrent
    .mockReset()
    .mockImplementation(
      (account: VerifiedAccount) =>
        fixture.session.status === "ready" &&
        fixture.session.userId === account.userId &&
        fixture.session.generation === account.generation,
    );
  fixture.expire.mockReset();
  hint = { ownerId: fixtureOwner, projectId: fixtureProject, generation: 1, referenceRevision: 1, pending: false };
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      if (path.endsWith("/identity/batches"))
        return Promise.resolve(
          Response.json({
            ownerId: fixtureOwner,
            projectId: fixtureProject,
            availability: {
              ownerId: fixtureOwner,
              projectId: fixtureProject,
              status: "unavailable",
              operation: "identity.image",
              requestedModel: IMAGE_MODEL,
              reason: "runtime_unavailable",
            },
            latest: null,
          }),
        );
      return new Promise<Response>((resolve) => reads.push({ path, signal: init.signal!, resolve }));
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("saved Identity read stability", () => {
  it("recovers a timed-out choice by reading its saved result without another selection", async () => {
    await render();
    await tick();
    await resolveRead(0, fixtureOverview());
    const read = vi.mocked(fetch).getMockImplementation()!,
      writes: RequestInit[] = [];
    let acknowledge!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((path, init) => {
      if (init?.method !== "POST") return read(path, init);
      writes.push(init);
      return new Promise<Response>((resolve) => {
        acknowledge = resolve;
      });
    });
    let choosing!: Promise<void>;
    await act(async () => {
      choosing = api.chooseSystem(false, fixtureSystem());
    });
    expect(api.pending).toBe(true);
    expect(api.selectionCheckAvailable).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(IDENTITY_REQUEST_TIMEOUT_MS));
    await act(async () => choosing);
    expect(writes[0]!.signal!.aborted).toBe(true);
    expect(api.pending).toBe(false);
    expect(api.selectionUncertain).toBe(true);
    expect(api.selectionCheckAvailable).toBe(true);
    expect(api.blocked).toBe(true);
    expect(api.notice).toBeNull();
    await act(async () => api.chooseSystem(false, fixtureSystem()));
    expect(writes).toHaveLength(1);
    let checking!: Promise<void>;
    await act(async () => {
      checking = api.refresh();
    });
    const saved = fixtureOverview({ selected: true });
    await resolveRead(1, saved);
    await act(async () => checking);
    expect(api.selectionUncertain).toBe(false);
    expect(api.pending).toBe(false);
    expect(api.system?.id).toBe(saved.currentSelection!.system.id);
    expect(api.blocked).toBe(false);
    await act(async () =>
      acknowledge(Response.json({ session: saved.session, currentSelection: saved.currentSelection })),
    );
    expect(api.system?.id).toBe(saved.currentSelection!.system.id);
    expect(api.selectionUncertain).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it("retains the exact preference intent after its acknowledgement times out", async () => {
    await start();
    const read = vi.mocked(fetch).getMockImplementation()!,
      writes: RequestInit[] = [];
    vi.mocked(fetch).mockImplementation((path, init) => {
      if (init?.method !== "PATCH") return read(path, init);
      writes.push(init);
      return new Promise<Response>(() => {});
    });
    await act(async () => api.setPreferenceValues({ ...api.preferenceValues!, notes: "A calmer visual direction" }));
    let saving!: Promise<void>;
    await act(async () => {
      saving = api.savePreferences();
    });
    const original = api.preferenceDraft?.pending;
    expect(original?.request.preferences.notes).toBe("A calmer visual direction");
    await act(async () => vi.advanceTimersByTimeAsync(IDENTITY_REQUEST_TIMEOUT_MS));
    await act(async () => saving);
    expect(api.pending).toBe(false);
    expect(api.preferenceDraft?.pending).toEqual(original);
    expect(api.preferencesDirty).toBe(true);
    expect(api.notice).toBeNull();
    await act(async () => api.savePreferences());
    expect(writes).toHaveLength(1);
    let checking!: Promise<void>;
    await act(async () => {
      checking = api.refresh();
    });
    await resolveRead(1, fixtureOverview({ selected: true }));
    await act(async () => checking);
    expect(api.preferenceRebaseReady).toBe(true);
    expect(api.preferenceDraft?.pending).toEqual(original);
    expect(writes).toHaveLength(1);
  });

  it("distinguishes unavailable saving from an active read and recovers without selecting or generating", async () => {
    await render();
    await tick();
    const unavailable = {
      ...fixtureOverview(),
      saveAvailability: { status: "unavailable", reason: "trusted_transaction_unavailable" },
    };
    await resolveRead(0, unavailable);
    expect(api.checked).toBe(true);
    expect(api.loading).toBe(false);
    expect(api.blocked).toBe(true);
    expect(api.selectionBlockedReason).toBe("Saving your direction is temporarily unavailable. Your boards are saved.");
    expect(api.selectionCheckAvailable).toBe(true);
    await act(async () => api.chooseSystem(false, fixtureSystem()));
    expect(reads).toHaveLength(1);
    let retry!: Promise<void>;
    await act(async () => {
      retry = api.refresh();
    });
    expect(api.selectionBlockedReason).toBe("Checking your saved choice…");
    await resolveRead(1, fixtureOverview());
    await act(async () => retry);
    expect(api.blocked).toBe(false);
    expect(api.selectionBlockedReason).toBeNull();
    expect(api.selectionCheckAvailable).toBe(false);
    expect(reads).toHaveLength(2);
  });

  it("settles a timed-out saved-choice read and keeps an explicit retry available", async () => {
    await render();
    await tick();
    const first = reads[0]!;
    first.signal.addEventListener("abort", () => first.resolve(Response.json({})), { once: true });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(first.signal.aborted).toBe(true);
    expect(api.loading).toBe(false);
    expect(api.checked).toBe(false);
    expect(api.blocked).toBe(true);
    expect(api.selectionCheckAvailable).toBe(true);
    expect(api.selectionBlockedReason).toBe("Your saved choice could not be checked. Please try again.");
    await tick();
    expect(reads).toHaveLength(1);
    let retry!: Promise<void>;
    await act(async () => {
      retry = api.refresh();
    });
    await resolveRead(1, fixtureOverview());
    await act(async () => retry);
    expect(api.checked).toBe(true);
    expect(api.blocked).toBe(false);
  });

  it("explains unsaved preferences without suggesting that a read can save or discard them", async () => {
    await start();
    await act(async () => api.setPreferenceValues({ ...api.preferenceValues!, notes: "A changed visual preference" }));
    expect(api.blocked).toBe(true);
    expect(api.preferencesDirty).toBe(true);
    expect(api.selectionBlockedReason).toBe("Save or discard your identity edits before choosing a direction.");
    expect(api.selectionCheckAvailable).toBe(false);
    await act(async () => api.discardPreference());
    expect(api.blocked).toBe(false);
    expect(api.selectionBlockedReason).toBeNull();
  });

  it("settles a failed reference-head check without looping, while explicit and new-target checks remain eligible", async () => {
    await start();
    const previous = api.overview;
    hint = { ...hint, referenceRevision: 2 };
    await render();
    await tick();
    expect(reads).toHaveLength(2);
    await resolveRead(1, { error: "Unavailable" }, 503);
    expect(api.loading).toBe(false);
    expect(api.error).not.toBeNull();
    expect(api.overview).toBe(previous);
    expect(api.referencesPending).toBe(true);
    expect(api.blocked).toBe(true);
    await tick();
    await render();
    await tick();
    expect(reads).toHaveLength(2);
    let retry!: Promise<void>;
    await act(async () => {
      retry = api.refresh();
    });
    expect(reads).toHaveLength(3);
    await resolveRead(2, fixtureOverview({ selected: true }));
    await act(async () => retry);
    await tick();
    expect(reads).toHaveLength(3);
    expect(api.referencesPending).toBe(true);
    hint = { ...hint, referenceRevision: 3 };
    await render();
    await tick();
    expect(reads).toHaveLength(4);
    await resolveRead(3, { error: "Unavailable" }, 503);
    await tick();
    expect(reads).toHaveLength(4);
  });

  it("also settles successful but still-lagging reference reads without treating stale inputs as checked for writes", async () => {
    await start();
    hint = { ...hint, referenceRevision: 2 };
    await render();
    await tick();
    await resolveRead(1, fixtureOverview({ selected: true }));
    await tick();
    await tick();
    expect(reads).toHaveLength(2);
    expect(api.loading).toBe(false);
    expect(api.referencesPending).toBe(true);
    expect(api.blocked).toBe(true);
    hint = { ...hint, referenceRevision: 1 };
    await render();
    expect(api.referencesPending).toBe(false);
    expect(api.blocked).toBe(false);
  });

  it("does not blank or refetch an already verified displayed system, but retries failed targets", async () => {
    await start();
    const selected = api.system!;
    await act(async () => {
      void api.viewSystem(selected.id);
    });
    expect(reads).toHaveLength(1);
    expect(api.detailLoading).toBe(false);
    expect(api.system).toBe(selected);
    const alternate = fixtureSystem(undefined, 1);
    let opening!: Promise<void>;
    await act(async () => {
      opening = api.viewSystem(alternate.id);
    });
    expect(reads).toHaveLength(2);
    expect(api.detailLoading).toBe(true);
    await resolveRead(1, { error: "Unavailable" }, 503);
    await act(async () => opening);
    expect(api.error).not.toBeNull();
    // The fallback selection is visible after a failed detail read, not a
    // reason to suppress an explicit recovery read of that same selection.
    await act(async () => {
      opening = api.viewSystem(selected.id);
    });
    expect(reads).toHaveLength(3);
    await resolveRead(2, detail(selected));
    await act(async () => opening);
    await act(async () => {
      opening = api.viewSystem(alternate.id);
    });
    expect(reads).toHaveLength(4);
    await resolveRead(3, detail(alternate));
    await act(async () => opening);
    const shown = api.system;
    await act(async () => {
      void api.viewSystem(alternate.id);
    });
    expect(reads).toHaveLength(4);
    expect(api.system).toBe(shown);
    expect(api.detailLoading).toBe(false);
  });

  it("does not reuse an attempted target or publish its late response after verification changes the client lifetime", async () => {
    await start();
    hint = { ...hint, referenceRevision: 2 };
    await render();
    await tick();
    expect(reads).toHaveLength(2);
    fixture.session = { status: "checking", generation: 2 };
    await render();
    expect(api.overview).toBeNull();
    expect(api.system).toBeNull();
    expect(reads[1]!.signal.aborted).toBe(true);
    fixture.session = { status: "ready", userId: fixtureOwner, generation: 2 };
    hint = { ...hint, generation: 2 };
    await render();
    await tick();
    expect(reads).toHaveLength(3);
    await resolveRead(1, fixtureOverview({ selected: true }));
    expect(api.overview).toBeNull();
    await resolveRead(2, fixtureOverview({ selected: true }));
    await tick();
    expect(reads).toHaveLength(4);
  });
});
