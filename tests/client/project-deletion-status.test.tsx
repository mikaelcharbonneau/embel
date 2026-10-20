// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { LifecycleProject } from "@/components/workspace/project-deletion-client";
import { ProjectDeletionStatus } from "@/components/workspace/project-deletion-status";

const mock = vi.hoisted(() => ({
  session: null as VerifiedAccount | { status: "checking"; generation: number } | null,
  current: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire }),
}));

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const stopping: LifecycleProject = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  owner_id: owner,
  title: "Synthetic pending deletion",
  scope: "complete_brand",
  current_revision: 3,
  created_at: "2026-10-15T12:00:00Z",
  lifecycle_version: 1,
  deletion_requested_at: "2026-10-15T15:00:00Z",
  deleted_at: null,
  deletion_state: "stopping",
};
const completed: LifecycleProject = { ...stopping, deletion_state: "deleted" };
const awaiting: LifecycleProject = { ...stopping, deletion_state: "awaiting_resolution" };
const response = (project: LifecycleProject) => Response.json({ project });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};

let root: Root | null;
let host: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn>;
let updated: ReturnType<typeof vi.fn<(project: LifecycleProject) => void>>;
let visibility: DocumentVisibilityState;

async function render(project: LifecycleProject = stopping, compact = false) {
  await act(async () => {
    root!.render(mock.session?.status === "ready"
      ? <ProjectDeletionStatus account={mock.session} project={project} onUpdated={updated} compact={compact} />
      : <p>Checking account</p>);
  });
}
async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}
async function setVisibility(next: DocumentVisibilityState) {
  await act(async () => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
  });
}
function signalAt(index: number) {
  return (fetcher.mock.calls[index]![1] as RequestInit).signal!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  mock.session = { status: "ready", userId: owner, generation: 1 };
  mock.current.mockReset().mockImplementation((account: VerifiedAccount) =>
    mock.session?.status === "ready" && account.userId === mock.session.userId && account.generation === mock.session.generation);
  mock.expire.mockReset();
  updated = vi.fn<(project: LifecycleProject) => void>();
  fetcher = vi.fn(async () => response(stopping));
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("deleted project presentation and read-only work status", () => {
  it.each([stopping, awaiting, completed])("shows $deletion_state as Deleted before any status read", async project => {
    await render(project);
    expect(host.querySelector(".project-deletion-state")?.textContent).toBe("Deleted");
    expect(host.querySelector(".project-deletion-state--deleted")).not.toBeNull();
    expect(host.textContent).not.toMatch(/Stopping|Awaiting resolution|updates automatically|stopped automatically/);
    expect(host.textContent?.includes("Cancellation requested")).toBe(project.deletion_state === "stopping");
    expect(fetcher).not.toHaveBeenCalled();
    expect(updated).not.toHaveBeenCalled();
    expect(project.deleted_at).toBeNull();
  });

  it("checks every five seconds with the owner fence and observes same-version completion", async () => {
    fetcher.mockResolvedValueOnce(response(stopping)).mockResolvedValueOnce(response(completed));
    await render();
    expect(host.querySelector(".project-deletion-state")?.textContent).toBe("Deleted");
    expect(host.textContent).toContain("Cancellation requested");
    await advance(4_999);
    expect(fetcher).not.toHaveBeenCalled();
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/projects/${stopping.id}/deletion`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: "GET", credentials: "same-origin", mode: "same-origin", cache: "no-store",
      headers: { Accept: "application/json", "X-Embel-Account": owner },
    });
    expect(fetcher.mock.calls[0]![1]).not.toHaveProperty("body");
    expect(updated).toHaveBeenLastCalledWith(stopping);
    await advance(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(updated).toHaveBeenLastCalledWith(completed);
    expect(completed.lifecycle_version).toBe(stopping.lifecycle_version);
    await advance(120_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await render(completed);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Deleted");
    await advance(120_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps unresolved work internal while showing Deleted and checking every thirty seconds", async () => {
    fetcher.mockImplementation(async () => response(awaiting));
    await render(awaiting);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Deleted");
    expect(host.textContent).not.toMatch(/Awaiting resolution|Cancellation requested|cancelled|stopped|automatically/);
    await advance(29_999);
    expect(fetcher).not.toHaveBeenCalled();
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(29_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("changes cadence when the same lifecycle advances from stopping to awaiting resolution", async () => {
    fetcher.mockImplementation(async () => response(awaiting));
    await render();
    await advance(5_000);
    expect(updated).toHaveBeenLastCalledWith(awaiting);
    await render(awaiting);
    await advance(29_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["active", "deleted"] as const)("does not poll a %s project", async deletion_state => {
    await render({ ...stopping, deletion_state, deletion_requested_at: deletion_state === "active" ? null : stopping.deletion_requested_at });
    await advance(120_000);
    expect(fetcher).not.toHaveBeenCalled();
    expect(updated).not.toHaveBeenCalled();
    expect(host.textContent).toBe(deletion_state === "active" ? "" : "Deleted");
  });

  it.each([stopping, awaiting, completed])("keeps compact $deletion_state acknowledgment without a second live status region", async project => {
    await render(project, true);
    expect(host.querySelector(".project-deletion-state")?.textContent).toBe("Deleted");
    expect(host.textContent).toBe(project.deletion_state === "stopping" ? "DeletedCancellation requested" : "Deleted");
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector(".project-deletion-status--compact")).not.toBeNull();
  });

  it("waits while initially hidden, aborts on hiding, and rejects a superseded hidden-tab response", async () => {
    const stale = deferred<Response>();
    fetcher.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(response(completed));
    visibility = "hidden";
    await render();
    await advance(120_000);
    expect(fetcher).not.toHaveBeenCalled();
    await setVisibility("visible");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(signalAt(0).aborted).toBe(false);
    await setVisibility("hidden");
    expect(signalAt(0).aborted).toBe(true);
    await advance(120_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("Work status could not be checked");
    await setVisibility("visible");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(updated).toHaveBeenCalledExactlyOnceWith(completed);
    await act(async () => stale.resolve(response(awaiting)));
    expect(updated).toHaveBeenCalledExactlyOnceWith(completed);
    await advance(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds one in-flight read to fifteen seconds, backs off, and ignores its late result", async () => {
    const stalled = deferred<Response>();
    fetcher.mockReturnValueOnce(stalled.promise).mockResolvedValueOnce(response(stopping));
    await render();
    await advance(5_000);
    await advance(14_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(signalAt(0).aborted).toBe(false);
    expect(host.textContent).not.toContain("Work status could not be checked");
    await advance(1);
    expect(signalAt(0).aborted).toBe(true);
    expect(host.textContent).toContain("Work status could not be checked. The project is still deleted.");
    expect(host.querySelector(".project-deletion-state")?.textContent).toBe("Deleted");
    expect(updated).not.toHaveBeenCalled();
    await advance(29_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(updated).toHaveBeenCalledExactlyOnceWith(stopping);
    expect(host.textContent).not.toContain("Work status could not be checked");
    await act(async () => stalled.resolve(response(completed)));
    expect(updated).toHaveBeenCalledExactlyOnceWith(stopping);
    await advance(4_999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("caps repeated awaiting-status failures at a sixty-second backoff", async () => {
    fetcher.mockRejectedValue(new Error("Synthetic status outage"));
    await render(awaiting);
    await advance(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Work status could not be checked");
    expect(host.querySelector(".project-deletion-state")?.textContent).toBe("Deleted");
    await advance(59_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await advance(59_999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(updated).not.toHaveBeenCalled();
    expect(mock.expire).not.toHaveBeenCalled();
  });

  it("aborts on unmount and never publishes or schedules after a late response", async () => {
    const stalled = deferred<Response>();
    fetcher.mockReturnValueOnce(stalled.promise);
    await render();
    await advance(5_000);
    await act(async () => root!.unmount());
    root = null;
    expect(signalAt(0).aborted).toBe(true);
    await act(async () => stalled.resolve(response(completed)));
    await advance(120_000);
    expect(updated).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts during reverification and fences late responses from an earlier same-owner generation", async () => {
    const stale = deferred<Response>();
    fetcher.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(response(awaiting));
    await render();
    await advance(5_000);
    mock.session = { status: "checking", generation: 2 };
    await render();
    expect(signalAt(0).aborted).toBe(true);
    expect(host.textContent).toBe("Checking account");
    await advance(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    mock.session = { status: "ready", userId: owner, generation: 3 };
    await render();
    await advance(5_000);
    expect(updated).toHaveBeenCalledExactlyOnceWith(awaiting);
    await act(async () => stale.resolve(response(completed)));
    expect(updated).toHaveBeenCalledExactlyOnceWith(awaiting);
    expect(mock.expire).not.toHaveBeenCalled();
  });

  it("rejects a response as soon as the account generation is no longer current", async () => {
    const stale = deferred<Response>();
    fetcher.mockReturnValueOnce(stale.promise);
    await render();
    await advance(5_000);
    mock.session = { status: "ready", userId: owner, generation: 2 };
    await act(async () => stale.resolve(response(completed)));
    await advance(120_000);
    expect(updated).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mock.expire).not.toHaveBeenCalled();
  });

  it.each(["unauthorized", "wrong owner"])("expires the captured account and stops polling for %s reads", async mode => {
    fetcher.mockResolvedValueOnce(mode === "unauthorized"
      ? new Response(null, { status: 401 })
      : response({ ...completed, owner_id: otherOwner }));
    const captured = mock.session;
    await render();
    await advance(5_000);
    expect(mock.expire).toHaveBeenCalledExactlyOnceWith(captured);
    expect(updated).not.toHaveBeenCalled();
    await advance(120_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects an older lifecycle response instead of replacing a newer deletion request", async () => {
    const newer = { ...stopping, lifecycle_version: 3 };
    fetcher.mockResolvedValueOnce(response(completed));
    await render(newer);
    await advance(5_000);
    expect(updated).not.toHaveBeenCalled();
    expect(host.querySelector(".project-deletion-state")?.textContent).toBe("Deleted");
    expect(host.textContent).toContain("Cancellation requested");
    expect(host.textContent).toContain("Work status could not be checked");
    expect(mock.expire).not.toHaveBeenCalled();
    await advance(29_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts an older lifecycle read when a newer restore is rendered", async () => {
    const stale = deferred<Response>();
    fetcher.mockReturnValueOnce(stale.promise);
    await render();
    await advance(5_000);
    await render({ ...stopping, lifecycle_version: 2, deletion_state: "active", deletion_requested_at: null });
    expect(signalAt(0).aborted).toBe(true);
    expect(host.textContent).toBe("");
    await act(async () => stale.resolve(response(completed)));
    await advance(120_000);
    expect(updated).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a newer content revision that arrived during the status read", async () => {
    const stale = deferred<Response>();
    fetcher.mockReturnValueOnce(stale.promise);
    await render();
    await advance(5_000);
    await render({ ...stopping, current_revision: 4 });
    expect(signalAt(0).aborted).toBe(false);
    await act(async () => stale.resolve(response(completed)));
    expect(updated).not.toHaveBeenCalled();
    expect(host.querySelector(".project-deletion-state")?.textContent).toBe("Deleted");
    expect(host.textContent).toContain("Cancellation requested");
    expect(mock.expire).not.toHaveBeenCalled();
  });
});
