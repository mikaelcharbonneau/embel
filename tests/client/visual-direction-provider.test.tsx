// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { useVisualDirection } from "@/features/identity-directions/components/use-visual-direction";
import { reviewVisualDirectionSchema, visualDirectionReferences, type ReviewVisualDirection, type VisualDirectionOverview } from "@/domain/visual-direction";
import { visualOverview, visualOwner, visualProject } from "../fixtures/visual-direction";
let root: Root, host: HTMLDivElement, controller: ReturnType<typeof useVisualDirection>, session: ReturnType<typeof useAccountSession>;
let owner: string, saved: VisualDirectionOverview, fetcher: ReturnType<typeof vi.fn>, logout: number, show: boolean;
let write: ((input: ReviewVisualDirection) => Promise<Response>) | null;
function Probe({ account }: { account: VerifiedAccount }) { const value = useVisualDirection(account, visualProject); useLayoutEffect(() => { controller = value; }); return <p>{value.guidance.character}</p>; }
function Harness() { const value = useAccountSession(); useLayoutEffect(() => { session = value; }); return show && value.session.status === "ready" ? <Probe key={`${value.session.userId}:${value.session.generation}`} account={value.session} /> : null; }
const render = () => act(async () => root.render(<AccountSessionProvider><Harness /></AccountSessionProvider>));
async function until(check: () => void) { let error: unknown; for (let i = 0; i < 100; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); try { check(); return; } catch (cause) { error = cause; } } throw error; }
function persist(input: ReviewVisualDirection) {
  const old = saved.current, revision = (old?.revision ?? 0) + 1;
  saved = { ...saved, stale: false, current: { id: `dddddddd-dddd-4ddd-8ddd-${String(revision).padStart(12, "0")}`, ownerId: owner, projectId: visualProject, revision,
    projectRevision: input.expectedProjectRevision, selectionRevision: input.expectedSelectionRevision, catalogVersion: input.catalogVersion,
    guidance: input.guidance, references: visualDirectionReferences(saved.inspiration), reviewedAt: "2026-10-13T13:00:00Z" }, history: old ? [old, ...saved.history] : [] };
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); owner = visualOwner; saved = visualOverview({ reviewed: true }); logout = 200; write = null; show = true;
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path === "/api/session") return Response.json({ user: { id: owner } });
    if (path === "/api/auth/sign-out") return logout === 200 ? Response.json({ authenticated: false }) : new Response(null, { status: logout });
    expect(path).toBe(`/api/projects/${visualProject}/visual-direction`);
    if (init.method === "POST") {
      const input = reviewVisualDirectionSchema.parse(JSON.parse(String(init.body)));
      if (write) return write(input);
      if (input.expectedRevision !== (saved.current?.revision ?? 0) || input.expectedSelectionRevision !== saved.inspiration.selectionRevision) return new Response(null, { status: 409 });
      persist(input);
    }
    return Response.json(saved);
  });
  vi.stubGlobal("fetch", fetcher); host = document.createElement("div"); document.body.append(host); root = createRoot(host); await render();
  await until(() => expect(controller.overview?.current?.guidance.character).toBe("Clear and warm"));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const edit = (character: string) => act(async () => controller.edit({ ...controller.guidance, character }));
it("keeps passive reads clean, restores unsaved words across navigation, and saves only after explicit review", async () => {
  expect(session.visualDirectionDrafts.hasUnsaved()).toBe(false); await edit("Precise and welcoming");
  show = false; await render(); expect(session.visualDirectionDrafts.hasUnsaved()).toBe(true);
  show = true; await render(); await until(() => expect(controller.loading).toBe(false)); expect(controller.guidance.character).toBe("Precise and welcoming");
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(0);
  await act(async () => { await Promise.all([controller.save(), controller.save()]); });
  expect(saved.current?.guidance.character).toBe("Precise and welcoming"); expect(saved.history[0]?.guidance.character).toBe("Clear and warm");
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1); expect(session.visualDirectionDrafts.hasUnsaved()).toBe(false);
  await act(async () => root.unmount()); root = createRoot(host); await render(); await until(() => expect(controller.guidance.character).toBe("Precise and welcoming"));
});
it("checks a lost successful save without sending the mutation again", async () => {
  await edit("Private written guidance"); write = async input => { persist(input); throw new Error("Synthetic lost acknowledgement"); };
  await act(async () => { await controller.save(); }); expect(controller.draft?.mustReload).toBe(true); expect(controller.canSave).toBe(false);
  await act(async () => { await controller.refresh(); }); expect(controller.draft).toBeNull(); expect(controller.message).toContain("confirmed");
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
});
it("keeps conflicting words and requires explicit review against updated inspiration", async () => {
  await edit("My unsaved direction"); saved = { ...saved, stale: true, inspiration: { ...saved.inspiration, selectionRevision: 1 } };
  await act(async () => { await controller.save(); }); expect(controller.draft?.mustReload).toBe(true);
  await act(async () => { await controller.refresh(); }); expect(controller.draft?.latest?.stale).toBe(true); expect(controller.canSave).toBe(false);
  await act(async () => controller.keepMine()); expect(controller.guidance.character).toBe("My unsaved direction"); expect(controller.canSave).toBe(true);
  await act(async () => { await controller.save(); }); expect(saved.current?.selectionRevision).toBe(1); expect(saved.current?.revision).toBe(2);
});
it("protects sign-out and unload, retaining guidance after a failed sign-out", async () => {
  await edit("Retain this draft"); expect(await session.signOut()).toEqual({ ok: false, reason: "confirmation_required" });
  const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  logout = 503; await act(async () => { expect(await session.signOut(true)).toEqual({ ok: false, reason: "failed" }); });
  await until(() => expect(controller.guidance.character).toBe("Retain this draft")); expect(session.visualDirectionDrafts.hasUnsaved()).toBe(true);
  logout = 200; await act(async () => { expect(await session.signOut(true)).toEqual({ ok: true }); }); expect(session.visualDirectionDrafts.hasUnsaved()).toBe(false);
});
it("rejects late old-owner save completion and never renders that owner's guidance after replacement", async () => {
  let resolve!: (response: Response) => void;
  write = () => new Promise<Response>(yes => { resolve = yes; });
  await edit("Owner A secret direction"); let operation!: Promise<unknown>;
  await act(async () => { operation = controller.save(); }); const old = structuredClone(saved);
  owner = visualProject; saved = visualOverview({ ownerId: owner, reviewed: true }); saved.current!.guidance.character = "Owner B direction";
  await act(async () => { await session.refresh(); }); await until(() => expect(host.textContent).toBe("Owner B direction"));
  await act(async () => { resolve(Response.json(old)); await operation; });
  expect(host.textContent).toBe("Owner B direction"); expect(session.visualDirectionDrafts.hasUnsaved()).toBe(false);
});
