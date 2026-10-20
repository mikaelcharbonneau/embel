// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdeasWorkspace } from "@/components/ideas/ideas-workspace";
import { createIdeaDraftMemory } from "@/components/ideas/ideas-draft-memory";
import type { useAccountSession, VerifiedAccount } from "@/components/workspace/account-session";

type Session = ReturnType<typeof useAccountSession>["session"];
const fixture = vi.hoisted(() => ({ session: null as unknown as Session, ideaDrafts: null as unknown as ReturnType<typeof createIdeaDraftMemory>, isCurrent: vi.fn(), expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => fixture, AccountStatus: () => <p>Account hidden</p> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const stamp = "2026-10-20T00:00:00.000000Z";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let host: HTMLDivElement, root: Root;
let reads: { url: URL; signal: AbortSignal; resolve: (response: Response) => void }[];
const page = (number: number, title: string, more = false, ownerId = owner) => ({ ownerId, items: [{
  id: id(number), ownerId, revision: 1, title, description: "Saved idea", theme: "", state: "developing", createdAt: stamp, updatedAt: stamp,
}], nextCursor: more ? { id: id(number), createdAt: stamp } : null });
async function render() { await act(async () => root.render(<IdeasWorkspace />)); }
async function resolveRead(index: number, value: unknown) { await act(async () => reads[index]!.resolve(Response.json(value))); }
async function filter(state: string) {
  await act(async () => { const select = host.querySelector<HTMLSelectElement>(".ideas-filter-state select")!; select.value = state; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function click(label: string) {
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click());
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); reads = [];
  fixture.session = { status: "ready", userId: owner, generation: 1 }; fixture.ideaDrafts = createIdeaDraftMemory();
  fixture.isCurrent.mockReset().mockImplementation((account: VerifiedAccount) => fixture.session.status === "ready" && fixture.session.userId === account.userId && fixture.session.generation === account.generation);
  fixture.expire.mockReset().mockImplementation(() => { fixture.session = { status: "signed_out", generation: fixture.session.generation + 1 }; });
  vi.stubGlobal("fetch", vi.fn((path: string, init: RequestInit) => new Promise<Response>(resolve => {
    const url = new URL(path, "https://fixture.invalid"); expect(url.pathname).toBe("/api/ideas"); reads.push({ url, signal: init.signal!, resolve });
  })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("Ideas query refresh continuity", () => {
  it("retains the verified grid and status slot while new filters load without an old cursor", async () => {
    await resolveRead(0, page(100, "First idea", true));
    const grid = host.querySelector(".ideas-grid"), card = host.querySelector(".idea-card"), status = host.querySelector(".ideas-load-status");
    await filter("developing");
    expect(host.querySelector(".ideas-grid")).toBe(grid); expect(host.querySelector(".idea-card")).toBe(card);
    expect(host.querySelector(".ideas-load-status")).toBe(status); expect(status?.textContent).toContain("Previous results remain visible");
    expect(host.querySelector(".ideas-results")?.getAttribute("aria-busy")).toBe("true");
    expect(reads[1]!.url.searchParams.has("cursorId")).toBe(false);
    expect(host.querySelector(".ideas-load-more")).toBeNull();
    await resolveRead(1, page(200, "Filtered idea"));
    expect(host.querySelector(".ideas-grid")).toBe(grid); expect(host.querySelector(".ideas-load-status")).toBe(status);
    expect(host.textContent).toContain("Filtered idea"); expect(host.textContent).not.toContain("First idea");
    expect(host.querySelector(".ideas-results")?.getAttribute("aria-busy")).toBe("false");
  });

  it("fences late pagination and A-to-B-to-A query completions and restarts at the first page", async () => {
    await resolveRead(0, page(100, "Original A", true)); await click("Load more ideas");
    expect(reads[1]!.url.searchParams.get("cursorId")).toBe(id(100));
    await filter("developing"); await filter("all");
    expect(reads).toHaveLength(4); expect(reads[1]!.signal.aborted).toBe(true); expect(reads[2]!.signal.aborted).toBe(true);
    expect(reads[3]!.url.searchParams.has("cursorId")).toBe(false);
    await resolveRead(1, page(50, "Late pagination")); await resolveRead(2, page(200, "Late B"));
    expect(host.textContent).toContain("Original A"); expect(host.textContent).not.toContain("Late pagination"); expect(host.textContent).not.toContain("Late B");
    await resolveRead(3, page(300, "Newest A"));
    expect(host.textContent).toContain("Newest A"); expect(host.textContent).not.toContain("Original A");
  });

  it("keeps prior results on filter failure but does not reuse their pagination on retry", async () => {
    await resolveRead(0, page(100, "Prior results", true)); await filter("used");
    await act(async () => reads[1]!.resolve(new Response(null, { status: 503 })));
    expect(host.textContent).toContain("Prior results"); expect(host.textContent).toContain("Previous results are still shown");
    expect(host.querySelector(".ideas-load-more")).toBeNull(); expect(host.querySelector(".ideas-results")?.getAttribute("aria-busy")).toBe("false");
    await click("Try loading ideas again"); expect(reads[2]!.url.searchParams.has("cursorId")).toBe(false);
    await resolveRead(2, { ownerId: owner, items: [], nextCursor: null });
    expect(host.textContent).not.toContain("Prior results"); expect(host.textContent).toContain("No saved ideas match these filters");
  });

  it("never retains a private grid through verification, generation or owner changes", async () => {
    await resolveRead(0, page(100, "Private old owner")); await filter("used");
    fixture.session = { status: "checking", generation: 2 }; await render();
    expect(host.textContent).not.toContain("Private old owner"); expect(reads[1]!.signal.aborted).toBe(true);
    fixture.session = { status: "ready", userId: other, generation: 2 }; await render();
    await resolveRead(1, page(200, "Late old owner")); expect(host.textContent).not.toContain("Late old owner");
    await resolveRead(2, page(300, "New owner", false, other)); expect(host.textContent).toContain("New owner");
    fixture.session = { status: "ready", userId: other, generation: 3 }; await render();
    expect(host.textContent).not.toContain("New owner"); expect(reads).toHaveLength(4);
  });

  it("expires on mismatched response ownership instead of publishing another owner's rows", async () => {
    await resolveRead(0, page(100, "Owned idea")); await filter("used");
    await resolveRead(1, page(200, "Foreign idea", false, other));
    expect(fixture.expire).toHaveBeenCalledOnce(); expect(host.textContent).not.toContain("Foreign idea");
    await render(); expect(host.textContent).not.toContain("Owned idea");
  });
});
