// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectForm } from "@/components/workspace/project-editor";
import { clearLocalDrafts, createLocalDraft, DRAFT_STORAGE_KEY } from "@/components/workspace/local-drafts";
import { createHomeInputSession, type HomeInputSession } from "@/features/home-inputs/home-input-session";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { rememberPromptForSignIn } from "@/components/workspace/prompt-recovery";
const mock = vi.hoisted(() => ({
  session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as
    VerifiedAccount | { status: "checking" | "signed_out"; generation: number },
  memory: null as HomeInputSession | null,
  push: vi.fn(),
  current: vi.fn(),
  expire: vi.fn(),
  refresh: vi.fn(),
}));
let accountDrafts: ReturnType<typeof createAccountDraftMemory>;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({
    drafts: accountDrafts,
    session: mock.session,
    homeInputSession: mock.memory,
    isCurrent: mock.current,
    expire: mock.expire,
    refresh: mock.refresh,
  }),
}));
let root: Root | null, host: HTMLDivElement, owner: string, fetcher: ReturnType<typeof vi.fn>;
const ready = {
  status: "available",
  operations: [
    { operation: "strategy.reformulate", maximumCostMicrousd: 10000, interviewVersion: 1 },
    { operation: "strategy.competitors", maximumCostMicrousd: 10000, interviewVersion: 1 },
  ],
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
async function render(exampleId: string | undefined = "b2b", home = true) {
  await act(async () => root!.render(createElement(NewProjectForm, { home, exampleId })));
}
async function remountHome() {
  await act(async () => root!.unmount());
  root = createRoot(host);
  await act(async () => root!.render(createElement(NewProjectForm, { home: true })));
}
async function signInLink() {
  const link = host.querySelector<HTMLAnchorElement>('a[href="/sign-in"]')!;
  link.addEventListener("click", (event) => event.preventDefault());
  await act(async () => link.click());
}
async function click(label: string) {
  await act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(label))!.click(),
  );
}
const mutations = () => fetcher.mock.calls.filter(([, init]) => init.method === "POST");
const creations = () => mutations().filter(([path]) => path === "/api/projects");
async function defaultFetch(path: string, init: RequestInit) {
  if (path.endsWith("/capability"))
    return Response.json({ ownerId: owner, policy: null, reason: "Synthetic unavailable storage" });
  if (path === "/api/session") return Response.json({ user: { id: owner } });
  if (path === "/api/strategy") return Response.json({ availability: ready });
  if (path === "/api/projects")
    return Response.json({
      project: {
        ...JSON.parse(String(init.body)),
        id: JSON.parse(String(init.body)).requestKey,
        owner_id: owner,
        current_revision: 1,
        created_at: "2026-10-07T00:00:00Z",
      },
    });
  if (init.method === "PATCH") {
    const body = JSON.parse(String(init.body));
    return Response.json({
      revision: {
        project_id: path.split("/")[3],
        owner_id: owner,
        revision: body.expectedRevision + 1,
        context: body.context,
        input_hash: "synthetic-context",
        created_at: "2026-10-07T00:00:00Z",
      },
    });
  }
  if (path.endsWith("/strategy") && init.method === "GET")
    return Response.json({
      availability: { status: "unavailable", operations: [], reason: "worker_unavailable" },
      jobs: [],
    });
  if (path.endsWith("/strategy"))
    return Response.json({
      job: {
        id: crypto.randomUUID(),
        owner_id: owner,
        project_id: path.split("/")[3],
        operation: "strategy.competitors",
        input_revision: JSON.parse(String(init.body)).expectedRevision,
        state: "queued",
        progress: 0,
        error_code: null,
        cancel_requested_at: null,
        created_at: "2026-10-07T00:00:00Z",
        finished_at: null,
        reserved_cost_microusd: 10000,
        actual_cost_microusd: 0,
        results: [],
      },
    });
  throw new Error(`Unexpected fixture request ${path}`);
}
beforeEach(() => {
  accountDrafts = createAccountDraftMemory();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollTo = vi.fn();
  window.sessionStorage.clear();
  window.localStorage.clear();
  clearLocalDrafts();
  owner = crypto.randomUUID();
  mock.session = { status: "ready", userId: owner, generation: 1 };
  mock.memory = createHomeInputSession();
  mock.memory.bind(mock.session);
  mock.current
    .mockReset()
    .mockImplementation(
      (account: VerifiedAccount) =>
        mock.session.status === "ready" &&
        account.userId === mock.session.userId &&
        account.generation === mock.session.generation,
    );
  mock.push.mockReset();
  mock.expire.mockReset();
  mock.refresh.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fetcher = vi.fn(defaultFetch);
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("Home account persistence and sign-in continuation", () => {
  it("uses the same modern intake on the New project route, including before sign-in, with no project type choice", async () => {
    mock.session = { status: "signed_out", generation: 2 };
    mock.memory!.bind(null);
    await render("b2b", false);
    expect(host.querySelector(".home-page .home-intake .home-composer")).not.toBeNull();
    expect(host.querySelector(".home-scope")).toBeNull();
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(host.textContent).toContain("Your next brand starts here");
    expect(host.querySelector("textarea")!.readOnly).toBe(false);
  });

  it("leaves typing and saving available while the initial AI read is pending", async () => {
    const held = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) =>
      path === "/api/strategy" ? held.promise : defaultFetch(path, init),
    );
    await render();
    expect(host.querySelector("textarea")!.readOnly).toBe(false);
    await click("Save project");
    const body = JSON.parse(String(creations()[0]![1].body));
    expect(body.scope).toBe("complete_brand");
    expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${body.requestKey}?view=strategy`);
    await act(async () => held.resolve(Response.json({ availability: ready })));
    expect(mutations()).toHaveLength(1);
    expect(host.textContent).toContain("Project saved. Opening your project…");
  });

  it("keeps a manual read-only AI recheck out of the editing and save lock", async () => {
    fetcher.mockImplementation((path: string, init: RequestInit) =>
      path === "/api/strategy"
        ? Promise.resolve(
            Response.json({ availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } }),
          )
        : defaultFetch(path, init),
    );
    await render();
    const held = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) =>
      path === "/api/strategy" ? held.promise : defaultFetch(path, init),
    );
    await click("Check AI availability");
    expect(host.querySelector("textarea")!.readOnly).toBe(false);
    await click("A skincare studio");
    expect(host.querySelector("textarea")!.value).toContain("independent skincare studio");
    await click("Save project");
    expect(creations()).toHaveLength(1);
    expect(JSON.parse(String(creations()[0]![1].body)).context.intake.guidedInterview).toBeUndefined();
    await act(async () => held.resolve(Response.json({ availability: ready })));
    expect(host.textContent).toContain("Project saved. Opening your project…");
    expect(host.textContent).not.toContain("Competitor research is ready");
    expect(mutations()).toHaveLength(1);
  });

  it("keeps the outgoing submitted prompt and navigation pending until the destination mounts", async () => {
    const held = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) =>
      path === "/api/projects" ? held.promise : defaultFetch(path, init),
    );
    await render();
    const original = host.querySelector("textarea")!.value;
    await click("Send prompt");
    expect(host.textContent).toContain(original);
    expect(host.textContent).toContain("Saving your project…");
    expect(host.textContent).not.toContain("Thinking…");
    expect(mock.push).not.toHaveBeenCalled();
    await act(async () => held.resolve(await defaultFetch("/api/projects", creations()[0]![1])));
    expect(host.textContent).toContain("Project saved. Opening your project…");
    expect(host.querySelector(".home-composer")).toBeNull();
    expect(host.querySelector<HTMLAnchorElement>("a.e-link")?.textContent).toBe("Open saved project");
    expect(creations()).toHaveLength(1);
    expect(mock.push).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "cannot replace an in-flight save with a late readiness result (available: %s)",
    async (available) => {
      fetcher.mockImplementation((path: string, init: RequestInit) =>
        path === "/api/strategy"
          ? Promise.resolve(
              Response.json({ availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } }),
            )
          : defaultFetch(path, init),
      );
      await render();
      const readiness = deferred<Response>(),
        save = deferred<Response>();
      fetcher.mockImplementation((path: string, init: RequestInit) =>
        path === "/api/strategy"
          ? readiness.promise
          : path === "/api/projects"
            ? save.promise
            : defaultFetch(path, init),
      );
      await click("Check AI availability");
      await click("Save project");
      expect(host.textContent).toContain("Saving your project…");
      expect(host.querySelector(".home-composer")).toBeNull();
      await act(async () =>
        readiness.resolve(available ? Response.json({ availability: ready }) : new Response(null, { status: 503 })),
      );
      expect(host.textContent).toContain("Saving your project…");
      expect(host.querySelector(".home-composer")).toBeNull();
      expect(mock.push).not.toHaveBeenCalled();
      expect(creations()).toHaveLength(1);
      await act(async () => save.resolve(await defaultFetch("/api/projects", creations()[0]![1])));
      expect(host.textContent).toContain("Project saved. Opening your project…");
      expect(mock.push).toHaveBeenCalledOnce();
    },
  );

  it("keeps the current guest prompt through sign-in, then saves without AI", async () => {
    mock.session = { status: "signed_out", generation: 2 };
    mock.memory!.bind(null);
    await render();
    const original = host.querySelector("textarea")!.value;
    await click("Send prompt");
    expect(mock.push).toHaveBeenCalledExactlyOnceWith("/sign-in");
    expect(mutations()).toHaveLength(0);
    mock.session = { status: "ready", userId: owner, generation: 3 };
    mock.memory!.bind(mock.session);
    await remountHome();
    expect(host.querySelector("textarea")!.value).toBe(original);
    await click("Save project");
    expect(mutations()).toHaveLength(1);
    expect(creations()).toHaveLength(1);
    const stored = JSON.parse(window.localStorage.getItem(DRAFT_STORAGE_KEY)!);
    expect(stored.drafts).toHaveLength(1);
    expect(stored.drafts[0]).toMatchObject({
      description: original,
      scope: "complete_brand",
      ownerId: owner,
      accountProjectId: stored.drafts[0].id,
    });
    expect(mock.push).toHaveBeenLastCalledWith(`/brands/account/${stored.drafts[0].id}?view=strategy`);
  });

  it("retires current prompt recovery after confirmed Send and starts a distinct next project", async () => {
    mock.session = { status: "signed_out", generation: 2 };
    mock.memory!.bind(null);
    await render();
    const original = host.querySelector("textarea")!.value;
    await signInLink();
    mock.session = { status: "ready", userId: owner, generation: 3 };
    mock.memory!.bind(mock.session);
    await remountHome();
    expect(host.querySelector("textarea")!.value).toBe(original);
    await click("Send prompt");
    expect(creations()).toHaveLength(1);
    expect(mutations()).toHaveLength(1);
    expect(window.sessionStorage.getItem("fluid.prompt-sign-in.v1")).toBeNull();
    await remountHome();
    expect(host.querySelector("textarea")!.value).toBe("");
    await click("A neighborhood coffee shop");
    await click("Send prompt");
    expect(creations()).toHaveLength(2);
    expect(mutations()).toHaveLength(2);
    expect(JSON.parse(String(creations()[1]![1].body)).requestKey).not.toBe(
      JSON.parse(String(creations()[0]![1].body)).requestKey,
    );
  });

  it("replays a lost creation acknowledgement exactly after remount without another AI admission", async () => {
    fetcher.mockImplementation((path: string, init: RequestInit) =>
      path === "/api/projects" ? Promise.reject(new TypeError("Lost acknowledgement")) : defaultFetch(path, init),
    );
    await render();
    const original = host.querySelector("textarea")!.value;
    await click("Send prompt");
    expect(creations()).toHaveLength(1);
    expect(host.querySelector("textarea")!.readOnly).toBe(true);
    await remountHome();
    expect(host.querySelector("textarea")!.value).toBe(original);
    expect(host.querySelector("textarea")!.readOnly).toBe(true);
    await click("A neighborhood coffee shop");
    expect(host.querySelector("textarea")!.value).toBe(original);
    fetcher.mockImplementation(defaultFetch);
    await click("Check and retry save");
    expect(creations()).toHaveLength(2);
    expect(creations()[1]![1].body).toBe(creations()[0]![1].body);
    expect(mutations()).toHaveLength(2);
    const id = JSON.parse(String(creations()[0]![1].body)).requestKey;
    expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${id}`);
    expect(accountDrafts.get(id)).toBeNull();
  });

  it("keeps legacy unowned history out of Home while preserving its original data", async () => {
    mock.session = { status: "signed_out", generation: 2 };
    mock.memory!.bind(null);
    await render();
    await signInLink();
    const original = window.localStorage.getItem(DRAFT_STORAGE_KEY)!;
    const draft = JSON.parse(original).drafts[0];
    window.sessionStorage.setItem("fluid.prompt-sign-in.v1", draft.id);
    await remountHome();
    expect(host.querySelector("textarea")!.value).toBe("");
    expect(host.textContent).not.toContain(draft.description);
    mock.session = { status: "ready", userId: owner, generation: 3 };
    mock.memory!.bind(mock.session);
    await remountHome();
    expect(host.querySelector("textarea")!.value).toBe("");
    expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(original);
    expect(mutations()).toHaveLength(0);
  });

  it("hides an owned prompt at sign-out and recovers its exact create only in the same account", async () => {
    const held = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) =>
      path === "/api/projects" ? held.promise : defaultFetch(path, init),
    );
    await render();
    const original = host.querySelector("textarea")!.value;
    await click("Send prompt");
    const body = creations()[0]![1].body;
    mock.session = { status: "signed_out", generation: 2 };
    mock.memory!.bind(null);
    await render();
    await act(async () => held.resolve(await defaultFetch("/api/projects", { method: "POST", body })));
    expect(host.querySelector("textarea")!.value).toBe("");
    expect(host.textContent).not.toContain(original);
    expect(mock.push).not.toHaveBeenCalled();
    mock.session = { status: "ready", userId: owner, generation: 3 };
    mock.memory!.bind(mock.session);
    fetcher.mockImplementation(defaultFetch);
    await remountHome();
    expect(host.querySelector("textarea")!.value).toBe(original);
    await click("Check and retry save");
    expect(creations()).toHaveLength(2);
    expect(creations()[1]![1].body).toBe(body);
    expect(mutations()).toHaveLength(2);
  });

  it("saves a Brand on Send even when AI is unavailable and returns Home without resurrecting its recovery buffer", async () => {
    fetcher.mockImplementation((path: string, init: RequestInit) =>
      path === "/api/strategy"
        ? Promise.resolve(
            Response.json({ availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } }),
          )
        : defaultFetch(path, init),
    );
    await render();
    const original = host.querySelector("textarea")!.value;
    await click("Send prompt");
    expect(mutations()).toHaveLength(1);
    expect(JSON.parse(String(creations()[0]![1].body)).context.description).toBe(original);
    expect(JSON.parse(String(creations()[0]![1].body)).context.intake.guidedInterview).toBeUndefined();
    expect(mock.push).toHaveBeenCalledExactlyOnceWith(
      `/brands/account/${JSON.parse(String(creations()[0]![1].body)).requestKey}?view=strategy`,
    );
    expect(window.sessionStorage.getItem(`fluid.prompt-buffer.v1:${owner}`)).toBeNull();
    await remountHome();
    expect(host.querySelector("textarea")!.value).toBe("");
    expect(host.textContent).not.toContain(original);
  });

  it.each(["unavailable", "malformed", "network"])(
    "opens the acknowledged project when its optional readiness read is %s",
    async (failure) => {
      fetcher.mockImplementation((path: string, init: RequestInit) => {
        if (path === "/api/strategy")
          return Promise.resolve(
            Response.json({ availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } }),
          );
        if (path.endsWith("/strategy") && init.method === "GET") {
          if (failure === "network") return Promise.reject(new TypeError("Synthetic network failure"));
          return Promise.resolve(Response.json({}, { status: failure === "malformed" ? 200 : 503 }));
        }
        return defaultFetch(path, init);
      });
      await render();
      await click("Send prompt");
      const body = JSON.parse(String(creations()[0]![1].body));
      expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${body.requestKey}?view=strategy`);
      expect(mutations()).toHaveLength(1);
      expect(window.sessionStorage.getItem(`fluid.prompt-buffer.v1:${owner}`)).toBeNull();
      await remountHome();
      expect(host.querySelector("textarea")!.value).toBe("");
    },
  );

  it.each([401, 403, 404])("does not conceal readiness authorization or missing-project error %s", async (status) => {
    fetcher.mockImplementation((path: string, init: RequestInit) => {
      if (path === "/api/strategy")
        return Promise.resolve(
          Response.json({ availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } }),
        );
      if (path.endsWith("/strategy") && init.method === "GET") return Promise.resolve(Response.json({}, { status }));
      return defaultFetch(path, init);
    });
    await render();
    await click("Send prompt");
    expect(mock.push).not.toHaveBeenCalled();
    expect(mutations()).toHaveLength(1);
    if (status === 401) expect(mock.expire).toHaveBeenCalledOnce();
  });

  it("saves the exact initial turn and opens the project before destination-owned research preparation", async () => {
    await render();
    await click("Send prompt");
    const body = JSON.parse(String(creations()[0]![1].body));
    expect(body.context.intake.guidedInterview.turns[0]).toMatchObject({
      inputRevision: 1,
      stage: "competitors",
      purpose: "research",
    });
    expect(body.context.intake.guidedInterview.turns[0]).toMatchObject({ stage: "competitors", purpose: "research" });
    expect(accountDrafts.get(body.requestKey)).toMatchObject({
      generation: 1,
      ownerId: owner,
      saved: { current_revision: 1, context: body.context },
    });
    expect(mutations()).toHaveLength(1);
    expect(fetcher.mock.calls.some(([, init]) => init.method === "PATCH")).toBe(false);
    expect(fetcher.mock.calls.filter(([path]) => path === "/api/strategy")).toHaveLength(1);
    expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${body.requestKey}?view=strategy`);
    expect(host.textContent).toContain("Project saved. Opening your project…");
    expect(host.querySelector(".home-composer")).toBeNull();
  });

  it("creates signed-in work with 50 legacy drafts without modifying their durable bytes", async () => {
    for (let i = 0; i < 50; i++)
      createLocalDraft({
        title: `Legacy ${i}`,
        scope: "complete_brand",
        description: `Unattributed retained work ${i}`,
        suppliedName: "",
        namingNotes: "",
        identityNotes: "",
        example: false,
      });
    const original = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    await render();
    await click("Save project");
    expect(creations()).toHaveLength(1);
    expect(mock.push).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(original);
    await remountHome();
    expect(host.querySelector("textarea")!.value).toBe("");
    expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(original);
  });

  it("keeps a pending new-account brief private after switching to another verified owner", async () => {
    fetcher.mockImplementation((path: string, init: RequestInit) =>
      path === "/api/projects" ? Promise.reject(new TypeError("Lost acknowledgement")) : defaultFetch(path, init),
    );
    await render();
    const original = host.querySelector("textarea")!.value;
    await click("Save project");
    const originalBuffer = window.sessionStorage.getItem(`fluid.prompt-buffer.v1:${owner}`);
    const firstOwner = owner;
    owner = crypto.randomUUID();
    mock.session = { status: "ready", userId: owner, generation: 2 };
    mock.memory!.bind(mock.session);
    await remountHome();
    expect(host.querySelector("textarea")!.value).toBe("");
    expect(host.textContent).not.toContain(original);
    expect(window.sessionStorage.getItem(`fluid.prompt-buffer.v1:${firstOwner}`)).toBe(originalBuffer);
    expect(creations()).toHaveLength(1);
  });

  it("requires an explicit continuation marker and lets a newer retained prompt take priority over an older account buffer", async () => {
    fetcher.mockImplementation((path: string, init: RequestInit) =>
      path === "/api/projects" ? Promise.reject(new TypeError("Lost acknowledgement")) : defaultFetch(path, init),
    );
    await render();
    await click("Save project");
    expect(window.sessionStorage.getItem(`fluid.prompt-buffer.v1:${owner}`)).not.toBeNull();
    window.sessionStorage.removeItem("fluid.prompt-sign-in.v1");
    await remountHome();
    expect(host.querySelector("textarea")!.value).toBe("");
    const id = createLocalDraft({
      title: "Explicitly retained prompt",
      scope: "complete_brand",
      description: "My newer prompt for sign-in",
      suppliedName: "",
      namingNotes: "",
      identityNotes: "",
      example: false,
    })!;
    rememberPromptForSignIn(id);
    await remountHome();
    expect(host.querySelector("textarea")!.value).toBe("My newer prompt for sign-in");
    expect(creations()).toHaveLength(1);
  });
});
