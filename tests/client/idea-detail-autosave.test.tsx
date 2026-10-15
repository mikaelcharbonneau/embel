// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { createIdeaDraftMemory } from "@/components/ideas/ideas-draft-memory";
import { ideaContentSchema, type IdeaRecord, type updateIdeaInputSchema } from "@/domain/ideas";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { IDEA_AUTOSAVE_DELAY_MS, IdeaDetail } from "@/components/ideas/idea-detail";

const fixture = vi.hoisted(() => ({
  session: { status: "ready" as const, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 },
  ideaDrafts: null as unknown as ReturnType<typeof createIdeaDraftMemory>,
  isCurrent: vi.fn(), expire: vi.fn(), refresh: vi.fn(), push: vi.fn(), lifecycleMemory: {},
}));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => fixture, AccountStatus: () => <p>Verify account</p> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: fixture.push }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/features/idea-project-attachment/attach-control", () => ({ AttachIdeaControl: () => null }));

type SaveInput = z.infer<typeof updateIdeaInputSchema>;
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ideaId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", stamp = "2026-10-15T12:00:00.000123Z";
let root: Root, host: HTMLDivElement, stored: IdeaRecord, writes: SaveInput[], reads: number;
let receipts: Map<string, { input: SaveInput; idea: IdeaRecord }>;
let write: (input: SaveInput) => Promise<Response>;
function commit(input: SaveInput): Response {
  const receipt = receipts.get(input.requestKey);
  if (receipt) return JSON.stringify(receipt.input) === JSON.stringify(input)
    ? Response.json({ idea: receipt.idea }) : Response.json({}, { status: 409 });
  if (input.expectedRevision !== stored.revision) return Response.json({}, { status: 409 });
  stored = { ...stored, revision: input.expectedRevision + 1, content: input.content };
  receipts.set(input.requestKey, { input, idea: stored });
  return Response.json({ idea: stored });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function tick(ms = IDEA_AUTOSAVE_DELAY_MS) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function render(mounted = true) { await act(async () => root.render(mounted ? <IdeaDetail ideaId={ideaId} /> : null)); await tick(0); }
const current = () => fixture.ideaDrafts.get(fixture.session.userId, ideaId)!;
const status = () => host.querySelector('[aria-label="Save status"]')?.textContent;
const description = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Description (optional)"]')!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label)!;
async function editDescription(value: string) {
  await act(async () => {
    const input = description();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function editTitle(value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('#idea-detail-form input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  fixture.session = { status: "ready", userId: owner, generation: 1 };
  fixture.ideaDrafts = createIdeaDraftMemory();
  fixture.isCurrent.mockImplementation((account: VerifiedAccount) => fixture.session.userId === account.userId && fixture.session.generation === account.generation);
  fixture.expire.mockReset(); fixture.refresh.mockReset(); fixture.push.mockReset();
  stored = { id: ideaId, ownerId: owner, revision: 1, content: ideaContentSchema.parse({ title: "Saved idea", description: "Original description" }), links: [], createdAt: stamp, updatedAt: stamp };
  writes = []; reads = 0; receipts = new Map(); write = async input => commit(input);
  vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
    if (options.method === "GET") {
      reads++;
      return Response.json({ idea: fixture.session.userId === owner ? stored : { ...stored, ownerId: other, content: ideaContentSchema.parse({ title: "Other account idea" }) } });
    }
    const input = JSON.parse(String(options.body)) as SaveInput; writes.push(input); return write(input);
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("owned IdeaDetail automatic saving", () => {
  it("debounces typing, displays Saved only after acknowledgement, and reloads the durable content", async () => {
    await render(); expect(status()).toBe("Saved"); expect(writes).toEqual([]);
    expect(button("Save changes")).toBeUndefined();
    await editDescription("First draft"); await tick(300); await editDescription("Finished draft");
    expect(status()).toBe("Saving…"); await tick(IDEA_AUTOSAVE_DELAY_MS - 1); expect(writes).toEqual([]);
    await tick(1); expect(writes).toHaveLength(1); expect(writes[0]!.content.description).toBe("Finished draft");
    expect(status()).toBe("Saved"); expect(host.textContent).toContain("Saved to account · version 2.");
    await render(false); fixture.ideaDrafts = createIdeaDraftMemory(); await render();
    expect(description().value).toBe("Finished draft"); expect(reads).toBe(2);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });

  it("keeps typing enabled during a save and serializes newer edits at the acknowledged revision", async () => {
    const pending = deferred<Response>(); write = () => pending.promise;
    await render(); await editDescription("Sent draft"); await tick();
    expect(writes).toHaveLength(1); expect(description().closest("fieldset")!.disabled).toBe(false);
    await editDescription("Newer typing"); await tick(5000); expect(writes).toHaveLength(1);
    write = async input => commit(input);
    await act(async () => pending.resolve(commit(writes[0]!)));
    expect(description().value).toBe("Newer typing"); expect(status()).toBe("Saving…");
    expect(current().saved.content.description).toBe("Sent draft");
    await tick(); expect(writes).toHaveLength(2); expect(writes[1]).toMatchObject({ expectedRevision: 2, content: { description: "Newer typing" } });
    expect(writes[1]!.requestKey).not.toBe(writes[0]!.requestKey); expect(status()).toBe("Saved");
  });

  it("pauses after a lost acknowledgement, preserves the original request through edits, and then saves newer typing", async () => {
    write = async input => { commit(input); throw new TypeError("Lost acknowledgement after commit"); };
    await render(); await editDescription("Original submitted draft"); await tick();
    const original = structuredClone(writes[0]!);
    expect(current().saveIntent).toEqual(original); expect(status()).toBe("Not savedRetry");
    await editDescription("Newest retained typing"); await tick(10_000);
    expect(writes).toHaveLength(1); expect(current().saveIntent).toEqual(original); expect(button("Retry").disabled).toBe(false);
    write = async input => commit(input);
    await act(async () => button("Retry").click());
    expect(writes[1]).toEqual(original); expect(description().value).toBe("Newest retained typing");
    expect(current().saved.content.description).toBe("Original submitted draft");
    await tick(); expect(writes).toHaveLength(3); expect(writes[2]).toMatchObject({ expectedRevision: 2, content: { description: "Newest retained typing" } });
    expect(status()).toBe("Saved"); expect(current().saveIntent).toBeNull();
  });

  it("preserves the user's revert while an earlier different value is still saving", async () => {
    const pending = deferred<Response>(); write = () => pending.promise;
    await render(); await editDescription("Temporarily changed"); await tick();
    await editDescription("Original description"); expect(status()).toBe("Saving…");
    write = async input => commit(input); await act(async () => pending.resolve(commit(writes[0]!)));
    expect(description().value).toBe("Original description"); await tick();
    expect(writes[1]!.content.description).toBe("Original description"); expect(stored.content.description).toBe("Original description");
  });

  it("pauses conflicting edits and requires explicit confirmation before loading the newer saved version", async () => {
    write = async () => Response.json({}, { status: 409 });
    await render(); await editDescription("My changes"); await tick();
    expect(current().conflict).toBe(true); await editDescription("Still my changes"); await tick(5000); expect(writes).toHaveLength(1);
    stored = { ...stored, revision: 3, content: { ...stored.content, description: "Other tab's saved changes" } };
    await act(async () => button("Load latest version").click()); expect(description().value).toBe("Still my changes");
    await act(async () => button("Replace with latest version").click());
    expect(description().value).toBe("Other tab's saved changes"); expect(current().saveIntent).toBeNull(); expect(status()).toBe("Saved");
  });

  it("retains an interrupted exact request across remount and same-owner verification without automatically retrying it", async () => {
    const pending = deferred<Response>(); write = () => pending.promise;
    await render(); await editDescription("Interrupted draft"); await tick(); const original = structuredClone(writes[0]!);
    await render(false); await act(async () => pending.resolve(commit(original)));
    fixture.session = { ...fixture.session, generation: 3 }; write = async input => commit(input);
    await render(); await tick(5000);
    expect(writes).toHaveLength(1); expect(current().saveIntent).toEqual(original); expect(current().generation).toBe(3);
    expect(status()).toBe("Not savedRetry"); await act(async () => button("Retry").click());
    expect(writes[1]).toEqual(original); expect(status()).toBe("Saved"); expect(current().saveIntent).toBeNull();
  });

  it("fences late acknowledgements and queued typing when the verified account changes", async () => {
    const pending = deferred<Response>(); write = () => pending.promise;
    await render(); await editDescription("Owner A private draft"); await tick(); await editDescription("Owner A newer draft");
    fixture.session = { status: "ready", userId: other, generation: 2 }; fixture.ideaDrafts.clear();
    await render(); await act(async () => pending.resolve(commit(writes[0]!))); await tick(5000);
    expect(writes).toHaveLength(1); expect(host.textContent).not.toContain("Owner A");
    expect(current().ownerId).toBe(other); expect(current().saved.content.title).toBe("Other account idea");
    expect(current().saveIntent).toBeNull(); expect(status()).toBe("Saved");
  });

  it("keeps an unfinished invalid title editable and resumes automatic saving after correction", async () => {
    await render(); await editTitle(""); await tick();
    expect(writes).toEqual([]); expect(status()).toBe("Not savedRetry");
    await editTitle("Corrected title"); await tick();
    expect(writes).toHaveLength(1); expect(stored.content.title).toBe("Corrected title"); expect(status()).toBe("Saved");
  });

  it("allows a new corrected request after a conclusive validation rejection", async () => {
    write = async () => Response.json({}, { status: 422 });
    await render(); await editDescription("Rejected draft"); await tick();
    expect(current().saveIntent).toBeNull(); await tick(5000); expect(writes).toHaveLength(1);
    write = async input => commit(input); await editDescription("Corrected draft"); await tick();
    expect(writes).toHaveLength(2); expect(writes[1]!.requestKey).not.toBe(writes[0]!.requestKey);
    expect(writes[1]!.expectedRevision).toBe(1); expect(status()).toBe("Saved");
  });
});
