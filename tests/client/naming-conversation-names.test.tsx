// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { installNamePreviewDialog, namePreview } from "../fixtures/name-preview-dialog";
import { ProjectNamingWorkspace } from "@/components/naming/project-naming-workspace";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { accountProjectSchema } from "@/domain/project-api";
import { projectNamingOverviewSchema, type ProjectNamingOverview } from "@/domain/naming-jobs";
import {
  getNamingReadiness,
  nameIdentityKey,
  namingStrategyBasis,
  namingStrategyKey,
  type ProjectNameEntry,
} from "@/domain/project-naming";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import {
  NAMING_GENERATION_CAUTION,
  type NamingFeedEntry,
  type NamingGenerationFeed,
  type NamingRun,
} from "@/domain/naming-generation";
import { initialNamingView } from "@/components/naming/use-project-naming";
import { reviewedStrategy } from "../fixtures/reviewed-strategy";

/** Voice · Name inside the project conversation, end to end against a synthetic API. */
const mock = vi.hoisted(() => ({
  memory: null as ReturnType<typeof createNamingBrainMemory> | null,
  drafts: null as ReturnType<typeof createAccountDraftMemory> | null,
  current: vi.fn(),
  expire: vi.fn(),
}));
const id = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { status: "ready" as const, userId: id(1), generation: 1 },
  projectId = id(2),
  runId = id(7),
  jobId = id(6),
  when = "2026-11-08T01:30:00Z";
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({
    session: account,
    namingBrainDrafts: mock.memory,
    drafts: mock.drafts,
    isCurrent: mock.current,
    expire: mock.expire,
  }),
  AccountStatus: () => null,
}));
const base = `/api/projects/${projectId}/naming`,
  owned = { ownerId: account.userId, projectId };
let host: HTMLDivElement,
  hosts: { messages: HTMLDivElement; results: HTMLDivElement; composer: HTMLDivElement },
  root: Root;
let state: ProjectNamingOverview,
  manual: ProjectNameEntry[],
  server: NamingGenerationFeed,
  failImport: boolean,
  onNameConfirmed: Mock<() => void>;
const requests: { path: string; method: string; body: Record<string, unknown> | null; account: string | null }[] = [];
const buttons = () => [...(namePreview(host) ?? host).querySelectorAll<HTMLButtonElement>("button")];
const button = (name: string) =>
  buttons().find(
    (row) => row.textContent?.trim() === name || row.getAttribute("aria-label") === name || row.title === name,
  );
async function click(name: string) {
  expect(button(name), name).toBeDefined();
  await act(async () => button(name)!.click());
}
const posts = (suffix: string) => requests.filter((row) => row.method !== "GET" && row.path.endsWith(suffix));
const names = () => hosts.results.textContent ?? "";
const chat = () => hosts.messages.textContent ?? "";
async function render() {
  await act(async () =>
    root.render(
      <ProjectNamingWorkspace
        projectId={projectId}
        inline={{ ...hosts, onQuestion: vi.fn(), onCanvas: vi.fn(), onNameConfirmed }}
      />,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function manualEntry(value: string, n: number): ProjectNameEntry {
  const candidateId = id(n);
  return {
    candidate: {
      ...owned,
      id: candidateId,
      value,
      identityKey: nameIdentityKey(value),
      rationale: "Synthetic own name",
      contextRevision: 1,
      strategyBasis: namingStrategyBasis(state.project.context),
      strategyKey: namingStrategyKey(state.project.context),
      createdAt: when,
      origin: {
        kind: "local_import",
        ...owned,
        candidateId,
        contextRevision: 1,
        source: { id: candidateId, value, createdAt: when, origin: "manual", history: [] },
        capturedContext: state.project.context,
      },
    },
    retention: { ...owned, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null },
  };
}
function generated(n: number): NamingFeedEntry {
  const candidateId = id(100 + n),
    value = `Synthetic ${n}`,
    createdAt = new Date(Date.parse(when) + n * 1000).toISOString();
  return {
    runId,
    primaryApproach: "real_words",
    entry: {
      candidate: {
        ...owned,
        id: candidateId,
        value,
        identityKey: nameIdentityKey(value),
        rationale: "A synthetic proposal.",
        caution: NAMING_GENERATION_CAUTION,
        contextRevision: 1,
        strategyBasis: namingStrategyBasis(state.project.context),
        strategyKey: namingStrategyKey(state.project.context),
        createdAt,
        origin: {
          kind: "brainstorm",
          version: 1,
          profile: "brainstorm_v1",
          ...owned,
          candidateId,
          contextRevision: 1,
          value,
          batchId: runId,
          jobId,
          runId,
          callId: id(8),
          responseId: "resp_synthetic",
          requestId: null,
          model: "synthetic",
          generatedAt: createdAt,
        },
      },
      retention: { ...owned, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null },
    },
  };
}
const run = (patch: Partial<NamingRun>): NamingRun => ({
  runId,
  jobId,
  kind: "initial",
  state: "running",
  target: 100,
  savedCount: 0,
  errorCode: null,
  usage: null,
  createdAt: when,
  finishedAt: null,
  ...patch,
});

beforeEach(() => {
  installNamePreviewDialog();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  Element.prototype.scrollIntoView = vi.fn();
  mock.memory = createNamingBrainMemory({ storage: () => null, debounceMs: 10 });
  mock.memory.bind(account);
  mock.drafts = createAccountDraftMemory();
  mock.current
    .mockReset()
    .mockImplementation((value) => value.userId === account.userId && value.generation === account.generation);
  mock.expire.mockReset();
  requests.length = 0;
  manual = [];
  failImport = false;
  onNameConfirmed = vi.fn();
  const project = accountProjectSchema.parse({
    id: projectId,
    owner_id: account.userId,
    title: "Synthetic kitchen",
    scope: "complete_brand",
    current_revision: 1,
    created_at: when,
    context: reviewedStrategy({ description: "A synthetic kitchen brief" }),
  });
  const preferences = {
    ...initialNamingPreferencesV2(project.context),
    approaches: ["real_words" as const],
    directness: "all" as const,
  };
  // Every question already confirmed: the conversation is at "Your naming direction".
  const namingChat = {
    version: 1 as const,
    preferencesVersion: 2,
    confirmed: {
      approaches: JSON.stringify(["real_words"]),
      directness: JSON.stringify("all"),
      length: JSON.stringify([null, null]),
      fragments: JSON.stringify([[], []]),
    },
  };
  state = projectNamingOverviewSchema.parse({
    project,
    readiness: getNamingReadiness(project.context, project.scope),
    session: {
      ...owned,
      revision: 1,
      currentPreferencesVersion: 2,
      latestBatchSequence: 0,
      currentSelectionId: null,
      viewRevision: 1,
      viewState: { ...initialNamingView, namingChat },
      createdAt: when,
      updatedAt: when,
    },
    preferences: { ...owned, version: 2, preferences, createdAt: when },
    currentSelection: null,
    candidates: { ...owned, items: [], nextCursor: null },
    batches: { ...owned, items: [], nextCursor: null },
    jobs: [],
    availability: { status: "unavailable", operation: "naming.generate", reason: "worker_unavailable" },
    screening: {
      domains: { status: "not_checked", reason: "integration_unavailable" },
      handles: { status: "not_checked", reason: "integration_unavailable" },
      trademarks: { status: "not_checked", reason: "integration_unavailable" },
    },
  });
  server = { version: 2, projectId, availability: { status: "available" }, run: null, entries: [], nextCursor: null };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit) => {
      if (path === "/api/standalone-checks")
        return Response.json({ ownerId: account.userId, domains: "unavailable", youtube: false, euipo: false });
      const url = new URL(path, "https://fixture.invalid"),
        method = options.method ?? "GET",
        body = options.body ? JSON.parse(String(options.body)) : null;
      requests.push({ path: url.pathname, method, body, account: new Headers(options.headers).get("X-Embel-Account") });
      if (url.pathname === base) return Response.json(state);
      if (url.pathname === `${base}/custom`) return Response.json({ ...owned, items: manual, nextCursor: null });
      if (url.pathname === `${base}/feed`) {
        const after = url.searchParams.get("cursorId"),
          start = after ? server.entries.findIndex((row) => row.entry.candidate.id === after) + 1 : 0;
        return Response.json({ feed: { ...server, entries: server.entries.slice(start) } });
      }
      if (url.pathname === `${base}/feed/ensure` || url.pathname === `${base}/steering`) {
        server = { ...server, run: run({ kind: body.kind, state: "queued", runId: id(900 + requests.length) }) };
        return Response.json({ feed: server, run: server.run, reused: false });
      }
      if (url.pathname === `${base}/feed/stop`) {
        server = { ...server, run: server.run && { ...server.run, state: "cancel_requested" } };
        return Response.json({ feed: server });
      }
      if (url.pathname === `${base}/imports`) {
        const fresh = manualEntry(body.source.value, 999),
          created = {
            ...fresh,
            candidate: { ...fresh.candidate, origin: { ...fresh.candidate.origin, source: body.source } },
          } as ProjectNameEntry;
        const entry =
          manual.find(
            (row) => row.candidate.origin.kind === "local_import" && row.candidate.origin.source.id === body.source.id,
          ) ?? created;
        if (!manual.includes(entry)) manual.push(entry);
        if (failImport) {
          failImport = false;
          return Response.json({}, { status: 503 });
        }
        return Response.json({ entry });
      }
      if (url.pathname === `${base}/view`) {
        state = {
          ...state,
          session: { ...state.session!, viewRevision: body.expectedViewRevision + 1, viewState: body.viewState },
        };
        return Response.json({ session: state.session });
      }
      if (url.pathname === `${base}/selection`) {
        const candidate = [
            ...manual.map((row) => row.candidate),
            ...server.entries.map((row) => row.entry.candidate),
          ].find((row) => row.id === body.candidateId)!,
          revision = body.expectedRevision + 1;
        const project = {
          ...state.project,
          current_revision: revision,
          context: { ...state.project.context, selectedName: candidate.value },
        };
        const selection = {
          id: id(5000),
          ...owned,
          candidateId: candidate.id,
          projectRevision: revision,
          previousSelectionId: null,
          acceptedEarlierContext: false,
          createdAt: when,
        };
        state = {
          ...state,
          project,
          currentSelection: { selection, candidate },
          session: { ...state.session!, currentSelectionId: selection.id },
        };
        return Response.json({ project, currentSelection: state.currentSelection, session: state.session });
      }
      throw Error(`Unexpected synthetic request ${method} ${url.pathname}`);
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  hosts = {
    messages: document.createElement("div"),
    results: document.createElement("div"),
    composer: document.createElement("div"),
  };
  const app = document.createElement("div");
  host.append(hosts.messages, hosts.results, hosts.composer, app);
  root = createRoot(app);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  mock.memory?.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("adds and chooses your own name before any names are generated, without starting generation", async () => {
  await render();
  const form = hosts.messages.querySelector<HTMLFormElement>('form[aria-label="Add your own name"]')!;
  expect(form).not.toBeNull();
  expect(names()).toBe("");
  await type(form.querySelector("input")!, "My kitchen name");
  await click("Add name");
  expect(manual).toHaveLength(1);
  expect(names()).toContain("My kitchen name");
  // Nothing is chosen yet: Send has nothing to continue with.
  expect(button("Continue to Slogan")).toBeUndefined();
  await act(async () => hosts.results.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  // The reply box carries the chosen name; Send with nothing typed moves on with it.
  expect(hosts.composer.textContent).toContain("Name: My kitchen name");
  expect(state.currentSelection).toBeNull();
  await click("Continue to Slogan");
  expect(state.currentSelection?.candidate.value).toBe("My kitchen name");
  expect(posts("/ensure")).toHaveLength(0);
  expect(requests.filter((row) => row.method !== "GET").every((row) => row.account === account.userId)).toBe(true);
});

it("retries the exact unconfirmed import", async () => {
  await render();
  await type(
    hosts.messages.querySelector<HTMLInputElement>('form[aria-label="Add your own name"] input')!,
    "Lost acknowledgement",
  );
  failImport = true;
  await click("Add name");
  expect(button("Retry saving name")).toBeDefined();
  await click("Retry saving name");
  const imports = posts("/imports");
  expect(imports).toHaveLength(2);
  expect(imports[1]!.body).toEqual(imports[0]!.body);
  expect(manual).toHaveLength(1);
});

it("shows progress with Stop while names arrive, then Stopped and More names", async () => {
  server = { ...server, run: run({ savedCount: 2 }), entries: [generated(1), generated(2)] };
  await render();
  expect(names()).toContain("Synthetic 1");
  expect(chat()).toContain("Generating names… 2 of 100");
  expect(button("Suggest more names")!.disabled).toBe(true);
  server = { ...server, run: run({ savedCount: 3 }), entries: [...server.entries, generated(3)] };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(names()).toContain("Synthetic 3");
  expect(chat()).toContain("Generating names… 3 of 100");
  await click("Stop");
  expect(posts("/feed/stop")).toEqual([expect.objectContaining({ body: {}, account: account.userId })]);
  expect(chat()).toContain("Stopping… 3 names saved.");
  server = { ...server, run: run({ state: "cancelled", savedCount: 3, finishedAt: when }) };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(chat()).toContain("Stopped. 3 names saved.");
  expect(button("Suggest more names")!.disabled).toBe(false);
  await click("Suggest more names");
  expect(posts("/feed/ensure").map((row) => row.body)).toMatchObject([
    {
      version: 2,
      kind: "more",
      expectedProjectRevision: 1,
      expectedPreferencesVersion: 2,
      seedIds: [],
      instruction: null,
    },
  ]);
  expect(chat()).toContain("Generating names… 0 of 100");
});

it("shows fewer than 100 finished names without a warning", async () => {
  server = {
    ...server,
    run: run({ state: "succeeded", savedCount: 3, finishedAt: when }),
    entries: [generated(1), generated(2), generated(3)],
  };
  await render();
  expect(names()).toContain("Synthetic 3");
  expect(names()).not.toMatch(/fewer|couldn’t|ended before|shortfall|incomplete/i);
  expect(hosts.results.querySelector('[role="alert"]')).toBeNull();
  expect(hosts.messages.querySelector('[role="alert"]')).toBeNull();
  expect(button("Suggest more names")!.disabled).toBe(false);
});

it("explains a failed run and Try again starts the same kind with a new request", async () => {
  server = { ...server, run: run({ state: "failed", errorCode: "send_interrupted", finishedAt: when }) };
  await render();
  expect(chat()).toContain("Names appear as they’re ready.");
  expect(chat()).toContain("Name generation was interrupted before it started. Try again.");
  await click("Try again");
  expect(posts("/feed/ensure").map((row) => row.body)).toMatchObject([{ kind: "initial" }]);
});

it("says plainly when AI name generation is unavailable", async () => {
  server = {
    ...server,
    availability: { status: "unavailable", code: "worker_unavailable" },
    entries: [generated(1)],
    run: run({ state: "succeeded", savedCount: 1, finishedAt: when }),
  };
  await render();
  expect(chat()).toContain("AI name generation is unavailable right now.");
  expect(button("Suggest more names")!.disabled).toBe(true);
});

it("keeps the name checks in the details overlay, offers More like this and no Explore variations", async () => {
  server = { ...server, run: run({ state: "succeeded", savedCount: 1, finishedAt: when }), entries: [generated(1)] };
  await render();
  await click("Details for Synthetic 1");
  expect(namePreview(host)?.querySelector("h2")?.textContent).toBe("Synthetic 1");
  expect(button("Explore variations")).toBeUndefined();
  expect(button("Save name")).toBeDefined();
  const seed = namePreview(host)!.querySelector<HTMLInputElement>('footer input[type="checkbox"]')!;
  expect(seed.closest("label")?.textContent).toBe("More like this: Synthetic 1");
  await act(async () => seed.click());
  expect(mock.memory!.get(account, projectId)!.steeringDraft.candidateIds).toEqual([id(101)]);
  await click("Close name details");
  await type(hosts.composer.querySelector("textarea")!, "Softer vowels");
  await act(async () => {
    button("Send naming direction")!.click();
  });
  expect(posts("/steering").map((row) => row.body)).toMatchObject([
    { version: 2, kind: "steer", seedIds: [id(101)], instruction: "Softer vowels" },
  ]);
  expect(mock.memory!.get(account, projectId)!.steeringDraft).toEqual({ candidateIds: [], instruction: "" });
});

it("steers with typed guidance alone once names exist", async () => {
  server = { ...server, run: run({ state: "succeeded", savedCount: 1, finishedAt: when }), entries: [generated(1)] };
  await render();
  await type(hosts.composer.querySelector("textarea")!, "Shorter and warmer");
  await act(async () => {
    button("Send naming direction")!.click();
  });
  expect(posts("/steering").map((row) => row.body)).toMatchObject([
    { kind: "steer", seedIds: [], instruction: "Shorter and warmer" },
  ]);
  expect(requests.some((row) => row.path.endsWith("/preferences"))).toBe(false);
});

it("returns an older saved filter or workshop view to the single names list", async () => {
  state = {
    ...state,
    session: {
      ...state.session!,
      viewState: {
        ...state.session!.viewState,
        pane: "workshop",
        filter: "saved",
        query: "Juniper",
        workshopCandidateId: id(101),
      },
    },
  };
  server = { ...server, run: run({ state: "succeeded", savedCount: 1, finishedAt: when }), entries: [generated(1)] };
  await render();
  expect(posts("/view").map((row) => row.body?.viewState)).toMatchObject([
    { pane: "results", filter: "all", query: "", visibleBatchId: null, workshopCandidateId: null },
  ]);
  expect(names()).toContain("Synthetic 1");
});

it("starts the first names when the last choices answer is confirmed", async () => {
  const viewState = state.session!.viewState,
    confirmed = viewState.namingChat!.confirmed;
  state = {
    ...state,
    session: {
      ...state.session!,
      viewState: {
        ...viewState,
        namingChat: {
          ...viewState.namingChat!,
          confirmed: { approaches: confirmed.approaches, directness: confirmed.directness },
        },
      },
    },
  };
  await render();
  expect(hosts.messages.querySelector("#project-naming-preferences-heading")?.textContent).toBe(
    "Any length limits or text to include or avoid?",
  );
  expect(posts("/ensure")).toHaveLength(0);
  await act(async () => {
    buttons()
      .find((row) => row.textContent === "Continue" && hosts.messages.contains(row))!
      .click();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(posts("/view").at(-1)?.body?.viewState).toMatchObject({
    namingChat: { confirmed: { length: JSON.stringify([null, null]) } },
  });
  expect(posts("/feed/ensure").map((row) => row.body)).toMatchObject([
    {
      version: 2,
      kind: "initial",
      expectedProjectRevision: 1,
      expectedPreferencesVersion: 2,
      seedIds: [],
      instruction: null,
    },
  ]);
  expect(chat()).toContain("Generating names… 0 of 100");
});

it("starts the first generated set from More names when only your own names exist", async () => {
  manual = [manualEntry("My own idea", 999)];
  await render();
  expect(names()).toContain("My own idea");
  await click("Suggest more names");
  expect(posts("/feed/ensure").map((row) => row.body)).toMatchObject([{ kind: "initial" }]);
});

describe("domain checks on the Naming results", () => {
  const checks = () => (fetch as unknown as Mock).mock.calls.filter(([path]) => path === "/api/standalone-checks");
  const domainLookups = () =>
    checks()
      .filter(([, options]) => options?.method === "POST")
      .map(([, options]) => JSON.parse(String(options.body)));
  beforeEach(() => {
    // Connected lookups, so a check that started on its own would reach the server.
    const fallback = (fetch as unknown as Mock).getMockImplementation() as (
      path: string,
      options: RequestInit,
    ) => Promise<Response>;
    (fetch as unknown as Mock).mockImplementation(async (path: string, options: RequestInit = {}) => {
      if (path !== "/api/standalone-checks") return fallback(path, options);
      if (!options.method || options.method === "GET")
        return Response.json({ ownerId: account.userId, domains: "rdap", youtube: true, euipo: true });
      const { domain } = JSON.parse(String(options.body));
      return Response.json({
        ownerId: account.userId,
        result: {
          status: "domain",
          quote: null,
          check: {
            id: "domain-fixture",
            provider: "Public registry RDAP",
            domain,
            availability: "taken",
            checkedAt: "2026-11-08T15:00:00Z",
            validUntil: new Date(Date.now() + 3_600_000).toISOString(),
            evidenceReference: "rdap:fixture",
            sourceUrl: `https://rdap.example.test/domain/${domain}`,
          },
        },
      });
    });
    server = {
      ...server,
      run: run({ state: "succeeded", savedCount: 100, finishedAt: when }),
      entries: Array.from({ length: 100 }, (_, index) => generated(index + 1)),
    };
  });

  it("shows the names without domain status and checks no domain on its own", async () => {
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(button("Details for Synthetic 1")).toBeDefined();
    expect(names()).toContain("Synthetic 40");
    expect(names()).toContain("40 of 100 names");
    expect(checks()).toHaveLength(0);
    expect(names()).not.toMatch(/\.com|domain/i);
  });

  it("checks a name's domain once, only when Check domain is clicked in its details, and shows that result on reopening", async () => {
    await render();
    await click("Details for Synthetic 7");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const preview = namePreview(host)!;
    expect(preview.querySelector<HTMLInputElement>("input")?.value).toBe("synthetic7");
    // Opening the details only reads which lookups are connected.
    expect(checks().map(([, options]) => options?.method ?? "GET")).toEqual(["GET"]);
    expect(domainLookups()).toHaveLength(0);
    await click("Check synthetic7.com");
    expect(domainLookups()).toEqual([{ tool: "domains", domain: "synthetic7.com" }]);
    expect(preview.querySelector("[data-status]")?.textContent).toBe("Taken");
    expect(preview.textContent).toContain("Checked with the public registry");
    expect(preview.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-08T15:00:00Z");
    await click("Close name details");
    expect(names()).not.toMatch(/\.com|domain/i);
    // Reopening shows the earlier result with when it was checked, without a new lookup.
    await click("Details for Synthetic 7");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(namePreview(host)!.querySelector("[data-status]")?.textContent).toBe("Taken");
    expect(namePreview(host)!.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-08T15:00:00Z");
    await click("Close name details");
    // Another name has no result until its own check.
    await click("Details for Synthetic 8");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(namePreview(host)!.querySelector("[data-status]")?.textContent).toBe("Not checked");
    expect(domainLookups()).toHaveLength(1);
  });
});
