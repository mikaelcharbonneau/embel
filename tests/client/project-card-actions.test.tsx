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
const fixture: LifecycleProject = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", owner_id: owner, title: "Synthetic project", scope: "complete_brand", current_revision: 3, lifecycle_version: 4, deleted_at: null, deletion_requested_at: null, deletion_state: "active", created_at: "2026-10-10T12:00:00Z" };
const deleted: LifecycleProject = { ...fixture, deletion_requested_at: "2026-10-15T12:00:00Z", deletion_state: "deleted", lifecycle_version: 5 };
const stopping: LifecycleProject = { ...deleted, deletion_state: "stopping" };
const awaiting: LifecycleProject = { ...deleted, deletion_state: "awaiting_resolution" };
const confirmLabel = "Stop active work and delete project";
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
    expect(host.textContent).toContain("requests cancellation of active work");
    expect(host.textContent).toContain("Work already started may still finish or incur usage");
    expect(host.textContent).not.toContain("This stops any active work");
    expect(document.activeElement).toBe(button("Cancel")); await click("Cancel");
    expect(host.querySelector("dialog")).toBeNull(); expect(document.activeElement).toBe(button(`Project options for ${fixture.title}`));
    await openDelete(); await act(async () => host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(host.querySelector("dialog")).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends one fenced CAS request for repeated confirmation clicks and keeps pending state honest", async () => {
    const wait = deferred<Response>(); fetcher.mockReturnValue(wait.promise);
    await render(); await openDelete();
    const confirm = button(confirmLabel); await act(async () => { confirm.click(); confirm.click(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`/api/projects/${fixture.id}/deletion`, expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "X-Embel-Account": owner }), body: JSON.stringify({ expectedRevision: 3, expectedLifecycleVersion: 4, stopActiveWork: true }), credentials: "same-origin", mode: "same-origin", cache: "no-store" }));
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
  it("accepts never-started queued work in the single POST without manual stop controls", async () => {
    await render(); await openDelete(); await click(confirmLabel);
    expect(changed).toHaveBeenCalledExactlyOnceWith(deleted, "delete");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("Open project");
    expect(host.textContent).not.toContain("stop it");
  });
  it.each([stopping, awaiting])("acknowledges accepted $deletion_state intent immediately", async saved => {
    fetcher.mockResolvedValue(Response.json({ project: saved }, { status: 202 }));
    await render(); await openDelete(); await click(confirmLabel);
    expect(changed).toHaveBeenCalledExactlyOnceWith(saved, "delete"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([stopping, awaiting])("allows Restore during $deletion_state without restarting AI work", async pending => {
    const restored = { ...fixture, lifecycle_version: 6 }; fetcher.mockResolvedValue(Response.json({ project: restored }));
    await render(pending); await click("Restore");
    expect(host.textContent).toContain("Restoring won’t restart cancelled AI work");
    expect(host.textContent).not.toContain("pending deletion");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "DELETE", body: JSON.stringify({ expectedRevision: 3, expectedLifecycleVersion: 5 }) });
    expect(changed).toHaveBeenCalledExactlyOnceWith(restored, "restore"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["network interruption", "conflict", "busy response", "safe lock retry"])("automatically reconciles %s without replaying the mutation", async mode => {
    if (mode === "network interruption") fetcher.mockRejectedValueOnce(new Error("Synthetic disconnected response"));
    else fetcher.mockResolvedValueOnce(Response.json({ error: { code: mode === "busy response" ? "project_busy" : mode === "safe lock retry" ? "project_deletion_retry" : "conflict", message: "Private server detail" } }, { status: 409 }));
    fetcher.mockResolvedValueOnce(Response.json({ project: stopping }));
    await render(); await openDelete(); await click(confirmLabel);
    expect(fetcher.mock.calls.map(([, options]) => options.method)).toEqual(["POST", "GET"]);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ headers: expect.objectContaining({ "X-Embel-Account": owner }) });
    expect(changed).toHaveBeenCalledExactlyOnceWith(stopping, "delete"); expect(host.textContent).not.toContain("Private server detail"); expect(reload).not.toHaveBeenCalled();
  });
  it("only offers an explicit safe retry after a status read proves the original version unchanged", async () => {
    fetcher.mockRejectedValueOnce(new Error("Synthetic offline")).mockResolvedValueOnce(Response.json({ project: fixture })).mockResolvedValueOnce(Response.json({ project: deleted }));
    await render(); await openDelete(); await click(confirmLabel);
    expect(changed).not.toHaveBeenCalled(); expect(host.textContent).toContain("You can try again safely"); expect(fetcher).toHaveBeenCalledTimes(2);
    await click("Try again"); expect(changed).toHaveBeenCalledExactlyOnceWith(deleted, "delete");
    expect(fetcher.mock.calls.map(([, options]) => options.method)).toEqual(["POST", "GET", "POST"]);
  });
  it("requires refresh when reconciliation finds a newer lifecycle, without guessing this request succeeded", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: "conflict" } }, { status: 409 })).mockResolvedValueOnce(Response.json({ project: { ...deleted, lifecycle_version: 7 } }));
    await render(); await openDelete(); await click(confirmLabel);
    expect(host.textContent).toContain("changed while its status was checked"); expect(button(confirmLabel)).toBeUndefined(); expect(changed).not.toHaveBeenCalled();
    await click("Close"); await openDelete(); expect(button(confirmLabel)).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(2);
    reload.mockResolvedValue(false); await click("Refresh projects"); expect(host.textContent).toContain("Projects could not be refreshed"); expect(host.querySelector("dialog")?.open).toBe(true);
  });
  it("bounds an ignored-abort POST, reconciles accepted intent and ignores its late response", async () => {
    const wait = deferred<Response>(); fetcher.mockReturnValueOnce(wait.promise).mockResolvedValueOnce(Response.json({ project: stopping }));
    await render(); await openDelete(); await click(confirmLabel);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true); expect(changed).toHaveBeenCalledExactlyOnceWith(stopping, "delete");
    await act(async () => wait.resolve(Response.json({ project: deleted })));
    expect(changed).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls.map(([, options]) => options.method)).toEqual(["POST", "GET"]);
  });
  it("bounds reconciliation and offers read-only Check status after two uncertain waits", async () => {
    const post = deferred<Response>(), get = deferred<Response>(); fetcher.mockReturnValueOnce(post.promise).mockReturnValueOnce(get.promise).mockResolvedValueOnce(Response.json({ project: stopping }));
    await render(); await openDelete(); await click(confirmLabel);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(host.textContent).toContain("Checking project status"); expect(button("Checking status…").disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(host.textContent).toContain("could not be confirmed"); expect(button("Check status").disabled).toBe(false);
    await act(async () => { post.resolve(Response.json({ project: deleted })); get.resolve(Response.json({ project: deleted })); }); expect(changed).not.toHaveBeenCalled();
    await click("Check status"); expect(changed).toHaveBeenCalledExactlyOnceWith(stopping, "delete");
    expect(fetcher.mock.calls.map(([, options]) => options.method)).toEqual(["POST", "GET", "GET"]);
  });
  it.each(["wrong project", "wrong revision", "wrong lifecycle", "wrong state", "missing lifecycle", "missing deletion state"])("reconciles an unverifiable success without trusting it: %s", async mode => {
    const result = { ...deleted } as Record<string, unknown>;
    if (mode === "wrong project") result.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    if (mode === "wrong revision") result.current_revision = 2;
    if (mode === "wrong lifecycle") result.lifecycle_version = 4;
    if (mode === "wrong state") result.deletion_state = "active";
    if (mode === "missing lifecycle") delete result.lifecycle_version;
    if (mode === "missing deletion state") delete result.deletion_state;
    fetcher.mockResolvedValueOnce(Response.json({ project: result })).mockRejectedValueOnce(new Error("Synthetic status unavailable"));
    await render(); await openDelete(); await click(confirmLabel);
    expect(changed).not.toHaveBeenCalled(); expect(host.textContent).toContain("could not be confirmed"); expect(button("Check status")).toBeDefined(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("reconciles an interrupted Restore through a read, without sending another DELETE", async () => {
    const restored = { ...fixture, lifecycle_version: 6 };
    fetcher.mockRejectedValueOnce(new Error("Synthetic interruption")).mockResolvedValueOnce(Response.json({ project: restored }));
    await render(stopping); await click("Restore");
    expect(changed).toHaveBeenCalledExactlyOnceWith(restored, "restore"); expect(fetcher.mock.calls.map(([, options]) => options.method)).toEqual(["DELETE", "GET"]);
  });
  it.each(["expired session", "wrong owner"])("expires the account for %s without publishing the response", async mode => {
    fetcher.mockResolvedValue(mode === "expired session" ? new Response(null, { status: 401 }) : Response.json({ project: { ...deleted, owner_id: otherOwner } }));
    await render(); await openDelete(); await click(confirmLabel);
    expect(mock.expire).toHaveBeenCalledExactlyOnceWith(mock.session); expect(changed).not.toHaveBeenCalled();
  });
  it("aborts and hides the dialog during session reverification, ignoring a late old-owner response", async () => {
    const wait = deferred<Response>(); fetcher.mockReturnValue(wait.promise);
    await render(); await openDelete(); await click(confirmLabel);
    mock.session = { status: "checking", generation: 2 }; await render();
    expect(host.textContent).not.toContain(fixture.title); expect(host.querySelector("dialog")).toBeNull(); expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
    mock.session = { status: "ready", userId: otherOwner, generation: 3 }; await render({ ...fixture, owner_id: otherOwner, title: "Other synthetic project" });
    await act(async () => wait.resolve(Response.json({ project: deleted })));
    expect(changed).not.toHaveBeenCalled(); expect(host.textContent).not.toContain(fixture.title);
  });
  it("aborts automatic reconciliation on an account change and never publishes its late result", async () => {
    const wait = deferred<Response>(); fetcher.mockRejectedValueOnce(new Error("Synthetic lost response")).mockReturnValueOnce(wait.promise);
    await render(); await openDelete(); await click(confirmLabel);
    expect(host.textContent).toContain("Checking project status"); expect(fetcher).toHaveBeenCalledTimes(2);
    mock.session = { status: "checking", generation: 2 }; await render();
    expect(fetcher.mock.calls[1]![1].signal.aborted).toBe(true); expect(host.querySelector("dialog")).toBeNull();
    mock.session = { status: "ready", userId: otherOwner, generation: 3 }; await render({ ...fixture, owner_id: otherOwner, title: "Other synthetic project" });
    await act(async () => wait.resolve(Response.json({ project: stopping })));
    expect(changed).not.toHaveBeenCalled(); expect(mock.expire).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("fails closed before fetch for another owner's project or an inconsistent action", async () => {
    await expect(changeProjectDeletion({ ...fixture, owner_id: otherOwner }, "delete", mock.session as VerifiedAccount, new AbortController().signal)).rejects.toMatchObject({ status: 409 });
    await expect(changeProjectDeletion(fixture, "restore", mock.session as VerifiedAccount, new AbortController().signal)).rejects.toMatchObject({ status: 409 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
