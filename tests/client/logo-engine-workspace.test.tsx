// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { LogoCreationWorkspace } from "@/components/logo-creation/logo-creation-workspace";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";
import { logoFixtureId as id } from "../fixtures/logo-creation";
import type { StepReply } from "@/features/logo-creation/model/step-reply";

// The Logo screen on the generation engine, with the actual account, client and memory
// over synthetic same-origin HTTP. No provider, database or Storage service.
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  let next = 0;
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = vi.fn(() => `blob:engine-${++next}`);
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
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
/** The engine is checked every 3 s while a run works, so these waits allow a few checks. */
async function until(check: () => void, rounds = 100) {
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
const grid = () => host.querySelector('[aria-label="Logo concepts"]')!;
const button = (text: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === text) ?? null;
async function mount(
  projectId: string,
  fetcher: typeof fetch,
  props: Partial<Parameters<typeof LogoCreationWorkspace>[0]> = {},
) {
  vi.stubGlobal("fetch", fetcher);
  function App() {
    const account = useAccountSession();
    return createElement(
      "main",
      null,
      createElement("button", { onClick: account.refresh }, "Recheck account"),
      createElement(LogoCreationWorkspace, { projectId, ...props }),
    );
  }
  await act(async () => root.render(createElement(AccountSessionProvider, null, createElement(App))));
  await until(() => expect(grid()?.querySelector('img[src^="blob:"]')).toBeTruthy());
}
async function instruction(value: string) {
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a change to this logo"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the Logo screen on the generation engine", () => {
  it("refines with one click and no quote, offers Stop while it runs, then chooses the refined logo", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      base = `/api/projects/${projectId}/logo`,
      runId = id(5000);
    const posts: { kind: string; idempotencyKey: string; input: Record<string, unknown> }[] = [],
      cancels: string[] = [];
    let status: "running" | "succeeded" = "running";
    const run = () => ({
      id: runId,
      kind: "logo.refine",
      status,
      credits: 1,
      errorCode: null,
      cancelRequested: cancels.length > 0,
      createdAt: "2026-11-09T20:00:00.000Z",
      finishedAt: status === "running" ? null : "2026-11-09T20:02:00.000Z",
      inputRevision: 1,
      outputs: [],
    });
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `${base}/engine`) return Response.json({ engine: true, runs: posts.length ? [run()] : [] });
      if (path === `/api/projects/${projectId}/generations` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return Response.json({ run: run() }, { status: 202 });
      }
      if (path === `/api/projects/${projectId}/generations/${runId}/cancel`) {
        cancels.push(runId);
        return Response.json({ run: run() });
      }
      return f.fetcher(input, init);
    };
    await mount(projectId, fetcher);
    await instruction("Make the lettering bolder");
    const refine = () => host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]')!;
    await until(() => expect(refine().disabled).toBe(false));
    await act(async () => refine().click());
    await until(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      kind: "logo.refine",
      idempotencyKey: expect.stringMatching(/^logo:logo\.refine:[0-9a-f-]{36}$/u),
      input: { expected: f.workspace.heads, source: f.source, instruction: "Make the lettering bolder" },
    });
    // No quote, no admission, no cost: one click started the run.
    expect(f.quotes).toEqual([]);
    expect(f.admissions).toEqual([]);
    expect(host.textContent).not.toMatch(/\$\d/u);
    await until(() => expect(button("Stop")).not.toBeNull());
    expect(host.textContent).toContain("Refining your logo…");
    await act(async () => button("Stop")!.click());
    await until(() => expect(cancels).toEqual([runId]));
    // The refinement lands under the run's id, as an old request key would.
    f.publish(runId);
    status = "succeeded";
    await until(() => expect(f.selections).toHaveLength(1), 200);
    expect(f.selections[0]!.source).toEqual({ kind: "refinement", rasterRevisionId: f.raster.id });
  }, 30_000);

  it("explains running out of credits on the action that was refused, without a price", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      base = `/api/projects/${projectId}/logo`;
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `${base}/engine`) return Response.json({ engine: true, runs: [] });
      if (path === `/api/projects/${projectId}/generations` && init?.method === "POST")
        return Response.json({ error: { code: "insufficient_credits" } }, { status: 402 });
      if (path === "/api/credits")
        return Response.json({ credits: { planId: "free", balance: 0, periodEnd: "2026-12-01T00:00:00.000Z" } });
      return f.fetcher(input, init);
    };
    await mount(projectId, fetcher);
    await instruction("Make the lettering bolder");
    const refine = () => host.querySelector<HTMLButtonElement>('button[aria-label="Refine"]')!;
    await until(() => expect(refine().disabled).toBe(false));
    await act(async () => refine().click());
    // The refusal shows the Out-of-credits message in place (D-015), once, with the way to Plans.
    await until(() =>
      expect(host.textContent).toContain(
        "You’ve used this month’s credits. New credits arrive on December 1. Your work is saved.",
      ),
    );
    expect(host.textContent!.split("used this month").length).toBe(2);
    expect([...host.querySelectorAll("a")].some((link) => link.textContent === "See plans")).toBe(true);
    expect(host.textContent).not.toMatch(/\$\d/u);
    expect(f.quotes).toEqual([]);
  }, 30_000);

  it("hands a Send-driven reply box the chosen concept, and Send with text changes it with one request", async () => {
    const f = await syntheticRefinementWorkspaceHttp(),
      projectId = f.workspace.projectId,
      base = `/api/projects/${projectId}/logo`;
    const posts: { kind: string; input: Record<string, unknown> }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input).split("?")[0]!;
      if (path === `${base}/engine`) return Response.json({ engine: true, runs: [] });
      if (path === `/api/projects/${projectId}/generations` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return Response.json({ error: { code: "busy" } }, { status: 409 });
      }
      return f.fetcher(input, init);
    };
    let reply: StepReply | null = null;
    const onContinue = vi.fn();
    await mount(projectId, fetcher, { reply: "external", onReplyChange: (value) => (reply = value), onContinue });
    // The reply box carries the step: no Continue button and no change box of its own.
    expect(button("Continue")).toBeNull();
    expect(host.querySelector('textarea[aria-label="Describe a change to this logo"]')).toBeNull();
    await until(() => {
      expect(reply?.chips.map((chip) => chip.label)).toEqual(["Logo: Concept 1"]);
      expect(reply?.canSend).toBe(true);
      expect(reply?.acceptsText).toBe(true);
    });
    expect(reply!.sendLabel).toBe("Continue to Creative direction");
    expect(reply!.outOfCredits).toBe(false);
    await act(async () => reply!.send("Make the lettering bolder"));
    await until(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.kind).toBe("logo.refine");
    expect(posts[0]!.input.instruction).toBe("Make the lettering bolder");
    expect(onContinue).not.toHaveBeenCalled();
    await act(async () => reply!.send(""));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(f.quotes).toEqual([]);
  }, 30_000);
});
