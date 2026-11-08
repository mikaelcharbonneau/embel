// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountSessionProvider } from "@/components/workspace/account-session";
import { LogoCreationWorkspace } from "@/components/logo-creation/logo-creation-workspace";
import { logoInspirationHeading } from "@/domain/logo-saved-inputs";
import type { LogoReferenceSnapshot, LogoStageRevision } from "@/domain/logo-workspace";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";

/** Concepts already exist; Inspiration likes changed afterwards. Actual Logo step,
 * account client and memory; synthetic same-origin HTTP only, no provider. */
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto); let next = 0;
  const OriginalURL = URL; vi.stubGlobal("URL", class extends OriginalURL { static createObjectURL = vi.fn(() => `blob:likes-${++next}`); static revokeObjectURL = vi.fn(); });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function until(check: () => void) { let error: unknown; for (let i = 0; i < 100; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); try { check(); return; } catch (cause) { error = cause; } } throw error; }
const notice = () => [...host.querySelectorAll('[role="status"]')].find(node => node.textContent?.includes("You changed your likes after these concepts")) ?? null;

async function setup(newer: boolean) {
  const f = await syntheticRefinementWorkspaceHttp(), projectId = f.workspace.projectId, base = `/api/projects/${projectId}/logo`;
  const read = async <T,>(path: string) => (await (await f.fetcher(path)).json()) as T;
  const brief = await read<LogoStageRevision>(`${base}/stages/brief_references/revisions/${f.workspace.stages.brief_references!.id}`);
  const payload = brief.payload as { name: string; activity: string; audience: string; personality: string; logoTypes: string[]; referenceSnapshotId: string; sourceProjectRevision: number };
  const snapshot = await read<LogoReferenceSnapshot>(`${base}/reference-snapshots/${payload.referenceSnapshotId}`);
  const personality = newer ? `${payload.personality}\n${logoInspirationHeading("2026-10-13.1", 3)}\nVelto brand (colors): Colors: Vibrant lime and light violet.` : payload.personality;
  const saves: { personality: string }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input), "http://127.0.0.1").pathname;
    if (path === `${base}/saved-inputs`) return Response.json({ ownerId: f.workspace.ownerId, projectId, projectRevision: f.workspace.heads.projectRevision,
      inspirationSelectionRevision: newer ? 3 : 0, inspirationCount: newer ? 1 : 0, nameConflict: false,
      references: snapshot.references.map(({ referenceId, aspects }) => ({ referenceId, aspects })),
      draft: { name: payload.name, activity: payload.activity, audience: payload.audience, personality, logoTypes: payload.logoTypes } });
    if (path === `${base}/brief` && init?.method === "PUT") { saves.push(JSON.parse(String(init.body)).brief); return Response.json({}, { status: 503 }); }
    return f.fetcher(input, init);
  };
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(AccountSessionProvider, null, createElement(LogoCreationWorkspace, { projectId }))));
  await until(() => expect(host.querySelector('[aria-label="Logo concepts"] img[src^="blob:"]')).not.toBeNull());
  return { saves, personality };
}

it("says nothing when the saved likes match the brief the concepts used", async () => {
  const f = await setup(false);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
  expect(notice()).toBeNull(); expect(f.saves).toEqual([]);
});

it("offers newer likes for the next concepts, explains the chosen logo, and saves only on request", async () => {
  const f = await setup(true);
  await until(() => expect(notice()).not.toBeNull());
  expect(notice()!.textContent).toContain("Your chosen logo will then need to be chosen again from the new concepts before Creative direction.");
  expect(f.saves).toEqual([]);
  const use = [...notice()!.querySelectorAll("button")].find(button => button.textContent === "Use my new likes")!;
  await until(() => expect(use.disabled).toBe(false));
  await act(async () => use.click());
  await until(() => expect(f.saves).toHaveLength(1));
  expect(f.saves[0]!.personality).toBe(f.personality);
});
