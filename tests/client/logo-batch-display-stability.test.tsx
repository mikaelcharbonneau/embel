// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { LogoCreationWorkspace } from "@/components/logo-creation/logo-creation-workspace";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";

// Actual account/client/memory, synthetic HTTP, one verified raster and six cards.
// This does not claim six decoded images, browser rendering or provider validation.
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  let next = 0;
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = vi.fn(() => `blob:batch-${++next}`);
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
async function until(check: () => void) {
  let error: unknown;
  for (let i = 0; i < 100; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
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
const image = () => grid()?.querySelector('img[src^="blob:"]') ?? null;
const select = () => grid()?.querySelector<HTMLElement>('[role="button"][aria-label="Select concept 1"]') ?? null;
const action = (label: string) => grid().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
// Refining now starts from the one refine box below the gallery, with its own request gating.
const actions = ["More concepts", "Retry 1 failed concept"];
async function mount(projectId: string, fetcher: typeof fetch) {
  vi.stubGlobal("fetch", fetcher);
  function App() {
    const account = useAccountSession();
    return createElement(
      "main",
      null,
      createElement("button", { onClick: account.refresh }, "Recheck account"),
      createElement(LogoCreationWorkspace, { projectId }),
    );
  }
  await act(async () => root.render(createElement(AccountSessionProvider, null, createElement(App))));
  await until(() => expect(image()).not.toBeNull());
}
async function instruction() {
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a change to this logo"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Simplify the shape");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("same-batch display across selection revisions", () => {
  it.each(["succeeds", "fails"] as const)(
    "retains the gallery but locks batch actions while the post-selection recheck is held and then %s",
    async (outcome) => {
      const f = await syntheticRefinementWorkspaceHttp();
      let release: (() => void) | undefined,
        hold = true;
      const pending: (() => void)[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        if (String(input).endsWith("/capabilities")) {
          const response = await f.fetcher(input, init),
            value = await response.json();
          value.operations["identity.logo_concept"] = {
            status: "available",
            expiresAt: new Date(Date.parse(value.observedAt) + 30000).toISOString(),
          };
          return Response.json(value);
        }
        if (String(input).endsWith("/concepts/selection")) {
          const { batchId, slotId, attemptId, ...command } = JSON.parse(String(init?.body));
          return f.fetcher(String(input).replace("/concepts/selection", "/rasters/selection"), {
            ...init,
            body: JSON.stringify({ ...command, source: { kind: "concept", batchId, slotId, attemptId } }),
          });
        }
        if (String(input).endsWith(`/batches/${f.batch.id}`) && f.selections.length) {
          if (hold)
            await new Promise<void>((resolve) => {
              pending.push(resolve);
              release = () => {
                hold = false;
                pending.splice(0).forEach((done) => done());
              };
            });
          if (outcome === "fails") return Response.json({}, { status: 503 });
        }
        return f.fetcher(input, init);
      };
      await mount(f.workspace.projectId, fetcher);
      await instruction();
      await until(() => {
        expect(select()).not.toBeNull();
        for (const label of actions) expect(action(label).disabled, label).toBe(false);
      });
      const before = image()!,
        url = before.getAttribute("src"),
        card = before.closest("li")!;
      try {
        await act(async () => select()!.click());
        await until(() => expect(release).toBeTypeOf("function"));
        expect(image()).toBe(before);
        expect(before.closest("li")).toBe(card);
        expect(before.getAttribute("src")).toBe(url);
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url);
        expect(grid().querySelectorAll("ol > li")).toHaveLength(6);
        expect(select()).toBeNull();
        for (const label of actions) expect(action(label).disabled, label).toBe(true);
        await act(async () => {
          for (const label of actions) action(label).click();
        });
        expect(f.admissions).toEqual([]);
        await act(async () => release!());
        if (outcome === "succeeds")
          await until(() => {
            expect(select()).not.toBeNull();
            for (const label of actions) expect(action(label).disabled, label).toBe(false);
          });
        else {
          await until(() => expect(grid().textContent).toContain("Saved concept details unavailable"));
          expect(select()).toBeNull();
          for (const label of actions) expect(action(label).disabled, label).toBe(true);
        }
        expect(image()).toBe(before);
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(url);
        expect(grid().textContent).toContain("Logo chosen");
        expect(f.selections).toHaveLength(1);
        expect(f.admissions).toEqual([]);
      } finally {
        await act(async () => release?.());
      }
    },
  );
});
