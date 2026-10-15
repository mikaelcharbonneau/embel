// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCardActions } from "@/components/workspace/project-card-actions";
import { changeProjectDeletion, type LifecycleProject } from "@/components/workspace/project-deletion-client";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({ session: null as VerifiedAccount | { status: "checking"; generation: number } | null, current: vi.fn(), expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire }) }));
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", otherOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fixture: LifecycleProject = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", owner_id: owner, title: "Synthetic project", scope: "complete_brand", current_revision: 3, lifecycle_version: 4, deleted_at: null, created_at: "2026-10-10T12:00:00Z" };
const deleted = { ...fixture, deleted_at: "2026-10-15T12:00:00Z", lifecycle_version: 5 };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let host: HTMLDivElement, root: Root, fetcher: ReturnType<typeof vi.fn>, changed: ReturnType<typeof vi.fn<(project: LifecycleProject, action: "delete" | "restore") => void>>, reload: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label)!;
async function click(label: string) { await act(async () => button(label).click()); }
async function render(project = fixture) {
  await act(async () => root.render(mock.session?.status === "ready" ? <article key={`${mock.session.userId}:${mock.session.generation}`}><a href={`/brands/account/${project.id}`}>Project link</a><ProjectCardActions project={project} account={mock.session} onChanged={changed} onReload={reload} /></article> : <p>Checking account</p>));
}
async function openDelete() { await click(`Project options for ${fixture.title}`); await click("Delete"); }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.session = { status: "ready", userId: owner, generation: 1 };
  mock.current.mockReset().mockImplementation((account: VerifiedAccount) => mock.session?.status === "ready" && account.userId === mock.session.userId && account.generation === mock.session.generation);
  mock.expire.mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  fetcher = vi.fn(async () => Response.json({ project: deleted })); vi.stubGlobal("fetch", fetcher);
  changed = vi.fn<(project: LifecycleProject, action: "delete" | "restore") => void>(); reload = vi.fn<() => Promise<boolean>>(async () => true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("project card contextual actions", () => {
  it("opens by keyboard, focuses Delete, closes with Escape, Tab and outside click without nested controls", async () => {
    await render(); const trigger = button(`Project options for ${fixture.title}`);
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(button("Delete")); expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => button("Delete").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    await act(async () => button("Delete").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(host.querySelector('[role="menu"]')).toBeNull();
    await act(async () => trigger.click()); await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(host.querySelector('[role="menu"]')).toBeNull(); expect(host.querySelector("a button, a a")).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("explains recovery and retains focus on cancellation without sending a request", async () => {
    await render(); await openDelete();
    expect(host.querySelector("dialog")?.open).toBe(true); expect(host.textContent).toContain("Its assets and history are kept");
    expect(document.activeElement).toBe(button("Cancel")); await click("Cancel");
    expect(host.querySelector("dialog")).toBeNull(); expect(document.activeElement).toBe(button(`Project options for ${fixture.title}`));
    await openDelete(); await act(async () => host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(host.querySelector("dialog")).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends one fenced CAS request for repeated confirmation clicks and keeps pending state honest", async () => {
    const wait = deferred<Response>(); fetcher.mockReturnValue(wait.promise);
    await render(); await openDelete();
    const confirm = button("Delete project"); await act(async () => { confirm.click(); confirm.click(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`/api/projects/${fixture.id}/deletion`, expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "X-Embel-Account": owner }), body: JSON.stringify({ expectedRevision: 3, expectedLifecycleVersion: 4 }), credentials: "same-origin", mode: "same-origin", cache: "no-store" }));
    expect(button("Cancel").disabled).toBe(true); expect(button("Moving project…").disabled).toBe(true);
    await act(async () => host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(host.querySelector("dialog")?.open).toBe(true);
    await act(async () => wait.resolve(Response.json({ project: deleted })));
    expect(changed).toHaveBeenCalledExactlyOnceWith(deleted, "delete");
  });
  it("restores directly through DELETE using the deleted lifecycle version", async () => {
    const restored = { ...fixture, lifecycle_version: 6 }; fetcher.mockResolvedValue(Response.json({ project: restored }));
    await render(deleted); await click("Restore");
    expect(fetcher).toHaveBeenCalledWith(`/api/projects/${fixture.id}/deletion`, expect.objectContaining({ method: "DELETE", body: JSON.stringify({ expectedRevision: 3, expectedLifecycleVersion: 5 }) }));
    expect(changed).toHaveBeenCalledExactlyOnceWith(restored, "restore");
  });
  it("explains active work and links to its existing project without cancelling jobs", async () => {
    fetcher.mockResolvedValue(Response.json({ error: { code: "project_busy", message: "Private server detail" } }, { status: 409 }));
    await render(); await openDelete(); await click("Delete project");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("active work or work awaiting resolution");
    expect(host.querySelector('a.text-link')?.getAttribute("href")).toBe(`/brands/account/${fixture.id}`);
    expect(host.textContent).not.toContain("Private server detail"); expect(fetcher).toHaveBeenCalledTimes(1); expect(changed).not.toHaveBeenCalled();
    await click("Refresh projects"); expect(reload).toHaveBeenCalledOnce(); expect(host.querySelector("dialog")).toBeNull();
  });
  it("requires a read after a stale lifecycle rather than retrying the mutation", async () => {
    fetcher.mockResolvedValue(Response.json({ error: { code: "conflict" } }, { status: 409 }));
    await render(); await openDelete(); await click("Delete project");
    expect(host.textContent).toContain("changed since it was loaded"); expect(button("Delete project")).toBeUndefined();
    await click("Close"); await openDelete(); expect(button("Delete project")).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds a fetch that ignores abort and ignores its late success after an uncertain timeout", async () => {
    const wait = deferred<Response>(); fetcher.mockReturnValue(wait.promise);
    await render(); await openDelete(); await click("Delete project");
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true); expect(host.textContent).toContain("could not be confirmed");
    expect(button("Refresh projects").disabled).toBe(false); expect(button("Delete project")).toBeUndefined();
    await act(async () => wait.resolve(Response.json({ project: deleted })));
    expect(changed).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
    reload.mockResolvedValue(false); await click("Refresh projects"); expect(host.textContent).toContain("Projects could not be refreshed"); expect(host.querySelector("dialog")?.open).toBe(true);
  });
  it.each(["wrong project", "wrong revision", "wrong lifecycle", "wrong state", "missing lifecycle"])("rejects an unverifiable success: %s", async mode => {
    const result = { ...deleted } as Record<string, unknown>;
    if (mode === "wrong project") result.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    if (mode === "wrong revision") result.current_revision = 2;
    if (mode === "wrong lifecycle") result.lifecycle_version = 4;
    if (mode === "wrong state") result.deleted_at = null;
    if (mode === "missing lifecycle") delete result.lifecycle_version;
    fetcher.mockResolvedValue(Response.json({ project: result }));
    await render(); await openDelete(); await click("Delete project");
    expect(changed).not.toHaveBeenCalled(); expect(host.textContent).toContain("could not be confirmed");
  });
  it.each(["expired session", "wrong owner"])("expires the account for %s without publishing the response", async mode => {
    fetcher.mockResolvedValue(mode === "expired session" ? new Response(null, { status: 401 }) : Response.json({ project: { ...deleted, owner_id: otherOwner } }));
    await render(); await openDelete(); await click("Delete project");
    expect(mock.expire).toHaveBeenCalledExactlyOnceWith(mock.session); expect(changed).not.toHaveBeenCalled();
  });
  it("aborts and hides the dialog during session reverification, ignoring a late old-owner response", async () => {
    const wait = deferred<Response>(); fetcher.mockReturnValue(wait.promise);
    await render(); await openDelete(); await click("Delete project");
    mock.session = { status: "checking", generation: 2 }; await render();
    expect(host.textContent).not.toContain(fixture.title); expect(host.querySelector("dialog")).toBeNull(); expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
    mock.session = { status: "ready", userId: otherOwner, generation: 3 }; await render({ ...fixture, owner_id: otherOwner, title: "Other synthetic project" });
    await act(async () => wait.resolve(Response.json({ project: deleted })));
    expect(changed).not.toHaveBeenCalled(); expect(host.textContent).not.toContain(fixture.title);
  });
  it("fails closed before fetch for another owner's project or an inconsistent action", async () => {
    await expect(changeProjectDeletion({ ...fixture, owner_id: otherOwner }, "delete", mock.session as VerifiedAccount, new AbortController().signal)).rejects.toMatchObject({ status: 409 });
    await expect(changeProjectDeletion(fixture, "restore", mock.session as VerifiedAccount, new AbortController().signal)).rejects.toMatchObject({ status: 409 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
