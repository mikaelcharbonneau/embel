// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "../../src/components/workspace/account-session";
import { LogoCreationWorkspace } from "../../src/components/logo-creation/logo-creation-workspace";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";
import { logoFixtureId as id } from "../fixtures/logo-creation";
import type { LogoDraftMemory } from "../../src/components/identity/logo-draft-memory";

let root: Root | null = null,
  host: HTMLDivElement,
  memory: LogoDraftMemory | null = null;
const createUrl = vi.fn(),
  revokeUrl = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  const OriginalURL = URL;
  let nextUrl = 0;
  createUrl.mockReset().mockImplementation(() => `blob:synthetic-logo-${++nextUrl}`);
  revokeUrl.mockReset();
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
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
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  memory = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function until(check: () => void) {
  let error: unknown;
  for (let i = 0; i < 100; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    try {
      check();
      return;
    } catch (e) {
      error = e;
    }
  }
  throw error;
}
const refinementQuotes = (f: Awaited<ReturnType<typeof syntheticRefinementWorkspaceHttp>>) =>
  f.quotes.filter((quote) => quote.operation === "refine_preview");
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label);
/** Concept 1 shows its saved refinement; choosing that card's picture selects it (null while it cannot be chosen). */
const selection = () =>
  host.querySelector<HTMLElement>('[aria-label="Logo concepts"] button[aria-label="Concept 1"]:not(:disabled)');
async function click(label: string) {
  await until(() => expect(button(label)?.disabled).toBe(false));
  await act(async () => button(label)!.click());
}
async function mount(
  f: Awaited<ReturnType<typeof syntheticRefinementWorkspaceHttp>>,
  fetcher: typeof fetch = f.fetcher,
  mode: "setup" | "refine" = "setup",
) {
  vi.stubGlobal("fetch", fetcher);
  function Harness() {
    const account = useAccountSession();
    useLayoutEffect(() => {
      memory = account.logoDrafts;
    });
    return createElement(
      "main",
      null,
      createElement("p", null, "Synthetic fixture. No live provider, storage or charges."),
      createElement("button", { onClick: account.refresh }, "Recheck account"),
      createElement(LogoCreationWorkspace, { projectId: f.workspace.projectId, mode }),
    );
  }
  root = createRoot(host);
  await act(async () => root!.render(createElement(AccountSessionProvider, null, createElement(Harness))));
  // The Logo message names the saved brand once the workspace has loaded.
  await until(() => expect(host.querySelector(".logo-conversation-message")?.textContent).toContain("Élan & Co"));
}

describe("refinement history through actual workspace, account client and memory", () => {
  it("lost selection keeps its exact body/key for explicit check and retry", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true);
    f.loseSelection = true;
    await mount(f);
    await until(() => expect(selection()).not.toBeNull());
    await act(async () => selection()!.click());
    await until(() => expect(button("Check my choice")).toBeDefined());
    const original = structuredClone(f.selections[0]);
    expect(memory?.get(f.workspace.projectId)?.pendingMutation?.command).toMatchObject({
      method: "selectLogoRaster",
      body: original,
    });
    await click("Check my choice");
    expect(f.selections).toHaveLength(1);
    await click("Save my choice again");
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(f.selections).toEqual([original, original]);
    expect(f.admissions).toEqual([]);
    expect(refinementQuotes(f)).toEqual([]);
    expect(memory?.get(f.workspace.projectId)?.pendingMutation).toBeNull();
  });
  it("recovers an absent stale selection without resubmitting, then explicitly selects from fresh heads", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true);
    await mount(f);
    await until(() => expect(selection()).not.toBeNull());
    // Another committed stage update advances the authoritative workspace after
    // this tab loaded. The strict synthetic server rejects its old CAS body.
    f.publish();
    await act(async () => selection()!.click());
    await until(() => expect(button("Check my choice")).toBeDefined());
    const original = structuredClone(f.selections[0]),
      latestHeads = structuredClone(f.workspace.heads);
    expect(host.textContent).toContain("Your logo changed elsewhere. Check your choice");
    await click("Check my choice");
    await until(() => expect(button("Check my choice")).toBeUndefined());
    expect(host.textContent).toContain("Choose your logo again.");
    expect(f.selections).toEqual([original]);
    expect(memory?.get(f.workspace.projectId)?.base).toEqual(latestHeads);
    await until(() => expect(selection()).not.toBeNull());
    await act(async () => selection()!.click());
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(f.selections).toHaveLength(2);
    expect(f.selections[1]?.expected).toEqual(latestHeads);
    expect(f.selections[1]?.requestKey).not.toBe(original?.requestKey);
    expect(f.selections[1]?.source).toEqual(original?.source);
    expect(f.admissions).toEqual([]);
    expect(refinementQuotes(f)).toEqual([]);
    expect(JSON.stringify(f.batch)).toBe(f.originalBatch);
  });
  it("retains and selects successful history when image generation is unavailable", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true);
    f.imageAvailable = false;
    await mount(f);
    await until(() => expect(selection()).not.toBeNull());
    expect(host.textContent).not.toContain("Confirmed charge");
    await act(async () => selection()!.click());
    await until(() => expect(selection()?.getAttribute("aria-pressed")).toBe("true"));
    expect(f.admissions).toEqual([]);
  });
  it("account change fences a delayed detail and releases verified preview URLs", async () => {
    const f = await syntheticRefinementWorkspaceHttp(true);
    let resolve!: (response: Response) => void;
    let detailSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (path, init) =>
      String(path).endsWith(`/raster-refinements/${id(503)}`)
        ? ((detailSignal = init?.signal),
          new Promise<Response>((yes) => {
            resolve = yes;
          }))
        : f.fetcher(path, init);
    await mount(f, fetcher);
    await until(() => expect(resolve).toBeTypeOf("function"));
    await until(() => expect(createUrl.mock.results.length).toBeGreaterThan(0));
    const shown = createUrl.mock.results.map((result) => result.value);
    f.owner = id(999);
    await click("Recheck account");
    await until(() => expect(selection()).toBeNull());
    expect(detailSignal?.aborted).toBe(true);
    await act(async () => resolve(Response.json(f.raster)));
    expect(selection()).toBeNull();
    expect(f.selections).toEqual([]);
    for (const url of shown) expect(revokeUrl).toHaveBeenCalledWith(url);
  });
});
