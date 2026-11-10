// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountSessionProvider } from "@/components/workspace/account-session";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoWorkspace } from "@/components/identity/use-logo-workspace";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";

/** The Logo and Creative direction steps read one shared logo memory in the project
 * conversation. Synthetic same-origin HTTP only; no provider or storage calls. */
let host: HTMLDivElement,
  root: Root | null = null;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
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
    } catch (e) {
      error = e;
    }
  }
  throw error;
}
function Reader({ name, projectId }: { name: string; projectId: string }) {
  const logo = useLogoWorkspace({ projectId, memory: useLogoDraftMemory() });
  const concepts = logo.stagePayloads?.concepts;
  return createElement(
    "p",
    {
      "data-reader": name,
      "data-revision": logo.workspace?.heads.workspaceRevision ?? "",
      "data-selected": concepts ? JSON.stringify(concepts.payload.selected) : "",
      "data-refinements": logo.stagePayloads?.refinements ? "yes" : "no",
    },
    createElement("button", { type: "button", onClick: () => void logo.reload(false) }, `Reload ${name}`),
  );
}
const reader = (name: string) => host.querySelector<HTMLElement>(`[data-reader="${name}"]`)!;
async function mount(projectId: string, fetcher: typeof fetch) {
  vi.stubGlobal("fetch", fetcher);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(
        AccountSessionProvider,
        null,
        createElement(Reader, { name: "logo", projectId }),
        createElement(Reader, { name: "directions", projectId }),
      ),
    ),
  );
}

it("gives both steps the saved selected logo when they open together", async () => {
  const f = await syntheticRefinementWorkspaceHttp();
  await mount(f.workspace.projectId, f.fetcher);
  const selected = JSON.stringify(f.source);
  await until(() => {
    expect(reader("logo").dataset.selected).toBe(selected);
    expect(reader("directions").dataset.selected).toBe(selected);
  });
  expect(f.selections).toEqual([]);
  expect(f.admissions).toEqual([]);
});

it("lets the other step follow a newer saved version that one step loaded", async () => {
  const f = await syntheticRefinementWorkspaceHttp();
  await mount(f.workspace.projectId, f.fetcher);
  await until(() => expect(reader("directions").dataset.selected).not.toBe(""));
  const before = Number(reader("directions").dataset.revision);
  // A refinement saved elsewhere advances the workspace; only the Logo step reloads.
  f.publish();
  await act(async () => reader("logo").querySelector("button")!.click());
  await until(() => {
    expect(Number(reader("directions").dataset.revision)).toBe(before + 1);
    expect(reader("directions").dataset.refinements).toBe("yes");
    expect(reader("directions").dataset.selected).toBe(JSON.stringify(f.source));
  });
  expect(f.selections).toEqual([]);
  expect(f.admissions).toEqual([]);
});
