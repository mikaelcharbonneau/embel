// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCard } from "@/components/workspace/project-card";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { LifecycleProject } from "@/components/workspace/project-deletion-client";
import { syntheticLogoBatch, logoFixtureId as id } from "../fixtures/logo-creation";

const mock = vi.hoisted(() => ({
  session: null as VerifiedAccount | { status: "checking"; generation: number } | null,
  isCurrent: vi.fn(), expire: vi.fn(), createClient: vi.fn(), read: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, isCurrent: mock.isCurrent, expire: mock.expire }) }));
vi.mock("@/components/identity/account-logo-client", () => ({ createAccountLogoClient: (...args: unknown[]) => mock.createClient(...args) }));
vi.mock("@/components/workspace/project-card-preview", () => ({ readProjectCardPreview: (...args: unknown[]) => mock.read(...args) }));

const account: VerifiedAccount = { status: "ready", userId: id(1), generation: 1 };
const project = (): LifecycleProject => ({ id: id(2), owner_id: id(1), title: "Untitled brand", scope: "complete_brand", current_revision: 1, lifecycle_version: 0,
  created_at: "2026-10-20T00:00:00Z", deleted_at: null, deletion_requested_at: null, deletion_state: "active" });
const receipt = syntheticLogoBatch().slots[0]!.acceptedPreview!;
type Preview = { url: string; release: ReturnType<typeof vi.fn> };
function client() {
  const requests: { resolve(value: Preview | null): void; signal: AbortSignal }[] = [];
  return { dispose: vi.fn(), previewAsset: vi.fn((_receipt: unknown, signal: AbortSignal) => new Promise<Preview | null>(resolve => { requests.push({ resolve, signal }); })), requests };
}
let host: HTMLDivElement, root: Root, source: ReturnType<typeof client>;
async function render(value = project(), props: Partial<Parameters<typeof ProjectCard>[0]> = {}) {
  await act(async () => root.render(<ProjectCard project={value} account={account} date="Created Oct 20, 2026" actions={<button type="button">Project options</button>} {...props} />));
}
async function settle(index = 0, url = "blob:saved-logo") {
  const value = { url, release: vi.fn() };
  await act(async () => source.requests[index]!.resolve(value));
  return value;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", class {
    private disconnected = false;
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => { if (!this.disconnected) this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }); }
    disconnect() { this.disconnected = true; }
  });
  mock.session = account;
  mock.isCurrent.mockReset().mockImplementation((value: VerifiedAccount) => mock.session?.status === "ready" && mock.session.userId === value.userId && mock.session.generation === value.generation);
  mock.expire.mockReset(); source = client(); mock.createClient.mockReset().mockReturnValue(source);
  mock.read.mockReset().mockResolvedValue({ name: "Persimmon", receipt });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("shared Home and Projects card", () => {
  it("shows saved selected artwork while retaining the project label and separate full name", async () => {
    await render(); await settle();
    expect(host.querySelector("h2")?.textContent).toBe("Untitled brand");
    expect(host.textContent).toContain("Logo brief: Persimmon");
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("Saved selected logo for Persimmon");
    expect(host.querySelector("a")?.getAttribute("href")).toBe(`/brands/account/${id(2)}`);
    expect(host.querySelector("a button")).toBeNull();
    expect(host.querySelector("button")?.textContent).toBe("Project options");
    await render(project(), { headingLevel: 3 });
    expect(host.querySelector("h3")?.textContent).toBe("Untitled brand");
  });

  it("keeps an equivalent snapshot's mounted image and avoids repeat private reads", async () => {
    await render(); const file = await settle(), image = host.querySelector("img");
    await render(structuredClone(project())); await render(structuredClone(project()));
    expect(host.querySelector("img")).toBe(image);
    expect(mock.read).toHaveBeenCalledTimes(1); expect(file.release).not.toHaveBeenCalled();
  });

  it("gives long project labels their own row and exposes the full unchanged title", async () => {
    const title = "A very long project label with a product description that must remain available in full";
    await render({ ...project(), title }); await settle();
    expect(host.querySelector("h2")?.getAttribute("title")).toBe(title);
    expect(host.querySelector("h2")?.textContent).toBe(title);
    expect(host.querySelector("a")?.getAttribute("aria-label")).toBe(`Continue ${title}`);
    expect(host.querySelector("h2")?.parentElement?.querySelector("span")?.textContent).toBe("Complete brand");
  });

  it("uses honest empty and unavailable states without inventing a logo", async () => {
    mock.read.mockResolvedValue({ name: null, receipt: null }); await render();
    expect(host.querySelector("img")).toBeNull(); expect(host.textContent).toContain("No logo selected");
    expect(source.previewAsset).not.toHaveBeenCalled();
    mock.read.mockRejectedValue(new Error("Preview not readable")); await render({ ...project(), current_revision: 2 });
    expect(host.textContent).toContain("Preview unavailable"); expect(host.textContent).toContain("Untitled brand");
    expect(host.querySelector("a")).not.toBeNull();
  });

  it("does not fetch deleted or naming-only artwork and keeps lifecycle controls separate", async () => {
    await render({ ...project(), deletion_state: "deleted", deleted_at: "2026-10-20T01:00:00Z" }, { deletionStatus: <p>Deleted project retained</p> });
    expect(mock.createClient).not.toHaveBeenCalled(); expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain("Deleted project retained"); expect(host.querySelector("button")).not.toBeNull();
    await render({ ...project(), scope: "naming_only" });
    expect(mock.createClient).not.toHaveBeenCalled(); expect(host.textContent).toContain("Naming project");
  });

  it("masks private content immediately on re-verification and never resurrects its released URL", async () => {
    await render(); const previous = await settle();
    mock.session = { status: "checking", generation: 2 }; await render();
    expect(host.textContent).toBe(""); expect(host.querySelector("img")).toBeNull();
    expect(previous.release).toHaveBeenCalledTimes(1); expect(source.dispose).toHaveBeenCalledTimes(1);
    mock.session = account; await render();
    expect(host.querySelector("img")).toBeNull();
    await settle(1, "blob:new-verification");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:new-verification");
  });

  it("releases late bytes after a project revision changes and ignores them", async () => {
    await render(); await render({ ...project(), current_revision: 2 });
    const late = await settle(0, "blob:late");
    expect(late.release).toHaveBeenCalledTimes(1); expect(host.querySelector("img")).toBeNull();
    await settle(1, "blob:current"); expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:current");
  });

  it("does not read or display another owner's project", async () => {
    await render({ ...project(), owner_id: id(999) });
    expect(host.textContent).toBe(""); expect(mock.createClient).not.toHaveBeenCalled();
  });

  it("keeps failed image decoding in the fallback without retrying or dropping the saved project", async () => {
    await render(); await settle();
    await act(async () => host.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(host.querySelector("img")).toBeNull(); expect(host.textContent).toContain("Preview unavailable");
    expect(host.querySelector("h2")?.textContent).toBe("Untitled brand");
    expect(mock.read).toHaveBeenCalledTimes(1);
  });

  it("bounds visible-card metadata and byte reads to three simultaneous pipelines", async () => {
    const clients: ReturnType<typeof client>[] = [];
    mock.createClient.mockImplementation(() => { const value = client(); clients.push(value); return value; });
    await act(async () => root.render(<>{[2, 3, 4, 5].map(value => <ProjectCard key={value} project={{ ...project(), id: id(value) }} account={account} date="Created today" actions={null} />)}</>));
    expect(mock.read).toHaveBeenCalledTimes(3); expect(clients).toHaveLength(4);
    expect(clients[3]!.previewAsset).not.toHaveBeenCalled();
    await act(async () => clients[0]!.requests[0]!.resolve(null));
    expect(mock.read).toHaveBeenCalledTimes(4); expect(clients[3]!.previewAsset).toHaveBeenCalledOnce();
    await act(async () => { clients.slice(1).forEach(value => value.requests[0]!.resolve(null)); });
  });
});
