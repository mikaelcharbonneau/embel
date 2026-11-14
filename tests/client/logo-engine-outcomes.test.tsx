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

// What the Logo screen says when a read fails, a request is refused, or a run ends without its result
// (docs/state-machines.md, S2 and S3). Synthetic same-origin HTTP: no provider, database or Storage service.
let root: Root, host: HTMLDivElement, chat: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  let next = 0;
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = vi.fn(() => `blob:outcome-${++next}`);
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
  const state = { reply: null as StepReply | null, messages: [] as (string | null)[] };
  await render(
    projectId,
    fetcher,
    { reply: "external", onReplyChange: (value) => (state.reply = value), onContinue: vi.fn() },
    {
      chat,
      overlay: null,
      setRows: vi.fn(),
      setSummary: vi.fn(),
      setMessage: (_step, text) => state.messages.push(text),
    },
  );
  await until(drawn);
  await until(() => expect(state.reply?.acceptsText).toBe(true));
  return state;
}
const refused = {
  busy: "Your logo details changed or a set is still being drawn. Your work is kept; try again in a moment.",
  limit: "You’ve reached today’s limit for this. Your logos are saved. Try again tomorrow.",
  off: "Logo drawing is unavailable right now. Nothing has started and nothing was used.",
  unknown: "This request could not be confirmed. Your logos are kept; check again before trying once more.",
};

describe("S3: reading the concepts while they are drawn", () => {
  it("keeps checking after one failed read, and a later read clears “unavailable”", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      base = `/api/projects/${projectId}/logo`;
    let failing = true,
      readsAfterRecovery = 0;
    const drawing = engineRun(id(5100), "logo.concepts", "running", {
      outputs: [{ key: "batch", output: { batchId: f.batch.id } }],
    });
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      // The round is drawing for the whole test: only the reads change.
      if (path === `${base}/engine`) return Response.json({ engine: true, runs: [drawing] });
      if (path === `${base}/batches/${f.batch.id}`) {
        if (failing) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
        readsAfterRecovery++;
      }
      return f.fetcher(input, init);
    };
    await render(projectId, fetcher);
    await until(() => expect(host.textContent).toContain("Saved concept details unavailable"));
    // Nothing else changes from here: the round is still drawing and only the next check can recover.
    failing = false;
    await until(() => {
      expect(readsAfterRecovery).toBeGreaterThan(0);
      expect(host.textContent).not.toContain("Saved concept details unavailable");
      drawn();
    });
  }, 30_000);
});

describe("S2: a refused Logo request inside the Workspace", () => {
  it("says why a change was refused, in the chat, and clears it once a request starts", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      base = `/api/projects/${projectId}/logo`,
      runId = id(5200);
    let answer: 409 | 429 | 503 | "offline" | "started" = 409,
      started = false;
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `${base}/engine`)
        return Response.json({ engine: true, runs: started ? [engineRun(runId, "logo.refine", "running")] : [] });
      if (path === `/api/projects/${projectId}/generations` && init?.method === "POST") {
        if (answer === "offline") throw new TypeError("Failed to fetch");
        if (answer !== "started") return Response.json({ error: { code: "refused" } }, { status: answer });
        started = true;
        return Response.json({ run: engineRun(runId, "logo.refine", "running") }, { status: 202 });
      }
      return f.fetcher(input, init);
    };
    const state = await inWorkspace(projectId, fetcher);
    for (const [status, sentence] of [
      [409, refused.busy],
      [429, refused.limit],
      [503, refused.off],
      ["offline", refused.unknown],
    ] as const) {
      answer = status;
      await act(async () => state.reply!.send("Make the lettering bolder"));
      await until(() => expect(chat.textContent).toContain(sentence));
      // Once, and never a price.
      expect(chat.textContent!.split(sentence).length).toBe(2);
      expect(chat.textContent).not.toMatch(/\$\d/u);
    }
    answer = "started";
    await until(() => expect(state.reply?.acceptsText).toBe(true));
    await act(async () => state.reply!.send("Make the lettering bolder"));
    await until(() => expect(chat.textContent).toContain("Changing your logo."));
    for (const sentence of Object.values(refused)) expect(chat.textContent).not.toContain(sentence);
  }, 60_000);

  it("says why “Retry 1 failed concept” was refused", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      base = `/api/projects/${projectId}/logo`;
    const posts: { kind: string }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `${base}/engine`) return Response.json({ engine: true, runs: [] });
      if (path === `/api/projects/${projectId}/generations` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return Response.json({ error: { code: "daily_limit" } }, { status: 429 });
      }
      return f.fetcher(input, init);
    };
    await inWorkspace(projectId, fetcher);
    const retry = () => chat.querySelector<HTMLButtonElement>('button[aria-label="Retry 1 failed concept"]');
    await until(() => expect(retry()?.disabled).toBe(false));
    await act(async () => retry()!.click());
    await until(() => expect(posts.map((post) => post.kind)).toEqual(["logo.concepts"]));
    await until(() => expect(chat.textContent).toContain(refused.limit));
    expect(chat.textContent!.split(refused.limit).length).toBe(2);
  }, 30_000);

  it("keeps the screen outside the Workspace as it was: the refusal sits under the action that was refused", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      base = `/api/projects/${projectId}/logo`;
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `${base}/engine`) return Response.json({ engine: true, runs: [] });
      if (path === `/api/projects/${projectId}/generations` && init?.method === "POST")
        return Response.json({ error: { code: "busy" } }, { status: 409 });
      return f.fetcher(input, init);
    };
    await render(projectId, fetcher);
    await until(drawn);
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a change to this logo"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Bolder");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const refine = () => host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]')!;
    await until(() => expect(refine().disabled).toBe(false));
    await act(async () => refine().click());
    await until(() => expect(host.textContent).toContain(refused.busy));
    expect(host.textContent!.split(refused.busy).length).toBe(2);
    expect(host.querySelector('[aria-label="Refine"][role="group"]')?.textContent).toContain(refused.busy);
  }, 30_000);
});

describe("S2: a Logo run that ends without its result", () => {
  const timedOut =
    "The change to your logo took too long and didn’t finish. Credits for anything not delivered were returned, so you can try again.";

  it("says in the chat that a change timed out, and stops saying so once a newer change starts", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      base = `/api/projects/${projectId}/logo`;
    const runs: ReturnType<typeof engineRun>[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `${base}/engine`) return Response.json({ engine: true, runs });
      if (path === `/api/projects/${projectId}/generations` && init?.method === "POST") {
        runs.unshift(
          engineRun(id(5300 + runs.length), "logo.refine", "running", {
            createdAt: `2026-11-14T10:0${runs.length}:00.000Z`,
          }),
        );
        return Response.json({ run: runs[0] }, { status: 202 });
      }
      return f.fetcher(input, init);
    };
    const state = await inWorkspace(projectId, fetcher);
    const before = state.messages.at(-1)!;
    expect(before).toMatch(/^Concept 1 is your logo\. /u);
    await act(async () => state.reply!.send("Make the lettering bolder"));
    await until(() => expect(state.messages.at(-1)).toMatch(/^I’m changing your logo\./u));
    runs[0] = { ...runs[0]!, status: "failed", errorCode: "run_timed_out", finishedAt: "2026-11-14T10:16:00.000Z" };
    // Embel says what happened, then what the person can do now.
    await until(() => expect(state.messages.at(-1)).toBe(`${timedOut} ${before}`));
    await until(() => expect(state.reply?.acceptsText).toBe(true));
    await act(async () => state.reply!.send("Make the lettering bolder"));
    await until(() => expect(state.messages.at(-1)).toMatch(/^I’m changing your logo\./u));
    runs[0] = { ...runs[0]!, status: "cancelled", cancelRequested: true, finishedAt: "2026-11-14T10:17:00.000Z" };
    // Stopped by the person is not a failure.
    await until(() => expect(state.messages.at(-1)).toBe(`The change to your logo was stopped. ${before}`));
    expect(state.messages.join("\n")).not.toMatch(/\$\d/u);
  }, 60_000);

  it("says so outside the Workspace too", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      base = `/api/projects/${projectId}/logo`;
    const runs: ReturnType<typeof engineRun>[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `${base}/engine`) return Response.json({ engine: true, runs });
      if (path === `/api/projects/${projectId}/generations` && init?.method === "POST") {
        runs.unshift(engineRun(id(5400), "logo.refine", "running"));
        return Response.json({ run: runs[0] }, { status: 202 });
      }
      return f.fetcher(input, init);
    };
    await render(projectId, fetcher);
    await until(drawn);
    expect(host.textContent).not.toContain("The change to your logo");
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a change to this logo"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Bolder");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const refine = () => host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]')!;
    await until(() => expect(refine().disabled).toBe(false));
    await act(async () => refine().click());
    await until(() => expect(host.textContent).toContain("Refining your logo…"));
    runs[0] = { ...runs[0]!, status: "failed", errorCode: "run_timed_out", finishedAt: "2026-11-14T10:16:00.000Z" };
    await until(() => expect(host.textContent).toContain(timedOut));
    expect(host.textContent!.split(timedOut).length).toBe(2);
  }, 30_000);

  it("does not bring up a run that ended before the page opened", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      base = `/api/projects/${projectId}/logo`;
    const old = engineRun(id(5500), "logo.refine", "failed", { errorCode: "run_timed_out" });
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `${base}/engine`) return Response.json({ engine: true, runs: [old] });
      return f.fetcher(input, init);
    };
    const state = await inWorkspace(projectId, fetcher);
    expect(state.messages.at(-1)).toMatch(/^Concept 1 is your logo\. /u);
    expect(chat.textContent).not.toContain("didn’t finish");
  }, 30_000);
});
