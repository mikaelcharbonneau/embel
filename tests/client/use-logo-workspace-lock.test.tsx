// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountSessionProvider } from "@/components/workspace/account-session";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoWorkspace } from "@/components/identity/use-logo-workspace";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";

/** docs/state-machines.md, S4: the Logo workspace does one thing at a time. A reload asked for while
 * something else runs waits for it; it is never answered "could not be loaded" when nothing failed.
 * Synthetic same-origin HTTP only. */
let host: HTMLDivElement,
  root: Root | null = null,
  api: ReturnType<typeof useLogoWorkspace>;
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
function Reader({ projectId }: { projectId: string }) {
  const logo = useLogoWorkspace({ projectId, memory: useLogoDraftMemory() });
  useLayoutEffect(() => {
    api = logo;
  });
  return null;
}
/** The fixture's HTTP, with the workspace read held back while `hold` is set. */
async function mounted() {
  const f = await syntheticRefinementWorkspaceHttp(),
    projectId = f.workspace.projectId;
  const state = { reads: 0, hold: null as Promise<void> | null };
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).split("?")[0] === `/api/projects/${projectId}/logo`) {
      state.reads++;
      await state.hold;
    }
    return f.fetcher(input, init);
  };
  vi.stubGlobal("fetch", fetcher);
  root = createRoot(host);
  await act(async () =>
    root!.render(createElement(AccountSessionProvider, null, createElement(Reader, { projectId }))),
  );
  await until(() => {
    expect(api.status).toBe("ready");
    expect(api.pending).toBe(false);
    expect(api.stagePayloads?.concepts).toBeTruthy();
  });
  return { f, state };
}
function gate() {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
}

it("runs a reload asked for during another reload once that one finishes, and reports what it loaded", async () => {
  const { f, state } = await mounted();
  const before = api.workspace!.heads.workspaceRevision,
    readsBefore = state.reads;
  const held = gate();
  state.hold = held.closed;
  let first!: Promise<string>, second!: Promise<string>, third!: Promise<string>;
  await act(async () => {
    first = api.reload(false);
  });
  expect(state.reads).toBe(readsBefore + 1);
  // A round ends meanwhile and saves a newer version; the screen asks to reload for it, twice.
  f.publish();
  await act(async () => {
    second = api.reload(false);
    third = api.reload(false);
  });
  // Nothing failed, so nothing is reported yet: the reload waits its turn.
  const early = await Promise.race([second, new Promise((resolve) => setTimeout(() => resolve("waiting"), 30))]);
  expect(early).toBe("waiting");
  state.hold = null;
  await act(async () => held.open());
  await until(() => expect(api.pending).toBe(false));
  expect(await first).toBe("reloaded");
  expect(await second).toBe("reloaded");
  expect(await third).toBe("reloaded");
  // One queued reload, not two, and it read the newest saved version.
  expect(state.reads).toBe(readsBefore + 2);
  expect(api.workspace!.heads.workspaceRevision).toBe(before + 1);
  expect(api.error).toBeNull();
});
