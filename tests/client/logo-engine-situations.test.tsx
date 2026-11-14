// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider } from "@/components/workspace/account-session";
import { LogoCreationWorkspace } from "@/components/logo-creation/logo-creation-workspace";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";
import { logoFixtureId as id } from "../fixtures/logo-creation";
import type { StepReply } from "@/features/logo-creation/model/step-reply";
import { WorkspaceSlotContext } from "@/components/workspace/workspace-slots";

// The Logo screen answers the same server situations as Naming and Creative direction
// (docs/state-machines.md, "The same server situation"). Synthetic same-origin HTTP: no provider, database or
// Storage service.
let root: Root, host: HTMLDivElement, chat: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  let next = 0;
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = vi.fn(() => `blob:situation-${++next}`);
      static revokeObjectURL = vi.fn();
    },
  );
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  host = document.createElement("div");
  chat = document.createElement("div");
  document.body.append(host, chat);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  chat.remove();
  vi.unstubAllGlobals();
});
async function until(check: () => void, rounds = 160) {
  let error: unknown;
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    try {
      check();
      return;
    } catch (cause) {
      error = cause;
    }
  }
  throw error;
}
const grid = () => host.querySelector('[aria-label="Logo concepts"]');
const drawn = () => expect(grid()?.querySelector('img[src^="blob:"]')).toBeTruthy();
async function render(
  projectId: string,
  fetcher: typeof fetch,
  props: Partial<Parameters<typeof LogoCreationWorkspace>[0]> = {},
  slots: ComponentProps<typeof WorkspaceSlotContext.Provider>["value"] = null,
) {
  vi.stubGlobal("fetch", fetcher);
  await act(async () =>
    root.render(
      createElement(
        WorkspaceSlotContext.Provider,
        { value: slots },
        createElement(AccountSessionProvider, null, createElement(LogoCreationWorkspace, { projectId, ...props })),
      ),
    ),
  );
}
type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
const engineRun = (
  runId: string,
  kind: string,
  status: RunStatus,
  over: { errorCode?: string | null; cancelRequested?: boolean; outputs?: unknown[]; createdAt?: string } = {},
) => ({
  id: runId,
  kind,
  status,
  credits: 1,
  errorCode: null,
  cancelRequested: false,
  createdAt: "2026-11-14T10:00:00.000Z",
  finishedAt: status === "queued" || status === "running" ? null : "2026-11-14T10:02:00.000Z",
  inputRevision: 1,
  outputs: [],
  ...over,
});
/** The Logo screen as the Workspace shows it: Send-driven, with Embel's words in the chat. */
async function inWorkspace(projectId: string, fetcher: typeof fetch) {
  const state = { reply: null as StepReply | null };
  await render(
    projectId,
    fetcher,
    { reply: "external", onReplyChange: (value) => (state.reply = value), onContinue: vi.fn() },
    { chat, overlay: null, setRows: vi.fn(), setSummary: vi.fn(), setMessage: vi.fn() },
  );
  await until(drawn);
  await until(() => expect(state.reply).not.toBeNull());
  return state;
}
const chatButton = (name: string) =>
  [...chat.querySelectorAll("button")].find((button) => button.textContent?.trim() === name);
const delayed = "Updates are delayed. Still working, and checking again.";
const stopFailed = "Stop couldn’t be confirmed.";
const unconfirmed = "This request could not be confirmed. Your logos are kept; check again before trying once more.";
const loadFailed = "Logo drawing couldn’t be loaded. Your logos are saved.";

describe("Stop asked, run still working", () => {
  it("says Stopping in the chat and the reply box of a tab that never pressed Stop", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId;
    const stoppingRun = engineRun(id(6100), "logo.refine", "running", { cancelRequested: true });
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `/api/projects/${projectId}/logo/engine`)
        return Response.json({ engine: true, runs: [stoppingRun] });
      return f.fetcher(input, init);
    };
    const state = await inWorkspace(projectId, fetcher);
    await until(() => expect(state.reply).toMatchObject({ working: true, stopping: true }));
    expect(state.reply!.stop).toBeUndefined();
    expect(chat.textContent).toContain("Stopping…");
  }, 30_000);
});

describe("Stop request fails", () => {
  it("says Stop couldn't be confirmed, with Try again, and keeps Stop", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      runId = id(6200);
    let run = engineRun(runId, "logo.refine", "running"),
      failing = true,
      stops = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `/api/projects/${projectId}/logo/engine`) return Response.json({ engine: true, runs: [run] });
      if (path === `/api/projects/${projectId}/generations/${runId}/cancel`) {
        stops++;
        if (failing) return Response.json({ error: { code: "unavailable" } }, { status: 500 });
        run = { ...run, cancelRequested: true };
        return Response.json({ run });
      }
      return f.fetcher(input, init);
    };
    const state = await inWorkspace(projectId, fetcher);
    await until(() => expect(state.reply?.stop).toBeDefined());
    await act(async () => state.reply!.stop!());
    await until(() => expect(chat.textContent).toContain(stopFailed));
    expect(chat.textContent!.split(stopFailed).length).toBe(2);
    // The run is still working and can still be stopped.
    expect(state.reply).toMatchObject({ working: true, stopping: false });
    expect(state.reply!.stop).toBeDefined();
    expect(chat.textContent).toContain("Changing your logo.");
    failing = false;
    await act(async () => chatButton("Try again")!.click());
    await until(() => expect(state.reply?.stopping).toBe(true));
    expect(stops).toBe(2);
    expect(chat.textContent).not.toContain(stopFailed);
    expect(state.reply!.stop).toBeUndefined();
  }, 30_000);
});

describe("a status check fails while the run is still working", () => {
  it("keeps progress and Stop, says updates are delayed, and keeps checking", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId;
    const run = engineRun(id(6300), "logo.refine", "running");
    let failing = false,
      readsAfterRecovery = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `/api/projects/${projectId}/logo/engine`) {
        if (failing) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
        readsAfterRecovery++;
        return Response.json({ engine: true, runs: [run] });
      }
      return f.fetcher(input, init);
    };
    const state = await inWorkspace(projectId, fetcher);
    await until(() => expect(state.reply?.stop).toBeDefined());
    expect(chat.textContent).not.toContain(delayed);
    failing = true;
    await until(() => expect(chat.textContent).toContain(delayed));
    // Never as if the run ended.
    expect(chat.textContent).toContain("Changing your logo.");
    expect(state.reply).toMatchObject({ working: true, stopping: false });
    expect(state.reply!.stop).toBeDefined();
    failing = false;
    readsAfterRecovery = 0;
    await until(() => {
      expect(readsAfterRecovery).toBeGreaterThan(0);
      expect(chat.textContent).not.toContain(delayed);
    }, 300);
    expect(state.reply?.working).toBe(true);
  }, 60_000);
});

describe("first load fails", () => {
  it("says so with Try again instead of “Getting ready…” with no end", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId;
    let failing = true,
      reads = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `/api/projects/${projectId}/logo/engine`) {
        reads++;
        if (failing) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
        return Response.json({ engine: true, runs: [] });
      }
      return f.fetcher(input, init);
    };
    await render(projectId, fetcher);
    await until(() => expect(host.textContent).toContain(loadFailed));
    expect(host.textContent).not.toContain("Getting ready…");
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Try again")!;
    failing = false;
    const before = reads;
    await act(async () => retry.click());
    await until(() => {
      expect(reads).toBeGreaterThan(before);
      expect(host.textContent).not.toContain(loadFailed);
    }, 40);
  }, 30_000);
});

describe("a start that couldn't be confirmed", () => {
  it("keeps the request's key for Try again, after looking the run up", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      runId = id(6500);
    const posts: { idempotencyKey: string }[] = [];
    let answer: 503 | "offline" | "started" = 503,
      started = false,
      lookups = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `/api/projects/${projectId}/logo/engine`) {
        if (posts.length) lookups++;
        return Response.json({ engine: true, runs: started ? [engineRun(runId, "logo.refine", "running")] : [] });
      }
      if (path === `/api/projects/${projectId}/generations` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        if (answer === "offline") throw new TypeError("Failed to fetch");
        if (answer !== "started") return Response.json({ error: { code: "unavailable" } }, { status: answer });
        started = true;
        return Response.json({ run: engineRun(runId, "logo.refine", "running") }, { status: 202 });
      }
      return f.fetcher(input, init);
    };
    const state = await inWorkspace(projectId, fetcher);
    await until(() => expect(state.reply?.acceptsText).toBe(true));
    await act(async () => state.reply!.send("Make the lettering bolder"));
    await until(() => expect(chat.textContent).toContain(unconfirmed));
    // The run was looked up before Try again was offered.
    expect(lookups).toBeGreaterThan(0);
    answer = "offline";
    await act(async () => chatButton("Try again")!.click());
    await until(() => expect(posts).toHaveLength(2));
    await until(() => expect(chatButton("Try again")).toBeDefined());
    answer = "started";
    await act(async () => chatButton("Try again")!.click());
    await until(() => expect(chat.textContent).toContain("Changing your logo."));
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((post) => post.idempotencyKey)).size).toBe(1);
    expect(chat.textContent).not.toContain(unconfirmed);
  }, 60_000);

  it("shows the run it started when the lookup finds it, and sends nothing twice", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      runId = id(6600);
    let posts = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `/api/projects/${projectId}/logo/engine`)
        return Response.json({ engine: true, runs: posts ? [engineRun(runId, "logo.refine", "running")] : [] });
      if (path === `/api/projects/${projectId}/generations` && init?.method === "POST") {
        posts++;
        // Admitted, but the answer was lost.
        return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      }
      return f.fetcher(input, init);
    };
    const state = await inWorkspace(projectId, fetcher);
    await until(() => expect(state.reply?.acceptsText).toBe(true));
    await act(async () => state.reply!.send("Make the lettering bolder"));
    await until(() => expect(chat.textContent).toContain("Changing your logo."));
    expect(chat.textContent).not.toContain(unconfirmed);
    expect(state.reply).toMatchObject({ working: true });
    expect(posts).toBe(1);
  }, 30_000);

  it("makes a new key for a new request once the earlier one was answered", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId;
    const posts: { idempotencyKey: string }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `/api/projects/${projectId}/logo/engine`) return Response.json({ engine: true, runs: [] });
      if (path === `/api/projects/${projectId}/generations` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return Response.json({ error: { code: "busy" } }, { status: 409 });
      }
      return f.fetcher(input, init);
    };
    const state = await inWorkspace(projectId, fetcher);
    await until(() => expect(state.reply?.acceptsText).toBe(true));
    for (const count of [1, 2]) {
      await act(async () => state.reply!.send("Make the lettering bolder"));
      await until(() => expect(posts).toHaveLength(count));
    }
    // A final refusal started nothing: the next click is a new request.
    expect(new Set(posts.map((post) => post.idempotencyKey)).size).toBe(2);
    expect(chatButton("Try again")).toBeUndefined();
  }, 30_000);
});
