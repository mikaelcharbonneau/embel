// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import {
  getNamingReadiness,
  initialNamingPreferences,
  nameIdentityKey,
  namingStrategyBasis,
  namingStrategyKey,
  type ProjectNameEntry,
} from "@/domain/project-naming";
import { projectNamingOverviewSchema, type ProjectNamingOverview } from "@/domain/naming-jobs";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { initialNamingView, useProjectNaming } from "@/components/naming/use-project-naming";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { reviewedStrategy } from "../fixtures/reviewed-strategy";

const mock = vi.hoisted(() => ({
  memory: null as ReturnType<typeof createAccountDraftMemory> | null,
  current: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ drafts: mock.memory, isCurrent: mock.current, expire: mock.expire }),
}));
const projectId = "bbbbbbbb-1111-4111-8111-111111111111",
  when = "2026-10-04T10:00:00.000Z";
const base = `/api/projects/${projectId}/naming`;
const id = (index: number) => `eeeeeeee-1111-4111-8111-${String(index).padStart(12, "0")}`;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
let root: Root | null, host: HTMLDivElement, api: ReturnType<typeof useProjectNaming>, account: VerifiedAccount;
let state: ProjectNamingOverview, rows: ProjectNameEntry[], fetcher: ReturnType<typeof vi.fn>;
function Harness() {
  const value = useProjectNaming({ account, projectId });
  useLayoutEffect(() => {
    api = value;
  });
  return null;
}
async function render() {
  await act(async () => root!.render(createElement(Harness)));
}
async function expireRequest() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
}
async function refresh() {
  await act(async () => api.refresh());
}
const writes = () => fetcher.mock.calls.filter(([, init]) => init.method !== "GET");
function candidate(index: number): ProjectNameEntry {
  const value = `Fixture ${index}`,
    createdAt = new Date(Date.parse(when) + index * 1000).toISOString();
  return {
    candidate: {
      id: id(index),
      ownerId: account.userId,
      projectId,
      value,
      identityKey: nameIdentityKey(value),
      rationale: "Synthetic imported name.",
      contextRevision: 1,
      strategyBasis: namingStrategyBasis(state.project.context),
      strategyKey: namingStrategyKey(state.project.context),
      origin: {
        kind: "local_import",
        ownerId: account.userId,
        projectId,
        candidateId: id(index),
        contextRevision: 1,
        source: { id: id(index), value, createdAt, origin: "manual", history: [] },
        capturedContext: state.project.context,
      },
      createdAt,
    },
    retention: {
      ownerId: account.userId,
      projectId,
      candidateId: id(index),
      revision: 0,
      favorite: false,
      saved: false,
      updatedAt: null,
    },
  };
}
function overview(path = base) {
  const url = new URL(path, "https://fixture.invalid"),
    cursor = url.searchParams.get("cursorId");
  const start = cursor ? rows.findIndex((entry) => entry.candidate.id === cursor) + 1 : 0;
  const items = rows.slice(start, start + 100),
    last = items.at(-1)?.candidate;
  return projectNamingOverviewSchema.parse({
    ...state,
    candidates: {
      ownerId: account.userId,
      projectId,
      items,
      nextCursor: last && start + items.length < rows.length ? { id: last.id, createdAt: last.createdAt } : null,
    },
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  account = { status: "ready", userId: crypto.randomUUID(), generation: 1 };
  mock.current
    .mockReset()
    .mockImplementation(
      (value: VerifiedAccount) => value.userId === account.userId && value.generation === account.generation,
    );
  mock.expire.mockReset();
  mock.memory = createAccountDraftMemory();
  const project = accountProjectSchema.parse({
    id: projectId,
    owner_id: account.userId,
    title: "Naming recovery fixture",
    scope: "complete_brand",
    current_revision: 1,
    created_at: when,
    context: reviewedStrategy({ description: "A neighborhood lunch kitchen" }),
  });
  mock.memory.set({
    ownerId: account.userId,
    generation: 1,
    saved: project,
    draft: accountProjectDraft(project),
    conflict: false,
  });
  const owned = { ownerId: account.userId, projectId };
  state = projectNamingOverviewSchema.parse({
    project,
    readiness: getNamingReadiness(project.context, project.scope),
    session: {
      ...owned,
      revision: 1,
      currentPreferencesVersion: 1,
      latestBatchSequence: 0,
      currentSelectionId: null,
      viewRevision: 1,
      viewState: initialNamingView,
      createdAt: when,
      updatedAt: when,
    },
    preferences: { ...owned, version: 1, preferences: initialNamingPreferences(project.context), createdAt: when },
    currentSelection: null,
    batches: { ...owned, items: [], nextCursor: null },
    candidates: { ...owned, items: [], nextCursor: null },
    availability: { status: "unavailable", operation: "naming.generate", reason: "naming_policy_unavailable" },
    jobs: [],
    screening: {
      domains: { status: "not_checked", reason: "integration_unavailable" },
      handles: { status: "not_checked", reason: "integration_unavailable" },
      trademarks: { status: "not_checked", reason: "integration_unavailable" },
    },
  });
  rows = [];
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json(overview(path));
    throw new Error("Unexpected fixture mutation");
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Naming acknowledgement recovery", () => {
  it("bounds a stalled first read and ignores its late snapshot after a successful refresh", async () => {
    const stalled = deferred<Response>();
    fetcher.mockImplementationOnce(() => stalled.promise);
    await render();
    await expireRequest();
    expect(api.readError).toContain("could not be confirmed");
    await refresh();
    expect(api.overview?.project.current_revision).toBe(1);
    const next = { ...state.project, current_revision: 2, title: "Current saved title" };
    state = { ...state, project: next };
    await refresh();
    await act(async () =>
      stalled.resolve(Response.json({ ...overview(), project: { ...next, current_revision: 1, title: "Late title" } })),
    );
    expect(api.overview?.project.title).toBe("Current saved title");
    expect(writes()).toHaveLength(0);
  });

  it("keeps a selection and newer draft edits after its saved response is lost", async () => {
    rows = [candidate(1)];
    await render();
    const stalled = deferred<Response>();
    fetcher.mockImplementation(async (path: string, init: RequestInit) => {
      if (init.method === "POST") {
        const project = {
          ...state.project,
          current_revision: 2,
          context: {
            ...state.project.context,
            selectedName: rows[0]!.candidate.value,
            intake: { ...state.project.context.intake, suppliedName: rows[0]!.candidate.value },
          },
        };
        const selection = {
          id: id(999),
          ownerId: account.userId,
          projectId,
          candidateId: id(1),
          projectRevision: 2,
          previousSelectionId: null,
          acceptedEarlierContext: false,
          createdAt: when,
        };
        state = {
          ...state,
          project,
          session: { ...state.session!, currentSelectionId: selection.id },
          currentSelection: { selection, candidate: rows[0]!.candidate },
        };
        return stalled.promise;
      }
      return Response.json(overview(path));
    });
    await act(async () => {
      void api.select(rows[0]!, false);
    });
    await act(async () => {
      const before = mock.memory!.get(projectId)!;
      mock.memory!.set({ ...before, draft: { ...before.draft, title: "Newer unsaved strategy edit" } });
    });
    await expireRequest();
    expect(api.pending).toBe(false);
    expect(api.overview?.currentSelection?.candidate.id).toBe(id(1));
    expect(mock.memory!.get(projectId)).toMatchObject({
      draft: { title: "Newer unsaved strategy edit" },
      conflict: true,
    });
    expect(writes()).toHaveLength(1);
  });
});

// docs/state-machines.md, S7: one choice is saved at a time; a second is queued, never dropped.
describe("a Naming choice made while another is being saved", () => {
  /** Serves the three choice writes like the server; each waits for `release[n]` when one is set. */
  let release: (ReturnType<typeof deferred<void>> | undefined)[];
  const sent = () =>
    writes().map(([path, init]) => ({
      path: String(path).slice(base.length),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    }));
  beforeEach(() => {
    release = [];
    let count = 0;
    fetcher.mockImplementation(async (path: string, init: RequestInit) => {
      if (init.method === "GET") return Response.json(overview(path));
      const gate = release[count++];
      const body = JSON.parse(String(init.body));
      const url = String(path);
      await gate?.promise;
      if (url.endsWith("/view")) {
        if (body.expectedViewRevision !== state.session!.viewRevision) return Response.json({}, { status: 409 });
        state = {
          ...state,
          session: { ...state.session!, viewRevision: state.session!.viewRevision + 1, viewState: body.viewState },
        };
        return Response.json({ session: state.session });
      }
      if (url.endsWith("/retention")) {
        const row = rows.find((entry) => entry.candidate.id === body.candidateId)!;
        if (body.expectedRevision !== row.retention.revision) return Response.json({}, { status: 409 });
        const entry = {
          ...row,
          retention: {
            ...row.retention,
            revision: row.retention.revision + 1,
            favorite: body.favorite,
            saved: body.saved,
            updatedAt: when,
          },
        };
        rows = rows.map((item) => (item === row ? entry : item));
        return Response.json({ entry });
      }
      if (url.endsWith("/selection")) {
        if (body.expectedRevision !== state.project.current_revision) return Response.json({}, { status: 409 });
        const chosen = rows.find((entry) => entry.candidate.id === body.candidateId)!.candidate;
        const project = {
          ...state.project,
          current_revision: state.project.current_revision + 1,
          context: {
            ...state.project.context,
            selectedName: chosen.value,
            intake: { ...state.project.context.intake, suppliedName: chosen.value },
          },
        };
        const selection = {
          id: id(999),
          ownerId: account.userId,
          projectId,
          candidateId: chosen.id,
          projectRevision: project.current_revision,
          previousSelectionId: null,
          acceptedEarlierContext: false,
          createdAt: when,
        };
        state = {
          ...state,
          project,
          session: { ...state.session!, currentSelectionId: selection.id },
          currentSelection: { selection, candidate: chosen },
        };
        return Response.json({ project, session: state.session, currentSelection: state.currentSelection });
      }
      throw new Error("Unexpected fixture mutation");
    });
  });
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

  it("saves a heart pressed while the view is being saved, after it", async () => {
    rows = [candidate(1)];
    await render();
    release[0] = deferred();
    let view!: Promise<boolean>, heart!: Promise<boolean>;
    await act(async () => {
      view = api.saveView({ scrollCandidateId: id(1) });
      heart = api.retain(rows[0]!, "favorite");
    });
    // One write at a time: the heart waits its turn.
    expect(sent().map((write) => write.path)).toEqual(["/view"]);
    expect(api.pending).toBe(true);
    await act(async () => release[0]!.resolve());
    expect(await view).toBe(true);
    expect(await heart).toBe(true);
    await settle();
    expect(sent().map((write) => write.path)).toEqual(["/view", "/retention"]);
    expect(rows[0]!.retention.favorite).toBe(true);
    expect(api.pending).toBe(false);
    expect(api.actionError).toBeNull();
  });

  it("keeps every heart: two names hearted while a third choice is being saved", async () => {
    rows = [candidate(1), candidate(2), candidate(3)];
    await render();
    release[0] = deferred();
    const results: Promise<boolean>[] = [];
    await act(async () => {
      results.push(api.retain(rows[0]!, "saved"), api.retain(rows[1]!, "favorite"), api.retain(rows[2]!, "favorite"));
    });
    await act(async () => release[0]!.resolve());
    expect(await Promise.all(results)).toEqual([true, true, true]);
    await settle();
    expect(sent().map((write) => write.body.candidateId)).toEqual([id(1), id(2), id(3)]);
    expect(rows.map((row) => [row.retention.saved, row.retention.favorite])).toEqual([
      [true, false],
      [false, true],
      [false, true],
    ]);
  });

  it("saves a second change to the same name from the newest saved version", async () => {
    rows = [candidate(1)];
    await render();
    release[0] = deferred();
    const shown = rows[0]!;
    let heart!: Promise<boolean>, keep!: Promise<boolean>;
    await act(async () => {
      heart = api.retain(shown, "favorite");
      keep = api.retain(shown, "saved");
    });
    await act(async () => release[0]!.resolve());
    expect([await heart, await keep]).toEqual([true, true]);
    await settle();
    expect(sent().map((write) => write.body)).toMatchObject([
      { expectedRevision: 0, favorite: true, saved: false },
      { expectedRevision: 1, favorite: true, saved: true },
    ]);
  });

  it("chooses a name pressed while a heart is being saved", async () => {
    rows = [candidate(1), candidate(2)];
    await render();
    release[0] = deferred();
    let heart!: Promise<boolean>, chosen!: Promise<boolean>;
    await act(async () => {
      heart = api.retain(rows[0]!, "favorite");
      chosen = api.select(rows[1]!, false);
    });
    await act(async () => release[0]!.resolve());
    expect([await heart, await chosen]).toEqual([true, true]);
    await settle();
    expect(sent().map((write) => write.path)).toEqual(["/retention", "/selection"]);
    expect(api.overview?.currentSelection?.candidate.id).toBe(id(2));
  });

  it("sends waiting view changes as one save, built on the view that was just saved", async () => {
    await render();
    release[0] = deferred();
    const results: Promise<boolean>[] = [];
    await act(async () => {
      results.push(
        api.saveView({ filter: "saved" }),
        api.saveView({ query: "kitchen" }),
        api.saveView({ scrollCandidateId: id(7) }),
      );
    });
    await act(async () => release[0]!.resolve());
    expect(await Promise.all(results)).toEqual([true, true, true]);
    await settle();
    expect(sent()).toMatchObject([
      { path: "/view", body: { expectedViewRevision: 1, viewState: { filter: "saved", query: "" } } },
      {
        path: "/view",
        body: {
          expectedViewRevision: 2,
          viewState: { filter: "saved", query: "kitchen", scrollCandidateId: id(7) },
        },
      },
    ]);
    expect(api.overview?.session?.viewState).toMatchObject({ filter: "saved", query: "kitchen" });
  });

  it("says so when a waiting choice then fails, and still saves the ones behind it", async () => {
    rows = [candidate(1), candidate(2)];
    await render();
    release[0] = deferred();
    const stale = { ...rows[1]!, retention: { ...rows[1]!.retention, revision: 5 } };
    let first!: Promise<boolean>, refused!: Promise<boolean>, last!: Promise<boolean>;
    await act(async () => {
      first = api.retain(rows[0]!, "favorite");
      refused = api.retain(stale, "favorite");
      last = api.saveView({ filter: "saved" });
    });
    await act(async () => release[0]!.resolve());
    expect([await first, await refused, await last]).toEqual([true, false, true]);
    await settle();
    expect(sent().map((write) => write.path)).toEqual(["/retention", "/retention", "/view"]);
    // The later save that worked does not wipe the message about the one that did not.
    expect(api.actionError).toContain("The project or naming workspace changed.");
  });
});
